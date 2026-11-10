// Hoshi: optional anime-sdk Anikoto connector. Never proxies media.
// Matching is explicit so an unrelated show is never selected by a fuzzy match.
const asText = x => String(x ?? '').trim();
const normalize = x => asText(x).toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim();

export function titleForSeries(series, rawMap = process.env.ANIKOTO_TITLE_MAP || '{}') {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(asText(series))) return null;
  try {
    const map = typeof rawMap === 'string' ? JSON.parse(rawMap) : rawMap;
    const title = Object.hasOwn(map, series) ? map[series] : null;
    return typeof title === 'string' && title.length <= 150 && title.trim() ? title.trim() : null;
  } catch { return null; }
}

export function exactTitleMatches(results, title) {
  if (!Array.isArray(results)) return [];
  const needle = normalize(title);
  if (!needle) return [];
  return results.filter(result => {
    const strings = [result?.title, result?.name, result?.englishTitle, result?.romajiTitle];
    // Some SDK versions store title fields inside an object.
    if (result?.title && typeof result.title === 'object') strings.push(...Object.values(result.title));
    return strings.some(s => typeof s === 'string' && normalize(s) === needle);
  });
}

export async function findAnikotoEpisodes(series, { sdk, titleMap } = {}) {
  const title = titleForSeries(series, titleMap);
  if (!title) return { available: false, reason: 'No explicit title mapping' };
  const { HttpClient, AnikotoProvider } = sdk ?? await import('anime-sdk');
  const provider = new AnikotoProvider(new HttpClient({ timeoutMs: 8000 }));
  const results = await provider.search(title);
  const matches = exactTitleMatches(results, title);
  if (matches.length !== 1) {
    return { available: false, reason: matches.length ? 'Ambiguous title match' : 'No exact title match', matches: matches.length };
  }
  const units = await provider.fetchContentUnits(matches[0].id);
  return {
    available: true,
    providerId: 'anikoto',
    mediaId: matches[0].id,
    title,
    units: Array.isArray(units) ? units : []
  };
}

// Stream resolution is deliberately separate from discovery. Only call this
// for titles whose playback rights and the provider's terms you have verified.
export async function resolvePermittedUnit(unitId, language, { sdk } = {}) {
  if (process.env.ANIKOTO_DIRECT_ENABLED !== 'true') return null;
  if (!['sub', 'dub'].includes(language) || typeof unitId !== 'string' || !unitId.startsWith('anikoto:')) return null;
  const { HttpClient, AnikotoProvider } = sdk ?? await import('anime-sdk');
  const provider = new AnikotoProvider(new HttpClient({ timeoutMs: 8000 }));
  return provider.resolveStream(unitId, language);
}
