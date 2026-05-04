import type { QobuzTrack } from './types';

const LYRICS_OFFSET_PREFIX = 'kplayer:lyrics-offset:v1:';

let lyricsComponentPromise: Promise<void> | null = null;

export type LyricsWebComponent = HTMLElement & {
  currentTime?: number;
};

export async function ensureLyricsComponentLoaded() {
  if (!lyricsComponentPromise) {
    lyricsComponentPromise = import('@uimaxbai/am-lyrics/am-lyrics.js').then(async () => {
      await customElements.whenDefined('am-lyrics');
    });
  }

  await lyricsComponentPromise;
}

export function readLyricsOffset(trackId: QobuzTrack['id']) {
  if (typeof localStorage === 'undefined') {
    return 0;
  }

  try {
    const stored = localStorage.getItem(`${LYRICS_OFFSET_PREFIX}${trackId}`);
    return stored ? Number.parseInt(stored, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export function writeLyricsOffset(trackId: QobuzTrack['id'], offsetMs: number) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(`${LYRICS_OFFSET_PREFIX}${trackId}`, String(offsetMs));
  } catch {
    // Ignore storage failures to keep lyrics usable.
  }
}

export function formatLyricsOffset(offsetMs: number) {
  const sign = offsetMs >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(offsetMs) / 1000).toFixed(1)}s`;
}