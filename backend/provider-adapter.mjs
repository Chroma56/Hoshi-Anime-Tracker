
```javascript
// Hoshi V4 - Optional anime-sdk streaming adapter
// Uses licensed or otherwise authorised direct video sources.
// Preserves Hoshi's existing MegaPlay embed fallback.

export function providerUrl(value) {
  try {
    const url = new URL(value);

    const hosts = String(
      process.env.PROVIDER_HOSTS || ''
    )
      .split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !hosts.includes(url.hostname.toLowerCase())
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function allowedMediaUrl(value, extension) {
  try {
    const url = new URL(value);

    const allowedHosts = String(
      process.env.MEDIA_HOSTS || ''
    )
      .split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !allowedHosts.includes(
        url.hostname.toLowerCase()
      )
    ) {
      return null;
    }

    if (
      extension &&
      !extension.test(url.pathname)
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function normalizeSubtitles(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 20)
    .map(track => {
      if (!track || typeof track !== 'object') {
        return null;
      }

      const url = allowedMediaUrl(
        track.url ||
        track.src ||
        track.sourceUrl,
        /\.vtt$/i
      );

      if (!url) {
        return null;
      }

      return {
        url: url,
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

function normalizeStream(result) {
  if (
    !result ||
    result.type !== 'video' ||
    !Array.isArray(result.streams)
  ) {
    return null;
  }

  for (const stream of result.streams) {
    if (!stream) {
      continue;
    }

    const url = allowedMediaUrl(
      stream.sourceUrl || stream.url,
      /\.(m3u8|mp4)$/i
    );

    if (!url) {
      continue;
    }

    const format = /\.m3u8$/i.test(
      new URL(url).pathname
    ) ? 'hls' : 'mp4';

    return {
      available: true,
      type: format,
      url: url,
      subtitles: normalizeSubtitles(
        stream.subtitles ||
        stream.tracks ||
        result.subtitles
      )
    };
  }

  return null;
}

function getAniListId(series) {
  let mapping = {};

  try {
    const value = JSON.parse(
      process.env.ANILIST_ID_MAP || '{}'
    );

    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      mapping = value;
    }
  } catch {
    return null;
  }

  let id = '';

  if (
    Object.prototype.hasOwnProperty.call(
      mapping,
      series
    )
  ) {
    id = String(mapping[series]);
  } else if (
    process.env.HOSHI_SERIES_IDS_ARE_ANILIST ===
    'true'
  ) {
    id = String(series);
  }

  return /^\d{1,10}$/.test(id)
    ? id
    : null;
}

let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('anime-sdk')
      .then(sdk => {
        const http = new sdk.HttpClient({
          timeoutMs: 4000
        });

        return {
          provider: new sdk.MegaPlayProvider(http),
          metadata: new sdk.AnilistMeta(http)
        };
      })
      .catch(error => {
        sdkPromise = null;
        throw error;
      });
  }

  return sdkPromise;
}

async function sdkResolve(
  series,
  episode,
  lang
) {
  if (
    process.env.HOSHI_SDK_ENABLED !== 'true'
  ) {
    return null;
  }

  const anilistId = getAniListId(series);

  if (
    !anilistId ||
    !['sub', 'dub'].includes(lang) ||
    !/^\d{1,5}$/.test(String(episode))
  ) {
    return null;
  }

  try {
    const sdk = await loadSdk();

    const result =
      await sdk.metadata.resolveStream(
        'anilist:' + anilistId,
        Number(episode),
        sdk.provider,
        lang
      );

    return normalizeStream(result);
  } catch (error) {
    console.warn(
      'Hoshi SDK resolution unavailable:',
      String(
        error && error.message
          ? error.message
          : error
      ).slice(0, 160)
    );

    return null;
  }
}

async function officialProviderResolve(
  series,
  episode,
  lang
) {
  const base = providerUrl(
    process.env.PROVIDER_API_URL || ''
  );

  if (!base || base.search || base.hash) {
    return null;
  }

  const url = new URL(base);

  url.searchParams.set('series', series);
  url.searchParams.set('episode', episode);
  url.searchParams.set('lang', lang);

  try {
    const headers = {
      Accept: 'application/json'
    };

    if (process.env.PROVIDER_API_TOKEN) {
      headers.Authorization =
        'Bearer ' +
        process.env.PROVIDER_API_TOKEN;
    }

    const response = await fetch(
      url.href,
      {
        method: 'GET',
        headers: headers,
        redirect: 'error',
        signal: AbortSignal.timeout(4000)
      }
    );

    if (!response.ok) {
      return null;
    }

    const declaredLength = Number(
      response.headers.get('content-length') || 0
    );

    if (declaredLength > 65536) {
      return null;
    }

    const body = await response.text();

    if (body.length > 65536) {
      return null;
    }

    const result = JSON.parse(body);

    if (
      !result ||
      result.available !== true
    ) {
      return null;
    }

    const format =
      result.format === 'hls' ||
      result.format === 'mp4'
        ? result.format
        : result.type;

    if (
      format !== 'hls' &&
      format !== 'mp4'
    ) {
      return null;
    }

    const url = allowedMediaUrl(
      result.url,
      format === 'hls'
        ? /\.m3u8$/i
        : /\.mp4$/i
    );

    if (!url) {
      return null;
    }

    return {
      available: true,
      type: format,
      url: url,
      subtitles: normalizeSubtitles(
        result.subtitles
      )
    };
  } catch (error) {
    return null;
  }
}

export async function providerEntry(
  series,
  episode,
  lang
) {
  if (
    !/^[A-Za-z0-9_-]{1,60}$/.test(
      String(series)
    ) ||
    !/^\d{1,5}(?:\.\d{1,2})?$/.test(
      String(episode)
    ) ||
    !['sub', 'dub'].includes(lang)
  ) {
    return null;
  }

  // First check an explicitly configured,
  // authorised provider API.
  const official =
    await officialProviderResolve(
      series,
      episode,
      lang
    );

  if (official) {
    return official;
  }

  // Optional anime-sdk integration.
  // Disabled until usage permissions
  // and stream compatibility are verified.
  return sdkResolve(
    series,
    episode,
    lang
  );
}
```
