
import http from 'node:http';
import { providerEntry } from './provider-adapter.mjs';

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BACKEND_TOKEN || '';
const HOSTS = new Set(
  (process.env.MEDIA_HOSTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

function catalog() {
  try {
    const x = JSON.parse(process.env.STREAM_CATALOG || '{}');
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch {
    return {};
  }
}

function reply(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function allowedUrl(value, ext) {
  try {
    const u = new URL(value);

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash ||
      !HOSTS.has(u.hostname.toLowerCase())
    ) return null;

    if (ext && !ext.test(u.pathname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function attributes(s) {
  const found = {};

  for (const match of s.matchAll(
    /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g
  )) {
    const v = match[2];
    found[match[1]] = v.startsWith('"')
      ? v.slice(1, -1)
      : v;
  }

  return found;
}

export function parsePlaylist(
  text,
  masterUrl,
  isAllowed = allowedUrl
) {
  const qualities = [];
  const subtitles = [];

  if (!String(text).trimStart().startsWith('#EXTM3U')) {
    return { qualities, subtitles };
  }

  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attributes(
        line.slice('#EXT-X-STREAM-INF:'.length)
      );

      const next = lines[i + 1];
      if (!next || next.startsWith('#')) continue;

      let value;

      try {
        value = new URL(next, masterUrl).href;
      } catch {
        continue;
      }

      const url = isAllowed(value, /\.m3u8$/i);
      if (!url) continue;

      const height =
        Number((a.RESOLUTION || '').split('x')[1]) || 0;

      const bandwidth = Number(a.BANDWIDTH) || 0;

      qualities.push({
        url,
        label: height ? `${height}p` : 'Auto',
        height,
        bandwidth
      });
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(
        line.slice('#EXT-X-MEDIA:'.length)
      );

      if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;

      let value;

      try {
        value = new URL(a.URI, masterUrl).href;
      } catch {
        continue;
      }

      // Only expose direct WebVTT files.
      const url = isAllowed(value, /\.vtt$/i);
      if (!url) continue;

      subtitles.push({
        url,
        lang: String(a.LANGUAGE || 'en').slice(0, 16),
        label: String(
          a.NAME || a.LANGUAGE || 'Subtitles'
        ).slice(0, 80)
      });
    }
  }

  qualities.sort(
    (a, b) =>
      b.height - a.height ||
      b.bandwidth - a.bandwidth
  );

  const seen = new Set();

  return {
    qualities: qualities.filter(q => {
      if (seen.has(q.url)) return false;
      seen.add(q.url);
      return true;
    }).slice(0, 12),

    subtitles: subtitles.filter(
      (t, i, list) =>
        list.findIndex(x => x.url === t.url) === i
    ).slice(0, 20)
  };
}

async function readMaster(master) {
  try {
    const response = await fetch(master, {
      headers: {
        Accept:
          'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(3500)
    });

    if (
      !response.ok ||
      Number(
        response.headers.get('content-length') || 0
      ) > 262144
    ) {
      return { qualities: [], subtitles: [] };
    }

    const reader = response.body?.getReader();

    if (!reader) {
      return { qualities: [], subtitles: [] };
    }

    let total = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;

      if (total > 262144) {
        await reader.cancel();
        return { qualities: [], subtitles: [] };
      }

      chunks.push(value);
    }

    return parsePlaylist(
      new TextDecoder().decode(Buffer.concat(chunks)),
      master
    );
  } catch {
    return { qualities: [], subtitles: [] };
  }
}

function explicitSubs(subs) {
  return (Array.isArray(subs) ? subs : [])
    .slice(0, 20)
    .map(t => {
      const url = allowedUrl(t?.url, /\.vtt$/i);

      return url ? {
        url,
        lang: String(t.lang || 'en').slice(0, 16),
        label: String(
          t.label || t.lang || 'Subtitles'
        ).slice(0, 80)
      } : null;
    })
    .filter(Boolean);
}

function missing(
  reason = 'No authorised direct stream registered'
) {
  return {
    type: 'embed',
    available: false,
    reason
  };
}

export async function resolveEntry(
  series,
  episode,
  lang
) {
  const registry = catalog();
  const key = `${series}:${episode}:${lang}`;

  const registered = Object.hasOwn(registry, key)
    ? registry[key]
    : null;

  // V3: Query a compatible provider if the catalog
  // does not contain the requested episode.
  const raw = registered ||
    await providerEntry(series, episode, lang);

  const format = raw?.type;

  if (format !== 'hls' && format !== 'mp4') {
    return missing();
  }

  const url = allowedUrl(
    raw.url,
    format === 'hls'
      ? /\.m3u8$/i
      : /\.mp4$/i
  );

  if (!url) {
    return missing(
      'Stream URL is invalid or host not in MEDIA_HOSTS'
    );
  }

  const tracks = format === 'hls'
    ? await readMaster(url)
    : { qualities: [], subtitles: [] };

  const subs = explicitSubs(raw.subtitles);
  const existing = new Set(subs.map(x => x.url));

  for (const t of tracks.subtitles) {
    if (!existing.has(t.url)) {
      subs.push(t);
      existing.add(t.url);
    }
  }

  return {
    type: 'direct',
    available: true,
    format,
    url,
    subtitles: subs.slice(0, 20),
    qualities: tracks.qualities
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    'http://localhost'
  );

  if (req.method !== 'GET') {
    return reply(res, 405, {
      error: 'Method not allowed'
    });
  }

  if (url.pathname === '/health') {
    return reply(res, 200, {
      ok: true,
      service: 'hoshi-node',
      version: '3.0',
      configured: Object.keys(catalog()).length > 0
    });
  }

  if (url.pathname !== '/resolve') {
    return reply(res, 404, {
      error: 'Not found'
    });
  }

  if (
    !TOKEN ||
    req.headers.authorization !== `Bearer ${TOKEN}`
  ) {
    return reply(res, 401, {
      error: 'Unauthorized'
    });
  }

  const series =
    url.searchParams.get('series') || '';

  const episode =
    url.searchParams.get('episode') || '';

  const lang =
    url.searchParams.get('lang') || 'sub';

  if (
    !/^[A-Za-z0-9_-]{1,60}$/.test(series) ||
    !/^[0-9]{1,5}(?:\.[0-9]{1,2})?$/.test(episode) ||
    !['sub', 'dub'].includes(lang)
  ) {
    return reply(res, 400, {
      error: 'Invalid series, episode, or lang'
    });
  }

  return reply(
    res,
    200,
    await resolveEntry(series, episode, lang)
  );
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(
    PORT,
    '0.0.0.0',
    () => console.log(
      `Hoshi stream metadata backend v3 listening on ${PORT}`
    )
  );
}

export { server };
