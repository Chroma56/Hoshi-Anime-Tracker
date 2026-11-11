// Hoshi V4: original implementation of the Playz-style MegaPlay resolution design.
// Requires explicit provider permission and approved CDN hostnames. No SDK dependency.
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const EMBED_ORIGIN = 'https://megaplay.buzz';
const MAX_HTML = 512 * 1024;
const MAX_JSON = 256 * 1024;
const MAX_PLAYLIST = 1024 * 1024;
const cache = new Map();

function allowedHosts() {
  return new Set(String(process.env.MEDIA_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
function approvedMedia(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
      !u.hash && !net.isIP(u.hostname) && allowedHosts().has(u.hostname.toLowerCase()) ? u.href : null;
  } catch { return null; }
}
function providerUrl(value) {
  try {
    const u = new URL(value);
    if (u.origin !== EMBED_ORIGIN || u.username || u.password || u.hash) return null;
    return u;
  } catch { return null; }
}
function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const a = ip.split('.').map(Number);
    return a[0] !== 0 && a[0] !== 10 && a[0] !== 127 && a[0] < 224 &&
      !(a[0] === 169 && a[1] === 254) && !(a[0] === 172 && a[1] >= 16 && a[1] <= 31) &&
      !(a[0] === 192 && (a[1] === 168 || a[1] === 0)) &&
      !(a[0] === 100 && a[1] >= 64 && a[1] <= 127) && !(a[0] === 198 && a[1] >= 18 && a[1] <= 19);
  }
  if (net.isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return publicAddress(v.slice(7));
    return v !== '::' && v !== '::1' && !/^(f[cd]|fe[89ab]|ff)/.test(v);
  }
  return false;
}
async function getText(url, headers = {}, limit = MAX_JSON) {
  const target = new URL(url);
  if (!providerUrl(url) && !approvedMedia(url)) throw Error('Host not approved');
  const records = await dns.lookup(target.hostname, {all:true});
  if (!records.length || records.some(x=>!publicAddress(x.address))) throw Error('Private network destination refused');
  const first = records[0];
  return new Promise((resolve, reject) => {
    const request = https.request(target, {method:'GET', timeout:12000,
      lookup:(_host,_options,callback)=>callback(null,first.address,first.family),
      headers:{'Accept':'*/*',...headers}}, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('HTTP_'+response.statusCode)); return; }
      let total=0; const parts=[];
      response.on('data',chunk=>{ total+=chunk.length; if(total>limit) {request.destroy(Error('Response too large'));return;} parts.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(parts).toString('utf8')));
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(Error('Timeout')));
    request.on('error',reject); request.end();
  });
}
function playerId(html) {
  const player=/<[^>]*\bid=["']megaplay-player["'][^>]*>/i.exec(html)?.[0];
  const id=player?.match(/\bdata-id=["'](\d+)["']/i)?.[1] ||
    /<[^>]*\bdata-id=["'](\d+)["'][^>]*>/i.exec(html)?.[1] ||
    /<title>\s*File\s+(\d+)/i.exec(html)?.[1];
  return id && /^\d{1,15}$/.test(id) ? id : null;
}
function clearCandidates(data) {
  const paths=[];
  // Older provider responses may contain plain playlist URLs.
  const raw = typeof data?.sources === 'string' ? data.sources :
    Array.isArray(data?.sources) ? data.sources.map(x=>x?.file) :
    [data?.sources?.file, data?.file];
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    if (typeof item === 'string' && /\.m3u8(?:\?|$)/i.test(item) && approvedMedia(item)) paths.push(item);
  }
  // The Playz design also looks for the master in the same media directory as subtitles.
  // Only use this when the provider has authorised those directory-level media URLs.
  if (process.env.MEGAPLAY_FOLDER_DISCOVERY === 'true') {
    for (const track of Array.isArray(data?.tracks) ? data.tracks : []) {
      const src=approvedMedia(track?.file);
      if (!src) continue;
      const u = new URL(src);
      const folder = /^(.+)\/(?:subtitles|sprites|thumbnails)\//i.exec(u.pathname)?.[1];
      if (folder) { u.pathname=folder+'/master.m3u8';u.search=''; paths.push(u.href); }
    }
  }
  return [...new Set(paths.filter(approvedMedia))].slice(0, 6);
}
function trackList(data) {
  return (Array.isArray(data?.tracks) ? data.tracks : []).slice(0, 30).flatMap(t=>{
    const url=approvedMedia(t?.file);
    if (!url || !/\.(?:vtt|srt)$/i.test(new URL(url).pathname)) return [];
    return [{url,lang:String(t.lang||'en').slice(0,16),label:String(t.label||'Subtitles').slice(0,80)}];
  });
}
async function browserCandidate(embedUrl) {
  if (process.env.HOSHI_PLAYZ_BROWSER !== 'true') return null;
  let chromium;
  try { ({chromium} = await import('playwright')); } catch { return null; }
  const browser = await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({serviceWorkers:'block'});
    try {
      const page=await context.newPage();
      const found = new Set();
      page.on('request', request => {
        const url=request.url();
        if (/\.m3u8(?:\?|$)/i.test(url) && approvedMedia(url)) found.add(url);
      });
      await page.goto(embedUrl,{waitUntil:'domcontentloaded',timeout:12000});
      if (!found.size) await page.waitForTimeout(5000);
      for (const url of found) {
        const text=await getText(url,{Referer:EMBED_ORIGIN+'/'} ,MAX_PLAYLIST).catch(()=>null);
        if (text?.trimStart().startsWith('#EXTM3U')) return {url,text};
      }
      return null;
    } finally { await context.close(); }
  } finally { await browser.close(); }
}
export async function resolvePlayzStyle(series, episode, lang) {
  if (process.env.HOSHI_PLAYZ_ENABLED !== 'true' || process.env.MEGAPLAY_SOURCE_PERMISSION !== 'true') return null;
  const match=/^al([1-9]\d{0,9})$/.exec(String(series));
  if (!match || !/^\d{1,5}$/.test(String(episode)) || !['sub','dub'].includes(lang)) return null;
  const key = `${series}:${episode}:${lang}`;
  const cached=cache.get(key);
  if (cached && cached.until>Date.now()) return cached.value;
  const embedUrl=`${EMBED_ORIGIN}/stream/ani/${match[1]}/${episode}/${lang}`;
  try {
    const html=await getText(embedUrl,{Referer:EMBED_ORIGIN+'/'},MAX_HTML);
    const id=playerId(html);
    if (!id) throw Error('PLAYER_ID_MISSING');
    const sourceUrl=new URL('/stream/getSources',EMBED_ORIGIN);
    sourceUrl.searchParams.set('id',id);
    const s = new URL(embedUrl).searchParams.get('s');
    if (s && /^[\w-]{1,80}$/.test(s)) sourceUrl.searchParams.set('s',s);
    let payload = null;
    try {
      payload=JSON.parse(await getText(sourceUrl.href,{
        Referer:embedUrl,'X-Requested-With':'XMLHttpRequest','Accept':'application/json'
      },MAX_JSON));
    } catch { console.warn('Hoshi Playz-style resolver: SOURCES_METADATA_UNAVAILABLE'); }
    let result=null;
    for (const candidate of clearCandidates(payload)) {
      const text=await getText(candidate,{Referer:EMBED_ORIGIN+'/',Origin:EMBED_ORIGIN},MAX_PLAYLIST).catch(()=>null);
      if (text?.trimStart().startsWith('#EXTM3U')) {
        result={type:'hls',url:candidate,referer:EMBED_ORIGIN+'/',subtitles:trackList(payload)}; break;
      }
    }
    if (!result) {
      const found=await browserCandidate(embedUrl);
      if (found) result={type:'hls',url:found.url,referer:EMBED_ORIGIN+'/',subtitles:trackList(payload)};
    }
    if (!result) throw Error('PLAYLIST_NOT_FOUND');
    if (cache.size>=100) cache.delete(cache.keys().next().value);
    cache.set(key,{value:result,until:Date.now()+5*60*1000});
    return result;
  } catch (error) {
    console.warn('Hoshi Playz-style resolver:', String(error?.message||error).slice(0,90));
    return null;
  }
}
