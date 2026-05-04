import PocketBase from 'pocketbase';

import { PB_URL as PUBLIC_PB_URL } from './env';

export const PB_URL = PUBLIC_PB_URL;

export const pb = new PocketBase(PB_URL);

// Persist auth across reloads (uses localStorage by default in browser/Electron renderer).
pb.autoCancellation(false);

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  username?: string;
  avatar?: string;
}

export function currentUser(): AuthUser | null {
  const model = pb.authStore.record;
  if (!model || !pb.authStore.isValid) return null;
  return {
    id: model.id,
    email: (model as { email?: string }).email ?? '',
    name: (model as { name?: string }).name,
    username: (model as { username?: string }).username,
    avatar: (model as { avatar?: string }).avatar,
  };
}

export function isAuthenticated(): boolean {
  return pb.authStore.isValid && !!pb.authStore.record;
}

export async function loginWithPassword(email: string, password: string): Promise<AuthUser> {
  await pb.collection('users').authWithPassword(email.trim(), password);
  const user = currentUser();
  if (!user) throw new Error('Login falhou');
  return user;
}

export async function signupWithPassword(email: string, password: string, name?: string): Promise<AuthUser> {
  const trimmedEmail = email.trim();
  await pb.collection('users').create({
    email: trimmedEmail,
    password,
    passwordConfirm: password,
    name: name?.trim() || trimmedEmail.split('@')[0],
  });
  return loginWithPassword(trimmedEmail, password);
}

export function logout() {
  pb.authStore.clear();
}

export function onAuthChange(listener: (user: AuthUser | null) => void): () => void {
  return pb.authStore.onChange(() => {
    listener(currentUser());
  });
}

export async function refreshAuth(): Promise<AuthUser | null> {
  if (!pb.authStore.isValid) return null;
  try {
    await pb.collection('users').authRefresh();
    return currentUser();
  } catch {
    pb.authStore.clear();
    return null;
  }
}

export async function updateProfile(data: { name?: string; username?: string; avatar?: File | null }): Promise<AuthUser> {
  const record = pb.authStore.record;
  if (!record || !pb.authStore.isValid) throw new Error('Not authenticated');

  const formData = new FormData();
  if (data.name !== undefined) formData.append('name', data.name);
  if (data.username !== undefined) formData.append('username', data.username);
  if (data.avatar) formData.append('avatar', data.avatar);
  else if (data.avatar === null) formData.append('avatar', '');

  await pb.collection('users').update(record.id, formData);
  await pb.collection('users').authRefresh();
  const user = currentUser();
  if (!user) throw new Error('Profile update failed');
  return user;
}

export function getAvatarUrl(user: AuthUser): string | null {
  if (!user.avatar) return null;
  const record = pb.authStore.record;
  if (!record) return null;
  return `${PB_URL}/api/files/${record.collectionId}/${record.id}/${user.avatar}`;
}
