
/*
 * Hoshi Provider Adapter V4.5
 *
 * Preserves:
 * - V4.4 direct provider integration
 * - AniList ID mapping
 * - MegaPlay SDK fallback
 * - Media host allowlisting
 * - Subtitle validation
 * - Caching
 *
 * Adds:
 * - Optional Anikoto provider
 * - Explicit anime title mapping
 * - Episode number matching
 * - SUB / DUB selection
 *
 * Anikoto direct playback is disabled by default.
 * Enable only with appropriate playback permission.
 */

const CACHE_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 100;
const cache = new Map();

function hosts(name) {
  return new Set(
    String(process.env[name] || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function secureUrl(input, allowed, extension) {
  try {
    const u = new URL(String(input));

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash ||
      u.port ||
      !allowed.has(u.hostname.toLowerCase()) ||
      (extension && !extension.test(u.pathname))
    ) {
      return null;
    }

    return u.href;
  } catch {
    return null;
  }
}

export function providerUrl(value) {
  const valid = secureUrl(
    value,
    hosts('PROVIDER_HOSTS')
  );

  return valid ? new URL(valid) : null;
}

export function getAniListId(series) {
  const id = String(series || '').trim();

  const direct = /^al([1-9]\d{0,9})$/.exec(id);

  if (direct) {
    return direct[1];
  }

  let mapping;

  try {
    mapping = JSON.parse(
      process.env.ANILIST_ID_MAP || '{}'
    );
  } catch {
    return null;
  }

  if (
    !mapping ||
    typeof mapping !== 'object' ||
    Array.isArray(mapping)
  ) {
    return null;
  }

  const candidate = Object.hasOwn(mapping, id)
    ? String(mapping[id])
    : process.env.HOSHI_SERIES_IDS_ARE_ANILIST === 'true'
      ? id
      : '';

  return /^[1-9]\d{0,9}$/.test(candidate)
    ? candidate
    : null;
}

function subtitles(input) {
  const seen = new Set();

  return (Array.isArray(input) ? input : [])
    .slice(0, 30)
    .flatMap(t => {
      if (!t || typeof t !== 'object') {
        return [];
      }

      const url = secureUrl(
        t.url || t.sourceUrl || t.src || t.file,
        hosts('MEDIA_HOSTS'),
        /\.vtt$/i
      );

      if (!url || seen.has(url)) {
        return [];
      }

      seen.add(url);

      return [{
        url,
        lang: String(
          t.lang || t.language || 'en'
        ).slice(0, 16),
        label: String(
          t.label || t.name || 'Subtitles'
        ).slice(0, 80)
      }];
    });
}

function normalize(raw) {
  if (!raw || raw.available === false) {
    return null;
  }

  const format = ['hls', 'mp4'].includes(raw.format)
    ? raw.format
    : raw.type;

  if (!['hls', 'mp4'].includes(format)) {
    return null;
  }

  const url = secureUrl(
    raw.url,
    hosts('MEDIA_HOSTS'),
    format === 'hls'
      ? /\.m3u8$/i
      : /\.mp4$/i
  );

  if (!url) {
    return null;
  }

  return {
    type: format,
    available: true,
    url,
    subtitles: subtitles(raw.subtitles)
  };
}

async function limitedJson(response) {
  if (
    !response.ok ||
    Number(
      response.headers.get('content-length') || 0
    ) > 65536 ||
    !response.body
  ) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.byteLength;

    if (size > 65536) {
      await reader.cancel();
      return null;
    }

    chunks.push(Buffer.from(value));
  }

  return JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  );
}

/*
 * EXISTING CONFIGURED PROVIDER
 */

async function configuredSource(series, episode, lang) {
  const base = providerUrl(
    process.env.PROVIDER_API_URL || ''
  );

  if (!base || base.search) {
    return null;
  }

  const endpoint = new URL(base);

  endpoint.searchParams.set('series', series);
  endpoint.searchParams.set('episode', episode);
  endpoint.searchParams.set('lang', lang);

  const headers = {
    Accept: 'application/json'
  };

  if (process.env.PROVIDER_API_TOKEN) {
    headers.Authorization =
      'Bearer ' + process.env.PROVIDER_API_TOKEN;
  }

  try {
    const response = await fetch(endpoint, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });

    return normalize(
      await limitedJson(response)
    );
  } catch {
    return null;
  }
}

/*
 * EXISTING MEGAPLAY SDK
 */

let sdkPromise;

async function sdkClients() {
  if (!sdkPromise) {
    sdkPromise = import('anime-sdk')
      .then(lib => {
        const http = new lib.HttpClient({
          timeoutMs: 4000
        });

        return {
          meta: new lib.AnilistMeta(http, {
            mappingClient: new lib.MappingClient(http)
          }),
          provider: new lib.MegaPlayProvider(http)
        };
      })
      .catch(error => {
        sdkPromise = null;
        throw error;
      });
  }

  return sdkPromise;
}

function normalizeSdkResult(result) {
  if (
    result?.type !== 'video' ||
    !Array.isArray(result.streams)
  ) {
    return null;
  }

  for (const stream of result.streams) {
    const source =
      stream?.sourceUrl ||
      stream?.url;

    let pathname;

    try {
      pathname = new URL(source).pathname;
    } catch {
      continue;
    }

    const format = /\.m3u8$/i.test(pathname)
      ? 'hls'
      : /\.mp4$/i.test(pathname)
        ? 'mp4'
        : null;

    if (!format) {
      continue;
    }

    // Hoshi's current player cannot attach custom
    // Referer, cookies or authorization headers.
    // Reject streams requiring those headers.
    if (
      stream.headers &&
      Object.keys(stream.headers).length > 0
    ) {
      continue;
    }

    const item = normalize({
      type: format,
      url: source,
      subtitles:
        stream.subtitles ||
        stream.tracks ||
        result.subtitles ||
        []
    });

    if (item) {
      return item;
    }
  }

  return null;
}

async function sdkSource(series, episode, lang) {
  if (
    process.env.HOSHI_SDK_ENABLED !== 'true'
  ) {
    return null;
  }

  const id = getAniListId(series);

  if (
    !id ||
    !/^\d{1,5}$/.test(episode)
  ) {
    return null;
  }

  try {
    const { meta, provider } =
      await sdkClients();

    const result = await meta.resolveStream(
      'anilist:' + id,
      Number(episode),
      provider,
      lang
    );

    return normalizeSdkResult(result);
  } catch (error) {
    console.warn(
      'Hoshi SDK resolver:',
      String(
        error?.message || error
      ).slice(0, 140)
    );

    return null;
  }
}

/*
 * NEW ANIKOTO INTEGRATION
 */

let anikotoModulePromise;

async function anikotoModule() {
  if (!anikotoModulePromise) {
    anikotoModulePromise = import(
      './anikoto-provider.mjs'
    ).catch(error => {
      anikotoModulePromise = null;
      throw error;
    });
  }

  return anikotoModulePromise;
}

async function anikotoSource(series, episode, lang) {
  // Two independent safety switches.
  if (
    process.env.ANIKOTO_DIRECT_ENABLED !== 'true' ||
    process.env.ANIKOTO_PLAYBACK_AUTHORISED !== 'true'
  ) {
    return null;
  }

  if (!/^\d{1,5}$/.test(episode)) {
    return null;
  }

  try {
    const {
      createAnikotoProvider,
      getMappedTitle,
      matchAnime
    } = await anikotoModule();

    const title = getMappedTitle(series);

    // Never guess which anime to play.
    if (!title) {
      return null;
    }

    const provider = createAnikotoProvider();

    const searchResults =
      await provider.search(title);

    const matches = matchAnime(
      searchResults,
      title
    );

    // Require exactly one matching title.
    if (matches.length !== 1) {
      return null;
    }

    const units =
      await provider.fetchContentUnits(
        matches[0].id
      );

    if (!Array.isArray(units)) {
      return null;
    }

    const wantedEpisode = Number(episode);

    const matchingEpisodes = units.filter(
      unit =>
        Number(unit?.number) === wantedEpisode
    );

    // Avoid the wrong episode.
    if (matchingEpisodes.length !== 1) {
      return null;
    }

    const unit = matchingEpisodes[0];

    // If the SDK knows which languages exist,
    // don't request an unavailable dub/sub.
    if (
      Array.isArray(unit.availableLanguages) &&
      unit.availableLanguages.length > 0 &&
      !unit.availableLanguages.includes(lang)
    ) {
      return null;
    }

    const result = await provider.resolveStream(
      unit.id,
      lang
    );

    return normalizeSdkResult(result);
  } catch (error) {
    console.warn(
      'Hoshi Anikoto:',
      String(
        error?.message || error
      ).slice(0, 140)
    );

    return null;
  }
}

/*
 * HOSHI PROVIDER ENTRY
 *
 * Priority:
 * 1. Configured source
 * 2. Anikoto (opt-in)
 * 3. Existing MegaPlay SDK (opt-in)
 *
 * Returns null when no permitted direct
 * video is available. Hoshi will then
 * use its existing embed fallback.
 */

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

  const key = [
    series,
    episode,
    lang
  ].join(':');

  const hit = cache.get(key);

  if (
    hit &&
    hit.until > Date.now()
  ) {
    return hit.value;
  }

  const value =
    await configuredSource(
      series,
      episode,
      lang
    ) ||
    await anikotoSource(
      series,
      episode,
      lang
    ) ||
    await sdkSource(
      series,
      episode,
      lang
    );

  if (value) {
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(
        cache.keys().next().value
      );
    }

    cache.set(key, {
      value,
      until: Date.now() + CACHE_MS
    });
  }

  return value;
}
