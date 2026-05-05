import { PB_URL, pb } from './pb';
import type { AppSettings } from './app-state';
import type { ListeningProfile } from './listening-profile';

export interface RecommendationMetadata {
  seedQueries?: string[];
  updatedAt?: number;
}

export interface UserStateBag {
  appSettings?: AppSettings;
  listeningProfile?: ListeningProfile;
  recommendations?: RecommendationMetadata;
  updatedAt?: number;
}

interface RemoteSettingsRecord {
  id: string;
  user: string;
  data?: UserStateBag;
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

async function listRemoteStateRecords(): Promise<RemoteSettingsRecord[]> {
  const auth = getAuthContext();
  if (!auth) {
    return [];
  }

  const url = new URL(`${PB_URL}/api/collections/kplayer_settings/records`);
  url.searchParams.set('perPage', '50');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to list remote state.'));
  }

  const payload = await response.json() as PocketBaseListResponse<RemoteSettingsRecord>;
  return Array.isArray(payload.items) ? payload.items : [];
}

async function createRemoteStateRecord(payload: { user: string; data: UserStateBag }) {
  const auth = getAuthContext();
  if (!auth) {
    return;
  }

  const response = await fetch(`${PB_URL}/api/collections/kplayer_settings/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to create remote state.'));
  }
}

async function updateRemoteStateRecord(recordId: string, payload: { user: string; data: UserStateBag }) {
  const auth = getAuthContext();
  if (!auth) {
    return;
  }

  const response = await fetch(`${PB_URL}/api/collections/kplayer_settings/records/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getResponseMessage(response, 'Failed to update remote state.'));
  }
}

async function findRecord(): Promise<RemoteSettingsRecord | null> {
  const auth = getAuthContext();
  if (!auth) return null;
  try {
    const records = await listRemoteStateRecords();
    return records.find((record) => record.user === auth.userId) ?? null;
  } catch {
    return null;
  }
}

export async function pullUserState(): Promise<UserStateBag | null> {
  const record = await findRecord();
  return record?.data ?? null;
}

export async function pushUserState(bag: UserStateBag): Promise<void> {
  const auth = getAuthContext();
  if (!auth) return;
  const userId = auth.userId;
  const payload = { user: userId, data: { ...bag, updatedAt: Date.now() } };
  const existing = await findRecord();
  if (existing) {
    await updateRemoteStateRecord(existing.id, payload);
  } else {
    await createRemoteStateRecord(payload);
  }
}
