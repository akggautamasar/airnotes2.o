import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Download, Settings
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { cleanFileName, formatSize } from '../../utils/format';

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SEEK_SECS = 10;

export default function VideoPlayer() {
  const { state, actions } = useApp();
  const file = state.openFile;
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hideControlsTimer = useRef(null);

  const [playing, setPlaying]         = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [volume, setVolume]           = useState(1);
  const [muted, setMuted]             = useState(false);
  const [fullscreen, setFullscreen]   = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [buffered, setBuffered]       = useState(0);
  const [speed, setSpeed]             = useState(1);
  const [showSpeed, setShowSpeed]     = useState(false);

  // Double-tap / tap gesture state
  const lastTapRef     = useRef({ time: 0, x: 0 });
  const tapTimerRef    = useRef(null);
  const seekIndicator  = useRef(null);
  const [seekFlash, setSeekFlash] = useState(null); // 'left' | 'right' | null

  const streamUrl = file ? api.getVideoStreamUrl(file.id) : null;
  const title     = file ? cleanFileName(file.name) : '';

  // ── Auto-hide controls ─────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    clearTimeout(hideControlsTimer.current);
    if (playing) {
      hideControlsTimer.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [playing]);

  useEffect(() => () => clearTimeout(hideControlsTimer.current), []);

  // ── Video events ───────────────────────────────────────────────────────
  function onLoadedMetadata() { setDuration(videoRef.current?.duration || 0); setLoading(false); }
  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
  }
  function onPlay()    { setPlaying(true);  }
  function onPause()   { setPlaying(false); }
  function onEnded()   { setPlaying(false); setShowControls(true); }
  function onError()   { setError('Failed to load video.'); setLoading(false); }
  function onWaiting() { setLoading(true);  }
  function onCanPlay() { setLoading(false); }

  // ── Controls ───────────────────────────────────────────────────────────
  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.pause(); else v.play();
    resetHideTimer();
  }

  function seek(e) {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
    resetHideTimer();
  }

  function skip(seconds) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, v.currentTime + seconds));
    resetHideTimer();
  }

  function changeVolume(e) {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) videoRef.current.volume = val;
    setMuted(val === 0);
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !muted;
    setMuted(!muted);
  }

  function changeSpeed(s) {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
    setShowSpeed(false);
  }

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!document.fullscreenElement) { el?.requestFullscreen?.(); setFullscreen(true); }
    else { document.exitFullscreen?.(); setFullscreen(false); }
  }

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Touch: double-tap to seek / single-tap to play-pause ──────────────
  function handleVideoTouch(e) {
    const touch = e.changedTouches[0];
    const now   = Date.now();
    const rect  = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const relX    = touch.clientX - rect.left;
    const width   = rect.width;
    const third   = width / 3;
    const zone    = relX < third ? 'left' : relX > width - third ? 'right' : 'center';
    const timeSinceLast = now - lastTapRef.current.time;
    const isSameSide    = Math.abs(relX - lastTapRef.current.x) < width * 0.35;

    if (timeSinceLast < 300 && isSameSide) {
      // Double tap
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
      if (zone === 'left') {
        skip(-SEEK_SECS);
        setSeekFlash('left');
        setTimeout(() => setSeekFlash(null), 600);
      } else if (zone === 'right') {
        skip(SEEK_SECS);
        setSeekFlash('right');
        setTimeout(() => setSeekFlash(null), 600);
      } else {
        togglePlay();
      }
      lastTapRef.current = { time: 0, x: 0 };
    } else {
      // Might be first tap — wait to confirm not double tap
      lastTapRef.current = { time: now, x: relX };
      tapTimerRef.current = setTimeout(() => {
        // Single tap confirmed — center = play/pause, sides = show controls
        if (zone === 'center') togglePlay();
        else resetHideTimer();
        tapTimerRef.current = null;
      }, 300);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft':  e.preventDefault(); skip(-SEEK_SECS); break;
        case 'ArrowRight': e.preventDefault(); skip(SEEK_SECS);  break;
        case 'ArrowUp':    e.preventDefault(); changeVolume({ target: { value: Math.min(1, volume + 0.1) } }); break;
        case 'ArrowDown':  e.preventDefault(); changeVolume({ target: { value: Math.max(0, volume - 0.1) } }); break;
        case 'm': toggleMute(); break;
        case 'f': toggleFullscreen(); break;
        case 'Escape': if (!document.fullscreenElement) actions.closeFile(); break;
        case '>': { const i = SPEEDS.indexOf(speed); if (i < SPEEDS.length - 1) changeSpeed(SPEEDS[i + 1]); break; }
        case '<': { const i = SPEEDS.indexOf(speed); if (i > 0) changeSpeed(SPEEDS[i - 1]); break; }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, volume, muted, speed]);

  if (!file) return null;

  const progressPct = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered  / duration) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">

      {/* ── Top bar ── */}
      <div className={`absolute top-0 left-0 right-0 z-10 flex items-center gap-3 px-4 py-3
                       bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300
                       ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all">
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{title}</p>
          <p className="text-white/50 text-xs">{formatSize(file.size)}</p>
        </div>
        <a href={streamUrl} download={file.name}
           className="text-white/70 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all"
           title="Download">
          <Download size={16} />
        </a>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all">
          <X size={18} />
        </button>
      </div>

      {/* ── Video area ── */}
      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center relative overflow-hidden"
        onMouseMove={resetHideTimer}
        onTouchEnd={handleVideoTouch}
        onClick={() => { /* clicks handled by touch for mobile; desktop uses mouse */ }}
      >
        {/* Desktop click-to-play (not on mobile) */}
        <div
          className="absolute inset-0 hidden sm:block cursor-pointer"
          onClick={togglePlay}
          onMouseMove={resetHideTimer}
        />

        {error ? (
          <div className="text-center z-10">
            <p className="text-red-400 mb-2">{error}</p>
            <button onClick={() => { setError(null); setLoading(true); videoRef.current?.load(); }}
                    className="text-white/60 text-sm underline">Retry</button>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={streamUrl}
            className="max-w-full max-h-full"
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay} onPause={onPause} onEnded={onEnded}
            onError={onError} onWaiting={onWaiting} onCanPlay={onCanPlay}
            playsInline
          />
        )}

        {/* Loading spinner */}
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Big play indicator (paused state) */}
        {!loading && !error && !playing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
              <Play size={28} className="text-white ml-1" fill="white" />
            </div>
          </div>
        )}

        {/* ── Double-tap seek flash ── */}
        {seekFlash === 'left' && (
          <div className="absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipBack size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">-{SEEK_SECS}s</span>
            </div>
          </div>
        )}
        {seekFlash === 'right' && (
          <div className="absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipForward size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">+{SEEK_SECS}s</span>
            </div>
          </div>
        )}

        {/* Tap zones hint — only shown when controls are visible */}
        {showControls && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 pointer-events-none
                          text-white/30 text-xs text-center hidden sm:block">
            ← {SEEK_SECS}s &nbsp;|&nbsp; tap to play/pause &nbsp;|&nbsp; {SEEK_SECS}s →
          </div>
        )}
      </div>

      {/* ── Bottom controls ── */}
      <div className={`absolute bottom-0 left-0 right-0 z-10 px-4 pb-4 pt-12
                       bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300
                       ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
           onMouseMove={resetHideTimer}>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-white/20 rounded-full mb-3 cursor-pointer relative group"
             onClick={seek}>
          <div className="absolute top-0 left-0 h-full bg-white/30 rounded-full"
               style={{ width: `${bufferedPct}%` }} />
          <div className="absolute top-0 left-0 h-full bg-white rounded-full transition-all"
               style={{ width: `${progressPct}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full
                         opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
               style={{ left: `calc(${progressPct}% - 7px)` }} />
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          {/* Play */}
          <button onClick={togglePlay} className="text-white hover:text-white/80 transition-colors">
            {playing ? <Pause size={22} fill="white" /> : <Play size={22} fill="white" className="ml-0.5" />}
          </button>

          {/* Skip */}
          <button onClick={() => skip(-SEEK_SECS)} className="text-white/70 hover:text-white" title={`Back ${SEEK_SECS}s`}>
            <SkipBack size={18} />
          </button>
          <button onClick={() => skip(SEEK_SECS)} className="text-white/70 hover:text-white" title={`Forward ${SEEK_SECS}s`}>
            <SkipForward size={18} />
          </button>

          {/* Time */}
          <span className="text-white/70 text-xs font-mono tabular-nums whitespace-nowrap">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Speed */}
          <div className="relative">
            <button onClick={() => setShowSpeed(s => !s)}
                    className="text-white/70 hover:text-white text-xs font-bold px-1.5 py-0.5
                               border border-white/30 rounded transition-colors">
              {speed}x
            </button>
            {showSpeed && (
              <div className="absolute bottom-8 right-0 bg-black/90 rounded-lg border border-white/20
                              overflow-hidden flex flex-col text-xs z-20">
                {SPEEDS.map(s => (
                  <button key={s} onClick={() => changeSpeed(s)}
                          className={`px-4 py-1.5 hover:bg-white/20 transition-colors text-right
                                     ${speed === s ? 'text-white font-bold' : 'text-white/70'}`}>
                    {s}x
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2">
            <button onClick={toggleMute} className="text-white/70 hover:text-white">
              {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input type="range" min="0" max="1" step="0.05"
                   value={muted ? 0 : volume} onChange={changeVolume}
                   className="w-20 accent-white cursor-pointer hidden sm:block" />
          </div>

          {/* Fullscreen */}
          <button onClick={toggleFullscreen} className="text-white/70 hover:text-white">
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>

        {/* Mobile hint: tap zones — only when controls visible */}
        {false && (
          <div className="flex justify-between text-white/25 text-xs mt-2 sm:hidden px-2">
            <span>← {SEEK_SECS}s</span>
            <span>tap = play/pause</span>
            <span>{SEEK_SECS}s →</span>
          </div>
        )}
      </div>
    </div>
  );
}
