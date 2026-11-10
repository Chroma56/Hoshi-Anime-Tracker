
// Hoshi V3.2 Relay Offline Self-Test
// Tests playlist handling and signed URLs.
// Does not download or play video.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Configure harmless test-only settings before importing.
process.env.NODE_ENV = 'test';
process.env.HOSHI_RELAY_ENABLED = 'false';
process.env.MEDIA_HOSTS = 'media.example.com';
process.env.RELAY_SIGNING_KEY =
  'offline-test-only-' +
  crypto.randomBytes(32).toString('hex');
process.env.RELAY_PUBLIC_BASE =
  'https://stream.example.com/';
process.env.STREAM_CATALOG = '{}';

const {
  parseMaster,
  rewritePlaylist,
  server
} = await import('./server.mjs');

let passed = 0;

function check(name, test) {
  test();
  passed++;
  console.log('PASS: ' + name);
}

const origin =
  'https://media.example.com/anime/master.m3u8';

const master = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="captions.vtt"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
  '720p/main.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
  '1080p/main.m3u8'
].join('\n');

const parsed = parseMaster(master, origin);

check('HLS quality detection', function () {
  assert.deepEqual(
    parsed.qualities.map(x => x.label),
    ['1080p', '720p']
  );

  assert.equal(
    parsed.qualities[0].url,
    'https://media.example.com/anime/1080p/main.m3u8'
  );
});

check('Subtitle metadata parsing', function () {
  assert.equal(parsed.subtitles.length, 1);

  assert.equal(
    parsed.subtitles[0].url,
    'https://media.example.com/anime/captions.vtt'
  );
});

const expires = String(
  Math.floor(Date.now() / 1000) + 900
);

const playlist = [
  '#EXTM3U',
  '#EXTINF:4,',
  'chunk0001.ts',
  '#EXT-X-MAP:URI="init.mp4"',
  ''
].join('\n');

const rewritten = rewritePlaylist(
  playlist,
  origin,
  expires
);

check('Signed media URLs', function () {
  const lines = rewritten.split('\n');
  const segment = new URL(lines[2]);

  assert.equal(
    segment.hostname,
    'stream.example.com'
  );

  assert.equal(
    segment.searchParams.get('u'),
    'https://media.example.com/anime/chunk0001.ts'
  );

  assert.match(
    segment.searchParams.get('sig'),
    /^[0-9a-f]{64}$/
  );

  assert.match(
    lines[3],
    /https:\/\/stream.example.com\/media\?/
  );
});

check('Unapproved media hosts rejected', function () {
  const unsafe = rewritePlaylist(
    '#EXTM3U\nhttps://unapproved.example/chunk.ts\n',
    origin,
    expires
  );

  assert.equal(
    unsafe.trim(),
    '#EXTM3U'
  );
});

check('Server stays offline', function () {
  assert.equal(typeof server.listen, 'function');
  assert.equal(server.listening, false);
});

console.log('------------------------------');
console.log(
  'HOSHI RELAY SELF-TEST: ' +
  passed +
  ' PASSED'
);
console.log('No video or network requests made.');
console.log('------------------------------');
