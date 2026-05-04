const { contextBridge, ipcRenderer } = require('electron');

function randomUUID() {
  return crypto.randomUUID();
}

const DOWNLOAD_PROGRESS_CHANNEL = 'kplayer:download-progress';

contextBridge.exposeInMainWorld('kplayer', {
  platform: process.platform,
  shell: 'electron',
  getArtistProfile: (artist) => ipcRenderer.invoke('kplayer:get-artist-profile', artist),
  getSimilarArtists: (artistName) => ipcRenderer.invoke('kplayer:get-similar-artists', artistName),
  setDiscordPresence: (payload) => ipcRenderer.invoke('kplayer:set-discord-presence', payload),
  clearDiscordPresence: () => ipcRenderer.invoke('kplayer:clear-discord-presence'),
  openExternal: (url) => ipcRenderer.invoke('kplayer:open-external', url),
  pickDownloadFolder: () => ipcRenderer.invoke('kplayer:pick-download-folder'),
  saveTrackDownload: (payload, onProgress) => {
    const requestId = randomUUID();
    const progressListener = typeof onProgress === 'function'
      ? (_event, eventPayload) => {
          if (eventPayload?.requestId === requestId) {
            onProgress(eventPayload);
          }
        }
      : null;

    if (progressListener) {
      ipcRenderer.on(DOWNLOAD_PROGRESS_CHANNEL, progressListener);
    }

    return ipcRenderer
      .invoke('kplayer:save-track-download', { ...payload, requestId })
      .finally(() => {
        if (progressListener) {
          ipcRenderer.removeListener(DOWNLOAD_PROGRESS_CHANNEL, progressListener);
        }
      });
  },
  listOfflineTracks: () => ipcRenderer.invoke('kplayer:list-offline-tracks'),
  deleteOfflineTrack: (trackId) => ipcRenderer.invoke('kplayer:delete-offline-track', trackId),
  revealPath: (filePath) => ipcRenderer.invoke('kplayer:reveal-path', filePath),
  checkForUpdate: () => ipcRenderer.invoke('kplayer:check-for-update'),
});