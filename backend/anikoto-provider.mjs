
/*
 * Hoshi Anikoto Provider V2.1
 * Automatic AniList and Anikoto episode matching.
 * Metadata only: no video streams or downloads.
 */

import { HttpClient, AnikotoProvider } from 'anime-sdk';

const cache = new Map();
const TTL = 30 * 60 * 1000;

function remember(key, value) {
  if (cache.size >= 100) cache.clear();
  cache.set(key, { value, expires: Date.now() + TTL });
  return value;
}

function recall(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getAniListId(series) {
  const id = String(series ?? '');
  const match = /^al([1-9]\d{0,9})$/.exec(id);
  if (match) return match[1];

  try {
    const map = JSON.parse(
      process.env.ANILIST_ID_MAP || '{}'
    );

    if (!map || typeof map !== 'object' ||
        Array.isArray(map)) return null;

    const value = Object.hasOwn(map, id)
      ? String(map[id])
      : process.env.HOSHI_SERIES_IDS_ARE_ANILIST === 'true'
        ? id : '';

    return /^[1-9]\d{0,9}$/.test(value)
      ? value : null;
  } catch {
    return null;
  }
}

export function getMappedTitle(series) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(String(series))) {
    return null;
  }

  try {
    const map = JSON.parse(
      process.env.ANIKOTO_TITLE_MAP || '{}'
    );

    if (!map || typeof map !== 'object' ||
        Array.isArray(map)) return null;

    const title = Object.hasOwn(map, series)
      ? map[series] : null;

    return typeof title === 'string' &&
      title.trim() &&
      title.length <= 150
        ? title.trim() : null;
  } catch {
    return null;
  }
}

export function matchAnime(results, title) {
  if (!Array.isArray(results)) return [];

  const wanted = normalizeTitle(title);
  if (!wanted) return [];

  return results.filter(anime => {
    const titles = [
      anime?.title,
      anime?.name,
      anime?.englishTitle,
      anime?.romajiTitle
    ];

    if (anime?.title &&
        typeof anime.title === 'object') {
      titles.push(...Object.values(anime.title));
    }

    return titles.some(value =>
      typeof value === 'string' &&
      normalizeTitle(value) === wanted
    );
  });
}

export function createAnikotoProvider() {
  return new AnikotoProvider(
    new HttpClient({ timeoutMs: 8000 })
  );
}

export async function searchAnikoto(title) {
  if (typeof title !== 'string' ||
      !title.trim() || title.length > 150) {
    return [];
  }

  return createAnikotoProvider().search(title.trim());
}

export async function fetchAniListTitles(series) {
  const id = getAniListId(series);

  if (!id) {
    return {
      available: false,
      reason: 'Invalid AniList ID',
      titles: []
    };
  }

  const key = 'titles:' + id;
  const hit = recall(key);
  if (hit) return hit;

  const query = `
    query ($id: Int!) {
      Media(id: $id, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
      }
    }
  `;

  const response = await fetch(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        query,
        variables: { id: Number(id) }
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error(
      'AniList HTTP ' + response.status
    );
  }

  const content = await response.text();

  if (content.length > 32768) {
    throw new Error('AniList response too large');
  }

  const media = JSON.parse(content)?.data?.Media;

  if (!media || String(media.id) !== id) {
    return {
      available: false,
      reason: 'Anime not found',
      titles: []
    };
  }

  const seen = new Set();
  const titles = [];

  for (const title of [
    getMappedTitle(series),
    media.title?.romaji,
    media.title?.english,
    media.title?.native
  ]) {
    if (typeof title !== 'string' ||
        !title.trim()) continue;

    const normalized = normalizeTitle(title);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    titles.push(title.trim());
  }

  return remember(key, {
    available: true,
    aniListId: id,
    titles
  });
}

export async function matchHoshiAnime(
  series,
  provider = createAnikotoProvider()
) {
  const key = 'anime:' + series;
  const hit = recall(key);
  if (hit) return hit;

  const metadata = await fetchAniListTitles(series);
  if (!metadata.available) return metadata;

  for (const title of metadata.titles) {
    const results = await provider.search(title);
    const matches = matchAnime(results, title);

    if (matches.length > 1) {
      return {
        available: false,
        reason: 'Ambiguous Anikoto match'
      };
    }

    if (matches.length === 1 &&
        matches[0]?.id) {
      return remember(key, {
        available: true,
        provider: 'anikoto',
        aniListId: metadata.aniListId,
        animeId: String(matches[0].id),
        title
      });
    }
  }

  return {
    available: false,
    reason: 'No exact Anikoto match'
  };
}

export async function matchHoshiEpisode(
  series,
  episode,
  language = 'sub',
  provider = createAnikotoProvider()
) {
  const number = Number(episode);

  if (!Number.isInteger(number) ||
      number < 1 || number > 99999 ||
      !['sub', 'dub'].includes(language)) {
    return {
      available: false,
      reason: 'Invalid episode or language'
    };
  }

  const anime = await matchHoshiAnime(
    series, provider
  );

  if (!anime.available) return anime;

  const units = await provider.fetchContentUnits(
    anime.animeId
  );

  if (!Array.isArray(units)) {
    return {
      available: false,
      reason: 'Invalid episode list'
    };
  }

  const matches = units.filter(unit =>
    Number(unit?.number) === number
  );

  if (matches.length !== 1) {
    return {
      available: false,
      reason: 'Episode missing or ambiguous'
    };
  }

  const unit = matches[0];
  const languages = Array.isArray(
    unit.availableLanguages
  ) ? unit.availableLanguages : [];

  if (languages.length &&
      !languages.includes(language)) {
    return {
      available: false,
      reason: 'Requested audio unavailable'
    };
  }

  return {
    available: true,
    provider: 'anikoto',
    aniListId: anime.aniListId,
    animeId: anime.animeId,
    episodeId: String(unit.id),
    episodeNumber: number,
    language,
    languages,
    totalEpisodes: units.length
  };
}

export async function getAnikotoEpisodes(series) {
  const provider = createAnikotoProvider();
  const anime = await matchHoshiAnime(
    series, provider
  );

  if (!anime.available) {
    return { ...anime, episodes: [] };
  }

  const units = await provider.fetchContentUnits(
    anime.animeId
  );

  return {
    ...anime,
    episodes: Array.isArray(units)
      ? units.map(unit => ({
          id: unit.id,
          number: unit.number ?? null,
          title: unit.title || '',
          languages:
            unit.availableLanguages || []
        }))
      : []
  };
}
