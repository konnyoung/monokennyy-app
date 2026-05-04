import { LASTFM_API_BASE, LASTFM_API_KEY } from './env';

interface LastFmSimilarTrack {
  name: string;
  artist: { name: string };
  match: number;
}

interface LastFmSimilarArtist {
  name: string;
  match: string;
}

async function lastfmRequest<T>(params: Record<string, string>): Promise<T> {
  const searchParams = new URLSearchParams({
    ...params,
    api_key: LASTFM_API_KEY,
    format: 'json',
  });
  const response = await fetch(`${LASTFM_API_BASE}?${searchParams.toString()}`);
  if (!response.ok) {
    throw new Error(`Last.fm API failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Get similar tracks from Last.fm for a given artist + track title.
 * Returns tracks sorted by match score.
 */
export async function getLastFmSimilarTracks(
  artist: string,
  track: string,
  limit = 20,
): Promise<Array<{ title: string; artist: string; match: number }>> {
  const data = await lastfmRequest<{
    similartracks?: { track?: LastFmSimilarTrack[] };
  }>({
    method: 'track.getSimilar',
    artist,
    track,
    limit: String(limit),
    autocorrect: '1',
  });

  return (data.similartracks?.track ?? []).map((t) => ({
    title: t.name,
    artist: t.artist.name,
    match: typeof t.match === 'number' ? t.match : Number(t.match) || 0,
  }));
}

/**
 * Get similar artists from Last.fm.
 */
export async function getLastFmSimilarArtists(
  artist: string,
  limit = 10,
): Promise<Array<{ name: string; match: number }>> {
  const data = await lastfmRequest<{
    similarartists?: { artist?: LastFmSimilarArtist[] };
  }>({
    method: 'artist.getSimilar',
    artist,
    limit: String(limit),
    autocorrect: '1',
  });

  return (data.similarartists?.artist ?? []).map((a) => ({
    name: a.name,
    match: Number(a.match) || 0,
  }));
}

/**
 * Given seed tracks (artist + title), get Last.fm similar tracks for each.
 * Returns unique recommendations with artist and title for Qobuz resolution.
 */
export async function getLastFmRecommendations(
  seeds: Array<{ artist: string; title: string }>,
  maxSeeds = 5,
  tracksPerSeed = 15,
): Promise<Array<{ title: string; artist: string; match: number }>> {
  const usedSeeds = seeds.slice(0, maxSeeds);

  const results = await Promise.allSettled(
    usedSeeds.map((seed) => getLastFmSimilarTracks(seed.artist, seed.title, tracksPerSeed)),
  );

  const seen = new Set<string>();
  const recommendations: Array<{ title: string; artist: string; match: number }> = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const track of result.value) {
      const key = `${track.artist.toLowerCase()}::${track.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recommendations.push(track);
    }
  }

  // Sort by match score descending
  return recommendations.sort((a, b) => b.match - a.match);
}
