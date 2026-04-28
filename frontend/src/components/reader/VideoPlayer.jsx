import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Download, Settings, Wifi, WifiOff
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { cleanFileName, formatSize } from '../../utils/format';

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

const SPEEDS   = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SEEK_SECS = 10;

// Quality levels — controls the backend chunk size
// "low"    = 512 KB chunks  → faster to start, may re-buffer on fast action
// "medium" = 1 MB chunks    → balanced
// "high"   = 2 MB chunks    → smoothest but slightly slower very first load
const QUALITIES = [
  { key: 'low',    label: '360p', desc: 'Faster start, uses less data' },
  { key: 'medium', label: '480p', desc: 'Balanced quality' },
  { key: 'high',   label: '720p', desc: 'Best quality, may be slower to start' },
];

export default function VideoPlayer() {
  const { state, actions } = useApp();
  const file = state.openFile;
  const videoRef      = useRef(null);
  const containerRef  = useRef(null);
  const hideTimer     = useRef(null);

  const [playing, setPlaying]           = useState(false);
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]         = useState(0);
  const [volume, setVolume]             = useState(1);
  const [muted, setMuted]               = useState(false);
  const [fullscreen, setFullscreen]     = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffering, setBuffering]       = useState(true);  // true = spinner shown
  const [error, setError]               = useState(null);
  const [buffered, setBuffered]         = useState(0);
  const [speed, setSpeed]               = useState(1);
  const [quality, setQuality]           = useState(() => localStorage.getItem('videoQuality') || 'medium');
  const [showSettings, setShowSettings] = useState(false);
  const [seekFlash, setSeekFlash]       = useState(null); // 'left'|'right'
  const [readyState, setReadyState]     = useState(0);   // video.readyState
  const [loadingMsg, setLoadingMsg]     = useState('Connecting to server…');

  // tap gesture
  const lastTap  = useRef({ time: 0, x: 0 });
  const tapTimer = useRef(null);

  // Build stream URL from quality
  const streamUrl = file ? api.getVideoStreamUrl(file.id, quality) : null;
  const title     = file ? cleanFileName(file.name) : '';

  // ── Loading message cycle ──────────────────────────────────────────────
  useEffect(() => {
    if (!buffering) return;
    const msgs = [
      'Connecting to server…',
      'Fetching from Telegram…',
      'Buffering first chunk…',
      'Almost ready…',
    ];
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % msgs.length;
      setLoadingMsg(msgs[i]);
    }, 3000);
    return () => clearInterval(iv);
  }, [buffering]);

  // ── Auto-hide controls ─────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    clearTimeout(hideTimer.current);
    if (playing) {
      hideTimer.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [playing]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // ── Video event handlers ───────────────────────────────────────────────
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration || 0);
    setReadyState(v.readyState);
    setLoadingMsg('Buffering first chunk…');
  };

  const onCanPlay = () => {
    const v = videoRef.current;
    setReadyState(v?.readyState || 3);
    setBuffering(false);
    setLoadingMsg('');
    // Auto-start play on first canplay
    if (v && !playing) {
      v.play().catch(() => {}); // may be blocked on some browsers without user gesture
    }
  };

  const onCanPlayThrough = () => {
    setBuffering(false);
    setReadyState(videoRef.current?.readyState || 4);
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    setReadyState(v.readyState);
    if (v.buffered.length > 0) {
      setBuffered(v.buffered.end(v.buffered.length - 1));
    }
  };

  const onPlay    = () => { setPlaying(true);  setBuffering(false); };
  const onPause   = () => { setPlaying(false); };
  const onEnded   = () => { setPlaying(false); setShowControls(true); };
  const onWaiting = () => { setBuffering(true); setLoadingMsg('Buffering…'); };
  const onPlaying = () => { setBuffering(false); };
  const onError   = () => { setError('Failed to load video. Try a different quality.'); setBuffering(false); };

  const onProgress = () => {
    const v = videoRef.current;
    if (!v || !v.buffered.length) return;
    setBuffered(v.buffered.end(v.buffered.length - 1));
  };

  // ── Quality change — reload video at same position ─────────────────────
  const changeQuality = (q) => {
    const v = videoRef.current;
    const savedTime = v ? v.currentTime : 0;
    const wasPlaying = playing;
    setQuality(q);
    localStorage.setItem('videoQuality', q);
    setShowSettings(false);
    setBuffering(true);
    setError(null);
    // After state update triggers new src, restore position
    requestAnimationFrame(() => {
      if (v) {
        v.load();
        v.addEventListener('loadedmetadata', () => {
          v.currentTime = savedTime;
          if (wasPlaying) v.play().catch(() => {});
        }, { once: true });
      }
    });
  };

  // ── Controls ───────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.pause(); else v.play().catch(() => {});
    resetHideTimer();
  };

  const seek = (e) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
    resetHideTimer();
  };

  const skip = (secs) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, v.currentTime + secs));
    resetHideTimer();
  };

  const changeVolume = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) videoRef.current.volume = val;
    setMuted(val === 0);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !muted;
    setMuted(!muted);
  };

  const changeSpeed = (s) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) { el?.requestFullscreen?.(); setFullscreen(true); }
    else { document.exitFullscreen?.(); setFullscreen(false); }
  };

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ── Touch gestures ─────────────────────────────────────────────────────
  const handleTouch = (e) => {
    const touch = e.changedTouches[0];
    const now   = Date.now();
    const rect  = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX  = touch.clientX - rect.left;
    const w     = rect.width;
    const zone  = relX < w / 3 ? 'left' : relX > w * 2/3 ? 'right' : 'center';
    const diff  = now - lastTap.current.time;
    const same  = Math.abs(relX - lastTap.current.x) < w * 0.35;

    if (diff < 300 && same) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (zone === 'left')  { skip(-SEEK_SECS); setSeekFlash('left');  setTimeout(() => setSeekFlash(null), 600); }
      else if (zone === 'right') { skip(SEEK_SECS); setSeekFlash('right'); setTimeout(() => setSeekFlash(null), 600); }
      else togglePlay();
      lastTap.current = { time: 0, x: 0 };
    } else {
      lastTap.current = { time: now, x: relX };
      tapTimer.current = setTimeout(() => {
        if (zone === 'center') togglePlay();
        else resetHideTimer();
        tapTimer.current = null;
      }, 300);
    }
  };

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft':   e.preventDefault(); skip(-SEEK_SECS); break;
        case 'ArrowRight':  e.preventDefault(); skip(SEEK_SECS);  break;
        case 'm': toggleMute(); break;
        case 'f': toggleFullscreen(); break;
        case 'Escape': if (!document.fullscreenElement) actions.closeFile(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, volume, muted, speed]);

  if (!file) return null;

  const progressPct = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered  / duration) * 100 : 0;
  const currentQuality = QUALITIES.find(q => q.key === quality) || QUALITIES[1];

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">

      {/* ── Top bar ── */}
      <div className={`absolute top-0 left-0 right-0 z-10 flex items-center gap-3 px-4 py-3
                       bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300
                       ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
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
        onTouchEnd={handleTouch}
      >
        {/* Desktop click-to-play */}
        <div className="absolute inset-0 hidden sm:block cursor-pointer z-0"
             onClick={togglePlay} onMouseMove={resetHideTimer} />

        {/* The video element — key changes when quality changes to force reload */}
        {!error && (
          <video
            key={`${file.id}-${quality}`}
            ref={videoRef}
            src={streamUrl}
            className="max-w-full max-h-full relative z-0"
            onLoadedMetadata={onLoadedMetadata}
            onCanPlay={onCanPlay}
            onCanPlayThrough={onCanPlayThrough}
            onTimeUpdate={onTimeUpdate}
            onProgress={onProgress}
            onPlay={onPlay}
            onPause={onPause}
            onEnded={onEnded}
            onWaiting={onWaiting}
            onPlaying={onPlaying}
            onError={onError}
            playsInline
            preload="auto"
          />
        )}

        {/* ── Buffering overlay ── */}
        {buffering && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
            <div className="w-14 h-14 border-2 border-white/20 border-t-white rounded-full animate-spin mb-4" />
            <p className="text-white/70 text-sm">{loadingMsg}</p>
            {duration === 0 && (
              <p className="text-white/40 text-xs mt-1">
                First load may take 10–30s depending on your connection
              </p>
            )}
          </div>
        )}

        {/* ── Error state ── */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
            <WifiOff size={40} className="text-red-400 mb-3" />
            <p className="text-red-400 font-medium mb-1">Playback Error</p>
            <p className="text-white/50 text-sm mb-4">{error}</p>
            <div className="flex gap-3">
              {QUALITIES.filter(q => q.key !== quality).map(q => (
                <button key={q.key} onClick={() => changeQuality(q.key)}
                        className="bg-white/10 hover:bg-white/20 text-white text-sm px-4 py-2 rounded-lg transition-colors">
                  Try {q.label}
                </button>
              ))}
              <button onClick={() => { setError(null); setBuffering(true); videoRef.current?.load(); }}
                      className="bg-white/10 hover:bg-white/20 text-white text-sm px-4 py-2 rounded-lg transition-colors">
                Retry
              </button>
            </div>
          </div>
        )}

        {/* ── Paused play button ── */}
        {!buffering && !error && !playing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5">
            <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
              <Play size={28} className="text-white ml-1" fill="white" />
            </div>
          </div>
        )}

        {/* ── Seek flash ── */}
        {seekFlash === 'left' && (
          <div className="absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipBack size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">-{SEEK_SECS}s</span>
            </div>
          </div>
        )}
        {seekFlash === 'right' && (
          <div className="absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipForward size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">+{SEEK_SECS}s</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom controls ── */}
      <div className={`absolute bottom-0 left-0 right-0 z-10 px-4 pb-safe-bottom pb-4 pt-12
                       bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300
                       ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
           onMouseMove={resetHideTimer}>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-white/20 rounded-full mb-3 cursor-pointer relative group"
             onClick={seek}>
          {/* Buffered */}
          <div className="absolute top-0 left-0 h-full bg-white/30 rounded-full transition-all"
               style={{ width: `${bufferedPct}%` }} />
          {/* Played */}
          <div className="absolute top-0 left-0 h-full bg-white rounded-full transition-all"
               style={{ width: `${progressPct}%` }} />
          {/* Scrubber dot */}
          <div className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full
                         opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
               style={{ left: `calc(${progressPct}% - 7px)` }} />
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">

          {/* Play/Pause */}
          <button onClick={togglePlay} className="text-white hover:text-white/80 transition-colors">
            {playing ? <Pause size={22} fill="white" /> : <Play size={22} fill="white" className="ml-0.5" />}
          </button>

          {/* Skip */}
          <button onClick={() => skip(-SEEK_SECS)} className="text-white/70 hover:text-white" title={`-${SEEK_SECS}s`}>
            <SkipBack size={18} />
          </button>
          <button onClick={() => skip(SEEK_SECS)} className="text-white/70 hover:text-white" title={`+${SEEK_SECS}s`}>
            <SkipForward size={18} />
          </button>

          {/* Time */}
          <span className="text-white/70 text-xs font-mono tabular-nums whitespace-nowrap">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Speed */}
          <div className="relative">
            <button onClick={() => { setShowSettings(false); }}
                    className="text-white/70 hover:text-white text-xs font-bold">
              {/* Speed selector inline */}
              <select
                value={speed}
                onChange={e => changeSpeed(parseFloat(e.target.value))}
                className="bg-transparent text-white/70 text-xs font-bold border border-white/30
                           rounded px-1.5 py-0.5 cursor-pointer appearance-none pr-3"
                style={{ WebkitAppearance: 'none' }}
              >
                {SPEEDS.map(s => <option key={s} value={s} className="bg-black">{s}x</option>)}
              </select>
            </button>
          </div>

          {/* Quality selector */}
          <div className="relative">
            <button
              onClick={() => setShowSettings(s => !s)}
              className={`flex items-center gap-1 text-xs font-semibold border rounded px-2 py-0.5 transition-colors
                         ${buffering ? 'text-yellow-400 border-yellow-400/50' : 'text-white/70 border-white/30 hover:text-white hover:border-white/60'}`}
              title="Quality"
            >
              <Settings size={12} className={buffering ? 'animate-spin' : ''} />
              {currentQuality.label}
            </button>
            {showSettings && (
              <div className="absolute bottom-9 right-0 bg-black/95 border border-white/20 rounded-xl
                              overflow-hidden z-30 min-w-[180px] shadow-2xl">
                <div className="px-3 py-2 border-b border-white/10">
                  <p className="text-white/50 text-xs font-semibold uppercase tracking-wider">Stream Quality</p>
                  <p className="text-white/30 text-xs mt-0.5">Single file from Telegram</p>
                </div>
                {QUALITIES.map(q => (
                  <button
                    key={q.key}
                    onClick={() => changeQuality(q.key)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 transition-colors text-left
                               ${quality === q.key ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
                  >
                    <div>
                      <p className="text-sm font-medium">{q.label}</p>
                      <p className="text-xs text-white/40">{q.desc}</p>
                    </div>
                    {quality === q.key && (
                      <div className="w-2 h-2 rounded-full bg-white ml-2 shrink-0" />
                    )}
                  </button>
                ))}
                <div className="px-3 py-2 border-t border-white/10">
                  <p className="text-white/25 text-xs leading-tight">
                    ⚡ If video is slow to start, try 360p
                  </p>
                </div>
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
      </div>
    </div>
  );
}
