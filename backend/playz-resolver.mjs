
/**
 * HOSHI V4 — Complete Diagnostic Patch
 *
 * Includes:
 * - Source response normalization
 * - HLS playlist validation
 * - Subtitle and track analysis
 * - ENC/server metadata diagnostics
 * - Approved CDN checks
 * - DNS safety checks
 * - Optional browser fallback
 * - Optional authorized folder discovery
 * - Successful stream caching
 *
 * Only use with explicitly authorized providers and media hosts.
 */

import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const EMBED_ORIGIN = 'https://megaplay.buzz';

const MAX_HTML = 512 * 1024;
const MAX_JSON = 256 * 1024;
const MAX_PLAYLIST = 1024 * 1024;

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

// The embed's player asks this file which CDN mirror
// to use when the usual one fails. Kept for 10 minutes.
let mirror = null;

async function fallbackMirror() {
  if (
    mirror &&
    Date.now() - mirror.at < 10 * 60 * 1000
  ) {
    return mirror.host;
  }

  let host = null;

  try {
    const data = JSON.parse(
      await getText(
        `${EMBED_ORIGIN}/lib/check_domain.json` +
        `?cache_burst=${Date.now()}`,
        { Referer: `${EMBED_ORIGIN}/` },
        MAX_JSON
      )
    );

    if (
      typeof data?.fallback === 'string' &&
      /^[a-z0-9.-]+$/i.test(data.fallback)
    ) {
      host = data.fallback.toLowerCase();
    }
  } catch {
    // No mirror known; the usual host is tried alone.
  }

  mirror = { at: Date.now(), host };

  return host;
}

// ============================================
// CONFIGURATION
// ============================================

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

// A MEDIA_HOSTS entry is an exact host name, or
// "*.example.com" for every subdomain of example.com.
function hostListed(host) {
  const hosts = allowedHosts();

  if (hosts.has(host)) return true;

  for (const entry of hosts) {
    if (
      entry.startsWith('*.') &&
      entry.length > 3 &&
      host.length > entry.length - 1 &&
      host.endsWith(entry.slice(1))
    ) {
      return true;
    }
  }

  return false;
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
      !hostListed(url.hostname.toLowerCase())
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

    return url.href;
  } catch {
    return null;
  }
}

// ============================================
// NETWORK SAFETY
// ============================================

const blockedIPv4 = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  blockedIPv4.addSubnet(address, prefix, 'ipv4');
}

const globalIPv6 = new net.BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

const blockedIPv6 = new net.BlockList();

for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16]
]) {
  blockedIPv6.addSubnet(address, prefix, 'ipv6');
}

function publicAddress(address) {
  const family = net.isIP(address);

  if (family === 4) {
    return !blockedIPv4.check(address, 'ipv4');
  }

  if (family === 6) {
    return (
      globalIPv6.check(address, 'ipv6') &&
      !blockedIPv6.check(address, 'ipv6')
    );
  }

  return false;
}

// ============================================
// HTTPS FETCH
// ============================================

async function getText(
  value,
  headers = {},
  limit = MAX_JSON
) {
  const safeUrl =
    providerUrl(value) ??
    approvedMedia(value);

  if (!safeUrl) {
    throw new Error('HOST_NOT_APPROVED');
  }

  const target = new URL(safeUrl);

  const addresses = await dns.lookup(
    target.hostname,
    { all: true }
  );

  if (
    !addresses.length ||
    addresses.some(
      entry => !publicAddress(entry.address)
    )
  ) {
    throw new Error('NON_PUBLIC_DESTINATION');
  }

  const selected = addresses[0];

  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method: 'GET',
        timeout: 12000,
        headers: {
          // Without a browser User-Agent the embed host
          // and its CDN tend to answer 403.
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...headers
        },
        lookup: (_host, options, callback) => {
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

          reject(
            new Error(`HTTP_${status}`)
          );

          return;
        }

        const chunks = [];
        let size = 0;

        response.on('data', chunk => {
          size += chunk.length;

          if (size > limit) {
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

// ============================================
// PLAYER ID
// ============================================

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

// ============================================
// PAYLOAD NORMALIZATION
// ============================================

function payloadLayers(root) {
  const layers = [];
  let current = root;

  for (let depth = 0; depth < 4; depth++) {
    if (
      !current ||
      typeof current !== 'object'
    ) {
      break;
    }

    layers.push(current);

    const next =
      current.data ??
      current.result ??
      current.payload;

    if (
      !next ||
      typeof next !== 'object' ||
      next === current
    ) {
      break;
    }

    current = next;
  }

  return layers;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';

  return typeof value;
}

function keysOf(value) {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return [];
  }

  return Object.keys(value).slice(0, 20);
}

// ============================================
// TRACK INSPECTION
// ============================================

function allTracks(root) {
  return payloadLayers(root).flatMap(layer => [
    ...(Array.isArray(layer.tracks)
      ? layer.tracks
      : []),

    ...(Array.isArray(layer.subtitles)
      ? layer.subtitles
      : [])
  ]);
}

function inspectTrack(track) {
  const file =
    track?.file ??
    track?.url ??
    track?.src;

  if (
    typeof file !== 'string' ||
    !file.trim()
  ) {
    return {
      reason: 'missingFile',
      extension: 'none',
      url: null
    };
  }

  let parsed;

  try {
    parsed = new URL(file);
  } catch {
    return {
      reason: 'relativeOrInvalid',
      extension: 'unknown',
      url: null
    };
  }

  const extension =
    parsed.pathname.match(
      /\.([a-z0-9]+)$/i
    )?.[1]?.toLowerCase() ?? 'none';

  if (parsed.protocol !== 'https:') {
    return {
      reason: 'notHttps',
      extension,
      url: null
    };
  }

  const approved = approvedMedia(file);

  if (!approved) {
    return {
      reason: 'unapprovedHost',
      extension,
      url: null
    };
  }

  if (
    extension !== 'vtt' &&
    extension !== 'srt'
  ) {
    return {
      reason: 'unsupportedExtension',
      extension,
      url: null
    };
  }

  return {
    reason: 'accepted',
    extension,
    url: approved
  };
}

// ============================================
// TRACK DIAGNOSTICS
// ============================================

function logTrackAnalysis(root) {
  const tracks = allTracks(root);
  const first = tracks[0];

  const reasons = {
    accepted: 0,
    missingFile: 0,
    relativeOrInvalid: 0,
    notHttps: 0,
    unapprovedHost: 0,
    unsupportedExtension: 0
  };

  for (const track of tracks) {
    const inspection = inspectTrack(track);

    if (inspection.reason in reasons) {
      reasons[inspection.reason]++;
    }
  }

  const firstInspection = inspectTrack(first);

  const firstFile =
    first?.file ??
    first?.url ??
    first?.src;

  const kinds = [
    ...new Set(
      tracks.map(track => {
        const kind = String(
          track?.kind ?? 'unknown'
        );

        return /^[\w -]{1,24}$/.test(kind)
          ? kind
          : 'unknown';
      })
    )
  ].slice(0, 10);

  const diagnostic = {
    totalTracks: tracks.length,

    kinds,

    firstTrack: {
      kind:
        typeof first?.kind === 'string' &&
        /^[\w -]{1,24}$/.test(first.kind)
          ? first.kind
          : 'unknown',

      hasFile:
        typeof firstFile === 'string',

      fileIsAbsoluteHttps:
        typeof firstFile === 'string' &&
        firstFile.startsWith('https://'),

      fileExtension:
        firstInspection.extension,

      validationResult:
        firstInspection.reason
    },

    validationSummary: reasons,

    // Host names only (no paths or tokens): these are
    // what MEDIA_HOSTS is missing when tracks are refused.
    unapprovedHosts: [
      ...new Set(
        tracks.flatMap(track => {
          if (inspectTrack(track).reason !== 'unapprovedHost') {
            return [];
          }

          try {
            return [
              new URL(
                track.file ?? track.url ?? track.src
              ).hostname.toLowerCase()
            ];
          } catch {
            return [];
          }
        })
      )
    ].slice(0, 10),

    approvedHostCount:
      allowedHosts().size
  };

  // Never log the raw track URLs or tokens.
  console.info(
    'HOSHI TRACK ANALYSIS:',
    JSON.stringify(diagnostic)
  );
}

// ============================================
// SUBTITLE EXTRACTION
// ============================================

// everyKind: also return thumbnail and sprite tracks.
// Those are not subtitles, but they sit in the same
// folder, which is what folder discovery looks for.
function trackList(root, everyKind = false) {
  const seen = new Set();
  const subtitles = [];

  for (const track of allTracks(root).slice(0, 80)) {
    if (
      !everyKind &&
      typeof track?.kind === 'string' &&
      !['captions', 'subtitles'].includes(
        track.kind.toLowerCase()
      )
    ) {
      continue;
    }

    const inspection = inspectTrack(track);

    if (
      inspection.reason !== 'accepted' ||
      !inspection.url
    ) {
      continue;
    }

    if (seen.has(inspection.url)) {
      continue;
    }

    seen.add(inspection.url);

    subtitles.push({
      url: inspection.url,

      lang: String(
        track.lang ??
        track.language ??
        'en'
      ).slice(0, 16),

      label: String(
        track.label ??
        'Subtitles'
      ).slice(0, 80)
    });
  }

  return subtitles;
}

// ============================================
// SOURCE CANDIDATE EXTRACTION
// ============================================

function clearCandidates(root) {
  const found = new Set();

  function add(value, depth = 0) {
    if (
      value === undefined ||
      value === null ||
      depth > 5
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        add(entry, depth + 1);
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

    if (typeof value !== 'string') {
      return;
    }

    const input = value.trim();

    if (
      input.startsWith('[') ||
      input.startsWith('{')
    ) {
      try {
        add(
          JSON.parse(input),
          depth + 1
        );
      } catch {
        // Ignore invalid serialized source data.
      }

      return;
    }

    const url = approvedMedia(input);

    if (
      url &&
      /\.m3u8$/i.test(
        new URL(url).pathname
      )
    ) {
      found.add(url);
    }
  }

  for (const layer of payloadLayers(root)) {
    for (const key of [
      'sources',
      'source',
      'streams',
      'file',
      'url',
      'master',
      'playback',
      'hls'
    ]) {
      add(layer[key]);
    }
  }

  // Only enable when explicitly authorized.
  if (enabled('MEGAPLAY_FOLDER_DISCOVERY')) {
    for (const track of trackList(root, true)) {
      const url = new URL(track.url);

      const match =
        /^(.+?)\/(?:subtitles|sprites?|thumbnails?)\/.+$/i
          .exec(url.pathname);

      if (!match) continue;

      url.pathname =
        `${match[1]}/master.m3u8`;

      url.search = '';

      const candidate = approvedMedia(url.href);

      if (candidate) {
        found.add(candidate);
      }
    }
  }

  return [...found].slice(0, 6);
}

// ============================================
// PLAYLIST DIAGNOSTICS
// ============================================

function logDiagnostic(root, candidates) {
  const layers = payloadLayers(root);
  const payload = layers.at(-1) ?? {};

  const tracks = allTracks(root);

  const diagnostic = {
    metadataReceived: true,

    rootKeys:
      keysOf(root),

    payloadKeys:
      keysOf(payload),

    sourcesType:
      typeOf(payload.sources),

    hasFileField:
      typeof payload.file === 'string',

    rawTrackCount:
      tracks.length,

    subtitleTrackCount:
      trackList(root).length,

    firstTrackKeys:
      keysOf(tracks[0]),

    approvedPlaylistCandidates:
      candidates.length,

    approvedHostCount:
      allowedHosts().size,

    encType:
      typeOf(payload.enc),

    encLength:
      typeof payload.enc === 'string'
        ? payload.enc.length
        : null,

    encKeys:
      keysOf(payload.enc),

    serverType:
      typeOf(payload.server),

    serverKeys:
      keysOf(payload.server),

    tType:
      typeOf(payload.t),

    browserFallbackEnabled:
      enabled('HOSHI_PLAYZ_BROWSER'),

    folderDiscoveryEnabled:
      enabled('MEGAPLAY_FOLDER_DISCOVERY')
  };

  console.info(
    'HOSHI PLAYLIST DIAGNOSTIC:',
    JSON.stringify(diagnostic)
  );

  logTrackAnalysis(root);
}

// ============================================
// OPTIONAL BROWSER FALLBACK
// ============================================

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

  // The player only asks for its playlist once it
  // starts playing, so autoplay has to be allowed.
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 960, height: 540 },
      serviceWorkers: 'block'
    });

    try {
      const page = await context.newPage();
      const found = new Set();

      // Popups are never the player; close them at once.
      context.on('page', other => {
        if (other !== page) {
          other.close().catch(() => {});
        }
      });

      // Pictures, fonts and video bytes are not needed
      // to see which playlist the player asks for.
      await page.route('**/*', route => {
        const type = route.request().resourceType();

        return ['image', 'font', 'media'].includes(type)
          ? route.abort()
          : route.continue();
      });

      let sawPlaylist = () => {};

      const firstPlaylist = new Promise(resolve => {
        sawPlaylist = resolve;
      });

      page.on('request', request => {
        const url = request.url();

        if (
          /\.m3u8(?:\?|$)/i.test(url) &&
          approvedMedia(url)
        ) {
          found.add(url);
          sawPlaylist();
        }
      });

      const deadline = Date.now() + 18000;

      await page.goto(embedUrl, {
        referer: `${EMBED_ORIGIN}/`,
        waitUntil: 'commit',
        timeout: 12000
      });

      // Wait for the first playlist request rather than a
      // fixed pause, then a moment more: a second playlist
      // often follows right after the first.
      const timedOut = await Promise.race([
        firstPlaylist.then(() => false),
        new Promise(resolve => setTimeout(
          () => resolve(true),
          Math.max(0, deadline - Date.now())
        ))
      ]);

      if (!timedOut) {
        await page.waitForTimeout(900);
      }

      // Masters before media playlists. The player's own
      // copy can carry a token that expires within minutes;
      // the same address without it is tried first.
      const ordered = [];

      for (const url of [...found].sort((x, y) =>
        Number(/master|playlist|index/i.test(y)) -
        Number(/master|playlist|index/i.test(x))
      )) {
        if (/[?&]token=/.test(url)) {
          const bare = approvedMedia(url.split('?')[0]);

          if (bare && !ordered.includes(bare)) {
            ordered.push(bare);
          }
        }

        if (!ordered.includes(url)) {
          ordered.push(url);
        }
      }

      for (const url of ordered.slice(0, 6)) {
        const text = await getText(
          url,
          {
            Referer: `${EMBED_ORIGIN}/`
          },
          MAX_PLAYLIST
        ).catch(() => null);

        if (
          text?.trimStart().startsWith(
            '#EXTM3U'
          )
        ) {
          return url;
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

// ============================================
// MAIN HOSHI V4 RESOLVER
// ============================================

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

  const match =
    /^al([1-9]\d{0,9})$/.exec(
      String(series)
    );

  if (
    !match ||
    !/^\d{1,5}$/.test(
      String(episode)
    ) ||
    !['sub', 'dub'].includes(lang)
  ) {
    console.warn(
      'Hoshi V4: INVALID_EPISODE_ARGUMENTS'
    );

    return null;
  }

  // ------------------------------------------
  // CACHE CHECK
  // ------------------------------------------

  const key =
    `${series}:${episode}:${lang}`;

  const cached = cache.get(key);

  if (
    cached &&
    cached.until > Date.now()
  ) {
    return cached.value;
  }

  if (cached) {
    cache.delete(key);
  }

  // ------------------------------------------
  // EMBED METADATA
  // ------------------------------------------

  const embedUrl =
    `${EMBED_ORIGIN}/stream/ani/` +
    `${match[1]}/${episode}/${lang}`;

  try {
    const html = await getText(
      embedUrl,
      {
        Referer: `${EMBED_ORIGIN}/`
      },
      MAX_HTML
    );

    const id = playerId(html);

    if (!id) {
      throw new Error(
        'PLAYER_ID_MISSING'
      );
    }

    // ----------------------------------------
    // SOURCES API
    // ----------------------------------------

    const sourceUrl = new URL(
      '/stream/getSources',
      EMBED_ORIGIN
    );

    sourceUrl.searchParams.set(
      'id',
      id
    );

    let payload = null;
    let candidates = [];

    try {
      const responseText = await getText(
        sourceUrl.href,
        {
          Referer: embedUrl,

          'X-Requested-With':
            'XMLHttpRequest',

          Accept:
            'application/json'
        },
        MAX_JSON
      );

      payload = JSON.parse(
        responseText
      );

      if (
        !payload ||
        typeof payload !== 'object'
      ) {
        throw new Error(
          'INVALID_METADATA'
        );
      }

      // Extract supported source formats.
      candidates = clearCandidates(
        payload
      );

      // Log both playlist and track diagnostics.
      logDiagnostic(
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

    // ----------------------------------------
    // CDN MIRROR
    // ----------------------------------------
    // Each folder candidate is also tried on the
    // mirror host, when that host is on MEDIA_HOSTS.

    if (
      candidates.length &&
      enabled('MEGAPLAY_FOLDER_DISCOVERY')
    ) {
      const alt = await fallbackMirror();

      if (alt) {
        for (const candidate of [...candidates]) {
          const url = new URL(candidate);

          if (url.hostname === alt) continue;

          url.hostname = alt;

          const mirrored = approvedMedia(url.href);

          if (
            mirrored &&
            !candidates.includes(mirrored)
          ) {
            candidates.push(mirrored);
          }
        }
      }
    }

    // ----------------------------------------
    // SUBTITLES
    // ----------------------------------------

    const subtitles = trackList(
      payload
    );

    // Intro and credits times, if the metadata carries
    // them. server.mjs validates the numbers.
    const chapters = {};

    for (const layer of payloadLayers(payload)) {
      for (const name of ['intro', 'outro']) {
        if (
          !chapters[name] &&
          layer[name] &&
          typeof layer[name] === 'object'
        ) {
          chapters[name] = {
            start: layer[name].start,
            end: layer[name].end
          };
        }
      }
    }

    let result = null;

    // ----------------------------------------
    // VALIDATE HLS PLAYLISTS
    // ----------------------------------------

    for (const candidate of candidates) {
      try {
        const playlist = await getText(
          candidate,
          {
            Referer:
              `${EMBED_ORIGIN}/`,

            Origin:
              EMBED_ORIGIN
          },
          MAX_PLAYLIST
        );

        if (
          playlist.trimStart().startsWith(
            '#EXTM3U'
          )
        ) {
          result = {
            type: 'hls',
            url: candidate,

            referer:
              `${EMBED_ORIGIN}/`,

            subtitles,
            ...chapters
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

    // ----------------------------------------
    // OPTIONAL BROWSER FALLBACK
    // ----------------------------------------

    if (!result) {
      const url = await browserCandidate(
        embedUrl
      );

      if (url) {
        result = {
          type: 'hls',
          url,

          referer:
            `${EMBED_ORIGIN}/`,

          subtitles,
          ...chapters
        };
      }
    }

    // ----------------------------------------
    // MISSING PLAYLIST
    // ----------------------------------------

    if (!result) {
      console.warn(
        'Hoshi V4: No approved HLS playlist returned.'
      );

      throw new Error(
        'PLAYLIST_NOT_FOUND'
      );
    }

    // ----------------------------------------
    // CACHE SUCCESS
    // ----------------------------------------

    if (cache.size >= 100) {
      cache.delete(
        cache.keys().next().value
      );
    }

    cache.set(key, {
      value: result,

      until:
        Date.now() + CACHE_TTL
    });

    console.info(
      'Hoshi V4: STREAM_RESOLVED',
      {
        type: result.type,
        subtitles:
          result.subtitles.length
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
