/*
 * Hoshi MegaPlay Resolver Diagnostic V3
 * Identifies failures without logging source URLs, secrets or stacks.
 * This calls the provider resolver but does not fetch video segments.
 */
import { HttpClient, MegaPlayProvider } from 'anime-sdk';

const TITLE = 'Naruto';
const ANILIST_ID = 20;
const EPISODE = 1;

function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function classify(error) {
  const name = String(error?.name || 'Error').slice(0, 40);
  const message = String(error?.message || '');
  const lower = (name + ' ' + message).toLowerCase();
  const rawStatus = error?.statusCode ?? error?.status ?? error?.response?.status;
  const number = Number(rawStatus);
  const status = rawStatus != null && Number.isInteger(number) && number >= 100 && number <= 599
    ? number : null;
  let category = 'UNKNOWN_RESOLVER_ERROR';
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|access denied/.test(lower)) {
    category = 'ACCESS_RESTRICTED';
  } else if (status === 429 || /rate.limit|too many requests/.test(lower)) {
    category = 'RATE_LIMITED';
  } else if (/captcha|turnstile|challenge/.test(lower)) {
    category = 'ACCESS_CHALLENGE';
  } else if (/timeout|timed out|aborterror|etimedout/.test(lower)) {
    category = 'TIMEOUT';
  } else if (status === 404 || /not found|no mapping|not mapped|not indexed|unavailable|no stream|no source|no embed/.test(lower)) {
    category = 'SOURCE_NOT_AVAILABLE';
  } else if (/invalid json|unexpected token|json|parse|decode/.test(lower)) {
    category = 'PARSING_ERROR';
  } else if (/fetch failed|network|enotfound|econnreset|dns|eai_again|socket/.test(lower)) {
    category = 'NETWORK_ERROR';
  } else if (status !== null && status >= 500) {
    category = 'UPSTREAM_SERVER_ERROR';
  } else if (status !== null) {
    category = 'HTTP_ERROR';
  }
  return { errorName: name, category, httpStatus: status };
}

function safeErrorMessage(error) {
  // The message is untrusted and can contain secrets. Best-effort redaction;
  // inspect logs before sharing them with anyone.
  return String(error?.message || '(empty error message)')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[AUTH_REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[VALUE_REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function sourceFormat(source) {
  if (typeof source !== 'string') return 'unknown';
  try {
    const url = new URL(source);
    if (/\.m3u8$/i.test(url.pathname)) return 'hls';
    if (/\.mp4$/i.test(url.pathname)) return 'mp4';
    return 'other';
  } catch {
    return 'invalid';
  }
}

async function main() {
  console.log('================================');
  console.log('HOSHI MEGAPLAY DIAGNOSTIC V3');
  console.log('================================');

  const http = new HttpClient({ timeoutMs: 10000 });
  const provider = new MegaPlayProvider(http, {
    baseUrl: 'https://megaplay.buzz'
  });
  console.log('PROVIDER: INITIALISED');
  console.log('--- SEARCH ---');

  const results = await provider.search(TITLE);
  console.log('SEARCH RESULTS:', Array.isArray(results) ? results.length : 0);
  if (!Array.isArray(results)) {
    console.log('RESULT: INVALID_SEARCH_RESPONSE');
    return;
  }
  const anime = results.find(item => String(item?.id) === 'megaplay:' + ANILIST_ID);
  if (!anime) {
    console.log('RESULT: ANIME_NOT_FOUND');
    return;
  }
  console.log('ANIME ID:', String(anime.id));
  console.log('--- EPISODES ---');

  const units = await provider.fetchContentUnits(anime.id);
  if (!Array.isArray(units)) {
    console.log('RESULT: INVALID_EPISODE_RESPONSE');
    return;
  }
  console.log('EPISODE COUNT:', units.length);
  const matches = units.filter(unit => Number(unit?.number) === EPISODE);
  if (matches.length !== 1) {
    console.log('RESULT: EPISODE_NOT_UNIQUE');
    return;
  }
  const unit = matches[0];
  console.log('EPISODE ID:', String(unit.id));
  console.log('--- RESOLVE SUB / DUB ---');

  for (const language of ['sub', 'dub']) {
    console.log('LANGUAGE:', language);
    const started = Date.now();
    try {
      const result = await provider.resolveStream(unit.id, language);
      console.log('DURATION_MS:', Date.now() - started);
      console.log('RESULT TYPE:', String(result?.type || 'unknown'));
      if (result?.type !== 'video' || !Array.isArray(result.streams)) {
        console.log('STATUS: NO_VIDEO_PAYLOAD');
        continue;
      }
      console.log('STREAM COUNT:', result.streams.length);
      for (const stream of result.streams.slice(0, 3)) {
        const source = stream?.sourceUrl || stream?.url;
        const headers = stream?.headers && typeof stream.headers === 'object'
          ? Object.keys(stream.headers) : [];
        const subtitles = Array.isArray(stream?.subtitles) ? stream.subtitles
          : Array.isArray(stream?.tracks) ? stream.tracks : [];
        console.log('STREAM METADATA:', JSON.stringify({
          format: sourceFormat(source),
          sourcePresent: typeof source === 'string' && source.length > 0,
          requiresHeaders: headers.length > 0,
          subtitleCount: subtitles.length
        }));
      }
      console.log('STATUS:', result.streams.length ? 'VIDEO_METADATA_RETURNED' : 'NO_STREAMS');
    } catch (error) {
      console.log('DURATION_MS:', Date.now() - started);
      console.log('SAFE_ERROR_MESSAGE:', safeErrorMessage(error));
      console.log('RESOLVER ERROR:', JSON.stringify(classify(error)));
      console.log('STATUS: RESOLVE_FAILED');
    }
  }
  console.log('RESULT: TEST_COMPLETE');
}

try {
  await main();
} catch (error) {
  console.log('RESULT: DIAGNOSTIC_FAILED');
  console.log('SAFE_ERROR_MESSAGE:', safeErrorMessage(error));
  console.log('DIAGNOSTIC ERROR:', JSON.stringify(classify(error)));
}
console.log('================================');
console.log('No video segments downloaded by this script.');
console.log('No stream URLs or credentials intentionally printed.');
console.log('================================');
