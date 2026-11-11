// Hoshi Backend V3.2 - opt-in signed media relay for authorised HTTPS sources.
// Original implementation. Not a MegaPlay stream extractor.
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
const MAX_PLAYLIST = 1024 * 1024;
const MAX_MEDIA = 64 * 1024 * 1024;
const HOSTS = new Set(String(process.env.MEDIA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const RELAY_ON = process.env.HOSHI_RELAY_ENABLED === 'true';
const RELAY_KEY = process.env.RELAY_SIGNING_KEY || '';
const RELAY_BASE = process.env.RELAY_PUBLIC_BASE || '';

function json(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}
function catalog() {
  try { const c = JSON.parse(process.env.STREAM_CATALOG || '{}'); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
  catch { return {}; }
}
function hostAllowed(value, extension) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !HOSTS.has(u.hostname.toLowerCase())) return null;
    if (net.isIP(u.hostname) || u.hostname.toLowerCase() === 'localhost') return null;
    if (extension && !extension.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}
function subtitles(input) {
  return (Array.isArray(input) ? input : []).slice(0,20).map(t => {
    const url = hostAllowed(t?.url, /\.vtt$/i);
    return url ? {url, lang:String(t.lang || 'en').slice(0,16), label:String(t.label || t.lang || 'Subtitles').slice(0,80)} : null;
  }).filter(Boolean);
}
function attrs(line) {
  const result = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[m[1]] = m[2].startsWith('"') ? m[2].slice(1,-1) : m[2];
  return result;
}
function parseMaster(text, source) {
  const qualities = [], subs = [];
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
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
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) BLOCK.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]]) BLOCK.addSubnet(ip,bits,'ipv6');
function publicIp(ip) {
  const family=net.isIP(ip);
  if (!family) return false;
  if (family===4) return !BLOCK.check(ip,'ipv4');
  const match=/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (match) return publicIp(match[1]);
  return !BLOCK.check(ip,'ipv6');
}
async function upstream(url, range, referer = '') {
  const parsed=new URL(url);
  const all=await dns.lookup(parsed.hostname,{all:true});
  if (!all.length || all.some(a => !publicIp(a.address))) throw Error('Unsafe DNS destination');
  const target=all[0];
  return new Promise((resolve,reject)=>{
    const req=https.request(parsed,{
      method:'GET',timeout:12000,
      lookup:(_host,_opts,cb)=>cb(null,target.address,target.family),
      headers:{Accept:'*/*', ...(range ? {Range:range} : {}), ...(referer ? {Referer:referer, Origin:new URL(referer).origin} : {})}
    },res=>resolve(res));
    req.on('timeout',()=>req.destroy(Error('Upstream timeout')));
    req.on('error',reject); req.end();
  });
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
function signingReady() {
  try { const u=new URL(RELAY_BASE); return RELAY_ON && RELAY_KEY.length>=32 && u.protocol==='https:' && !u.username && !u.password && !u.hash && !u.search; }
  catch { return false; }
}
function mac(url,exp,referer='') { return crypto.createHmac('sha256',RELAY_KEY).update(url+'\n'+exp+'\n'+referer).digest('hex'); }
function signedLink(url, exp, referer = '') {
  if (!hostAllowed(url)) throw Error('Host not approved');
  const u=new URL('/media',RELAY_BASE);
  u.searchParams.set('u',url);
  u.searchParams.set('exp',String(exp));
  if (referer) u.searchParams.set('r',referer);
  u.searchParams.set('sig',mac(url,exp,referer));
  return u.href;
}
function validSignature(url,exp,sig,referer='') {
  if (!/^\d{10}$/.test(exp) || Number(exp)<Math.floor(Date.now()/1000) || Number(exp)>Math.floor(Date.now()/1000)+15000 || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return crypto.timingSafeEqual(Buffer.from(mac(url,exp,referer),'hex'),Buffer.from(sig,'hex'));
}
function rewritePlaylist(text, origin, exp, referer = '') {
  const lines=text.split(/\r?\n/);
  return lines.map(line=>{
    if (!line.trim()) return line;
    // Rewrite URI attributes in key, map, subtitle, iframe and low-latency HLS tags.
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g,(_m,raw)=>{
      try { const url=hostAllowed(new URL(raw,origin).href); return url ? 'URI="'+signedLink(url,exp,referer)+'"' : 'URI=""'; }
      catch { return 'URI=""'; }
    });
    try { const url=hostAllowed(new URL(line.trim(),origin).href); return url ? signedLink(url,exp,referer) : ''; }
    catch { return ''; }
  }).join('\n');
}
function cors(req) {
  const origin=req.headers.origin;
  return {
    'Access-Control-Allow-Origin':origin===ORIGIN ? ORIGIN : ORIGIN,
    'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':'Range',
    'Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range, Content-Type',
    'Vary':'Origin',
    'X-Content-Type-Options':'nosniff'
  };
}
async function media(req,res,url) {
  if (!signingReady()) return json(res,404,{error:'Relay disabled'});
  if (req.method==='OPTIONS') { res.writeHead(204,cors(req)); return res.end(); }
  if (req.method!=='GET') return json(res,405,{error:'Method not allowed'});
  const target=url.searchParams.get('u') || '';
  const exp=url.searchParams.get('exp') || '';
  const sig=url.searchParams.get('sig') || '';
  const referer=url.searchParams.get('r') || '';
  if (referer && referer !== 'https://megaplay.buzz/') return json(res,403,{error:'Invalid media referer'});
  if (!hostAllowed(target) || !validSignature(target,exp,sig,referer)) return json(res,403,{error:'Invalid or expired media link'});
  const range=req.headers.range;
  if (range && !/^bytes=\d+-\d*$/.test(range)) return json(res,400,{error:'Invalid byte range'});
  try {
    const source=await upstream(target,range,referer);
    if (![200,206].includes(source.statusCode)) { source.resume(); return json(res,502,{error:'Upstream media unavailable'}); }
    const playlist=/\.m3u8$/i.test(new URL(target).pathname);
    if (playlist) {
      const content=await readLimited(source,MAX_PLAYLIST);
      if (!content.startsWith('#EXTM3U')) return json(res,502,{error:'Invalid HLS playlist'});
      const output=rewritePlaylist(content,target,exp,referer);
      res.writeHead(200,{...cors(req),'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store'});
      return res.end(output);
    }
    const size=Number(source.headers['content-length'] || 0);
    if(size>MAX_MEDIA) { source.destroy(); return json(res,413,{error:'Media object too large'}); }
    const headers={...cors(req),'Cache-Control':'private, max-age=60'};
    for(const k of ['content-type','content-length','content-range','accept-ranges']) if(source.headers[k]) headers[k]=source.headers[k];
    res.writeHead(source.statusCode,headers);
    let transferred=0;
    source.on('data',chunk=>{ transferred+=chunk.length; if(transferred>MAX_MEDIA) source.destroy(Error('Media limit exceeded')); });
    await pipeline(source,res);
  } catch(e) { if(!res.headersSent) json(res,502,{error:'Media relay failed'}); else res.destroy(); }
}
async function masterInfo(url,referer='') {
  try { const stream=await upstream(url,null,referer); if (stream.statusCode!==200) {stream.resume();return {qualities:[],subtitles:[]};} return parseMaster(await readLimited(stream,MAX_PLAYLIST),url); }
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
  if (signingReady()) {
    const exp=Math.floor(Date.now()/1000)+(referer ? 900 : 14400);
    result.url=signedLink(result.url,exp,referer);
    result.qualities=result.qualities.map(q=>({...q,url:signedLink(q.url,exp,referer)}));
    result.subtitles=result.subtitles.map(t=>({...t,url:signedLink(t.url,exp,referer)}));
  }
  return result;
}
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url || '/','http://localhost');
    if (u.pathname==='/media') return await media(req,res,u);
    if(req.method!=='GET') return json(res,405,{error:'Method not allowed'});
    if(u.pathname==='/health') {
      const entries=Object.keys(catalog()).length;
      let providerConfigured=false;
      try { const p=new URL(process.env.PROVIDER_API_URL || '');providerConfigured=p.protocol==='https:' && !p.username && !p.password && !p.hash && !p.search && new Set(String(process.env.PROVIDER_HOSTS||'').split(',').map(x=>x.trim().toLowerCase())).has(p.hostname.toLowerCase()); } catch {}
      return json(res,200,{ok:true,service:'hoshi-node',version:'4.0-playz',configured:entries>0||providerConfigured,catalogEntries:entries,providerConfigured,mediaRelayEnabled:signingReady(),playzEnabled:process.env.HOSHI_PLAYZ_ENABLED==='true' && process.env.MEGAPLAY_SOURCE_PERMISSION==='true'});
    }
    if(u.pathname!=='/resolve') return json(res,404,{error:'Not found'});
    if(!BACKEND_TOKEN || req.headers.authorization!=='Bearer '+BACKEND_TOKEN) return json(res,401,{error:'Unauthorized'});
    const series=u.searchParams.get('series') || '',episode=u.searchParams.get('episode') || '',lang=u.searchParams.get('lang') || 'sub';
    if(!/^[A-Za-z0-9_-]{1,60}$/.test(series) || !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) || !['sub','dub'].includes(lang)) return json(res,400,{error:'Invalid parameters'});
    return json(res,200,await resolve(series,episode,lang));
  } catch(e) { console.error('Hoshi request error:',e?.message);if(!res.headersSent) json(res,500,{error:'Server error'});else res.destroy(); }
});
if(process.env.NODE_ENV!=='test') server.listen(PORT,'0.0.0.0',()=>console.log('Hoshi stream backend v4.0-playz listening on '+PORT));
export {server,resolve,parseMaster,rewritePlaylist};
