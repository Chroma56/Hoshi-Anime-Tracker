
import http from 'node:http';
import { providerEntry } from './provider-adapter.mjs';

// Hoshi Stream Backend V3.1
// Keep provider-adapter.mjs unchanged.

const PORT = Number(process.env.PORT || 3000);
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || '';

function splitHosts(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(function (host) {
        return host.trim().toLowerCase();
      })
      .filter(Boolean)
  );
}

function mediaHosts() {
  return splitHosts(process.env.MEDIA_HOSTS);
}

function readCatalog() {
  try {
    const value = JSON.parse(
      process.env.STREAM_CATALOG || '{}'
    );

    return value &&
      typeof value === 'object' &&
      !Array.isArray(value)
      ? value
      : {};
  } catch (error) {
    return {};
  }
}

function providerIsConfigured() {
  try {
    const endpoint = new URL(
      process.env.PROVIDER_API_URL || ''
    );

    return (
      endpoint.protocol === 'https:' &&
      !endpoint.username &&
      !endpoint.password &&
      splitHosts(process.env.PROVIDER_HOSTS)
        .has(endpoint.hostname.toLowerCase())
    );
  } catch (error) {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(body));
}

function safeMediaUrl(value, extension) {
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

    if (!mediaHosts().has(url.hostname.toLowerCase())) {
      return null;
    }

    if (extension && !extension.test(url.pathname)) {
      return null;
    }

    return url.href;
  } catch (error) {
    return null;
  }
}

function parseAttributes(line) {
  const result = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;

  while ((match = regex.exec(line)) !== null) {
    const value = match[2];

    result[match[1]] =
      value.charAt(0) === '"'
        ? value.slice(1, -1)
        : value;
  }

  return result;
}

function parseMasterPlaylist(text, masterUrl) {
  const qualities = [];
  const subtitles = [];

  const lines = String(text)
    .split(/\r?\n/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);

  if (lines[0] !== '#EXTM3U') {
    return {
      qualities: qualities,
      subtitles: subtitles
    };
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attr = parseAttributes(
        line.slice('#EXT-X-STREAM-INF:'.length)
      );

      const next = lines[i + 1];

      if (!next || next.startsWith('#')) {
        continue;
      }

      try {
        const candidate = new URL(
          next,
          masterUrl
        ).href;

        const url = safeMediaUrl(
          candidate,
          /\.m3u8$/i
        );

        if (!url) {
          continue;
        }

        const height =
          Number(
            (attr.RESOLUTION || '').split('x')[1]
          ) || 0;

        const bandwidth =
          Number(attr.BANDWIDTH) || 0;

        qualities.push({
          url: url,
          label: height
            ? String(height) + 'p'
            : 'Auto',
          height: height,
          bandwidth: bandwidth
        });
      } catch (error) {
        continue;
      }
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attr = parseAttributes(
        line.slice('#EXT-X-MEDIA:'.length)
      );

      if (
        attr.TYPE !== 'SUBTITLES' ||
        !attr.URI
      ) {
        continue;
      }

      try {
        const candidate = new URL(
          attr.URI,
          masterUrl
        ).href;

        const url = safeMediaUrl(
          candidate,
          /\.vtt$/i
        );

        if (!url) {
          continue;
        }

        subtitles.push({
          url: url,
          lang: String(
            attr.LANGUAGE || 'en'
          ).slice(0, 16),
          label: String(
            attr.NAME ||
            attr.LANGUAGE ||
            'Subtitles'
          ).slice(0, 80)
        });
      } catch (error) {
        continue;
      }
    }
  }

  qualities.sort(function (a, b) {
    return (
      b.height - a.height ||
      b.bandwidth - a.bandwidth
    );
  });

  return {
    qualities: qualities
      .filter(function (item, index, list) {
        return list.findIndex(function (x) {
          return x.url === item.url;
        }) === index;
      })
      .slice(0, 12),

    subtitles: subtitles
      .filter(function (item, index, list) {
        return list.findIndex(function (x) {
          return x.url === item.url;
        }) === index;
      })
      .slice(0, 20)
  };
}

async function readMasterPlaylist(url) {
  const empty = {
    qualities: [],
    subtitles: []
  };

  try {
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        Accept:
          'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain'
      },
      signal: AbortSignal.timeout(3500)
    });

    if (!response.ok) {
      return empty;
    }

    if (
      Number(
        response.headers.get('content-length') || 0
      ) > 262144
    ) {
      return empty;
    }

    const reader =
      response.body &&
      response.body.getReader();

    if (!reader) {
      return empty;
    }

    const chunks = [];
    let size = 0;

    while (true) {
      const part = await reader.read();

      if (part.done) {
        break;
      }

      size += part.value.byteLength;

      if (size > 262144) {
        await reader.cancel();
        return empty;
      }

      chunks.push(Buffer.from(part.value));
    }

    return parseMasterPlaylist(
      Buffer.concat(chunks).toString('utf8'),
      url
    );
  } catch (error) {
    return empty;
  }
}

function validatedSubtitles(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 20)
    .map(function (track) {
      const url = safeMediaUrl(
        track && track.url,
        /\.vtt$/i
      );

      if (!url) {
        return null;
      }

      return {
        url: url,
        lang: String(
          track.lang || 'en'
        ).slice(0, 16),
        label: String(
          track.label ||
          track.lang ||
          'Subtitles'
        ).slice(0, 80)
      };
    })
    .filter(Boolean);
}

function unavailable(reason) {
  return {
    type: 'embed',
    available: false,
    reason:
      reason ||
      'No authorised direct stream registered'
  };
}

async function resolveStream(
  series,
  episode,
  lang
) {
  const catalog = readCatalog();
  const key =
    series + ':' + episode + ':' + lang;

  let raw =
    Object.prototype.hasOwnProperty.call(
      catalog,
      key
    )
      ? catalog[key]
      : null;

  if (!raw) {
    try {
      raw = await providerEntry(
        series,
        episode,
        lang
      );
    } catch (error) {
      console.error(
        'Provider lookup failed:',
        error && error.message
          ? error.message
          : 'unknown error'
      );

      return unavailable(
        'Direct stream provider unavailable'
      );
    }
  }

  if (!raw || raw.available === false) {
    return unavailable();
  }

  const format =
    raw.format === 'hls' ||
    raw.format === 'mp4'
      ? raw.format
      : raw.type;

  if (
    format !== 'hls' &&
    format !== 'mp4'
  ) {
    return unavailable();
  }

  const url = safeMediaUrl(
    raw.url,
    format === 'hls'
      ? /\.m3u8$/i
      : /\.mp4$/i
  );

  if (!url) {
    return unavailable(
      'Stream URL invalid or host missing from MEDIA_HOSTS'
    );
  }

  const playlist =
    format === 'hls'
      ? await readMasterPlaylist(url)
      : {
          qualities: [],
          subtitles: []
        };

  const subtitles = validatedSubtitles(
    raw.subtitles
  );

  const existingUrls = new Set(
    subtitles.map(function (track) {
      return track.url;
    })
  );

  for (const track of playlist.subtitles) {
    if (!existingUrls.has(track.url)) {
      subtitles.push(track);
      existingUrls.add(track.url);
    }
  }

  return {
    type: 'direct',
    available: true,
    format: format,
    url: url,
    subtitles: subtitles.slice(0, 20),
    qualities: playlist.qualities
  };
}

const server = http.createServer(
  async function (req, res) {
    try {
      const url = new URL(
        req.url || '/',
        'http://localhost'
      );

      if (req.method !== 'GET') {
        return sendJson(res, 405, {
          error: 'Method not allowed'
        });
      }

      if (url.pathname === '/health') {
        const catalogEntries =
          Object.keys(readCatalog()).length;

        const providerConfigured =
          providerIsConfigured();

        return sendJson(res, 200, {
          ok: true,
          service: 'hoshi-node',
          version: '3.1',
          configured:
            catalogEntries > 0 ||
            providerConfigured,
          catalogEntries: catalogEntries,
          providerConfigured:
            providerConfigured
        });
      }

      if (url.pathname !== '/resolve') {
        return sendJson(res, 404, {
          error: 'Not found'
        });
      }

      if (
        !BACKEND_TOKEN ||
        req.headers.authorization !==
          'Bearer ' + BACKEND_TOKEN
      ) {
        return sendJson(res, 401, {
          error: 'Unauthorized'
        });
      }

      const series =
        url.searchParams.get('series') || '';

      const episode =
        url.searchParams.get('episode') || '';

      const lang =
        url.searchParams.get('lang') ||
        'sub';

      if (
        !/^[A-Za-z0-9_-]{1,60}$/.test(series) ||
        !/^[0-9]{1,5}(?:\.[0-9]{1,2})?$/.test(episode) ||
        (lang !== 'sub' && lang !== 'dub')
      ) {
        return sendJson(res, 400, {
          error:
            'Invalid series, episode, or lang'
        });
      }

      return sendJson(
        res,
        200,
        await resolveStream(
          series,
          episode,
          lang
        )
      );
    } catch (error) {
      console.error(
        'Hoshi request error:',
        error && error.message
          ? error.message
          : 'unknown error'
      );

      if (!res.headersSent) {
        return sendJson(res, 500, {
          error: 'Internal server error'
        });
      }

      res.end();
    }
  }
);

if (process.env.NODE_ENV !== 'test') {
  server.listen(
    PORT,
    '0.0.0.0',
    function () {
      console.log(
        'Hoshi stream metadata backend v3.1 listening on ' +
          PORT
      );
    }
  );
}

export {
  server,
  resolveStream,
  parseMasterPlaylist
};
