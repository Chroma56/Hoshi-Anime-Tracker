// One-time Render build diagnostic: searches Anikoto and lists content units.
// Does not resolve streams, fetch media, or print sensitive URLs.
import { HttpClient, AnikotoProvider } from 'anime-sdk';
import { exactTitleMatches } from './anikoto-provider.mjs';

const title = 'Naruto';
console.log('=== HOSHI ANIKOTO CATALOGUE TEST ===');
try {
  const sdk = await import('anime-sdk');
  console.log('AnikotoProvider:', typeof sdk.AnikotoProvider === 'function' ? 'AVAILABLE' : 'MISSING');
  const provider = new AnikotoProvider(new HttpClient({ timeoutMs: 8000 }));
  const results = await provider.search(title);
  console.log('Search results:', Array.isArray(results) ? results.length : 'Unexpected response');
  const exact = exactTitleMatches(results, title);
  console.log('Exact title matches:', exact.length);
  if (exact.length !== 1) {
    console.log('RESULT:', exact.length ? 'AMBIGUOUS_MATCH' : 'NO_EXACT_MATCH');
  } else {
    const units = await provider.fetchContentUnits(exact[0].id);
    console.log('Content units:', Array.isArray(units) ? units.length : 'Unexpected response');
    const sample = Array.isArray(units) ? units.slice(0, 3) : [];
    for (const u of sample) {
      console.log('Unit:', JSON.stringify({ id: u.id, number: u.number ?? u.episodeNumber ?? null, languages: u.availableLanguages ?? [] }));
    }
    console.log('RESULT:', sample.length ? 'ANIKOTO_EPISODES_FOUND' : 'NO_EPISODES');
  }
} catch (error) {
  // Do not print upstream URLs, headers or credentials.
  console.log('RESULT: SDK_REQUEST_FAILED');
  console.log('Error category:', error?.name || 'Unknown');
}
console.log('No stream resolution or video download performed.');
