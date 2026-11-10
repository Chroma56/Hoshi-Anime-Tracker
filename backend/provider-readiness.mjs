
```javascript
// Hoshi provider diagnostic.
// Tests provider readiness without exposing API tokens.
//
// Usage:
// node provider-readiness.mjs 8989 1 sub

import {
  providerEntry,
  providerUrl
} from './provider-adapter.mjs';

const [
  series = '8989',
  episode = '1',
  lang = 'sub'
] = process.argv.slice(2);

const endpoint = providerUrl(
  process.env.PROVIDER_API_URL || ''
);

const safe = {
  providerConfigured: !!endpoint,
  providerHostAllowed: !!endpoint,
  mediaHostsConfigured: !!(
    process.env.MEDIA_HOSTS || ''
  ).trim(),
  catalogEntries: (() => {
    try {
      return Object.keys(
        JSON.parse(process.env.STREAM_CATALOG || '{}')
      ).length;
    } catch {
      return 0;
    }
  })(),
  sample: {
    series,
    episode,
    lang
  }
};

if (!endpoint) {
  console.log(JSON.stringify({
    ...safe,
    directAvailable: false,
    reason: 'Configure HTTPS PROVIDER_API_URL and matching PROVIDER_HOSTS first'
  }, null, 2));

  process.exitCode = 2;
} else {
  const result = await providerEntry(
    series,
    episode,
    lang
  );

  console.log(JSON.stringify({
    ...safe,
    directAvailable: !!result,
    format: result?.type || null,
    subtitleCount: result?.subtitles?.length || 0,
    reason: result
      ? 'Provider returned direct metadata (playback not verified)'
      : 'No compatible direct response; embed fallback applies'
  }, null, 2));

  if (!result) process.exitCode = 1;
}
```
