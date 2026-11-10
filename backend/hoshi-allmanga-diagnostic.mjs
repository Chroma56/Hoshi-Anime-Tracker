/*
 * Hoshi AllManga Diagnostic V1
 * Tests catalogue and stream metadata for Naruto and Frieren.
 * No playback, video segment requests, or proxy server.
 * Full video URLs, headers and tokens are never logged.
 */
import { HttpClient, AllmangaProvider } from 'anime-sdk';

const provider = new AllmangaProvider(new HttpClient({ timeoutMs: 10000 }));
const tests = [
  { title: 'Naruto', search: 'Naruto', year: 2002 },
  { title: 'Frieren', search: 'Frieren', year: 2023 }
];

function normal(s) {
  return String(s || '').toLowerCase().normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function mediaTitle(item) {
  const t = item?.title;
  return typeof t === 'string' ? t :
    (t && typeof t === 'object' ? (t.english || t.romaji || t.native || '') : '');
}

function pickShow(shows, test) {
  // Do not silently select Naruto Shippuden or Frieren Season 2.
  const expected = test.title === 'Frieren'
    ? ['frieren beyond journey s end', 'sousou no frieren', 'frieren']
    : ['naruto'];
  const exact = shows.filter(x => expected.includes(normal(mediaTitle(x))));
  const yearMatched = exact.filter(x => Number(x.year) === test.year);
  return (yearMatched.length === 1 ? yearMatched[0] :
    exact.length === 1 ? exact[0] : null);
}

function classify(err) {
  const msg = String(err?.message || '').toLowerCase();
  const raw = Number(err?.statusCode ?? err?.status ?? err?.response?.status);
  const httpStatus = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  let category = 'UNKNOWN_ERROR';
  if (/no video sources|no streams?|no sources?/.test(msg)) category = 'NO_VIDEO_SOURCES';
  else if (/timeout|timed out|abort/.test(msg)) category = 'TIMEOUT';
  else if (/captcha|challenge|turnstile/.test(msg)) category = 'ACCESS_CHALLENGE';
  else if (httpStatus === 401 || httpStatus === 403 || /forbidden|unauthori[sz]ed/.test(msg)) category = 'ACCESS_RESTRICTED';
  else if (httpStatus === 429 || /rate.limit/.test(msg)) category = 'RATE_LIMITED';
  else if (httpStatus === 404 || /not found|unavailable/.test(msg)) category = 'SOURCE_UNAVAILABLE';
  else if (/json|parse|decrypt|aes|decode|unexpected token/.test(msg)) category = 'FORMAT_OR_DECODING_ERROR';
  else if (/fetch failed|network|dns|socket|econn/.test(msg)) category = 'NETWORK_ERROR';
  else if (httpStatus && httpStatus >= 500) category = 'UPSTREAM_SERVER_ERROR';
  else if (httpStatus) category = 'HTTP_ERROR';
  return { category, httpStatus };
}

function streamFormat(s) {
  if (s?.isHLS === true) return 'HLS';
  const u = s?.sourceUrl || s?.url;
  if (typeof u !== 'string') return 'MISSING';
  try {
    const path = new URL(u).pathname;
    if (/\.m3u8$/i.test(path)) return 'HLS';
    if (/\.mp4$/i.test(path)) return 'MP4';
    return 'OTHER';
  } catch { return 'INVALID'; }
}

console.log('================================');
console.log('HOSHI ALLMANGA DIAGNOSTIC V1');
console.log('================================');
console.log('PROVIDER: allmanga');

for (const test of tests) {
  console.log('--- ' + test.title.toUpperCase() + ' ---');
  let shows, show, units, unit;
  try {
    shows = await provider.search(test.search);
    console.log('SEARCH_COUNT:', Array.isArray(shows) ? shows.length : 0);
    if (!Array.isArray(shows)) { console.log('RESULT: INVALID_SEARCH'); continue; }
    show = pickShow(shows, test);
    if (!show) {
      console.log('EXACT_MATCH_COUNT:', shows.filter(x => normal(mediaTitle(x)).includes(normal(test.title))).length);
      console.log('RESULT: UNAMBIGUOUS_TITLE_NOT_FOUND');
      continue;
    }
    console.log('SHOW_MATCHED:', true);
    console.log('SHOW_LANGUAGES:', JSON.stringify(show.availableLanguages || []));
    units = await provider.fetchContentUnits(show.id);
    console.log('EPISODE_COUNT:', Array.isArray(units) ? units.length : 0);
    if (!Array.isArray(units)) { console.log('RESULT: INVALID_EPISODES'); continue; }
    unit = units.find(x => Number(x.number) === 1);
    if (!unit) { console.log('RESULT: EPISODE_1_NOT_FOUND'); continue; }
    console.log('EPISODE_1_FOUND:', true);
    console.log('EPISODE_LANGUAGES:', JSON.stringify(unit.availableLanguages || []));
  } catch (err) {
    console.log('LOOKUP_ERROR:', JSON.stringify(classify(err)));
    console.log('RESULT: LOOKUP_FAILED');
    continue;
  }

  for (const lang of ['sub', 'dub']) {
    console.log('LANGUAGE:', lang);
    if (Array.isArray(unit.availableLanguages) && unit.availableLanguages.length && !unit.availableLanguages.includes(lang)) {
      console.log('RESULT: LANGUAGE_NOT_LISTED');
      continue;
    }
    const start = Date.now();
    try {
      const result = await provider.resolveStream(unit.id, lang);
      console.log('RESOLVE_MS:', Date.now() - start);
      console.log('RESULT_TYPE:', result?.type || 'unknown');
      if (result?.type !== 'video' || !Array.isArray(result.streams)) {
        console.log('RESULT: NO_VIDEO_PAYLOAD');
        continue;
      }
      console.log('STREAM_COUNT:', result.streams.length);
      for (const s of result.streams.slice(0, 3)) {
        console.log('STREAM_METADATA:', JSON.stringify({
          format: streamFormat(s),
          hasSource: typeof (s?.sourceUrl || s?.url) === 'string',
          needsHeaders: Boolean(s?.headers && Object.keys(s.headers).length),
          subtitleCount: Array.isArray(s?.subtitles) ? s.subtitles.length : 0
        }));
      }
      console.log('RESULT:', result.streams.length ? 'VIDEO_METADATA_RETURNED' : 'NO_VIDEO_SOURCES');
    } catch (err) {
      console.log('RESOLVE_MS:', Date.now() - start);
      console.log('RESOLVE_ERROR:', JSON.stringify(classify(err)));
      console.log('RESULT: RESOLVE_FAILED');
    }
  }
}
console.log('RESULT: ALLMANGA_TEST_COMPLETE');
console.log('No media URLs, tokens or credentials printed. No video segments downloaded.');
