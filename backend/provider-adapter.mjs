
// Hoshi V4 - Provider Adapter
// Compatible with Hoshi Backend V3.1
// Optional anime-sdk integration.
// Do not enable unverified third-party video sources.

function hostSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(function (host) {
        return host.trim().toLowerCase();
      })
      .filter(Boolean)
  );
}

export function providerUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      return null;
    }

    if (
      !hostSet(process.env.PROVIDER_HOSTS)
        .has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    return url;
  } catch (error) {
    return null;
  }
}

function mediaUrl(value, format) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }

    if (
      !hostSet(process.env.MEDIA_HOSTS)
        .has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    const patterns = {
      hls: /\.m3u8$/i,
      mp4: /\.mp4$/i,
      vtt: /\.vtt$/i
    };

    if (
      !patterns[format] ||
      !patterns[format].test(url.pathname)
    ) {
      return null;
    }

    return url.href;
  } catch (error) {
    return null;
  }
}

function normalizeSubtitles(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .slice(0, 20)
    .map(function (track) {
      if (
        !track ||
        typeof track !== 'object'
      ) {
        return null;
      }

      const url = mediaUrl(
        track.url ||
        track.src ||
        track.sourceUrl,
        'vtt'
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

function normalizeDirect(data) {
  if (
    !data ||
    data.available === false
  ) {
    return null;
  }

  let format = data.format;

  if (
    format !== 'hls' &&
    format !== 'mp4'
  ) {
    format = data.type;
  }

  if (
    format !== 'hls' &&
    format !== 'mp4'
  ) {
    return null;
  }

  const url = mediaUrl(
    data.url,
    format
  );

  if (!url) {
    return null;
  }

  return {
    type: format,
    available: true,
    url: url,
    subtitles: normalizeSubtitles(
      data.subtitles
    )
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

  if (!base) {
    return null;
  }

  const endpoint = new URL(base.href);

  endpoint.searchParams.set(
    'series',
    series
  );

  endpoint.searchParams.set(
    'episode',
    episode
  );

  endpoint.searchParams.set(
    'lang',
    lang
  );

  const headers = {
    Accept: 'application/json'
  };

  if (process.env.PROVIDER_API_TOKEN) {
    headers.Authorization =
      'Bearer ' +
      process.env.PROVIDER_API_TOKEN;
  }

  try {
    const response = await fetch(
      endpoint.href,
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
      response.headers.get(
        'content-length'
      ) || 0
    );

    if (declaredLength > 65536) {
      return null;
    }

    const body = await response.text();

    if (body.length > 65536) {
      return null;
    }

    return normalizeDirect(
      JSON.parse(body)
    );
  } catch (error) {
    return null;
  }
}

function getAniListId(series) {
  let mapping = {};

  try {
    const parsed = JSON.parse(
      process.env.ANILIST_ID_MAP || '{}'
    );

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      mapping = parsed;
    }
  } catch (error) {
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

  if (!/^[1-9]\d{0,9}$/.test(id)) {
    return null;
  }

  return id;
}

let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('anime-sdk')
      .then(function (lib) {
        if (
          typeof lib.HttpClient !== 'function' ||
          typeof lib.AnilistMeta !== 'function' ||
          typeof lib.MegaPlayProvider !== 'function'
        ) {
          throw new Error(
            'Required anime-sdk exports unavailable'
          );
        }

        const http = new lib.HttpClient({
          timeoutMs: 4000
        });

        return {
          metadata: new lib.AnilistMeta(http),
          provider: new lib.MegaPlayProvider(http)
        };
      })
      .catch(function (error) {
        sdkPromise = null;
        throw error;
      });
  }

  return sdkPromise;
}

async function sdkProvider(
  series,
  episode,
  lang
) {
  // Disabled until the selected video source
  // permits direct playback on Hoshi.
  if (
    process.env.HOSHI_SDK_ENABLED !== 'true'
  ) {
    return null;
  }

  const anilistId = getAniListId(series);

  if (
    !anilistId ||
    !/^\d{1,5}$/.test(episode)
  ) {
    return null;
  }

  try {
    const sdk = await loadSdk();

    if (
      typeof sdk.metadata.resolveStream !==
      'function'
    ) {
      return null;
    }

    const result =
      await sdk.metadata.resolveStream(
        'anilist:' + anilistId,
        Number(episode),
        sdk.provider,
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
      if (!stream) {
        continue;
      }

      const candidate =
        stream.sourceUrl ||
        stream.url;

      if (!candidate) {
        continue;
      }

      let format;

      try {
        const path = new URL(
          candidate
        ).pathname;

        if (/\.m3u8$/i.test(path)) {
          format = 'hls';
        } else if (/\.mp4$/i.test(path)) {
          format = 'mp4';
        } else {
          continue;
        }
      } catch (error) {
        continue;
      }

      const normalized = normalizeDirect({
        type: format,
        url: candidate,
        subtitles:
          stream.subtitles ||
          stream.tracks ||
          result.subtitles ||
          []
      });

      if (normalized) {
        return normalized;
      }
    }

    return null;
  } catch (error) {
    console.warn(
      'Hoshi SDK unavailable:',
      String(
        error && error.message
          ? error.message
          : error
      ).slice(0, 120)
    );

    return null;
  }
}

// Required export for backend/server.mjs
export async function providerEntry(
  series,
  episode,
  lang
) {
  series = String(series);
  episode = String(episode);
  lang = String(lang);

  if (
    !/^[A-Za-z0-9_-]{1,60}$/.test(series) ||
    !/^\d{1,5}(?:\.\d{1,2})?$/.test(episode) ||
    !['sub', 'dub'].includes(lang)
  ) {
    return null;
  }

  // Prefer a configured, authorised API.
  const official = await officialProvider(
    series,
    episode,
    lang
  );

  if (official) {
    return official;
  }

  // Optional SDK resolver.
  // Returns null if disabled or unavailable.
  return sdkProvider(
    series,
    episode,
    lang
  );
}
