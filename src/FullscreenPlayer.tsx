import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, MicVocal, Minus, Pause, Play, Plus, RotateCcw, Volume2, X } from 'lucide-react';
import { ensureLyricsComponentLoaded, formatLyricsOffset, readLyricsOffset, writeLyricsOffset, type LyricsWebComponent } from './fullscreen-lyrics';
import type { QobuzTrack } from './types';

type FullscreenPlayerProps = {
  isOpen: boolean;
  track: QobuzTrack | null;
  coverSrc: string;
  qualityLabel: string;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  onClose: () => void;
  onTogglePlayback: () => void;
  onSeek: (nextPosition: number) => void;
  onLyricsSeek: (nextPosition: number) => void;
  onVolumeChange: (nextVolume: number) => void;
  onDownload: () => void;
  formatDuration: (seconds: number) => string;
  getSliderStyle: (value: number, max: number) => CSSProperties;
  getCurrentTime: () => number;
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

export function FullscreenPlayer({
  isOpen,
  track,
  coverSrc,
  qualityLabel,
  isPlaying,
  position,
  duration,
  volume,
  onClose,
  onTogglePlayback,
  onSeek,
  onLyricsSeek,
  onVolumeChange,
  onDownload,
  formatDuration,
  getSliderStyle,
  getCurrentTime,
}: FullscreenPlayerProps) {
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const lyricsElementRef = useRef<LyricsWebComponent | null>(null);
  const lyricsOffsetRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onLyricsSeekRef = useRef(onLyricsSeek);
  const getCurrentTimeRef = useRef(getCurrentTime);

  const [lyricsStatus, setLyricsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [lyricsVisible, setLyricsVisible] = useState(true);
  const [lyricsOffset, setLyricsOffset] = useState(0);

  function adjustLyricsOffset(deltaMs: number) {
    if (!track) {
      return;
    }

    const nextOffset = Math.max(-5000, Math.min(5000, lyricsOffsetRef.current + deltaMs));
    lyricsOffsetRef.current = nextOffset;
    setLyricsOffset(nextOffset);
    writeLyricsOffset(track.id, nextOffset);
  }

  function resetStoredLyricsOffset() {
    if (!track) {
      return;
    }

    lyricsOffsetRef.current = 0;
    setLyricsOffset(0);
    writeLyricsOffset(track.id, 0);
  }

  useEffect(() => {
    lyricsOffsetRef.current = lyricsOffset;
  }, [lyricsOffset]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onLyricsSeekRef.current = onLyricsSeek;
  }, [onLyricsSeek]);

  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime;
  }, [getCurrentTime]);

  useEffect(() => {
    if (!isOpen || !track) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, track?.id]);

  useEffect(() => {
    if (!isOpen || !track) {
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
    setLyricsVisible(true);
    const currentTrack = track;

    const storedOffset = readLyricsOffset(currentTrack.id);
    lyricsOffsetRef.current = storedOffset;
    setLyricsOffset(storedOffset);

    async function renderLyrics() {
      setLyricsStatus('loading');
      setLyricsMessage(container, 'Loading synced lyrics...', 'fullscreen-lyrics-message loading');

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
          setLyricsMessage(container, 'Failed to load synced lyrics.', 'fullscreen-lyrics-message error');
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
  }, [isOpen, track?.id]);

  useEffect(() => {
    if (!isOpen || !track || !lyricsElementRef.current) {
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
  }, [isOpen, track?.id, isPlaying, position, lyricsOffset]);

  if (!isOpen || !track) {
    return null;
  }

  const artistName = track.performer?.name ?? 'Unknown artist';
  const albumTitle = track.album?.title ?? 'Unknown album';
  const lyricsUnavailable = lyricsStatus === 'error';
  const showLyricsPane = lyricsVisible && !lyricsUnavailable;

  return (
    <div
      className={`fullscreen-player-overlay ${showLyricsPane ? '' : 'lyrics-hidden'} ${lyricsUnavailable ? 'lyrics-unavailable' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div aria-hidden="true" className="fullscreen-player-backdrop" style={{ backgroundImage: `url(${coverSrc})` }} />
      <div aria-hidden="true" className="fullscreen-player-scrim" />

      <div className="fullscreen-player-content">
        <button aria-label="Dismiss fullscreen" className="fullscreen-dismiss-handle" onClick={onClose} type="button" />

        <button
          aria-label={showLyricsPane ? 'Hide synced lyrics' : 'Show synced lyrics'}
          className={`fullscreen-mobile-lyrics-toggle ${showLyricsPane ? 'active' : ''}`}
          disabled={lyricsUnavailable}
          onClick={() => setLyricsVisible((current) => !current)}
          type="button"
        >
          <MicVocal size={18} />
        </button>

        <div className="fullscreen-top-actions">
          <button
            aria-label={showLyricsPane ? 'Hide synced lyrics' : 'Show synced lyrics'}
            className={`fullscreen-lyrics-toggle ${showLyricsPane ? 'active' : ''}`}
            disabled={lyricsUnavailable}
            onClick={() => setLyricsVisible((current) => !current)}
            type="button"
          >
            <MicVocal size={20} />
          </button>
          <button aria-label="Close fullscreen" className="fullscreen-close-button" onClick={onClose} type="button">
            <X size={20} />
          </button>
        </div>

        <div className="fullscreen-shell">
          <div className="fullscreen-main-view">
            <div className="fullscreen-media-column">
              <div className="fullscreen-artwork-card">
                <img alt={albumTitle} className="fullscreen-cover-image" id="fullscreen-cover-image" src={coverSrc} />
              </div>

              <div className="fullscreen-track-info">
                <div className="fullscreen-track-text">
                  <h2>{track.title ?? 'Untitled track'}</h2>
                  <h3>{artistName}</h3>
                  <p>{albumTitle}</p>
                </div>

                <div className="fullscreen-track-badges">
                  <span className="fullscreen-quality-badge">{qualityLabel}</span>
                  <span className="fullscreen-quality-badge subtle">Synced lyrics</span>
                </div>

                <div className="fullscreen-actions-row">
                  <button className="fullscreen-action-button" onClick={onDownload} type="button">
                    <Download size={18} />
                    <span>Download</span>
                  </button>
                </div>

                <div className="fullscreen-lyrics-offset-row">
                  <span>Lyrics timing</span>
                  <div className="fullscreen-lyrics-offset-controls">
                    <button aria-label="Advance lyrics" onClick={() => adjustLyricsOffset(-500)} type="button">
                      <Minus size={14} />
                    </button>
                    <strong>{formatLyricsOffset(lyricsOffset)}</strong>
                    <button aria-label="Delay lyrics" onClick={() => adjustLyricsOffset(500)} type="button">
                      <Plus size={14} />
                    </button>
                    <button aria-label="Reset lyrics timing" onClick={resetStoredLyricsOffset} type="button">
                      <RotateCcw size={14} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="fullscreen-controls">
                <div className="fullscreen-progress-container">
                  <span>{formatDuration(Math.floor(position))}</span>
                  <input
                    className="player-slider"
                    max={duration || 0}
                    min={0}
                    onChange={(event) => onSeek(Number(event.target.value))}
                    style={getSliderStyle(Math.min(position, duration || 0), duration || 0)}
                    type="range"
                    value={Math.min(position, duration || 0)}
                  />
                  <span>{formatDuration(Math.floor(duration))}</span>
                </div>

                <div className="fullscreen-primary-controls">
                  <button className="fullscreen-play-button" onClick={onTogglePlayback} type="button">
                    {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
                  </button>
                </div>

                <div className="fullscreen-volume-container">
                  <Volume2 size={16} />
                  <input
                    className="player-slider"
                    max={1}
                    min={0}
                    onChange={(event) => onVolumeChange(Number(event.target.value))}
                    step={0.01}
                    style={getSliderStyle(volume, 1)}
                    type="range"
                    value={volume}
                  />
                </div>
              </div>
            </div>

            <aside className="fullscreen-lyrics-pane">
              <div className="fullscreen-lyrics-shell">
                <div className="fullscreen-lyrics-content" ref={lyricsContainerRef} />
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}