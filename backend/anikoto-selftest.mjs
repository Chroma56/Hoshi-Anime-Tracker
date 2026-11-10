
/*
 * Hoshi Anikoto Self-Test V2.1
 *
 * Compatible with anikoto-provider.mjs V2.1
 *
 * Tests:
 * - Explicit anime title mappings
 * - AniList ID parsing
 * - Exact anime title matching
 * - Invalid series rejection
 * - Unrelated anime rejection
 *
 * No network requests or video downloads.
 */

import assert from 'node:assert/strict';

import {
  getAniListId,
  getMappedTitle,
  normalizeTitle,
  matchAnime
} from './anikoto-provider.mjs';

console.log('================================');
console.log('HOSHI ANIKOTO SELF-TEST V2.1');
console.log('================================');

const previousTitleMap =
  process.env.ANIKOTO_TITLE_MAP;

const previousIdMap =
  process.env.ANILIST_ID_MAP;

try {
  process.env.ANIKOTO_TITLE_MAP = JSON.stringify({
    al20: 'Naruto'
  });

  process.env.ANILIST_ID_MAP = JSON.stringify({
    test123: '20'
  });

  // Test 1: Anime title mapping
  assert.equal(
    getMappedTitle('al20'),
    'Naruto'
  );

  console.log('PASS: Anime title mapping');

  // Test 2: AniList ID recognition
  assert.equal(
    getAniListId('al20'),
    '20'
  );

  assert.equal(
    getAniListId('test123'),
    '20'
  );

  console.log('PASS: AniList ID recognition');

  // Test 3: Title normalization
  assert.equal(
    normalizeTitle('NARUTO'),
    normalizeTitle('Naruto')
  );

  console.log('PASS: Title normalization');

  // Test 4: Exact anime matching
  const results = [
    {
      id: 'anikoto:100',
      title: 'Naruto'
    },
    {
      id: 'anikoto:200',
      title: 'One Piece'
    },
    {
      id: 'anikoto:300',
      title: 'Bleach'
    }
  ];

  const matches = matchAnime(
    results,
    'naruto'
  );

  assert.equal(matches.length, 1);
  assert.equal(
    matches[0].id,
    'anikoto:100'
  );

  console.log('PASS: Exact anime matching');

  // Test 5: Invalid and unrelated anime
  assert.equal(
    getMappedTitle('../unsafe'),
    null
  );

  assert.equal(
    matchAnime(results, 'Dragon Ball').length,
    0
  );

  console.log('PASS: Invalid and unrelated anime rejected');

  console.log('--------------------------------');
  console.log('HOSHI ANIKOTO SELFTEST: 5 PASSED');
  console.log('No network requests performed.');
  console.log('--------------------------------');

} catch (error) {
  console.error(
    'HOSHI ANIKOTO SELFTEST: FAILED'
  );

  console.error(error.message);

  process.exitCode = 1;

} finally {
  if (previousTitleMap === undefined) {
    delete process.env.ANIKOTO_TITLE_MAP;
  } else {
    process.env.ANIKOTO_TITLE_MAP =
      previousTitleMap;
  }

  if (previousIdMap === undefined) {
    delete process.env.ANILIST_ID_MAP;
  } else {
    process.env.ANILIST_ID_MAP =
      previousIdMap;
  }
}
