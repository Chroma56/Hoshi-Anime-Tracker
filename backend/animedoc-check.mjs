
// Hoshi AnimeDoc Diagnostic V3
// Check one title's episode metadata and media-source access.
// Never print API keys, signed video URLs or CDN tokens.

const KEY = process.env.ANIMEDOC_API_KEY;
const BASE = 'https://api.animedoc.cloud';

const subjectId = '4319713065219645832';
const detailPath = 'demons-crest-english-EGBaFVyk695';

if (!KEY) {
  console.log('RESULT: API_KEY_MISSING');
  process.exit(0);
}

async function api(path, params) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(url, {
      headers: {
        'X-API-Key': KEY,
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    });

    console.log('HTTP STATUS:', response.status);

    if (!response.ok) {
      return { error: response.status };
    }

    const body = await response.json();
    console.log('API CODE:', body.code);

    if (body.code !== 0) return { error: 'API_ERROR' };
    return { data: body.data || {} };
  } catch {
    return { error: 'NETWORK_ERROR' };
  }
}

console.log('=== ANIMEDOC DETAILS TEST ===');

const details = await api('/api/v2/anime/detail/', {
  detailPath
});

if (details.error) {
  console.log('DETAIL RESULT:', details.error);
  process.exit(0);
}

const resource = details.data.resource || {};
const seasons = Array.isArray(resource.seasons)
  ? resource.seasons : [];

console.log('TITLE:', details.data.title || 'Unknown');
console.log('SEASONS:', seasons.length);

for (const season of seasons) {
  console.log('SEASON:', season.se, 'EPISODES:', season.maxEp);
}

const chosen = seasons.find(season =>
  Number(season.maxEp) > 0
);

if (!chosen) {
  console.log('RESULT: NO_EPISODES_AVAILABLE');
  process.exit(0);
}

console.log('=== ANIMEDOC MEDIA ACCESS TEST ===');

const media = await api('/api/v2/anime/media-sources/', {
  subjectId,
  detailPath,
  se: chosen.se,
  ep: 1
});

if (media.error) {
  console.log('MEDIA RESULT:', media.error);

  if (media.error === 403) {
    console.log('PLAYBACK ACCESS REQUIRES PLAN REVIEW');
  }

  process.exit(0);
}

const downloads = Array.isArray(media.data.downloads)
  ? media.data.downloads : [];

const available = downloads.filter(item =>
  item.url && item.vipLocked !== true
);

const captions = Array.isArray(media.data.captions)
  ? media.data.captions : [];

console.log('VIDEO SOURCES:', available.length);
console.log(
  'RESOLUTIONS:',
  available.map(x => x.resolution).filter(Boolean)
);
console.log('CAPTIONS:', captions.length);

console.log(
  'RESULT:',
  available.length
    ? 'VIDEO_METADATA_AVAILABLE'
    : 'NO_ACCESSIBLE_VIDEO_SOURCES'
);

console.log('No video files downloaded.');
console.log('No signed URLs or credentials printed.');
