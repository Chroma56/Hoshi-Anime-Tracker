/**
 * HOSHI V4 - Resolver (polite edition)
 *
 * Same behaviour as the diagnostic patch, plus:
 * - requests to the embed host and CDN are spaced out and capped per domain
 * - HTTP 429 / 503 / timeouts are retried with backoff (Retry-After honoured)
 * - if the host refuses a refresh, a recent good answer is reused for up to 10 minutes
 * - the long diagnostic JSON lines are off by default (set HOSHI_DIAGNOSTICS=true to see them)
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
const STALE_TTL = 10 * 60 * 1000;
const cache = new Map();

// Tuning. Set as environment variables if the log still shows HTTP_429.
const CONCURRENCY = Math.max(1, Number(process.env.PLAYZ_CONCURRENCY || 3));
const MIN_GAP_MS = Math.max(0, Number(process.env.PLAYZ_MIN_GAP_MS || 150));
const MAX_ATTEMPTS = 3;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

// The embed's player asks this file which CDN mirror
// to use when the usual one fails. Kept for 10 minutes.
let mirror = null;

async function fallbackMirror() {
  if (mirror && Date.now() - mirror.at < 10 * 60 * 1000) return mirror.host;

  let host = null;

  try {
    const data = JSON.parse(
      await getText(
        `${EMBED_ORIGIN}/lib/check_domain.json?cache_burst=${Date.now()}`,
        { Referer: `${EMBED_ORIGIN}/` },
        MAX_JSON
      )
    );

    if (typeof data?.fallback === 'string' && /^[a-z0-9.-]+$/i.test(data.fallback)) {
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

    if (url.origin !== EMBED_ORIGIN || url.username || url.password || url.hash) {
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

  if (family === 4) return !blockedIPv4.check(address, 'ipv4');

  if (family === 6) {
    return globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  }

  return false;
}

// ============================================
// HTTPS FETCH (single attempt)
// ============================================

async function getTextOnce(value, headers = {}, limit = MAX_JSON) {
  const safeUrl = providerUrl(value) ?? approvedMedia(value);

  if (!safeUrl) throw new Error('HOST_NOT_APPROVED');

  const target = new URL(safeUrl);

  const addresses = await dns.lookup(target.hostname, { all: true });

  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
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
            callback(null, [{ address: selected.address, family: selected.family }]);
          } else {
            callback(null, selected.address, selected.family);
          }
        }
      },
      response => {
        if (response.statusCode !== 200) {
          const status = response.statusCode;
          const retryAfter = Number(response.headers['retry-after']);
          response.resume();

          const failure = new Error(`HTTP_${status}`);
          if (Number.isFinite(retryAfter)) failure.retryAfterMs = Math.max(0, retryAfter) * 1000;
          reject(failure);
          return;
        }

        const chunks = [];
        let size = 0;

        response.on('data', chunk => {
          size += chunk.length;

          if (size > limit) {
            request.destroy(new Error('RESPONSE_TOO_LARGE'));
            return;
          }

          chunks.push(chunk);
        });

        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      }
    );

    request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
    request.on('error', reject);
    request.end();
  });
}

// ---- polite layer ------------------------------------------------------------------------
// Every request goes through getText(): per-domain spacing and concurrency cap, and a retry
// with backoff when the host answers 429/503 or times out.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Rate limits apply per IP or domain, not per random subdomain.
function gateKey(host) {
  const parts = host.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

const gates = new Map();

function gateFor(key) {
  let gate = gates.get(key);

  if (!gate) {
    gate = { active: 0, waiters: [], nextSlot: 0, cooldownUntil: 0 };
    gates.set(key, gate);
  }

  return gate;
}

setInterval(() => {
  const now = Date.now();

  for (const [key, gate] of gates) {
    if (!gate.active && !gate.waiters.length && gate.nextSlot < now && gate.cooldownUntil < now) {
      gates.delete(key);
    }
  }
}, 60000).unref();

async function withGate(key, fn) {
  const gate = gateFor(key);

  while (gate.active >= CONCURRENCY) {
    await new Promise(resolve => gate.waiters.push(resolve));
  }

  gate.active++;

  try {
    const now = Date.now();
    const slot = Math.max(now, gate.nextSlot, gate.cooldownUntil);
    gate.nextSlot = slot + MIN_GAP_MS;

    if (slot > now) await sleep(slot - now);

    // a 429 seen while queued pauses everyone who reserved a slot earlier
    for (let wait = gate.cooldownUntil - Date.now(); wait > 0; wait = gate.cooldownUntil - Date.now()) {
      await sleep(wait);
    }

    return await fn();
  } finally {
    gate.active--;
    gate.waiters.shift()?.();
  }
}

async function getText(value, headers = {}, limit = MAX_JSON) {
  let key = 'unknown';

  try {
    key = gateKey(new URL(value).hostname);
  } catch {
    // getTextOnce rejects invalid addresses itself
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await withGate(key, () => getTextOnce(value, headers, limit));
    } catch (error) {
      const message = String(error?.message ?? '');
      const retryable = message === 'HTTP_429' || message === 'HTTP_503' || message === 'TIMEOUT';

      if (!retryable || attempt >= MAX_ATTEMPTS - 1) throw error;

      const wait =
        Math.min(Math.max(error.retryAfterMs ?? 0, 500 * 2 ** attempt), 6000) +
        Math.random() * 250;

      console.warn(
        `Hoshi V4: ${message} from ${key}, retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${Math.round(wait)}ms`
      );

      const gate = gateFor(key);
      gate.cooldownUntil = Math.max(gate.cooldownUntil, Date.now() + wait);

      await sleep(wait);
    }
  }
}
// ---- end polite layer --------------------------------------------------------------------

// ============================================
// PLAYER ID
// ============================================

function playerId(html) {
  const playerTag = /<[^>]*\bid=["']megaplay-player["'][^>]*>/i.exec(html)?.[0];

  const id =
    playerTag?.match(/\bdata-id=["'](\d+)["']/i)?.[1] ??
    /<[^>]*\bdata-id=["'](\d+)["'][^>]*>/i.exec(html)?.[1] ??
    /<title>\s*File\s+(\d+)/i.exec(html)?.[1];

  return id && /^\d{1,15}$/.test(id) ? id : null;
}

// ============================================
// PAYLOAD NORMALIZATION
// ============================================

function payloadLayers(root) {
  const layers = [];
  let current = root;

  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') break;

    layers.push(current);

    const next = current.data ?? current.result ?? current.payload;

    if (!next || typeof next !== 'object' || next === current) break;

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
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).slice(0, 20);
}

// ============================================
// TRACK INSPECTION
// ============================================

function allTracks(root) {
  return payloadLayers(root).flatMap(layer => [
    ...(Array.isArray(layer.tracks) ? layer.tracks : []),
    ...(Array.isArray(layer.subtitles) ? layer.subtitles : [])
  ]);
}

function inspectTrack(track) {
  const file = track?.file ?? track?.url ?? track?.src;

  if (typeof file !== 'string' || !file.trim()) {
    return { reason: 'missingFile', extension: 'none', url: null };
  }

  let parsed;

  try {
    parsed = new URL(file);
  } catch {
    return { reason: 'relativeOrInvalid', extension: 'unknown', url: null };
  }

  const extension = parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'none';

  if (parsed.protocol !== 'https:') {
    return { reason: 'notHttps', extension, url: null };
  }

  const approved = approvedMedia(file);

  if (!approved) {
    return { reason: 'unapprovedHost', extension, url: null };
  }

  if (extension !== 'vtt' && extension !== 'srt') {
    return { reason: 'unsupportedExtension', extension, url: null };
  }

  return { reason: 'accepted', extension, url: approved };
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
    if (inspection.reason in reasons) reasons[inspection.reason]++;
  }

  const firstInspection = inspectTrack(first);
  const firstFile = first?.file ?? first?.url ?? first?.src;

  const kinds = [
    ...new Set(
      tracks.map(track => {
        const kind = String(track?.kind ?? 'unknown');
        return /^[\w -]{1,24}$/.test(kind) ? kind : 'unknown';
      })
    )
  ].slice(0, 10);

  const diagnostic = {
    totalTracks: tracks.length,
    kinds,
    firstTrack: {
      kind:
        typeof first?.kind === 'string' && /^[\w -]{1,24}$/.test(first.kind)
          ? first.kind
          : 'unknown',
      hasFile: typeof firstFile === 'string',
      fileIsAbsoluteHttps: typeof firstFile === 'string' && firstFile.startsWith('https://'),
      fileExtension: firstInspection.extension,
      validationResult: firstInspection.reason
    },
    validationSummary: reasons,

    // Host names only (no paths or tokens): these are
    // what MEDIA_HOSTS is missing when tracks are refused.
    unapprovedHosts: [
      ...new Set(
        tracks.flatMap(track => {
          if (inspectTrack(track).reason !== 'unapprovedHost') return [];

          try {
            return [new URL(track.file ?? track.url ?? track.src).hostname.toLowerCase()];
          } catch {
            return [];
          }
        })
      )
    ].slice(0, 10),

    approvedHostCount: allowedHosts().size
  };

  // Never log the raw track URLs or tokens.
  console.info('HOSHI TRACK ANALYSIS:', JSON.stringify(diagnostic));
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
      !['captions', 'subtitles'].includes(track.kind.toLowerCase())
    ) {
      continue;
    }

    const inspection = inspectTrack(track);

    if (inspection.reason !== 'accepted' || !inspection.url) continue;
    if (seen.has(inspection.url)) continue;

    seen.add(inspection.url);

    subtitles.push({
      url: inspection.url,
      lang: String(track.lang ?? track.language ?? 'en').slice(0, 16),
      label: String(track.label ?? 'Subtitles').slice(0, 80)
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
    if (value === undefined || value === null || depth > 5) return;

    if (Array.isArray(value)) {
      for (const entry of value) add(entry, depth + 1);
      return;
    }

    if (typeof value === 'object') {
      for (const key of [
        'file', 'url', 'src', 'master', 'playlist',
        'source', 'sources', 'streams', 'hls', 'playback'
      ]) {
        add(value[key], depth + 1);
      }

      return;
    }

    if (typeof value !== 'string') return;

    const input = value.trim();

    if (input.startsWith('[') || input.startsWith('{')) {
      try {
        add(JSON.parse(input), depth + 1);
      } catch {
        // Ignore invalid serialized source data.
      }

      return;
    }

    const url = approvedMedia(input);

    if (url && /\.m3u8$/i.test(new URL(url).pathname)) found.add(url);
  }

  for (const layer of payloadLayers(root)) {
    for (const key of [
      'sources', 'source', 'streams', 'file',
      'url', 'master', 'playback', 'hls'
    ]) {
      add(layer[key]);
    }
  }

  // Only enable when explicitly authorized.
  if (enabled('MEGAPLAY_FOLDER_DISCOVERY')) {
    for (const track of trackList(root, true)) {
      const url = new URL(track.url);

      const match = /^(.+?)\/(?:subtitles|sprites?|thumbnails?)\/.+$/i.exec(url.pathname);

      if (!match) continue;

      url.pathname = `${match[1]}/master.m3u8`;
      url.search = '';

      const candidate = approvedMedia(url.href);

      if (candidate) found.add(candidate);
    }
  }

  return [...found].slice(0, 6);
}

// ============================================
// PLAYLIST DIAGNOSTICS
// ============================================

function logDiagnostic(root, candidates) {
  // These two lines are long and print on every lookup. Off unless asked for.
  if (!enabled('HOSHI_DIAGNOSTICS')) return;

  const layers = payloadLayers(root);
  const payload = layers.at(-1) ?? {};
  const tracks = allTracks(root);

  const diagnostic = {
    metadataReceived: true,
    rootKeys: keysOf(root),
    payloadKeys: keysOf(payload),
    sourcesType: typeOf(payload.sources),
    hasFileField: typeof payload.file === 'string',
    rawTrackCount: tracks.length,
    subtitleTrackCount: trackList(root).length,
    firstTrackKeys: keysOf(tracks[0]),
    approvedPlaylistCandidates: candidates.length,
    approvedHostCount: allowedHosts().size,
    encType: typeOf(payload.enc),
    encLength: typeof payload.enc === 'string' ? payload.enc.length : null,
    encKeys: keysOf(payload.enc),
    serverType: typeOf(payload.server),
    serverKeys: keysOf(payload.server),
    tType: typeOf(payload.t),
    browserFallbackEnabled: enabled('HOSHI_PLAYZ_BROWSER'),
    folderDiscoveryEnabled: enabled('MEGAPLAY_FOLDER_DISCOVERY')
  };

  console.info('HOSHI PLAYLIST DIAGNOSTIC:', JSON.stringify(diagnostic));

  logTrackAnalysis(root);
}

// ============================================
// OPTIONAL BROWSER FALLBACK
// ============================================

async function browserCandidate(embedUrl) {
  if (!enabled('HOSHI_PLAYZ_BROWSER')) return null;

  let chromium;

  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('Hoshi V4: PLAYWRIGHT_NOT_INSTALLED');
    return null;
  }

  // The player only asks for its playlist once it
  // starts playing, so autoplay has to be allowed.
  const browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']
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
        if (other !== page) other.close().catch(() => {});
      });

      // Pictures, fonts and video bytes are not needed
      // to see which playlist the player asks for.
      await page.route('**/*', route => {
        const type = route.request().resourceType();
        return ['image', 'font', 'media'].includes(type) ? route.abort() : route.continue();
      });

      let sawPlaylist = () => {};

      const firstPlaylist = new Promise(resolve => {
        sawPlaylist = resolve;
      });

      page.on('request', request => {
        const url = request.url();

        if (/\.m3u8(?:\?|$)/i.test(url) && approvedMedia(url)) {
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
        new Promise(resolve => setTimeout(() => resolve(true), Math.max(0, deadline - Date.now())))
      ]);

      if (!timedOut) await page.waitForTimeout(900);

      // Masters before media playlists. The player's own
      // copy can carry a token that expires within minutes;
      // the same address without it is tried first.
      const ordered = [];

      for (const url of [...found].sort(
        (x, y) =>
          Number(/master|playlist|index/i.test(y)) - Number(/master|playlist|index/i.test(x))
      )) {
        if (/[?&]token=/.test(url)) {
          const bare = approvedMedia(url.split('?')[0]);
          if (bare && !ordered.includes(bare)) ordered.push(bare);
        }

        if (!ordered.includes(url)) ordered.push(url);
      }

      for (const url of ordered.slice(0, 6)) {
        const text = await getText(url, { Referer: `${EMBED_ORIGIN}/` }, MAX_PLAYLIST).catch(() => null);

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

// ============================================
// MAIN HOSHI V4 RESOLVER
// ============================================

export async function resolvePlayzStyle(series, episode, lang) {
  if (!enabled('HOSHI_PLAYZ_ENABLED') || !enabled('MEGAPLAY_SOURCE_PERMISSION')) {
    return null;
  }

  // The embed host has three addresses for an episode,
  // and a show can exist under one but not another:
  //   al<id>   /stream/ani/<AniList id>/<episode>/<lang>
  //   mal<id>  /stream/mal/<MAL id>/<episode>/<lang>
  //   s2-<id>  /stream/s-2/<episode embed id>/<lang>
  const seriesText = String(series);

  const byAni = /^al([1-9]\d{0,9})$/.exec(seriesText);
  const byMal = /^mal([1-9]\d{0,9})$/.exec(seriesText);
  const byEmbed = /^s2-([1-9]\d{0,17})$/.exec(seriesText);

  const match = byAni || byMal || byEmbed;

  if (!match || !/^\d{1,5}$/.test(String(episode)) || !['sub', 'dub'].includes(lang)) {
    console.warn('Hoshi V4: INVALID_EPISODE_ARGUMENTS');
    return null;
  }

  // ------------------------------------------
  // CACHE CHECK
  // ------------------------------------------

  const key = `${series}:${episode}:${lang}`;

  const cached = cache.get(key);

  if (cached && cached.until > Date.now()) return cached.value;

  // An expired entry is kept for a while as a fallback if the host refuses the refresh.
  const stale = cached && cached.until + STALE_TTL > Date.now() ? cached : null;

  if (cached && !stale) cache.delete(key);

  // ------------------------------------------
  // EMBED METADATA
  // ------------------------------------------

  const embedPath = byEmbed
    ? `s-2/${byEmbed[1]}/${lang}`
    : `${byAni ? 'ani' : 'mal'}/${match[1]}/${episode}/${lang}`;

  const embedUrl = `${EMBED_ORIGIN}/stream/${embedPath}`;

  try {
    const html = await getText(embedUrl, { Referer: `${EMBED_ORIGIN}/` }, MAX_HTML);

    const id = playerId(html);

    if (!id) throw new Error('PLAYER_ID_MISSING');

    // ----------------------------------------
    // SOURCES API
    // ----------------------------------------

    const sourceUrl = new URL('/stream/getSources', EMBED_ORIGIN);
    sourceUrl.searchParams.set('id', id);

    let payload = null;
    let candidates = [];

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

      payload = JSON.parse(responseText);

      if (!payload || typeof payload !== 'object') throw new Error('INVALID_METADATA');

      // Extract supported source formats.
      candidates = clearCandidates(payload);

      // Log both playlist and track diagnostics (when enabled).
      logDiagnostic(payload, candidates);
    } catch (error) {
      console.warn(
        'Hoshi V4: SOURCES_METADATA_UNAVAILABLE:',
        String(error?.message ?? error).slice(0, 120)
      );
    }

    // ----------------------------------------
    // CDN MIRROR
    // ----------------------------------------
    // Each folder candidate is also tried on the
    // mirror host, when that host is on MEDIA_HOSTS.

    if (candidates.length && enabled('MEGAPLAY_FOLDER_DISCOVERY')) {
      const alt = await fallbackMirror();

      if (alt) {
        for (const candidate of [...candidates]) {
          const url = new URL(candidate);

          if (url.hostname === alt) continue;

          url.hostname = alt;

          const mirrored = approvedMedia(url.href);

          if (mirrored && !candidates.includes(mirrored)) candidates.push(mirrored);
        }
      }
    }

    // ----------------------------------------
    // SUBTITLES
    // ----------------------------------------

    const subtitles = trackList(payload);

    // Intro and credits times, if the metadata carries
    // them. server.mjs validates the numbers.
    const chapters = {};

    for (const layer of payloadLayers(payload)) {
      for (const name of ['intro', 'outro']) {
        if (!chapters[name] && layer[name] && typeof layer[name] === 'object') {
          chapters[name] = { start: layer[name].start, end: layer[name].end };
        }
      }
    }

    let result = null;

    // ----------------------------------------
    // VALIDATE HLS PLAYLISTS
    // ----------------------------------------

    let playlistRefused = false;

    for (const candidate of candidates) {
      try {
        const playlist = await getText(
          candidate,
          { Referer: `${EMBED_ORIGIN}/`, Origin: EMBED_ORIGIN },
          MAX_PLAYLIST
        );

        if (playlist.trimStart().startsWith('#EXTM3U')) {
          result = {
            type: 'hls',
            url: candidate,
            referer: `${EMBED_ORIGIN}/`,
            subtitles,
            ...chapters
          };

          break;
        }

        console.warn('Hoshi V4: CANDIDATE_NOT_HLS');
      } catch (error) {
        const message = String(error?.message ?? error);

        if (/^(HTTP_429|HTTP_503|TIMEOUT)$/.test(message)) playlistRefused = true;

        console.warn('Hoshi V4: PLAYLIST_FETCH_FAILED:', message.slice(0, 120));
      }
    }

    // ----------------------------------------
    // OPTIONAL BROWSER FALLBACK
    // ----------------------------------------

    if (!result) {
      const url = await browserCandidate(embedUrl);

      if (url) {
        result = {
          type: 'hls',
          url,
          referer: `${EMBED_ORIGIN}/`,
          subtitles,
          ...chapters
        };
      }
    }

    // ----------------------------------------
    // MISSING PLAYLIST
    // ----------------------------------------

    if (!result) {
      console.warn('Hoshi V4: No approved HLS playlist returned.');

      throw new Error(playlistRefused ? 'HTTP_429' : 'PLAYLIST_NOT_FOUND');
    }

    // ----------------------------------------
    // CACHE SUCCESS
    // ----------------------------------------

    if (cache.size >= 100) cache.delete(cache.keys().next().value);

    cache.set(key, { value: result, until: Date.now() + CACHE_TTL });

    console.info('Hoshi V4: STREAM_RESOLVED', {
      type: result.type,
      subtitles: result.subtitles.length
    });

    return result;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 120);

    console.warn('Hoshi Playz-style resolver:', message);

    // The host is refusing or timing out: a recent good answer is better than
    // making the direct player disappear.
    if (stale && /^(HTTP_429|HTTP_503|TIMEOUT)$/.test(message)) {
      console.warn('Hoshi V4: serving last good answer for ' + key);
      return stale.value;
    }

    return null;
  }
}
