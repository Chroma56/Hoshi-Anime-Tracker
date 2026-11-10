
// Pluggable, permission-based provider:
// direct stream metadata only.
//
// Anikoto's embed URL is NOT a playable stream
// and is never scraped here.

const SERIES = /^[A-Za-z0-9_-]{1,60}$/;
const EPISODE = /^\d{1,5}(?:\.\d{1,2})?$/;
const LANGS = new Set(['sub', 'dub']);

function hosts() {
  return new Set(
    (process.env.PROVIDER_HOSTS || '')
      .split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function providerUrl(
  base,
  allowed = hosts()
) {
  try {
    const u = new URL(base);

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      !allowed.has(u.hostname.toLowerCase())
    ) {
      return null;
    }

    return u;
  } catch {
    return null;
  }
}

// Provider response:
// {
//   available: true,
//   type: 'direct',
//   format: 'hls' | 'mp4',
//   url: 'https://...',
//   subtitles: [{ lang, label, url }]
// }
//
// Stream URLs are independently checked
// by server.mjs against MEDIA_HOSTS.

export async function providerEntry(
  series,
  episode,
  lang,
  fetchFn = fetch
) {
  if (
    !SERIES.test(series) ||
    !EPISODE.test(episode) ||
    !LANGS.has(lang)
  ) {
    return null;
  }

  const base = providerUrl(
    process.env.PROVIDER_API_URL || ''
  );

  if (!base) return null;

  const url = new URL(base.href);

  url.searchParams.set('series', series);
  url.searchParams.set('episode', episode);
  url.searchParams.set('lang', lang);

  const key =
    process.env.PROVIDER_API_TOKEN || '';

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(key
          ? {
              Authorization: `Bearer ${key}`
            }
          : {})
      },
      signal: AbortSignal.timeout(3500)
    });

    if (
      !response.ok ||
      !/^application\/json\b/i.test(
        response.headers.get('content-type') || ''
      ) ||
      Number(
        response.headers.get('content-length') || 0
      ) > 65536
    ) {
      return null;
    }

    const reader = response.body?.getReader();

    if (!reader) return null;

    let size = 0;
    const pieces = [];

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > 65536) {
        await reader.cancel();
        return null;
      }

      pieces.push(value);
    }

    const result = JSON.parse(
      Buffer.concat(pieces).toString('utf8')
    );

    if (
      !result ||
      result.available !== true ||
      result.type !== 'direct' ||
      !['hls', 'mp4'].includes(result.format) ||
      typeof result.url !== 'string'
    ) {
      return null;
    }

    return {
      type: result.format,
      url: result.url,
      subtitles: Array.isArray(result.subtitles)
        ? result.subtitles.slice(0, 20)
        : []
    };
  } catch {
    return null;
  }
}
