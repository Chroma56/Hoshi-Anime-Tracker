// Hoshi stream metadata backend. Compatible with Hoshi Player V3 /resolve API.
// Does not scrape embeds, decrypt streams, bypass DRM, or proxy video bytes.
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BACKEND_TOKEN || '';
const HOSTS = (process.env.MEDIA_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CATALOG = (() => { try { const v = JSON.parse(process.env.STREAM_CATALOG || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } })();

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function validMedia(value, ext) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || !HOSTS.includes(u.hostname.toLowerCase())) return null;
    if (ext && !ext.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}
export function parseMaster(text, masterUrl) {
  if (!text.includes('#EXT-X-STREAM-INF')) return [];
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const path = lines[i+1];
    if (!path || path.startsWith('#')) continue;
    const height = Number(/RESOLUTION=\d+x(\d+)/i.exec(lines[i])?.[1] || 0);
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(lines[i])?.[1] || 0);
    const uri = new URL(path, masterUrl).href;
    if (!validMedia(uri, /\.m3u8$/i)) continue;
    result.push({ url: uri, label: height ? `${height}p` : 'Auto', height, bandwidth });
  }
  return result.slice(0, 12).sort((a,b) => b.height - a.height || b.bandwidth - a.bandwidth);
}
async function getVariants(master) {
  try {
    const response = await fetch(master, { signal: AbortSignal.timeout(4500), headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain' }, redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 262144) return [];
    const reader = response.body?.getReader();
    if (!reader) return [];
    let n = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > 262144) { await reader.cancel(); return []; }
      chunks.push(value);
    }
    return parseMaster(new TextDecoder().decode(Buffer.concat(chunks)), master);
  } catch { return []; }
}
function makeSubtitles(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 20).map(t => {
    const url = validMedia(t?.url, /\.vtt$/i);
    return url ? { url, label: String(t.label || t.lang || 'Subtitles').slice(0, 60), lang: String(t.lang || 'en').slice(0, 12) } : null;
  }).filter(Boolean);
}
async function resolveEntry(series, episode, lang) {
  const raw = Object.hasOwn(CATALOG, `${series}:${episode}:${lang}`) ? CATALOG[`${series}:${episode}:${lang}`] : null;
  const format = raw?.type;
  if (format !== 'hls' && format !== 'mp4') return { type: 'embed', available: false, reason: 'No authorised direct stream registered' };
  const url = validMedia(raw.url, format === 'hls' ? /\.m3u8$/i : /\.mp4$/i);
  if (!url) return { type: 'embed', available: false, reason: 'Video URL not allowed by MEDIA_HOSTS or invalid' };
  return { type: 'direct', available: true, format, url, subtitles: makeSubtitles(raw.subtitles), qualities: format === 'hls' ? await getVariants(url) : [] };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/health') return reply(res, 200, { ok: true, service: 'hoshi-node', version: '1.0', configured: Object.keys(CATALOG).length > 0 });
  if (url.pathname !== '/resolve') return reply(res, 404, { error: 'Not found' });
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return reply(res, 401, { error: 'Unauthorized' });
  const series = url.searchParams.get('series') || '';
  const episode = url.searchParams.get('episode') || '';
  const lang = url.searchParams.get('lang') || 'sub';
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(series) || !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) || !['sub','dub'].includes(lang)) return reply(res, 400, { error: 'Invalid series, episode, or lang' });
  return reply(res, 200, await resolveEntry(series, episode, lang));
});
if (process.env.NODE_ENV !== 'test') server.listen(PORT, '0.0.0.0', () => console.log(`Hoshi stream backend listening on ${PORT}`));
export { server };
