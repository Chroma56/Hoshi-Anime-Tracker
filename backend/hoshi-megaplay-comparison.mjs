
/*
 * Hoshi MegaPlay Comparison V1
 * Tests Naruto vs Frieren with default language.
 * Does not proxy/download video or log source URLs or credentials.
 */
import { HttpClient, MegaPlayProvider } from 'anime-sdk';

const http = new HttpClient({ timeoutMs: 10000 });
const provider = new MegaPlayProvider(http, { baseUrl: 'https://megaplay.buzz' });
const tests = [
  { title: 'Naruto', aniListId: 20 },
  { title: 'Frieren', aniListId: 154587 }
];

function describeError(error) {
  const name = String(error?.name || 'Error');
  const msg = String(error?.message || '').toLowerCase();
  let category = 'UNKNOWN_ERROR';
  if (/no video sources|no stream|no source/.test(msg)) category = 'NO_VIDEO_SOURCES';
  else if (/timed out|timeout|abort/.test(msg)) category = 'TIMEOUT';
  else if (/not found|no mapping|unavailable/.test(msg)) category = 'SOURCE_NOT_AVAILABLE';
  else if (/unauthori|forbidden|captcha|challenge/.test(msg)) category = 'ACCESS_RESTRICTED';
  else if (/fetch failed|network|dns|socket/.test(msg)) category = 'NETWORK_ERROR';
  else if (/json|parse|unexpected token/.test(msg)) category = 'PARSING_ERROR';
  const rawStatus = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  return { name: name.slice(0, 40), category, httpStatus: status };
}

function sourceFormat(stream) {
  if (stream?.isHLS === true) return 'HLS';
  const url = stream?.sourceUrl || stream?.url;
  if (typeof url !== 'string') return 'UNKNOWN';
  try {
    const pathname = new URL(url).pathname;
    if (/\.m3u8$/i.test(pathname)) return 'HLS';
    if (/\.mp4$/i.test(pathname)) return 'MP4';
    return 'OTHER';
  } catch { return 'INVALID'; }
}

console.log('================================');
console.log('HOSHI MEGAPLAY COMPARISON V1');
console.log('================================');

for (const test of tests) {
  console.log('--- ' + test.title.toUpperCase() + ' ---');
  const desiredId = 'megaplay:' + test.aniListId;
  try {
    const shows = await provider.search(test.title);
    console.log('SEARCH_COUNT:', Array.isArray(shows) ? shows.length : 0);
    const show = Array.isArray(shows) && shows.find(x => String(x?.id) === desiredId);
    if (!show) {
      console.log('RESULT: EXACT_ID_NOT_FOUND');
      continue;
    }
    console.log('ANIME_ID:', show.id);
    const units = await provider.fetchContentUnits(show.id);
    console.log('EPISODE_COUNT:', Array.isArray(units) ? units.length : 0);
    const unit = Array.isArray(units) && units.find(x => Number(x?.number) === 1);
    if (!unit) {
      console.log('RESULT: EPISODE_1_NOT_FOUND');
      continue;
    }
    console.log('EPISODE_ID:', String(unit.id));
    const started = Date.now();
    try {
      // Purposefully omit language to match the SDK documentation example.
      const resolved = await provider.resolveStream(unit.id);
      console.log('RESOLVE_MS:', Date.now() - started);
      console.log('RESULT_TYPE:', resolved?.type || 'unknown');
      if (resolved?.type === 'video' && Array.isArray(resolved.streams)) {
        console.log('STREAM_COUNT:', resolved.streams.length);
        for (const stream of resolved.streams.slice(0, 3)) {
          console.log('STREAM_METADATA:', JSON.stringify({
            format: sourceFormat(stream),
            hasSource: typeof (stream?.sourceUrl || stream?.url) === 'string',
            requiresHeaders: !!stream?.headers && Object.keys(stream.headers).length > 0,
            subtitleCount: Array.isArray(stream?.subtitles) ? stream.subtitles.length : 0
          }));
        }
        console.log('RESULT:', resolved.streams.length ? 'VIDEO_METADATA_RETURNED' : 'NO_VIDEO_SOURCES');
      } else {
        console.log('RESULT: NON_VIDEO_PAYLOAD');
      }
    } catch (error) {
      console.log('RESOLVE_MS:', Date.now() - started);
      console.log('RESOLVE_ERROR:', JSON.stringify(describeError(error)));
      console.log('RESULT: RESOLVE_FAILED');
    }
  } catch (error) {
    console.log('LOOKUP_ERROR:', JSON.stringify(describeError(error)));
    console.log('RESULT: LOOKUP_FAILED');
  }
}
console.log('RESULT: COMPARISON_COMPLETE');
console.log('No video segments requested; no media URLs or credentials printed.');
