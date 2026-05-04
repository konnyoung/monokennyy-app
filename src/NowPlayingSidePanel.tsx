import { useEffect, useRef, useState } from 'react';
import { Download, GripVertical, Heart, Minus, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { ensureLyricsComponentLoaded, formatLyricsOffset, readLyricsOffset, writeLyricsOffset, type LyricsWebComponent } from './fullscreen-lyrics';
import type { QobuzTrack } from './types';

export type QueuePanelItem = {
  queueId: string;
  track: QobuzTrack;
  isCurrent: boolean;
  isLiked: boolean;
};

type NowPlayingSidePanelProps = {
  view: 'queue' | 'lyrics' | null;
  track: QobuzTrack | null;
  queueTitle: string;
  queueItems: QueuePanelItem[];
  isPlaying: boolean;
  position: number;
  formatDuration: (seconds: number) => string;
  getCoverForTrack: (track: QobuzTrack) => string;
  getCurrentTime: () => number;
  onClose: () => void;
  onPlayQueueIndex: (index: number) => void;
  onRemoveQueueIndex: (index: number) => void;
  onClearQueue: () => void;
  onLikeAllQueue: () => void;
  onToggleQueueTrackLike: (track: QobuzTrack) => void;
  onDownloadQueue: () => void;
  onLyricsSeek: (nextPosition: number) => void;
};

function setLyricsMessage(container: HTMLDivElement | null, text: string, className: string) {
  if (!container) {
    return;
  }

  const message = document.createElement('div');
  message.className = className;
  message.textContent = text;
  container.replaceChildren(message);
}

export function NowPlayingSidePanel({
  view,
  track,
  queueTitle,
  queueItems,
  isPlaying,
  position,
  formatDuration,
  getCoverForTrack,
  getCurrentTime,
  onClose,
  onPlayQueueIndex,
  onRemoveQueueIndex,
  onClearQueue,
  onLikeAllQueue,
  onToggleQueueTrackLike,
  onDownloadQueue,
  onLyricsSeek,
}: NowPlayingSidePanelProps) {
  const isOpen = view !== null;
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const lyricsElementRef = useRef<LyricsWebComponent | null>(null);
  const lyricsOffsetRef = useRef(0);
  const onLyricsSeekRef = useRef(onLyricsSeek);
  const getCurrentTimeRef = useRef(getCurrentTime);

  const [lyricsStatus, setLyricsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [lyricsOffset, setLyricsOffset] = useState(0);

  useEffect(() => {
    onLyricsSeekRef.current = onLyricsSeek;
  }, [onLyricsSeek]);

  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime;
  }, [getCurrentTime]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    lyricsOffsetRef.current = lyricsOffset;
  }, [lyricsOffset]);

  useEffect(() => {
    if (view !== 'lyrics' || !track) {
      const container = lyricsContainerRef.current;
      lyricsElementRef.current = null;
      if (container) {
        container.replaceChildren();
      }
      setLyricsStatus('idle');
      return;
    }

    let cancelled = false;
    const container = lyricsContainerRef.current;
    lyricsElementRef.current = null;
    const currentTrack = track;

    const storedOffset = readLyricsOffset(currentTrack.id);
    lyricsOffsetRef.current = storedOffset;
    setLyricsOffset(storedOffset);

    async function renderLyrics() {
      setLyricsStatus('loading');
      setLyricsMessage(container, 'Loading synced lyrics...', 'side-panel-placeholder');

      try {
        await ensureLyricsComponentLoaded();

        if (cancelled || !container) {
          return;
        }

        const lyricsElement = document.createElement('am-lyrics') as LyricsWebComponent;
        const title = currentTrack.title?.trim() ?? '';
        const artist = currentTrack.performer?.name?.trim() ?? '';
        const albumTitle = currentTrack.album?.title?.trim() ?? '';

        lyricsElement.setAttribute('song-title', title);
        lyricsElement.setAttribute('song-artist', artist);
        lyricsElement.setAttribute('query', `${title} ${artist}`.trim());
        if (albumTitle) {
          lyricsElement.setAttribute('song-album', albumTitle);
        }
        if (currentTrack.duration > 0) {
          lyricsElement.setAttribute('song-duration', String(Math.round(currentTrack.duration * 1000)));
        }
        lyricsElement.setAttribute('highlight-color', '#f6f4ef');
        lyricsElement.setAttribute('hover-background-color', 'rgba(232, 54, 93, 0.12)');
        lyricsElement.setAttribute('autoscroll', '');
        lyricsElement.setAttribute('interpolate', '');
        lyricsElement.style.width = '100%';
        lyricsElement.style.height = '100%';

        const handleLineClick = (event: Event) => {
          const detail = (event as CustomEvent<{ timestamp?: number }>).detail;
          if (typeof detail?.timestamp === 'number') {
            onLyricsSeekRef.current(detail.timestamp / 1000);
          }
        };

        lyricsElement.addEventListener('line-click', handleLineClick as EventListener);
        container.replaceChildren(lyricsElement);
        lyricsElementRef.current = lyricsElement;
        setLyricsStatus('ready');

        if (cancelled) {
          lyricsElement.removeEventListener('line-click', handleLineClick as EventListener);
          container.replaceChildren();
          lyricsElementRef.current = null;
        }
      } catch {
        if (!cancelled) {
          setLyricsMessage(container, 'Failed to load synced lyrics.', 'side-panel-placeholder');
          setLyricsStatus('error');
        }
      }
    }

    void renderLyrics();

    return () => {
      cancelled = true;
      lyricsElementRef.current = null;
      if (container) {
        container.replaceChildren();
      }
    };
  }, [view, track?.id]);

  useEffect(() => {
    if (view !== 'lyrics' || !track || !lyricsElementRef.current) {
      return;
    }

    lyricsElementRef.current.currentTime = Math.max(0, getCurrentTimeRef.current() * 1000 - lyricsOffsetRef.current);

    if (!isPlaying) {
      return;
    }

    let animationFrameId = 0;

    const tick = () => {
      if (lyricsElementRef.current) {
        lyricsElementRef.current.currentTime = Math.max(0, getCurrentTimeRef.current() * 1000 - lyricsOffsetRef.current);
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [view, track?.id, isPlaying, position, lyricsOffset]);

  function adjustLyricsOffset(deltaMs: number) {
    if (!track) {
      return;
    }

    const nextOffset = Math.max(-5000, Math.min(5000, lyricsOffsetRef.current + deltaMs));
    lyricsOffsetRef.current = nextOffset;
    setLyricsOffset(nextOffset);
    writeLyricsOffset(track.id, nextOffset);
  }

  function resetLyricsOffset() {
    if (!track) {
      return;
    }

    lyricsOffsetRef.current = 0;
    setLyricsOffset(0);
    writeLyricsOffset(track.id, 0);
  }

  return (
    <aside className={`side-panel ${isOpen ? 'active' : ''}`} data-view={view ?? undefined}>
      <div className="panel-header">
        <h3>{view === 'queue' ? queueTitle : 'Lyrics'}</h3>

        <div className="panel-controls">
          {view === 'queue' ? (
            <>
              <button className="icon-button side-panel-action" disabled={queueItems.length === 0} onClick={onDownloadQueue} title="Download queue" type="button">
                <Download size={16} />
              </button>
              <button className="icon-button side-panel-action" disabled={queueItems.length === 0} onClick={onLikeAllQueue} title="Save queue to favorites" type="button">
                <Heart size={16} />
              </button>
              <button className="icon-button side-panel-action" disabled={queueItems.length <= 1} onClick={onClearQueue} title="Clear queue" type="button">
                <Trash2 size={16} />
              </button>
            </>
          ) : null}

          {view === 'lyrics' ? (
            <div className="lyrics-timing-controls">
              <button className="icon-button side-panel-action" disabled={!track || lyricsStatus !== 'ready'} onClick={() => adjustLyricsOffset(-500)} title="Lyrics earlier" type="button">
                <Minus size={16} />
              </button>
              <span className="lyrics-timing-display">{formatLyricsOffset(lyricsOffset)}</span>
              <button className="icon-button side-panel-action" disabled={!track || lyricsStatus !== 'ready'} onClick={() => adjustLyricsOffset(500)} title="Lyrics later" type="button">
                <Plus size={16} />
              </button>
              <button className="icon-button side-panel-action" disabled={!track} onClick={resetLyricsOffset} title="Reset lyrics timing" type="button">
                <RotateCcw size={16} />
              </button>
            </div>
          ) : null}

          <button className="icon-button side-panel-action" onClick={onClose} title="Close panel" type="button">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="panel-content">
        {view === 'queue' ? (
          queueItems.length > 0 ? (
            <div className="queue-list">
              {queueItems.map((item, index) => (
                <div className={`queue-track-item ${item.isCurrent ? 'playing' : ''}`} key={item.queueId}>
                  <button className="queue-track-main" onClick={() => onPlayQueueIndex(index)} type="button">
                    <span aria-hidden="true" className="drag-handle">
                      <GripVertical size={16} />
                    </span>
                    <div className="track-item-info">
                      <img alt={item.track.album?.title ?? item.track.title ?? 'Queue cover'} className="track-item-cover" src={getCoverForTrack(item.track)} />
                      <div className="track-item-details">
                        <div className="title">{item.track.title ?? 'Untitled track'}</div>
                        <div className="artist">{item.track.performer?.name ?? item.track.album?.artist?.name ?? 'Unknown artist'}</div>
                      </div>
                    </div>
                    <div className="track-item-duration">{formatDuration(item.track.duration)}</div>
                  </button>
                  <button className={`queue-like-btn ${item.isLiked ? 'active' : ''}`} onClick={() => onToggleQueueTrackLike(item.track)} title={item.isLiked ? 'Remove from favorites' : 'Save to favorites'} type="button">
                    <Heart size={16} />
                  </button>
                  <button className="queue-remove-btn" onClick={() => onRemoveQueueIndex(index)} title="Remove from queue" type="button">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="side-panel-placeholder">Queue is empty.</div>
          )
        ) : null}

        {view === 'lyrics' ? (
          track ? (
            <div className="lyrics-panel-shell">
              <div className="lyrics-panel-copy">
                <strong>{track.title ?? 'Untitled track'}</strong>
                <span>{track.performer?.name ?? track.album?.artist?.name ?? 'Unknown artist'}</span>
              </div>
              <div className="lyrics-panel-content" ref={lyricsContainerRef} />
            </div>
          ) : (
            <div className="side-panel-placeholder">Select a track to load lyrics.</div>
          )
        ) : null}
      </div>
    </aside>
  );
}