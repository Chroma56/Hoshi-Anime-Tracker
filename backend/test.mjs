import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// server.mjs reads its settings once, when it is imported, so they are set first and the
// modules are loaded with import() afterwards. Nothing here touches the network.
process.env.NODE_ENV = 'test';
process.env.MEDIA_HOSTS = 'media.example.test,*.wild.example.test';
process.env.HOSHI_RELAY_ENABLED = 'false';
process.env.RELAY_SIGNING_KEY = 'offline-test-only-' + crypto.randomBytes(32).toString('hex');
process.env.RELAY_PUBLIC_BASE = 'https://stream.example.test/';
process.env.STREAM_CATALOG = '{}';
delete process.env.RELAY_STRICT_HOSTS;

const { parseMaster, resolve, rewritePlaylist, signedLink, validSignature } = await import('./server.mjs');
const { providerEntry, providerUrl } = await import('./provider-adapter.mjs');

const master = 'https://media.example.test/season/master.m3u8';
const exp = String(Math.floor(Date.now() / 1000) + 900);

const sample = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English, CC",LANGUAGE="en",URI="captions/en.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",URI="captions/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3600000,RESOLUTION=1920x1080,SUBTITLES="subs"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,SUBTITLES="subs"
720/index.m3u8`;

// ── Master playlist parsing ─────────────────────────────────────────────────

test('HLS master yields ordered quality renditions', () => {
  const result = parseMaster(sample, master);
  assert.deepEqual(result.qualities.map(x => x.label), ['1080p', '720p']);
  assert.equal(result.qualities[0].url, 'https://media.example.test/season/1080/index.m3u8');
});

test('HLS direct VTT subtitles preserve quoted commas', () => {
  assert.deepEqual(parseMaster(sample, master).subtitles, [{
    url: 'https://media.example.test/season/captions/en.vtt',
    lang: 'en',
    label: 'English, CC'
  }]);
});

test('a byte-order mark before #EXTM3U does not hide the playlist', () => {
  assert.equal(parseMaster('﻿' + sample, master).qualities.length, 2);
});

test('reject captions and renditions from non-allowlisted hosts', () => {
  const payload =
    '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="EN",URI="https://other.test/en.vtt"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=400\n' +
    'https://other.test/720.m3u8';
  assert.deepEqual(parseMaster(payload, master), { qualities: [], subtitles: [] });
});

test('a "*.domain" entry covers every subdomain and nothing else', () => {
  const variant = host => parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400,RESOLUTION=1280x720\nhttps://' + host + '/720.m3u8', master).qualities.length;
  assert.equal(variant('ab12c.wild.example.test'), 1);
  assert.equal(variant('a.b.wild.example.test'), 1);
  assert.equal(variant('wild.example.test'), 0);
  assert.equal(variant('notwild.example.test'), 0);
  assert.equal(variant('wild.example.test.evil.test'), 0);
});

test('empty catalog always falls back to embed', async () => {
  assert.equal((await resolve('8989', '1', 'sub')).type, 'embed');
});

// ── Relay links ─────────────────────────────────────────────────────────────

test('relay links end in the extension the Worker and the page check for', () => {
  const ext = link => new URL(link).pathname;
  assert.equal(ext(signedLink(master, exp, '', 'hls')), '/media/hls.m3u8');
  assert.equal(ext(signedLink('https://media.example.test/a.mp4', exp, '', 'video')), '/media/video.mp4');
  assert.equal(ext(signedLink('https://media.example.test/en.vtt', exp, '', 'sub')), '/media/sub.vtt');
  assert.equal(ext(signedLink('https://media.example.test/seg1.ts', exp)), '/media/file');
});

test('a signature covers the kind, the address, the expiry and the referer', () => {
  const referer = 'https://megaplay.buzz/';
  const link = new URL(signedLink(master, exp, referer, 'hls'));
  const sig = link.searchParams.get('sig');
  assert.equal(validSignature('hls', master, exp, sig, referer), true);
  assert.equal(validSignature('file', master, exp, sig, referer), false);
  assert.equal(validSignature('hls', master + 'x', exp, sig, referer), false);
  assert.equal(validSignature('hls', master, String(Number(exp) + 1), sig, referer), false);
  assert.equal(validSignature('hls', master, exp, sig, ''), false);
});

test('expired links are refused', () => {
  const old = String(Math.floor(Date.now() / 1000) - 5);
  const sig = new URL(signedLink(master, old, '', 'hls')).searchParams.get('sig');
  assert.equal(validSignature('hls', master, old, sig, ''), false);
});

// ── Playlist rewriting ──────────────────────────────────────────────────────

test('variants and renditions become playlist links, files become file links', () => {
  const lines = rewritePlaylist(sample, master, exp).split('\n');
  const at = i => new URL(/^#/.test(lines[i]) ? /URI="([^"]*)"/.exec(lines[i])[1] : lines[i]);

  // A subtitle named directly as .vtt is a file, even inside #EXT-X-MEDIA.
  assert.equal(at(1).pathname, '/media/file');
  assert.equal(at(1).searchParams.get('u'), 'https://media.example.test/season/captions/en.vtt');
  assert.equal(at(2).pathname, '/media/hls.m3u8');
  assert.equal(at(4).pathname, '/media/hls.m3u8');
  assert.equal(at(4).searchParams.get('u'), 'https://media.example.test/season/1080/index.m3u8');
  assert.equal(at(6).pathname, '/media/hls.m3u8');
});

test('a variant without .m3u8 in its name is still treated as a playlist', () => {
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant?id=7\nseg.ts', master, exp).split('\n');
  assert.equal(new URL(out[2]).pathname, '/media/hls.m3u8');
  assert.equal(new URL(out[3]).pathname, '/media/file');
});

test('segments, keys and init sections on another public host are relayed', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.cdn.example.test/k1.key",IV=0x01',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'https://edge7.cdn.example.test/v/seg1.ts'
  ].join('\n');
  const out = rewritePlaylist(media, master, exp, 'https://megaplay.buzz/').split('\n');

  const key = new URL(/URI="([^"]*)"/.exec(out[1])[1]);
  assert.equal(key.pathname, '/media/file');
  assert.equal(key.searchParams.get('u'), 'https://keys.cdn.example.test/k1.key');
  assert.match(out[1], /,IV=0x01$/);

  const init = new URL(/URI="([^"]*)"/.exec(out[2])[1]);
  assert.equal(init.searchParams.get('u'), 'https://media.example.test/season/init.mp4');

  const seg = new URL(out[4]);
  assert.equal(seg.hostname, 'stream.example.test');
  assert.equal(seg.searchParams.get('u'), 'https://edge7.cdn.example.test/v/seg1.ts');
  assert.equal(seg.searchParams.get('r'), 'https://megaplay.buzz/');
  assert.equal(validSignature('file', seg.searchParams.get('u'), exp, seg.searchParams.get('sig'), 'https://megaplay.buzz/'), true);
});

test('local, numeric and plain-http addresses in a playlist are dropped', () => {
  const out = rewritePlaylist(
    '#EXTM3U\nhttps://127.0.0.1/a.ts\nhttps://localhost/b.ts\nhttp://media.example.test/c.ts\nhttps://router.local/d.ts\nhttps://media.example.test:8443/e.ts',
    master,
    exp
  );
  assert.equal(out.trim(), '#EXTM3U');
});

test('data: key URIs are left as they are', () => {
  const line = '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"';
  assert.equal(rewritePlaylist('#EXTM3U\n' + line, master, exp).split('\n')[1], line);
});

// ── Provider adapter ────────────────────────────────────────────────────────

test('provider URL must be HTTPS and on the provider-host allowlist', () => {
  process.env.PROVIDER_HOSTS = 'api.example.test';
  assert.equal(providerUrl('https://api.example.test/resolve')?.pathname, '/resolve');
  assert.equal(providerUrl('http://api.example.test/resolve'), null);
  assert.equal(providerUrl('https://other.test/resolve'), null);
  delete process.env.PROVIDER_HOSTS;
});

// The adapter calls the global fetch, so the tests swap it out for the length of one call.
async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test('provider adapter retrieves a permitted JSON stream response', async () => {
  process.env.PROVIDER_HOSTS = 'api.example.test';
  process.env.PROVIDER_API_URL = 'https://api.example.test/resolve';
  const example = { available: true, type: 'direct', format: 'mp4', url: 'https://media.example.test/demo.mp4', subtitles: [] };

  const stream = await withFetch(async (url, init) => {
    assert.equal(url.searchParams.get('series'), '8989');
    assert.equal(url.searchParams.get('episode'), '1');
    assert.equal(url.searchParams.get('lang'), 'sub');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify(example), { headers: { 'content-type': 'application/json' } });
  }, () => providerEntry('8989', '1', 'sub'));

  assert.equal(stream.url, example.url);
  assert.equal(stream.type, 'mp4');
  delete process.env.PROVIDER_API_URL;
  delete process.env.PROVIDER_HOSTS;
});

test('provider adapter rejects embed-only responses', async () => {
  process.env.PROVIDER_HOSTS = 'api.example.test';
  process.env.PROVIDER_API_URL = 'https://api.example.test/resolve';

  // A different series from the test above: the adapter caches successful answers.
  const stream = await withFetch(
    async () => new Response(JSON.stringify({ type: 'embed', available: false, url: 'https://site.example/watch' }), { headers: { 'content-type': 'application/json' } }),
    () => providerEntry('7777', '1', 'sub')
  );

  assert.equal(stream, null);
  delete process.env.PROVIDER_API_URL;
  delete process.env.PROVIDER_HOSTS;
});
