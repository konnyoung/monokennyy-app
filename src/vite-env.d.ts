/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PB_URL: string;
  readonly VITE_QOBUZ_API_BASE: string;
  readonly VITE_LASTFM_API_KEY: string;
  readonly VITE_LASTFM_API_BASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}