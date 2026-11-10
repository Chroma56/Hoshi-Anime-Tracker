
/*
 * Hoshi Automatic Anikoto Diagnostic V2.1
 *
 * Tests automatic title and episode matching.
 * Does not request video streams.
 */

import {
  fetchAniListTitles,
  matchHoshiAnime,
  matchHoshiEpisode
} from './anikoto-provider.mjs';

console.log('================================');
console.log('HOSHI AUTO MATCH DIAGNOSTIC V2.1');
console.log('================================');

try {
  const series = 'al20';

  const metadata = await fetchAniListTitles(series);

  console.log(
    'ANILIST AVAILABLE:', metadata.available
  );

  console.log(
    'TITLES:', JSON.stringify(
      metadata.titles || []
    )
  );

  if (!metadata.available) {
    console.log('RESULT: ANILIST_FAILED');
  } else {
    const anime = await matchHoshiAnime(series);

    console.log(
      'ANIKOTO MATCHED:', anime.available
    );

    if (!anime.available) {
      console.log(
        'REASON:', anime.reason || 'Unknown'
      );
      console.log('RESULT: ANIKOTO_MATCH_FAILED');
    } else {
      console.log(
        'ANIKOTO ANIME ID:', anime.animeId
      );

      const sub = await matchHoshiEpisode(
        series, '1', 'sub'
      );

      const dub = await matchHoshiEpisode(
        series, '1', 'dub'
      );

      console.log('SUB AVAILABLE:', sub.available);
      console.log('DUB AVAILABLE:', dub.available);

      if (sub.available) {
        console.log(
          'SUB EPISODE ID:', sub.episodeId
        );
      }

      if (dub.available) {
        console.log(
          'DUB EPISODE ID:', dub.episodeId
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
    }
  }
} catch (error) {
  console.log('RESULT: AUTO_MATCH_ERROR');
  console.log(
    'ERROR:',
    String(error?.message || error).slice(0, 180)
  );
}

console.log('No video streams requested.');
