
// Hoshi AnimeDoc API Connection Test
// No video downloads or exposed API secrets.

const key = process.env.ANIMEDOC_API_KEY;

if (!key) {
  console.log('ANIMEDOC: KEY_NOT_CONFIGURED');
  process.exit(0);
}

const endpoint =
  'https://api.animedoc.cloud/api/v2/anime/search/';

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      keyword: 'Naruto',
      page: 1,
      perPage: 5
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(12000)
  });

  console.log('ANIMEDOC HTTP STATUS:', response.status);

  if (!response.ok) {
    if (response.status === 401) {
      console.log('RESULT: INVALID_API_KEY');
    } else if (response.status === 403) {
      console.log('RESULT: PLAN_OR_ACCESS_RESTRICTED');
    } else if (response.status === 429) {
      console.log('RESULT: RATE_LIMITED');
    } else {
      console.log('RESULT: API_ERROR');
    }
  } else {
    const json = await response.json();

    console.log('API response code:', json.code ?? 'unknown');

    const data = json.data;

    console.log(
      'Data structure:',
      Array.isArray(data) ? 'array' : typeof data
    );

    if (data && typeof data === 'object') {
      console.log('Data fields:', Object.keys(data).slice(0, 15));
    }

    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data?.list)
            ? data.list
            : [];

    console.log('Recognised search results:', items.length);

    if (items.length) {
      console.log(
        'First result fields:',
        Object.keys(items[0]).slice(0, 20)
      );
    }

    console.log(
      'RESULT:',
      json.code === 0 ? 'API_CONNECTED' : 'CHECK_RESPONSE'
    );
  }
} catch (error) {
  console.log('RESULT: CONNECTION_FAILED');
  console.log('Reason:', error.name === 'TimeoutError'
    ? 'Timeout'
    : 'Network request failed');
}

console.log('No API keys or media URLs printed.');
