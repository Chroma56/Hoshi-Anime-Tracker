
```javascript
// Hoshi streaming provider adapter
// SDK-ready, opt-in integration for Backend V3.1.
// Only use video sources authorised for Hoshi playback.

function hosts(input) {
  return new Set(
    String(input || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function providerUrl(value) {
  try {
    const u = new URL(value);

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    ) return null;

    return hosts(process.env.PROVIDER_HOSTS)
      .has(u.hostname.toLowerCase()) ? u : null;
  } catch {
    return null;
  }
}

function mediaUrl(value, extension) {
  try {
    const u = new URL(value);

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash
    ) return null;

    if (!hosts(process.env.MEDIA_HOSTS)
      .has(u.hostname.toLowerCase())) return null;

    return extension.test(u.pathname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}

function subtitles(input) {
  return (Array.isArray(input) ? input : [])
    .slice(0, 20)
    .map(track => {
      if (!track || typeof track !== 'object') {
        return null;
      }

      const url = mediaUrl(
        track.url ||
        track.src ||
        track.sourceUrl,
        /\.vtt$/i
      );

      if (!url) return null;

      return {
        url,
        lang: String(
          track.lang ||
          track.language ||
          'en'
        ).slice(0, 16),
        label: String(
          track.label ||
          track.name ||
          'Subtitles'
        ).slice(0, 80)
      };
    })
    .filter(Boolean);
}

function normalizeDirect(data) {
  if (!data || data.available === false) {
    return null;
  }

  const format =
    data.format === 'hls' ||
    data.format === 'mp4'
      ? data.format
      : data.type;

  if (format !== 'hls' && format !== 'mp4') {
    return null;
  }

  const url = mediaUrl(
    data.url,
    format === 'hls'
      ? /\.m3u8$/i
      : /\.mp4$/i
  );

  if (!url) return null;

  return {
    type: format,
    url,
    subtitles: subtitles(data.subtitles)
  };
}

async function officialProvider(
  series,
  episode,
  lang
) {
  const base = providerUrl(
    process.env.PROVIDER_API_URL || ''
  );

  if (!base) return null;

  const url = new URL(base.href);

  url.searchParams.set('series', series);
  url.searchParams.set('episode', episode);
  url.searchParams.set('lang', lang);

  const headers = {
    Accept: 'application/json'
  };

  if (process.env.PROVIDER_API_TOKEN) {
    headers.Authorization =
      'Bearer ' +
      process.env.PROVIDER_API_TOKEN;
  }

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) return null;

    const length = Number(
      response.headers.get(
        'content-length'
      ) || 0
    );

    if (length > 65536) return null;

    const text = await response.text();

    if (text.length > 65536) return null;

    return normalizeDirect(
      JSON.parse(text)
    );
  } catch {
    return null;
  }
}

function aniListId(series) {
  let map;

  try {
    map = JSON.parse(
      process.env.ANILIST_ID_MAP || '{}'
    );
  } catch {
    return null;
  }

  if (
    !map ||
    typeof map !== 'object' ||
    Array.isArray(map)
  ) return null;

  const id = Object.hasOwn(map, series)
    ? String(map[series])
    : (
        process.env
          .HOSHI_SERIES_IDS_ARE_ANILIST ===
        'true'
          ? String(series)
          : ''
      );

  return /^[1-9]\d{0,9}$/.test(id)
    ? id
    : null;
}

// Load the SDK only when enabled.
let sdkInstance;

async function sdk() {
  if (!sdkInstance) {
    sdkInstance = import('anime-sdk')
      .then(lib => {
        const http = new lib.HttpClient({
          timeoutMs: 4000
        });

        return {
          meta: new lib.AnilistMeta(http),
          provider:
            new lib.MegaPlayProvider(http)
        };
      })
      .catch(error => {
        sdkInstance = undefined;
        throw error;
      });
  }

  return sdkInstance;
}

async function sdkProvider(
  series,
  episode,
  lang
) {
  // Keep disabled until direct third-party
  // playback is authorised.
  if (
    process.env.HOSHI_SDK_ENABLED !==
    'true'
  ) return null;

  const id = aniListId(series);

  if (
    !id ||
    !/^\d{1,5}$/.test(episode)
  ) return null;

  try {
    const instance = await sdk();

    const result =
      await instance.meta.resolveStream(
        'anilist:' + id,
        Number(episode),
        instance.provider,
        lang
      );

    if (
      !result ||
      result.type !== 'video' ||
      !Array.isArray(result.streams)
    ) {
      return null;
    }

    for (const stream of result.streams) {
      const candidate =
        stream &&
        (stream.sourceUrl || stream.url);

      if (!candidate) continue;

      let format;

      try {
        const path = new URL(
          candidate
        ).pathname;

        format = /\.m3u8$/i.test(path)
          ? 'hls'
          : 'mp4';
      } catch {
        continue;
      }

      const normalized = normalizeDirect({
        type: format,
        url: candidate,
        subtitles:
          stream.subtitles ||
          stream.tracks ||
          result.subtitles
      });

      if (normalized) {
        return normalized;
      }
    }

    return null;
  } catch (error) {
    console.warn(
      'Hoshi SDK resolution unavailable:',
      String(
        error?.message || error
      ).slice(0, 120)
    );

    return null;
  }
}

// Required by server.mjs
export async function providerEntry(
  series,
  episode,
  lang
) {
  series = String(series);
  episode = String(episode);

  if (
    !/^[A-Za-z0-9_-]{1,60}$/.test(series) ||
    !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) ||
    !['sub', 'dub'].includes(lang)
  ) {
    return null;
  }

  const official = await officialProvider(
    series,
    episode,
    lang
  );

  if (official) return official;

  return sdkProvider(
    series,
    episode,
    lang
  );
}
```
