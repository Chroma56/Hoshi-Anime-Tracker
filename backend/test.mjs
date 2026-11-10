import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaster } from './server.mjs';
test('no variants from media playlist', () => assert.deepEqual(parseMaster('#EXTM3U\n#EXTINF:10', 'https://example.com/master.m3u8'), []));
test('rejects variants without configured host', () => assert.deepEqual(parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8', 'https://example.com/master.m3u8'), []));
