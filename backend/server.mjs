// Hoshi Backend V3.3 - opt-in signed media relay for authorised HTTPS sources.
// Original implementation. Not a MegaPlay stream extractor.
// V3.3+: polite upstream layer (per-domain throttle, 429 retry, caching, resolve de-duplication).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { providerEntry } from './provider-adapter.mjs';
import { resolvePlayzStyle } from './playz-resolver.mjs';

const PORT = Number(process.env.PORT || 3000);
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || '';
const ORIGIN = 'https://chroma56.github.io';
// Extra page origins allowed to read relay responses (comma separated), e.g. a local test server.
const ORIGINS = new Set([ORIGIN, ...String(process.env.HOSHI_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);
const MAX_PLAYLIST = 1024 * 1024;
const MAX_MEDIA = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// One lifetime for every relay link. A VOD playlist is fetched once, so its segment links
// have to outlive the whole episode. Must stay below the 15000 s ceiling in validSignature.
const LINK_TTL = 14400;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HOSTS = new Set(String(process.env.MEDIA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const RELAY_ON = process.env.HOSHI_RELAY_ENABLED === 'true';
const RELAY_KEY = process.env.RELAY_SIGNING_KEY || '';
const RELAY_BASE = process.env.RELAY_PUBLIC_BASE || '';
// The stream you start from must always be on MEDIA_HOSTS. Playlists then name segment, key
// and rendition URLs, often on other CDN hosts. By default those are relayed from any public
// HTTPS host (each one is signed here and DNS-checked on fetch). Set RELAY_STRICT_HOSTS=true
// to drop everything that is not on MEDIA_HOSTS, as V3.2 did.
const STRICT_HOSTS = process.env.RELAY_STRICT_HOSTS === 'true';

// Polite upstream tuning. If the log still shows HTTP 429, lower CONCURRENCY (try 2) and/or
// raise MIN_GAP_MS (try 300). No code edit needed: set them as environment variables.
const UPSTREAM_CONCURRENCY = Math.max(1, Number(process.env.UPSTREAM_CONCURRENCY || 4));
const UPSTREAM_MIN_GAP_MS = Math.max(0, Number(process.env.UPSTREAM_MIN_GAP_MS || 120));
const UPSTREAM_ATTEMPTS = 4;                                        // tries per request on 429/503
const RESOLVE_TTL_MS = Number(process.env.RESOLVE_TTL_MS || 120000); // keep well under any provider token lifetime
const RESOLVE_FAIL_TTL_MS = 10000;                                  // "unavailable" and errors are remembered briefly

/*
 * Relay links carry their kind in the path, so the link itself still ends in the extension
 * the Worker and the page check for:
 *   /media/hls.m3u8   a playlist; every URI inside it is rewritten to point back here
 *   /media/sub.vtt    a subtitle file
 *   /media/video.mp4  a whole MP4 (no size cap; the browser asks for byte ranges)
 *   /media/file       segments, keys, init sections
 */
const KIND_PATH = { hls: 'hls.m3u8', sub: 'sub.vtt', video: 'video.mp4', file: 'file' };
const PATH_KIND = Object.fromEntries(Object.entries(KIND_PATH).map(([kind, name]) => ['/media/' + name, kind]));

function json(res, status, body, extra = {}) {
  res.writeHead(status, {...extra,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}
function catalog() {
  try { const c = JSON.parse(process.env.STREAM_CATALOG || '{}'); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
  catch { return {}; }
}
// MEDIA_HOSTS entries are exact host names, or "*.example.com" for every subdomain of
// example.com (CDNs that hand out a different random subdomain per episode).
const HOST_SUFFIXES = [...HOSTS].filter(h => h.startsWith('*.') && h.length > 3).map(h => h.slice(1));
function hostListed(host) { return HOSTS.has(host) || HOST_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length); }
function hostAllowed(value, extension) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !hostListed(u.hostname.toLowerCase())) return null;
    if (net.isIP(u.hostname) || u.hostname.toLowerCase() === 'localhost') return null;
    if (extension && !extension.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}
/** Any public-looking HTTPS URL. The address it resolves to is checked again in upstream(). */
function relayable(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
    if (!host || net.isIP(host) || host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
function permitted(value) { return STRICT_HOSTS ? hostAllowed(value) : relayable(value); }
function subtitles(input) {
  return (Array.isArray(input) ? input : []).slice(0,20).map(t => {
    const url = hostAllowed(t?.url, /\.vtt$/i);
    return url ? {url, lang:String(t.lang || 'en').slice(0,16), label:String(t.label || t.lang || 'Subtitles').slice(0,80)} : null;
  }).filter(Boolean);
}
/** A {start,end} pair in seconds, or null when it is missing, empty or nonsense. */
function chapter(input) {
  const start=Number(input?.start), end=Number(input?.end);
  return Number.isFinite(start) && Number.isFinite(end) && start>=0 && end>start+1 && end<=86400 ? {start,end} : null;
}
function attrs(line) {
  const result = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[m[1]] = m[2].startsWith('"') ? m[2].slice(1,-1) : m[2];
  return result;
}
function parseMaster(text, source) {
  const qualities = [], subs = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') return {qualities,subtitles:subs};
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a=attrs(line.slice(18)), next=lines[i+1];
      if (!next || next.startsWith('#')) continue;
      let url; try { url=hostAllowed(new URL(next,source).href,/\.m3u8$/i); } catch {}
      if (!url) continue;
      const height=Number((a.RESOLUTION || '').split('x')[1]) || 0;
      qualities.push({url,label:height ? String(height)+'p' : 'Auto',height,bandwidth:Number(a.BANDWIDTH)||0});
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a=attrs(line.slice(13));
      if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
      let url; try { url=hostAllowed(new URL(a.URI,source).href,/\.vtt$/i); } catch {}
      if (url) subs.push({url,lang:String(a.LANGUAGE || 'en').slice(0,16),label:String(a.NAME || 'Subtitles').slice(0,80)});
    }
  }
  qualities.sort((a,b)=>b.height-a.height || b.bandwidth-a.bandwidth);
  return {qualities:qualities.filter((q,i,a)=>a.findIndex(x=>x.url===q.url)===i).slice(0,12),subtitles:subs.filter((t,i,a)=>a.findIndex(x=>x.url===t.url)===i).slice(0,20)};
}
const BLOCK = new net.BlockList();
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) BLOCK.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]]) BLOCK.addSubnet(ip,bits,'ipv6');
function publicIp(ip) {
  const family=net.isIP(ip);
  if (!family) return false;
  if (family===4) return !BLOCK.check(ip,'ipv4');
  const match=/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (match) return publicIp(match[1]);
  return !BLOCK.check(ip,'ipv6');
}
/**
 * GET an upstream URL. Every hop, redirects included, must pass permitted() and resolve only
 * to public addresses; the connection is pinned to the address that was checked.
 * The response carries finalUrl: the URL that actually answered, after redirects.
 */
async function upstream(url, range, referer = '', hop = 0) {
  const safe=permitted(url);
  if (!safe) throw Error('Unsafe upstream destination');
  const parsed=new URL(safe);
  const all=await dns.lookup(parsed.hostname,{all:true});
  if (!all.length || all.some(a => !publicIp(a.address))) throw Error('Unsafe DNS destination');
  const target=all[0];
  const response=await new Promise((resolve,reject)=>{
    const req=https.request(parsed,{
      method:'GET',timeout:12000,
      lookup:(_host, opts, cb)=> {
        if (opts?.all) cb(null, [{ address:target.address, family:target.family }]);
        else cb(null, target.address, target.family);
      },
      // identity: byte counts and ranges must match what the browser receives.
      headers:{'User-Agent':USER_AGENT, Accept:'*/*', 'Accept-Encoding':'identity', ...(range ? {Range:range} : {}), ...(referer ? {Referer:referer, Origin:new URL(referer).origin} : {})}
    },res=>resolve(res));
    req.on('timeout',()=>req.destroy(Error('Upstream timeout')));
    req.on('error',reject); req.end();
  });
  const location=response.headers.location;
  if ([301,302,303,307,308].includes(response.statusCode) && location) {
    response.resume();
    if (hop >= MAX_REDIRECTS) throw Error('Upstream redirected too many times');
    return upstream(new URL(location,parsed).href, range, referer, hop+1);
  }
  response.finalUrl=parsed.href;
  return response;
}
async function readLimited(stream,max) {
  let length=0; const chunks=[];
  for await (const piece of stream) {
    length+=piece.length;
    if(length>max) { stream.destroy(); throw Error('Response too large'); }
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---- polite upstream layer -------------------------------------------------------------
// Everything that talks to the media host goes through upstreamPolite(): requests to one
// domain are spaced out and capped, a 429/503 pauses the whole domain and is retried with
// backoff BEFORE any response headers reach the viewer, and small files are cached.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CDNs hand out random subdomains (20f9h.wintergrove.space, fn5an.wintergrove.space) but
// rate-limit by IP or domain, so throttle per registrable-looking domain, not per host name.
function gateKey(host) { const p = host.split('.'); return p.length > 2 ? p.slice(-2).join('.') : host; }

const gates = new Map();
function gateFor(key) {
  let g = gates.get(key);
  if (!g) { g = { active: 0, waiters: [], nextSlot: 0, cooldownUntil: 0 }; gates.set(key, g); }
  return g;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, g] of gates) if (!g.active && !g.waiters.length && g.nextSlot < now && g.cooldownUntil < now) gates.delete(key);
}, 60000).unref();

async function withGate(key, aborted, fn) {
  const g = gateFor(key);
  while (g.active >= UPSTREAM_CONCURRENCY) await new Promise(r => g.waiters.push(r));
  g.active++;
  try {
    const now = Date.now();
    const slot = Math.max(now, g.nextSlot, g.cooldownUntil);
    g.nextSlot = slot + UPSTREAM_MIN_GAP_MS;
    if (slot > now) await sleep(slot - now);
    // a 429 seen while we were queued pauses everyone who reserved a slot earlier
    for (let wait = g.cooldownUntil - Date.now(); wait > 0; wait = g.cooldownUntil - Date.now()) await sleep(wait);
    if (aborted()) throw Error('Viewer left');
    return await fn();
  } finally {
    g.active--;
    g.waiters.shift()?.();
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return Math.max(0, secs) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Drop-in replacement for upstream(). `aborted` lets a viewer who left stop waiting. */
async function upstreamPolite(url, range, referer = '', aborted = () => false) {
  const key = gateKey(new URL(url).hostname);
  for (let attempt = 0; ; attempt++) {
    let source;
    try {
      source = await withGate(key, aborted, () => upstream(url, range, referer));
    } catch (e) {
      const transient = /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(e?.code || '') + ' ' + String(e?.message || ''));
      if (!transient || attempt >= 2 || aborted()) throw e;
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (![429, 503].includes(source.statusCode) || attempt >= UPSTREAM_ATTEMPTS - 1 || aborted()) return source;
    source.resume();
    const retryAfter = parseRetryAfter(source.headers['retry-after']);
    const wait = Math.min(Math.max(retryAfter ?? 0, 400 * 2 ** attempt), 8000) + Math.random() * 250;
    console.warn('Hoshi relay: HTTP '+source.statusCode+' from '+new URL(url).hostname+', retry '+(attempt+1)+'/'+(UPSTREAM_ATTEMPTS-1)+' in '+Math.round(wait)+'ms'+(retryAfter!=null ? ' (host asked for '+Math.round(retryAfter/1000)+'s)' : ''));
    const g = gateFor(key);
    g.cooldownUntil = Math.max(g.cooldownUntil, Date.now() + wait); // pause the whole domain
    await sleep(wait);
  }
}

async function readBytes(stream, max) {
  let length = 0; const chunks = [];
  for await (const piece of stream) {
    length += piece.length;
    if (length > max) { stream.destroy(); throw Error('Response too large'); }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

// Playlists: the raw upstream text is cached briefly, but every response is still re-signed
// with a fresh expiry by rewritePlaylist(). Finished (VOD) and master playlists don't change;
// live playlists must stay fresh.
const playlists = new Map(), playlistFlight = new Map();
const PLAYLIST_STALE_MS = 10 * 60000;
async function getPlaylist(url, referer) {
  const key = referer + '|' + url;
  const hit = playlists.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (playlistFlight.has(key)) return playlistFlight.get(key);
  const p = (async () => {
    try {
      const src = await upstreamPolite(url, undefined, referer);
      if (src.statusCode !== 200) {
        src.resume();
        if (hit?.stable && hit.expires + PLAYLIST_STALE_MS > Date.now()) return hit; // host is refusing: reuse the last good copy
        return { statusCode: src.statusCode, finalUrl: src.finalUrl };
      }
      const content = (await readLimited(src, MAX_PLAYLIST)).replace(/^\uFEFF/, '');
      const ended = content.includes('#EXT-X-ENDLIST'), master = content.includes('#EXT-X-STREAM-INF');
      const entry = { statusCode: 200, content, finalUrl: src.finalUrl, stable: ended || master, expires: Date.now() + (ended ? 300000 : master ? 60000 : 2000) };
      if (content.trimStart().startsWith('#EXTM3U')) {
        playlists.set(key, entry);
        if (playlists.size > 200) playlists.delete(playlists.keys().next().value);
      }
      return entry;
    } finally { playlistFlight.delete(key); }
  })();
  playlistFlight.set(key, p);
  return p;
}

// Small stable files (subtitles, thumbnails): cached 30 minutes, served stale for up to 6
// hours if the host is refusing us. Memory is bounded by total bytes.
const SMALL_FILE = /\.(?:vtt|srt|jpe?g|png|webp|gif)$/i;
const SMALL_TTL = 30 * 60000, SMALL_STALE = 6 * 3600000;
const SMALL_MAX = 8 * 1024 * 1024, SMALL_BUDGET = 64 * 1024 * 1024;
const small = new Map(), smallFlight = new Map();
let smallBytes = 0;
function smallPut(key, entry) {
  const old = small.get(key);
  if (old) { smallBytes -= old.body.length; small.delete(key); }
  small.set(key, entry); smallBytes += entry.body.length;
  while (smallBytes > SMALL_BUDGET && small.size > 1) {
    const [k, v] = small.entries().next().value;
    small.delete(k); smallBytes -= v.body.length;
  }
}
async function getSmall(url, referer) {
  const key = referer + '|' + url;
  const hit = small.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (smallFlight.has(key)) return smallFlight.get(key);
  const fallback = () => (hit && hit.staleUntil > Date.now() ? hit : null);
  const p = (async () => {
    try {
      const src = await upstreamPolite(url, undefined, referer);
      if (src.statusCode !== 200) {
        src.resume();
        console.warn('Hoshi relay: subtitle/thumbnail HTTP '+src.statusCode+' from '+new URL(url).hostname+(fallback() ? ' (served cached copy)' : ''));
        return fallback();
      }
      const body = await readBytes(src, SMALL_MAX);
      const entry = {
        body,
        type: src.headers['content-type'] || (/\.vtt$/i.test(new URL(url).pathname) ? 'text/vtt; charset=utf-8' : 'application/octet-stream'),
        expires: Date.now() + SMALL_TTL,
        staleUntil: Date.now() + SMALL_TTL + SMALL_STALE
      };
      smallPut(key, entry);
      return entry;
    } catch (e) {
      console.warn('Hoshi relay: subtitle/thumbnail failed:', String(e?.message || e).slice(0,100));
      return fallback();
    }
    finally { smallFlight.delete(key); }
  })();
  smallFlight.set(key, p);
  return p;
}
// ---- end polite upstream layer ---------------------------------------------------------

function signingReady() {
  try { const u=new URL(RELAY_BASE); return RELAY_ON && RELAY_KEY.length>=32 && u.protocol==='https:' && !u.username && !u.password && !u.hash && !u.search; }
  catch { return false; }
}
function expiry() { return String(Math.floor(Date.now()/1000)+LINK_TTL); }
// The kind is signed too, so a segment link can't be replayed as a playlist or the other way round.
function mac(kind,url,exp,referer='') { return crypto.createHmac('sha256',RELAY_KEY).update(kind+'\n'+url+'\n'+exp+'\n'+referer).digest('hex'); }
function signedLink(url, exp, referer = '', kind = 'file') {
  if (!KIND_PATH[kind]) throw Error('Unknown link kind');
  if (!permitted(url)) throw Error('Host not approved');
  const u=new URL('/media/'+KIND_PATH[kind],RELAY_BASE);
  u.searchParams.set('u',url);
  u.searchParams.set('exp',String(exp));
  if (referer) u.searchParams.set('r',referer);
  u.searchParams.set('sig',mac(kind,url,exp,referer));
  return u.href;
}
function validSignature(kind,url,exp,sig,referer='') {
  if (!/^\d{10}$/.test(exp) || Number(exp)<Math.floor(Date.now()/1000) || Number(exp)>Math.floor(Date.now()/1000)+15000 || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return crypto.timingSafeEqual(Buffer.from(mac(kind,url,exp,referer),'hex'),Buffer.from(sig,'hex'));
}
// Tags whose URI="" normally names another playlist rather than a file.
const PLAYLIST_TAG = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)\b/;
const FILE_EXTENSION = /\.(?:vtt|webvtt|ts|m4s|m4a|m4v|mp4|aac|mp3|key|jpe?g|png|webp)$/i;
/**
 * Points every URI in a playlist back at this relay. Relative URIs are resolved against
 * `origin` (the playlist's own URL). Variant and rendition playlists become /media/hls.m3u8
 * links so they get rewritten in turn; everything else becomes a /media/file link.
 */
function rewritePlaylist(text, origin, exp, referer = '') {
  let variantNext=false;
  // Returns the relay link, '' when the URI may not be relayed, or null to leave it untouched.
  const link=(raw,hint)=>{
    let abs;
    try { abs=new URL(raw,origin); } catch { return ''; }
    if (abs.protocol!=='https:' && abs.protocol!=='http:') return null; // data:, skd: and friends
    abs.hash='';
    const url=permitted(abs.href);
    if (!url) return '';
    const path=abs.pathname;
    const playlist=/\.m3u8$/i.test(path) || hint==='variant' || (hint==='tag' && !FILE_EXTENSION.test(path));
    return signedLink(url,exp,referer,playlist ? 'hls' : 'file');
  };
  return text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>{
    const t=line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (t.startsWith('#EXT-X-STREAM-INF')) variantNext=true;
      const hint=PLAYLIST_TAG.test(t) ? 'tag' : '';
      // Key, map, media, i-frame and low-latency tags all carry their address as URI="...".
      return t.replace(/URI="([^"]*)"/g,(whole,raw)=>{
        const out=link(raw,hint);
        return out===null ? whole : 'URI="'+out+'"';
      });
    }
    const out=link(t,variantNext ? 'variant' : '');
    variantNext=false;
    return out===null ? line : out;
  }).join('\n');
}
function cors(req) {
  const origin=req.headers.origin;
  return {
    'Access-Control-Allow-Origin':ORIGINS.has(origin) ? origin : ORIGIN,
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Allow-Headers':'Range',
    'Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range, Content-Type',
    'Vary':'Origin',
    'X-Content-Type-Options':'nosniff'
  };
}
async function media(req,res,url) {
  // Errors carry the CORS headers too; without them hls.js only sees an anonymous network failure.
  const fail=(status,body)=>json(res,status,body,cors(req));
  if (req.method==='OPTIONS') { res.writeHead(204,{...cors(req),'Access-Control-Max-Age':'86400'}); return res.end(); }
  if (!signingReady()) { console.warn('Hoshi relay: REJECTED, relay disabled (need HOSHI_RELAY_ENABLED=true, RELAY_SIGNING_KEY of 32+ chars, RELAY_PUBLIC_BASE as an https URL with no path query)'); return fail(404,{error:'Relay disabled'}); }
  if (req.method!=='GET') return fail(405,{error:'Method not allowed'});
  const kind=PATH_KIND[url.pathname];
  if (!kind) { console.warn('Hoshi relay: REJECTED, unknown path '+url.pathname); return fail(404,{error:'Unknown relay path. Links issued before V3.3 are no longer valid; resolve the episode again.'}); }
  const target=url.searchParams.get('u') || '';
  const exp=url.searchParams.get('exp') || '';
  const sig=url.searchParams.get('sig') || '';
  const referer=url.searchParams.get('r') || '';
  if (referer && referer !== 'https://megaplay.buzz/') { console.warn('Hoshi relay: REJECTED, invalid referer'); return fail(403,{error:'Invalid media referer'}); }
  if (!permitted(target) || !validSignature(kind,target,exp,sig,referer)) { console.warn('Hoshi relay: REJECTED, invalid or expired link ('+kind+'). If this repeats, RELAY_SIGNING_KEY changed or the page is using an old link.'); return fail(403,{error:'Invalid or expired media link'}); }
  const range=kind==='hls' ? undefined : req.headers.range;
  if (range && !/^bytes=\d+-\d*$/.test(range)) return fail(400,{error:'Invalid byte range'});
  const gone=()=>res.destroyed; // the viewer left (seek, tab closed): stop waiting for the host
  if (process.env.RELAY_DEBUG === 'true') console.log('Hoshi relay:', kind, new URL(target).hostname);
  try {
    // Playlists: cached and de-duplicated; still re-signed with a fresh expiry every time.
    if (kind==='hls') {
      const pl=await getPlaylist(target,referer);
      if (pl.statusCode!==200) {
        console.warn('Hoshi relay: upstream HTTP '+pl.statusCode+' from '+new URL(pl.finalUrl || target).hostname+' ('+kind+')');
        return fail([404,410].includes(pl.statusCode) ? pl.statusCode : 502,{error:'Upstream media unavailable',upstreamStatus:pl.statusCode});
      }
      if (!pl.content.trimStart().startsWith('#EXTM3U')) return fail(502,{error:'Invalid HLS playlist'});
      // Children get a fresh expiry each time, so a live playlist that keeps reloading never runs out.
      const output=rewritePlaylist(pl.content,pl.finalUrl,expiry(),referer);
      res.writeHead(200,{...cors(req),'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store'});
      return res.end(output);
    }
    // Subtitles and thumbnails: cached, and a failure must never break playback.
    if (!range && (kind==='sub' || (kind==='file' && SMALL_FILE.test(new URL(target).pathname)))) {
      const hit=await getSmall(target,referer);
      if (hit) {
        res.writeHead(200,{...cors(req),'Content-Type':hit.type,'Content-Length':hit.body.length,'Cache-Control':'private, max-age=600'});
        return res.end(hit.body);
      }
      if (kind==='sub') { // an empty track instead of an error
        res.writeHead(200,{...cors(req),'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'no-store'});
        return res.end('WEBVTT\n\n');
      }
      return fail(502,{error:'Upstream media unavailable'});
    }
    // Segments, keys, init sections, MP4: throttled and retried, then streamed through.
    const source=await upstreamPolite(target,range,referer,gone);
    if (![200,206].includes(source.statusCode)) {
      source.resume();
      console.warn('Hoshi relay: upstream HTTP '+source.statusCode+' from '+new URL(source.finalUrl).hostname+' ('+kind+')');
      return fail([404,410,416].includes(source.statusCode) ? source.statusCode : 502,{error:'Upstream media unavailable',upstreamStatus:source.statusCode});
    }
    // Segments and keys are capped; a whole MP4 is not, or anything over 64 MB could never play.
    const capped=kind!=='video';
    const size=Number(source.headers['content-length'] || 0);
    if(capped && size>MAX_MEDIA) { source.destroy(); return fail(413,{error:'Media object too large'}); }
    const headers={...cors(req),'Cache-Control':'private, max-age=60'};
    for(const k of ['content-type','content-length','content-range','accept-ranges']) if(source.headers[k]) headers[k]=source.headers[k];
    res.writeHead(source.statusCode,headers);
    let transferred=0;
    if (capped) source.on('data',chunk=>{ transferred+=chunk.length; if(transferred>MAX_MEDIA) source.destroy(Error('Media limit exceeded')); });
    await pipeline(source,res);
  } catch(e) {
    // A viewer seeking or leaving closes the response mid-transfer; that is not worth a log line.
    if (res.destroyed) return;
    console.warn('Hoshi relay failed ('+kind+'):',String(e?.message || e).slice(0,140));
    if(!res.headersSent) fail(502,{error:'Media relay failed'}); else res.destroy();
  }
}
async function masterInfo(url,referer='') {
  // Shares the playlist cache, so the player's own request for this master a moment later costs nothing.
  try { const pl=await getPlaylist(url,referer); if (pl.statusCode!==200) return {qualities:[],subtitles:[]}; return parseMaster(pl.content,pl.finalUrl); }
  catch {return {qualities:[],subtitles:[]};}
}
async function resolve(series,episode,lang) {
  const cat=catalog(); const key=series+':'+episode+':'+lang;
  let raw=Object.hasOwn(cat,key) ? cat[key] : null;
  if (!raw) raw=await resolvePlayzStyle(series,episode,lang);
  if (!raw) raw=await providerEntry(series,episode,lang);
  const format=['hls','mp4'].includes(raw?.format) ? raw.format : raw?.type;
  if (!['hls','mp4'].includes(format)) return {type:'embed',available:false,reason:'No authorised direct stream registered'};
  const url=hostAllowed(raw.url,format==='hls' ? /\.m3u8$/i : /\.mp4$/i);
  if(!url) return {type:'embed',available:false,reason:'Stream host is not allowlisted'};
  const referer = raw.referer === 'https://megaplay.buzz/' ? raw.referer : '';
  if (referer && !signingReady()) return {type:'embed',available:false,reason:'Signed relay is required for this provider'};
  const info=format==='hls' ? await masterInfo(url,referer) : {qualities:[],subtitles:[]};
  const subs=subtitles(raw.subtitles).concat(info.subtitles).filter((v,i,a)=>a.findIndex(x=>x.url===v.url)===i).slice(0,20);
  const result={type:'direct',available:true,format,url,subtitles:subs,qualities:info.qualities};
  // Intro and credits times, when the source knows them: the player's skip button and up-next card use these.
  for (const name of ['intro','outro']) { const c=chapter(raw[name]); if (c) result[name]=c; }
  if (signingReady()) {
    const exp=expiry();
    result.url=signedLink(result.url,exp,referer,format==='hls' ? 'hls' : 'video');
    result.qualities=result.qualities.map(q=>({...q,url:signedLink(q.url,exp,referer,'hls')}));
    result.subtitles=result.subtitles.map(t=>({...t,url:signedLink(t.url,exp,referer,'sub')}));
  }
  return result;
}
// The page can call /resolve several times for one episode (re-renders, retries). Identical
// calls share one provider lookup, and the answer is remembered briefly, failures included,
// so a rate-limited provider is not asked again straight away. Links inside the answer last
// LINK_TTL, so a couple of minutes of reuse costs nothing.
const resolved = new Map(), resolveFlight = new Map();
async function resolveCached(series,episode,lang) {
  const key=series+':'+episode+':'+lang;
  const hit=resolved.get(key);
  if (hit && hit.expires>Date.now()) { if (hit.error) throw hit.error; return hit.value; }
  if (resolveFlight.has(key)) return resolveFlight.get(key);
  const p=(async()=>{
    try {
      const value=await resolve(series,episode,lang);
      resolved.set(key,{value,expires:Date.now()+(value?.available ? RESOLVE_TTL_MS : RESOLVE_FAIL_TTL_MS)});
      return value;
    } catch(error) {
      resolved.set(key,{error,expires:Date.now()+RESOLVE_FAIL_TTL_MS});
      throw error;
    } finally {
      resolveFlight.delete(key);
      if (resolved.size>200) resolved.delete(resolved.keys().next().value);
    }
  })();
  resolveFlight.set(key,p);
  return p;
}
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url || '/','http://localhost');
    if (u.pathname==='/media' || u.pathname.startsWith('/media/')) return await media(req,res,u);
    if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});
    if(u.pathname==='/health') {
      const entries=Object.keys(catalog()).length;
      let providerConfigured=false;
      try { const p=new URL(process.env.PROVIDER_API_URL || '');providerConfigured=p.protocol==='https:' && !p.username && !p.password && !p.hash && !p.search && new Set(String(process.env.PROVIDER_HOSTS||'').split(',').map(x=>x.trim().toLowerCase())).has(p.hostname.toLowerCase()); } catch {}
      return json(res,200,{ok:true,service:'hoshi-node',version:'4.1-playz',configured:entries>0||providerConfigured,catalogEntries:entries,providerConfigured,mediaRelayEnabled:signingReady(),strictMediaHosts:STRICT_HOSTS,playzEnabled:process.env.HOSHI_PLAYZ_ENABLED==='true' && process.env.MEGAPLAY_SOURCE_PERMISSION==='true'});
    }
    if(u.pathname!=='/resolve') return json(res,404,{error:'Not found'});
    if(!BACKEND_TOKEN || req.headers.authorization!=='Bearer '+BACKEND_TOKEN) return json(res,401,{error:'Unauthorized'});
    const series=u.searchParams.get('series') || '',episode=u.searchParams.get('episode') || '',lang=u.searchParams.get('lang') || 'sub';
    if(!/^[A-Za-z0-9_-]{1,60}$/.test(series) || !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) || !['sub','dub'].includes(lang)) return json(res,400,{error:'Invalid parameters'});
    return json(res,200,await resolveCached(series,episode,lang));
  } catch(e) { console.error('Hoshi request error:',e?.message);if(!res.headersSent) json(res,500,{error:'Server error'});else res.destroy(); }
});
if(process.env.NODE_ENV!=='test') server.listen(PORT,'0.0.0.0',()=>console.log('Hoshi stream backend v4.1-playz listening on '+PORT));
export {server,resolve,parseMaster,rewritePlaylist,signedLink,validSignature,relayable,chapter};
