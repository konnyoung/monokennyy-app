import type { QobuzAlbum, QobuzArtist, QobuzTrack } from './types';

const STORAGE_KEY = 'kplayer:listening-profile:v1';
const MAX_PLAYS = 240;
const MAX_RECENTS = 100;
const MAX_TRACK_SIGNALS = 360;

export interface PlayedTrack {
  id: number;
  title?: string;
  duration: number;
  hires: boolean;
  listenedAt: number;
  performer?: QobuzArtist;
  album?: QobuzAlbum;
}

export interface TrackSignal {
  id: number;
  title?: string;
  duration: number;
  hires: boolean;
  performer?: QobuzArtist;
  album?: QobuzAlbum;
  firstInteractedAt: number;
  lastInteractedAt: number;
  playCount: number;
  completionCount: number;
  skipCount: number;
  likeCount: number;
  isLiked: boolean;
  totalListenedSeconds: number;
}

export interface ListeningProfile {
  plays: PlayedTrack[];
  recents: PlayedTrack[];
  trackSignals: TrackSignal[];
}

export interface TasteEntity {
  key: string;
  name: string;
  score: number;
  playCount: number;
  completionCount: number;
  skipCount: number;
  likeCount: number;
  replayCount: number;
  lastInteractedAt: number;
}

export interface ListeningInsights {
  totalPlays: number;
  uniqueArtists: number;
  uniqueAlbums: number;
  stage: 0 | 1 | 2 | 3;
  recents: PlayedTrack[];
  topArtists: TasteEntity[];
  topAlbums: TasteEntity[];
  topTracks: TasteEntity[];
  recentArtists: TasteEntity[];
}

export interface RecommendationSeed {
  key: string;
  query: string;
  kind: 'artist' | 'album' | 'track';
  weight: number;
  source: 'taste-artist' | 'discovery-artist' | 'catalog';
}

export interface SeedResult {
  seed: RecommendationSeed;
  tracks: QobuzTrack[];
  albums: QobuzAlbum[];
  artists: QobuzArtist[];
}

export interface ArtistSection {
  artistName: string;
  tracks: QobuzTrack[];
  albums: QobuzAlbum[];
}

export interface HomeFeed {
  tracks: QobuzTrack[];
  albums: QobuzAlbum[];
  artistSections: ArtistSection[];
  recents: PlayedTrack[];
  topArtists: TasteEntity[];
  totalPlays: number;
  uniqueArtists: number;
  uniqueAlbums: number;
  stage: 0 | 1 | 2 | 3;
  seedQueries: string[];
}

type ArtistPreference = {
  key: string;
  name: string;
  affinityScore: number;
  familiarity: number;
  playCount: number;
  completionCount: number;
  skipCount: number;
  likeCount: number;
  replayCount: number;
  lastInteractedAt: number;
};

type DiversifiedCandidate<T> = {
  item: T;
  id: string | number;
  score: number;
  artistKey: string;
  artistName: string;
  primarySeedKey: string;
  isDiscovery: boolean;
  familiarity: number;
};

type TrackCandidateAccumulator = {
  track: QobuzTrack;
  score: number;
  primarySeedKey: string;
  primarySeedScore: number;
  seedCount: number;
  discoveryHits: number;
  familiarity: number;
  artistKey: string;
  artistName: string;
};

type AlbumCandidateAccumulator = {
  album: QobuzAlbum;
  score: number;
  primarySeedKey: string;
  primarySeedScore: number;
  seedCount: number;
  discoveryHits: number;
  familiarity: number;
  artistKey: string;
  artistName: string;
};

const RECOMMENDATION_NOISE_PATTERN =
  /\b(karaoke|tribute|original performed by|originally performed by|in the style of|piano version|instrumental version|tribute to)\b/i;

const SEASONAL_NOISE_PATTERN =
  /\b(christmas|xmas|jingle bell|silent night|santa claus|feliz navidad|white christmas|jingle bells|rudolph the red|frosty the snowman|auld lang syne|deck the halls|o holy night|hark the herald|away in a manger|we wish you a merry|little drummer boy|the first noel|o come all ye faithful|have yourself a merry little|let it snow|winter wonderland|carol of the bells|sleigh ride)\b/i;

export function createEmptyProfile(): ListeningProfile {
  return { plays: [], recents: [], trackSignals: [] };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function recencyWeight(listenedAt: number, now: number) {
  const ageInDays = Math.max(0, now - listenedAt) / (1000 * 60 * 60 * 24);
  return Math.max(0.35, Math.exp(-ageInDays / 18));
}

function safeTrackDuration(duration: number | undefined) {
  return Number.isFinite(duration) && Number(duration) > 0 ? Number(duration) : 180;
}

function inferHistoricalListenSeconds(duration: number | undefined) {
  return Math.max(12, Math.min(32, safeTrackDuration(duration) * 0.38));
}

function snapshotTrack(track: QobuzTrack, listenedAt: number): PlayedTrack {
  return {
    id: track.id,
    title: track.title,
    duration: safeTrackDuration(track.duration),
    hires: Boolean(track.hires),
    listenedAt,
    performer: track.performer,
    album: track.album,
  };
}

function normalizeName(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function normalizePlayedTrack(entry: PlayedTrack): PlayedTrack {
  return {
    id: entry.id,
    title: entry.title,
    duration: safeTrackDuration(entry.duration),
    hires: Boolean(entry.hires),
    listenedAt: entry.listenedAt,
    performer: entry.performer,
    album: entry.album,
  };
}

function createSignalFromTrack(track: Pick<QobuzTrack, 'id' | 'title' | 'duration' | 'hires' | 'performer' | 'album'>, interactedAt: number): TrackSignal {
  return {
    id: track.id,
    title: track.title,
    duration: safeTrackDuration(track.duration),
    hires: Boolean(track.hires),
    performer: track.performer,
    album: track.album,
    firstInteractedAt: interactedAt,
    lastInteractedAt: interactedAt,
    playCount: 0,
    completionCount: 0,
    skipCount: 0,
    likeCount: 0,
    isLiked: false,
    totalListenedSeconds: 0,
  };
}

function normalizeTrackSignal(entry: TrackSignal): TrackSignal {
  const firstInteractedAt = Number.isFinite(entry.firstInteractedAt) ? entry.firstInteractedAt : entry.lastInteractedAt;
  const lastInteractedAt = Number.isFinite(entry.lastInteractedAt) ? entry.lastInteractedAt : firstInteractedAt;

  return {
    id: entry.id,
    title: entry.title,
    duration: safeTrackDuration(entry.duration),
    hires: Boolean(entry.hires),
    performer: entry.performer,
    album: entry.album,
    firstInteractedAt: Math.min(firstInteractedAt, lastInteractedAt),
    lastInteractedAt: Math.max(firstInteractedAt, lastInteractedAt),
    playCount: Math.max(0, Math.floor(entry.playCount ?? 0)),
    completionCount: Math.max(0, Math.floor(entry.completionCount ?? 0)),
    skipCount: Math.max(0, Math.floor(entry.skipCount ?? 0)),
    likeCount: Math.max(0, Math.floor(entry.likeCount ?? 0)),
    isLiked: Boolean(entry.isLiked ?? (entry.likeCount ?? 0) > 0),
    totalListenedSeconds: Math.max(0, Number(entry.totalListenedSeconds ?? 0)),
  };
}

function signalRetentionScore(signal: TrackSignal, now: number) {
  const recency = recencyWeight(signal.lastInteractedAt, now);
  const replayCount = Math.max(0, signal.playCount - 1);
  return (
    recency *
      (signal.playCount + signal.completionCount * 1.35 + signal.likeCount * 2.9 + replayCount * 0.45 + (signal.isLiked ? 1.5 : 0)) -
    signal.skipCount * 0.6
  );
}

function buildHistoricalTrackSignals(plays: PlayedTrack[]) {
  const signalMap = new Map<number, TrackSignal>();

  for (const play of plays) {
    const current = signalMap.get(play.id) ?? createSignalFromTrack(play, play.listenedAt);
    current.playCount += 1;
    current.totalListenedSeconds += inferHistoricalListenSeconds(play.duration);
    current.firstInteractedAt = Math.min(current.firstInteractedAt, play.listenedAt);
    current.lastInteractedAt = Math.max(current.lastInteractedAt, play.listenedAt);
    current.title = play.title ?? current.title;
    current.performer = play.performer ?? current.performer;
    current.album = play.album ?? current.album;
    signalMap.set(play.id, current);
  }

  return [...signalMap.values()].map(normalizeTrackSignal);
}

function normalizeProfile(profile: Partial<ListeningProfile> | ListeningProfile | undefined): ListeningProfile {
  const plays = Array.isArray(profile?.plays)
    ? profile.plays
        .filter((entry): entry is PlayedTrack => typeof entry?.id === 'number' && typeof entry.listenedAt === 'number')
        .map(normalizePlayedTrack)
        .sort((left, right) => right.listenedAt - left.listenedAt)
        .slice(0, MAX_PLAYS)
    : [];

  const recentsSource = Array.isArray(profile?.recents) && profile.recents.length > 0 ? profile.recents : plays;
  const recents = recentsSource
    .filter((entry): entry is PlayedTrack => typeof entry?.id === 'number' && typeof entry.listenedAt === 'number')
    .map(normalizePlayedTrack)
    .sort((left, right) => right.listenedAt - left.listenedAt)
    .slice(0, MAX_RECENTS);

  const rawSignals = Array.isArray(profile?.trackSignals) ? profile.trackSignals.map(normalizeTrackSignal) : buildHistoricalTrackSignals(plays);
  const now = Date.now();

  return {
    plays,
    recents,
    trackSignals: rawSignals
      .sort(
        (left, right) =>
          signalRetentionScore(right, now) - signalRetentionScore(left, now) || right.lastInteractedAt - left.lastInteractedAt,
      )
      .slice(0, MAX_TRACK_SIGNALS),
  };
}

function updateTrackSignal(
  profile: ListeningProfile,
  track: QobuzTrack,
  interactedAt: number,
  updater: (signal: TrackSignal) => TrackSignal,
) {
  const signalMap = new Map(profile.trackSignals.map((signal) => [signal.id, signal]));
  const baseSignal = normalizeTrackSignal(signalMap.get(track.id) ?? createSignalFromTrack(track, interactedAt));
  const mergedSignal = normalizeTrackSignal(
    updater({
      ...baseSignal,
      title: track.title ?? baseSignal.title,
      duration: safeTrackDuration(track.duration),
      hires: Boolean(track.hires),
      performer: track.performer ?? baseSignal.performer,
      album: track.album ?? baseSignal.album,
      firstInteractedAt: Math.min(baseSignal.firstInteractedAt, interactedAt),
      lastInteractedAt: Math.max(baseSignal.lastInteractedAt, interactedAt),
    }),
  );

  signalMap.set(track.id, mergedSignal);
  return normalizeProfile({
    ...profile,
    trackSignals: [...signalMap.values()],
  });
}

function getArtistKeyAndName(trackLike: {
  performer?: QobuzArtist;
  album?: QobuzAlbum;
}) {
  const artistName = trackLike.performer?.name ?? trackLike.album?.artist?.name;
  const artistId = trackLike.performer?.id ?? trackLike.album?.artist?.id;
  return {
    key: String(artistId ?? artistName ?? ''),
    name: artistName,
  };
}

function addTasteScore(
  bucket: Map<string, TasteEntity>,
  key: string | undefined,
  name: string | undefined,
  increment: number,
  details?: Partial<Omit<TasteEntity, 'key' | 'name' | 'score'>>,
) {
  if (!key || !name) {
    return;
  }

  const current = bucket.get(key);
  if (current) {
    current.score += increment;
    current.playCount += details?.playCount ?? 0;
    current.completionCount += details?.completionCount ?? 0;
    current.skipCount += details?.skipCount ?? 0;
    current.likeCount += details?.likeCount ?? 0;
    current.replayCount += details?.replayCount ?? 0;
    current.lastInteractedAt = Math.max(current.lastInteractedAt, details?.lastInteractedAt ?? 0);
    return;
  }

  bucket.set(key, {
    key,
    name,
    score: increment,
    playCount: details?.playCount ?? 0,
    completionCount: details?.completionCount ?? 0,
    skipCount: details?.skipCount ?? 0,
    likeCount: details?.likeCount ?? 0,
    replayCount: details?.replayCount ?? 0,
    lastInteractedAt: details?.lastInteractedAt ?? 0,
  });
}

function rankTasteEntities(bucket: Map<string, TasteEntity>, limit: number) {
  return [...bucket.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.likeCount - left.likeCount ||
        right.completionCount - left.completionCount ||
        right.playCount - left.playCount ||
        right.lastInteractedAt - left.lastInteractedAt ||
        left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

function isNoisyTrackRecommendation(track: QobuzTrack) {
  const haystack = [track.title, track.album?.title]
    .filter(Boolean)
    .join(' ');

  return RECOMMENDATION_NOISE_PATTERN.test(haystack) || SEASONAL_NOISE_PATTERN.test(haystack);
}

function isNoisyAlbumRecommendation(album: QobuzAlbum) {
  const haystack = [album.title, album.label?.name].filter(Boolean).join(' ');
  return RECOMMENDATION_NOISE_PATTERN.test(haystack) || SEASONAL_NOISE_PATTERN.test(haystack);
}

function getTrackArtistKey(track: QobuzTrack) {
  const artistId = track.performer?.id ?? track.album?.artist?.id;
  if (typeof artistId === 'number') {
    return `artist:${artistId}`;
  }

  const artistName = normalizeName(track.performer?.name ?? track.album?.artist?.name);
  return artistName ? `artist:${artistName}` : `track:${track.id}`;
}

function getAlbumArtistKey(album: QobuzAlbum) {
  if (typeof album.artist?.id === 'number') {
    return `artist:${album.artist.id}`;
  }

  const artistName = normalizeName(album.artist?.name);
  return artistName ? `artist:${artistName}` : `album:${String(album.id ?? album.title ?? 'unknown')}`;
}

function buildArtistPreferences(profile: ListeningProfile, now = Date.now()) {
  const bucket = new Map<string, ArtistPreference>();

  for (const signal of profile.trackSignals) {
    const artistName = signal.performer?.name ?? signal.album?.artist?.name;
    const normalizedArtistName = normalizeName(artistName);
    if (!normalizedArtistName || !artistName) {
      continue;
    }

    const recency = recencyWeight(signal.lastInteractedAt, now);
    const replayCount = Math.max(0, signal.playCount - 1);
    const positive =
      signal.playCount * 1.05 +
      signal.completionCount * 1.8 +
      signal.likeCount * 3.4 +
      replayCount * 0.65 +
      Math.min(2.6, signal.totalListenedSeconds / safeTrackDuration(signal.duration)) * 0.42 +
      (signal.isLiked ? 1.1 : 0);
    const negative = signal.skipCount * 1.7;
    const affinityDelta = recency * (positive - negative);
    const familiarityDelta =
      recency * (signal.playCount + signal.completionCount * 0.85 + replayCount * 0.45 + (signal.isLiked ? 0.55 : 0));

    const current = bucket.get(normalizedArtistName);
    if (current) {
      current.affinityScore += affinityDelta;
      current.familiarity += familiarityDelta;
      current.playCount += signal.playCount;
      current.completionCount += signal.completionCount;
      current.skipCount += signal.skipCount;
      current.likeCount += signal.likeCount;
      current.replayCount += replayCount;
      current.lastInteractedAt = Math.max(current.lastInteractedAt, signal.lastInteractedAt);
      continue;
    }

    bucket.set(normalizedArtistName, {
      key: normalizedArtistName,
      name: artistName,
      affinityScore: affinityDelta,
      familiarity: familiarityDelta,
      playCount: signal.playCount,
      completionCount: signal.completionCount,
      skipCount: signal.skipCount,
      likeCount: signal.likeCount,
      replayCount,
      lastInteractedAt: signal.lastInteractedAt,
    });
  }

  return bucket;
}

function selectDiversifiedCandidates<T>(entries: DiversifiedCandidate<T>[], limit: number, targetDiscoveryRatio: number) {
  const remaining = [...entries].sort((left, right) => right.score - left.score || left.artistName.localeCompare(right.artistName));
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  const seedCounts = new Map<string, number>();
  let discoveryCount = 0;

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index];
      const idKey = String(entry.id);
      if (selectedIds.has(idKey)) {
        continue;
      }

      const artistReuseCount = artistCounts.get(entry.artistKey) ?? 0;
      const artistReusePenalty =
        artistReuseCount === 0
          ? 0
          : artistReuseCount === 1
            ? 1.9
            : 4.2 + (artistReuseCount - 2) * 1.8;
      const seedReusePenalty = (seedCounts.get(entry.primarySeedKey) ?? 0) * 0.34;
      const currentDiscoveryRatio = selected.length === 0 ? 0 : discoveryCount / selected.length;
      const discoveryAdjustment = entry.isDiscovery
        ? currentDiscoveryRatio < targetDiscoveryRatio
          ? 0.78
          : 0.16
        : currentDiscoveryRatio < targetDiscoveryRatio
          ? -0.42
          : 0.12;
      const oversaturatedPenalty = Math.max(0, entry.familiarity - 1.05) * 0.35;
      const adjustedScore = entry.score - artistReusePenalty - seedReusePenalty - oversaturatedPenalty + discoveryAdjustment;

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    const [selectedEntry] = remaining.splice(bestIndex, 1);
    selected.push(selectedEntry.item);
    selectedIds.add(String(selectedEntry.id));
    artistCounts.set(selectedEntry.artistKey, (artistCounts.get(selectedEntry.artistKey) ?? 0) + 1);
    seedCounts.set(selectedEntry.primarySeedKey, (seedCounts.get(selectedEntry.primarySeedKey) ?? 0) + 1);
    if (selectedEntry.isDiscovery) {
      discoveryCount += 1;
    }
  }

  return selected;
}

function storeTrackCandidate(
  bucket: Map<number, TrackCandidateAccumulator>,
  track: QobuzTrack,
  seed: RecommendationSeed,
  score: number,
  isDiscovery: boolean,
  familiarity: number,
) {
  const artistKey = getTrackArtistKey(track);
  const artistName = track.performer?.name ?? track.album?.artist?.name ?? 'Unknown artist';
  const current = bucket.get(track.id);

  if (!current) {
    bucket.set(track.id, {
      track,
      score,
      primarySeedKey: seed.key,
      primarySeedScore: score,
      seedCount: 1,
      discoveryHits: isDiscovery ? 1 : 0,
      familiarity,
      artistKey,
      artistName,
    });
    return;
  }

  current.score += score * 0.62;
  current.seedCount += 1;
  current.discoveryHits += isDiscovery ? 1 : 0;
  current.familiarity = Math.max(current.familiarity, familiarity);
  if (score > current.primarySeedScore) {
    current.primarySeedScore = score;
    current.primarySeedKey = seed.key;
  }
}

function storeAlbumCandidate(
  bucket: Map<string, AlbumCandidateAccumulator>,
  album: QobuzAlbum,
  seed: RecommendationSeed,
  score: number,
  isDiscovery: boolean,
  familiarity: number,
) {
  if (!album.id) {
    return;
  }

  const artistKey = getAlbumArtistKey(album);
  const artistName = album.artist?.name ?? 'Unknown artist';
  const current = bucket.get(album.id);

  if (!current) {
    bucket.set(album.id, {
      album,
      score,
      primarySeedKey: seed.key,
      primarySeedScore: score,
      seedCount: 1,
      discoveryHits: isDiscovery ? 1 : 0,
      familiarity,
      artistKey,
      artistName,
    });
    return;
  }

  current.score += score * 0.64;
  current.seedCount += 1;
  current.discoveryHits += isDiscovery ? 1 : 0;
  current.familiarity = Math.max(current.familiarity, familiarity);
  if (score > current.primarySeedScore) {
    current.primarySeedScore = score;
    current.primarySeedKey = seed.key;
  }
}

export function loadListeningProfile(): ListeningProfile {
  if (typeof localStorage === 'undefined') {
    return createEmptyProfile();
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createEmptyProfile();
    }

    return normalizeProfile(JSON.parse(raw) as Partial<ListeningProfile>);
  } catch {
    return createEmptyProfile();
  }
}

export function saveListeningProfile(profile: ListeningProfile) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeProfile(profile)));
  } catch {
    // Ignore storage failures and keep the UI responsive.
  }
}

export function recordListen(
  profile: ListeningProfile,
  track: QobuzTrack,
  listenedAt = Date.now(),
  listenedSeconds = inferHistoricalListenSeconds(track.duration),
): ListeningProfile {
  const normalizedProfile = normalizeProfile(profile);
  const nextPlay = snapshotTrack(track, listenedAt);
  const latestPlay = normalizedProfile.plays[0];
  const duplicateRecentPlay = latestPlay && latestPlay.id === track.id && listenedAt - latestPlay.listenedAt < 90_000;

  const plays = duplicateRecentPlay
    ? [{ ...latestPlay, listenedAt }, ...normalizedProfile.plays.slice(1)]
    : [nextPlay, ...normalizedProfile.plays].slice(0, MAX_PLAYS);

  return updateTrackSignal(
    {
      ...normalizedProfile,
      plays,
    },
    track,
    listenedAt,
    (signal) => ({
      ...signal,
      playCount: duplicateRecentPlay ? signal.playCount : signal.playCount + 1,
      totalListenedSeconds: duplicateRecentPlay
        ? signal.totalListenedSeconds
        : signal.totalListenedSeconds + Math.max(0, listenedSeconds),
    }),
  );
}

export function recordRecentPlayback(profile: ListeningProfile, track: QobuzTrack, listenedAt = Date.now()): ListeningProfile {
  const normalizedProfile = normalizeProfile(profile);
  const nextPlay = snapshotTrack(track, listenedAt);
  const latestRecent = normalizedProfile.recents[0];
  const duplicateRecentPlay = latestRecent && latestRecent.id === track.id && listenedAt - latestRecent.listenedAt < 90_000;

  const recents = duplicateRecentPlay
    ? [{ ...latestRecent, listenedAt }, ...normalizedProfile.recents.slice(1)]
    : [nextPlay, ...normalizedProfile.recents].slice(0, MAX_RECENTS);

  return normalizeProfile({
    ...normalizedProfile,
    recents,
  });
}

export function recordTrackCompletion(
  profile: ListeningProfile,
  track: QobuzTrack,
  completedAt = Date.now(),
  additionalListenedSeconds = Math.max(0, safeTrackDuration(track.duration) * 0.67),
) {
  return updateTrackSignal(normalizeProfile(profile), track, completedAt, (signal) => ({
    ...signal,
    completionCount: signal.completionCount + 1,
    totalListenedSeconds: signal.totalListenedSeconds + Math.max(0, additionalListenedSeconds),
  }));
}

export function recordTrackSkip(
  profile: ListeningProfile,
  track: QobuzTrack,
  skippedAt = Date.now(),
  listenedSeconds = 0,
) {
  return updateTrackSignal(normalizeProfile(profile), track, skippedAt, (signal) => ({
    ...signal,
    skipCount: signal.skipCount + 1,
    totalListenedSeconds: signal.totalListenedSeconds + Math.max(0, listenedSeconds),
  }));
}

export function toggleTrackLike(profile: ListeningProfile, track: QobuzTrack, likedAt = Date.now()) {
  const normalizedProfile = normalizeProfile(profile);
  const currentSignal = normalizedProfile.trackSignals.find((signal) => signal.id === track.id);
  const nextLikedState = !currentSignal?.isLiked;

  return updateTrackSignal(normalizedProfile, track, likedAt, (signal) => ({
    ...signal,
    isLiked: nextLikedState,
    likeCount: nextLikedState ? signal.likeCount + 1 : signal.likeCount,
  }));
}

export function isTrackLiked(profile: ListeningProfile, trackId: number) {
  return normalizeProfile(profile).trackSignals.some((signal) => signal.id === trackId && signal.isLiked);
}

export function buildListeningInsights(profile: ListeningProfile, now = Date.now()): ListeningInsights {
  const normalizedProfile = normalizeProfile(profile);
  const artistBucket = new Map<string, TasteEntity>();
  const albumBucket = new Map<string, TasteEntity>();
  const trackBucket = new Map<string, TasteEntity>();
  const recentArtistBucket = new Map<string, TasteEntity>();

  for (const play of normalizedProfile.plays) {
    const weight = recencyWeight(play.listenedAt, now);
    const artist = getArtistKeyAndName(play);
    addTasteScore(artistBucket, artist.key, artist.name, weight * 0.55, {
      playCount: 1,
      lastInteractedAt: play.listenedAt,
    });
    addTasteScore(albumBucket, String(play.album?.id ?? play.album?.title ?? ''), play.album?.title, weight * 0.4, {
      playCount: 1,
      lastInteractedAt: play.listenedAt,
    });
    addTasteScore(trackBucket, String(play.id), play.title, weight * 0.35, {
      playCount: 1,
      lastInteractedAt: play.listenedAt,
    });

    if (now - play.listenedAt <= 1000 * 60 * 60 * 24 * 10) {
      addTasteScore(recentArtistBucket, artist.key, artist.name, weight * 1.15, {
        playCount: 1,
        lastInteractedAt: play.listenedAt,
      });
    }
  }

  for (const signal of normalizedProfile.trackSignals) {
    const recency = recencyWeight(signal.lastInteractedAt, now);
    const replayCount = Math.max(0, signal.playCount - 1);
    const positiveSignal =
      signal.playCount * 1.05 +
      signal.completionCount * 1.8 +
      signal.likeCount * 3.5 +
      replayCount * 0.55 +
      Math.min(2.5, signal.totalListenedSeconds / safeTrackDuration(signal.duration)) * 0.4 +
      (signal.isLiked ? 0.9 : 0);
    const negativeSignal = signal.skipCount * 1.7;
    const netSignal = recency * (positiveSignal - negativeSignal);
    const artist = getArtistKeyAndName(signal);

    addTasteScore(artistBucket, artist.key, artist.name, netSignal * 1.45, {
      playCount: signal.playCount,
      completionCount: signal.completionCount,
      skipCount: signal.skipCount,
      likeCount: signal.likeCount,
      replayCount,
      lastInteractedAt: signal.lastInteractedAt,
    });

    addTasteScore(albumBucket, String(signal.album?.id ?? signal.album?.title ?? ''), signal.album?.title, netSignal * 1.15, {
      playCount: signal.playCount,
      completionCount: signal.completionCount,
      skipCount: signal.skipCount,
      likeCount: signal.likeCount,
      replayCount,
      lastInteractedAt: signal.lastInteractedAt,
    });

    addTasteScore(trackBucket, String(signal.id), signal.title, netSignal * 1.05, {
      playCount: signal.playCount,
      completionCount: signal.completionCount,
      skipCount: signal.skipCount,
      likeCount: signal.likeCount,
      replayCount,
      lastInteractedAt: signal.lastInteractedAt,
    });

    if (now - signal.lastInteractedAt <= 1000 * 60 * 60 * 24 * 10) {
      addTasteScore(
        recentArtistBucket,
        artist.key,
        artist.name,
        recency * (signal.playCount * 0.8 + signal.completionCount * 1.1 + signal.likeCount * 1.5),
        {
          playCount: signal.playCount,
          completionCount: signal.completionCount,
          skipCount: signal.skipCount,
          likeCount: signal.likeCount,
          replayCount,
          lastInteractedAt: signal.lastInteractedAt,
        },
      );
    }
  }

  const positiveInteractions = normalizedProfile.trackSignals.reduce(
    (total, signal) => total + signal.playCount + signal.completionCount + signal.likeCount * 2,
    0,
  );
  const totalPlays = normalizedProfile.plays.length;
  const stage: ListeningInsights['stage'] =
    positiveInteractions >= 22 || totalPlays >= 18 ? 3 : positiveInteractions >= 8 || totalPlays >= 5 ? 2 : totalPlays >= 1 ? 1 : 0;

  // Deduplicate recents by track id, keeping only the most recent play
  const seenTrackIds = new Set<number>();
  const uniqueRecents: typeof normalizedProfile.recents = [];
  for (const entry of normalizedProfile.recents) {
    if (!seenTrackIds.has(entry.id)) {
      seenTrackIds.add(entry.id);
      uniqueRecents.push(entry);
    }
    if (uniqueRecents.length >= 8) break;
  }

  return {
    totalPlays,
    uniqueArtists: artistBucket.size,
    uniqueAlbums: albumBucket.size,
    stage,
    recents: uniqueRecents,
    topArtists: rankTasteEntities(artistBucket, 8),
    topAlbums: rankTasteEntities(albumBucket, 8),
    topTracks: rankTasteEntities(trackBucket, 8),
    recentArtists: rankTasteEntities(recentArtistBucket, 5),
  };
}

export function buildRecommendationSeeds(insights: ListeningInsights): RecommendationSeed[] {
  const seeds = new Map<string, RecommendationSeed>();

  const pushSeed = (seed: RecommendationSeed) => {
    const existing = seeds.get(seed.key);
    if (existing) {
      existing.weight = Math.max(existing.weight, seed.weight);
      return;
    }

    seeds.set(seed.key, seed);
  };

  insights.topArtists.forEach((artist, index) => {
    const strengthBoost = Math.min(2.8, artist.likeCount * 0.55 + artist.completionCount * 0.12 + artist.replayCount * 0.18);
    pushSeed({
      key: `artist:${artist.key}`,
      query: artist.name,
      kind: 'artist',
      weight: 8.8 - index * 0.72 + strengthBoost,
      source: 'taste-artist',
    });
  });

  insights.recentArtists.forEach((artist, index) => {
    pushSeed({
      key: `recent-artist:${artist.key}`,
      query: artist.name,
      kind: 'artist',
      weight: 6.2 - index * 0.48 + Math.min(1.2, artist.likeCount * 0.25 + artist.completionCount * 0.08),
      source: 'taste-artist',
    });
  });

  const maxSeeds = insights.stage >= 3 ? 10 : insights.stage >= 2 ? 6 : 3;
  return [...seeds.values()]
    .filter((seed) => seed.query.trim().length > 0)
    .sort((left, right) => right.weight - left.weight || left.query.localeCompare(right.query))
    .slice(0, maxSeeds);
}

export function buildHomeFeed(profile: ListeningProfile, seedResults: SeedResult[]): HomeFeed {
  const normalizedProfile = normalizeProfile(profile);
  const insights = buildListeningInsights(normalizedProfile);
  const listenedTrackIds = new Set(normalizedProfile.plays.map((play) => play.id));
  const listenedAlbumIds = new Set(normalizedProfile.plays.map((play) => play.album?.id).filter(Boolean));
  const likedTrackIds = new Set(
    normalizedProfile.trackSignals.filter((signal) => signal.isLiked).map((signal) => signal.id),
  );
  const listenedArtistNames = new Set(
    [
      ...normalizedProfile.plays.map((play) => normalizeName(play.performer?.name ?? play.album?.artist?.name)),
      ...normalizedProfile.trackSignals.map((signal) => normalizeName(signal.performer?.name ?? signal.album?.artist?.name)),
    ].filter((name) => name.length > 0),
  );

  const artistPreferences = buildArtistPreferences(normalizedProfile);
  const maxAffinity = Math.max(1, ...[...artistPreferences.values()].map((artist) => Math.max(0, artist.affinityScore)));
  const maxFamiliarity = Math.max(1, ...[...artistPreferences.values()].map((artist) => artist.familiarity));
  const artistBreadth = insights.totalPlays > 0 ? insights.uniqueArtists / insights.totalPlays : 0;
  const explorationAppetite = clamp(0.35 + artistBreadth * 2.1 + (insights.recentArtists.length / 5) * 0.45, 0.35, 1.3);

  const trackCandidates = new Map<number, TrackCandidateAccumulator>();
  const albumCandidates = new Map<string, AlbumCandidateAccumulator>();

  seedResults.forEach(({ seed, tracks, albums }) => {
    tracks.forEach((track, index) => {
      if (listenedTrackIds.has(track.id) || likedTrackIds.has(track.id) || isNoisyTrackRecommendation(track)) {
        return;
      }

      const artistName = track.performer?.name ?? track.album?.artist?.name;
      const normalizedArtistName = normalizeName(artistName);
      const artistPreference = artistPreferences.get(normalizedArtistName);
      const familiarity = artistPreference ? artistPreference.familiarity / maxFamiliarity : 0;
      const affinity = artistPreference ? clamp(artistPreference.affinityScore / maxAffinity, -0.9, 1.6) : 0;
      const completionRate = artistPreference
        ? artistPreference.completionCount / Math.max(1, artistPreference.playCount + artistPreference.completionCount)
        : 0;
      const skipRate = artistPreference
        ? artistPreference.skipCount /
          Math.max(1, artistPreference.playCount + artistPreference.completionCount + artistPreference.skipCount)
        : 0;
      const replayRate = artistPreference ? artistPreference.replayCount / Math.max(1, artistPreference.playCount) : 0;
      const isKnownArtist = normalizedArtistName.length > 0 && listenedArtistNames.has(normalizedArtistName);
      const isDiscoveryCandidate = seed.source === 'discovery-artist' || !isKnownArtist;

      // Penalize tracks that don't match the seed artist in taste-artist searches
      // (Qobuz search returns unrelated tracks that happen to match query text)
      const normalizedSeedQuery = normalizeName(seed.query);
      const trackMatchesSeedArtist = seed.kind === 'artist' && normalizedArtistName.length > 0 &&
        (normalizedArtistName === normalizedSeedQuery || normalizedArtistName.includes(normalizedSeedQuery) || normalizedSeedQuery.includes(normalizedArtistName));
      const seedArtistMismatchPenalty = seed.source === 'taste-artist' && !trackMatchesSeedArtist && !isKnownArtist
        ? seed.weight * 0.7
        : 0;

      const discoveryBonus = isDiscoveryCandidate
        ? 0.6 + explorationAppetite * 0.3 + Math.max(0, 0.2 - familiarity)
        : 0.12;
      const comfortBonus = isDiscoveryCandidate
        ? 0
        : 0.3 + affinity * 0.45 + completionRate * 0.5 + (artistPreference?.likeCount ?? 0) * 0.12;
      const oversaturationPenalty = isDiscoveryCandidate ? 0 : Math.max(0, familiarity - 0.95) * 1.05;
      const skipPenalty = skipRate * 1.5;
      const nextScore =
        seed.weight * 1.7 -
        index * 0.075 +
        discoveryBonus +
        comfortBonus +
        affinity * 0.55 +
        replayRate * 0.35 +
        (track.hires ? 0.12 : 0) -
        skipPenalty -
        oversaturationPenalty -
        seedArtistMismatchPenalty;

      storeTrackCandidate(trackCandidates, track, seed, nextScore, isDiscoveryCandidate, familiarity);
    });

    albums.forEach((album, index) => {
      if (!album.id || listenedAlbumIds.has(album.id) || isNoisyAlbumRecommendation(album)) {
        return;
      }

      const normalizedArtistName = normalizeName(album.artist?.name);
      const artistPreference = artistPreferences.get(normalizedArtistName);
      const familiarity = artistPreference ? artistPreference.familiarity / maxFamiliarity : 0;
      const affinity = artistPreference ? clamp(artistPreference.affinityScore / maxAffinity, -0.9, 1.6) : 0;
      const completionRate = artistPreference
        ? artistPreference.completionCount / Math.max(1, artistPreference.playCount + artistPreference.completionCount)
        : 0;
      const skipRate = artistPreference
        ? artistPreference.skipCount /
          Math.max(1, artistPreference.playCount + artistPreference.completionCount + artistPreference.skipCount)
        : 0;
      const isKnownArtist = normalizedArtistName.length > 0 && listenedArtistNames.has(normalizedArtistName);
      const isDiscoveryCandidate = seed.source === 'discovery-artist' || !isKnownArtist;

      // Penalize albums that don't match the seed artist in taste-artist searches
      const normalizedSeedQuery = normalizeName(seed.query);
      const albumMatchesSeedArtist = seed.kind === 'artist' && normalizedArtistName.length > 0 &&
        (normalizedArtistName === normalizedSeedQuery || normalizedArtistName.includes(normalizedSeedQuery) || normalizedSeedQuery.includes(normalizedArtistName));
      const seedArtistMismatchPenalty = seed.source === 'taste-artist' && !albumMatchesSeedArtist && !isKnownArtist
        ? seed.weight * 0.65
        : 0;

      const discoveryBonus = isDiscoveryCandidate ? 0.8 + explorationAppetite * 0.3 : 0.08;
      const comfortBonus = isDiscoveryCandidate
        ? 0
        : 0.2 + affinity * 0.28 + completionRate * 0.32 + (artistPreference?.likeCount ?? 0) * 0.06;
      const oversaturationPenalty = isDiscoveryCandidate ? 0 : Math.max(0, familiarity - 0.95) * 0.88;
      const skipPenalty = skipRate * 1.25;
      const nextScore =
        seed.weight * 1.45 -
        index * 0.068 +
        discoveryBonus +
        comfortBonus +
        affinity * 0.42 +
        (album.hires ? 0.12 : 0) -
        skipPenalty -
        oversaturationPenalty -
        seedArtistMismatchPenalty;

      storeAlbumCandidate(albumCandidates, album, seed, nextScore, isDiscoveryCandidate, familiarity);
    });
  });

  const trackLimit = insights.stage >= 3 ? 18 : insights.stage >= 2 ? 12 : 9;
  const albumLimit = insights.stage >= 3 ? 12 : insights.stage >= 2 ? 8 : 4;

  const rankedTracks = selectDiversifiedCandidates(
    [...trackCandidates.values()]
      .map((candidate) => ({
        item: candidate.track,
        id: candidate.track.id,
        score: candidate.score + candidate.seedCount * 0.28 + candidate.discoveryHits * 0.18,
        artistKey: candidate.artistKey,
        artistName: candidate.artistName,
        primarySeedKey: candidate.primarySeedKey,
        isDiscovery:
          candidate.discoveryHits * 2 >= candidate.seedCount ||
          !listenedArtistNames.has(normalizeName(candidate.artistName)),
        familiarity: candidate.familiarity,
      }))
      .sort((left, right) => right.score - left.score || left.artistName.localeCompare(right.artistName)),
    trackLimit,
    insights.stage >= 3 ? 0.45 : insights.stage >= 2 ? 0.35 : 0.25,
  );

  const rankedAlbums = selectDiversifiedCandidates(
    [...albumCandidates.values()]
      .map((candidate) => ({
        item: candidate.album,
        id: candidate.album.id ?? candidate.album.title ?? candidate.artistName,
        score: candidate.score + candidate.seedCount * 0.22 + candidate.discoveryHits * 0.14,
        artistKey: candidate.artistKey,
        artistName: candidate.artistName,
        primarySeedKey: candidate.primarySeedKey,
        isDiscovery:
          candidate.discoveryHits * 2 >= candidate.seedCount ||
          !listenedArtistNames.has(normalizeName(candidate.artistName)),
        familiarity: candidate.familiarity,
      }))
      .sort((left, right) => right.score - left.score || left.artistName.localeCompare(right.artistName)),
    albumLimit,
    insights.stage >= 3 ? 0.4 : insights.stage >= 2 ? 0.3 : 0.2,
  );

  const artistSectionMap = new Map<string, { tracks: QobuzTrack[]; albums: QobuzAlbum[] }>();
  seedResults.forEach(({ seed, tracks, albums }) => {
    if (seed.kind !== 'artist' || seed.source !== 'taste-artist') {
      return;
    }

    const normalizedSeedName = normalizeName(seed.query);
    const existing = artistSectionMap.get(seed.query) ?? { tracks: [], albums: [] };

    for (const track of tracks) {
      if (existing.tracks.length >= 6) {
        break;
      }

      const normalizedTrackArtist = normalizeName(track.performer?.name ?? track.album?.artist?.name);
      if (listenedTrackIds.has(track.id) || likedTrackIds.has(track.id) || isNoisyTrackRecommendation(track)) {
        continue;
      }
      if (normalizedTrackArtist !== normalizedSeedName) {
        continue;
      }
      if (!existing.tracks.some((entry) => entry.id === track.id)) {
        existing.tracks.push(track);
      }
    }

    for (const album of albums) {
      if (existing.albums.length >= 4) {
        break;
      }

      if (!album.id || listenedAlbumIds.has(album.id) || isNoisyAlbumRecommendation(album)) {
        continue;
      }
      if (normalizeName(album.artist?.name) !== normalizedSeedName) {
        continue;
      }
      if (!existing.albums.some((entry) => entry.id === album.id)) {
        existing.albums.push(album);
      }
    }

    artistSectionMap.set(seed.query, existing);
  });

  const artistSections: ArtistSection[] = [...artistSectionMap.entries()]
    .filter(([, data]) => data.tracks.length > 0 || data.albums.length > 0)
    .map(([artistName, data]) => ({ artistName, tracks: data.tracks, albums: data.albums }))
    .slice(0, insights.stage >= 3 ? 3 : 2);

  return {
    tracks: rankedTracks,
    albums: rankedAlbums,
    artistSections,
    recents: insights.recents,
    topArtists: insights.topArtists,
    totalPlays: insights.totalPlays,
    uniqueArtists: insights.uniqueArtists,
    uniqueAlbums: insights.uniqueAlbums,
    stage: insights.stage,
    seedQueries: seedResults.map(({ seed }) => seed.query),
  };
}
