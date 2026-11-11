
/**
 * Hoshi V4 — Playz-style resolver (ES module)
 *
 * Only use this with provider permission and CDN hosts you are
 * authorized to access. Does not decrypt or guess stream URLs.
 *
 * Required env:
 *   HOSHI_PLAYZ_ENABLED=true
 *   MEGAPLAY_SOURCE_PERMISSION=true
 *   MEDIA_HOSTS=licensed-cdn.example.com
 *
 * Optional (disabled by default):
 *   HOSHI_PLAYZ_BROWSER=false
 *   MEGAPLAY_FOLDER_DISCOVERY=false
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

const blockedV4 = new net.BlockList();
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
  ['240.0.0.0', 4],
]) {
  blockedV4.addSubnet(address, prefix, 'ipv4');
}

const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

const blockedV6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
]) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

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
    return url.href;
  } catch {
    return null;
  }
}

function publicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blockedV4.check(ip, 'ipv4');
  if (family === 6) {
    return globalV6.check(ip, 'ipv6') && !blockedV6.check(ip, 'ipv6');
  }
  return false;
}

async function getText(value, headers = {}, maxBytes = MAX_JSON) {
  const safeUrl = providerUrl(value) ?? approvedMedia(value);
  if (!safeUrl) throw new Error('HOST_NOT_APPROVED');

  const url = new URL(safeUrl);
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error('NON_PUBLIC_DESTINATION');
  }

  // Pin the resolved IP so the connection doesn't perform a second DNS lookup.
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        timeout: 12000,
        headers: { Accept: '*/*', ...headers },
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      },
      response => {
        if (response.statusCode !== 200) {
          const status = response.statusCode;
          response.resume();
          reject(new Error(`HTTP_${status}`));
          return;
        }

        const parts = [];
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > maxBytes) {
            request.destroy(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          parts.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        response.on('error', reject);
      }
    );
    request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
    request.on('error', reject);
    request.end();
  });
}

function playerId(html) {
  const playerTag =
    /<[^>]*\bid=["']megaplay-player["'][^>]*>/i.exec(html)?.[0];

  const id =
    playerTag?.match(/\bdata-id=["'](\d+)["']/i)?.[1] ??
    /<[^>]*\bdata-id=["'](\d+)["'][^>]*>/i.exec(html)?.[1] ??
    /<title>\s*File\s+(\d+)/i.exec(html)?.[1];

  return id && /^\d{1,15}$/.test(id) ? id : null;
}

// Follow ordinary API response wrappers without assuming "enc" is a source.
function payloadLayers(root) {
  const layers = [];
  let current = root;
  for (let i = 0; i < 4; i++) {
    if (!current || typeof current !== 'object') break;
    layers.push(current);
    const next = current.data ?? current.result ?? current.payload;
    if (!next || typeof next !== 'object' || next === current) break;
    current = next;
  }
  return layers;
}

function trackList(root) {
  const tracks = payloadLayers(root).flatMap(layer => [
    ...(Array.isArray(layer.tracks) ? layer.tracks : []),
    ...(Array.isArray(layer.subtitles) ? layer.subtitles : []),
  ]);
  const seen = new Set();
  const result = [];

  for (const track of tracks.slice(0, 30)) {
    const url = approvedMedia(track?.file ?? track?.url ?? track?.src);
    if (!url || !/\.(vtt|srt)$/i.test(new URL(url).pathname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push({
      url,
      lang: String(track?.lang ?? track?.language ?? 'en').slice(0, 16),
      label: String(track?.label ?? 'Subtitles').slice(0, 80),
    });
  }
  return result;
}

function clearCandidates(root) {
  const found = new Set();

  function add(value, depth = 0) {
    if (value == null || depth > 5) return;

    if (Array.isArray(value)) {
      value.forEach(item => add(item, depth + 1));
      return;
    }

    if (typeof value === 'object') {
      for (const key of [
        'file', 'url', 'src', 'master', 'playlist',
        'source', 'sources', 'streams', 'hls', 'playback',
      ]) {
        add(value[key], depth + 1);
      }
      return;
    }

    if (typeof value !== 'string') return;
    const input = value.trim();

    // Some APIs return a JSON-encoded source array.
    if (input.startsWith('[') || input.startsWith('{')) {
      try {
        add(JSON.parse(input), depth + 1);
      } catch {
        // Ignore invalid JSON; do not attempt decoding unknown "enc" values.
      }
      return;
    }

    const url = approvedMedia(input);
    if (url && /\.m3u8$/i.test(new URL(url).pathname)) found.add(url);
  }

  for (const layer of payloadLayers(root)) {
    for (const key of [
      'sources', 'source', 'streams', 'file',
      'url', 'master', 'playback', 'hls',
    ]) {
      add(layer[key]);
    }
  }

  // Use only when the provider explicitly authorizes this directory layout.
  if (enabled('MEGAPLAY_FOLDER_DISCOVERY')) {
    for (const track of trackList(root)) {
      const url = new URL(track.url);
      const match = /^(.+?)\/(?:subtitles|sprites|thumbnails)\/.+$/i.exec(url.pathname);
      if (!match) continue;
      url.pathname = `${match[1]}/master.m3u8`;
      url.search = '';
      const candidate = approvedMedia(url.href);
      if (candidate) found.add(candidate);
    }
  }

  return [...found].slice(0, 6);
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function keysOf(value) {
  return value && typeof value === 'object'
    ? Object.keys(value).slice(0, 20)
    : [];
}

function logDiagnostic(root, candidates) {
  const layers = payloadLayers(root);
  const payload = layers.at(-1) ?? {};
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const firstTrack = tracks[0];

  // Structural information only: no raw URLs, secrets, or "enc" contents.
  console.info('HOSHI PLAYLIST DIAGNOSTIC:', JSON.stringify({
    metadataReceived: true,
    rootKeys: keysOf(root),
    payloadKeys: keysOf(payload),
    sourcesType: typeOf(payload.sources),
    hasFileField: typeof payload.file === 'string',
    rawTrackCount: tracks.length,
    subtitleTrackCount: trackList(root).length,
    firstTrackKeys: keysOf(firstTrack),
    approvedPlaylistCandidates: candidates.length,
    approvedHostCount: allowedHosts().size,
    encType: typeOf(payload.enc),
    encLength: typeof payload.enc === 'string' ? payload.enc.length : null,
    encKeys: keysOf(payload.enc),
    serverType: typeOf(payload.server),
    serverKeys: keysOf(payload.server),
    tType: typeOf(payload.t),
    browserFallbackEnabled: enabled('HOSHI_PLAYZ_BROWSER'),
    folderDiscoveryEnabled: enabled('MEGAPLAY_FOLDER_DISCOVERY'),
  }));
}

async function browserCandidate(embedUrl) {
  if (!enabled('HOSHI_PLAYZ_BROWSER')) return null;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('Hoshi V4: PLAYWRIGHT_NOT_INSTALLED');
    return null;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const found = new Set();
      page.on('request', request => {
        const url = request.url();
        if (/\.m3u8(?:\?|$)/i.test(url) && approvedMedia(url)) {
          found.add(url);
        }
      });

      await page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      });
      if (!found.size) await page.waitForTimeout(5000);

      for (const url of found) {
        const text = await getText(
          url,
          { Referer: `${EMBED_ORIGIN}/` },
          MAX_PLAYLIST
        ).catch(() => null);

        if (text?.trimStart().startsWith('#EXTM3U')) return url;
      }
      return null;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function resolvePlayzStyle(series, episode, lang) {
  if (
    !enabled('HOSHI_PLAYZ_ENABLED') ||
    !enabled('MEGAPLAY_SOURCE_PERMISSION')
  ) {
    return null;
  }

  const match = /^al([1-9]\d{0,9})$/.exec(String(series));
  if (
    !match ||
    !/^\d{1,5}$/.test(String(episode)) ||
    !['sub', 'dub'].includes(lang)
  ) {
    console.warn('Hoshi V4: INVALID_EPISODE_ARGUMENTS');
    return null;
  }

  const key = `${series}:${episode}:${lang}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  if (cached) cache.delete(key);

  const embedUrl =
    `${EMBED_ORIGIN}/stream/ani/${match[1]}/${episode}/${lang}`;

  try {
    const html = await getText(
      embedUrl,
      { Referer: `${EMBED_ORIGIN}/` },
      MAX_HTML
    );
    const id = playerId(html);
    if (!id) throw new Error('PLAYER_ID_MISSING');

    const sourceUrl = new URL('/stream/getSources', EMBED_ORIGIN);
    sourceUrl.searchParams.set('id', id);

    let payload = null;
    let candidates = [];

    try {
      const response = await getText(
        sourceUrl.href,
        {
          Referer: embedUrl,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
        MAX_JSON
      );

      payload = JSON.parse(response);
      if (!payload || typeof payload !== 'object') {
        throw new Error('INVALID_METADATA');
      }

      candidates = clearCandidates(payload);
      logDiagnostic(payload, candidates);
    } catch (error) {
      console.warn(
        'Hoshi V4: SOURCES_METADATA_UNAVAILABLE:',
        String(error?.message ?? error).slice(0, 120)
      );
    }

    let result = null;
    const subtitles = trackList(payload);

    for (const candidate of candidates) {
      try {
        const text = await getText(
          candidate,
          { Referer: `${EMBED_ORIGIN}/`, Origin: EMBED_ORIGIN },
          MAX_PLAYLIST
        );

        if (text.trimStart().startsWith('#EXTM3U')) {
          result = {
            type: 'hls',
            url: candidate,
            referer: `${EMBED_ORIGIN}/`,
            subtitles,
          };
          break;
        }

        console.warn('Hoshi V4: CANDIDATE_NOT_HLS');
      } catch (error) {
        console.warn(
          'Hoshi V4: PLAYLIST_FETCH_FAILED:',
          String(error?.message ?? error).slice(0, 120)
        );
      }
    }

    if (!result) {
      const url = await browserCandidate(embedUrl);
      if (url) {
        result = {
          type: 'hls',
          url,
          referer: `${EMBED_ORIGIN}/`,
          subtitles,
        };
      }
    }

    if (!result) throw new Error('PLAYLIST_NOT_FOUND');

    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { value: result, until: Date.now() + CACHE_TTL });

    console.info('Hoshi V4: STREAM_RESOLVED', {
      type: result.type,
      subtitles: result.subtitles.length,
    });

    return result;
  } catch (error) {
    console.warn(
      'Hoshi Playz-style resolver:',
      String(error?.message ?? error).slice(0, 120)
    );
    return null;
  }
}
