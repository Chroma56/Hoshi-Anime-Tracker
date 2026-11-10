// Hoshi Stream Worker V2: Node backend bridge + existing authorised catalog fallback.
const CORS = { 'Access-Control-Allow-Origin': 'https://chroma56.github.io', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
function json(data, status=200) { return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' } }); }
function safeUrl(v, ext) { try { const u = new URL(v); return u.protocol==='https:' && !u.username && !u.password && !u.hash && ext.test(u.pathname) ? u.href : null; } catch { return null; } }
function fallback(env, key) {
  let cat = {}; try { cat = JSON.parse(env.STREAM_CATALOG || '{}'); } catch { return { error:'Invalid STREAM_CATALOG' }; }
  const raw = cat && typeof cat==='object' && !Array.isArray(cat) && Object.hasOwn(cat, key) ? cat[key] : null;
  const f = raw?.type;
  const url = safeUrl(raw?.url, f==='hls' ? /\.m3u8$/i : /\.mp4$/i);
  if (!['hls','mp4'].includes(f) || !url) return { type:'embed', available:false, reason:'No authorised direct stream registered' };
  const subtitles = (Array.isArray(raw.subtitles) ? raw.subtitles : []).slice(0,20).map(s=>({ url:safeUrl(s?.url, /\.vtt$/i), lang:String(s?.lang||'en').slice(0,12), label:String(s?.label||'Subtitles').slice(0,80) })).filter(s=>s.url);
  return { type:'direct', available:true, format:f, url, subtitles };
}
export default { async fetch(request, env) {
  if (request.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});
  if (request.method!=='GET') return json({error:'Method not allowed'},405);
  const u = new URL(request.url);
  if (u.pathname==='/health') return json({ok:true,service:'hoshi-stream',version:'2.0',nodeConfigured:!!(env.NODE_BACKEND_URL&&env.BACKEND_TOKEN),configured:!!env.STREAM_CATALOG});
  if (u.pathname!=='/resolve') return json({error:'Not found'},404);
  const series=u.searchParams.get('series')||'',episode=u.searchParams.get('episode')||'',lang=u.searchParams.get('lang')||'sub';
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(series)||!/^\d{1,5}(?:\.\d{1,2})?$/.test(episode)||!['sub','dub'].includes(lang)) return json({error:'Invalid parameters'},400);
  if (env.NODE_BACKEND_URL && env.BACKEND_TOKEN) {
    try {
      const backend=new URL(env.NODE_BACKEND_URL);
      if (backend.protocol!=='https:' || backend.username || backend.password || backend.search || backend.hash || backend.pathname!=='/') throw Error('Invalid backend URL');
      const target=new URL('/resolve',backend);
      target.searchParams.set('series',series);target.searchParams.set('episode',episode);target.searchParams.set('lang',lang);
      const r=await fetch(target,{headers:{Authorization:'Bearer '+env.BACKEND_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(5500)});
      if (r.ok) {
        const data=await r.json();
        if (data?.available===true && data.type==='direct') {
          const f=data.format,url=safeUrl(data.url,f==='hls'?/\.m3u8$/i:/\.mp4$/i);
          if (['hls','mp4'].includes(f) && url) return json({available:true,type:'direct',format:f,url,subtitles:(Array.isArray(data.subtitles)?data.subtitles:[]).filter(t=>safeUrl(t?.url,/\.vtt$/i)).slice(0,20)});
        }
      }
    } catch (err) { console.warn('Hoshi Node backend unavailable:',String(err)); }
  }
  return json(fallback(env,`${series}:${episode}:${lang}`));
} };
