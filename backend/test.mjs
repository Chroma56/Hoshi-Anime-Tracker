
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, resolveEntry } from './server.mjs';

const master = 'https://media.example.test/season/master.m3u8';

const allow = (x, ext) => {
  const u = new URL(x);
  return u.hostname === 'media.example.test' && ext.test(u.pathname)
    ? u.href
    : null;
};

const sample = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English, CC",LANGUAGE="en",URI="captions/en.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",URI="captions/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3600000,RESOLUTION=1920x1080,SUBTITLES="subs"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,SUBTITLES="subs"
720/index.m3u8`;

test('HLS master yields ordered quality renditions', () => {
  const result = parsePlaylist(sample, master, allow);

  assert.deepEqual(
    result.qualities.map(x => x.label),
    ['1080p', '720p']
  );

  assert.equal(
    result.qualities[0].url,
    'https://media.example.test/season/1080/index.m3u8'
  );
});

test('HLS direct VTT subtitles preserve quoted commas', () => {
  const result = parsePlaylist(sample, master, allow);

  assert.deepEqual(result.subtitles, [{
    url: 'https://media.example.test/season/captions/en.vtt',
    lang: 'en',
    label: 'English, CC'
  }]);
});

test('reject captions and renditions from non-allowlisted hosts', () => {
  const payload = '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="EN",URI="https://other.test/en.vtt"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=400\n' +
    'https://other.test/720.m3u8';

  assert.deepEqual(
    parsePlaylist(payload, master, allow),
    { qualities: [], subtitles: [] }
  );
});

test('empty catalog always falls back to embed', async () => {
  process.env.STREAM_CATALOG = '{}';

  assert.equal(
    (await resolveEntry('8989', '1', 'sub')).type,
    'embed'
  );
});
