
const key = process.env.ANIMEDOC_API_KEY;

if (!key) {
  console.log('RESULT: KEY_MISSING');
  process.exit(0);
}

const url = new URL(
  'https://api.animedoc.cloud/api/v2/anime/browse/'
);

url.search = new URLSearchParams({
  channelId: '2',
  sort: 'Latest',
  genre: 'Anime',
  page: '1',
  perPage: '5'
}).toString();

try {
  const response = await fetch(url, {
    headers: {
      'X-API-Key': key,
      Accept: 'application/json'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(12000)
  });

  console.log('HTTP STATUS:', response.status);

  if (!response.ok) {
    console.log('RESULT: REQUEST_FAILED');
    process.exitCode = 0;
  } else {
    const json = await response.json();
    const data = json.data || {};
    const items = Array.isArray(data.items)
      ? data.items : [];

    console.log('API CODE:', json.code);
    console.log('ITEMS FOUND:', items.length);
    console.log(
      'PAGER:',
      JSON.stringify(data.pager || {})
    );

    for (const anime of items.slice(0, 5)) {
      console.log('ANIME:', JSON.stringify({
        title: anime.title || null,
        subjectId: anime.subjectId || null,
        detailPath: anime.detailPath || null
      }));
    }

    console.log(
      'RESULT:',
      items.length ? 'CATALOGUE_WORKING' : 'CATALOGUE_EMPTY'
    );
  }
} catch (error) {
  console.log('RESULT: CONNECTION_FAILED');
  console.log('ERROR TYPE:', error.name);
}

console.log('No API credentials or media URLs printed.');
