import PocketBase from 'pocketbase';

export const PB_URL = 'https://pocketbase.kennyy.com.br';

export const pb = new PocketBase(PB_URL);

// Persist auth across reloads (uses localStorage by default in browser/Electron renderer).
pb.autoCancellation(false);

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
}

export function currentUser(): AuthUser | null {
  const model = pb.authStore.record;
  if (!model || !pb.authStore.isValid) return null;
  return {
    id: model.id,
    email: (model as { email?: string }).email ?? '',
    name: (model as { name?: string }).name,
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
