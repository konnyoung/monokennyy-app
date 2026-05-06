export {};

import type { DownloadFormat, DownloadTarget, OfflineTrackRecord } from './app-state';

type DownloadProgressEvent = {
  requestId: string;
  bytesReceived: number;
  totalBytes: number;
  progress: number;
  stage?: 'downloading' | 'processing' | 'transcoding' | 'complete';
};

type DiscordPresencePayload = {
  details: string;
  state?: string;
  trackTitle?: string;
  artistName?: string;
  albumTitle?: string;
  coverUrl?: string;
  isPlaying?: boolean;
  positionSeconds?: number;
  durationSeconds?: number;
};

declare global {
  interface Window {
    kplayer?: {
      platform: string;
      shell: string;
      getArtistProfile?: (artist: { id: number; name?: string; slug?: string }) => Promise<{ description?: string; url?: string }>;
      getSimilarArtists?: (artist: string | { id?: number; name?: string; slug?: string }) => Promise<string[]>;
      setDiscordPresence?: (payload: DiscordPresencePayload) => Promise<{ enabled: boolean; connected: boolean }>;
      clearDiscordPresence?: () => Promise<{ enabled: boolean; connected: boolean }>;
      openExternal?: (url: string) => Promise<void>;
      pickDownloadFolder?: () => Promise<string>;
      saveTrackDownload?: (payload: {
        streamUrl: string;
        target: DownloadTarget;
        format: DownloadFormat;
        preferredDirectory?: string;
        track: {
          trackId: number;
          title?: string;
          artistName?: string;
          albumId?: string;
          albumTitle?: string;
          coverUrl?: string;
          duration: number;
          trackNumber?: number;
        };
      }, onProgress?: (event: DownloadProgressEvent) => void) => Promise<{ cancelled: boolean; target: DownloadTarget; offlineTrack?: OfflineTrackRecord; filePath?: string }>;
      listOfflineTracks?: () => Promise<OfflineTrackRecord[]>;
      deleteOfflineTrack?: (trackId: number) => Promise<{ success: boolean }>;
      revealPath?: (filePath: string) => Promise<void>;
      checkForUpdate?: () => Promise<{
        currentVersion: string;
        latestVersion: string;
        releaseUrl: string;
        downloadUrl: string;
        releaseNotes: string;
      } | null>;
    };
  }
}