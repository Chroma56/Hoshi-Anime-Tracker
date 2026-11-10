
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlaylist,
  resolveEntry
} from './server.mjs';

const master =
  'https://media.example.test/season/master.m3u8';

const allow = (x, ext) => {
  const u = new URL(x);

  return (
    u.hostname === 'media.example.test' &&
    ext.test(u.pathname)
  ) ? u.href : null;
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
  const payload =
    '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="EN",URI="https://other.test/en.vtt"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=400\n' +
    'https://other.test/720.m3u8';

  assert.deepEqual(
    parsePlaylist(payload, master, allow),
    {
      qualities: [],
      subtitles: []
    }
  );
});

test('empty catalog always falls back to embed', async () => {
  process.env.STREAM_CATALOG = '{}';

  assert.equal(
    (await resolveEntry('8989', '1', 'sub')).type,
    'embed'
  );
});

import {
  providerEntry,
  providerUrl
} from './provider-adapter.mjs';

test('provider URL must be HTTPS and on the provider-host allowlist', () => {
  const hosts = new Set(['api.example.test']);

  assert.equal(
    providerUrl(
      'https://api.example.test/resolve',
      hosts
    )?.pathname,
    '/resolve'
  );

  assert.equal(
    providerUrl(
      'http://api.example.test/resolve',
      hosts
    ),
    null
  );

  assert.equal(
    providerUrl(
      'https://other.test/resolve',
      hosts
    ),
    null
  );

  assert.equal(
    providerUrl(
      'https://api.example.test/resolve?unsafe=1',
      hosts
    ),
    null
  );
});

test('provider adapter retrieves a permitted JSON stream response', async () => {
  process.env.PROVIDER_HOSTS = 'api.example.test';
  process.env.PROVIDER_API_URL =
    'https://api.example.test/resolve';

  const example = {
    available: true,
    type: 'direct',
    format: 'mp4',
    url: 'https://media.example.test/demo.mp4',
    subtitles: []
  };

  const mock = async (url, init) => {
    assert.equal(
      url.searchParams.get('series'),
      '8989'
    );

    assert.equal(
      url.searchParams.get('episode'),
      '1'
    );

    assert.equal(
      url.searchParams.get('lang'),
      'sub'
    );

    assert.equal(init.redirect, 'error');

    return new Response(
      JSON.stringify(example),
      {
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  };

  const stream = await providerEntry(
    '8989',
    '1',
    'sub',
    mock
  );

  assert.equal(stream.url, example.url);
  assert.equal(stream.type, 'mp4');

  delete process.env.PROVIDER_API_URL;
  delete process.env.PROVIDER_HOSTS;
});

test('provider adapter rejects embed-only responses', async () => {
  process.env.PROVIDER_HOSTS = 'api.example.test';
  process.env.PROVIDER_API_URL =
    'https://api.example.test/resolve';

  const fake = async () =>
    new Response(
      JSON.stringify({
        type: 'embed',
        available: false,
        url: 'https://site.example/watch'
      }),
      {
        headers: {
          'content-type': 'application/json'
        }
      }
    );

  assert.equal(
    await providerEntry(
      '8989',
      '1',
      'sub',
      fake
    ),
    null
  );

  delete process.env.PROVIDER_API_URL;
  delete process.env.PROVIDER_HOSTS;
});
