import { PB_URL, pb } from './pb';
import type { PlayedTrack, TrackSignal } from './listening-profile';

// ---------------------------------------------------------------------------
// Helpers — single record per user per collection
// ---------------------------------------------------------------------------

function getAuthContext() {
  if (!pb.authStore.isValid || !pb.authStore.record || !pb.authStore.token) {
    return null;
  }
  return { token: pb.authStore.token, userId: pb.authStore.record.id };
}

interface RecordItem<T> {
  id: string;
  user: string;
  data?: T;
}

async function pullSingleRecord<T>(collection: string): Promise<T | null> {
  const auth = getAuthContext();
  if (!auth) return null;

  const url = new URL(`${PB_URL}/api/collections/${collection}/records`);
  url.searchParams.set('perPage', '1');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  if (!res.ok) return null;

  const payload = (await res.json()) as { items?: RecordItem<T>[] };
  return payload.items?.[0]?.data ?? null;
}

async function pushSingleRecord<T>(collection: string, data: T): Promise<void> {
  const auth = getAuthContext();
  if (!auth) return;

  const url = new URL(`${PB_URL}/api/collections/${collection}/records`);
  url.searchParams.set('perPage', '1');

  const listRes = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  if (!listRes.ok) return;

  const payload = (await listRes.json()) as { items?: RecordItem<T>[] };
  const existing = payload.items?.[0];

  const body = JSON.stringify({ user: auth.userId, data });

  if (existing) {
    await fetch(`${PB_URL}/api/collections/${collection}/records/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body,
    });
  } else {
    await fetch(`${PB_URL}/api/collections/${collection}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// Recents — kplayer_recents: { user, data: PlayedTrack[] }
// ---------------------------------------------------------------------------

export async function pullRecentsFromRemote(): Promise<PlayedTrack[]> {
  const data = await pullSingleRecord<PlayedTrack[]>('kplayer_recents');
  return Array.isArray(data) ? data : [];
}

export async function pushRecentsToRemote(recents: PlayedTrack[]): Promise<void> {
  await pushSingleRecord('kplayer_recents', recents.slice(0, 100));
}

// ---------------------------------------------------------------------------
// Liked tracks — kplayer_liked_tracks: { user, data: LikedTrackEntry[] }
// ---------------------------------------------------------------------------

export interface LikedTrackEntry {
  id: number;
  title?: string;
  duration: number;
  hires: boolean;
  performer?: { id: number; name?: string };
  album?: { id?: string; title?: string; image?: Record<string, string | null | undefined> };
  likedAt: number;
}

export function extractLikedTracks(signals: TrackSignal[]): LikedTrackEntry[] {
  return signals
    .filter((s) => s.isLiked)
    .map((s) => ({
      id: s.id,
      title: s.title,
      duration: s.duration,
      hires: s.hires,
      performer: s.performer ? { id: s.performer.id, name: s.performer.name } : undefined,
      album: s.album
        ? { id: s.album.id, title: s.album.title, image: s.album.image as Record<string, string | null | undefined> }
        : undefined,
      likedAt: s.lastInteractedAt,
    }));
}

export function mergeLikedIntoSignals(signals: TrackSignal[], liked: LikedTrackEntry[]): TrackSignal[] {
  const likedMap = new Map(liked.map((l) => [l.id, l]));
  const merged = [...signals];

  for (const signal of merged) {
    if (likedMap.has(signal.id)) {
      signal.isLiked = true;
      likedMap.delete(signal.id);
    }
  }

  for (const entry of likedMap.values()) {
    merged.push({
      id: entry.id,
      title: entry.title,
      duration: entry.duration,
      hires: entry.hires,
      performer: entry.performer ? { id: entry.performer.id, name: entry.performer.name } : undefined,
      album: entry.album
        ? {
            id: entry.album.id,
            title: entry.album.title,
            image: entry.album.image,
            tracks_count: 0,
            duration: 0,
            hires: entry.hires,
            maximum_bit_depth: 0,
            maximum_sampling_rate: 0,
          }
        : undefined,
      firstInteractedAt: entry.likedAt,
      lastInteractedAt: entry.likedAt,
      playCount: 0,
      completionCount: 0,
      skipCount: 0,
      likeCount: 1,
      isLiked: true,
      totalListenedSeconds: 0,
    });
  }

  return merged;
}

export async function pullLikedTracksFromRemote(): Promise<LikedTrackEntry[]> {
  const data = await pullSingleRecord<LikedTrackEntry[]>('kplayer_liked_tracks');
  return Array.isArray(data) ? data : [];
}

export async function pushLikedTracksToRemote(liked: LikedTrackEntry[]): Promise<void> {
  await pushSingleRecord('kplayer_liked_tracks', liked);
}
