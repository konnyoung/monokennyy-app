import { QOBUZ_API_BASE } from './env';
import type { ApiResponse, DownloadUrlData, QobuzAlbumDetail, QobuzSearchResults } from './types';

async function request<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, `${QOBUZ_API_BASE}/`).toString());

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.success || payload.data === undefined) {
    throw new Error('Invalid API response');
  }

  return payload.data;
}

export function searchQobuz(query: string, offset = 0) {
  return request<QobuzSearchResults>(
    `api/get-music?q=${encodeURIComponent(query)}&offset=${offset}`,
  );
}

export function getAlbum(albumId: string) {
  return request<QobuzAlbumDetail>(`api/get-album?album_id=${encodeURIComponent(albumId)}`);
}

export async function getTrackUrl(trackId: number, quality = '27') {
  const data = await request<DownloadUrlData>(
    `api/download-music?track_id=${trackId}&quality=${encodeURIComponent(quality)}`,
  );

  if (!data.url) {
    throw new Error('No stream URL returned by the proxy');
  }

  return data.url;
}