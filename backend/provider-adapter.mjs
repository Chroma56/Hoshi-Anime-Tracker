
// Hoshi provider adapter V4.3
// Uses the documented anime-sdk provider workflow rather than AnilistMeta.resolveStream.
// SDK integration stays opt-in. Only resolve media you are authorised to play.

const CACHE_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 100;
const cache = new Map();

function hosts(variable) {
  return new Set(String(process.env[variable] || '').split(',')
    .map(x => x.trim().toLowerCase()).filter(Boolean));
}

function secureUrl(value, allowed, extension) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'https:' || u.username || u.password || u.hash ||
        u.port || !allowed.has(u.hostname.toLowerCase()) ||
        (extension && !extension.test(u.pathname))) return null;
    return u.href;
  } catch { return null; }
}

export function providerUrl(value) {
  const url = secureUrl(value, hosts('PROVIDER_HOSTS'));
  return url ? new URL(url) : null;
}

export function getAniListId(series) {
  const key = String(series || '').trim();
  const prefixed = /^al([1-9]\d{0,9})$/.exec(key);
  if (prefixed) return prefixed[1];
  let mapping;
  try { mapping = JSON.parse(process.env.ANILIST_ID_MAP || '{}'); }
  catch { return null; }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  const raw = Object.hasOwn(mapping, key) ? String(mapping[key]) :
    process.env.HOSHI_SERIES_IDS_ARE_ANILIST === 'true' ? key : '';
  return /^[1-9]\d{0,9}$/.test(raw) ? raw : null;
}

function subtitles(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 30).flatMap(t => {
    if (!t || typeof t !== 'object') return [];
    const url = secureUrl(t.url || t.sourceUrl || t.src || t.file,
      hosts('MEDIA_HOSTS'), /\.vtt$/i);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ url, lang: String(t.lang || t.language || 'en').slice(0, 16),
      label: String(t.label || t.name || 'Subtitles').slice(0, 80) }];
  });
}

function normalize(raw) {
  if (!raw || raw.available === false) return null;
  const format = ['hls', 'mp4'].includes(raw.format) ? raw.format : raw.type;
  if (!['hls', 'mp4'].includes(format)) return null;
  const url = secureUrl(raw.url, hosts('MEDIA_HOSTS'),
    format === 'hls' ? /\.m3u8$/i : /\.mp4$/i);
  return url ? { type: format, available: true, url, subtitles: subtitles(raw.subtitles) } : null;
}

async function limitedJson(response) {
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536) return null;
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); return null; }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function officialSource(series, episode, lang) {
  const base = providerUrl(process.env.PROVIDER_API_URL || '');
  if (!base || base.search) return null;
  const endpoint = new URL(base);
  endpoint.searchParams.set('series', series);
  endpoint.searchParams.set('episode', episode);
  endpoint.searchParams.set('lang', lang);
  const headers = { Accept: 'application/json' };
  if (process.env.PROVIDER_API_TOKEN) headers.Authorization = `Bearer ${process.env.PROVIDER_API_TOKEN}`;
  try {
    const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(4000) });
    return normalize(await limitedJson(response));
  } catch { return null; }
}

let sdkPromise;
async function sdkProvider() {
  if (!sdkPromise) {
    sdkPromise = import('anime-sdk').then(lib =>
      new lib.MegaPlayProvider(new lib.HttpClient({ timeoutMs: 4000 }))
    ).catch(e => { sdkPromise = null; throw e; });
  }
  return sdkPromise;
}

async function sdkSource(series, episode, lang) {
  if (process.env.HOSHI_SDK_ENABLED !== 'true') return null;
  const id = getAniListId(series);
  if (!id || !/^\d{1,5}$/.test(episode)) return null;
  try {
    const provider = await sdkProvider();
    // The SDK documents provider.fetchContentUnits(id) then provider.resolveStream(unit.id, lang).
    // ID syntax varies with SDK release; do not assume that units are always found.
    const units = await provider.fetchContentUnits('anilist:' + id);
    if (!Array.isArray(units)) return null;
    const unit = units.find(u => Number(u.number ?? u.episode ?? u.episodeNumber) === Number(episode));
    if (!unit?.id) return null;
    const result = await provider.resolveStream(unit.id, lang);
    if (result?.type !== 'video' || !Array.isArray(result.streams)) return null;
    for (const stream of result.streams) {
      const source = stream?.sourceUrl || stream?.url;
      let extension;
      try { extension = new URL(source).pathname; } catch { continue; }
      const format = /\.m3u8$/i.test(extension) ? 'hls' : /\.mp4$/i.test(extension) ? 'mp4' : null;
      if (!format) continue;
      const value = normalize({ type: format, url: source,
        subtitles: stream.subtitles || stream.tracks || result.subtitles || [] });
      if (value) return value;
    }
    return null;
  } catch (error) {
    console.warn('Hoshi optional SDK resolver:', String(error?.message || error).slice(0, 140));
    return null;
  }
}

export async function providerEntry(series, episode, lang) {
  series = String(series);
  episode = String(episode);
  lang = String(lang);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(series) ||
      !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) ||
      !['sub', 'dub'].includes(lang)) return null;
  const key = [series, episode, lang].join(':');
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.result;
  const result = await officialSource(series, episode, lang) || await sdkSource(series, episode, lang);
  if (result) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { result, expires: Date.now() + CACHE_MS });
  }
  return result;
}
