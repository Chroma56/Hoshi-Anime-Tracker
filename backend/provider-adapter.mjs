
// Hoshi V3.1 — Corrected Provider Adapter
// Compatible with backend/server.mjs.
// Direct streaming requires a configured, authorised provider.

function hostSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(function (s) {
        return s.trim().toLowerCase();
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

    if (
      format === 'hls' &&
      !/\.m3u8$/i.test(url.pathname)
    ) {
      return null;
    }

    if (
      format === 'mp4' &&
      !/\.mp4$/i.test(url.pathname)
    ) {
      return null;
    }

    if (
      format === 'vtt' &&
      !/\.vtt$/i.test(url.pathname)
    ) {
      return null;
    }

    return url.href;
  } catch (error) {
    return null;
  }
}

function cleanSubtitles(subtitles) {
  if (!Array.isArray(subtitles)) {
    return [];
  }

  return subtitles
    .slice(0, 20)
    .map(function (item) {
      if (
        !item ||
        typeof item !== 'object'
      ) {
        return null;
      }

      const url = mediaUrl(
        item.url,
        'vtt'
      );

      if (!url) {
        return null;
      }

      return {
        url: url,
        lang: String(
          item.lang || 'en'
        ).slice(0, 16),
        label: String(
          item.label ||
          item.lang ||
          'Subtitles'
        ).slice(0, 80)
      };
    })
    .filter(Boolean);
}

// Main function required by server.mjs
export async function providerEntry(
  series,
  episode,
  lang
) {
  if (
    !/^[A-Za-z0-9_-]{1,60}$/.test(
      String(series)
    )
  ) {
    return null;
  }

  if (
    !/^\d{1,5}(?:\.\d{1,2})?$/.test(
      String(episode)
    )
  ) {
    return null;
  }

  if (
    lang !== 'sub' &&
    lang !== 'dub'
  ) {
    return null;
  }

  const base = providerUrl(
    process.env.PROVIDER_API_URL || ''
  );

  if (!base) {
    return null;
  }

  const endpoint = new URL(base.href);

  endpoint.searchParams.set(
    'series',
    String(series)
  );

  endpoint.searchParams.set(
    'episode',
    String(episode)
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

    if (
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      ) > 65536
    ) {
      return null;
    }

    const text = await response.text();

    if (text.length > 65536) {
      return null;
    }

    const data = JSON.parse(text);

    if (
      !data ||
      data.available !== true
    ) {
      return null;
    }

    const format =
      data.format === 'hls' ||
      data.format === 'mp4'
        ? data.format
        : data.type;

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
      subtitles: cleanSubtitles(
        data.subtitles
      )
    };
  } catch (error) {
    return null;
  }
}
