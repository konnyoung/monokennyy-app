const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { load } = require('cheerio');
const packageJson = require('../package.json');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ffmpegPath = require('ffmpeg-static');

const isDev = !app.isPackaged;
let mainWindow = null;
const OFFLINE_LIBRARY_DIR = 'offline-library';
const OFFLINE_MANIFEST_FILE = 'downloads.json';
const DOWNLOAD_PROGRESS_CHANNEL = 'kplayer:download-progress';
const DISCORD_RPC_CLIENT_ID = String(process.env.KPLAYER_DISCORD_CLIENT_ID ?? packageJson.kplayer?.discordRpcClientId ?? '').trim();
const DISCORD_RPC_ACTIVITY_NAME = String(packageJson.kplayer?.discordRpcActivityName ?? 'monochrome').trim() || 'monochrome';
const DISCORD_ACTIVITY_TYPE_LISTENING = 2;
const DISCORD_RPC_ASSETS = {
  largeImageKey: String(packageJson.kplayer?.discordRpcAssets?.largeImageKey ?? '').trim(),
  largeImageText: String(packageJson.kplayer?.discordRpcAssets?.largeImageText ?? '').trim(),
  playSmallImageKey: String(packageJson.kplayer?.discordRpcAssets?.playSmallImageKey ?? '').trim(),
  playSmallImageText: String(packageJson.kplayer?.discordRpcAssets?.playSmallImageText ?? '').trim(),
  pauseSmallImageKey: String(packageJson.kplayer?.discordRpcAssets?.pauseSmallImageKey ?? '').trim(),
  pauseSmallImageText: String(packageJson.kplayer?.discordRpcAssets?.pauseSmallImageText ?? '').trim(),
  idleSmallImageKey: String(packageJson.kplayer?.discordRpcAssets?.idleSmallImageKey ?? '').trim(),
  idleSmallImageText: String(packageJson.kplayer?.discordRpcAssets?.idleSmallImageText ?? '').trim(),
};
const DISCORD_RPC_BUTTONS = Array.isArray(packageJson.kplayer?.discordRpcButtons)
  ? packageJson.kplayer.discordRpcButtons
  : [];
const DISCORD_RPC_RECONNECT_DELAY_MS = 15_000;
const DISCORD_RPC_DEBUG = process.env.KPLAYER_DEBUG_RPC === '1';
const SIMILAR_ARTISTS_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const similarArtistsCache = new Map();

// ─── Raw Discord IPC client (bypasses discord-rpc lib) ───────────────────────
const net = require('node:net');

const DISCORD_IPC_OPCODES = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
let discordIpcSocket = null;
let discordIpcReady = false;
let discordIpcReconnectTimeout = null;
let discordIpcNonceCounter = 0;
let discordIpcPendingCallbacks = new Map();
let discordActivityRevision = 0;
let discordActivity = null;

// Mirror of DOWNLOAD_FORMATS from src/app-state.ts. Keep in sync.
const DOWNLOAD_FORMATS = {
  SOURCE_HIRES: { extension: 'flac', sourceQuality: '27', ffmpegArgs: null },
  SOURCE_FLAC:  { extension: 'flac', sourceQuality: '6',  ffmpegArgs: null },
  SOURCE_MP3:   { extension: 'mp3',  sourceQuality: '5',  ffmpegArgs: null },
  FLAC:         { extension: 'flac', sourceQuality: '27', ffmpegArgs: ['-vn', '-map_metadata', '-1', '-map', '0:a', '-c:a', 'flac'] },
  ALAC:         { extension: 'm4a',  sourceQuality: '27', ffmpegArgs: ['-vn', '-map_metadata', '-1', '-map', '0:a', '-c:a', 'alac'] },
  MP3_320: { extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100'] },
  MP3_256: { extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '256k', '-ar', '44100'] },
  MP3_128: { extension: 'mp3', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100'] },
  OGG_320: { extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '320k'] },
  OGG_256: { extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '256k'] },
  OGG_128: { extension: 'ogg', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'libvorbis', '-b:a', '128k'] },
  AAC_320: { extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '320k'] },
  AAC_256: { extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '256k'] },
  AAC_128: { extension: 'm4a', sourceQuality: '27', ffmpegArgs: ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '128k'] },
};

function resolveFfmpegBinary() {
  if (!ffmpegPath) return null;
  // In a packaged app, ffmpeg-static lives inside app.asar.unpacked because
  // binaries cannot run from inside an asar archive.
  if (app.isPackaged) {
    return ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  }
  return ffmpegPath;
}

async function transcodeWithFfmpeg(srcPath, outPath, args, onProgress) {
  const binary = resolveFfmpegBinary();
  if (!binary) {
    throw new Error('Bundled ffmpeg binary is unavailable');
  }

  await ensureDirectory(path.dirname(outPath));
  const fullArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-i', srcPath, ...args, outPath];

  return new Promise((resolve, reject) => {
    const child = spawn(binary, fullArgs, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        if (onProgress) {
          onProgress({ stage: 'transcoding', progress: 1 });
        }
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || 'unknown error'}`));
      }
    });
  });
}

function sanitizePathSegment(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function getOfflineLibraryRoot() {
  return path.join(app.getPath('userData'), OFFLINE_LIBRARY_DIR);
}

function getOfflineManifestPath() {
  return path.join(getOfflineLibraryRoot(), OFFLINE_MANIFEST_FILE);
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readOfflineManifest() {
  try {
    const raw = await fs.readFile(getOfflineManifestPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeOfflineManifest(entries) {
  await ensureDirectory(getOfflineLibraryRoot());
  await fs.writeFile(getOfflineManifestPath(), JSON.stringify(entries, null, 2), 'utf8');
}

function detectAudioExtension(contentType, quality) {
  const normalized = String(contentType ?? '').toLowerCase();
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'mp3';
  }

  if (normalized.includes('flac')) {
    return 'flac';
  }

  return quality === '5' ? 'mp3' : 'flac';
}

function isDiscordRpcEnabled() {
  return DISCORD_RPC_CLIENT_ID.length > 0;
}

function logDiscordRpc(message, payload) {
  if (!DISCORD_RPC_DEBUG) return;
  if (typeof payload === 'undefined') {
    console.log(`[discord-rpc] ${message}`);
  } else {
    console.log(`[discord-rpc] ${message}`, payload);
  }
}

function normalizeDiscordText(value, fallback) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 128);
  return normalized || fallback;
}

function sanitizeDiscordButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons
    .map((b) => {
      const label = String(b?.label ?? '').trim().slice(0, 32);
      const url = String(b?.url ?? '').trim().slice(0, 512);
      if (!label || !/^https?:\/\//i.test(url)) return null;
      return { label, url };
    })
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeDiscordImageReference(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (/^https?:\/\//i.test(normalized)) return normalized.slice(0, 300);
  return normalized.slice(0, 128);
}

// ─── Raw Discord IPC transport ───────────────────────────────────────────────

function getDiscordIpcPath(instance = 0) {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\discord-ipc-${instance}`;
  }
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'];
  for (const dir of dirs) {
    if (dir) return path.join(dir, `discord-ipc-${instance}`);
  }
  return `/tmp/discord-ipc-${instance}`;
}

function encodeIpcFrame(opcode, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const payloadBuf = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

function generateNonce() {
  discordIpcNonceCounter += 1;
  return `kplayer-${Date.now()}-${discordIpcNonceCounter}`;
}

function clearDiscordReconnectTimeout() {
  if (discordIpcReconnectTimeout) {
    clearTimeout(discordIpcReconnectTimeout);
    discordIpcReconnectTimeout = null;
  }
}

function scheduleDiscordRpcReconnect() {
  if (!isDiscordRpcEnabled() || discordIpcReconnectTimeout) return;
  discordIpcReconnectTimeout = setTimeout(() => {
    discordIpcReconnectTimeout = null;
    void connectDiscordIpc();
  }, DISCORD_RPC_RECONNECT_DELAY_MS);
}

function destroyDiscordIpc() {
  clearDiscordReconnectTimeout();
  discordIpcReady = false;
  for (const [, cb] of discordIpcPendingCallbacks) {
    cb.reject(new Error('IPC destroyed'));
  }
  discordIpcPendingCallbacks.clear();
  if (discordIpcSocket) {
    // Send CLOSE frame to tell Discord to drop the activity
    try {
      discordIpcSocket.write(encodeIpcFrame(DISCORD_IPC_OPCODES.CLOSE, {}));
    } catch {}
    try { discordIpcSocket.destroy(); } catch {}
    discordIpcSocket = null;
  }
}

function sendIpcFrame(opcode, data) {
  if (!discordIpcSocket || discordIpcSocket.destroyed) return false;
  try {
    discordIpcSocket.write(encodeIpcFrame(opcode, data));
    return true;
  } catch (e) {
    logDiscordRpc('send frame error', e.message);
    return false;
  }
}

function sendIpcCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const nonce = generateNonce();
    discordIpcPendingCallbacks.set(nonce, { resolve, reject });
    const sent = sendIpcFrame(DISCORD_IPC_OPCODES.FRAME, { cmd, args, nonce });
    if (!sent) {
      discordIpcPendingCallbacks.delete(nonce);
      reject(new Error('Socket not available'));
    }
    // Timeout after 10 seconds
    setTimeout(() => {
      if (discordIpcPendingCallbacks.has(nonce)) {
        discordIpcPendingCallbacks.delete(nonce);
        reject(new Error('IPC command timeout'));
      }
    }, 10000);
  });
}

async function connectDiscordIpc() {
  if (!isDiscordRpcEnabled()) {
    logDiscordRpc('disabled; no client id');
    return false;
  }

  if (discordIpcReady && discordIpcSocket && !discordIpcSocket.destroyed) {
    return true;
  }

  // If socket exists but not yet ready, it's still connecting — don't destroy it
  if (discordIpcSocket && !discordIpcSocket.destroyed) {
    logDiscordRpc('connection in progress, waiting for READY');
    return false;
  }

  destroyDiscordIpc();

  // Try pipe instances 0-9
  for (let instance = 0; instance < 10; instance++) {
    const pipePath = getDiscordIpcPath(instance);
    try {
      const connected = await new Promise((resolve, reject) => {
        const socket = net.createConnection(pipePath, () => {
          resolve(socket);
        });
        socket.once('error', reject);
        socket.setTimeout(5000, () => {
          socket.destroy();
          reject(new Error('Connection timeout'));
        });
      });

      discordIpcSocket = connected;
      discordIpcSocket.setTimeout(0); // clear connect timeout
      logDiscordRpc(`connected to pipe instance ${instance}`);
      break;
    } catch {
      continue;
    }
  }

  if (!discordIpcSocket) {
    logDiscordRpc('no Discord IPC pipe found');
    scheduleDiscordRpcReconnect();
    return false;
  }

  // Set up data reader
  let readBuffer = Buffer.alloc(0);

  discordIpcSocket.on('data', (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);

    while (readBuffer.length >= 8) {
      const opcode = readBuffer.readUInt32LE(0);
      const length = readBuffer.readUInt32LE(4);
      if (readBuffer.length < 8 + length) break; // incomplete frame

      const payloadBuf = readBuffer.subarray(8, 8 + length);
      readBuffer = readBuffer.subarray(8 + length);

      let payload;
      try { payload = JSON.parse(payloadBuf.toString('utf8')); } catch { continue; }

      handleDiscordIpcMessage(opcode, payload);
    }
  });

  discordIpcSocket.on('close', () => {
    logDiscordRpc('socket closed');
    discordIpcReady = false;
    discordIpcSocket = null;
    scheduleDiscordRpcReconnect();
  });

  discordIpcSocket.on('error', (err) => {
    logDiscordRpc('socket error', err.message);
    discordIpcReady = false;
    discordIpcSocket = null;
    scheduleDiscordRpcReconnect();
  });

  // Send handshake
  sendIpcFrame(DISCORD_IPC_OPCODES.HANDSHAKE, {
    v: 1,
    client_id: DISCORD_RPC_CLIENT_ID,
  });

  logDiscordRpc('handshake sent');
  return true;
}

function handleDiscordIpcMessage(opcode, payload) {
  if (opcode === DISCORD_IPC_OPCODES.FRAME) {
    // Check if it's a response to a pending command
    if (payload.nonce && discordIpcPendingCallbacks.has(payload.nonce)) {
      const cb = discordIpcPendingCallbacks.get(payload.nonce);
      discordIpcPendingCallbacks.delete(payload.nonce);
      if (payload.evt === 'ERROR') {
        cb.reject(new Error(payload.data?.message || 'Unknown RPC error'));
      } else {
        cb.resolve(payload);
      }
      return;
    }

    // Dispatch event
    if (payload.evt === 'READY') {
      discordIpcReady = true;
      logDiscordRpc('READY event received', { user: payload.data?.user?.username });
      // Apply current activity
      void applyDiscordActivity();
    }
  } else if (opcode === DISCORD_IPC_OPCODES.CLOSE) {
    logDiscordRpc('received CLOSE frame', payload);
    destroyDiscordIpc();
    scheduleDiscordRpcReconnect();
  } else if (opcode === DISCORD_IPC_OPCODES.PING) {
    sendIpcFrame(DISCORD_IPC_OPCODES.PONG, payload);
  }
}

// ─── Activity building ───────────────────────────────────────────────────────

function getDiscordActivityPid() {
  const candidateWindow = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const rendererPid = candidateWindow?.webContents?.getOSProcessId?.();
  if (Number.isFinite(rendererPid) && rendererPid > 0) return rendererPid;
  return process.pid;
}

function buildDiscordActivity(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      name: DISCORD_RPC_ACTIVITY_NAME,
      type: DISCORD_ACTIVITY_TYPE_LISTENING,
      details: 'Browsing music',
      assets: {
        large_image: DISCORD_RPC_ASSETS.largeImageKey || undefined,
        small_image: DISCORD_RPC_ASSETS.idleSmallImageKey || undefined,
        small_text: DISCORD_RPC_ASSETS.idleSmallImageText || 'Idle',
      },
    };
  }

  const trackTitle = normalizeDiscordText(payload.trackTitle, '');
  const artistName = normalizeDiscordText(payload.artistName, '');
  const albumTitle = normalizeDiscordText(payload.albumTitle, '');
  const coverUrl = normalizeDiscordImageReference(payload.coverUrl);
  const hasTrack = trackTitle.length > 0;
  const isPlaying = hasTrack && payload.isPlaying !== false;

  const activity = {
    name: DISCORD_RPC_ACTIVITY_NAME,
    type: DISCORD_ACTIVITY_TYPE_LISTENING,
    details: hasTrack ? trackTitle : 'Browsing music',
    state: hasTrack ? artistName || undefined : undefined,
    assets: {
      large_image: coverUrl || DISCORD_RPC_ASSETS.largeImageKey || undefined,
      large_text: hasTrack
        ? albumTitle || artistName || undefined
        : undefined,
      small_image: undefined,
      small_text: undefined,
    },
  };

  if (hasTrack && isPlaying) {
    activity.assets.small_image = DISCORD_RPC_ASSETS.playSmallImageKey || undefined;
    activity.assets.small_text = DISCORD_RPC_ASSETS.playSmallImageText || 'Playing';

    const durationSeconds = Math.max(0, Number(payload.durationSeconds ?? 0));
    const positionSeconds = Math.max(0, Number(payload.positionSeconds ?? 0));
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      const clampedPosition = Math.min(positionSeconds, durationSeconds);
      const nowMs = Date.now();
      activity.timestamps = {
        start: nowMs - Math.floor(clampedPosition * 1000),
        end: nowMs - Math.floor(clampedPosition * 1000) + Math.floor(durationSeconds * 1000),
      };
    }
  } else if (hasTrack) {
    activity.assets.small_image = DISCORD_RPC_ASSETS.pauseSmallImageKey || undefined;
    activity.assets.small_text = DISCORD_RPC_ASSETS.pauseSmallImageText || 'Paused';
  } else {
    activity.assets.small_image = DISCORD_RPC_ASSETS.idleSmallImageKey || undefined;
    activity.assets.small_text = DISCORD_RPC_ASSETS.idleSmallImageText || 'Idle';
  }

  const buttons = sanitizeDiscordButtons(DISCORD_RPC_BUTTONS);
  if (buttons.length > 0) {
    activity.buttons = buttons;
  }

  return activity;
}

async function applyDiscordActivity() {
  if (!discordIpcReady || !discordIpcSocket || discordIpcSocket.destroyed) {
    logDiscordRpc('skip apply; not connected');
    return false;
  }

  const revision = discordActivityRevision;
  const activity = buildDiscordActivity(discordActivity);
  const pid = getDiscordActivityPid();

  logDiscordRpc('applying activity', { pid, revision, activity });

  try {
    const response = await sendIpcCommand('SET_ACTIVITY', {
      pid,
      activity,
    });
    if (revision !== discordActivityRevision) {
      logDiscordRpc('stale revision after apply', { revision, current: discordActivityRevision });
      return false;
    }
    logDiscordRpc('activity applied OK', response?.data?.name);
    return true;
  } catch (error) {
    logDiscordRpc('activity apply failed', error.message);
    destroyDiscordIpc();
    scheduleDiscordRpcReconnect();
    return false;
  }
}

async function ensureDiscordRpcClient() {
  return connectDiscordIpc();
}

function buildTrackFilename(track, extension) {
  const trackNumber = Number.isFinite(track?.trackNumber) ? `${String(track.trackNumber).padStart(2, '0')} - ` : '';
  const artistName = sanitizePathSegment(track?.artistName) || 'Unknown Artist';
  const title = sanitizePathSegment(track?.title) || `Track ${track?.trackId ?? ''}`;
  return `${trackNumber}${artistName} - ${title}.${extension}`;
}

function buildOfflineFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

async function fetchTrackResponse(streamUrl) {
  const response = await fetch(streamUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  return response;
}

function emitDownloadProgress(webContents, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send(DOWNLOAD_PROGRESS_CHANNEL, payload);
}

async function streamResponseToFile(response, filePath, onProgress) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Download stream is unavailable');
  }

  const fileHandle = await fs.open(filePath, 'w');
  const totalBytes = Math.max(0, Number(response.headers.get('content-length') ?? 0));
  let bytesReceived = 0;
  let lastEmittedAt = 0;
  let streamError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.length === 0) {
        continue;
      }

      const chunk = Buffer.from(value);
      await fileHandle.write(chunk);
      bytesReceived += chunk.length;

      const now = Date.now();
      if (onProgress && (now - lastEmittedAt >= 90 || (totalBytes > 0 && bytesReceived >= totalBytes))) {
        onProgress({
          bytesReceived,
          totalBytes,
          progress: totalBytes > 0 ? Math.min(1, bytesReceived / totalBytes) : 0,
        });
        lastEmittedAt = now;
      }
    }
  } catch (error) {
    streamError = error;
  }

  await fileHandle.close();

  if (streamError) {
    await fs.unlink(filePath).catch(() => {});
    throw streamError;
  }

  if (onProgress) {
    onProgress({
      bytesReceived,
      totalBytes,
      progress: 1,
    });
  }

  return {
    bytesReceived,
    totalBytes,
    contentType: response.headers.get('content-type') ?? '',
  };
}

async function resolveDiskDirectory(preferredDirectory) {
  if (preferredDirectory) {
    await ensureDirectory(preferredDirectory);
    return preferredDirectory;
  }

  const parentWindow = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose a download folder',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function listOfflineTracks() {
  const manifest = await readOfflineManifest();
  const availableEntries = [];

  for (const entry of manifest) {
    try {
      await fs.access(entry.filePath);
      // Migrate legacy `quality` field to `format` for backward compat.
      let format = entry.format;
      if (!format) {
        if (entry.quality === '5') format = 'SOURCE_MP3';
        else if (entry.quality === '6') format = 'SOURCE_FLAC';
        else format = 'SOURCE_HIRES';
      }
      availableEntries.push({
        trackId: entry.trackId,
        title: entry.title,
        artistName: entry.artistName,
        albumId: entry.albumId,
        albumTitle: entry.albumTitle,
        coverUrl: entry.coverUrl,
        duration: entry.duration ?? 0,
        format,
        fileUrl: buildOfflineFileUrl(entry.filePath),
        downloadedAt: entry.downloadedAt,
        trackNumber: entry.trackNumber,
      });
    } catch {
      // Ignore missing files and drop them from the returned list.
    }
  }

  return availableEntries.sort((left, right) => right.downloadedAt - left.downloadedAt);
}

function slugifyArtistName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeArtistName(name) {
  return String(name ?? '').trim().toLocaleLowerCase();
}

function buildLastFmSimilarArtistsUrl(artistName) {
  const encodedName = encodeURIComponent(String(artistName ?? '').trim()).replace(/%20/g, '+');
  return `https://www.last.fm/music/${encodedName}/+similar`;
}

function getSimilarArtistsCacheKey(artist) {
  if (artist && typeof artist === 'object') {
    const artistId = typeof artist.id === 'number' ? artist.id : '';
    const artistSlug = typeof artist.slug === 'string' ? artist.slug : '';
    const artistName = typeof artist.name === 'string' ? artist.name : '';
    return `qobuz:${artistId}:${artistSlug}:${normalizeArtistName(artistName)}`;
  }

  return `lastfm:${normalizeArtistName(artist)}`;
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|li|ul|ol|br|span)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/ +/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim(),
  );
}

function extractArtistDescription(html, artistName) {
  const text = stripHtml(html);
  const possibleEndings = ['© Heather', 'Read more', 'Similar artists', 'DISCOGRAPHY', 'IN THE MAGAZINE'];
  const endIndex = possibleEndings
    .map((token) => text.indexOf(token))
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0];

  if (!endIndex) {
    return '';
  }

  const windowStart = Math.max(0, endIndex - 12000);
  const candidateWindow = text.slice(windowStart, endIndex);
  const nameIndex = candidateWindow.lastIndexOf(artistName);

  let description = nameIndex >= 0 ? candidateWindow.slice(nameIndex + artistName.length).trim() : candidateWindow.trim();
  description = description
    .split('Read more')[0]
    .split('Similar artists')[0]
    .split('DISCOGRAPHY')[0]
    .split('IN THE MAGAZINE')[0]
    .replace(/^[-–—:\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return description.length >= 120 ? description : '';
}

function parseSimilarArtists(html, artistName) {
  const $ = load(html);
  const seen = new Set([normalizeArtistName(artistName)]);
  const similarArtists = [];

  $('h3 a[href^="/music/"]').each((_index, element) => {
    const name = $(element).text().trim();
    const normalized = normalizeArtistName(name);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    similarArtists.push(name);

    if (similarArtists.length >= 12) {
      return false;
    }
  });

  if (similarArtists.length > 0) {
    return similarArtists;
  }

  const fallbackMatches = [...html.matchAll(/<a[^>]+href="\/music\/[^"#?]+"[^>]*>([^<]+)<\/a>/gi)];
  for (const match of fallbackMatches) {
    const name = decodeHtmlEntities(match[1]).trim();
    const normalized = normalizeArtistName(name);
    if (!normalized || seen.has(normalized) || name.length < 2) {
      continue;
    }

    seen.add(normalized);
    similarArtists.push(name);
    if (similarArtists.length >= 12) {
      break;
    }
  }

  return similarArtists;
}

function parseQobuzSimilarArtists(html, artistName) {
  const $ = load(html);
  const seen = new Set([normalizeArtistName(artistName)]);
  const similarArtists = [];

  $('a[href*="/interpreter/"]').each((_index, element) => {
    const name = $(element).text().replace(/\s+/g, ' ').trim();
    const normalized = normalizeArtistName(name);
    if (!normalized || seen.has(normalized) || name.length < 2 || /^\d+$/.test(name)) {
      return;
    }

    seen.add(normalized);
    similarArtists.push(name);

    if (similarArtists.length >= 16) {
      return false;
    }
  });

  return similarArtists;
}

async function fetchQobuzSimilarArtists(artist) {
  if (!artist?.id || !artist?.name) {
    return [];
  }

  const response = await fetch(buildQobuzArtistUrl(artist), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  });

  if (!response.ok) {
    return [];
  }

  const html = await response.text();
  return parseQobuzSimilarArtists(html, artist.name);
}

async function fetchLastFmSimilarArtists(artistName) {
  const normalizedName = normalizeArtistName(artistName);
  if (!normalizedName) {
    return [];
  }

  const response = await fetch(buildLastFmSimilarArtistsUrl(artistName), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    return [];
  }

  const html = await response.text();
  return parseSimilarArtists(html, artistName);
}

async function fetchSimilarArtists(artist) {
  const artistName = typeof artist === 'string' ? artist : artist?.name;
  const normalizedName = normalizeArtistName(artistName);
  if (!normalizedName) {
    return [];
  }

  const cacheKey = getSimilarArtistsCacheKey(artist);
  const cached = similarArtistsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SIMILAR_ARTISTS_CACHE_TTL_MS) {
    return cached.items;
  }

  let items = [];

  if (artist && typeof artist === 'object') {
    items = await fetchQobuzSimilarArtists(artist);
  }

  if (items.length === 0) {
    items = await fetchLastFmSimilarArtists(artistName);
  }

  similarArtistsCache.set(cacheKey, { fetchedAt: Date.now(), items });
  return items;
}

function buildQobuzArtistUrl(artist) {
  const slug = artist?.slug || slugifyArtistName(artist?.name);
  return `https://www.qobuz.com/gb-en/interpreter/${slug}/${artist?.id}`;
}

function createWindow() {
  const useWindowsTitleBarOverlay = process.platform === 'win32';
  const iconPath = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    icon: iconPath,
    titleBarStyle: useWindowsTitleBarOverlay ? 'hidden' : 'hiddenInset',
    titleBarOverlay: useWindowsTitleBarOverlay
      ? {
          color: '#0d0d0d',
          symbolColor: '#f4f4f5',
          height: 56,
        }
      : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL('http://127.0.0.1:5173');
    if (process.env.KPLAYER_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('kplayer:get-artist-profile', async (_event, artist) => {
  if (!artist?.id || !artist?.name) {
    return { description: '', url: '' };
  }

  const url = buildQobuzArtistUrl(artist);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });

    if (!response.ok) {
      return { description: '', url };
    }

    const html = await response.text();
    return {
      description: extractArtistDescription(html, artist.name),
      url,
    };
  } catch {
    return { description: '', url };
  }
});

ipcMain.handle('kplayer:get-similar-artists', async (_event, artistName) => {
  if ((typeof artistName !== 'string' && typeof artistName !== 'object') || !artistName) {
    return [];
  }

  try {
    return await fetchSimilarArtists(artistName);
  } catch {
    return [];
  }
});

ipcMain.handle('kplayer:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('kplayer:pick-download-folder', async () => {
  const directory = await resolveDiskDirectory('');
  return directory ?? '';
});

ipcMain.handle('kplayer:save-track-download', async (event, payload) => {
  const streamUrl = payload?.streamUrl;
  const target = payload?.target;
  const track = payload?.track;
  const format = payload?.format;
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';

  if (typeof streamUrl !== 'string' || !/^https?:\/\//i.test(streamUrl)) {
    throw new Error('Invalid download URL');
  }

  if (!track || typeof track.trackId !== 'number') {
    throw new Error('Invalid track metadata');
  }

  if (target !== 'app' && target !== 'disk') {
    throw new Error('Invalid download target');
  }

  const formatSpec = DOWNLOAD_FORMATS[format];
  if (!formatSpec) {
    throw new Error(`Unknown download format: ${format}`);
  }

  const artistFolder = sanitizePathSegment(track.artistName) || 'Unknown Artist';
  const albumFolder = sanitizePathSegment(track.albumTitle) || 'Singles';
  const response = await fetchTrackResponse(streamUrl);
  const reportProgress = requestId
    ? (progress) => emitDownloadProgress(event.sender, { requestId, ...progress })
    : null;

  const needsTranscode = formatSpec.ffmpegArgs !== null;
  const finalExtension = formatSpec.extension;
  const finalFilename = buildTrackFilename(track, finalExtension);

  const writeFinalFile = async (finalPath) => {
    await ensureDirectory(path.dirname(finalPath));

    if (!needsTranscode) {
      // Stream straight to destination — no transcoding required.
      await streamResponseToFile(response, finalPath, reportProgress);
      return;
    }

    // Download to a temp file, then transcode with ffmpeg, then remove temp.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kplayer-dl-'));
    const tmpPath = path.join(tmpDir, `source-${randomUUID()}`);
    try {
      await streamResponseToFile(response, tmpPath, (progress) => {
        if (reportProgress) {
          // Reserve the last 15% of the progress bar for the transcode step.
          reportProgress({
            ...progress,
            stage: 'downloading',
            progress: progress.totalBytes > 0 ? Math.min(0.85, progress.progress * 0.85) : 0,
          });
        }
      });

      if (reportProgress) {
        reportProgress({ stage: 'transcoding', progress: 0.9, bytesReceived: 0, totalBytes: 0 });
      }

      await transcodeWithFfmpeg(tmpPath, finalPath, formatSpec.ffmpegArgs, reportProgress);

      if (reportProgress) {
        const stat = await fs.stat(finalPath).catch(() => null);
        const finalBytes = stat ? stat.size : 0;
        reportProgress({ stage: 'complete', progress: 1, bytesReceived: finalBytes, totalBytes: finalBytes });
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (target === 'app') {
    const targetDirectory = path.join(getOfflineLibraryRoot(), artistFolder, albumFolder);
    const filePath = path.join(targetDirectory, finalFilename);
    await writeFinalFile(filePath);

    const manifest = await readOfflineManifest();
    const nextEntry = {
      trackId: track.trackId,
      title: track.title,
      artistName: track.artistName,
      albumId: track.albumId,
      albumTitle: track.albumTitle,
      coverUrl: track.coverUrl,
      duration: track.duration ?? 0,
      format,
      filePath,
      downloadedAt: Date.now(),
      trackNumber: track.trackNumber,
    };

    const nextManifest = [nextEntry, ...manifest.filter((entry) => entry.trackId !== track.trackId)];
    await writeOfflineManifest(nextManifest);

    return {
      cancelled: false,
      target,
      offlineTrack: {
        fileUrl: buildOfflineFileUrl(filePath),
        trackId: nextEntry.trackId,
        title: nextEntry.title,
        artistName: nextEntry.artistName,
        albumId: nextEntry.albumId,
        albumTitle: nextEntry.albumTitle,
        coverUrl: nextEntry.coverUrl,
        duration: nextEntry.duration,
        format: nextEntry.format,
        downloadedAt: nextEntry.downloadedAt,
        trackNumber: nextEntry.trackNumber,
      },
    };
  }

  const preferredDirectory = typeof payload?.preferredDirectory === 'string' ? payload.preferredDirectory : '';
  const resolvedDirectory = await resolveDiskDirectory(preferredDirectory);
  if (!resolvedDirectory) {
    return { cancelled: true, target };
  }

  const exportDirectory = path.join(resolvedDirectory, artistFolder, albumFolder);
  const filePath = path.join(exportDirectory, finalFilename);
  await writeFinalFile(filePath);

  return {
    cancelled: false,
    target,
    filePath,
  };
});

ipcMain.handle('kplayer:list-offline-tracks', async () => listOfflineTracks());

ipcMain.handle('kplayer:delete-offline-track', async (_event, trackId) => {
  if (typeof trackId !== 'number') {
    throw new Error('Invalid track id');
  }

  const manifest = await readOfflineManifest();
  const entry = manifest.find((item) => item.trackId === trackId);
  if (entry?.filePath) {
    try {
      await fs.unlink(entry.filePath);
    } catch {
      // Ignore deletion failures to keep the manifest in sync.
    }
  }

  await writeOfflineManifest(manifest.filter((item) => item.trackId !== trackId));
  return { success: true };
});

ipcMain.handle('kplayer:reveal-path', async (_event, filePath) => {
  if (typeof filePath === 'string' && filePath) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('kplayer:set-discord-presence', async (_event, payload) => {
  if (!isDiscordRpcEnabled()) {
    logDiscordRpc('presence update ignored; rpc disabled');
    return { enabled: false, connected: false };
  }

  discordActivity = payload;
  discordActivityRevision += 1;
  logDiscordRpc('presence update received', payload);
  const connected = await ensureDiscordRpcClient();
  if (connected && discordIpcReady) {
    await applyDiscordActivity();
  }

  return { enabled: true, connected: Boolean(discordIpcReady) };
});

ipcMain.handle('kplayer:clear-discord-presence', async () => {
  discordActivity = null;
  discordActivityRevision += 1;

  if (!discordIpcReady || !discordIpcSocket) {
    return { enabled: isDiscordRpcEnabled(), connected: false };
  }

  try {
    await sendIpcCommand('SET_ACTIVITY', {
      pid: getDiscordActivityPid(),
      activity: null,
    });
    return { enabled: true, connected: true };
  } catch {
    destroyDiscordIpc();
    scheduleDiscordRpcReconnect();
    return { enabled: true, connected: false };
  }
});

ipcMain.handle('kplayer:check-for-update', async () => {
  try {
    const https = require('node:https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://api.github.com/repos/konnyoung/monokennyy-app/releases/latest', {
        headers: { 'User-Agent': `monokennyy/${packageJson.version}`, Accept: 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });

    if (!data || !data.tag_name) return null;

    const latestVersion = data.tag_name.replace(/^v/, '');
    const currentVersion = packageJson.version;

    if (latestVersion === currentVersion) return null;

    const [cMajor = 0, cMinor = 0, cPatch = 0] = currentVersion.split('.').map(Number);
    const [lMajor = 0, lMinor = 0, lPatch = 0] = latestVersion.split('.').map(Number);
    const isNewer = lMajor > cMajor || (lMajor === cMajor && lMinor > cMinor) || (lMajor === cMajor && lMinor === cMinor && lPatch > cPatch);
    if (!isNewer) return null;

    const asset = (data.assets || []).find((a) => /\.exe$/i.test(a.name));

    return {
      currentVersion,
      latestVersion,
      releaseUrl: data.html_url,
      downloadUrl: asset?.browser_download_url || data.html_url,
      releaseNotes: data.body || '',
    };
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.kennyy.monokennyy');
  }
  if (isDiscordRpcEnabled()) {
    void ensureDiscordRpcClient();
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  destroyDiscordIpc();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});