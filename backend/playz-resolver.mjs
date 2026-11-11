
/**
 * HOSHI V4 — Patched Playz-Style Resolver
 *
 * Node.js ES module.
 * Requires explicit provider permission.
 * Only connects to approved HTTPS media hosts.
 */

import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const EMBED_ORIGIN = 'https://megaplay.buzz';

const MAX_HTML = 512 * 1024;
const MAX_JSON = 256 * 1024;
const MAX_PLAYLIST = 1024 * 1024;

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

// ---------------------------------------------
// NETWORK SECURITY
// ---------------------------------------------

const deniedIPv4 = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  deniedIPv4.addSubnet(address, prefix, 'ipv4');
}

const deniedIPv6 = new net.BlockList();

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) {
  deniedIPv6.addSubnet(address, prefix, 'ipv6');
}

const globalIPv6 = new net.BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

function enabled(name) {
  return process.env[name] === 'true';
}

function allowedHosts() {
  return new Set(
    String(process.env.MEDIA_HOSTS || '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

function approvedMedia(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value.trim());

    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      net.isIP(url.hostname) ||
      !allowedHosts().has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function providerUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.origin !== EMBED_ORIGIN ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function publicAddress(ip) {
  const family = net.isIP(ip);

  if (family === 4) {
    return !deniedIPv4.check(ip, 'ipv4');
  }

  if (family === 6) {
    return (
      globalIPv6.check(ip, 'ipv6') &&
      !deniedIPv6.check(ip, 'ipv6')
    );
  }

  return false;
}

// ---------------------------------------------
// SAFE HTTPS REQUEST
// ---------------------------------------------

async function getText(value, headers = {}, limit = MAX_JSON) {
  const safeUrl =
    providerUrl(value)?.href ??
    approvedMedia(value);

  if (!safeUrl) {
    throw new Error('HOST_NOT_APPROVED');
  }

  const target = new URL(safeUrl);

  const records = await dns.lookup(target.hostname, {
    all: true
  });

  if (
    !records.length ||
    records.some(record => !publicAddress(record.address))
  ) {
    throw new Error('NON_PUBLIC_DESTINATION');
  }

  const selected = records[0];

  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method: 'GET',
        timeout: 12000,
        headers: {
          Accept: '*/*',
          ...headers
        },
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [{
              address: selected.address,
              family: selected.family
            }]);
          } else {
            callback(
              null,
              selected.address,
              selected.family
            );
          }
        }
      },
      response => {
        if (response.statusCode !== 200) {
          const status = response.statusCode;
          response.resume();
          reject(new Error(`HTTP_${status}`));
          return;
        }

        const chunks = [];
        let received = 0;

        response.on('data', chunk => {
          received += chunk.length;

          if (received > limit) {
            request.destroy(
              new Error('RESPONSE_TOO_LARGE')
            );
            return;
          }

          chunks.push(chunk);
        });

        response.on('end', () => {
          resolve(
            Buffer.concat(chunks).toString('utf8')
          );
        });

        response.on('error', reject);
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('TIMEOUT'));
    });

    request.on('error', reject);
    request.end();
  });
}

// ---------------------------------------------
// PLAYER ID DETECTION
// ---------------------------------------------

function playerId(html) {
  const playerTag =
    /<[^>]*\bid=["']megaplay-player["'][^>]*>/i
      .exec(html)?.[0];

  const id =
    playerTag?.match(
      /\bdata-id=["'](\d+)["']/i
    )?.[1] ??
    /<[^>]*\bdata-id=["'](\d+)["'][^>]*>/i
      .exec(html)?.[1] ??
    /<title>\s*File\s+(\d+)/i
      .exec(html)?.[1];

  return id && /^\d{1,15}$/.test(id)
    ? id
    : null;
}

// ---------------------------------------------
// METADATA NORMALIZATION
// ---------------------------------------------

function unwrapPayload(value) {
  let current = value;

  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object') {
      break;
    }

    if (
      current.sources !== undefined ||
      current.streams !== undefined ||
      current.file !== undefined ||
      current.playback !== undefined ||
      current.url !== undefined
    ) {
      break;
    }

    const next =
      current.data ??
      current.result ??
      current.payload;

    if (!next || typeof next !== 'object') {
      break;
    }

    current = next;
  }

  return current;
}

// ---------------------------------------------
// SUBTITLE DETECTION
// ---------------------------------------------

function trackList(rawPayload) {
  const data = unwrapPayload(rawPayload);

  const locations =
    data === rawPayload
      ? [data]
      : [data, rawPayload];

  const tracks = locations.flatMap(location => [
    ...(Array.isArray(location?.tracks)
      ? location.tracks
      : []),

    ...(Array.isArray(location?.subtitles)
      ? location.subtitles
      : [])
  ]);

  return tracks.slice(0, 30).flatMap(track => {
    const url = approvedMedia(
      track?.file ??
      track?.url ??
      track?.src
    );

    if (
      !url ||
      !/\.(vtt|srt)$/i.test(new URL(url).pathname)
    ) {
      return [];
    }

    return [{
      url,
      lang: String(
        track.lang ??
        track.language ??
        'en'
      ).slice(0, 16),

      label: String(
        track.label ??
        'Subtitles'
      ).slice(0, 80)
    }];
  });
}

// ---------------------------------------------
// HLS SOURCE EXTRACTION
// ---------------------------------------------

function clearCandidates(rawPayload) {
  const data = unwrapPayload(rawPayload);
  const found = new Set();

  function add(value, depth = 0) {
    if (value == null || depth > 5) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        add(item, depth + 1);
      }
      return;
    }

    if (typeof value === 'object') {
      for (const key of [
        'file',
        'url',
        'src',
        'master',
        'playlist',
        'source',
        'sources',
        'streams',
        'hls',
        'playback'
      ]) {
        add(value[key], depth + 1);
      }
      return;
    }

    if (typeof value !== 'string') return;

    const input = value.trim();

    // Handle serialized JSON sources.
    if (
      input.startsWith('[') ||
      input.startsWith('{')
    ) {
      try {
        add(JSON.parse(input), depth + 1);
      } catch {
        // Ignore malformed JSON source lists.
      }
      return;
    }

    const url = approvedMedia(input);

    if (
      url &&
      /\.m3u8$/i.test(new URL(url).pathname)
    ) {
      found.add(url);
    }
  }

  for (const value of [
    data?.sources,
    data?.source,
    data?.streams,
    data?.file,
    data?.url,
    data?.master,
    data?.playback,
    data?.hls
  ]) {
    add(value);
  }

  // Only enable if the provider has explicitly
  // authorized directory-level URL discovery.
  if (enabled('MEGAPLAY_FOLDER_DISCOVERY')) {
    for (const track of trackList(rawPayload)) {
      const url = new URL(track.url);

      const match =
        /^(.+?)\/(?:subtitles|sprites|thumbnails)\/.+$/i
          .exec(url.pathname);

      if (!match) continue;

      url.pathname = `${match[1]}/master.m3u8`;
      url.search = '';

      const candidate = approvedMedia(url.href);

      if (candidate) {
        found.add(candidate);
      }
    }
  }

  return [...found].slice(0, 6);
}

// ---------------------------------------------
// DIAGNOSTICS
// ---------------------------------------------

function logDiagnostic(root, payload, candidates) {
  const rootObject =
    root && typeof root === 'object'
      ? root
      : {};

  const body =
    payload && typeof payload === 'object'
      ? payload
      : {};

  const diagnostic = {
    metadataReceived: true,

    rootKeys:
      Object.keys(rootObject).slice(0, 25),

    payloadKeys:
      Object.keys(body).slice(0, 25),

    sourcesType:
      Array.isArray(body.sources)
        ? 'array'
        : typeof body.sources,

    hasFileField:
      typeof body.file === 'string',

    subtitleTrackCount:
      trackList(root).length,

    approvedPlaylistCandidates:
      candidates.length,

    approvedHostCount:
      allowedHosts().size,

    browserFallbackEnabled:
      enabled('HOSHI_PLAYZ_BROWSER'),

    folderDiscoveryEnabled:
      enabled('MEGAPLAY_FOLDER_DISCOVERY')
  };

  console.info(
    'HOSHI PLAYLIST DIAGNOSTIC:',
    JSON.stringify(diagnostic)
  );
}

// ---------------------------------------------
// OPTIONAL BROWSER FALLBACK
// ---------------------------------------------

async function browserCandidate(embedUrl) {
  if (!enabled('HOSHI_PLAYZ_BROWSER')) {
    return null;
  }

  let chromium;

  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn(
      'Hoshi V4: PLAYWRIGHT_NOT_INSTALLED'
    );
    return null;
  }

  const browser = await chromium.launch({
    headless: true
  });

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block'
    });

    try {
      const page = await context.newPage();
      const found = new Set();

      page.on('request', request => {
        const url = request.url();

        if (
          /\.m3u8(?:\?|$)/i.test(url) &&
          approvedMedia(url)
        ) {
          found.add(url);
        }
      });

      await page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 12000
      });

      if (!found.size) {
        await page.waitForTimeout(5000);
      }

      for (const url of found) {
        const playlist = await getText(
          url,
          {
            Referer: `${EMBED_ORIGIN}/`
          },
          MAX_PLAYLIST
        ).catch(() => null);

        if (
          playlist?.trimStart().startsWith('#EXTM3U')
        ) {
          return {
            url,
            text: playlist
          };
        }
      }

      return null;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------
// MAIN RESOLVER
// ---------------------------------------------

export async function resolvePlayzStyle(
  series,
  episode,
  lang
) {
  if (
    !enabled('HOSHI_PLAYZ_ENABLED') ||
    !enabled('MEGAPLAY_SOURCE_PERMISSION')
  ) {
    return null;
  }

  // Validate episode arguments.
  const match =
    /^al([1-9]\d{0,9})$/.exec(String(series));

  if (
    !match ||
    !/^\d{1,5}$/.test(String(episode)) ||
    !['sub', 'dub'].includes(lang)
  ) {
    console.warn(
      'Hoshi V4: INVALID_EPISODE_ARGUMENTS'
    );
    return null;
  }

  // Check existing cache.
  const key = `${series}:${episode}:${lang}`;

  const cached = cache.get(key);

  if (cached && cached.until > Date.now()) {
    return cached.value;
  }

  if (cached) {
    cache.delete(key);
  }

  const embedUrl =
    `${EMBED_ORIGIN}/stream/ani/` +
    `${match[1]}/${episode}/${lang}`;

  try {
    // STEP 1: Retrieve embed metadata.
    const html = await getText(
      embedUrl,
      {
        Referer: `${EMBED_ORIGIN}/`
      },
      MAX_HTML
    );

    // STEP 2: Extract player identifier.
    const id = playerId(html);

    if (!id) {
      throw new Error('PLAYER_ID_MISSING');
    }

    // STEP 3: Construct source API request.
    const sourceUrl = new URL(
      '/stream/getSources',
      EMBED_ORIGIN
    );

    sourceUrl.searchParams.set('id', id);

    let rootPayload = null;
    let payload = null;
    let candidates = [];

    // STEP 4: Request and normalize sources.
    try {
      const responseText = await getText(
        sourceUrl.href,
        {
          Referer: embedUrl,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json'
        },
        MAX_JSON
      );

      rootPayload = JSON.parse(responseText);

      payload = unwrapPayload(rootPayload);

      candidates = clearCandidates(payload);

      logDiagnostic(
        rootPayload,
        payload,
        candidates
      );
    } catch (error) {
      console.warn(
        'Hoshi V4: SOURCES_METADATA_UNAVAILABLE:',
        String(
          error?.message ?? error
        ).slice(0, 120)
      );
    }

    let result = null;

    const subtitles = trackList(
      rootPayload ?? payload
    );

    // STEP 5: Validate approved playlists.
    for (const candidate of candidates) {
      try {
        const playlist = await getText(
          candidate,
          {
            Referer: `${EMBED_ORIGIN}/`,
            Origin: EMBED_ORIGIN
          },
          MAX_PLAYLIST
        );

        if (
          playlist.trimStart().startsWith('#EXTM3U')
        ) {
          result = {
            type: 'hls',
            url: candidate,
            referer: `${EMBED_ORIGIN}/`,
            subtitles
          };

          break;
        }

        console.warn(
          'Hoshi V4: CANDIDATE_NOT_HLS'
        );
      } catch (error) {
        console.warn(
          'Hoshi V4: PLAYLIST_FETCH_FAILED:',
          String(
            error?.message ?? error
          ).slice(0, 120)
        );
      }
    }

    // STEP 6: Optional authorized fallback.
    if (!result) {
      const found = await browserCandidate(
        embedUrl
      );

      if (found) {
        result = {
          type: 'hls',
          url: found.url,
          referer: `${EMBED_ORIGIN}/`,
          subtitles
        };
      }
    }

    // STEP 7: Final validation.
    if (!result) {
      throw new Error('PLAYLIST_NOT_FOUND');
    }

    // STEP 8: Store successful resolution.
    if (cache.size >= 100) {
      cache.delete(
        cache.keys().next().value
      );
    }

    cache.set(key, {
      value: result,
      until: Date.now() + CACHE_TTL_MS
    });

    console.info(
      'Hoshi V4: STREAM_RESOLVED',
      {
        type: result.type,
        subtitles: result.subtitles.length
      }
    );

    return result;
  } catch (error) {
    console.warn(
      'Hoshi Playz-style resolver:',
      String(
        error?.message ?? error
      ).slice(0, 120)
    );

    return null;
  }
}
