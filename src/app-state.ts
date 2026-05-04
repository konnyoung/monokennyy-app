const SETTINGS_STORAGE_KEY = 'kplayer:app-settings:v1';
const DOWNLOAD_JOBS_STORAGE_KEY = 'kplayer:download-jobs:v1';
const PLAYLISTS_STORAGE_KEY = 'kplayer:playlists:v1';
const LAST_SESSION_STORAGE_KEY = 'kplayer:last-session:v1';

export type AudioQuality = '5' | '6' | '27';
export type DownloadTarget = 'app' | 'disk';
export type DownloadJobStatus = 'queued' | 'downloading' | 'completed' | 'failed';
export type DownloadSourceKind = 'track' | 'album' | 'artist' | 'queue';

export type DownloadFormat =
  | 'SOURCE_HIRES'
  | 'SOURCE_FLAC'
  | 'SOURCE_MP3'
  | 'FLAC'
  | 'ALAC'
  | 'MP3_320' | 'MP3_256' | 'MP3_128'
  | 'OGG_320' | 'OGG_256' | 'OGG_128'
  | 'AAC_320' | 'AAC_256' | 'AAC_128';

export interface DownloadFormatSpec {
  label: string;
  category: 'Source' | 'FLAC' | 'ALAC' | 'MP3' | 'OGG' | 'AAC';
  extension: string;
  /** Qobuz quality code to fetch from the streaming API */
  sourceQuality: AudioQuality;
  /** ffmpeg arguments excluding -i input and output filename. null = no transcode (write source bytes) */
  ffmpegArgs: string[] | null;
}

export const DOWNLOAD_FORMATS: Record<DownloadFormat, DownloadFormatSpec> = {
  SOURCE_HIRES: { label: 'Best Available (Hi-Res FLAC)', category: 'Source', extension: 'flac', sourceQuality: '27', ffmpegArgs: null },
  SOURCE_FLAC:  { label: 'FLAC 16-bit / 44.1 kHz (source)', category: 'Source', extension: 'flac', sourceQuality: '6',  ffmpegArgs: null },
  SOURCE_MP3:   { label: 'MP3 320 kbps (source)',           category: 'Source', extension: 'mp3',  sourceQuality: '5',  ffmpegArgs: null },
  FLAC:         { label: 'FLAC',                            category: 'FLAC',   extension: 'flac', sourceQuality: '27', ffmpegArgs: ['-vn', '-map_metadata', '-1', '-map', '0:a', '-c:a', 'flac'] },
  ALAC:         { label: 'Apple Lossless (ALAC)',           category: 'ALAC',   extension: 'm4a',  sourceQuality: '27', ffmpegArgs: ['-vn', '-map_metadata', '-1', '-map', '0:a', '-c:a', 'alac'] },
  MP3_320: { label: 'MP3 320 kbps', category: 'MP3', extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100'] },
  MP3_256: { label: 'MP3 256 kbps', category: 'MP3', extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '256k', '-ar', '44100'] },
  MP3_128: { label: 'MP3 128 kbps', category: 'MP3', extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100'] },
  OGG_320: { label: 'OGG 320 kbps', category: 'OGG', extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '320k'] },
  OGG_256: { label: 'OGG 256 kbps', category: 'OGG', extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '256k'] },
  OGG_128: { label: 'OGG 128 kbps', category: 'OGG', extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '128k'] },
  AAC_320: { label: 'AAC 320 kbps', category: 'AAC', extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '320k'] },
  AAC_256: { label: 'AAC 256 kbps', category: 'AAC', extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '256k'] },
  AAC_128: { label: 'AAC 128 kbps', category: 'AAC', extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '128k'] },
};

export function isDownloadFormat(value: unknown): value is DownloadFormat {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOWNLOAD_FORMATS, value);
}

export function getDownloadFormatLabel(format: DownloadFormat): string {
  return DOWNLOAD_FORMATS[format]?.label ?? format;
}

export interface AppSettings {
  streamQuality: AudioQuality;
  downloadFormat: DownloadFormat;
  defaultDownloadTarget: DownloadTarget;
  diskDownloadFolder: string;
  askDiskFolderEveryTime: boolean;
  preferOfflinePlayback: boolean;
  defaultVolume: number;
}

export interface DownloadJob {
  id: string;
  sourceKind: DownloadSourceKind;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  target: DownloadTarget;
  format: DownloadFormat;
  status: DownloadJobStatus;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  currentTrackTitle?: string;
  currentTrackProgress: number;
  currentTrackBytesReceived: number;
  currentTrackBytesTotal: number;
  currentTrackStage?: 'downloading' | 'transcoding';
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface OfflineTrackRecord {
  trackId: number;
  title?: string;
  artistName?: string;
  albumId?: string;
  albumTitle?: string;
  coverUrl?: string;
  duration: number;
  format: DownloadFormat;
  fileUrl: string;
  downloadedAt: number;
  trackNumber?: number;
}

export const defaultAppSettings: AppSettings = {
  streamQuality: '27',
  downloadFormat: 'SOURCE_HIRES',
  defaultDownloadTarget: 'app',
  diskDownloadFolder: '',
  askDiskFolderEveryTime: true,
  preferOfflinePlayback: true,
  defaultVolume: 0.8,
};

/** Migrate the legacy `downloadQuality` AudioQuality value to a DownloadFormat. */
function migrateDownloadFormat(parsed: any): DownloadFormat {
  if (isDownloadFormat(parsed?.downloadFormat)) {
    return parsed.downloadFormat;
  }
  switch (parsed?.downloadQuality) {
    case '5':
      return 'SOURCE_MP3';
    case '6':
      return 'SOURCE_FLAC';
    case '27':
      return 'SOURCE_HIRES';
    default:
      return defaultAppSettings.downloadFormat;
  }
}

export function getAudioQualityLabel(quality: AudioQuality) {
  switch (quality) {
    case '5':
      return 'MP3 320 kbps';
    case '6':
      return 'FLAC 16-bit / 44.1 kHz';
    case '27':
    default:
      return 'Best Available (Hi-Res FLAC)';
  }
}

export function getDownloadTargetLabel(target: DownloadTarget) {
  return target === 'app' ? 'Offline in app' : 'Saved to disk';
}

export function loadAppSettings(): AppSettings {
  if (typeof localStorage === 'undefined') {
    return defaultAppSettings;
  }

  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return defaultAppSettings;
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      streamQuality: parsed.streamQuality === '5' || parsed.streamQuality === '6' || parsed.streamQuality === '27' ? parsed.streamQuality : defaultAppSettings.streamQuality,
      downloadFormat: migrateDownloadFormat(parsed),
      defaultDownloadTarget:
        parsed.defaultDownloadTarget === 'disk' || parsed.defaultDownloadTarget === 'app'
          ? parsed.defaultDownloadTarget
          : defaultAppSettings.defaultDownloadTarget,
      diskDownloadFolder: typeof parsed.diskDownloadFolder === 'string' ? parsed.diskDownloadFolder : defaultAppSettings.diskDownloadFolder,
      askDiskFolderEveryTime:
        typeof parsed.askDiskFolderEveryTime === 'boolean'
          ? parsed.askDiskFolderEveryTime
          : defaultAppSettings.askDiskFolderEveryTime,
      preferOfflinePlayback:
        typeof parsed.preferOfflinePlayback === 'boolean'
          ? parsed.preferOfflinePlayback
          : defaultAppSettings.preferOfflinePlayback,
      defaultVolume:
        typeof parsed.defaultVolume === 'number' && Number.isFinite(parsed.defaultVolume)
          ? Math.min(1, Math.max(0, parsed.defaultVolume))
          : defaultAppSettings.defaultVolume,
    };
  } catch {
    return defaultAppSettings;
  }
}

export function saveAppSettings(settings: AppSettings) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures and keep the player usable.
  }
}

export function loadDownloadJobs(): DownloadJob[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(DOWNLOAD_JOBS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is DownloadJob => typeof entry?.id === 'string' && typeof entry?.title === 'string')
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function saveDownloadJobs(jobs: DownloadJob[]) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(DOWNLOAD_JOBS_STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    // Ignore storage failures and keep the player usable.
  }
}

export interface PlaylistTrack {
  id: number;
  title?: string;
  duration: number;
  hires: boolean;
  performer?: { id?: number; name?: string };
  album?: { id?: string; title?: string; image?: { small?: string; thumbnail?: string; large?: string } };
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  tracks: PlaylistTrack[];
  createdAt: number;
  updatedAt: number;
}

export function loadPlaylists(): Playlist[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is Playlist => typeof entry?.id === 'string' && typeof entry?.name === 'string' && Array.isArray(entry?.tracks))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function savePlaylists(playlists: Playlist[]) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(playlists));
  } catch {
    // Ignore storage failures.
  }
}

export interface LastSession {
  nowPlaying: import('./types').QobuzTrack;
  queue: {
    tracks: import('./types').QobuzTrack[];
    currentIndex: number;
    sourceLabel: string;
  };
  position: number;
  duration: number;
}

export function loadLastSession(): LastSession | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.nowPlaying === 'object' && typeof parsed.nowPlaying.id === 'number') {
      return parsed as LastSession;
    }

    return null;
  } catch {
    return null;
  }
}

export function saveLastSession(session: LastSession | null) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    if (session) {
      localStorage.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}