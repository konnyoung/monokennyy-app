import { PB_URL, pb } from './pb';
import type { Playlist, PlaylistTrack } from './app-state';

export const PLAYLIST_LIMIT = 10;
export const TRACKS_PER_PLAYLIST_LIMIT = 300;

interface RemotePlaylistRecord {
  id: string;
  user: string;
  localId?: string;
  name: string;
  description?: string;
  coverUrl?: string;
  tracks?: PlaylistTrack[];
  sortOrder?: number;
  created: string;
  updated: string;
}

interface PocketBaseListResponse<T> {
  items?: T[];
}

function getAuthContext() {
  if (!pb.authStore.isValid || !pb.authStore.record || !pb.authStore.token) {
    return null;
  }

  return {
    token: pb.authStore.token,
    userId: pb.authStore.record.id,
  };
}

async function getResponseMessage(response: Response, fallback: string) {
  try {
    const data = await response.json() as { message?: string };
    return data.message || fallback;
  } catch {
    return fallback;
  }
}

async function listRemotePlaylistRecords(): Promise<RemotePlaylistRecord[]> {
  const auth = getAuthContext();
  if (!auth) {
    return [];
  }

  const url = new URL(`${PB_URL}/api/collections/kplayer_playlists/records`);
  url.searchParams.set('perPage', '200');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to list remote playlists.'));
  }

  const payload = await response.json() as PocketBaseListResponse<RemotePlaylistRecord>;
    return Array.isArray(payload.items) ? payload.items.sort(compareRemotePlaylistRecords) : [];
}

async function createRemotePlaylistRecord(payload: ReturnType<typeof playlistToRecord>) {
  const auth = getAuthContext();
  if (!auth) {
    return;
  }

  const response = await fetch(`${PB_URL}/api/collections/kplayer_playlists/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to create remote playlist.'));
  }
}

async function updateRemotePlaylistRecord(recordId: string, payload: ReturnType<typeof playlistToRecord>) {
  const auth = getAuthContext();
  if (!auth) {
    return;
  }

  const response = await fetch(`${PB_URL}/api/collections/kplayer_playlists/records/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to update remote playlist.'));
  }
}

async function deleteRemotePlaylistRecord(recordId: string) {
  const auth = getAuthContext();
  if (!auth) {
    return;
  }

  const response = await fetch(`${PB_URL}/api/collections/kplayer_playlists/records/${recordId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to delete remote playlist.'));
  }
}

function recordToPlaylist(record: RemotePlaylistRecord): Playlist {
  const tracks = Array.isArray(record.tracks) ? record.tracks : [];
  const createdAt = Date.parse(record.created) || Date.now();
  const updatedAt = Date.parse(record.updated) || createdAt;
  return {
    id: record.localId || record.id,
    name: record.name,
    description: record.description || undefined,
    coverUrl: record.coverUrl || undefined,
    tracks,
    createdAt,
    updatedAt,
  };
}

  function compareRemotePlaylistRecords(left: RemotePlaylistRecord, right: RemotePlaylistRecord) {
    const leftSortOrder = Number.isFinite(left.sortOrder) ? Number(left.sortOrder) : Number.MAX_SAFE_INTEGER;
    const rightSortOrder = Number.isFinite(right.sortOrder) ? Number(right.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (leftSortOrder !== rightSortOrder) {
      return leftSortOrder - rightSortOrder;
    }

    const leftUpdated = Date.parse(left.updated) || 0;
    const rightUpdated = Date.parse(right.updated) || 0;
    return rightUpdated - leftUpdated;
  }

function playlistToRecord(playlist: Playlist, userId: string, sortOrder: number) {
  return {
    user: userId,
    localId: playlist.id,
    name: playlist.name,
    description: playlist.description ?? '',
    coverUrl: playlist.coverUrl ?? '',
    tracks: playlist.tracks.slice(0, TRACKS_PER_PLAYLIST_LIMIT),
    sortOrder,
  };
}

export async function pullPlaylistsFromRemote(): Promise<Playlist[]> {
  const auth = getAuthContext();
  if (!auth) return [];
  const records = await listRemotePlaylistRecords();
  return records.filter((record) => record.user === auth.userId).map(recordToPlaylist);
}

/**
 * Push every local playlist to the remote, deleting remote records that no longer exist locally.
 * Local playlists beyond PLAYLIST_LIMIT are skipped (caller should enforce client-side too).
 */
export async function pushPlaylistsToRemote(playlists: Playlist[]): Promise<void> {
  const auth = getAuthContext();
  if (!auth) return;
  const { userId } = auth;

  const trimmed = playlists.slice(0, PLAYLIST_LIMIT);

  // Fetch existing remote records for this user
  const existing = (await listRemotePlaylistRecords())
    .filter((record) => record.user === userId);
  const byLocalId = new Map<string, RemotePlaylistRecord>();
  for (const rec of existing) {
    if (rec.localId) byLocalId.set(rec.localId, rec);
  }

  const localIds = new Set(trimmed.map((p) => p.id));

  // Upserts
  await Promise.all(
    trimmed.map(async (pl, index) => {
      const remote = byLocalId.get(pl.id);
      const payload = playlistToRecord(pl, userId, index);
      if (remote) {
        await updateRemotePlaylistRecord(remote.id, payload);
      } else {
        await createRemotePlaylistRecord(payload);
      }
    }),
  );

  // Delete remote records that no longer exist locally
  await Promise.all(
    existing
      .filter((rec) => !rec.localId || !localIds.has(rec.localId))
      .map((rec) => deleteRemotePlaylistRecord(rec.id)),
  );
}

/**
 * Merge local + remote playlists. For matching localId, keeps the one with the most recent updatedAt.
 * Items without a match are kept as-is from each side.
 */
export function mergePlaylists(local: Playlist[], remote: Playlist[]): Playlist[] {
  const byId = new Map<string, Playlist>();
  for (const pl of remote) byId.set(pl.id, pl);
  for (const pl of local) {
    const existing = byId.get(pl.id);
    if (!existing || pl.updatedAt > existing.updatedAt) {
      byId.set(pl.id, pl);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}
