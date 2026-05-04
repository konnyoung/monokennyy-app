export interface QobuzImage {
  small?: string;
  medium?: string;
  thumbnail?: string;
  large?: string;
  extralarge?: string;
  mega?: string;
  back?: string | null;
}

export interface QobuzLabel {
  name?: string;
}

export interface QobuzArtist {
  id: number;
  name?: string;
  image?: QobuzImage;
  picture?: string | null;
  slug?: string;
  albums_count?: number;
}

export interface QobuzAlbum {
  id?: string;
  title?: string;
  image?: QobuzImage;
  artist?: QobuzArtist;
  label?: QobuzLabel;
  url?: string;
  tracks_count: number;
  duration: number;
  hires: boolean;
  maximum_bit_depth: number;
  maximum_sampling_rate: number;
  parental_warning?: boolean;
  release_date_original?: string;
}

export interface QobuzTrack {
  id: number;
  title?: string;
  track_number: number;
  duration: number;
  hires: boolean;
  copyright?: string;
  parental_warning?: boolean;
  media_number?: number;
  maximum_technical_specifications?: string;
  performer?: QobuzArtist;
  album?: QobuzAlbum;
}

export interface QobuzListPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface QobuzSearchResults {
  query?: string;
  albums?: QobuzListPage<QobuzAlbum>;
  tracks?: QobuzListPage<QobuzTrack>;
  artists?: QobuzListPage<QobuzArtist>;
}

export interface QobuzAlbumDetail extends QobuzAlbum {
  tracks?: QobuzListPage<QobuzTrack>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

export interface DownloadUrlData {
  url?: string;
}