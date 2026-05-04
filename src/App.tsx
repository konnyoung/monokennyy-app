import { startTransition, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  Globe,
  Heart,
  Home,
  Library,
  ListMusic,
  ListPlus,
  MicVocal,
  Music,
  Minus,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  Repeat,
  RotateCcw,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  User,
  Volume2,
  X,
} from 'lucide-react';
import { getAlbum, getTrackUrl, searchQobuz } from './api';
import {
  buildHomeFeed,
  buildListeningInsights,
  buildRecommendationSeeds,
  createEmptyProfile,
  isTrackLiked,
  loadListeningProfile,
  recordRecentPlayback,
  recordListen,
  recordTrackCompletion,
  recordTrackSkip,
  saveListeningProfile,
  toggleTrackLike,
  type HomeFeed,
  type ListeningProfile,
  type PlayedTrack,
  type RecommendationSeed,
  type SeedResult,
  type TrackSignal,
} from './music-recommender';
import {
  defaultAppSettings,
  DOWNLOAD_FORMATS,
  getAudioQualityLabel,
  getDownloadFormatLabel,
  loadDownloadJobs,
  loadAppSettings,
  loadLastSession,
  loadPlaylists,
  saveAppSettings,
  saveDownloadJobs,
  saveLastSession,
  savePlaylists,
  type AppSettings,
  type DownloadFormat,
  type DownloadJob,
  type DownloadSourceKind,
  type DownloadTarget,
  type OfflineTrackRecord,
  type Playlist,
  type PlaylistTrack,
} from './app-state';
import { FullscreenPlayer } from './FullscreenPlayer';
import { NowPlayingSidePanel } from './NowPlayingSidePanel';
import type { QobuzAlbum, QobuzAlbumDetail, QobuzArtist, QobuzSearchResults, QobuzTrack } from './types';
import { currentUser, getAvatarUrl, loginWithPassword, logout as pbLogout, onAuthChange, refreshAuth, signupWithPassword, updateProfile, type AuthUser } from './pb';
import { PLAYLIST_LIMIT, pullPlaylistsFromRemote, pushPlaylistsToRemote, TRACKS_PER_PLAYLIST_LIMIT } from './playlist-sync';
import { pullUserState, pushUserState } from './user-state-sync';
import { extractLikedTracks, mergeLikedIntoSignals, pullLikedTracksFromRemote, pullRecentsFromRemote, pushLikedTracksToRemote, pushRecentsToRemote } from './library-sync';

type Page =
  | { kind: 'home' }
  | { kind: 'search'; query: string }
  | { kind: 'album'; albumId: string }
  | { kind: 'artist'; artistId: number; artistName: string }
  | { kind: 'library'; tab: LibraryTab }
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'settings'; tab: SettingsTab };

type LibraryTab = 'recent' | 'favorites';
type SettingsTab = 'playback' | 'downloads';

type SearchTab = 'all' | 'artists' | 'tracks' | 'albums';

type SearchResults = {
  artists: QobuzArtist[];
  tracks: QobuzTrack[];
  albums: QobuzAlbum[];
};

const SEARCH_HISTORY_STORAGE_KEY = 'search-history';
const MAX_SEARCH_HISTORY_ITEMS = 10;

type ArtistPageData = {
  artist: QobuzArtist;
  tracks: QobuzTrack[];
  albums: QobuzAlbum[];
  description?: string;
  qobuzUrl?: string;
};

type AlbumPageSidebarAlbum = QobuzAlbum;
type DownloadRequest = {
  sourceKind: DownloadSourceKind;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  tracks: QobuzTrack[];
};

type PlaybackLearningState = {
  trackId: number | null;
  qualifiedRecorded: boolean;
  completionRecorded: boolean;
  skipRecorded: boolean;
  accountedSeconds: number;
};

type RepeatMode = 'off' | 'all' | 'one';
type SidePanelView = 'queue' | 'lyrics';

type QueueEntry = {
  queueId: string;
  track: QobuzTrack;
};

type PlaybackQueueState = {
  entries: QueueEntry[];
  originalEntries: QueueEntry[];
  currentIndex: number;
  sourceLabel: string;
};

type PlayTrackOptions = {
  queueTracks?: QobuzTrack[];
  queueIndex?: number;
  sourceLabel?: string;
};

function createPlaybackLearningState(trackId: number | null): PlaybackLearningState {
  return {
    trackId,
    qualifiedRecorded: false,
    completionRecorded: false,
    skipRecorded: false,
    accountedSeconds: 0,
  };
}

function shuffleArray<T>(items: T[]) {
  const next = [...items];

  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }

  return next;
}

function createQueueEntries(tracks: QobuzTrack[]): QueueEntry[] {
  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return tracks.map((track, index) => ({
    queueId: `${batchId}-${track.id}-${index}`,
    track,
  }));
}

function shuffleQueueEntries(entries: QueueEntry[], currentQueueId: string) {
  const currentEntry = entries.find((entry) => entry.queueId === currentQueueId);
  const remainingEntries = shuffleArray(entries.filter((entry) => entry.queueId !== currentQueueId));
  return currentEntry ? [currentEntry, ...remainingEntries] : remainingEntries;
}

function buildPlaybackQueueState(tracks: QobuzTrack[], currentTrackIndex: number, sourceLabel: string, shuffleEnabled: boolean): PlaybackQueueState {
  const originalEntries = createQueueEntries(tracks);
  const safeIndex = Math.max(0, Math.min(currentTrackIndex, Math.max(0, originalEntries.length - 1)));
  const currentEntry = originalEntries[safeIndex];
  const entries = shuffleEnabled && currentEntry ? shuffleQueueEntries(originalEntries, currentEntry.queueId) : originalEntries;
  const currentIndex = currentEntry ? Math.max(0, entries.findIndex((entry) => entry.queueId === currentEntry.queueId)) : 0;

  return {
    entries,
    originalEntries,
    currentIndex,
    sourceLabel,
  };
}

const homePage: Page = { kind: 'home' };
const libraryPage: Page = { kind: 'library', tab: 'favorites' };

const DOWNLOADS_PLAYLIST_ID = '__downloads__';
const settingsPage: Page = { kind: 'settings', tab: 'playback' };

function mergeAlbumImages(image: QobuzAlbum['image'], fallbackImage: QobuzAlbum['image']) {
  const merged = { ...(fallbackImage ?? {}), ...(image ?? {}) };
  return Object.values(merged).some((value) => Boolean(value)) ? merged : undefined;
}

function mergeAlbumWithFallback(album: QobuzAlbum | undefined, fallbackAlbum: QobuzAlbum | undefined): QobuzAlbum | undefined {
  if (!album && !fallbackAlbum) {
    return undefined;
  }

  return {
    ...(fallbackAlbum ?? {}),
    ...(album ?? {}),
    id: album?.id ?? fallbackAlbum?.id,
    title: album?.title ?? fallbackAlbum?.title,
    image: mergeAlbumImages(album?.image, fallbackAlbum?.image),
    artist: album?.artist ?? fallbackAlbum?.artist,
    label: album?.label ?? fallbackAlbum?.label,
    url: album?.url ?? fallbackAlbum?.url,
    parental_warning: album?.parental_warning ?? fallbackAlbum?.parental_warning,
    release_date_original: album?.release_date_original ?? fallbackAlbum?.release_date_original,
    tracks_count: album?.tracks_count ?? fallbackAlbum?.tracks_count ?? 0,
    duration: album?.duration ?? fallbackAlbum?.duration ?? 0,
    hires: album?.hires ?? fallbackAlbum?.hires ?? false,
    maximum_bit_depth: album?.maximum_bit_depth ?? fallbackAlbum?.maximum_bit_depth ?? 0,
    maximum_sampling_rate: album?.maximum_sampling_rate ?? fallbackAlbum?.maximum_sampling_rate ?? 0,
  };
}

function mergeTrackWithAlbumFallback(track: QobuzTrack, fallbackAlbum: QobuzAlbum | undefined): QobuzTrack {
  const mergedAlbum = mergeAlbumWithFallback(track.album, fallbackAlbum);

  return {
    ...track,
    performer: track.performer ?? mergedAlbum?.artist,
    album: mergedAlbum,
  };
}

function normalizeText(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function loadSearchHistory() {
  if (typeof window === 'undefined') {
    return [] as string[];
  }

  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, MAX_SEARCH_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

function saveSearchHistory(history: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (history.length === 0) {
      window.localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage failures and keep search usable.
  }
}

function mergeSearchHistory(history: string[], query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return history;
  }

  return [normalizedQuery, ...history.filter((entry) => normalizeText(entry) !== normalizeText(normalizedQuery))].slice(
    0,
    MAX_SEARCH_HISTORY_ITEMS,
  );
}

function areStringListsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dedupeById<T>(items: T[], getId: (item: T) => string | number | undefined) {
  const seen = new Set<string>();

  return items.filter((item) => {
    const id = getId(item);
    if (id === undefined || id === null || id === '') {
      return false;
    }

    const key = String(id);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function matchesArtistReference(artist: QobuzArtist | undefined, artistId: number, artistName: string) {
  if (!artist) {
    return false;
  }

  return artist.id === artistId || normalizeText(artist.name) === normalizeText(artistName);
}

function buildArtistPageData(searchResults: QobuzSearchResults, artistId: number, artistName: string): ArtistPageData {
  const artists = searchResults.artists?.items ?? [];
  const matchedArtist =
    artists.find((artist) => artist.id === artistId) ??
    artists.find((artist) => normalizeText(artist.name) === normalizeText(artistName)) ??
    ({ id: artistId, name: artistName } satisfies QobuzArtist);

  const tracks = dedupeById(
    (searchResults.tracks?.items ?? []).filter((track) => matchesArtistReference(track.performer, artistId, artistName)),
    (track) => track.id,
  ).slice(0, 10);

  const albums = dedupeById(
    (searchResults.albums?.items ?? []).filter((album) => matchesArtistReference(album.artist, artistId, artistName)),
    (album) => album.id,
  ).slice(0, 12);

  return {
    artist: matchedArtist,
    tracks,
    albums,
  };
}

function buildAlbumSidebarAlbums(searchResults: QobuzSearchResults, album: QobuzAlbumDetail): AlbumPageSidebarAlbum[] {
  const artistId = album.artist?.id ?? -1;
  const artistName = album.artist?.name ?? '';

  return dedupeById(
    (searchResults.albums?.items ?? []).filter(
      (entry) => entry.id !== album.id && matchesArtistReference(entry.artist, artistId, artistName),
    ),
    (entry) => entry.id,
  ).slice(0, 6);
}

function normalizeAlbumDetail(album: QobuzAlbumDetail): QobuzAlbumDetail {
  const normalizedAlbum: QobuzAlbumDetail = {
    ...album,
    image: album.image ?? album.tracks?.items?.[0]?.album?.image,
    artist: album.artist ?? album.tracks?.items?.[0]?.performer,
  };

  if (!album.tracks) {
    return normalizedAlbum;
  }

  return {
    ...normalizedAlbum,
    tracks: {
      ...album.tracks,
      items: album.tracks.items.map((track) => mergeTrackWithAlbumFallback(track, normalizedAlbum)),
    },
  };
}

function samePage(left: Page, right: Page) {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'home' && right.kind === 'home') {
    return true;
  }

  if (left.kind === 'search' && right.kind === 'search') {
    return left.query === right.query;
  }

  if (left.kind === 'album' && right.kind === 'album') {
    return left.albumId === right.albumId;
  }

  if (left.kind === 'artist' && right.kind === 'artist') {
    return left.artistId === right.artistId;
  }

  if (left.kind === 'library' && right.kind === 'library') {
    return left.tab === right.tab;
  }

  if (left.kind === 'settings' && right.kind === 'settings') {
    return left.tab === right.tab;
  }

  return false;
}

function splitIntoColumns<T>(items: T[], columnCount: number) {
  const columns = Array.from({ length: columnCount }, () => [] as T[]);
  if (items.length === 0) {
    return columns;
  }

  const chunkSize = Math.ceil(items.length / columnCount);
  items.forEach((item, index) => {
    const columnIndex = Math.min(columnCount - 1, Math.floor(index / chunkSize));
    columns[columnIndex].push(item);
  });
  return columns;
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getPlayerSliderStyle(value: number, max: number): CSSProperties {
  const safeMax = Math.max(0, max);
  const safeValue = Math.min(Math.max(0, value), safeMax || value);
  const fill = safeMax > 0 ? Math.min(100, Math.max(0, (safeValue / safeMax) * 100)) : 0;

  return {
    ['--player-slider-background' as string]: `linear-gradient(90deg, var(--player-slider-fill) 0 ${fill}%, var(--player-slider-track) ${fill}% 100%)`,
  } as CSSProperties;
}

function formatAlbumLength(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.round((safeSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours} hr ${minutes} min`;
  }

  return `${minutes} min`;
}

function formatFullDate(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRelativeTime(timestamp: number) {
  const delta = Date.now() - timestamp;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;

  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function getDownloadJobProgress(job: DownloadJob) {
  if (job.totalTracks <= 0) {
    return job.status === 'completed' ? 1 : 0;
  }

  const processedTracks = job.completedTracks + job.failedTracks;
  const currentTrackProgress = job.status === 'downloading' ? Math.max(0, Math.min(1, job.currentTrackProgress)) : 0;
  return Math.max(0, Math.min(1, (processedTracks + currentTrackProgress) / job.totalTracks));
}

function getDownloadAggregateProgress(jobs: DownloadJob[]) {
  if (jobs.length === 0) {
    return 0;
  }

  const totalProgress = jobs.reduce((sum, job) => sum + getDownloadJobProgress(job), 0);
  return Math.max(0, Math.min(1, totalProgress / jobs.length));
}

function getCover(url?: string, placeholderLabel?: string) {
  if (url) {
    return url;
  }

  const initial = Array.from(placeholderLabel?.trim() ?? '').find((character) => /[\p{L}\p{N}]/u.test(character))?.toUpperCase() ?? 'K';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><rect width="640" height="640" fill="#171717"/><text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" fill="#f4f4f5" font-family="Segoe UI, Arial, sans-serif" font-size="256" font-weight="700">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getBestImageUrl(image?: QobuzAlbum['image']) {
  return image?.large ?? image?.extralarge ?? image?.mega ?? image?.medium ?? image?.small ?? image?.thumbnail ?? undefined;
}

function playedTrackToTrack(track: PlayedTrack): QobuzTrack {
  return {
    id: track.id,
    title: track.title,
    duration: track.duration,
    hires: track.hires,
    performer: track.performer,
    album: track.album,
    track_number: 0,
  };
}

function offlineTrackToTrack(track: OfflineTrackRecord): QobuzTrack {
  const sourceQuality = DOWNLOAD_FORMATS[track.format]?.sourceQuality ?? '27';
  const isHires = sourceQuality !== '5';
  return {
    id: track.trackId,
    title: track.title,
    duration: track.duration,
    hires: isHires,
    performer: track.artistName ? { id: -1, name: track.artistName } : undefined,
    album: {
      id: track.albumId,
      title: track.albumTitle,
      image: track.coverUrl ? { large: track.coverUrl, thumbnail: track.coverUrl } : undefined,
      artist: track.artistName ? { id: -1, name: track.artistName } : undefined,
      tracks_count: 0,
      duration: track.duration,
      hires: isHires,
      maximum_bit_depth: 0,
      maximum_sampling_rate: 0,
    },
    track_number: track.trackNumber ?? 0,
  };
}

function trackSignalToTrack(signal: TrackSignal): QobuzTrack {
  return {
    id: signal.id,
    title: signal.title,
    duration: signal.duration,
    hires: signal.hires,
    performer: signal.performer,
    album: signal.album,
    track_number: 0,
  };
}

interface WindowControlsOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowControlsOverlayApi {
  visible: boolean;
  getTitlebarAreaRect: () => WindowControlsOverlayRect;
  addEventListener: (type: 'geometrychange', listener: () => void) => void;
  removeEventListener: (type: 'geometrychange', listener: () => void) => void;
}

const WINDOWS_CONTROLS_FALLBACK_PX = 140;

function useWindowsControlsOverlayMetrics(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const root = document.documentElement;
    const overlay = (navigator as unknown as { windowControlsOverlay?: WindowControlsOverlayApi })
      .windowControlsOverlay;

    if (!overlay) {
      root.style.setProperty('--window-controls-space', `${WINDOWS_CONTROLS_FALLBACK_PX}px`);
      return () => {
        root.style.removeProperty('--window-controls-space');
      };
    }

    const apply = () => {
      const rect = overlay.getTitlebarAreaRect();
      const innerWidth = window.innerWidth || rect.width + rect.x;
      const measured = Math.max(0, Math.round(innerWidth - (rect.x + rect.width)));
      const reserved = measured > 0 ? measured : WINDOWS_CONTROLS_FALLBACK_PX;
      root.style.setProperty('--window-controls-space', `${reserved}px`);
    };

    apply();
    overlay.addEventListener('geometrychange', apply);
    window.addEventListener('resize', apply);
    return () => {
      overlay.removeEventListener('geometrychange', apply);
      window.removeEventListener('resize', apply);
      root.style.removeProperty('--window-controls-space');
    };
  }, [enabled]);
}

type ContextMenuTarget =
  | { kind: 'track'; track: QobuzTrack }
  | { kind: 'album'; album: QobuzAlbum }
  | { kind: 'artist'; artist: QobuzArtist };

interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

interface ContextMenuItem {
  key: string;
  label?: string;
  separator?: boolean;
  onSelect?: () => void | Promise<void>;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

function ContextMenu({
  items,
  x,
  y,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const { offsetWidth, offsetHeight } = node;
    const margin = 8;
    const maxLeft = window.innerWidth - offsetWidth - margin;
    const maxTop = window.innerHeight - offsetHeight - margin;
    setPosition({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop)),
    });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current) return;
      if (event.target instanceof Node && menuRef.current.contains(event.target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('contextmenu', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('contextmenu', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const style: CSSProperties = {
    display: 'block',
    left: position.left,
    top: position.top,
  };

  return (
    <div id="context-menu" ref={menuRef} role="menu" style={style} onContextMenu={(event) => event.preventDefault()}>
      <ul>
        {items.map((item) =>
          item.separator ? (
            <li className="separator" key={item.key} />
          ) : (
            <li data-action={item.key} key={item.key} onClick={() => void item.onSelect?.()} role="menuitem">
              {item.label}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

export default function App() {
  const initialAuthUser = currentUser();
  const initialListeningProfile = initialAuthUser ? createEmptyProfile() : loadListeningProfile();
  const reserveWindowsControlsSpace =
    typeof window !== 'undefined' &&
    window.kplayer?.shell === 'electron' &&
    window.kplayer.platform === 'win32';
  useWindowsControlsOverlayMetrics(reserveWindowsControlsSpace);

  const [navigation, setNavigation] = useState<{ stack: Page[]; index: number }>({
    stack: [homePage],
    index: 0,
  });
  const currentPage = navigation.stack[navigation.index] ?? homePage;

  const [query, setQuery] = useState('');
  const [searchTab, setSearchTab] = useState<SearchTab>('all');
  const [results, setResults] = useState<SearchResults>({ artists: [], tracks: [], albums: [] });
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  const [isSearchHistoryOpen, setIsSearchHistoryOpen] = useState(false);
  const [album, setAlbum] = useState<QobuzAlbumDetail | null>(null);
  const [albumSidebarAlbums, setAlbumSidebarAlbums] = useState<AlbumPageSidebarAlbum[]>([]);
  const [artistPage, setArtistPage] = useState<ArtistPageData | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => loadAppSettings());
  const [listeningProfile, setListeningProfile] = useState<ListeningProfile>(() => initialListeningProfile);
  const [homeFeed, setHomeFeed] = useState<HomeFeed>(() => buildHomeFeed(initialListeningProfile, []));
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>(() => (initialAuthUser ? [] : loadDownloadJobs()));
  const [playlists, setPlaylists] = useState<Playlist[]>(() => (initialAuthUser ? [] : loadPlaylists()));
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false);
  const [createPlaylistForm, setCreatePlaylistForm] = useState({ name: '', description: '', coverUrl: '' });
  const [renamePlaylistTarget, setRenamePlaylistTarget] = useState<{ id: string; name: string; description: string; coverUrl: string } | null>(null);
  const [deletePlaylistTarget, setDeletePlaylistTarget] = useState<{ id: string; name: string } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<QobuzTrack | null>(null);
  const [playlistPickerSearch, setPlaylistPickerSearch] = useState('');
  const [playlistTrackSearch, setPlaylistTrackSearch] = useState('');
  const [offlineTracks, setOfflineTracks] = useState<OfflineTrackRecord[]>([]);
  const [isFullscreenPlayerOpen, setIsFullscreenPlayerOpen] = useState(false);
  const [isDownloadsBubbleOpen, setIsDownloadsBubbleOpen] = useState(false);
  const [hasIntroducedDownloadsBubble, setHasIntroducedDownloadsBubble] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('kplayer.downloadsBubbleIntroduced') === '1';
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isHomeLoading, setIsHomeLoading] = useState(false);
  const [status, setStatus] = useState("Tell us what you like and we'll recommend songs for you.");
  const [savedSession] = useState(() => loadLastSession());
  const [nowPlaying, setNowPlaying] = useState<QobuzTrack | null>(() => savedSession?.nowPlaying ?? null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(() => savedSession?.position ?? 0);
  const [duration, setDuration] = useState(() => savedSession?.duration ?? 0);
  const [volume, setVolume] = useState(() => loadAppSettings().defaultVolume);
  const [isArtistBioExpanded, setIsArtistBioExpanded] = useState(false);
  const [downloadRequest, setDownloadRequest] = useState<DownloadRequest | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueueState | null>(() => {
    if (!savedSession?.queue) return null;
    const { tracks, currentIndex, sourceLabel } = savedSession.queue;
    return tracks.length > 0 ? buildPlaybackQueueState(tracks, currentIndex, sourceLabel, false) : null;
  });
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);
  const [sidePanelView, setSidePanelView] = useState<SidePanelView | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => initialAuthUser);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authForm, setAuthForm] = useState({ email: '', password: '', name: '' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: '', username: '', avatarFile: null as File | null, avatarPreview: '' });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [syncReadyUserId, setSyncReadyUserId] = useState<string | null>(null);
  const [syncedRecommendationSeedQueries, setSyncedRecommendationSeedQueries] = useState<string[]>([]);
  const [availableUpdate, setAvailableUpdate] = useState<{ latestVersion: string; downloadUrl: string } | null>(null);
  const authUserId = authUser?.id ?? null;
  const isAccountSyncBlocked = Boolean(authUserId && syncReadyUserId !== authUserId);

  const clearAccountScopedState = () => {
    const emptyProfile = createEmptyProfile();
    setPlaylists([]);
    setListeningProfile(emptyProfile);
    setHomeFeed(buildHomeFeed(emptyProfile, []));
    setSyncedRecommendationSeedQueries([]);
    setDownloadJobs([]);
    return emptyProfile;
  };

  const ensureAccountSyncReady = () => {
    if (!isAccountSyncBlocked) {
      return true;
    }

    setStatus('Sincronizando conta. Aguarde um instante e tente de novo.');
    return false;
  };

  useEffect(() => {
    const unsubscribe = onAuthChange((user) => setAuthUser(user));
    void refreshAuth().then((user) => setAuthUser(user));
    return () => {
      unsubscribe();
    };
  }, []);

  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const searchFormRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    saveSearchHistory(searchHistory);
    if (searchHistory.length === 0) {
      setIsSearchHistoryOpen(false);
    }
  }, [searchHistory]);

  useEffect(() => {
    if (!showAccountMenu) return;
    const handle = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
    };
    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [showAccountMenu]);

  useEffect(() => {
    if (!isSearchHistoryOpen) {
      return;
    }

    const handle = (event: MouseEvent) => {
      if (searchFormRef.current && !searchFormRef.current.contains(event.target as Node)) {
        setIsSearchHistoryOpen(false);
      }
    };

    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [isSearchHistoryOpen]);

  const openAuthModal = (mode: 'login' | 'signup' = 'login') => {
    setAuthMode(mode);
    setAuthForm({ email: '', password: '', name: '' });
    setAuthError(null);
    setAuthBusy(false);
    setShowAuthModal(true);
  };

  const submitAuth = async () => {
    setAuthError(null);
    const email = authForm.email.trim();
    const password = authForm.password;
    if (!email || !password) {
      setAuthError('Email e senha são obrigatórios.');
      return;
    }
    if (authMode === 'signup' && password.length < 8) {
      setAuthError('Senha precisa ter ao menos 8 caracteres.');
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === 'login') {
        await loginWithPassword(email, password);
        setStatus('Login efetuado.');
      } else {
        await signupWithPassword(email, password, authForm.name);
        setStatus('Conta criada.');
      }
      setShowAuthModal(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na autenticação.';
      setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = () => {
    pbLogout();
    setShowAccountMenu(false);
    // Wipe all account-scoped state so a different user can sign in cleanly.
    clearAccountScopedState();
    setSyncReadyUserId(null);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem('kplayer:playlists:v1');
        localStorage.removeItem('kplayer:listening-profile:v1');
        localStorage.removeItem('kplayer:download-jobs:v1');
      } catch {
        // Ignore storage errors; in-memory state has already been cleared.
      }
    }
    setStatus('Você saiu da conta.');
  };

  const openProfileModal = () => {
    if (!authUser) return;
    const avatarUrl = getAvatarUrl(authUser);
    setProfileForm({
      name: authUser.name || '',
      username: authUser.username || '',
      avatarFile: null,
      avatarPreview: avatarUrl || '',
    });
    setProfileError(null);
    setProfileBusy(false);
    setShowProfileModal(true);
  };

  const submitProfile = async () => {
    setProfileError(null);
    setProfileBusy(true);
    try {
      const updated = await updateProfile({
        name: profileForm.name.trim(),
        username: profileForm.username.trim(),
        ...(profileForm.avatarFile ? { avatar: profileForm.avatarFile } : {}),
      });
      setAuthUser(updated);
      setShowProfileModal(false);
      setStatus('Profile updated.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update profile.';
      setProfileError(message);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setProfileError('Image must be under 2 MB.');
      return;
    }
    setProfileError(null);
    setProfileForm((f) => ({ ...f, avatarFile: file, avatarPreview: URL.createObjectURL(file) }));
  };

  const searchCache = useRef(new Map<string, SearchResults>());
  const albumCache = useRef(new Map<string, QobuzAlbumDetail>());
  const albumSidebarCache = useRef(new Map<string, AlbumPageSidebarAlbum[]>());
  const artistCache = useRef(new Map<string, ArtistPageData>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const restoredPositionRef = useRef<number | null>(savedSession?.position ?? null);
  const playbackLearningRef = useRef<PlaybackLearningState>(createPlaybackLearningState(null));
  const pendingTrackRef = useRef<QobuzTrack | null>(null);
  const playbackQueueRef = useRef<PlaybackQueueState | null>(null);
  const repeatModeRef = useRef<RepeatMode>('off');
  const playQueueIndexRef = useRef<(index: number) => Promise<void>>(async () => {});
  const playNextTrackRef = useRef<(triggeredByEnded?: boolean) => Promise<void>>(async () => {});
  const downloadsBubbleRef = useRef<HTMLDivElement | null>(null);
  const downloadSpeedRef = useRef<Map<string, { bytes: number; time: number; speed: number }>>(new Map());

  const trackColumns = splitIntoColumns<QobuzTrack>(results.tracks, 3);
  const homeTrackColumns = splitIntoColumns<QobuzTrack>(homeFeed.tracks, 3);
  const albumTracks = album?.tracks?.items ?? [];
  const offlineTrackById = new Map(offlineTracks.map((track) => [track.trackId, track]));
  const activeDownloadJobs = downloadJobs.filter((job) => job.status !== 'completed');
  const inProgressDownloadJobs = downloadJobs.filter((job) => job.status === 'queued' || job.status === 'downloading');
  const nowPlayingLiked = nowPlaying ? isTrackLiked(listeningProfile, nowPlaying.id) : false;
  const nowPlayingArtistName = nowPlaying?.performer?.name ?? nowPlaying?.album?.artist?.name ?? 'Unknown artist';
  const nowPlayingAlbumTitle = nowPlaying?.album?.title ?? '';
  const nowPlayingDiscordCoverUrl = getBestImageUrl(nowPlaying?.album?.image);
  const discordPresencePositionBucket = nowPlaying && isPlaying ? Math.floor(position / 5) : Math.floor(position);
  const discordPresenceDurationSeconds = Math.max(0, Math.floor(duration || nowPlaying?.duration || 0));

  useEffect(() => {
    playbackQueueRef.current = playbackQueue;
  }, [playbackQueue]);

  useEffect(() => {
    repeatModeRef.current = repeatMode;
  }, [repeatMode]);

  function openExternalUrl(url?: string) {
    if (!url) {
      return;
    }

    if (typeof window.kplayer?.openExternal === 'function') {
      void window.kplayer.openExternal(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function pushPage(page: Page) {
    setNavigation((current) => {
      const trimmed = current.stack.slice(0, current.index + 1);
      const lastPage = trimmed[trimmed.length - 1] ?? homePage;
      if (samePage(lastPage, page)) {
        return current;
      }

      return {
        stack: [...trimmed, page],
        index: trimmed.length,
      };
    });
  }

  function goBack() {
    setNavigation((current) => ({
      ...current,
      index: Math.max(0, current.index - 1),
    }));
  }

  function goForward() {
    setNavigation((current) => ({
      ...current,
      index: Math.min(current.stack.length - 1, current.index + 1),
    }));
  }

  useEffect(() => {
    const handleMouseNav = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); goBack(); }
      else if (e.button === 4) { e.preventDefault(); goForward(); }
    };
    window.addEventListener('mouseup', handleMouseNav);
    return () => window.removeEventListener('mouseup', handleMouseNav);
  }, []);

  function goHome() {
    pushPage(homePage);
  }

  function openSearch(queryText: string) {
    const normalized = queryText.trim();
    if (!normalized) {
      return;
    }

    setQuery(normalized);
    setSearchTab('all');
    pushPage({ kind: 'search', query: normalized });
  }

  async function openAlbum(albumId?: string) {
    if (!albumId) {
      return;
    }

    pushPage({ kind: 'album', albumId });
  }

  function openArtist(artist?: QobuzArtist | null) {
    if (!artist?.id || !artist.name) {
      return;
    }

    pushPage({ kind: 'artist', artistId: artist.id, artistName: artist.name });
  }

  function renderArtistInline(
    primary: { id?: number; name?: string } | undefined,
    fallback?: { id?: number; name?: string } | undefined,
    fallbackText: string = 'Unknown artist',
  ) {
    const candidate = primary?.name ? primary : fallback?.name ? fallback : undefined;
    if (!candidate?.name) {
      return <span>{fallbackText}</span>;
    }
    if (!candidate.id) {
      return <span>{candidate.name}</span>;
    }
    const target: QobuzArtist = { id: candidate.id, name: candidate.name };
    return (
      <span
        className="artist-link-inline"
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          openArtist(target);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
            event.preventDefault();
            openArtist(target);
          }
        }}
        role="link"
        tabIndex={0}
      >
        {candidate.name}
      </span>
    );
  }

  function openLibrary(tab: LibraryTab = 'favorites') {
    pushPage({ kind: 'library', tab });
  }

  function openSettings(tab: SettingsTab = 'playback') {
    pushPage({ kind: 'settings', tab });
  }

  async function refreshOfflineTracks() {
    if (typeof window.kplayer?.listOfflineTracks !== 'function') {
      setOfflineTracks([]);
      return;
    }

    try {
      const nextTracks = await window.kplayer.listOfflineTracks();
      setOfflineTracks(nextTracks);
    } catch {
      setOfflineTracks([]);
    }
  }

  function getTrackDownloadPayload(track: QobuzTrack) {
    const resolvedTrack = mergeTrackWithAlbumFallback(track, currentPage.kind === 'album' ? album ?? undefined : undefined);
    return {
      trackId: resolvedTrack.id,
      title: resolvedTrack.title,
      artistName: resolvedTrack.performer?.name,
      albumId: resolvedTrack.album?.id,
      albumTitle: resolvedTrack.album?.title,
      coverUrl: getBestImageUrl(resolvedTrack.album?.image),
      duration: resolvedTrack.duration,
      trackNumber: resolvedTrack.track_number,
    };
  }

  function updateDownloadJob(jobId: string, patch: Partial<DownloadJob>) {
    setDownloadJobs((current) =>
      current
        .map((job) => (job.id === jobId ? { ...job, ...patch, updatedAt: Date.now() } : job))
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }

  function dismissDownloadJob(jobId: string) {
    setDownloadJobs((current) => current.filter((job) => job.id !== jobId));
  }

  function openDownloadsHub() {
    setIsDownloadsBubbleOpen(false);
    pushPage({ kind: 'playlist', playlistId: DOWNLOADS_PLAYLIST_ID });
  }

  function createPlaylist(name: string, description?: string, coverUrl?: string): Playlist | null {
    if (!ensureAccountSyncReady()) {
      return null;
    }
    if (playlists.length >= PLAYLIST_LIMIT) {
      setStatus(`Limite de ${PLAYLIST_LIMIT} playlists atingido.`);
      return playlists[0];
    }
    const playlist: Playlist = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: description || undefined,
      coverUrl: coverUrl || undefined,
      tracks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setPlaylists((current) => [playlist, ...current]);
    return playlist;
  }

  function renamePlaylist(playlistId: string, name: string) {
    if (!ensureAccountSyncReady()) {
      return;
    }
    setPlaylists((current) =>
      current.map((pl) => pl.id === playlistId ? { ...pl, name, updatedAt: Date.now() } : pl),
    );
  }

  function updatePlaylist(playlistId: string, patch: { name?: string; description?: string; coverUrl?: string }) {
    if (!ensureAccountSyncReady()) {
      return;
    }
    setPlaylists((current) =>
      current.map((pl) => pl.id === playlistId
        ? {
            ...pl,
            name: patch.name !== undefined ? patch.name : pl.name,
            description: patch.description !== undefined ? (patch.description || undefined) : pl.description,
            coverUrl: patch.coverUrl !== undefined ? (patch.coverUrl || undefined) : pl.coverUrl,
            updatedAt: Date.now(),
          }
        : pl),
    );
  }

  function deletePlaylist(playlistId: string) {
    if (!ensureAccountSyncReady()) {
      return;
    }
    setPlaylists((current) => current.filter((pl) => pl.id !== playlistId));
    if (currentPage.kind === 'playlist' && currentPage.playlistId === playlistId) {
      openLibrary('favorites');
    }
  }

  function addTracksToPlaylist(playlistId: string, tracks: QobuzTrack[]) {
    if (!ensureAccountSyncReady()) {
      return;
    }
    const now = Date.now();
    const newTracks: PlaylistTrack[] = tracks.map((track) => ({
      id: track.id,
      title: track.title,
      duration: track.duration,
      hires: track.hires ?? false,
      performer: track.performer ? { id: track.performer.id, name: track.performer.name } : undefined,
      album: track.album ? { id: track.album.id, title: track.album.title, image: track.album.image } : undefined,
      addedAt: now,
    }));
    setPlaylists((current) =>
      current.map((pl) => {
        if (pl.id !== playlistId) return pl;
        const existingIds = new Set(pl.tracks.map((t) => t.id));
        const toAdd = newTracks.filter((t) => !existingIds.has(t.id));
        const combined = [...pl.tracks, ...toAdd];
        if (combined.length > TRACKS_PER_PLAYLIST_LIMIT) {
          setStatus(`Limite de ${TRACKS_PER_PLAYLIST_LIMIT} músicas por playlist atingido.`);
        }
        return { ...pl, tracks: combined.slice(0, TRACKS_PER_PLAYLIST_LIMIT), updatedAt: now };
      }),
    );
  }

  function removeTrackFromPlaylist(playlistId: string, trackId: number) {
    if (!ensureAccountSyncReady()) {
      return;
    }
    setPlaylists((current) =>
      current.map((pl) => {
        if (pl.id !== playlistId) return pl;
        return { ...pl, tracks: pl.tracks.filter((t) => t.id !== trackId), updatedAt: Date.now() };
      }),
    );
  }

  function openPlaylist(playlistId: string) {
    setPlaylistTrackSearch('');
    pushPage({ kind: 'playlist', playlistId });
  }

  function openTrackDownload(track: QobuzTrack) {
    const resolvedTrack = mergeTrackWithAlbumFallback(track, currentPage.kind === 'album' ? album ?? undefined : undefined);
    setDownloadRequest({
      sourceKind: 'track',
      title: resolvedTrack.title ?? 'Untitled track',
      subtitle: resolvedTrack.performer?.name ?? 'Unknown artist',
      coverUrl: getBestImageUrl(resolvedTrack.album?.image),
      tracks: [resolvedTrack],
    });
  }

  async function openAlbumDownloadFromMenu(albumEntry: QobuzAlbum) {
    if (!albumEntry.id) {
      return;
    }

    if (album?.id === albumEntry.id && albumTracks.length > 0) {
      openAlbumDownload();
      return;
    }

    setStatus('Loading album for download...');

    try {
      const cachedAlbum = albumCache.current.get(albumEntry.id);
      const detailedAlbum = cachedAlbum ?? normalizeAlbumDetail(await getAlbum(albumEntry.id));
      if (!cachedAlbum) {
        albumCache.current.set(albumEntry.id, detailedAlbum);
      }

      const tracks = detailedAlbum.tracks?.items ?? [];
      if (tracks.length === 0) {
        setStatus('This album has no tracks available for download.');
        return;
      }

      setDownloadRequest({
        sourceKind: 'album',
        title: detailedAlbum.title ?? 'Untitled album',
        subtitle: detailedAlbum.artist?.name ?? 'Unknown artist',
        coverUrl: getBestImageUrl(detailedAlbum.image),
        tracks: tracks.map((track) => mergeTrackWithAlbumFallback(track, detailedAlbum)),
      });
    } catch {
      setStatus('Unable to prepare that album for download.');
    }
  }

  function openContextMenuAt(target: ContextMenuTarget, clientX: number, clientY: number) {
    setContextMenu({ target, x: clientX, y: clientY });
  }

  function openContextMenuFromAnchor(target: ContextMenuTarget, element: Element) {
    const rect = element.getBoundingClientRect();
    openContextMenuAt(target, rect.left, rect.bottom + 5);
  }

  function openContextMenuFromEvent(
    event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void },
    target: ContextMenuTarget,
  ) {
    event.preventDefault();
    event.stopPropagation?.();
    openContextMenuAt(target, event.clientX, event.clientY);
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function toggleTrackLikeFromMenu(track: QobuzTrack) {
    setListeningProfile((current: ListeningProfile) => toggleTrackLike(current, track, Date.now()));
  }

  function renderContextMenuButton(target: ContextMenuTarget, className: string, label = 'Menu') {
    return (
      <span
        aria-label={label}
        className={className}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openContextMenuFromAnchor(target, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          openContextMenuFromAnchor(target, event.currentTarget);
        }}
      >
        <MoreVertical size={16} />
      </span>
    );
  }

  function openAlbumDownload() {
    if (!album || albumTracks.length === 0) {
      return;
    }

    setDownloadRequest({
      sourceKind: 'album',
      title: album.title ?? 'Untitled album',
      subtitle: album.artist?.name ?? 'Unknown artist',
      coverUrl: getBestImageUrl(album.image),
      tracks: albumTracks.map((track) => mergeTrackWithAlbumFallback(track, album)),
    });
  }

  function openArtistDownload() {
    if (!artistPage || artistTracks.length === 0) {
      return;
    }

    setDownloadRequest({
      sourceKind: 'artist',
      title: artistPage.artist.name ?? (currentPage.kind === 'artist' ? currentPage.artistName : 'Artist'),
      subtitle: `${artistTracks.length} popular tracks`,
      coverUrl: getBestImageUrl(artistPage.artist.image),
      tracks: artistTracks.map((track) => mergeTrackWithAlbumFallback(track, track.album)),
    });
  }

  function openNowPlayingDownload() {
    if (!nowPlaying) {
      return;
    }

    openTrackDownload(nowPlaying);
  }

  function openQueueDownload() {
    const queue = playbackQueueRef.current;
    if (!queue || queue.entries.length === 0) {
      return;
    }

    const tracks = queue.entries.map((entry) => entry.track);
    const currentEntry = queue.entries[queue.currentIndex] ?? queue.entries[0];

    setDownloadRequest({
      sourceKind: 'queue',
      title: queue.sourceLabel ? `${queue.sourceLabel} Queue` : 'Playback Queue',
      subtitle: `${tracks.length} tracks`,
      coverUrl: getBestImageUrl(currentEntry.track.album?.image),
      tracks,
    });
  }

  function renderTrackLikeIndicator(trackId: number, track?: QobuzTrack) {
    const liked = isTrackLiked(listeningProfile, trackId);
    if (track) {
      return (
        <span
          className={`track-meta-icon track-like-btn ${liked ? 'is-liked' : ''}`}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleTrackLikeFromMenu(track); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleTrackLikeFromMenu(track); } }}
          role="button"
          tabIndex={0}
          title={liked ? 'Unlike' : 'Like'}
        >
          <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
        </span>
      );
    }
    return <Heart size={16} className={`track-meta-icon ${liked ? 'is-liked' : ''}`} fill={liked ? 'currentColor' : 'none'} />;
  }

  function resolvePlaybackTrack(track: QobuzTrack) {
    return mergeTrackWithAlbumFallback(track, currentPage.kind === 'album' ? album ?? undefined : undefined);
  }

  function buildPlayableCollection(tracks: QobuzTrack[]) {
    return tracks.map((track) => resolvePlaybackTrack(track));
  }

  async function startQueuePlayback(tracks: QobuzTrack[], index: number, sourceLabel: string) {
    const queueTracks = buildPlayableCollection(tracks);
    const queueState = buildPlaybackQueueState(queueTracks, index, sourceLabel, isShuffleEnabled);
    const entry = queueState.entries[queueState.currentIndex];

    if (!entry) {
      return false;
    }

    await startPlayback(entry.track);
    setPlaybackQueue(queueState);
    return true;
  }

  function appendTracksToQueue(tracks: QobuzTrack[], sourceLabel: string) {
    const resolvedTracks = buildPlayableCollection(tracks);
    if (resolvedTracks.length === 0) {
      return;
    }

    const queue = playbackQueueRef.current;
    if (!queue) {
      void startQueuePlayback(resolvedTracks, 0, sourceLabel);
      setStatus(`Started ${sourceLabel.toLowerCase()}.`);
      return;
    }

    const existingIds = new Set(queue.originalEntries.map((entry) => entry.track.id));
    const tracksToAdd = resolvedTracks.filter((track) => !existingIds.has(track.id));
    if (tracksToAdd.length === 0) {
      setStatus('Those tracks are already in your queue.');
      return;
    }

    const newEntries = createQueueEntries(tracksToAdd);
    setPlaybackQueue({
      ...queue,
      originalEntries: [...queue.originalEntries, ...newEntries],
      entries: [...queue.entries, ...newEntries],
    });
    setStatus(`Added ${tracksToAdd.length} ${tracksToAdd.length === 1 ? 'track' : 'tracks'} to the queue.`);
  }

  function queueTracksNext(tracks: QobuzTrack[], sourceLabel: string) {
    const resolvedTracks = buildPlayableCollection(tracks);
    if (resolvedTracks.length === 0) {
      return;
    }

    const queue = playbackQueueRef.current;
    if (!queue) {
      void startQueuePlayback(resolvedTracks, 0, sourceLabel);
      setStatus(`Started ${sourceLabel.toLowerCase()}.`);
      return;
    }

    const currentEntry = queue.entries[queue.currentIndex];
    if (!currentEntry) {
      appendTracksToQueue(resolvedTracks, sourceLabel);
      return;
    }

    const existingIds = new Set(queue.originalEntries.map((entry) => entry.track.id));
    const tracksToAdd = resolvedTracks.filter((track) => !existingIds.has(track.id));
    if (tracksToAdd.length === 0) {
      setStatus('Those tracks are already in your queue.');
      return;
    }

    const newEntries = createQueueEntries(tracksToAdd);
    const currentOriginalIndex = queue.originalEntries.findIndex((entry) => entry.queueId === currentEntry.queueId);
    const insertOriginalAt = currentOriginalIndex >= 0 ? currentOriginalIndex + 1 : queue.originalEntries.length;
    const nextOriginalEntries = [...queue.originalEntries];
    nextOriginalEntries.splice(insertOriginalAt, 0, ...newEntries);

    const nextEntries = [...queue.entries];
    nextEntries.splice(queue.currentIndex + 1, 0, ...newEntries);

    setPlaybackQueue({
      ...queue,
      originalEntries: nextOriginalEntries,
      entries: nextEntries,
    });
    setStatus(`Playing next: ${tracksToAdd.length} ${tracksToAdd.length === 1 ? 'track' : 'tracks'}.`);
  }

  function toggleTrackCollectionLike(tracks: QobuzTrack[], collectionLabel: string) {
    if (tracks.length === 0) {
      return;
    }

    const resolvedTracks = buildPlayableCollection(tracks);
    const shouldLike = resolvedTracks.some((track) => !isTrackLiked(listeningProfile, track.id));
    const eventTime = Date.now();

    setListeningProfile((current) => {
      let nextProfile = current;

      resolvedTracks.forEach((track) => {
        const trackLiked = isTrackLiked(nextProfile, track.id);
        if (trackLiked !== shouldLike) {
          nextProfile = toggleTrackLike(nextProfile, track, eventTime);
        }
      });

      return nextProfile;
    });

    setStatus(
      shouldLike
        ? `Saved ${collectionLabel.toLowerCase()} to favorites.`
        : `Removed ${collectionLabel.toLowerCase()} from favorites.`,
    );
  }

  function dedupeRecommendationSeeds(seeds: RecommendationSeed[]) {
    return seeds.filter(
      (seed: RecommendationSeed, index: number, collection: RecommendationSeed[]) =>
        collection.findIndex((entry: RecommendationSeed) => normalizeText(entry.query) === normalizeText(seed.query)) === index,
    );
  }

  async function loadCachedSearchResults(query: string) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { artists: [], tracks: [], albums: [] } satisfies SearchResults;
    }

    const cached = searchCache.current.get(trimmedQuery);
    if (cached) {
      return cached;
    }

    const data = await searchQobuz(trimmedQuery);
    const mapped = {
      artists: data.artists?.items ?? [],
      tracks: data.tracks?.items ?? [],
      albums: data.albums?.items ?? [],
    } satisfies SearchResults;

    searchCache.current.set(trimmedQuery, mapped);
    return mapped;
  }

  async function loadRecommendationSeedResults(seedsToLoad: RecommendationSeed[]) {
    const settled = await Promise.allSettled(
      seedsToLoad.map(async (seed): Promise<SeedResult> => {
        const mapped = await loadCachedSearchResults(seed.query);
        return { seed, ...mapped };
      }),
    );

    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  async function buildAutoplayTracks(baseTrack: QobuzTrack) {
    const insights = buildListeningInsights(listeningProfile);
    const currentArtistName = baseTrack.performer?.name ?? baseTrack.album?.artist?.name;
    const autoplaySeedCandidates: RecommendationSeed[] = [];

    if (currentArtistName) {
      autoplaySeedCandidates.push({
        key: `autoplay-artist:${normalizeText(currentArtistName)}`,
        query: currentArtistName,
        kind: 'artist',
        weight: 12.8,
        source: 'taste-artist',
      });
    }

    if (baseTrack.title && currentArtistName) {
      autoplaySeedCandidates.push({
        key: `autoplay-track:${baseTrack.id}`,
        query: `${baseTrack.title} ${currentArtistName}`,
        kind: 'track',
        weight: 9.4,
        source: 'catalog',
      });
    }

    autoplaySeedCandidates.push(
      ...buildRecommendationSeeds(insights).map((seed, index) => ({
        ...seed,
        weight: seed.weight + Math.max(0, 2.6 - index * 0.18),
      })),
    );

    const maxSeeds = insights.stage >= 3 ? 8 : insights.stage >= 2 ? 6 : 4;
    const uniqueSeeds = dedupeRecommendationSeeds(autoplaySeedCandidates)
      .filter((seed) => seed.query.trim().length > 0)
      .sort((left, right) => right.weight - left.weight || left.query.localeCompare(right.query))
      .slice(0, maxSeeds);

    if (uniqueSeeds.length === 0) {
      return [] as QobuzTrack[];
    }

    const primaryResults = await loadRecommendationSeedResults(uniqueSeeds);
    const knownArtists = new Set(
      [
        currentArtistName,
        ...uniqueSeeds.map((seed) => seed.query),
        ...listeningProfile.plays.map((play: PlayedTrack) => play.performer?.name ?? play.album?.artist?.name),
      ]
        .map((value) => normalizeText(value))
        .filter((value) => value.length > 0),
    );

    const discoveryLimit = insights.stage >= 3 ? 4 : insights.stage >= 2 ? 3 : 2;
    const discoverySeedMap = new Map<string, RecommendationSeed>();

    const pushDiscoverySeed = (name: string | undefined, weight: number) => {
      const query = name?.trim();
      if (!query) {
        return;
      }

      const normalized = normalizeText(query);
      if (!normalized || knownArtists.has(normalized)) {
        return;
      }

      const nextSeed: RecommendationSeed = {
        key: `autoplay-discovery:${normalized}`,
        query,
        kind: 'artist',
        weight: Math.max(weight, 1),
        source: 'discovery-artist',
      };

      const current = discoverySeedMap.get(normalized);
      if (!current || nextSeed.weight > current.weight) {
        discoverySeedMap.set(normalized, nextSeed);
      }
    };

    const similarArtistSettled = window.kplayer?.getSimilarArtists
      ? await Promise.allSettled(
          primaryResults
            .filter(({ seed }) => seed.kind === 'artist' || seed.source === 'taste-artist')
            .slice(0, 5)
            .map(async ({ seed, artists }) => {
              const matchedArtist =
                artists.find((artist: QobuzArtist) => normalizeText(artist.name) === normalizeText(seed.query)) ?? artists[0] ?? seed.query;

              return {
                seed,
                artists: await window.kplayer?.getSimilarArtists?.(matchedArtist),
              };
            }),
        )
      : [];

    similarArtistSettled
      .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      .forEach(({ seed, artists }) => {
        (artists ?? []).slice(0, 3).forEach((artistName, index) => {
          pushDiscoverySeed(artistName, seed.weight - 1.1 - index * 0.28);
        });
      });

    if (discoverySeedMap.size < discoveryLimit) {
      primaryResults.forEach(({ seed, artists }) => {
        artists.slice(0, 4).forEach((artist: QobuzArtist, index: number) => {
          pushDiscoverySeed(artist.name, seed.weight - 1.35 - index * 0.24);
        });
      });
    }

    const discoverySeeds = [...discoverySeedMap.values()]
      .sort((left, right) => right.weight - left.weight || left.query.localeCompare(right.query))
      .slice(0, discoveryLimit);
    const discoveryResults = discoverySeeds.length > 0 ? await loadRecommendationSeedResults(discoverySeeds) : [];

    const excludedTrackIds = new Set<number>([
      baseTrack.id,
      ...(playbackQueueRef.current?.entries.map((entry) => entry.track.id) ?? []),
    ]);
    const successfulResults = [...primaryResults, ...discoveryResults];
    const feedTracks = buildHomeFeed(listeningProfile, successfulResults).tracks
      .filter((track) => !excludedTrackIds.has(track.id))
      .map((track) => resolvePlaybackTrack(track));

    if (feedTracks.length > 0) {
      return feedTracks.slice(0, 24);
    }

    const fallbackTracks = successfulResults
      .flatMap((result) => result.tracks)
      .filter((track) => !excludedTrackIds.has(track.id))
      .map((track) => resolvePlaybackTrack(track))
      .filter((track, index, collection) => collection.findIndex((entry) => entry.id === track.id) === index);

    return fallbackTracks.slice(0, 24);
  }

  async function continueQueueWithRecommendations(baseTrack: QobuzTrack) {
    setStatus('Queue finished. Loading more music for you...');

    const autoplayTracks = await buildAutoplayTracks(baseTrack);
    if (autoplayTracks.length === 0) {
      return false;
    }

    const sourceLabel = baseTrack.performer?.name ?? baseTrack.album?.artist?.name
      ? `Autoplay for ${baseTrack.performer?.name ?? baseTrack.album?.artist?.name}`
      : 'Autoplay';
    const started = await startQueuePlayback(autoplayTracks, 0, sourceLabel);

    if (!started) {
      return false;
    }

    setStatus(sourceLabel === 'Autoplay' ? 'Queue finished. Continuing with recommended tracks.' : `Queue finished. Continuing with ${sourceLabel.toLowerCase()}.`);
    return true;
  }

  async function startInfiniteRadio(baseTrack: QobuzTrack, sourceLabel?: string) {
    try {
      const autoplayTracks = await buildAutoplayTracks(baseTrack);
      const queueTracks = [resolvePlaybackTrack(baseTrack), ...autoplayTracks].filter(
        (track, index, collection) => collection.findIndex((entry) => entry.id === track.id) === index,
      );

      if (queueTracks.length === 0) {
        setStatus('Unable to build an infinite radio for this selection yet.');
        return;
      }

      const label = sourceLabel ?? `Radio for ${baseTrack.performer?.name ?? baseTrack.album?.artist?.name ?? baseTrack.title ?? 'this track'}`;
      await startQueuePlayback(queueTracks, 0, label);
      setStatus(`Started ${label.toLowerCase()}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start infinite radio.';
      setStatus(message);
    }
  }

  async function startPlayback(track: QobuzTrack) {
    setStatus(`Loading ${track.title ?? 'track'}...`);

    const audio = audioRef.current;
    const playbackTrack = resolvePlaybackTrack(track);
    const offlineTrack = appSettings.preferOfflinePlayback ? offlineTrackById.get(playbackTrack.id) : undefined;

    if (!audio) {
      throw new Error('Audio player unavailable');
    }

    registerSkipIfNeeded(playbackTrack.id);

    const streamUrl = offlineTrack?.fileUrl ?? (await getTrackUrl(playbackTrack.id, appSettings.streamQuality));

    if (audio.src !== streamUrl) {
      audio.src = streamUrl;
    }

    await audio.play();
    setNowPlaying(playbackTrack);
    pendingTrackRef.current = playbackTrack;
    resetPlaybackLearning(playbackTrack.id);
    setListeningProfile((current: ListeningProfile) => recordRecentPlayback(current, playbackTrack, Date.now()));
    setPosition(0);
    setStatus(`Playing ${playbackTrack.title ?? 'track'}`);
  }

  async function playTrack(track: QobuzTrack, options: PlayTrackOptions = {}) {
    try {
      if (options.queueTracks && options.queueTracks.length > 0) {
        await startQueuePlayback(options.queueTracks, options.queueIndex ?? 0, options.sourceLabel ?? 'Queue');
        return;
      }

      const playbackTrack = resolvePlaybackTrack(track);
      await startPlayback(playbackTrack);
      setPlaybackQueue((current) => {
        if (current) {
          const existingIndex = current.entries.findIndex((entry) => entry.track.id === playbackTrack.id);
          if (existingIndex >= 0) {
            return {
              ...current,
              currentIndex: existingIndex,
            };
          }
        }

        return buildPlaybackQueueState([playbackTrack], 0, options.sourceLabel ?? 'Now Playing', false);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown playback error';
      setStatus(message);
    }
  }

  async function playTracksFromSource(tracks: QobuzTrack[], index: number, sourceLabel: string) {
    if (tracks.length === 0) {
      return;
    }

    await playTrack(tracks[Math.max(0, Math.min(index, tracks.length - 1))], {
      queueTracks: tracks,
      queueIndex: index,
      sourceLabel,
    });
  }

  async function playQueueIndex(index: number) {
    const queue = playbackQueueRef.current;
    if (!queue) {
      return;
    }

    const entry = queue.entries[index];
    if (!entry) {
      return;
    }

    await startPlayback(entry.track);
    setPlaybackQueue((current) => (current ? { ...current, currentIndex: index } : current));
  }

  async function playNextTrack(triggeredByEnded = false) {
    const queue = playbackQueueRef.current;
    if (!queue || queue.entries.length === 0) {
      return;
    }

    if (triggeredByEnded && repeatModeRef.current === 'one') {
      await playQueueIndexRef.current(queue.currentIndex);
      return;
    }

    let nextIndex = queue.currentIndex + 1;
    if (nextIndex >= queue.entries.length) {
      if (repeatModeRef.current === 'all') {
        nextIndex = 0;
      } else {
        const currentEntry = queue.entries[queue.currentIndex];
        if (currentEntry) {
          const continued = await continueQueueWithRecommendations(currentEntry.track);
          if (continued) {
            return;
          }
        }

        setStatus('Queue finished.');
        return;
      }
    }

    await playQueueIndexRef.current(nextIndex);
  }

  async function playPreviousTrack() {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setPosition(0);
      return;
    }

    const queue = playbackQueueRef.current;
    if (!queue || queue.entries.length === 0) {
      return;
    }

    let previousIndex = queue.currentIndex - 1;
    if (previousIndex < 0) {
      previousIndex = repeatModeRef.current === 'all' ? queue.entries.length - 1 : 0;
    }

    await playQueueIndex(previousIndex);
  }

  function toggleShuffleMode() {
    setIsShuffleEnabled((current) => {
      const next = !current;

      setPlaybackQueue((queue) => {
        if (!queue || queue.originalEntries.length <= 1) {
          return queue;
        }

        const currentEntry = queue.entries[queue.currentIndex];
        if (!currentEntry) {
          return queue;
        }

        const entries = next ? shuffleQueueEntries(queue.originalEntries, currentEntry.queueId) : queue.originalEntries;
        const currentIndex = Math.max(0, entries.findIndex((entry) => entry.queueId === currentEntry.queueId));

        return {
          ...queue,
          entries,
          currentIndex,
        };
      });

      return next;
    });
  }

  function cycleRepeatMode() {
    setRepeatMode((current) => (current === 'off' ? 'all' : current === 'all' ? 'one' : 'off'));
  }

  function toggleSidePanel(view: SidePanelView) {
    setSidePanelView((current) => (current === view ? null : view));
  }

  function closeSidePanel() {
    setSidePanelView(null);
  }

  async function removeQueueEntryAtIndex(index: number) {
    const queue = playbackQueueRef.current;
    if (!queue) {
      return;
    }

    const removedEntry = queue.entries[index];
    if (!removedEntry) {
      return;
    }

    const nextEntries = queue.entries.filter((entry) => entry.queueId !== removedEntry.queueId);
    const nextOriginalEntries = queue.originalEntries.filter((entry) => entry.queueId !== removedEntry.queueId);

    if (nextEntries.length === 0 || nextOriginalEntries.length === 0) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }

      pendingTrackRef.current = null;
      resetPlaybackLearning(null);
      setPlaybackQueue(null);
      setNowPlaying(null);
      setIsPlaying(false);
      setPosition(0);
      setDuration(0);
      setStatus('Queue cleared.');
      closeSidePanel();
      return;
    }

    const removedCurrentTrack = index === queue.currentIndex;
    const nextIndex = removedCurrentTrack
      ? Math.min(index, nextEntries.length - 1)
      : index < queue.currentIndex
        ? queue.currentIndex - 1
        : queue.currentIndex;

    const nextQueueState: PlaybackQueueState = {
      ...queue,
      entries: nextEntries,
      originalEntries: nextOriginalEntries,
      currentIndex: nextIndex,
    };

    setPlaybackQueue(nextQueueState);

    if (removedCurrentTrack) {
      await startPlayback(nextEntries[nextIndex].track);
    }
  }

  function moveQueueEntry(fromIndex: number, toIndex: number) {
    const queue = playbackQueueRef.current;
    if (!queue || fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= queue.entries.length) return;
    if (toIndex < 0 || toIndex >= queue.entries.length) return;

    const nextEntries = [...queue.entries];
    const [moved] = nextEntries.splice(fromIndex, 1);
    nextEntries.splice(toIndex, 0, moved);

    let nextCurrentIndex = queue.currentIndex;
    if (fromIndex === queue.currentIndex) {
      nextCurrentIndex = toIndex;
    } else {
      if (fromIndex < queue.currentIndex && toIndex >= queue.currentIndex) {
        nextCurrentIndex -= 1;
      } else if (fromIndex > queue.currentIndex && toIndex <= queue.currentIndex) {
        nextCurrentIndex += 1;
      }
    }

    setPlaybackQueue({ ...queue, entries: nextEntries, currentIndex: nextCurrentIndex });
  }

  function clearQueue() {
    const queue = playbackQueueRef.current;
    if (!queue) {
      return;
    }

    const currentEntry = queue.entries[queue.currentIndex];
    if (!currentEntry) {
      return;
    }

    setPlaybackQueue({
      entries: [currentEntry],
      originalEntries: [currentEntry],
      currentIndex: 0,
      sourceLabel: 'Now Playing',
    });
    setStatus('Queue cleared.');
  }

  function likeAllQueueTracks() {
    const queue = playbackQueueRef.current;
    if (!queue || queue.entries.length === 0) {
      return;
    }

    const eventTime = Date.now();
    setListeningProfile((current) => {
      let nextProfile = current;

      queue.entries.forEach((entry) => {
        if (!isTrackLiked(nextProfile, entry.track.id)) {
          nextProfile = toggleTrackLike(nextProfile, entry.track, eventTime);
        }
      });

      return nextProfile;
    });
    setStatus(`Saved ${queue.entries.length} queue tracks to favorites.`);
  }

  async function removeOfflineTrack(trackId: number) {
    if (typeof window.kplayer?.deleteOfflineTrack !== 'function') {
      setOfflineTracks((current) => current.filter((track) => track.trackId !== trackId));
      return;
    }

    await window.kplayer.deleteOfflineTrack(trackId);
    setOfflineTracks((current) => current.filter((track) => track.trackId !== trackId));
    setStatus('Removed offline download.');
  }

  async function startDownload(target: DownloadTarget) {
    const request = downloadRequest;
    if (!request) {
      return;
    }

    if (typeof window.kplayer?.saveTrackDownload !== 'function') {
      setStatus('Downloads are only available in the desktop app.');
      setDownloadRequest(null);
      return;
    }

    let preferredDirectory = appSettings.diskDownloadFolder;
    if (target === 'disk' && (appSettings.askDiskFolderEveryTime || !preferredDirectory)) {
      if (typeof window.kplayer?.pickDownloadFolder !== 'function') {
        setStatus('Disk downloads are unavailable in this environment.');
        setDownloadRequest(null);
        return;
      }

      preferredDirectory = await window.kplayer.pickDownloadFolder();
      if (!preferredDirectory) {
        setStatus('Download cancelled.');
        setDownloadRequest(null);
        return;
      }
    }

    const jobId = `${request.sourceKind}-${Date.now()}`;
    const baseJob: DownloadJob = {
      id: jobId,
      sourceKind: request.sourceKind,
      title: request.title,
      subtitle: request.subtitle,
      coverUrl: request.coverUrl,
      target,
      format: appSettings.downloadFormat,
      status: 'queued',
      totalTracks: request.tracks.length,
      completedTracks: 0,
      failedTracks: 0,
      currentTrackTitle: request.tracks[0]?.title,
      currentTrackProgress: 0,
      currentTrackBytesReceived: 0,
      currentTrackBytesTotal: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    setDownloadJobs((current) => [baseJob, ...current].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 24));
    setIsDownloadsBubbleOpen(true);
    setDownloadRequest(null);

    let completedTracks = 0;
    let failedTracks = 0;
    let lastError = '';

    for (const track of request.tracks) {
      const trackTitle = track.title ?? `Track ${completedTracks + failedTracks + 1}`;

      updateDownloadJob(jobId, {
        status: 'downloading',
        completedTracks,
        failedTracks,
        currentTrackTitle: trackTitle,
        currentTrackProgress: 0,
        currentTrackBytesReceived: 0,
        currentTrackBytesTotal: 0,
        error: undefined,
      });

      try {
        const sourceQuality = DOWNLOAD_FORMATS[appSettings.downloadFormat].sourceQuality;
        const streamUrl = await getTrackUrl(track.id, sourceQuality);
        const result = await window.kplayer.saveTrackDownload({
          streamUrl,
          target,
          format: appSettings.downloadFormat,
          preferredDirectory: target === 'disk' ? preferredDirectory : '',
          track: getTrackDownloadPayload(track),
        }, (progress) => {
          const isTranscoding = progress.stage === 'transcoding';
          updateDownloadJob(jobId, {
            status: 'downloading',
            currentTrackTitle: trackTitle,
            currentTrackProgress: progress.progress,
            currentTrackBytesReceived: progress.bytesReceived,
            currentTrackBytesTotal: progress.totalBytes,
            currentTrackStage: isTranscoding ? 'transcoding' : 'downloading',
            completedTracks,
            failedTracks,
          });
        });

        if (result.cancelled) {
          setDownloadJobs((current) => current.filter((job) => job.id !== jobId));
          setStatus('Download cancelled.');
          return;
        }

        if (result.offlineTrack) {
          const offlineTrack = result.offlineTrack;
          setOfflineTracks((current) => [offlineTrack, ...current.filter((entry) => entry.trackId !== offlineTrack.trackId)]);
        }

        completedTracks += 1;
      } catch (error) {
        failedTracks += 1;
        lastError = error instanceof Error ? error.message : 'Download failed';
        updateDownloadJob(jobId, {
          status: 'failed',
          completedTracks,
          failedTracks,
          currentTrackTitle: trackTitle,
          currentTrackProgress: 0,
          currentTrackBytesReceived: 0,
          currentTrackBytesTotal: 0,
          error: lastError,
        });
      }

      updateDownloadJob(jobId, {
        completedTracks,
        failedTracks,
      });
    }

    if (target === 'app') {
      await refreshOfflineTracks();
    }

    if (target === 'disk' && preferredDirectory && preferredDirectory !== appSettings.diskDownloadFolder) {
      setAppSettings((current) => ({
        ...current,
        diskDownloadFolder: preferredDirectory,
      }));
    }

    const nextStatus = failedTracks > 0 ? 'failed' : 'completed';

    if (nextStatus === 'completed') {
      updateDownloadJob(jobId, {
        status: 'completed',
        completedTracks,
        failedTracks,
        currentTrackProgress: 1,
        currentTrackBytesReceived: 0,
        currentTrackBytesTotal: 0,
        currentTrackTitle: undefined,
        error: undefined,
      });
    } else {
      updateDownloadJob(jobId, {
        status: 'failed',
        completedTracks,
        failedTracks,
        currentTrackProgress: 0,
        currentTrackBytesReceived: 0,
        currentTrackBytesTotal: 0,
        error: lastError || `${failedTracks} tracks failed.`,
      });
    }

    setStatus(
      failedTracks > 0
        ? `${completedTracks} downloaded, ${failedTracks} failed.`
        : target === 'app'
          ? `${completedTracks} ${completedTracks === 1 ? 'track saved inside kPlayer.' : 'tracks saved inside kPlayer.'}`
          : `${completedTracks} ${completedTracks === 1 ? 'track saved to disk.' : 'tracks saved to disk.'}`,
    );
  }

  async function chooseDiskDownloadFolder() {
    if (typeof window.kplayer?.pickDownloadFolder !== 'function') {
      setStatus('Folder selection is only available in the desktop app.');
      return;
    }

    const nextFolder = await window.kplayer.pickDownloadFolder();
    if (!nextFolder) {
      return;
    }

    setAppSettings((current) => ({
      ...current,
      diskDownloadFolder: nextFolder,
      askDiskFolderEveryTime: false,
    }));
  }

  function resetDownloadPreferences() {
    setAppSettings((current) => ({
      ...current,
      downloadFormat: defaultAppSettings.downloadFormat,
      defaultDownloadTarget: defaultAppSettings.defaultDownloadTarget,
      diskDownloadFolder: defaultAppSettings.diskDownloadFolder,
      askDiskFolderEveryTime: defaultAppSettings.askDiskFolderEveryTime,
    }));
  }

  function seekToPosition(nextPosition: number) {
    setPosition(nextPosition);
    if (audioRef.current) {
      audioRef.current.currentTime = nextPosition;
    }
  }

  function seekLyricsAndResume(nextPosition: number) {
    seekToPosition(nextPosition);
    if (audioRef.current) {
      void audioRef.current.play();
    }
  }

  function getEffectivePlaybackDuration(track?: QobuzTrack | null) {
    const audioDuration = audioRef.current?.duration;
    if (typeof audioDuration === 'number' && Number.isFinite(audioDuration) && audioDuration > 0) {
      return audioDuration;
    }

    const trackDuration = track?.duration;
    return typeof trackDuration === 'number' && Number.isFinite(trackDuration) && trackDuration > 0 ? trackDuration : 0;
  }

  function getQualifiedListenThreshold(totalSeconds: number) {
    return Math.min(30, totalSeconds * 0.33);
  }

  function resetPlaybackLearning(trackId: number | null) {
    playbackLearningRef.current = createPlaybackLearningState(trackId);
  }

  function registerSkipIfNeeded(nextTrackId?: number) {
    const currentTrack = pendingTrackRef.current;
    const audio = audioRef.current;
    if (!currentTrack || !audio) {
      return;
    }

    if (typeof nextTrackId === 'number' && currentTrack.id === nextTrackId) {
      return;
    }

    const learning = playbackLearningRef.current;
    const elapsed = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const total = getEffectivePlaybackDuration(currentTrack);
    const threshold = getQualifiedListenThreshold(total);
    if (learning.skipRecorded || learning.qualifiedRecorded || learning.completionRecorded) {
      return;
    }

    if (elapsed >= 6 && (threshold <= 0 || elapsed < threshold)) {
      const additional = Math.max(0, elapsed - learning.accountedSeconds);
      learning.skipRecorded = true;
      learning.accountedSeconds = Math.max(learning.accountedSeconds, elapsed);
      setListeningProfile((current: ListeningProfile) => recordTrackSkip(current, currentTrack, Date.now(), additional));
    }
  }

  function toggleCurrentTrackLike() {
    if (!nowPlaying) {
      return;
    }

    setListeningProfile((current: ListeningProfile) => toggleTrackLike(current, nowPlaying, Date.now()));
  }

  function toggleArtistFavorites() {
    if (!artistPage || artistTracks.length === 0) {
      return;
    }

    toggleTrackCollectionLike(
      artistTracks,
      artistPage.artist.name ?? (currentPage.kind === 'artist' ? currentPage.artistName : 'artist'),
    );
  }

  function toggleAlbumFavorites() {
    if (!album || albumTracks.length === 0) {
      return;
    }

    toggleTrackCollectionLike(albumTracks, album.title ?? 'album');
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      if (!audio.src && nowPlaying) {
        const resumePos = restoredPositionRef.current;
        restoredPositionRef.current = null;
        void startPlayback(nowPlaying).then(() => {
          if (resumePos && resumePos > 0 && audioRef.current) {
            audioRef.current.currentTime = resumePos;
            setPosition(resumePos);
          }
        });
        return;
      }
      void audio.play();
      return;
    }

    audio.pause();
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = query.trim();
    if (!normalized) {
      return;
    }

    setSearchHistory((current) => mergeSearchHistory(current, normalized));
    setIsSearchHistoryOpen(false);
    openSearch(normalized);
  }

  function clearSearch() {
    setIsSearchHistoryOpen(false);
    setQuery('');
    setResults({ artists: [], tracks: [], albums: [] });
    setAlbum(null);
    setArtistPage(null);
    goHome();
  }

  function showSearchHistory() {
    if (searchHistory.length > 0) {
      setIsSearchHistoryOpen(true);
    }
  }

  function selectSearchHistory(queryText: string) {
    const normalized = queryText.trim();
    if (!normalized) {
      return;
    }

    setQuery(normalized);
    setSearchHistory((current) => mergeSearchHistory(current, normalized));
    setIsSearchHistoryOpen(false);
    openSearch(normalized);
  }

  function removeSearchHistoryEntry(queryText: string) {
    setSearchHistory((current) => current.filter((entry) => normalizeText(entry) !== normalizeText(queryText)));
  }

  function clearSearchHistory() {
    setSearchHistory([]);
    setIsSearchHistoryOpen(false);
  }

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = volume;
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      setPosition(audio.currentTime);

      const track = pendingTrackRef.current;
      if (!track) {
        return;
      }

      if (playbackLearningRef.current.trackId !== track.id) {
        resetPlaybackLearning(track.id);
      }

      const learning = playbackLearningRef.current;
      const elapsed = audio.currentTime;
      const total = getEffectivePlaybackDuration(track);
      const threshold = getQualifiedListenThreshold(total);

      if (!learning.qualifiedRecorded && threshold > 0 && elapsed >= threshold) {
        const additional = Math.max(0, elapsed - learning.accountedSeconds);
        learning.qualifiedRecorded = true;
        learning.accountedSeconds = Math.max(learning.accountedSeconds, elapsed);
        setListeningProfile((current: ListeningProfile) => recordListen(current, track, Date.now(), additional));
      }

      if (!learning.completionRecorded && total > 0 && elapsed >= total * 0.92) {
        const additional = Math.max(0, total - learning.accountedSeconds);
        learning.completionRecorded = true;
        learning.accountedSeconds = Math.max(learning.accountedSeconds, total);
        setListeningProfile((current: ListeningProfile) => recordTrackCompletion(current, track, Date.now(), additional));
      }
    };
    const handleDurationChange = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);

      const track = pendingTrackRef.current;
      if (!track) {
        return;
      }

      const learning = playbackLearningRef.current;
      const total = getEffectivePlaybackDuration(track);
      if (!learning.completionRecorded && total > 0) {
        const additional = Math.max(0, total - learning.accountedSeconds);
        learning.completionRecorded = true;
        learning.accountedSeconds = Math.max(learning.accountedSeconds, total);
        setListeningProfile((current: ListeningProfile) => recordTrackCompletion(current, track, Date.now(), additional));
      }

      void playNextTrackRef.current(true);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);

  useEffect(() => {
    playQueueIndexRef.current = playQueueIndex;
  }, [playQueueIndex]);

  useEffect(() => {
    playNextTrackRef.current = playNextTrack;
  }, [playNextTrack]);

  useEffect(() => {
    void refreshOfflineTracks();
  }, []);

  useEffect(() => {
    if (typeof window.kplayer?.checkForUpdate === 'function') {
      void window.kplayer.checkForUpdate().then((info) => {
        if (info) setAvailableUpdate({ latestVersion: info.latestVersion, downloadUrl: info.downloadUrl });
      });
    }
  }, []);

  useEffect(() => {
    if (!nowPlaying) {
      setIsFullscreenPlayerOpen(false);
      resetPlaybackLearning(null);
    }
  }, [nowPlaying]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  // Persist volume to settings (debounced so we don't thrash storage during drag)
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setAppSettings((current) => (current.defaultVolume === volume ? current : { ...current, defaultVolume: volume }));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [volume]);

  useEffect(() => {
    saveAppSettings(appSettings);
  }, [appSettings]);

  useEffect(() => {
    saveDownloadJobs(downloadJobs);
  }, [downloadJobs]);

  useEffect(() => {
    savePlaylists(playlists);
  }, [playlists]);

  useEffect(() => {
    if (nowPlaying && playbackQueue) {
      const tracks = playbackQueue.originalEntries.map((e) => e.track);
      saveLastSession({
        nowPlaying,
        queue: { tracks, currentIndex: playbackQueue.currentIndex, sourceLabel: playbackQueue.sourceLabel },
        position,
        duration,
      });
    }
  }, [nowPlaying, playbackQueue]);

  useEffect(() => {
    function handleBeforeUnload() {
      if (nowPlaying && playbackQueue) {
        const tracks = playbackQueue.originalEntries.map((e) => e.track);
        saveLastSession({
          nowPlaying,
          queue: { tracks, currentIndex: playbackQueue.currentIndex, sourceLabel: playbackQueue.sourceLabel },
          position: audioRef.current?.currentTime ?? position,
          duration,
        });
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nowPlaying, playbackQueue, position, duration]);

  // Pull account-scoped data from PocketBase on login and render the remote
  // state as the source of truth before any local pushes are allowed.
  useEffect(() => {
    if (!authUserId) {
      setSyncReadyUserId(null);
      return;
    }

    clearAccountScopedState();
    setSyncReadyUserId(null);
    setStatus('Sincronizando conta...');

    let cancelled = false;
    (async () => {
      try {
        const [remotePlaylists, remoteState, remoteRecents, remoteLiked] = await Promise.all([
          pullPlaylistsFromRemote(),
          pullUserState(),
          pullRecentsFromRemote(),
          pullLikedTracksFromRemote(),
        ]);
        if (cancelled) return;

        const baseProfile = remoteState?.listeningProfile ?? createEmptyProfile();
        const nextProfile = {
          ...baseProfile,
          recents: remoteRecents.length > 0 ? remoteRecents : baseProfile.recents,
          trackSignals: remoteLiked.length > 0 ? mergeLikedIntoSignals(baseProfile.trackSignals, remoteLiked) : baseProfile.trackSignals,
        };
        setPlaylists(remotePlaylists.slice(0, PLAYLIST_LIMIT));
        setListeningProfile(nextProfile);
        setHomeFeed(buildHomeFeed(nextProfile, []));
        setSyncedRecommendationSeedQueries(remoteState?.recommendations?.seedQueries ?? []);
        if (remoteState?.appSettings) {
          setAppSettings((current) => ({ ...current, ...remoteState.appSettings }));
        }

        // Mark pull complete only AFTER the remote state is committed. This
        // unlocks the push effects below.
        setSyncReadyUserId(authUserId);
        setStatus('Conta sincronizada.');
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Falha ao sincronizar conta.';
          setStatus(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUserId]);

  // Debounced push of playlists to PocketBase whenever they change (only when authed)
  const playlistPushTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!authUserId) return;
    if (syncReadyUserId !== authUserId) return; // wait until first pull is done
    if (playlistPushTimerRef.current !== null) {
      window.clearTimeout(playlistPushTimerRef.current);
    }
    playlistPushTimerRef.current = window.setTimeout(() => {
      playlistPushTimerRef.current = null;
      void pushPlaylistsToRemote(playlists).catch((error) => {
        const message = error instanceof Error ? error.message : 'Falha ao enviar playlists.';
        setStatus(message);
      });
    }, 1200);
    return () => {
      if (playlistPushTimerRef.current !== null) {
        window.clearTimeout(playlistPushTimerRef.current);
        playlistPushTimerRef.current = null;
      }
    };
  }, [playlists, authUserId, syncReadyUserId]);

  // Debounced push of settings + listening profile to PocketBase
  const userStatePushTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!authUserId) return;
    if (syncReadyUserId !== authUserId) return;
    if (userStatePushTimerRef.current !== null) {
      window.clearTimeout(userStatePushTimerRef.current);
    }
    userStatePushTimerRef.current = window.setTimeout(() => {
      userStatePushTimerRef.current = null;
      void Promise.all([
        pushUserState({
          appSettings,
          listeningProfile,
          recommendations: {
            seedQueries: syncedRecommendationSeedQueries,
            updatedAt: Date.now(),
          },
        }),
        pushRecentsToRemote(listeningProfile.recents),
        pushLikedTracksToRemote(extractLikedTracks(listeningProfile.trackSignals)),
      ]).catch((error) => {
        const message = error instanceof Error ? error.message : 'Falha ao enviar dados.';
        setStatus(message);
      });
    }, 2000);
    return () => {
      if (userStatePushTimerRef.current !== null) {
        window.clearTimeout(userStatePushTimerRef.current);
        userStatePushTimerRef.current = null;
      }
    };
  }, [appSettings, listeningProfile, authUserId, syncReadyUserId, syncedRecommendationSeedQueries]);

  useEffect(() => {
    if (hasIntroducedDownloadsBubble) {
      return;
    }

    const timer = window.setTimeout(() => {
      setIsDownloadsBubbleOpen(true);
      setHasIntroducedDownloadsBubble(true);
      window.localStorage.setItem('kplayer.downloadsBubbleIntroduced', '1');
    }, 600);

    return () => window.clearTimeout(timer);
  }, [hasIntroducedDownloadsBubble]);

  useEffect(() => {
    if (!isDownloadsBubbleOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!downloadsBubbleRef.current?.contains(target)) {
        setIsDownloadsBubbleOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDownloadsBubbleOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDownloadsBubbleOpen]);

  useEffect(() => {
    setIsArtistBioExpanded(false);
  }, [currentPage.kind === 'artist' ? currentPage.artistId : null]);

  useEffect(() => {
    if (currentPage.kind !== 'album' || !album?.artist?.name) {
      setAlbumSidebarAlbums([]);
      return;
    }

    const cacheKey = currentPage.albumId;
    const cached = albumSidebarCache.current.get(cacheKey);
    if (cached) {
      setAlbumSidebarAlbums(cached);
      return;
    }

    let cancelled = false;
    setAlbumSidebarAlbums([]);

    void (async () => {
      try {
        const data = await searchQobuz(album.artist?.name ?? '');
        if (cancelled) {
          return;
        }

        const nextAlbums = buildAlbumSidebarAlbums(data, album);
        albumSidebarCache.current.set(cacheKey, nextAlbums);
        setAlbumSidebarAlbums(nextAlbums);
      } catch {
        if (!cancelled) {
          setAlbumSidebarAlbums([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [album, currentPage]);

  useEffect(() => {
    saveListeningProfile(listeningProfile);
  }, [listeningProfile]);

  useEffect(() => {
    if (currentPage.kind === 'home') {
      document.title = 'kPlayer';
      return;
    }

    if (currentPage.kind === 'search') {
      document.title = `Search: ${currentPage.query} • kPlayer`;
      return;
    }

    if (currentPage.kind === 'library') {
      document.title = 'Library • kPlayer';
      return;
    }

    if (currentPage.kind === 'playlist') {
      const playlistTitle = playlists.find((entry) => entry.id === currentPage.playlistId)?.name ?? 'Playlist';
      document.title = `${playlistTitle} • kPlayer`;
      return;
    }

    if (currentPage.kind === 'settings') {
      document.title = 'Settings • kPlayer';
      return;
    }

    if (currentPage.kind === 'artist') {
      document.title = `${artistPage?.artist.name ?? currentPage.artistName} • kPlayer`;
      return;
    }

    document.title = `${album?.title ?? 'Album'} • kPlayer`;
  }, [album?.title, artistPage?.artist.name, currentPage, playlists]);

  useEffect(() => {
    if (typeof window.kplayer?.setDiscordPresence !== 'function') {
      return;
    }

    void window.kplayer.setDiscordPresence({
      details: 'Ouvindo monochrome',
      state: nowPlaying
        ? `${nowPlaying.title ?? 'Untitled track'} - ${nowPlayingArtistName}${isPlaying ? '' : ' (pausado)'}`
        : 'Escolhendo a próxima música',
      trackTitle: nowPlaying?.title ?? '',
      artistName: nowPlaying ? nowPlayingArtistName : '',
      albumTitle: nowPlaying ? nowPlayingAlbumTitle : '',
      coverUrl: nowPlaying ? nowPlayingDiscordCoverUrl : '',
      isPlaying: Boolean(nowPlaying && isPlaying),
      positionSeconds: nowPlaying && isPlaying ? discordPresencePositionBucket * 5 : Math.max(0, Math.floor(position)),
      durationSeconds: nowPlaying ? discordPresenceDurationSeconds : 0,
    });
  }, [discordPresenceDurationSeconds, discordPresencePositionBucket, isPlaying, nowPlaying?.id, nowPlaying?.title, nowPlayingAlbumTitle, nowPlayingArtistName, nowPlayingDiscordCoverUrl, position]);

  useEffect(() => () => {
    if (typeof window.kplayer?.clearDiscordPresence === 'function') {
      void window.kplayer.clearDiscordPresence();
    }
  }, []);

  const homeFeedLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Use a longer debounce if we already have a feed, shorter for first load
    const delay = homeFeedLoadedRef.current ? 8000 : 400;
    const timeout = setTimeout(() => {
      void loadHomeRecommendations();
    }, delay);

    async function loadHomeRecommendations() {
      const insights = buildListeningInsights(listeningProfile);
      const baseSeeds = buildRecommendationSeeds(insights);

      // Augment seeds with artists frequent in the user's playlists (only impacts Recommended Songs)
      const playlistArtistCounts = new Map<string, { name: string; count: number }>();
      for (const playlist of playlists) {
        for (const track of playlist.tracks) {
          const name = track.performer?.name?.trim();
          if (!name) continue;
          const key = name.toLowerCase();
          const entry = playlistArtistCounts.get(key);
          if (entry) {
            entry.count += 1;
          } else {
            playlistArtistCounts.set(key, { name, count: 1 });
          }
        }
      }
      const playlistSeeds: RecommendationSeed[] = [...playlistArtistCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 6)
        .map(({ name, count }) => ({
          key: `playlist-artist:${name.toLowerCase()}`,
          query: name,
          kind: 'artist' as const,
          weight: Math.min(3.5, 1.5 + count * 0.25),
          source: 'taste-artist' as const,
        }));

      // Also use liked track artists as strong recommendation signals
      const likedSignals = listeningProfile.trackSignals.filter((s) => s.isLiked);
      const likedArtistCounts = new Map<string, { name: string; count: number }>();
      for (const signal of likedSignals) {
        const name = signal.performer?.name?.trim() ?? signal.album?.artist?.name?.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const entry = likedArtistCounts.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          likedArtistCounts.set(key, { name, count: 1 });
        }
      }
      const likedSeeds: RecommendationSeed[] = [...likedArtistCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map(({ name, count }) => ({
          key: `liked-artist:${name.toLowerCase()}`,
          query: name,
          kind: 'artist' as const,
          weight: Math.min(6.0, 3.0 + count * 0.7),
          source: 'taste-artist' as const,
        }));

      const seeds = [...baseSeeds, ...likedSeeds, ...playlistSeeds];
      const uniqueSeeds = seeds.filter(
        (seed: RecommendationSeed, index: number, collection: RecommendationSeed[]) =>
          collection.findIndex((entry: RecommendationSeed) => entry.query.toLowerCase() === seed.query.toLowerCase()) === index,
      );

      if (uniqueSeeds.length === 0) {
        setIsHomeLoading(false);
        return;
      }

      setIsHomeLoading(true);

      const loadSeedResults = async (seedsToLoad: RecommendationSeed[]) => {
        const settled = await Promise.allSettled(
          seedsToLoad.map(async (seed): Promise<SeedResult> => {
            const cached = searchCache.current.get(seed.query);
            if (cached) {
              return { seed, artists: cached.artists, tracks: cached.tracks, albums: cached.albums };
            }

            const data = await searchQobuz(seed.query);
            const mapped = {
              artists: data.artists?.items ?? [],
              tracks: data.tracks?.items ?? [],
              albums: data.albums?.items ?? [],
            } satisfies SearchResults;

            searchCache.current.set(seed.query, mapped);
            return { seed, ...mapped };
          }),
        );

        if (cancelled) {
          return null;
        }

        return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      };

      const primaryResults = await loadSeedResults(uniqueSeeds);

      if (!primaryResults) {
        return;
      }

      // Show primary results immediately while discovery loads in background
      const primaryFeed = buildHomeFeed(listeningProfile, primaryResults);
      if (!cancelled) {
        startTransition(() => {
          setHomeFeed(primaryFeed);
        });
        setIsHomeLoading(false);
        homeFeedLoadedRef.current = true;
      }

      const knownArtists = new Set(
        [
          ...uniqueSeeds.map((seed: RecommendationSeed) => seed.query),
          ...listeningProfile.plays.map((play: PlayedTrack) => play.performer?.name ?? play.album?.artist?.name),
        ]
          .map((value) => normalizeText(value))
          .filter((value) => value.length > 0),
      );

      const discoveryLimit = insights.stage >= 3 ? 6 : insights.stage >= 2 ? 4 : 2;
      const discoverySeedMap = new Map<string, RecommendationSeed>();

      const pushDiscoverySeed = (name: string | undefined, weight: number) => {
        const query = name?.trim();
        if (!query) {
          return;
        }

        const normalized = normalizeText(query);
        if (!normalized || knownArtists.has(normalized)) {
          return;
        }

        const nextSeed: RecommendationSeed = {
          key: `discovery-artist:${normalized}`,
          query,
          kind: 'artist',
          weight: Math.max(weight, 1),
          source: 'discovery-artist',
        };

        const current = discoverySeedMap.get(normalized);
        if (!current || nextSeed.weight > current.weight) {
          discoverySeedMap.set(normalized, nextSeed);
        }
      };

      const similarArtistSettled = window.kplayer?.getSimilarArtists
        ? await Promise.allSettled(
            primaryResults
              .filter(({ seed }) => seed.source === 'taste-artist')
              .map(async ({ seed, artists }) => {
                const matchedArtist =
                  artists.find((artist: QobuzArtist) => normalizeText(artist.name) === normalizeText(seed.query)) ??
                  artists[0] ??
                  seed.query;

                return {
                  seed,
                  artists: await window.kplayer?.getSimilarArtists?.(matchedArtist),
                };
              }),
          )
        : [];

      if (cancelled) {
        return;
      }

      similarArtistSettled
        .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
        .forEach(({ seed, artists }) => {
          (artists ?? []).slice(0, 3).forEach((artistName, index) => {
            pushDiscoverySeed(artistName, seed.weight - 0.85 - index * 0.22);
          });
        });

      if (discoverySeedMap.size < discoveryLimit) {
        primaryResults.forEach(({ seed, artists }) => {
          artists.slice(0, 6).forEach((artist: QobuzArtist, index: number) => {
            pushDiscoverySeed(artist.name, seed.weight - 1.3 - index * 0.24);
          });
        });
      }

      const discoverySeeds = [...discoverySeedMap.values()]
        .sort((left, right) => right.weight - left.weight)
        .slice(0, discoveryLimit);

      const discoveryResults = discoverySeeds.length > 0 ? await loadSeedResults(discoverySeeds) : [];

      if (cancelled) {
        return;
      }

      if (discoveryResults && discoveryResults.length > 0) {
        const successfulResults = [...primaryResults, ...discoveryResults];
        const nextHomeFeed = buildHomeFeed(listeningProfile, successfulResults);
        if (!areStringListsEqual(nextHomeFeed.seedQueries, syncedRecommendationSeedQueries)) {
          setSyncedRecommendationSeedQueries(nextHomeFeed.seedQueries);
        }
        startTransition(() => {
          setHomeFeed(nextHomeFeed);
        });
      } else {
        if (!areStringListsEqual(primaryFeed.seedQueries, syncedRecommendationSeedQueries)) {
          setSyncedRecommendationSeedQueries(primaryFeed.seedQueries);
        }
      }
    }

    void loadHomeRecommendations();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [listeningProfile, playlists]);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentPage() {
      if (currentPage.kind === 'home') {
        setIsLoading(false);
        setAlbum(null);
        setArtistPage(null);
        return;
      }

      if (currentPage.kind === 'library' || currentPage.kind === 'settings' || currentPage.kind === 'playlist') {
        setIsLoading(false);
        setAlbum(null);
        setArtistPage(null);
        return;
      }

      if (currentPage.kind === 'search') {
        setQuery(currentPage.query);
        setAlbum(null);
        setArtistPage(null);
        setResults({ artists: [], tracks: [], albums: [] });

        const cached = searchCache.current.get(currentPage.query);
        if (cached) {
          setResults(cached);
          setStatus(`${cached.artists.length} artists • ${cached.albums.length} albums • ${cached.tracks.length} tracks`);
          return;
        }

        setIsLoading(true);
        setStatus(`Searching for "${currentPage.query}"...`);

        try {
          const data = await searchQobuz(currentPage.query);
          if (cancelled) {
            return;
          }

          const nextResults = {
            artists: data.artists?.items ?? [],
            tracks: data.tracks?.items ?? [],
            albums: data.albums?.items ?? [],
          } satisfies SearchResults;

          searchCache.current.set(currentPage.query, nextResults);
          startTransition(() => {
            setResults(nextResults);
            setStatus(
              nextResults.artists.length || nextResults.albums.length || nextResults.tracks.length
                ? `${nextResults.artists.length} artists • ${nextResults.albums.length} albums • ${nextResults.tracks.length} tracks`
                : 'No results found for this search.',
            );
          });
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : 'Search failed';
            setResults({ artists: [], tracks: [], albums: [] });
            setStatus(message);
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }

        return;
      }

      if (currentPage.kind === 'artist') {
        setAlbum(null);
        setArtistPage(null);

        const cacheKey = `${currentPage.artistId}:${currentPage.artistName}`;
        const cached = artistCache.current.get(cacheKey);
        if (cached) {
          setArtistPage(cached);
          setStatus(`Artist loaded: ${cached.artist.name ?? currentPage.artistName}`);
          return;
        }

        setIsLoading(true);
        setStatus('Loading artist...');

        try {
          const data = await searchQobuz(currentPage.artistName);
          if (cancelled) {
            return;
          }

          let nextArtistPage = buildArtistPageData(data, currentPage.artistId, currentPage.artistName);

          if (typeof window.kplayer?.getArtistProfile === 'function') {
            try {
              const extras = await window.kplayer.getArtistProfile({
                id: nextArtistPage.artist.id,
                name: nextArtistPage.artist.name,
                slug: nextArtistPage.artist.slug,
              });

              nextArtistPage = {
                ...nextArtistPage,
                description: extras?.description?.trim(),
                qobuzUrl: extras?.url,
              };
            } catch {
              // Keep artist page usable even if the biography fetch fails.
            }
          }

          artistCache.current.set(cacheKey, nextArtistPage);
          setArtistPage(nextArtistPage);
          setStatus(`Artist loaded: ${nextArtistPage.artist.name ?? currentPage.artistName}`);
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : 'Artist loading failed';
            setArtistPage(null);
            setStatus(message);
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }

        return;
      }

      setAlbum(null);
      setArtistPage(null);

      const cached = albumCache.current.get(currentPage.albumId);
      if (cached) {
        setAlbum(cached);
        setStatus(`Album loaded: ${cached.title ?? 'Untitled'}`);
        return;
      }

      setIsLoading(true);
      setStatus('Loading album...');

      try {
        const data = normalizeAlbumDetail(await getAlbum(currentPage.albumId));
        if (cancelled) {
          return;
        }

        albumCache.current.set(currentPage.albumId, data);
        setAlbum(data);
        setStatus(`Album loaded: ${data.title ?? 'Untitled'}`);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Album loading failed';
          setAlbum(null);
          setStatus(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadCurrentPage();

    return () => {
      cancelled = true;
    };
  }, [currentPage]);

  const albumMeta = album
    ? [
        formatFullDate(album.release_date_original),
        `${albumTracks.length || album.tracks_count || 0} tracks`,
        album.duration ? formatAlbumLength(album.duration) : undefined,
      ]
        .filter(Boolean)
        .join(' • ')
    : '';

  const albumQuality = album
    ? album.hires && album.maximum_bit_depth > 0 && album.maximum_sampling_rate > 0
      ? `${album.maximum_bit_depth}-bit / ${album.maximum_sampling_rate} kHz • Hi-Res FLAC`
      : 'FLAC / CD quality'
    : '';

  const isDetailPage = currentPage.kind === 'artist' || currentPage.kind === 'album';

  const artistTracks = artistPage?.tracks ?? [];
  const artistAlbums = artistPage?.albums ?? [];
  const artistTrackColumns = splitIntoColumns(artistTracks, 3);
  const artistHeroImage = getCover(artistPage?.artist.image?.large ?? artistPage?.artist.image?.thumbnail, artistPage?.artist.name);
  const artistDescription = artistPage?.description?.trim() ?? '';
  const artistDescriptionCollapsed = artistDescription.length > 320 && !isArtistBioExpanded;
  const visibleArtistDescription = artistDescriptionCollapsed ? `${artistDescription.slice(0, 320).trim()}...` : artistDescription;
  const artistQobuzUrl = artistPage?.qobuzUrl;
  const artistReleaseCount = artistPage?.artist.albums_count ?? artistAlbums.length;
  const albumCoverUrl = getBestImageUrl(album?.image);
  const albumCover = getCover(albumCoverUrl, album?.title);
  const albumArtistName = album?.artist?.name ?? 'Unknown artist';
  const albumCopyright = albumTracks.find((track) => track.copyright)?.copyright;
  const albumFactLines = [albumQuality, album?.label?.name ? `Label: ${album.label.name}` : undefined].filter(Boolean);
  const nowPlayingCoverUrl =
    getBestImageUrl(nowPlaying?.album?.image) ??
    (currentPage.kind === 'album' ? albumCoverUrl : undefined);
  const nowPlayingOfflineRecord = nowPlaying ? offlineTrackById.get(nowPlaying.id) : undefined;
  const fullscreenQualityLabel = nowPlayingOfflineRecord
    ? getDownloadFormatLabel(nowPlayingOfflineRecord.format)
    : getAudioQualityLabel(appSettings.streamQuality);
  const currentLibraryTab = currentPage.kind === 'library' ? currentPage.tab : 'favorites';
  const currentSettingsTab = currentPage.kind === 'settings' ? currentPage.tab : 'playback';
  const recentLibraryTracks: PlayedTrack[] = listeningProfile.plays.slice(0, 18);
  const favoriteTrackSignals = [...listeningProfile.trackSignals]
    .filter((signal) => signal.isLiked)
    .sort((left, right) => right.lastInteractedAt - left.lastInteractedAt);
  const favoriteTracks = favoriteTrackSignals.map(trackSignalToTrack);
  const favoriteTrackColumns = splitIntoColumns(favoriteTracks, 3);
  const homeRecentTracks = homeFeed.recents.map(playedTrackToTrack);
  const homeRecentColumns = splitIntoColumns(homeRecentTracks, 3);
  const recentLibraryPlayableTracks = recentLibraryTracks.map(playedTrackToTrack);
  const offlinePlayableTracks = offlineTracks.map(offlineTrackToTrack);
  const downloadsCoverMosaic = offlineTracks
    .map((t) => t.coverUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, 4);
  const downloadsPlaylist: Playlist | null = offlineTracks.length > 0
    ? {
        id: DOWNLOADS_PLAYLIST_ID,
        name: 'Downloaded Songs',
        description: 'All tracks saved for offline listening',
        coverUrl: undefined,
        tracks: offlineTracks.map((t) => ({
          id: t.trackId,
          title: t.title,
          duration: t.duration,
          hires: (DOWNLOAD_FORMATS[t.format]?.sourceQuality ?? '27') !== '5',
          performer: t.artistName ? { id: -1, name: t.artistName } : undefined,
          album: {
            id: t.albumId,
            title: t.albumTitle,
            image: t.coverUrl ? { large: t.coverUrl, thumbnail: t.coverUrl } : undefined,
          },
          addedAt: t.downloadedAt,
        })),
        createdAt: offlineTracks[offlineTracks.length - 1]?.downloadedAt ?? Date.now(),
        updatedAt: offlineTracks[0]?.downloadedAt ?? Date.now(),
      }
    : null;
  const queueEntries = playbackQueue?.entries ?? [];
  const queuePanelItems = queueEntries.map((entry, index) => ({
    queueId: entry.queueId,
    track: entry.track,
    isCurrent: index === (playbackQueue?.currentIndex ?? -1),
    isLiked: isTrackLiked(listeningProfile, entry.track.id),
  }));
  const queueTitle = playbackQueue?.sourceLabel ? `${playbackQueue.sourceLabel} Queue` : 'Queue';
  const isQueuePanelOpen = sidePanelView === 'queue';
  const isLyricsPanelOpen = sidePanelView === 'lyrics';
  const artistFavoritesActive = artistTracks.length > 0 && artistTracks.every((track) => isTrackLiked(listeningProfile, track.id));
  const albumFavoritesActive = albumTracks.length > 0 && albumTracks.every((track) => isTrackLiked(listeningProfile, track.id));
  const downloadBubbleJobs = downloadJobs.slice(0, 6);
  const downloadBubbleProgress = getDownloadAggregateProgress(inProgressDownloadJobs);
  const downloadBubbleLabel = inProgressDownloadJobs.length > 0
    ? `${inProgressDownloadJobs.length} download${inProgressDownloadJobs.length === 1 ? '' : 's'} in progress`
    : downloadBubbleJobs.length > 0
      ? 'Recent downloads'
      : 'Downloads';
  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? (() => {
        switch (contextMenu.target.kind) {
          case 'track': {
            const track = contextMenu.target.track;
            const trackArtist = track.performer ?? track.album?.artist ?? null;
            const liked = isTrackLiked(listeningProfile, track.id);
            const items: ContextMenuItem[] = [
              {
                key: 'toggle-like',
                label: liked ? 'Unlike' : 'Like',
                onSelect: () => {
                  toggleTrackLikeFromMenu(track);
                  closeContextMenu();
                },
              },
            ];

            items.push({
              key: 'play-next',
              label: 'Play next',
              onSelect: () => {
                queueTracksNext([track], 'Queue');
                closeContextMenu();
              },
            });

            items.push({
              key: 'add-to-queue',
              label: 'Add to queue',
              onSelect: () => {
                appendTracksToQueue([track], 'Queue');
                closeContextMenu();
              },
            });

            // Add to playlist
            items.push({
              key: 'add-to-playlist',
              label: 'Add to playlist',
              onSelect: () => {
                closeContextMenu();
                setPlaylistPickerSearch('');
                setAddToPlaylistTrack(track);
              },
            });

            if (trackArtist?.id && trackArtist.name) {
              items.push({ key: 'separator-nav', separator: true });
              items.push({
                key: 'go-to-artist',
                label: 'Go to artist',
                onSelect: () => {
                  closeContextMenu();
                  openArtist(trackArtist);
                },
              });
            }

            if (track.album?.id) {
              if (!trackArtist?.id) {
                items.push({ key: 'separator-nav', separator: true });
              }
              items.push({
                key: 'go-to-album',
                label: 'Go to album',
                onSelect: () => {
                  closeContextMenu();
                  void openAlbum(track.album?.id);
                },
              });
            }

            items.push({
              key: 'download',
              label: 'Download',
              onSelect: () => {
                closeContextMenu();
                openTrackDownload(track);
              },
            });

            if (track.album?.url) {
              items.push({ key: 'separator-open', separator: true });
              items.push({
                key: 'open-in-qobuz',
                label: 'Open on Qobuz',
                onSelect: () => {
                  closeContextMenu();
                  openExternalUrl(track.album?.url);
                },
              });
            }

            return items;
          }

          case 'album': {
            const albumEntry = contextMenu.target.album;
            const items: ContextMenuItem[] = [];

            if (albumEntry.id) {
              items.push({
                key: 'go-to-album',
                label: 'Go to album',
                onSelect: () => {
                  closeContextMenu();
                  void openAlbum(albumEntry.id);
                },
              });
            }

            if (albumEntry.artist?.id && albumEntry.artist.name) {
              items.push({
                key: 'go-to-artist',
                label: 'Go to artist',
                onSelect: () => {
                  closeContextMenu();
                  openArtist(albumEntry.artist);
                },
              });
            }

            if (albumEntry.id) {
              items.push({
                key: 'download',
                label: 'Download',
                onSelect: () => {
                  closeContextMenu();
                  void openAlbumDownloadFromMenu(albumEntry);
                },
              });
            }

            if (albumEntry.url) {
              items.push({ key: 'separator-open', separator: true });
              items.push({
                key: 'open-in-qobuz',
                label: 'Open on Qobuz',
                onSelect: () => {
                  closeContextMenu();
                  openExternalUrl(albumEntry.url);
                },
              });
            }

            return items;
          }

          case 'artist': {
            const artist = contextMenu.target.artist;
            const isCurrentArtist = currentPage.kind === 'artist' && artistPage?.artist.id === artist.id;
            const items: ContextMenuItem[] = [];

            if (artist.id && artist.name) {
              items.push({
                key: 'go-to-artist',
                label: 'Go to artist',
                onSelect: () => {
                  closeContextMenu();
                  openArtist(artist);
                },
              });
            }

            if (isCurrentArtist && artistTracks.length > 0) {
              items.push({
                key: 'download',
                label: 'Download popular tracks',
                onSelect: () => {
                  closeContextMenu();
                  openArtistDownload();
                },
              });
            }

            if (isCurrentArtist && artistQobuzUrl) {
              items.push({ key: 'separator-open', separator: true });
              items.push({
                key: 'open-in-qobuz',
                label: 'Open on Qobuz',
                onSelect: () => {
                  closeContextMenu();
                  openExternalUrl(artistQobuzUrl);
                },
              });
            }

            return items;
          }
        }
      })()
    : [];

  const showArtists = currentPage.kind === 'search' && searchTab === 'artists';
  const showTracks = currentPage.kind === 'search' && (searchTab === 'all' || searchTab === 'tracks');
  const showAlbums = currentPage.kind === 'search' && (searchTab === 'all' || searchTab === 'albums');
  const showSearchEmpty =
    currentPage.kind === 'search' && !isLoading && results.artists.length === 0 && results.tracks.length === 0 && results.albums.length === 0;
  const showHomeRecommendations = homeFeed.stage > 0 && homeFeed.tracks.length > 0;
  const showHomeAlbums = homeFeed.stage >= 2 && homeFeed.albums.length > 0;
  const showHomeRecents = homeFeed.recents.length > 0;

  return (
    <div className="app-shell">
      <header className={`window-titlebar ${reserveWindowsControlsSpace ? 'window-titlebar-with-overlay' : ''}`}>
        <div className="window-titlebar-leading">
          <button aria-label="Go home" className="brand-home-button" onClick={goHome} type="button">
            <span className="brand-mark">
              <span className="brand-muted">mono</span>
              <span className="brand-accent">k</span>
              <span className="brand-muted">e</span>
              <span className="brand-muted">nnyy</span>
            </span>
          </button>
        </div>

        <div className="window-titlebar-main">
          <div className="header-nav">
            <button className="nav-circle" disabled={navigation.index === 0} onClick={goBack} type="button">
              <ChevronLeft size={18} />
            </button>
            <button
              className="nav-circle"
              disabled={navigation.index >= navigation.stack.length - 1}
              onClick={goForward}
              type="button"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <form
            className={`search-form window-titlebar-search ${isSearchHistoryOpen && searchHistory.length > 0 ? 'is-history-open' : ''}`}
            onSubmit={submitSearch}
            ref={searchFormRef}
          >
            <Search size={18} className="search-icon" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClick={showSearchHistory}
              onFocus={showSearchHistory}
              placeholder="Search"
              aria-label="Search"
              aria-controls="search-history-dropdown"
              aria-expanded={isSearchHistoryOpen && searchHistory.length > 0}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {query ? (
              <button aria-label="Clear search" className="search-clear" onClick={clearSearch} type="button">
                <X size={16} />
              </button>
            ) : null}

            {isSearchHistoryOpen && searchHistory.length > 0 ? (
              <div aria-label="Search history" className="search-history-dropdown" id="search-history-dropdown" role="listbox">
                {searchHistory.map((entry) => (
                  <div className="search-history-item" key={entry}>
                    <button className="search-history-entry" onClick={() => selectSearchHistory(entry)} type="button">
                      <Clock3 className="history-icon" size={14} />
                      <span className="query-text">{entry}</span>
                    </button>
                    <button
                      aria-label={`Remove ${entry} from history`}
                      className="delete-history-btn"
                      onClick={() => removeSearchHistoryEntry(entry)}
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}

                <button className="search-history-clear-all" onClick={clearSearchHistory} type="button">
                  Clear all history
                </button>
              </div>
            ) : null}
          </form>
        </div>

        <div className="window-titlebar-actions">
          <div className={`downloads-bubble ${isDownloadsBubbleOpen ? 'open' : ''}`} ref={downloadsBubbleRef}>
            <button
              aria-expanded={isDownloadsBubbleOpen}
              aria-label={downloadBubbleLabel}
              className={`downloads-bubble-trigger ${inProgressDownloadJobs.length > 0 ? 'is-active' : ''}`}
              onClick={() => setIsDownloadsBubbleOpen((current) => !current)}
              type="button"
            >
              <Download size={16} />
            </button>

            {isDownloadsBubbleOpen ? (
              <div className="downloads-bubble-panel">
                <div className="downloads-bubble-header">
                  <div>
                    <strong>Downloads</strong>
                    <span>{downloadBubbleLabel}</span>
                  </div>
                  <button className="ghost-pill downloads-bubble-link" onClick={openDownloadsHub} type="button">
                    <span>Show all</span>
                  </button>
                </div>

                {downloadBubbleJobs.length > 0 ? (
                  <div className="downloads-bubble-list">
                    {downloadBubbleJobs.map((job) => {
                      const overallProgress = getDownloadJobProgress(job);
                      const progressPercent = Math.round(overallProgress * 100);
                      const progressSummary = job.status === 'completed'
                        ? job.target === 'app'
                          ? 'Saved inside kPlayer'
                          : 'Saved to disk'
                        : job.status === 'failed'
                          ? job.error ?? 'Download failed'
                          : `${progressPercent}% • ${job.completedTracks}/${job.totalTracks} tracks`;
                      const speedEntry = downloadSpeedRef.current.get(job.id);
                      const now = Date.now();
                      if (job.status === 'downloading' && job.currentTrackBytesReceived > 0) {
                        const prev = speedEntry;
                        if (prev && now - prev.time > 500) {
                          const elapsed = (now - prev.time) / 1000;
                          const deltaBytes = job.currentTrackBytesReceived - prev.bytes;
                          const instantSpeed = deltaBytes > 0 ? deltaBytes / elapsed : 0;
                          const smoothed = prev.speed > 0 ? prev.speed * 0.7 + instantSpeed * 0.3 : instantSpeed;
                          downloadSpeedRef.current.set(job.id, { bytes: job.currentTrackBytesReceived, time: now, speed: smoothed });
                        } else if (!prev) {
                          downloadSpeedRef.current.set(job.id, { bytes: job.currentTrackBytesReceived, time: now, speed: 0 });
                        }
                      } else if (job.status !== 'downloading') {
                        downloadSpeedRef.current.delete(job.id);
                      }
                      const currentSpeed = speedEntry?.speed ?? 0;
                      const speedLabel = currentSpeed > 0 ? `${formatByteSize(currentSpeed)}/s` : '';
                      const isTranscoding = job.status === 'downloading' && job.currentTrackStage === 'transcoding';
                      const bytesSummary = isTranscoding
                        ? 'Converting with ffmpeg…'
                        : job.currentTrackBytesTotal > 0
                          ? `${formatByteSize(job.currentTrackBytesReceived)} / ${formatByteSize(job.currentTrackBytesTotal)}${speedLabel ? ` • ${speedLabel}` : ''}`
                          : getDownloadFormatLabel(job.format);
                      const liveProgressSummary = isTranscoding
                        ? `Converting to ${getDownloadFormatLabel(job.format)}…`
                        : progressSummary;
                      const liveSpeedLabel = isTranscoding ? '' : speedLabel;

                      return (
                        <article className={`downloads-bubble-item ${job.status === 'failed' ? 'is-failed' : ''} ${job.status === 'completed' ? 'is-complete' : ''}`} key={job.id}>
                          <button className="downloads-bubble-item-main" onClick={openDownloadsHub} type="button">
                            <img alt={job.title} className="downloads-bubble-cover" src={getCover(job.coverUrl, job.title)} />

                            <div className="downloads-bubble-copy">
                              <strong>{job.title}</strong>
                              {job.status === 'downloading' ? (
                                <>
                                  <span>{liveProgressSummary}{liveSpeedLabel ? ` • ${liveSpeedLabel}` : ''}</span>
                                  <div className={`downloads-bubble-progress ${isTranscoding ? 'is-indeterminate' : ''}`} aria-hidden="true">
                                    <span style={isTranscoding ? undefined : { width: `${progressPercent}%` }} />
                                  </div>
                                </>
                              ) : job.status === 'completed' ? (
                                <span>Saved to {job.target === 'app' ? 'library' : 'disk'}</span>
                              ) : job.status === 'failed' ? (
                                <span>{job.error ?? 'Download failed'}</span>
                              ) : (
                                <span>Queued • {job.totalTracks} {job.totalTracks === 1 ? 'track' : 'tracks'}</span>
                              )}
                            </div>
                          </button>

                          {(job.status === 'completed' || job.status === 'failed') ? (
                            <button className="icon-button downloads-bubble-dismiss" onClick={() => dismissDownloadJob(job.id)} type="button">
                              <X size={14} />
                            </button>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="downloads-bubble-empty">
                    <strong>No downloads yet</strong>
                    <span>Start a download and its progress will stay here at the top.</span>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="account-menu-wrapper" ref={accountMenuRef}>
            <button
              aria-label={authUser ? `Conta ${authUser.email}` : 'Entrar'}
              className={`account-pill ${authUser ? 'is-signed' : ''}`}
              onClick={() => {
                if (authUser) {
                  setShowAccountMenu((s) => !s);
                } else {
                  openAuthModal('login');
                }
              }}
              type="button"
            >
              <span>{authUser ? (authUser.avatar ? <img alt="" className="account-pill-avatar" src={getAvatarUrl(authUser)!} /> : (authUser.name?.[0] ?? authUser.email[0] ?? '?').toUpperCase()) : <User size={16} aria-hidden="true" />}</span>
            </button>
            {showAccountMenu && authUser ? (
              <div className="account-menu">
                <div className="account-menu-header">
                  <strong>{authUser.name || authUser.email.split('@')[0]}</strong>
                  <span>{authUser.email}</span>
                </div>
                <button className="account-menu-item" onClick={() => { setShowAccountMenu(false); openProfileModal(); }} type="button">
                  Edit Profile
                </button>
                <button className="account-menu-item" onClick={handleLogout} type="button">
                  Sair
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="sidebar-nav">
          <button className={`nav-item ${currentPage.kind === 'home' ? 'active' : ''}`} onClick={goHome} type="button">
            <Home size={18} />
            <span>Home</span>
          </button>
          <button className={`nav-item ${currentPage.kind === 'library' ? 'active' : ''}`} onClick={() => openLibrary('favorites')} type="button">
            <Library size={18} />
            <span>Library</span>
          </button>
          <button className={`nav-item ${currentPage.kind === 'settings' ? 'active' : ''}`} onClick={() => openSettings('playback')} type="button">
            <Settings size={18} />
            <span>Settings</span>
          </button>
        </nav>

        <div className="sidebar-playlists">
          <div className="sidebar-playlists-header">
            <span>Playlists</span>
            <button
              className="icon-button sidebar-playlist-add"
              onClick={() => {
                setCreatePlaylistForm({ name: '', description: '', coverUrl: '' });
                setShowCreatePlaylistModal(true);
              }}
              type="button"
            >
              <Plus size={14} />
            </button>
          </div>
          {playlists.map((pl) => (
            <button
              className={`sidebar-playlist-item ${currentPage.kind === 'playlist' && currentPage.playlistId === pl.id ? 'active' : ''}`}
              key={pl.id}
              onClick={() => openPlaylist(pl.id)}
              type="button"
            >
              <ListMusic size={15} />
              <span>{pl.name}</span>
              <small>{pl.tracks.length}</small>
            </button>
          ))}
        </div>
      </aside>

      <main className={`main-layout ${isDetailPage ? 'detail-main-layout' : ''}`}>
        <section className={`content-scroll ${isDetailPage ? 'detail-content-scroll' : ''}`}>
          {currentPage.kind === 'home' ? (
            <div className="page-stack">
              {homeFeed.stage === 0 ? (
                <div className="home-empty">
                  <h1>Welcome to kPlayer</h1>
                  <p>You haven't listened to anything yet. Search for your favorite songs to get started!</p>
                </div>
              ) : (
                <>
                  {(() => {
                    // Build unique shortcut cards from recent albums + top artists
                    const seenAlbums = new Set<string>();
                    const artistShortcutByKey = new Map<string, { artist?: QobuzArtist; cover?: string }>();
                    const cachedArtistByKey = new Map<string, QobuzArtist>();
                    const cachedArtistByName = new Map<string, QobuzArtist>();
                    const shortcuts: { key: string; label: string; cover?: string; action: () => void }[] = [];

                    for (const cachedResults of searchCache.current.values()) {
                      for (const cachedArtist of cachedResults.artists) {
                        const artistKey = String(cachedArtist.id ?? '');
                        const artistNameKey = normalizeText(cachedArtist.name);

                        if (artistKey && !cachedArtistByKey.has(artistKey)) {
                          cachedArtistByKey.set(artistKey, cachedArtist);
                        }

                        if (artistNameKey && !cachedArtistByName.has(artistNameKey)) {
                          cachedArtistByName.set(artistNameKey, cachedArtist);
                        }
                      }
                    }

                    for (const entry of listeningProfile.plays) {
                      const artistKey = String(entry.performer?.id ?? entry.performer?.name ?? '');
                      if (!artistKey) {
                        continue;
                      }

                      const existing = artistShortcutByKey.get(artistKey);
                      artistShortcutByKey.set(artistKey, {
                        artist: existing?.artist ?? entry.performer,
                        cover: existing?.cover ?? getBestImageUrl(entry.performer?.image),
                      });
                    }

                    for (const entry of homeFeed.recents) {
                      if (!entry.album?.id || seenAlbums.has(entry.album.id)) continue;
                      seenAlbums.add(entry.album.id);
                      const albumId = entry.album.id;
                      shortcuts.push({
                        key: `album-${albumId}`,
                        label: entry.album.title ?? 'Album',
                        cover: getCover(entry.album.image?.large ?? entry.album.image?.thumbnail, entry.album.title),
                        action: () => void openAlbum(albumId),
                      });
                      if (shortcuts.length >= 8) break;
                    }

                    for (const artist of homeFeed.topArtists) {
                      if (shortcuts.length >= 8) break;

                      const cachedArtist = cachedArtistByKey.get(artist.key) ?? cachedArtistByName.get(normalizeText(artist.name));
                      const cachedCover = getBestImageUrl(cachedArtist?.image);
                      const historyShortcut = artistShortcutByKey.get(artist.key);

                      const shortcutArtist =
                        historyShortcut?.artist ??
                        cachedArtist ??
                        (/^\d+$/.test(artist.key) ? { id: Number(artist.key), name: artist.name } : undefined);

                      if (!shortcutArtist?.id || !shortcutArtist.name) {
                        continue;
                      }

                      shortcuts.push({
                        key: `artist-${artist.key}`,
                        label: artist.name,
                        cover: historyShortcut?.cover ?? cachedCover,
                        action: () => openArtist(shortcutArtist),
                      });
                    }

                    return shortcuts.length > 0 ? (
                      <div className="shortcut-grid">
                        {shortcuts.slice(0, 8).map((s) => (
                          <button className="shortcut-card" key={s.key} onClick={s.action} type="button">
                            <span className="shortcut-media">
                              {s.cover ? (
                                <img alt={s.label} src={s.cover} className="shortcut-cover" />
                              ) : (
                                <span className="shortcut-letter">{s.label[0]}</span>
                              )}
                            </span>
                            <span className="shortcut-label">{s.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })()}

                  {showHomeRecommendations ? (
                    <section className="section-block">
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Recommended Songs</h2>
                        </div>
                      </div>

                      {isHomeLoading && homeFeed.tracks.length === 0 ? <div className="loading-center"><span className="spinner" /></div> : null}

                      <div className="track-columns">
                        {homeTrackColumns.map((column, index) => (
                          <div className="track-column" key={`home-track-column-${index}`}>
                            {column.map((track) => (
                              <button className="track-row" key={track.id} onClick={() => void playTracksFromSource(homeFeed.tracks, homeFeed.tracks.findIndex((entry) => entry.id === track.id), 'Recommended Songs')} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })} type="button">
                                <img
                                  alt={track.album?.title ?? track.title ?? 'Album cover'}
                                  className="track-cover"
                                  src={getCover(track.album?.image?.thumbnail ?? track.album?.image?.large, track.album?.title ?? track.title)}
                                />
                                <div className="track-copy">
                                  <div className="track-title-row">
                                    <strong>{track.title ?? 'Untitled track'}</strong>
                                    {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                  </div>
                                  {renderArtistInline(track.performer)}
                                </div>
                                <span className="track-duration">{formatDuration(track.duration)}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {homeFeed.artistSections.map((section) => (
                    <section className="section-block" key={`artist-section-${section.artistName}`}>
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Because you listened to {section.artistName}</h2>
                        </div>
                      </div>

                      {section.tracks.length > 0 ? (
                        <div className="track-columns">
                          {splitIntoColumns(section.tracks, 3).map((column, colIdx) => (
                            <div className="track-column" key={`artist-section-col-${colIdx}`}>
                              {column.map((track) => (
                                <button className="track-row" key={track.id} onClick={() => void playTracksFromSource(section.tracks, section.tracks.findIndex((entry) => entry.id === track.id), `Because you listened to ${section.artistName}`)} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })} type="button">
                                  <img
                                    alt={track.album?.title ?? track.title ?? 'Album cover'}
                                    className="track-cover"
                                    src={getCover(track.album?.image?.thumbnail ?? track.album?.image?.large, track.album?.title ?? track.title)}
                                  />
                                  <div className="track-copy">
                                    <div className="track-title-row">
                                      <strong>{track.title ?? 'Untitled track'}</strong>
                                      {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                    </div>
                                    {renderArtistInline(track.performer)}
                                  </div>
                                  <span className="track-duration">{formatDuration(track.duration)}</span>
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {section.albums.length > 0 ? (
                        <div className="album-grid">
                          {section.albums.map((entry) => (
                            <button
                              className="album-card context-card"
                              key={entry.id}
                              onClick={() => void openAlbum(entry.id)}
                              onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'album', album: entry })}
                              type="button"
                            >
                              {renderContextMenuButton({ kind: 'album', album: entry }, 'card-menu-btn')}
                              <img alt={entry.title ?? 'Album cover'} src={getCover(entry.image?.large ?? entry.image?.thumbnail, entry.title)} />
                              <div className="album-card-copy">
                                <strong>{entry.title ?? 'Untitled album'}</strong>
                                <span>{entry.artist?.name ?? 'Unknown artist'}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ))}

                  {showHomeAlbums ? (
                    <section className="section-block">
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Recommended Albums</h2>
                        </div>
                      </div>

                      <div className="album-grid">
                        {homeFeed.albums.map((entry) => (
                          <button
                            className="album-card context-card"
                            key={entry.id}
                            onClick={() => void openAlbum(entry.id)}
                            onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'album', album: entry })}
                            type="button"
                          >
                            {renderContextMenuButton({ kind: 'album', album: entry }, 'card-menu-btn')}
                            <img alt={entry.title ?? 'Album cover'} src={getCover(entry.image?.large ?? entry.image?.thumbnail, entry.title)} />
                            <div className="album-card-copy">
                              <strong>{entry.title ?? 'Untitled album'}</strong>
                              <span>{entry.artist?.name ?? 'Unknown artist'}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {showHomeRecents ? (
                    <section className="section-block">
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Jump Back In</h2>
                        </div>
                      </div>

                      <div className="track-columns">
                        {homeRecentColumns.map((column, index) => (
                          <div className="track-column" key={`home-recent-column-${index}`}>
                            {column.map((track) => (
                              <button className="track-row" key={track.id} onClick={() => void playTracksFromSource(homeRecentTracks, homeRecentTracks.findIndex((entry) => entry.id === track.id), 'Jump Back In')} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })} type="button">
                                <img
                                  alt={track.album?.title ?? track.title ?? 'Album cover'}
                                  className="track-cover"
                                  src={getCover(track.album?.image?.thumbnail ?? track.album?.image?.large, track.album?.title ?? track.title)}
                                />
                                <div className="track-copy">
                                  <div className="track-title-row">
                                    <strong>{track.title ?? 'Untitled track'}</strong>
                                    {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                  </div>
                                  {renderArtistInline(track.performer)}
                                </div>
                                <span className="track-duration">{formatDuration(track.duration)}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {currentPage.kind === 'library' ? (
            <div className="page-stack library-page">
              <section className="content-section">
                <div className="library-header">
                  <h2>My Playlists</h2>
                </div>
                <div className="card-grid">
                  <button
                    className="card library-create-dashed-card"
                    onClick={() => {
                      setCreatePlaylistForm({ name: '', description: '', coverUrl: '' });
                      setShowCreatePlaylistModal(true);
                    }}
                    type="button"
                  >
                    <div className="library-create-dashed-art">
                      <ListMusic size={28} />
                    </div>
                    <div className="card-info">
                      <h4 className="card-title">Create playlist</h4>
                    </div>
                  </button>
                  {downloadsPlaylist ? (
                    <button
                      className="card playlist-card"
                      key={DOWNLOADS_PLAYLIST_ID}
                      onClick={() => pushPage({ kind: 'playlist', playlistId: DOWNLOADS_PLAYLIST_ID })}
                      type="button"
                    >
                      <div className={`playlist-card-cover playlist-card-cover-mosaic playlist-card-cover-mosaic-${Math.min(downloadsCoverMosaic.length, 4)}`}>
                        {downloadsCoverMosaic.length > 0 ? (
                          downloadsCoverMosaic.slice(0, 4).map((url, i) => (
                            <img alt="" key={i} src={url} />
                          ))
                        ) : (
                          <Download size={24} />
                        )}
                      </div>
                      <div className="card-info">
                        <h4 className="card-title">{downloadsPlaylist.name}</h4>
                        <span className="card-subtitle">{downloadsPlaylist.tracks.length} {downloadsPlaylist.tracks.length === 1 ? 'track' : 'tracks'}</span>
                      </div>
                    </button>
                  ) : null}
                  {playlists.map((pl) => (
                    <button className="card playlist-card" key={pl.id} onClick={() => openPlaylist(pl.id)} type="button">
                      <div className="playlist-card-cover">
                        {pl.coverUrl ? (
                          <img alt={pl.name} src={pl.coverUrl} />
                        ) : pl.tracks.length > 0 && pl.tracks[0].album?.image ? (
                          <img alt={pl.name} src={getCover(getBestImageUrl(pl.tracks[0].album.image), pl.name)} />
                        ) : (
                          <ListMusic size={24} />
                        )}
                      </div>
                      <div className="card-info">
                        <h4 className="card-title">{pl.name}</h4>
                        <span className="card-subtitle">{pl.tracks.length} {pl.tracks.length === 1 ? 'track' : 'tracks'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <section className="content-section">
                <h2 className="section-title">Favorites</h2>
                <div className="search-tabs library-tabs">
                  <button className={`search-tab ${currentLibraryTab === 'favorites' ? 'active' : ''}`} onClick={() => openLibrary('favorites')} type="button">
                    Liked Tracks
                  </button>
                  <button className={`search-tab ${currentLibraryTab === 'recent' ? 'active' : ''}`} onClick={() => openLibrary('recent')} type="button">
                    Recent
                  </button>
                </div>

                {currentLibraryTab === 'favorites' ? (
                  favoriteTracks.length > 0 ? (
                    <div className="library-tab-content">
                      <div className="library-liked-tracks-toolbar">
                        <button className="ghost-pill" onClick={() => void playTracksFromSource(favoriteTracks, 0, 'Favorites')} type="button">
                          <Play size={16} fill="currentColor" />
                          <span>Play</span>
                        </button>
                        <button className="ghost-pill" onClick={() => void playTracksFromSource(shuffleArray(favoriteTracks), 0, 'Favorites')} type="button">
                          <Shuffle size={16} />
                          <span>Shuffle</span>
                        </button>
                      </div>

                      <div className="library-track-list">
                        {favoriteTracks.map((track, idx) => (
                          <button
                            className="track-row"
                            key={track.id}
                            onClick={() => void playTracksFromSource(favoriteTracks, idx, 'Favorites')}
                            onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })}
                            type="button"
                          >
                            <img alt={track.album?.title ?? track.title ?? 'Album cover'} className="track-cover" src={getCover(getBestImageUrl(track.album?.image), track.album?.title ?? track.title)} />
                            <div className="track-copy">
                              <div className="track-title-row">
                                <strong>{track.title ?? 'Untitled track'}</strong>
                                {track.hires ? <span className="tag">HD</span> : null}
                              </div>
                              <span className="track-subtitle">
                                {renderArtistInline(track.performer, track.album?.artist)}
                                {track.album?.title ? <> • {track.album.title}</> : null}
                              </span>
                            </div>
                            <div className="track-meta">
                              {renderTrackLikeIndicator(track.id)}
                              <span className="track-duration">{formatDuration(track.duration)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="home-empty library-empty-state">
                      <h1>No favorites yet</h1>
                      <p>Use the heart actions around the app and your liked tracks will appear here.</p>
                    </div>
                  )
                ) : null}

                {currentLibraryTab === 'recent' ? (
                  recentLibraryTracks.length > 0 ? (
                    <div className="library-tab-content">
                      <div className="library-track-list">
                        {recentLibraryTracks.map((entry, idx) => {
                          const replayTrack = playedTrackToTrack(entry);
                          return (
                            <button
                              className="track-row"
                              key={`${entry.id}-${entry.listenedAt}`}
                              onClick={() => void playTracksFromSource(recentLibraryPlayableTracks, idx, 'Recent Plays')}
                              onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track: replayTrack })}
                              type="button"
                            >
                              <img alt={entry.album?.title ?? entry.title ?? 'Recent cover'} className="track-cover" src={getCover(getBestImageUrl(entry.album?.image), entry.album?.title ?? entry.title)} />
                              <div className="track-copy">
                                <div className="track-title-row">
                                  <strong>{entry.title ?? 'Untitled track'}</strong>
                                  {entry.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                </div>
                                <span className="track-subtitle">
                                  {renderArtistInline(entry.performer)}
                                  {entry.album?.title ? <> • {entry.album.title}</> : null}
                                </span>
                              </div>
                              <div className="track-meta">
                                {renderTrackLikeIndicator(entry.id)}
                                <span className="track-duration">{formatRelativeTime(entry.listenedAt)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="home-empty library-empty-state">
                      <h1>No listening history yet</h1>
                      <p>Play some music and your recent activity will show up here.</p>
                    </div>
                  )
                ) : null}
              </section>
            </div>
          ) : null}

          {currentPage.kind === 'playlist' ? (() => {
            const isDownloadsPlaylist = currentPage.playlistId === DOWNLOADS_PLAYLIST_ID;
            const playlist = isDownloadsPlaylist
              ? downloadsPlaylist
              : playlists.find((pl) => pl.id === currentPage.playlistId);
            if (!playlist) {
              return (
                <div className="page-stack">
                  <div className="home-empty library-empty-state">
                    <h1>{isDownloadsPlaylist ? 'No downloaded songs yet' : 'Playlist not found'}</h1>
                    <p>{isDownloadsPlaylist ? 'Download tracks from any album or artist and they will appear here.' : 'This playlist may have been deleted.'}</p>
                    <button className="ghost-pill" onClick={() => openLibrary('favorites')} type="button">
                      <span>Back to Library</span>
                    </button>
                  </div>
                </div>
              );
            }

            const playlistTracks: QobuzTrack[] = playlist.tracks.map((t, idx) => ({
              id: t.id,
              title: t.title ?? 'Untitled',
              track_number: idx + 1,
              duration: t.duration,
              hires: t.hires,
              performer: t.performer as QobuzArtist | undefined,
              album: t.album as QobuzAlbum | undefined,
            }));

            const playlistCover = playlist.coverUrl
              ? playlist.coverUrl
              : playlist.tracks.length > 0 && playlist.tracks[0].album?.image
                ? getCover(getBestImageUrl(playlist.tracks[0].album.image), playlist.name)
                : undefined;
            const playlistCreatedLabel = new Date(playlist.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            const normalizedPlaylistTrackSearch = normalizeText(playlistTrackSearch).trim();
            const playlistRows = playlist.tracks.map((track, index) => ({
              index,
              sourceTrack: track,
              playbackTrack: playlistTracks[index],
            }));
            const filteredPlaylistRows = normalizedPlaylistTrackSearch
              ? playlistRows.filter(({ sourceTrack }) => [sourceTrack.title, sourceTrack.performer?.name, sourceTrack.album?.title]
                .filter(Boolean)
                .some((value) => normalizeText(value).includes(normalizedPlaylistTrackSearch)))
              : playlistRows;

            return (
              <div className="page-stack playlist-detail-page">
                <header className="detail-header playlist-detail-header">
                  <div className="detail-header-cover-container">
                    {isDownloadsPlaylist && downloadsCoverMosaic.length > 0 ? (
                      <div className={`detail-header-image detail-header-image-mosaic detail-header-image-mosaic-${Math.min(downloadsCoverMosaic.length, 4)}`} aria-label={playlist.name}>
                        {downloadsCoverMosaic.slice(0, 4).map((url, i) => (
                          <img alt="" key={i} src={url} />
                        ))}
                      </div>
                    ) : playlistCover ? (
                      <img alt={playlist.name} className="detail-header-image" src={playlistCover} />
                    ) : (
                      <div className="detail-header-image detail-header-image-placeholder">
                        <ListMusic size={40} />
                      </div>
                    )}
                  </div>
                  <div className="detail-header-info">
                    <h1 className="title">{playlist.name}</h1>
                    <div className="meta">
                      <span>{playlist.tracks.length} {playlist.tracks.length === 1 ? 'track' : 'tracks'}</span>
                      <span>Created {playlistCreatedLabel}</span>
                    </div>
                    {playlist.description ? <p className="playlist-detail-description">{playlist.description}</p> : null}
                    <div className="detail-header-actions">
                      <button
                        className="btn-primary"
                        disabled={playlist.tracks.length === 0}
                        onClick={() => void playTracksFromSource(playlistTracks, 0, playlist.name)}
                        title="Play"
                        type="button"
                      >
                        <Play size={18} fill="currentColor" />
                        <span>Play</span>
                      </button>
                      <button
                        className="btn-primary"
                        disabled={playlist.tracks.length === 0}
                        onClick={() => void playTracksFromSource(shuffleArray(playlistTracks), 0, playlist.name)}
                        title="Shuffle"
                        type="button"
                      >
                        <Shuffle size={18} />
                        <span>Shuffle</span>
                      </button>
                      {isDownloadsPlaylist ? null : (
                        <>
                          <button
                            className="btn-secondary"
                            onClick={() => setRenamePlaylistTarget({
                              id: playlist.id,
                              name: playlist.name,
                              description: playlist.description ?? '',
                              coverUrl: playlist.coverUrl ?? '',
                            })}
                            title="Edit"
                            type="button"
                          >
                            <Pencil size={16} />
                            <span>Edit</span>
                          </button>
                          <button
                            className="btn-secondary detail-action-danger"
                            onClick={() => setDeletePlaylistTarget({ id: playlist.id, name: playlist.name })}
                            title="Delete"
                            type="button"
                          >
                            <Trash2 size={16} />
                            <span>Delete</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </header>

                {playlist.tracks.length > 0 ? (
                  <>
                    <form className="track-list-search-container playlist-track-search" onSubmit={(event) => event.preventDefault()}>
                      <Search className="search-icon" size={18} />
                      <input
                        autoComplete="off"
                        className="track-list-search-input"
                        onChange={(event) => setPlaylistTrackSearch(event.target.value)}
                        placeholder="Search tracks..."
                        spellCheck={false}
                        type="search"
                        value={playlistTrackSearch}
                      />
                      {playlistTrackSearch ? (
                        <button
                          className="search-clear-btn icon-button playlist-track-search-clear"
                          onClick={() => setPlaylistTrackSearch('')}
                          title="Clear search"
                          type="button"
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </form>

                    {filteredPlaylistRows.length > 0 ? (
                      <div className="playlist-track-list">
                        {filteredPlaylistRows.map(({ index, sourceTrack, playbackTrack }) => (
                          <article className="playlist-track-item" key={`${sourceTrack.id}-${index}`}>
                            <button
                              className="track-row playlist-track-row"
                              onClick={() => void playTracksFromSource(playlistTracks, index, playlist.name)}
                              onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track: playbackTrack })}
                              type="button"
                            >
                              <img
                                alt={sourceTrack.album?.title ?? sourceTrack.title ?? 'Cover'}
                                className="track-cover"
                                src={getCover(getBestImageUrl(sourceTrack.album?.image), sourceTrack.album?.title ?? sourceTrack.title)}
                              />
                              <div className="track-copy">
                                <div className="track-title-row">
                                  <strong>{sourceTrack.title ?? 'Untitled track'}</strong>
                                  {playbackTrack.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                </div>
                                <span className="track-subtitle">
                                  {renderArtistInline(sourceTrack.performer)}
                                  {sourceTrack.album?.title ? <> • {sourceTrack.album.title}</> : null}
                                </span>
                              </div>
                              <span className="track-duration">{formatDuration(sourceTrack.duration)}</span>
                            </button>
                            <button
                              className="playlist-track-remove"
                              onClick={() => removeTrackFromPlaylist(playlist.id, sourceTrack.id)}
                              title="Remove from playlist"
                              type="button"
                            >
                              <Minus size={14} />
                            </button>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="home-empty library-empty-state">
                        <p>No tracks match "{playlistTrackSearch}".</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="home-empty library-empty-state">
                    <p>This playlist is empty. Use the context menu on any track to add it here.</p>
                  </div>
                )}
              </div>
            );
          })() : null}

          {currentPage.kind === 'settings' ? (
            <div className="page-stack settings-page">
              <div className="page-header">
                <div>
                  <h1>Settings</h1>
                  <p>Only the controls that matter for playback and downloading live here.</p>
                </div>
              </div>

              <div className="search-tabs settings-tabs">
                <button className={`search-tab ${currentSettingsTab === 'playback' ? 'active' : ''}`} onClick={() => openSettings('playback')} type="button">
                  Playback
                </button>
                <button className={`search-tab ${currentSettingsTab === 'downloads' ? 'active' : ''}`} onClick={() => openSettings('downloads')} type="button">
                  Downloads
                </button>
              </div>

              {currentSettingsTab === 'playback' ? (
                <section className="section-block settings-panel">
                  <div className="settings-group">
                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Streaming Quality</strong>
                        <span>Choose the quality used when you press play.</span>
                      </div>
                      <select className="settings-select" onChange={(event) => setAppSettings((current) => ({ ...current, streamQuality: event.target.value as AppSettings['streamQuality'] }))} value={appSettings.streamQuality}>
                        <option value="27">Best Available (Hi-Res FLAC)</option>
                        <option value="6">FLAC 16-bit / 44.1 kHz</option>
                        <option value="5">MP3 320 kbps</option>
                      </select>
                    </div>

                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Prefer Offline Downloads</strong>
                        <span>If a track exists in the app library, use it first when playback starts.</span>
                      </div>
                      <label className="settings-toggle" htmlFor="prefer-offline-toggle">
                        <input checked={appSettings.preferOfflinePlayback} id="prefer-offline-toggle" onChange={(event) => setAppSettings((current) => ({ ...current, preferOfflinePlayback: event.target.checked }))} type="checkbox" />
                        <span />
                      </label>
                    </div>
                  </div>
                </section>
              ) : null}

              {currentSettingsTab === 'downloads' ? (
                <section className="section-block settings-panel">
                  <div className="settings-group">
                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Download Format</strong>
                        <span>Choose the file type used for downloads. Lossy formats are transcoded with the bundled ffmpeg.</span>
                      </div>
                      <select className="settings-select" onChange={(event) => setAppSettings((current) => ({ ...current, downloadFormat: event.target.value as DownloadFormat }))} value={appSettings.downloadFormat}>
                        <optgroup label="Source (no re-encoding)">
                          <option value="SOURCE_HIRES">Best Available (Hi-Res FLAC)</option>
                          <option value="SOURCE_FLAC">FLAC 16-bit / 44.1 kHz</option>
                          <option value="SOURCE_MP3">MP3 320 kbps</option>
                        </optgroup>
                        <optgroup label="Lossless">
                          <option value="FLAC">FLAC</option>
                          <option value="ALAC">Apple Lossless (ALAC)</option>
                        </optgroup>
                        <optgroup label="MP3">
                          <option value="MP3_320">MP3 320 kbps</option>
                          <option value="MP3_256">MP3 256 kbps</option>
                          <option value="MP3_128">MP3 128 kbps</option>
                        </optgroup>
                        <optgroup label="OGG Vorbis">
                          <option value="OGG_320">OGG 320 kbps</option>
                          <option value="OGG_256">OGG 256 kbps</option>
                          <option value="OGG_128">OGG 128 kbps</option>
                        </optgroup>
                        <optgroup label="AAC">
                          <option value="AAC_320">AAC 320 kbps</option>
                          <option value="AAC_256">AAC 256 kbps</option>
                          <option value="AAC_128">AAC 128 kbps</option>
                        </optgroup>
                      </select>
                    </div>

                    <div className="settings-row settings-row-targets">
                      <div className="settings-copy">
                        <strong>Default Download Destination</strong>
                        <span>Choose whether new downloads should go to the app library or be exported as files.</span>
                      </div>
                      <div className="settings-target-grid">
                        <button className={`settings-target-card ${appSettings.defaultDownloadTarget === 'app' ? 'active' : ''}`} onClick={() => setAppSettings((current) => ({ ...current, defaultDownloadTarget: 'app' }))} type="button">
                          <strong>Offline in app</strong>
                          <span>Best for listening without internet inside kPlayer.</span>
                        </button>
                        <button className={`settings-target-card ${appSettings.defaultDownloadTarget === 'disk' ? 'active' : ''}`} onClick={() => setAppSettings((current) => ({ ...current, defaultDownloadTarget: 'disk' }))} type="button">
                          <strong>Save to disk</strong>
                          <span>Exports regular files to a folder you choose.</span>
                        </button>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Disk Download Folder</strong>
                        <span>{appSettings.diskDownloadFolder || 'No folder selected yet. You will be prompted when saving to disk.'}</span>
                      </div>
                      <button className="ghost-pill" onClick={() => void chooseDiskDownloadFolder()} type="button">
                        <Download size={16} />
                        <span>{appSettings.diskDownloadFolder ? 'Change Folder' : 'Choose Folder'}</span>
                      </button>
                    </div>

                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Ask For Folder Every Time</strong>
                        <span>Useful if you sometimes want the same album in different places on disk.</span>
                      </div>
                      <label className="settings-toggle" htmlFor="ask-folder-toggle">
                        <input checked={appSettings.askDiskFolderEveryTime} id="ask-folder-toggle" onChange={(event) => setAppSettings((current) => ({ ...current, askDiskFolderEveryTime: event.target.checked }))} type="checkbox" />
                        <span />
                      </label>
                    </div>

                    <div className="settings-row">
                      <div className="settings-copy">
                        <strong>Reset Download Preferences</strong>
                        <span>Restore the default quality and destination choices.</span>
                      </div>
                      <button className="ghost-pill" onClick={resetDownloadPreferences} type="button">
                        <X size={16} />
                        <span>Reset</span>
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {currentPage.kind === 'search' ? (
            <div className="page-stack">
              <div className="page-header">
                <div>
                  <h1>Search Results for &quot;{currentPage.query}&quot;</h1>
                  {!isLoading && (results.artists.length > 0 || results.tracks.length > 0 || results.albums.length > 0) ? (
                    <p className="search-meta">{results.artists.length} artists • {results.albums.length} albums • {results.tracks.length} tracks</p>
                  ) : null}
                </div>
              </div>

              <div className="search-tabs">
                <button
                  className={`search-tab ${searchTab === 'all' ? 'active' : ''}`}
                  onClick={() => setSearchTab('all')}
                  type="button"
                >
                  All
                </button>
                <button
                  className={`search-tab ${searchTab === 'artists' ? 'active' : ''}`}
                  onClick={() => setSearchTab('artists')}
                  type="button"
                >
                  Artists
                </button>
                <button
                  className={`search-tab ${searchTab === 'tracks' ? 'active' : ''}`}
                  onClick={() => setSearchTab('tracks')}
                  type="button"
                >
                  Tracks
                </button>
                <button
                  className={`search-tab ${searchTab === 'albums' ? 'active' : ''}`}
                  onClick={() => setSearchTab('albums')}
                  type="button"
                >
                  Albums
                </button>
              </div>

              {isLoading ? <div className="loading-center"><span className="spinner" /></div> : null}
              {showSearchEmpty ? <p className="empty-text">No results found.</p> : null}

              {showArtists && results.artists.length > 0 ? (
                <section className="section-block">
                  <div className="section-header">
                    <div className="section-title-wrap">
                      <h2>Artists</h2>
                      <span>{results.artists.length} results</span>
                    </div>
                  </div>

                  <div className="artist-grid">
                    {results.artists.map((artist) => (
                      <button
                        className="artist-card context-card"
                        key={artist.id}
                        onClick={() => openArtist(artist)}
                        onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'artist', artist })}
                        type="button"
                      >
                        {renderContextMenuButton({ kind: 'artist', artist }, 'card-menu-btn')}
                        <img alt={artist.name ?? 'Artist'} className="artist-card-image" src={getCover(artist.image?.large ?? artist.image?.thumbnail, artist.name)} />
                        <div className="artist-card-copy">
                          <strong>{artist.name ?? 'Unknown artist'}</strong>
                          <span>Artist</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {showTracks && results.tracks.length > 0 ? (
                <section className="section-block">
                  <div className="section-header">
                    <div className="section-title-wrap">
                      <h2>Tracks</h2>
                      <span>{results.tracks.length} results</span>
                    </div>
                    <button className="ghost-pill" onClick={() => void startInfiniteRadio(results.tracks[0], `Radio for ${currentPage.query}`)} type="button">
                      <Radio size={16} />
                      <span>Start Infinite Radio</span>
                    </button>
                  </div>

                  <div className="track-columns">
                    {trackColumns.map((column, index) => (
                      <div className="track-column" key={`track-column-${index}`}>
                        {column.map((track) => (
                          <button className="track-row" key={track.id} onClick={() => void playTrack(track, { sourceLabel: 'Search Results' })} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })} type="button">
                            <img
                              alt={track.album?.title ?? track.title ?? 'Album cover'}
                              className="track-cover"
                              src={getCover(track.album?.image?.thumbnail ?? track.album?.image?.large, track.album?.title ?? track.title)}
                            />
                            <div className="track-copy">
                              <div className="track-title-row">
                                <strong>{track.title ?? 'Untitled track'}</strong>
                                {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                              </div>
                              {renderArtistInline(track.performer)}
                            </div>
                            {renderTrackLikeIndicator(track.id)}
                            <span className="track-duration">{formatDuration(track.duration)}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {showAlbums && results.albums.length > 0 ? (
                <section className="section-block">
                  <div className="section-header">
                    <div className="section-title-wrap">
                      <h2>Albums</h2>
                      <span>{results.albums.length} results</span>
                    </div>
                  </div>

                  <div className="album-grid">
                    {results.albums.map((entry) => (
                      <button
                        className="album-card context-card"
                        key={entry.id}
                        onClick={() => void openAlbum(entry.id)}
                        onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'album', album: entry })}
                        type="button"
                      >
                        {renderContextMenuButton({ kind: 'album', album: entry }, 'card-menu-btn')}
                        <img alt={entry.title ?? 'Album cover'} src={getCover(entry.image?.large ?? entry.image?.thumbnail, entry.title)} />
                        <div className="album-card-copy">
                          <strong>{entry.title ?? 'Untitled album'}</strong>
                          <span>{entry.artist?.name ?? 'Unknown artist'}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {currentPage.kind === 'artist' ? (
            <div className="page-stack">
              {artistPage ? (
                <>
                  <section className="artist-banner">
                    <div className="artist-banner-backdrop" style={{ backgroundImage: `linear-gradient(180deg, rgba(7,7,7,0.12), rgba(7,7,7,0.78) 48%, rgba(7,7,7,0.96) 100%), url(${artistHeroImage})` }} />
                    <div className="artist-banner-overlay" />
                    <div className="artist-banner-inner">
                      <div className="artist-portrait-wrap">
                        <img alt={artistPage.artist.name ?? 'Artist'} className="artist-portrait" src={artistHeroImage} />
                      </div>

                      <div className="artist-banner-copy">
                        <h1>{artistPage.artist.name ?? currentPage.artistName}</h1>

                        <div className="artist-meta-row">
                          {artistQobuzUrl ? (
                            <button className="artist-meta-button" onClick={() => openExternalUrl(artistQobuzUrl)} type="button">
                              <Globe size={15} />
                            </button>
                          ) : null}
                          <button className="artist-meta-button" onClick={() => openSearch(artistPage.artist.name ?? currentPage.artistName)} type="button">
                            <Search size={15} />
                          </button>
                          {artistQobuzUrl ? (
                            <button className="artist-meta-button" onClick={() => openExternalUrl(artistQobuzUrl)} type="button">
                              <ExternalLink size={15} />
                            </button>
                          ) : null}
                          <span className="artist-meta-text">{artistTracks.length} popular tracks</span>
                          <span className="artist-meta-text">{artistReleaseCount} releases</span>
                        </div>

                        {artistDescription ? (
                          <div className="artist-description-block">
                            <p className="artist-description">{visibleArtistDescription}</p>
                            {artistDescription.length > 320 ? (
                              <button className="artist-read-more" onClick={() => setIsArtistBioExpanded((current) => !current)} type="button">
                                {isArtistBioExpanded ? 'Read Less' : 'Read More'}
                              </button>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="artist-action-row">
                          <button className="artist-circle-button artist-circle-button-primary" onClick={() => (artistTracks[0] ? void playTracksFromSource(artistTracks, 0, 'Popular Tracks') : undefined)} type="button">
                            <Play size={18} fill="currentColor" />
                          </button>
                          <button
                            className="artist-circle-button artist-circle-button-primary"
                            onClick={() => {
                              if (artistTracks.length === 0) {
                                return;
                              }

                              const shuffledTracks = shuffleArray(artistTracks);
                              void playTracksFromSource(shuffledTracks, 0, 'Popular Tracks');
                            }}
                            type="button"
                          >
                            <Shuffle size={18} />
                          </button>
                          <button
                            className="artist-circle-button artist-circle-button-primary"
                            onClick={openArtistDownload}
                            type="button"
                          >
                            <Download size={18} />
                          </button>
                          <button className={`artist-circle-button ${artistFavoritesActive ? 'is-active' : ''}`} onClick={toggleArtistFavorites} type="button">
                            <Heart size={18} fill={artistFavoritesActive ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            className="artist-circle-button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openContextMenuFromAnchor({ kind: 'artist', artist: artistPage.artist }, event.currentTarget);
                            }}
                            type="button"
                          >
                            <MoreVertical size={18} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  {artistTracks.length > 0 ? (
                    <section className="section-block">
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Popular Tracks</h2>
                        </div>
                      </div>

                      <div className="track-columns artist-track-columns">
                        {artistTrackColumns.map((column, index) => (
                          <div className="track-column" key={`artist-track-column-${index}`}>
                            {column.map((track) => (
                              <button className="track-row artist-track-row" key={track.id} onClick={() => void playTracksFromSource(artistTracks, artistTracks.findIndex((entry) => entry.id === track.id), 'Popular Tracks')} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track })} type="button">
                                <img
                                  alt={track.album?.title ?? track.title ?? 'Album cover'}
                                  className="track-cover"
                                  src={getCover(track.album?.image?.thumbnail ?? track.album?.image?.large, track.album?.title ?? track.title)}
                                />
                                <div className="track-copy">
                                  <div className="track-title-row">
                                    <strong>{track.title ?? 'Untitled track'}</strong>
                                    {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                                  </div>
                                  {renderArtistInline(track.performer, artistPage.artist)}
                                </div>
                                {renderTrackLikeIndicator(track.id, track)}
                                <span className="track-duration">{formatDuration(track.duration)}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {artistAlbums.length > 0 ? (
                    <section className="section-block">
                      <div className="section-header">
                        <div className="section-title-wrap">
                          <h2>Releases</h2>
                        </div>
                      </div>

                      <div className="album-grid">
                        {artistAlbums.map((entry) => (
                          <button
                            className="album-card context-card"
                            key={entry.id}
                            onClick={() => void openAlbum(entry.id)}
                            onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'album', album: entry })}
                            type="button"
                          >
                            {renderContextMenuButton({ kind: 'album', album: entry }, 'card-menu-btn')}
                            <img alt={entry.title ?? 'Album cover'} src={getCover(entry.image?.large ?? entry.image?.thumbnail, entry.title)} />
                            <div className="album-card-copy">
                              <strong>{entry.title ?? 'Untitled album'}</strong>
                              <span>{entry.release_date_original?.slice(0, 4) ?? 'Release'}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="loading-center"><span className="spinner" /></div>
              )}
            </div>
          ) : null}

          {currentPage.kind === 'album' ? (
            <div className="page-stack album-page">
              {album ? (
                <>
                  <section className="album-page-hero">
                    <div className="album-page-hero-backdrop" style={{ backgroundImage: `url(${albumCover})` }} />
                    <div className="album-page-hero-overlay" />
                    <div className="album-page-hero-inner">
                      <img alt={album.title ?? 'Album cover'} className="album-page-cover" src={albumCover} />

                      <div className="album-page-copy">
                        <h1>
                          {album.title ?? 'Untitled album'}
                          {album.parental_warning ? <span className="album-explicit-badge">E</span> : null}
                        </h1>

                        <p className="album-page-meta">{albumMeta}</p>

                        <p className="album-page-credit">
                          <span>By </span>
                          {album.artist?.name ? (
                            <button className="artist-name-link album-page-artist-link" onClick={() => openArtist(album.artist)} type="button">
                              {album.artist.name}
                            </button>
                          ) : (
                            <span>{albumArtistName}</span>
                          )}
                          {albumCopyright ? <span> • {albumCopyright}</span> : null}
                        </p>

                        {albumFactLines.length > 0 ? (
                          <div className="album-page-fact-lines">
                            {albumFactLines.map((line) => (
                              <p key={line}>{line}</p>
                            ))}
                          </div>
                        ) : null}

                        <div className="album-page-actions">
                          <button className="artist-circle-button artist-circle-button-primary" onClick={() => (albumTracks[0] ? void playTracksFromSource(albumTracks, 0, album?.title ?? 'Album') : undefined)} type="button">
                            <Play size={18} fill="currentColor" />
                          </button>
                          <button
                            className="artist-circle-button artist-circle-button-primary"
                            onClick={() => {
                              if (albumTracks.length === 0) {
                                return;
                              }

                              const shuffledTracks = shuffleArray(albumTracks);
                              void playTracksFromSource(shuffledTracks, 0, album?.title ?? 'Album');
                            }}
                            type="button"
                          >
                            <Shuffle size={18} />
                          </button>
                          <button className="artist-circle-button artist-circle-button-primary" onClick={openAlbumDownload} type="button">
                            <Download size={18} />
                          </button>
                          <button className="artist-circle-button" onClick={() => appendTracksToQueue(albumTracks, album?.title ?? 'Album')} type="button">
                            <Plus size={18} />
                          </button>
                          <button className={`artist-circle-button ${albumFavoritesActive ? 'is-active' : ''}`} onClick={toggleAlbumFavorites} type="button">
                            <Heart size={18} fill={albumFavoritesActive ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            className="artist-circle-button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openContextMenuFromAnchor({ kind: 'album', album }, event.currentTarget);
                            }}
                            type="button"
                          >
                            <MoreVertical size={18} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className={`album-page-main ${albumSidebarAlbums.length > 0 ? 'has-sidebar' : ''}`}>
                    <div className="album-page-track-panel section-block">
                      <div className="album-track-header-row">
                        <span>#</span>
                        <span>Title</span>
                        <span>Duration</span>
                        <span aria-hidden="true" />
                      </div>

                      <div className="album-track-list album-page-track-list">
                        {albumTracks.map((track) => (
                          <button className="track-row album-page-track-row" key={track.id} onClick={() => void playTracksFromSource(albumTracks, albumTracks.findIndex((entry) => entry.id === track.id), album?.title ?? 'Album')} onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'track', track: mergeTrackWithAlbumFallback(track, album) })} type="button">
                            <span className="album-track-number">{track.track_number}</span>
                            <div className="track-copy">
                              <div className="track-title-row">
                                <strong>{track.title ?? 'Untitled track'}</strong>
                                {track.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>}
                              </div>
                              <span className="track-subtitle">
                                {renderArtistInline(track.performer, album.artist)}
                                {album.release_date_original?.slice(0, 4) ? <> • {album.release_date_original.slice(0, 4)}</> : null}
                              </span>
                            </div>
                            <div className="album-track-meta">
                              {renderTrackLikeIndicator(track.id, mergeTrackWithAlbumFallback(track, album))}
                              <span className="track-duration">{formatDuration(track.duration)}</span>
                            </div>
                            <span
                              className="track-meta-icon track-menu-btn album-track-menu"
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                                openContextMenuAt({ kind: 'track', track: mergeTrackWithAlbumFallback(track, album) }, rect.left, rect.bottom + 5);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.stopPropagation();
                                event.preventDefault();
                                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                                openContextMenuAt({ kind: 'track', track: mergeTrackWithAlbumFallback(track, album) }, rect.left, rect.bottom + 5);
                              }}
                            >
                              <MoreVertical size={16} />
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {albumSidebarAlbums.length > 0 ? (
                      <aside className="album-page-sidebar">
                        <div className="section-header">
                          <div className="section-title-wrap">
                            <h2>More albums from {albumArtistName}</h2>
                          </div>
                        </div>

                        <div className="album-sidebar-grid">
                          {albumSidebarAlbums.map((entry) => (
                            <button
                              className="album-sidebar-card context-card"
                              key={entry.id}
                              onClick={() => void openAlbum(entry.id)}
                              onContextMenu={(event) => openContextMenuFromEvent(event, { kind: 'album', album: entry })}
                              type="button"
                            >
                              {renderContextMenuButton({ kind: 'album', album: entry }, 'card-menu-btn')}
                              <img alt={entry.title ?? 'Album cover'} src={getCover(entry.image?.large ?? entry.image?.thumbnail, entry.title)} />
                              <div className="album-sidebar-card-copy">
                                <strong>{entry.title ?? 'Untitled album'}</strong>
                                <span>{entry.artist?.name ?? albumArtistName}</span>
                                <small>{entry.release_date_original?.slice(0, 4) ?? 'Release'}</small>
                              </div>
                            </button>
                          ))}
                        </div>
                      </aside>
                    ) : null}
                  </section>
                </>
              ) : (
                <div className="loading-center"><span className="spinner" /></div>
              )}
            </div>
          ) : null}
        </section>
      </main>

      {downloadRequest ? (
        <div className="download-modal-backdrop" onClick={() => setDownloadRequest(null)}>
          <div className="download-modal" onClick={(event) => event.stopPropagation()}>
            <div className="download-modal-header">
              <div className="download-modal-media">
                <img alt={downloadRequest.title} src={getCover(downloadRequest.coverUrl, downloadRequest.title)} />
              </div>

              <div className="download-modal-copy">
                <h2>{downloadRequest.title}</h2>
                <p>{downloadRequest.subtitle ?? `${downloadRequest.tracks.length} tracks`}</p>
                <small>
                  {downloadRequest.tracks.length} {downloadRequest.tracks.length === 1 ? 'track' : 'tracks'} • {getDownloadFormatLabel(appSettings.downloadFormat)}
                </small>
              </div>

              <button className="icon-button" onClick={() => setDownloadRequest(null)} type="button">
                <X size={16} />
              </button>
            </div>

              <div className="download-modal-body">
              <div className="modal-download-target-grid">
                <button className={`settings-target-card download-target-card ${appSettings.defaultDownloadTarget === 'app' ? 'active' : ''}`} onClick={() => void startDownload('app')} type="button">
                  <div className="download-target-card-copy">
                    <strong>Save for Offline Playback</strong>
                    <span>Stores the download inside kPlayer so the Library can play it without internet.</span>
                  </div>
                  <small className="download-target-card-meta">Saved to the app library</small>
                </button>

                <button className={`settings-target-card download-target-card ${appSettings.defaultDownloadTarget === 'disk' ? 'active' : ''}`} onClick={() => void startDownload('disk')} type="button">
                  <div className="download-target-card-copy">
                    <strong>Save to Disk</strong>
                    <span>Exports regular audio files to your selected folder.</span>
                  </div>
                  <small className="download-target-card-meta">{appSettings.diskDownloadFolder || 'Choose a folder when the download starts.'}</small>
                </button>
              </div>
            </div>

            <div className="download-modal-footer">
              <small>Quality and destination defaults live in Download Settings.</small>
              <button className="ghost-pill" onClick={() => openSettings('downloads')} type="button">
                <Settings size={16} />
                <span>Download Settings</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contextMenu && contextMenuItems.length > 0 ? (
        <ContextMenu items={contextMenuItems} onClose={closeContextMenu} x={contextMenu.x} y={contextMenu.y} />
      ) : null}

      <FullscreenPlayer
        coverSrc={getCover(nowPlayingCoverUrl, nowPlaying?.album?.title ?? nowPlaying?.title ?? album?.title)}
        duration={duration}
        formatDuration={formatDuration}
        getCurrentTime={() => audioRef.current?.currentTime ?? position}
        getSliderStyle={getPlayerSliderStyle}
        isOpen={isFullscreenPlayerOpen && Boolean(nowPlaying)}
        isPlaying={isPlaying}
        onClose={() => setIsFullscreenPlayerOpen(false)}
        onDownload={openNowPlayingDownload}
        onLyricsSeek={seekLyricsAndResume}
        onSeek={seekToPosition}
        onTogglePlayback={togglePlayback}
        onVolumeChange={setVolume}
        position={position}
        qualityLabel={fullscreenQualityLabel}
        track={nowPlaying}
        volume={volume}
      />

      <NowPlayingSidePanel
        formatDuration={formatDuration}
        getCoverForTrack={(track) => getCover(getBestImageUrl(track.album?.image), track.album?.title ?? track.title)}
        getCurrentTime={() => audioRef.current?.currentTime ?? position}
        isPlaying={isPlaying}
        position={position}
        onClearQueue={clearQueue}
        onClose={closeSidePanel}
        onDownloadQueue={openQueueDownload}
        onLikeAllQueue={likeAllQueueTracks}
        onLyricsSeek={seekLyricsAndResume}
        onMoveQueueItem={moveQueueEntry}
        onPlayQueueIndex={(index) => void playQueueIndex(index)}
        onRemoveQueueIndex={(index) => void removeQueueEntryAtIndex(index)}
        onToggleQueueTrackLike={toggleTrackLikeFromMenu}
        queueItems={queuePanelItems}
        queueTitle={queueTitle}
        track={nowPlaying}
        view={sidePanelView}
      />

      <footer className="player-bar">
        {availableUpdate && (
          <div className="update-banner">
            <span>New version available: <strong>v{availableUpdate.latestVersion}</strong></span>
            <button className="update-banner-button" onClick={() => openExternalUrl(availableUpdate.downloadUrl)} type="button">Download</button>
            <button className="update-banner-dismiss" onClick={() => setAvailableUpdate(null)} type="button">✕</button>
          </div>
        )}
        <div className="player-left">
          <button aria-label="Open fullscreen player" className="player-cover-button" disabled={!nowPlaying} onClick={() => setIsFullscreenPlayerOpen(true)} type="button">
            {nowPlaying ? (
              <img
                alt={nowPlaying.album?.title ?? album?.title ?? 'Now playing cover'}
                className="player-cover"
                src={getCover(nowPlayingCoverUrl, nowPlaying.album?.title ?? nowPlaying.title ?? album?.title)}
              />
            ) : (
              <div className="player-cover player-cover-idle">
                <Music size={20} />
              </div>
            )}
          </button>
          <div className="player-copy">
            <div className="track-title-row">
              <strong>{nowPlaying?.title ?? 'Nothing playing'}</strong>
              {nowPlaying ? (nowPlaying.hires ? <span className="tag">HD</span> : <span className="tag">FLAC</span>) : null}
            </div>
            {nowPlaying ? renderArtistInline(nowPlaying.performer, nowPlaying.album?.artist, 'Pick something from search') : <span>Pick something from search</span>}
          </div>
        </div>

        <div className="player-center">
          <div className="progress-row">
            <span>{formatDuration(Math.floor(position))}</span>
            <input
              className="player-slider"
              max={duration || 0}
              min={0}
              onChange={(event) => seekToPosition(Number(event.target.value))}
              style={getPlayerSliderStyle(Math.min(position, duration || 0), duration || 0)}
              type="range"
              value={Math.min(position, duration || 0)}
            />
            <span>{formatDuration(Math.floor(duration))}</span>
          </div>

          <div className="player-controls">
            <button
              aria-label={isShuffleEnabled ? 'Disable shuffle' : 'Enable shuffle'}
              className={`icon-button ${isShuffleEnabled ? 'is-active' : ''}`}
              disabled={!nowPlaying}
              onClick={toggleShuffleMode}
              type="button"
            >
              <Shuffle size={16} />
            </button>
            <button aria-label="Previous track" className="icon-button" disabled={!nowPlaying} onClick={() => void playPreviousTrack()} type="button">
              <SkipBack size={18} />
            </button>
            <button className="play-button" onClick={togglePlayback} type="button">
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button aria-label="Next track" className="icon-button" disabled={!nowPlaying} onClick={() => void playNextTrack()} type="button">
              <SkipForward size={18} />
            </button>
            <button
              aria-label={repeatMode === 'one' ? 'Repeat one enabled' : repeatMode === 'all' ? 'Repeat all enabled' : 'Repeat disabled'}
              className={`icon-button ${repeatMode !== 'off' ? 'is-active' : ''}`}
              disabled={!nowPlaying}
              onClick={cycleRepeatMode}
              type="button"
            >
              <Repeat size={16} />
              {repeatMode === 'one' ? <span className="repeat-mode-badge">1</span> : null}
            </button>
          </div>
        </div>

        <div className="player-right">
          <div className="player-actions-row">
            <button
              aria-label={nowPlayingLiked ? 'Remove track from favorites' : 'Favorite current track'}
              className={`icon-button ${nowPlayingLiked ? 'is-active' : ''}`}
              disabled={!nowPlaying}
              onClick={toggleCurrentTrackLike}
              type="button"
            >
              <Heart size={16} fill={nowPlayingLiked ? 'currentColor' : 'none'} />
            </button>
            <button
              aria-label={isLyricsPanelOpen ? 'Close lyrics panel' : 'Open lyrics panel'}
              className={`icon-button ${isLyricsPanelOpen ? 'is-active' : ''}`}
              disabled={!nowPlaying}
              onClick={() => toggleSidePanel('lyrics')}
              type="button"
            >
              <MicVocal size={16} />
            </button>
            <button
              aria-label={isQueuePanelOpen ? 'Close queue panel' : 'Open queue panel'}
              className={`icon-button ${isQueuePanelOpen ? 'is-active' : ''}`}
              disabled={!nowPlaying}
              onClick={() => toggleSidePanel('queue')}
              type="button"
            >
              <ListMusic size={16} />
            </button>
            <button className="icon-button" disabled={!nowPlaying} onClick={openNowPlayingDownload} type="button">
              <Download size={16} />
            </button>
          </div>

          <div className="volume-slider-row">
            <Volume2 size={16} />
            <input
              className="player-slider"
              max={1}
              min={0}
              onChange={(event) => setVolume(Number(event.target.value))}
              step={0.01}
              style={getPlayerSliderStyle(volume, 1)}
              type="range"
              value={volume}
            />
          </div>
        </div>
      </footer>

      {showAuthModal ? (
        <div className="modal-overlay" onClick={() => (authBusy ? null : setShowAuthModal(false))}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>{authMode === 'login' ? 'Entrar' : 'Criar conta'}</h3>
            <p className="modal-subtle">
              {authMode === 'login'
                ? 'Acesse sua conta kPlayer para sincronizar playlists, recentes e configurações.'
                : 'Sua conta vai sincronizar playlists, recentes e configurações entre dispositivos.'}
            </p>
            {authMode === 'signup' ? (
              <input
                autoFocus
                className="modal-input"
                onChange={(e) => setAuthForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Nome (opcional)"
                type="text"
                value={authForm.name}
              />
            ) : null}
            <input
              autoFocus={authMode === 'login'}
              className="modal-input"
              onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="Email"
              type="email"
              value={authForm.email}
            />
            <input
              className="modal-input"
              onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !authBusy) {
                  void submitAuth();
                }
              }}
              placeholder={authMode === 'signup' ? 'Senha (mín. 8 caracteres)' : 'Senha'}
              type="password"
              value={authForm.password}
            />
            {authError ? <p className="modal-error">{authError}</p> : null}
            <div className="modal-actions modal-actions-split">
              <button
                className="ghost-pill"
                disabled={authBusy}
                onClick={() => setAuthMode((m) => (m === 'login' ? 'signup' : 'login'))}
                type="button"
              >
                {authMode === 'login' ? 'Criar conta' : 'Já tenho conta'}
              </button>
              <div className="modal-actions">
                <button className="ghost-pill" disabled={authBusy} onClick={() => setShowAuthModal(false)} type="button">
                  Cancelar
                </button>
                <button
                  className="ghost-pill modal-primary"
                  disabled={authBusy || !authForm.email.trim() || !authForm.password}
                  onClick={() => void submitAuth()}
                  type="button"
                >
                  {authBusy ? '...' : authMode === 'login' ? 'Entrar' : 'Criar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showProfileModal && authUser ? (
        <div className="modal-overlay" onClick={() => (profileBusy ? null : setShowProfileModal(false))}>
          <div className="modal-content profile-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Profile</h3>
            <div className="profile-avatar-section">
              <label className="profile-avatar-label" htmlFor="avatar-input">
                {profileForm.avatarPreview ? (
                  <img alt="Avatar" className="profile-avatar-img" src={profileForm.avatarPreview} />
                ) : (
                  <div className="profile-avatar-placeholder">
                    {(authUser.name?.[0] ?? authUser.email[0] ?? '?').toUpperCase()}
                  </div>
                )}
                <span className="profile-avatar-hint">Change photo</span>
              </label>
              <input accept="image/*" id="avatar-input" onChange={handleAvatarChange} style={{ display: 'none' }} type="file" />
            </div>
            <input
              className="modal-input"
              onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Display name"
              type="text"
              value={profileForm.name}
            />
            <input
              className="modal-input"
              onChange={(e) => setProfileForm((f) => ({ ...f, username: e.target.value }))}
              placeholder="Username"
              type="text"
              value={profileForm.username}
            />
            <input
              className="modal-input"
              disabled
              type="email"
              value={authUser.email}
            />
            {profileError ? <p className="modal-error">{profileError}</p> : null}
            <div className="modal-actions">
              <button className="ghost-pill" disabled={profileBusy} onClick={() => setShowProfileModal(false)} type="button">
                Cancel
              </button>
              <button
                className="ghost-pill modal-primary"
                disabled={profileBusy}
                onClick={() => void submitProfile()}
                type="button"
              >
                {profileBusy ? '...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCreatePlaylistModal ? (
        <div className="modal-overlay" onClick={() => setShowCreatePlaylistModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create Playlist</h3>
            <input
              autoFocus
              className="modal-input"
              onChange={(e) => setCreatePlaylistForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Playlist name"
              type="text"
              value={createPlaylistForm.name}
            />
            <input
              className="modal-input"
              onChange={(e) => setCreatePlaylistForm((f) => ({ ...f, coverUrl: e.target.value }))}
              placeholder="Cover image URL (optional)"
              type="url"
              value={createPlaylistForm.coverUrl}
            />
            <textarea
              className="modal-input modal-textarea"
              onChange={(e) => setCreatePlaylistForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
              value={createPlaylistForm.description}
            />
            <div className="modal-actions">
              <button className="ghost-pill" onClick={() => setShowCreatePlaylistModal(false)} type="button">
                Cancel
              </button>
              <button
                className="ghost-pill modal-primary"
                disabled={!createPlaylistForm.name.trim()}
                onClick={() => {
                  const pl = createPlaylist(
                    createPlaylistForm.name.trim(),
                    createPlaylistForm.description.trim(),
                    createPlaylistForm.coverUrl.trim(),
                  );
                  if (!pl) {
                    return;
                  }
                  if (addToPlaylistTrack) {
                    addTracksToPlaylist(pl.id, [addToPlaylistTrack]);
                    setStatus(`Added to ${pl.name}`);
                    setAddToPlaylistTrack(null);
                  }
                  setShowCreatePlaylistModal(false);
                  openPlaylist(pl.id);
                }}
                type="button"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renamePlaylistTarget ? (
        <div className="modal-overlay" onClick={() => setRenamePlaylistTarget(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Playlist</h3>
            <input
              autoFocus
              className="modal-input"
              onChange={(e) => setRenamePlaylistTarget((t) => (t ? { ...t, name: e.target.value } : t))}
              placeholder="Playlist name"
              type="text"
              value={renamePlaylistTarget.name}
            />
            <input
              className="modal-input"
              onChange={(e) => setRenamePlaylistTarget((t) => (t ? { ...t, coverUrl: e.target.value } : t))}
              placeholder="Cover image URL (optional)"
              type="url"
              value={renamePlaylistTarget.coverUrl}
            />
            <textarea
              className="modal-input modal-textarea"
              onChange={(e) => setRenamePlaylistTarget((t) => (t ? { ...t, description: e.target.value } : t))}
              placeholder="Description (optional)"
              value={renamePlaylistTarget.description}
            />
            <div className="modal-actions">
              <button className="ghost-pill" onClick={() => setRenamePlaylistTarget(null)} type="button">
                Cancel
              </button>
              <button
                className="ghost-pill modal-primary"
                disabled={!renamePlaylistTarget.name.trim()}
                onClick={() => {
                  updatePlaylist(renamePlaylistTarget.id, {
                    name: renamePlaylistTarget.name.trim(),
                    description: renamePlaylistTarget.description.trim(),
                    coverUrl: renamePlaylistTarget.coverUrl.trim(),
                  });
                  setRenamePlaylistTarget(null);
                }}
                type="button"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deletePlaylistTarget ? (
        <div className="modal-overlay" onClick={() => setDeletePlaylistTarget(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Playlist</h3>
            <p style={{ color: 'var(--muted)', margin: '8px 0 16px' }}>
              Are you sure you want to delete <strong style={{ color: 'var(--text)' }}>{deletePlaylistTarget.name}</strong>? This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="ghost-pill" onClick={() => setDeletePlaylistTarget(null)} type="button">
                Cancel
              </button>
              <button
                className="ghost-pill modal-primary"
                onClick={() => {
                  deletePlaylist(deletePlaylistTarget.id);
                  setDeletePlaylistTarget(null);
                }}
                style={{ background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addToPlaylistTrack ? (
        <div className="modal-overlay" onClick={() => setAddToPlaylistTrack(null)}>
          <div className="modal-content playlist-picker" onClick={(e) => e.stopPropagation()}>
            <h3>Add to playlist</h3>
            <input
              autoFocus
              className="modal-input"
              onChange={(e) => setPlaylistPickerSearch(e.target.value)}
              placeholder="Search playlists..."
              type="text"
              value={playlistPickerSearch}
            />
            <div className="playlist-picker-list">
              {playlists
                .filter((pl) => !playlistPickerSearch || pl.name.toLowerCase().includes(playlistPickerSearch.toLowerCase()))
                .map((pl) => (
                  <button
                    className="playlist-picker-item"
                    key={pl.id}
                    onClick={() => {
                      addTracksToPlaylist(pl.id, [addToPlaylistTrack]);
                      setStatus(`Added to ${pl.name}`);
                      setAddToPlaylistTrack(null);
                    }}
                    type="button"
                  >
                    <div className="playlist-picker-item-cover">
                      {pl.coverUrl ? (
                        <img alt={pl.name} src={pl.coverUrl} />
                      ) : pl.tracks.length > 0 && pl.tracks[0].album?.image ? (
                        <img alt={pl.name} src={getBestImageUrl(pl.tracks[0].album.image) ?? ''} />
                      ) : (
                        <ListMusic size={16} />
                      )}
                    </div>
                    <div className="playlist-picker-item-info">
                      <strong>{pl.name}</strong>
                      <span>{pl.tracks.length} {pl.tracks.length === 1 ? 'track' : 'tracks'}</span>
                    </div>
                  </button>
                ))}
              {playlists.length === 0 ? (
                <p className="playlist-picker-empty">No playlists yet.</p>
              ) : null}
            </div>
            <div className="modal-actions">
              <button className="ghost-pill" onClick={() => setAddToPlaylistTrack(null)} type="button">
                Cancel
              </button>
              <button
                className="ghost-pill modal-primary"
                onClick={() => {
                  setCreatePlaylistForm({ name: '', description: '', coverUrl: '' });
                  setShowCreatePlaylistModal(true);
                }}
                type="button"
              >
                New Playlist
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
