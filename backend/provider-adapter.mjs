
// Hoshi provider adapter V4.2
// Compatible with Hoshi Render Backend V3.1.

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
const MAX_CACHE = 120;

function allowedHosts(value) {
  return new Set(String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}

export function providerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null;
    return allowedHosts(process.env.PROVIDER_HOSTS).has(url.hostname.toLowerCase()) ? url : null;
  } catch { return null; }
}

function mediaUrl(value, kind) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (!allowedHosts(process.env.MEDIA_HOSTS).has(url.hostname.toLowerCase())) return null;
    const suffix = kind === 'hls' ? /\.m3u8$/i : kind === 'mp4' ? /\.mp4$/i : kind === 'vtt' ? /\.vtt$/i : null;
    return suffix && suffix.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function getAniListId(series) {
  const value = String(series || '').trim();
  const match = /^al([1-9]\d{0,9})$/.exec(value);
  if (match) return match[1];
  let mapping = {};
  try {
    const input = JSON.parse(process.env.ANILIST_ID_MAP || '{}');
    if (input && typeof input === 'object' && !Array.isArray(input)) mapping = input;
  } catch { return null; }
  const id = Object.prototype.hasOwnProperty.call(mapping, value)
    ? String(mapping[value])
    : process.env.HOSHI_SERIES_IDS_ARE_ANILIST === 'true' ? value : '';
  return /^[1-9]\d{0,9}$/.test(id) ? id : null;
}

function normalizeSubs(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(track => {
    if (!track || typeof track !== 'object') return null;
    const url = mediaUrl(track.url || track.sourceUrl || track.src || track.file, 'vtt');
    if (!url || seen.has(url)) return null;
    seen.add(url);
    const lang = String(track.lang || track.language || 'en').slice(0, 16);
    const label = String(track.label || track.name || lang || 'Subtitles')
      .replace(/\s{2,}/g, ' ').trim().slice(0, 80);
    return { url, lang, label };
  }).filter(Boolean).slice(0, 20);
}

function normalizeDirect(input) {
  if (!input || input.available === false) return null;
  const format = ['hls', 'mp4'].includes(input.format) ? input.format : input.type;
  if (format !== 'hls' && format !== 'mp4') return null;
  const url = mediaUrl(input.url, format);
  if (!url) return null;
  return { type: format, url, subtitles: normalizeSubs(input.subtitles) };
}

async function officialSource(series, episode, lang) {
  const base = providerUrl(process.env.PROVIDER_API_URL || '');
  if (!base) return null;
  const endpoint = new URL(base.href);
  endpoint.searchParams.set('series', series);
  endpoint.searchParams.set('episode', episode);
  endpoint.searchParams.set('lang', lang);
  const headers = { Accept: 'application/json' };
  if (process.env.PROVIDER_API_TOKEN) headers.Authorization = 'Bearer ' + process.env.PROVIDER_API_TOKEN;
  try {
    const response = await fetch(endpoint, {
      headers, redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536) return null;
    // Enforce actual byte bound even when the server omits Content-Length.
    const reader = response.body?.getReader();
    if (!reader) return null;
    const parts = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) { await reader.cancel(); return null; }
      parts.push(Buffer.from(next.value));
    }
    return normalizeDirect(JSON.parse(Buffer.concat(parts).toString('utf8')));
  } catch { return null; }
}

let sdkPromise;
async function sdkInstances() {
  if (!sdkPromise) {
    sdkPromise = import('anime-sdk').then(lib => {
      const http = new lib.HttpClient({ timeoutMs: 4000 });
      return {
        meta: new lib.AnilistMeta(http),
        megaplay: new lib.MegaPlayProvider(http)
      };
    }).catch(error => { sdkPromise = null; throw error; });
  }
  return sdkPromise;
}

async function sdkSource(series, episode, lang) {
  // Opt-in only: API/package availability is not proof of video playback rights.
  if (process.env.HOSHI_SDK_ENABLED !== 'true') return null;
  const id = getAniListId(series);
  if (!id || !/^\d{1,5}$/.test(episode)) return null;
  try {
    const sdk = await sdkInstances();
    const result = await sdk.meta.resolveStream('anilist:' + id, Number(episode), sdk.megaplay, lang);
    if (!result || result.type !== 'video' || !Array.isArray(result.streams)) return null;
    // Prefer an accessible HLS track; keep MP4 as backup.
    const streams = result.streams.slice().sort((a, b) => {
      const aHls = /\.m3u8(?:[?#]|$)/i.test(String(a?.sourceUrl || a?.url || ''));
      const bHls = /\.m3u8(?:[?#]|$)/i.test(String(b?.sourceUrl || b?.url || ''));
      return Number(bHls) - Number(aHls);
    });
    for (const stream of streams) {
      const candidate = stream?.sourceUrl || stream?.url;
      if (!candidate) continue;
      let format;
      try {
        format = /\.m3u8$/i.test(new URL(candidate).pathname) ? 'hls' : 'mp4';
      } catch { continue; }
      const normalized = normalizeDirect({
        type: format, url: candidate,
        subtitles: stream?.subtitles || stream?.tracks || result.subtitles || []
      });
      if (normalized) return normalized;
    }
    return null;
  } catch (error) {
    console.warn('Hoshi SDK resolver failed:', String(error?.message || error).slice(0, 120));
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

  const key = series + ':' + episode + ':' + lang;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  // Explicitly configured provider goes first; SDK is an optional fallback.
  const value = await officialSource(series, episode, lang) || await sdkSource(series, episode, lang);
  // Cache only positive results so new authorised source configurations take effect promptly.
  if (value) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: Date.now() + CACHE_MS });
  }
  return value;
}
