
/*
 * Hoshi MegaPlay Diagnostic V1
 *
 * Tests SDK search, episode lookup and
 * video-source metadata resolution.
 *
 * Does not download or proxy video.
 * Does not print media URLs or tokens.
 */

import {
  HttpClient,
  MegaPlayProvider
} from 'anime-sdk';

const TITLE = 'Naruto';
const EPISODE = 1;

console.log('================================');
console.log('HOSHI MEGAPLAY DIAGNOSTIC V1');
console.log('================================');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatches(item, wanted) {
  const values = [
    item?.title,
    item?.name,
    item?.englishTitle,
    item?.romajiTitle
  ];

  if (
    item?.title &&
    typeof item.title === 'object'
  ) {
    values.push(...Object.values(item.title));
  }

  return values.some(value =>
    typeof value === 'string' &&
    normalize(value) === normalize(wanted)
  );
}

function describeStream(stream) {
  const source =
    stream?.sourceUrl ||
    stream?.url ||
    '';

  let format = 'unknown';

  try {
    const path = new URL(source).pathname;

    if (/\.m3u8$/i.test(path)) {
      format = 'hls';
    } else if (/\.mp4$/i.test(path)) {
      format = 'mp4';
    } else if (source) {
      format = 'other';
    }
  } catch {
    format = 'invalid';
  }

  const headers = stream?.headers;

  const headerNames =
    headers && typeof headers === 'object'
      ? Object.keys(headers).map(x =>
          x.toLowerCase()
        )
      : [];

  const tracks =
    stream?.subtitles ||
    stream?.tracks ||
    [];

  const subtitleList =
    Array.isArray(tracks) ? tracks : [];

  return {
    format,
    hasSource: Boolean(source),
    requiresHeaders: headerNames.length > 0,
    headerNames,
    subtitles: subtitleList.length,
    hasQualityLabel: Boolean(
      stream?.quality ||
      stream?.resolution
    )
  };
}

async function run() {
  const http = new HttpClient({
    timeoutMs: 10000
  });

  const provider = new MegaPlayProvider(http);

  console.log('MegaPlayProvider: INITIALISED');

  console.log('--- ANIME SEARCH ---');

  const results = await provider.search(TITLE);

  console.log(
    'SEARCH RESULTS:',
    Array.isArray(results) ? results.length : 0
  );

  const matches = Array.isArray(results)
    ? results.filter(item =>
        titleMatches(item, TITLE)
      )
    : [];

  console.log('EXACT MATCHES:', matches.length);

  // Prefer the verified AniList ID for Naruto.
  const anime = matches.find(item =>
    /(?:^|:)20$/.test(String(item.id))
  );

  if (!anime) {
    console.log('RESULT: ANIME_ID_NOT_FOUND');
    return;
  }

  console.log('ANIME ID:', String(anime.id));

  console.log('--- EPISODE LOOKUP ---');

  const units = await provider.fetchContentUnits(
    anime.id
  );

  console.log(
    'EPISODES FOUND:',
    Array.isArray(units) ? units.length : 0
  );

  if (!Array.isArray(units)) {
    console.log('RESULT: EPISODE_LIST_INVALID');
    return;
  }

  const episodes = units.filter(unit =>
    Number(unit?.number) === EPISODE
  );

  if (episodes.length !== 1) {
    console.log('RESULT: EPISODE_NOT_UNIQUE');
    return;
  }

  const unit = episodes[0];

  console.log('EPISODE ID:', String(unit.id));

  console.log('--- STREAM RESOLUTION ---');

  for (const language of ['sub', 'dub']) {
    console.log('LANGUAGE:', language);

    try {
      const result = await provider.resolveStream(
        unit.id,
        language
      );

      console.log(
        'RESULT TYPE:',
        result?.type || 'unknown'
      );

      if (
        result?.type !== 'video' ||
        !Array.isArray(result.streams)
      ) {
        console.log(
          'STREAM STATUS: NO_VIDEO_PAYLOAD'
        );
        continue;
      }

      console.log(
        'STREAM COUNT:',
        result.streams.length
      );

      result.streams.slice(0, 3).forEach(
        (stream, index) => {
          console.log(
            'STREAM ' + (index + 1) + ':',
            JSON.stringify(
              describeStream(stream)
            )
          );
        }
      );

      console.log(
        'STREAM STATUS:',
        result.streams.length
          ? 'METADATA_RETURNED'
          : 'NO_STREAMS'
      );

    } catch (error) {
      console.log(
        'STREAM STATUS: RESOLVE_FAILED'
      );

      console.log(
        'ERROR TYPE:',
        String(
          error?.name || 'Unknown'
        )
      );
    }
  }

  console.log('RESULT: DIAGNOSTIC_COMPLETE');
}

try {
  await run();
} catch (error) {
  console.log('RESULT: DIAGNOSTIC_FAILED');
  console.log(
    'ERROR TYPE:',
    String(error?.name || 'Unknown')
  );
}

console.log('================================');
console.log('No video files downloaded.');
console.log('No stream URLs or tokens printed.');
console.log('================================');
