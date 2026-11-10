
const key = process.env.ANIMEDOC_API_KEY;

if (!key) {
  console.log('RESULT: KEY_MISSING');
  process.exit(0);
}

try {
  const response = await fetch(
    'https://api.animedoc.cloud/api/v2/anime/search/',
    {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        keyword: 'naruto',
        page: 1,
        perPage: 5,
        subjectType: 0
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    }
  );

  console.log('HTTP STATUS:', response.status);

  if (!response.ok) {
    console.log('RESULT: REQUEST_FAILED');
  } else {
    const result = await response.json();
    const data = result.data || {};
    const items = Array.isArray(data.items) ? data.items : [];

    console.log('API CODE:', result.code);
    console.log('PAGER:', JSON.stringify(data.pager || {}));
    console.log('COUNTS:', JSON.stringify(data.counts || {}));
    console.log('ITEMS FOUND:', items.length);

    for (const item of items.slice(0, 5)) {
      console.log('ANIME:', JSON.stringify({
        title: item.title,
        subjectId: item.subjectId,
        detailPath: item.detailPath,
        hasResource: item.hasResource
      }));
    }

    console.log(
      'RESULT:',
      items.length ? 'ANIME_FOUND' : 'NO_SEARCH_RESULTS'
    );
  }
} catch (error) {
  console.log('RESULT: CONNECTION_FAILED');
  console.log('ERROR TYPE:', error.name);
}

console.log('No API credentials or video URLs printed.');
