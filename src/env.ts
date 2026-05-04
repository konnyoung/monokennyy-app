function readRequiredEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${String(name)}`);
  }

  return value.trim();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const PB_URL = trimTrailingSlash(readRequiredEnv('VITE_PB_URL'));
export const QOBUZ_API_BASE = trimTrailingSlash(readRequiredEnv('VITE_QOBUZ_API_BASE'));
export const LASTFM_API_KEY = readRequiredEnv('VITE_LASTFM_API_KEY');
export const LASTFM_API_BASE = readRequiredEnv('VITE_LASTFM_API_BASE');
