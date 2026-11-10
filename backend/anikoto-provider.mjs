
/*
 * Hoshi Automatic Anime Matching Diagnostic V2
 *
 * Tests:
 * 1. AniList ID lookup
 * 2. Automatic Anikoto matching
 * 3. Episode number matching
 * 4. SUB / DUB availability
 *
 * No video streams are requested.
 */

import {
  fetchAniListTitles,
  matchHoshiAnime,
  matchHoshiEpisode
} from './anikoto-provider.mjs';

console.log('================================');
console.log('HOSHI AUTO MATCH DIAGNOSTIC V2');
console.log('================================');

const series = 'al20';
const episode = '1';

try {
  console.log('SERIES:', series);
  console.log('EPISODE:', episode);

  console.log('--- ANILIST LOOKUP ---');

  const metadata = await fetchAniListTitles(
    series
  );

  console.log(
    'ANILIST AVAILABLE:',
    metadata.available
  );

  console.log(
    'TITLES:',
    JSON.stringify(metadata.titles || [])
  );

  if (!metadata.available) {
    console.log('RESULT: ANILIST_MATCH_FAILED');
    process.exit(0);
  }

  console.log('--- ANIKOTO MATCHING ---');

  const anime = await matchHoshiAnime(series);

  console.log(
    'ANIKOTO MATCHED:',
    anime.available
  );

  if (!anime.available) {
    console.log(
      'REASON:',
      anime.reason || 'Unknown'
    );

    console.log('RESULT: ANIKOTO_MATCH_FAILED');
    process.exit(0);
  }

  console.log(
    'ANIKOTO ANIME ID:',
    anime.animeId
  );

  console.log('--- SUB MATCH ---');

  const sub = await matchHoshiEpisode(
    series,
    episode,
    'sub'
  );

  console.log(
    'SUB AVAILABLE:',
    sub.available
  );

  if (sub.available) {
    console.log(
      'SUB EPISODE ID:',
      sub.episodeId
    );

    console.log(
      'TOTAL EPISODES:',
      sub.totalEpisodes
    );
  } else {
    console.log(
      'SUB REASON:',
      sub.reason || 'Unknown'
    );
  }

  console.log('--- DUB MATCH ---');

  const dub = await matchHoshiEpisode(
    series,
    episode,
    'dub'
  );

  console.log(
    'DUB AVAILABLE:',
    dub.available
  );

  if (dub.available) {
    console.log(
      'DUB EPISODE ID:',
      dub.episodeId
    );
  } else {
    console.log(
      'DUB REASON:',
      dub.reason || 'Unknown'
    );
  }

  console.log(
    'RESULT:',
    sub.available && dub.available
      ? 'AUTO_MATCH_SUCCESS'
      : sub.available || dub.available
        ? 'PARTIAL_MATCH_SUCCESS'
        : 'EPISODE_MATCH_FAILED'
  );
} catch (error) {
  console.log('RESULT: AUTO_MATCH_ERROR');

  console.log(
    'ERROR:',
    String(error?.message || error)
      .slice(0, 180)
  );
}

console.log('================================');
console.log('No stream URLs requested.');
console.log('No video files downloaded.');
console.log('================================');
