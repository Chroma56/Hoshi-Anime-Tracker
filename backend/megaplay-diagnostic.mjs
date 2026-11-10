
/*
 * Hoshi MegaPlay Resolver Diagnostic V2
 *
 * Tests Naruto episode 1 SUB/DUB resolution.
 * Reports sanitised errors, not raw error messages.
 *
 * No video downloads, proxies, or credentials.
 */

import {
  HttpClient,
  MegaPlayProvider
} from 'anime-sdk';

const TITLE = 'Naruto';
const ANILIST_ID = 20;
const EPISODE = 1;

function classify(error) {
  const name = String(error?.name || 'Error');

  // Used for classification only.
  // Never print the raw message or stack.
  const message = String(error?.message || '');
  const text = message.toLowerCase();

  const statusValue =
    error?.statusCode ??
    error?.status ??
    error?.response?.status;

  const statusNumber = Number(statusValue);

  const status = Number.isInteger(statusNumber) &&
    statusNumber >= 100 &&
    statusNumber <= 599
      ? statusNumber
      : null;

  let category = 'UNKNOWN_RESOLVER_ERROR';

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|forbidden|access denied/.test(text)
  ) {
    category = 'ACCESS_RESTRICTED';

  } else if (
    status === 429 ||
    /rate.limit|too many requests/.test(text)
  ) {
    category = 'RATE_LIMITED';

  } else if (
    /captcha|turnstile|challenge/.test(text)
  ) {
    category = 'ACCESS_CHALLENGE';

  } else if (
    /timeout|timed out|aborterror|etimedout/.test(
      text + ' ' + name.toLowerCase()
    )
  ) {
    category = 'TIMEOUT';

  } else if (
    status === 404 ||
    /not found|no mapping|not mapped|not indexed|unavailable|no stream|no source|no embed/.test(
      text
    )
  ) {
    category = 'SOURCE_NOT_AVAILABLE';

  } else if (
    /invalid json|unexpected token|json|parse|decode/.test(
      text
    )
  ) {
    category = 'PARSING_ERROR';

  } else if (
    /fetch failed|network|enotfound|econnreset|dns|eai_again|socket/.test(
      text
    )
  ) {
    category = 'NETWORK_ERROR';

  } else if (
    status !== null && status >= 500
  ) {
    category = 'UPSTREAM_SERVER_ERROR';

  } else if (
    status !== null
  ) {
    category = 'HTTP_ERROR';

  }

  // Fixed fields only. Never expose arbitrary
  // upstream error strings or URLs.
  return {
    errorName: name.slice(0, 40),
    category,
    httpStatus: status
  };
}

function getFormat(value) {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  try {
    const path = new URL(value).pathname;

    if (/\.m3u8$/i.test(path)) return 'hls';
    if (/\.mp4$/i.test(path)) return 'mp4';

    return 'other';
  } catch {
    return 'invalid';
  }
}

async function main() {
  console.log('================================');
  console.log('HOSHI MEGAPLAY DIAGNOSTIC V2');
  console.log('================================');

  const http = new HttpClient({
    timeoutMs: 10000
  });

  const provider = new MegaPlayProvider(http, {   baseUrl: 'https://megaplay.buzz', });

  console.log('PROVIDER: INITIALISED');

  console.log('--- SEARCH ---');

  const results = await provider.search(TITLE);

  console.log(
    'SEARCH RESULTS:',
    Array.isArray(results) ? results.length : 0
  );

  if (!Array.isArray(results)) {
    console.log('RESULT: INVALID_SEARCH_RESPONSE');
    return;
  }

  const anime = results.find(item =>
    String(item.id) ===
    'megaplay:' + ANILIST_ID
  );

  if (!anime) {
    console.log('RESULT: ANIME_NOT_FOUND');
    return;
  }

  console.log('ANIME ID:', anime.id);

  console.log('--- EPISODES ---');

  const units = await provider.fetchContentUnits(
    anime.id
  );

  if (!Array.isArray(units)) {
    console.log('RESULT: INVALID_EPISODE_RESPONSE');
    return;
  }

  console.log('EPISODE COUNT:', units.length);

  const matches = units.filter(unit =>
    Number(unit?.number) === EPISODE
  );

  if (matches.length !== 1) {
    console.log('RESULT: EPISODE_NOT_UNIQUE');
    return;
  }

  const unit = matches[0];

  console.log('EPISODE ID:', unit.id);

  console.log('--- RESOLVE SUB / DUB ---');

  for (const language of ['sub', 'dub']) {
    console.log('LANGUAGE:', language);

    const started = Date.now();

    try {
      const result = await provider.resolveStream(
        unit.id,
        language
      );

      console.log(
        'DURATION_MS:',
        Date.now() - started
      );

      console.log(
        'RESULT TYPE:',
        result?.type || 'unknown'
      );

      if (
        result?.type !== 'video' ||
        !Array.isArray(result.streams)
      ) {
        console.log('STATUS: NO_VIDEO_PAYLOAD');
        continue;
      }

      console.log(
        'STREAM COUNT:',
        result.streams.length
      );

      for (
        const stream of result.streams.slice(0, 3)
      ) {
        const source =
          stream?.sourceUrl ||
          stream?.url;

        const headerNames = stream?.headers &&
          typeof stream.headers === 'object'
            ? Object.keys(stream.headers)
            : [];

        const tracks = Array.isArray(
          stream?.subtitles
        )
          ? stream.subtitles
          : Array.isArray(stream?.tracks)
            ? stream.tracks
            : [];

        console.log('STREAM METADATA:', JSON.stringify({
          format: getFormat(source),
          sourcePresent:
            typeof source === 'string' &&
            source.length > 0,
          requiresHeaders:
            headerNames.length > 0,
          subtitleCount: tracks.length
        }));
      }

      console.log(
        'STATUS:',
        result.streams.length > 0
          ? 'VIDEO_METADATA_RETURNED'
          : 'NO_STREAMS'
      );

    } catch (error) {
      console.log(
        'DURATION_MS:',
        Date.now() - started
      );

      console.log(
        'RESOLVER ERROR:',
        JSON.stringify(classify(error))
      );

      console.log('STATUS: RESOLVE_FAILED');
    }
  }

  console.log('RESULT: TEST_COMPLETE');
}

try {
  await main();

} catch (error) {
  console.log(
    'RESULT: DIAGNOSTIC_FAILED'
  );

  console.log(
    'DIAGNOSTIC ERROR:',
    JSON.stringify(classify(error))
  );
}

console.log('================================');
console.log('No video files downloaded.');
console.log('No stream URLs or credentials printed.');
console.log('================================');
