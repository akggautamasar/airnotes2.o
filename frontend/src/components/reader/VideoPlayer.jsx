import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Download, RotateCcw
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { cleanFileName, formatSize } from '../../utils/format';

function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

const SPEEDS    = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP_SECS = 10;

export default function VideoPlayer() {
  const { state, actions } = useApp();
  const file = state.openFile;

  const videoRef     = useRef(null);
  const containerRef = useRef(null);
  const hideRef      = useRef(null);
  const tapRef       = useRef({ time: 0, x: 0 });
  const tapTimer     = useRef(null);

  const [playing,      setPlaying]      = useState(false);
  const [currentTime,  setCurrentTime]  = useState(0);
  const [duration,     setDuration]     = useState(0);
  const [buffered,     setBuffered]     = useState(0);
  const [volume,       setVolume]       = useState(1);
  const [muted,        setMuted]        = useState(false);
  const [fullscreen,   setFullscreen]   = useState(false);
  const [showCtrl,     setShowCtrl]     = useState(true);
  const [buffering,    setBuffering]    = useState(true);
  const [error,        setError]        = useState(null);
  const [speed,        setSpeed]        = useState(1);
  const [seekFlash,    setSeekFlash]    = useState(null);

  const streamUrl = file ? api.getVideoStreamUrl(file.id) : null;
  const title     = file ? cleanFileName(file.name) : '';

  // ── controls auto-hide ───────────────────────────────────────────────
  const resetHide = useCallback(() => {
    setShowCtrl(true);
    clearTimeout(hideRef.current);
    if (playing) hideRef.current = setTimeout(() => setShowCtrl(false), 3000);
  }, [playing]);
  useEffect(() => () => clearTimeout(hideRef.current), []);

  // ── video events ─────────────────────────────────────────────────────
  const onMeta    = ()  => { const v = videoRef.current; if (v) setDuration(v.duration || 0); };
  const onCanPlay = ()  => { setBuffering(false); };
  const onPlaying = ()  => { setBuffering(false); setPlaying(true); };
  const onPause   = ()  => { setPlaying(false); setShowCtrl(true); };
  const onEnded   = ()  => { setPlaying(false); setShowCtrl(true); };
  const onWaiting = ()  => { setBuffering(true); };
  const onError   = ()  => { setError('Could not load video. Check your connection.'); setBuffering(false); };
  const onProgress = () => {
    const v = videoRef.current;
    if (v && v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
  };
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
  };

  // ── controls ─────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    playing ? v.pause() : v.play().catch(() => {});
    resetHide();
  };

  const skip = (secs) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, v.currentTime + secs));
    resetHide();
  };

  const seek = (e) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * duration;
    resetHide();
  };

  const setVol = (val) => {
    const v = videoRef.current;
    setVolume(val);
    setMuted(val === 0);
    if (v) { v.volume = val; v.muted = val === 0; }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
  };

  const setSpd = (s) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const toggleFS = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) { el?.requestFullscreen?.(); }
    else { document.exitFullscreen?.(); }
  };
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  // ── double-tap seek gesture ──────────────────────────────────────────
  const handleTouchEnd = (e) => {
    const touch = e.changedTouches[0];
    const now   = Date.now();
    const rect  = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX  = touch.clientX - rect.left;
    const zone  = relX < rect.width / 3 ? 'left' : relX > rect.width * 2/3 ? 'right' : 'center';
    const diff  = now - tapRef.current.time;
    const sameSide = Math.abs(relX - tapRef.current.x) < rect.width * 0.35;

    if (diff < 300 && sameSide) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (zone !== 'center') {
        const dir = zone === 'left' ? -1 : 1;
        skip(dir * SKIP_SECS);
        setSeekFlash(zone);
        setTimeout(() => setSeekFlash(null), 600);
      } else {
        togglePlay();
      }
      tapRef.current = { time: 0, x: 0 };
    } else {
      tapRef.current = { time: now, x: relX };
      tapTimer.current = setTimeout(() => {
        if (zone === 'center') togglePlay(); else resetHide();
        tapTimer.current = null;
      }, 300);
    }
  };

  // ── keyboard ─────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); skip(-SKIP_SECS); }
      if (e.key === 'ArrowRight') { e.preventDefault(); skip(SKIP_SECS); }
      if (e.key === 'm') toggleMute();
      if (e.key === 'f') toggleFS();
      if (e.key === 'Escape' && !document.fullscreenElement) actions.closeFile();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [playing, muted]);

  if (!file) return null;

  const pct  = duration ? (currentTime / duration) * 100 : 0;
  const bpct = duration ? (buffered   / duration) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">

      {/* ── top bar ── */}
      <div className={`absolute top-0 left-0 right-0 z-10 px-4 py-3
                       bg-gradient-to-b from-black/80 to-transparent
                       flex items-center gap-3 transition-opacity duration-300
                       ${showCtrl ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10">
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{title}</p>
          <p className="text-white/40 text-xs">{formatSize(file.size)}</p>
        </div>
        <a href={streamUrl} download={file.name}
           className="text-white/70 hover:text-white p-1.5 rounded-lg hover:bg-white/10">
          <Download size={16} />
        </a>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10">
          <X size={18} />
        </button>
      </div>

      {/* ── video + overlays ── */}
      <div
        ref={containerRef}
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        onMouseMove={resetHide}
        onTouchEnd={handleTouchEnd}
      >
        {/* desktop click-to-play */}
        <div className="absolute inset-0 hidden sm:block cursor-pointer z-0"
             onClick={togglePlay} />

        {!error && (
          <video
            ref={videoRef}
            src={streamUrl}
            className="max-w-full max-h-full z-0"
            preload="auto"
            playsInline
            onLoadedMetadata={onMeta}
            onCanPlay={onCanPlay}
            onPlaying={onPlaying}
            onPause={onPause}
            onEnded={onEnded}
            onWaiting={onWaiting}
            onTimeUpdate={onTimeUpdate}
            onProgress={onProgress}
            onError={onError}
          />
        )}

        {/* spinner — only while truly buffering */}
        {buffering && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="w-14 h-14 rounded-full border-2 border-white/20 border-t-white animate-spin" />
          </div>
        )}

        {/* paused icon */}
        {!buffering && !error && !playing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5">
            <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
              <Play size={28} className="text-white ml-1" fill="white" />
            </div>
          </div>
        )}

        {/* error */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3">
            <p className="text-white/70 text-sm">{error}</p>
            <button
              onClick={() => { setError(null); setBuffering(true); videoRef.current?.load(); }}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white
                         text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <RotateCcw size={14} /> Retry
            </button>
          </div>
        )}

        {/* seek flash — left */}
        {seekFlash === 'left' && (
          <div className="absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipBack size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">-{SKIP_SECS}s</span>
            </div>
          </div>
        )}
        {seekFlash === 'right' && (
          <div className="absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-white/20 rounded-full px-5 py-3 backdrop-blur-sm flex flex-col items-center gap-1">
              <SkipForward size={28} className="text-white" fill="white" />
              <span className="text-white text-xs font-semibold">+{SKIP_SECS}s</span>
            </div>
          </div>
        )}
      </div>

      {/* ── bottom controls ── */}
      <div className={`absolute bottom-0 left-0 right-0 z-10 px-4 pb-6 pt-12
                       bg-gradient-to-t from-black/90 to-transparent
                       transition-opacity duration-300
                       ${showCtrl ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
           onMouseMove={resetHide}>

        {/* progress */}
        <div className="w-full h-1.5 bg-white/20 rounded-full mb-4 cursor-pointer relative group"
             onClick={seek}>
          <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full"
               style={{ width: `${bpct}%` }} />
          <div className="absolute inset-y-0 left-0 bg-white rounded-full transition-all"
               style={{ width: `${pct}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow
                         opacity-0 group-hover:opacity-100 transition-opacity"
               style={{ left: `calc(${pct}% - 7px)` }} />
        </div>

        {/* row */}
        <div className="flex items-center gap-3">

          <button onClick={togglePlay} className="text-white hover:text-white/80">
            {playing
              ? <Pause size={22} fill="white" />
              : <Play  size={22} fill="white" className="ml-0.5" />}
          </button>

          <button onClick={() => skip(-SKIP_SECS)} className="text-white/70 hover:text-white">
            <SkipBack size={18} />
          </button>
          <button onClick={() => skip(SKIP_SECS)} className="text-white/70 hover:text-white">
            <SkipForward size={18} />
          </button>

          <span className="text-white/60 text-xs font-mono tabular-nums whitespace-nowrap">
            {fmt(currentTime)} / {fmt(duration)}
          </span>

          <div className="flex-1" />

          {/* speed */}
          <select
            value={speed}
            onChange={e => setSpd(parseFloat(e.target.value))}
            className="bg-transparent text-white/70 text-xs font-bold
                       border border-white/30 rounded px-1.5 py-0.5 cursor-pointer"
          >
            {SPEEDS.map(s => <option key={s} value={s} className="bg-black">{s}x</option>)}
          </select>

          {/* volume */}
          <button onClick={toggleMute} className="text-white/70 hover:text-white">
            {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input type="range" min="0" max="1" step="0.05"
                 value={muted ? 0 : volume}
                 onChange={e => setVol(parseFloat(e.target.value))}
                 className="w-20 accent-white cursor-pointer hidden sm:block" />

          {/* fullscreen */}
          <button onClick={toggleFS} className="text-white/70 hover:text-white">
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
