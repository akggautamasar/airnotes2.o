import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Download, RotateCcw,
  Clock
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

// ── Resume storage helpers ────────────────────────────────────────────────────
const RESUME_KEY   = 'airnotes_resume';
const RESUME_THRESHOLD = 30;        // don't save position if < 30s played
const RESUME_END_MARGIN = 60;       // treat as "finished" if within last 60s

function getSavedPositions() {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}'); } catch { return {}; }
}
function savePosition(fileId, time, duration) {
  if (!fileId || time < RESUME_THRESHOLD) return;
  if (duration && time >= duration - RESUME_END_MARGIN) {
    // Finished — clear saved position
    const d = getSavedPositions();
    delete d[fileId];
    localStorage.setItem(RESUME_KEY, JSON.stringify(d));
    return;
  }
  const d = getSavedPositions();
  d[fileId] = { time: Math.floor(time), savedAt: Date.now() };
  // Keep only last 50 entries
  const keys = Object.keys(d);
  if (keys.length > 50) delete d[keys[0]];
  localStorage.setItem(RESUME_KEY, JSON.stringify(d));
}
function getResumeTime(fileId) {
  const d = getSavedPositions();
  return d[fileId]?.time || 0;
}
function clearResumeTime(fileId) {
  const d = getSavedPositions();
  delete d[fileId];
  localStorage.setItem(RESUME_KEY, JSON.stringify(d));
}

const SPEEDS    = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_SECS = 10;

export default function VideoPlayer() {
  const { state, actions } = useApp();
  const file = state.openFile;

  const videoRef     = useRef(null);
  const containerRef = useRef(null);
  const hideRef      = useRef(null);
  const tapRef       = useRef({ time: 0, x: 0 });
  const tapTimer     = useRef(null);
  const saveRef      = useRef(null);         // interval for periodic position save
  const seekingRef   = useRef(false);        // suppress time updates while scrubbing

  const [playing,       setPlaying]      = useState(false);
  const [currentTime,   setCurrentTime]  = useState(0);
  const [duration,      setDuration]     = useState(0);
  const [buffered,      setBuffered]     = useState(0);
  const [volume,        setVolume]       = useState(1);
  const [muted,         setMuted]        = useState(false);
  const [fullscreen,    setFullscreen]   = useState(false);
  const [showCtrl,      setShowCtrl]     = useState(true);
  const [buffering,     setBuffering]    = useState(true);
  const [error,         setError]        = useState(null);
  const [speed,         setSpeed]        = useState(1);
  const [seekFlash,     setSeekFlash]    = useState(null);
  const [useTranscode,  setUseTranscode] = useState(false);
  const [audioCodec,    setAudioCodec]   = useState(null);
  const [audioTracks,   setAudioTracks]  = useState([]);
  const [audioTrack,    setAudioTrack]   = useState(0);
  const [resumePrompt,  setResumePrompt] = useState(null);  // { time } to show resume banner
  const [scrubTime,     setScrubTime]    = useState(null);  // preview time while dragging seek bar
  const [qualities,     setQualities]    = useState({});    // {label: {file_id, ready, size}}
  const [activeQuality, setActiveQuality] = useState('original'); // currently selected quality

  const activeFileId = (activeQuality !== 'original' && qualities[activeQuality]?.file_id) ? qualities[activeQuality].file_id : (file?.id ?? null);
  const normalUrl    = activeFileId ? api.getVideoStreamUrl(activeFileId) : null;
  const transcodeUrl = activeFileId ? api.getTranscodeStreamUrl(activeFileId, 0, audioTrack) : null;
  const streamUrl    = useTranscode ? transcodeUrl : normalUrl;
  const title        = file ? cleanFileName(file.name) : '';

  const rawMime   = (file?.mime || '').toLowerCase();
  const videoType = rawMime === 'video/webm' ? 'video/webm'
                  : rawMime === 'video/mp2t' ? 'video/mp2t'
                  : 'video/mp4';

  // ── Probe audio codec + check resume on file open ────────────────────────
  useEffect(() => {
    if (!file) return;
    setUseTranscode(false);
    setAudioCodec(null);
    setAudioTracks([]);
    setAudioTrack(0);
    setResumePrompt(null);
    setCurrentTime(0);
    setDuration(0);

    // Check saved resume position
    const saved = getResumeTime(file.id);
    if (saved > RESUME_THRESHOLD) setResumePrompt({ time: saved });

    // Fetch quality variants
    setQualities({});
    setActiveQuality('original');
    api.getQualities(file.id)
      .then(q => setQualities(q))
      .catch(() => {});  // non-critical, quality selector just won't show

    // Delay audio codec check by 1s so video starts buffering immediately
    const _audioTimer = setTimeout(() => {
      api.getAudioInfo(file.id)
        .then(({ codec, needs_transcode, audio_tracks }) => {
          setAudioCodec(codec);
          if (audio_tracks && audio_tracks.length > 1) setAudioTracks(audio_tracks);
          if (needs_transcode) {
            setUseTranscode(true);
            const v = videoRef.current;
            if (v) { const t = v.currentTime; v.load(); v.currentTime = t; v.play().catch(() => {}); }
          }
        })
        .catch(() => {
          setUseTranscode(true);
          const v = videoRef.current;
          if (v) { v.load(); v.play().catch(() => {}); }
        });
    }, 1000);
    return () => clearTimeout(_audioTimer);
  }, [file?.id]);

  // ── Periodic position save (every 5s while playing) ──────────────────────
  useEffect(() => {
    if (playing && file) {
      saveRef.current = setInterval(() => {
        savePosition(file.id, currentTime, duration);
      }, 5000);
    }
    return () => clearInterval(saveRef.current);
  }, [playing, file?.id]);

  // ── Save on unmount / close ───────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (file) savePosition(file.id, currentTime, duration);
    };
  }, [file?.id, currentTime, duration]);

  // ── Controls auto-hide ───────────────────────────────────────────────────
  const resetHide = useCallback(() => {
    setShowCtrl(true);
    clearTimeout(hideRef.current);
    if (playing) hideRef.current = setTimeout(() => setShowCtrl(false), 3000);
  }, [playing]);
  useEffect(() => () => clearTimeout(hideRef.current), []);

  // ── Video events ─────────────────────────────────────────────────────────
  const onMeta    = () => { const v = videoRef.current; if (v) setDuration(v.duration || 0); };
  const onCanPlay = () => { setBuffering(false); };
  const onPlaying = () => { setBuffering(false); setPlaying(true); };
  const onPause   = () => { setPlaying(false); setShowCtrl(true); if (file) savePosition(file.id, currentTime, duration); };
  const onEnded   = () => { setPlaying(false); setShowCtrl(true); if (file) savePosition(file.id, duration, duration); };
  const onWaiting = () => { setBuffering(true); };
  const onError   = () => { setError('Could not load video. Check your connection.'); setBuffering(false); };
  const onProgress = () => {
    const v = videoRef.current;
    if (v && v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
  };
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || seekingRef.current) return;
    setCurrentTime(v.currentTime);
    if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
  };

  // ── Controls ─────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    playing ? v.pause() : v.play().catch(() => {});
    resetHide();
  };

  const seekTranscode = useCallback((targetTime) => {
    const v = videoRef.current;
    if (!v) return;
    const url = api.getTranscodeStreamUrl(file.id, targetTime, audioTrack);
    v.src = url;
    v.load();
    v.play().catch(() => {});
    setCurrentTime(targetTime);
  }, [file?.id, audioTrack]);

  const skip = (secs) => {
    const v = videoRef.current;
    if (!v) return;
    const targetTime = Math.max(0, Math.min(duration, currentTime + secs));
    if (useTranscode) { seekTranscode(targetTime); }
    else { v.currentTime = targetTime; }
    resetHide();
  };

  // ── Seek bar: drag support ────────────────────────────────────────────────
  const seekBarRef = useRef(null);

  const getSeekTime = (clientX) => {
    const r = seekBarRef.current?.getBoundingClientRect();
    if (!r || !duration) return null;
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const commitSeek = (targetTime) => {
    seekingRef.current = false;
    setScrubTime(null);
    if (useTranscode) { seekTranscode(targetTime); }
    else { const v = videoRef.current; if (v) v.currentTime = targetTime; setCurrentTime(targetTime); }
    resetHide();
  };

  const onSeekMouseDown = (e) => {
    seekingRef.current = true;
    const t = getSeekTime(e.clientX);
    if (t !== null) setScrubTime(t);
    const onMove = (ev) => { const tt = getSeekTime(ev.clientX); if (tt !== null) setScrubTime(tt); };
    const onUp   = (ev) => { const tt = getSeekTime(ev.clientX); commitSeek(tt ?? scrubTime ?? currentTime); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const onSeekTouchStart = (e) => {
    seekingRef.current = true;
    const t = getSeekTime(e.touches[0].clientX);
    if (t !== null) setScrubTime(t);
  };
  const onSeekTouchMove = (e) => {
    e.preventDefault();
    const t = getSeekTime(e.touches[0].clientX);
    if (t !== null) setScrubTime(t);
  };
  const onSeekTouchEnd = (e) => {
    const t = getSeekTime(e.changedTouches[0].clientX);
    commitSeek(t ?? scrubTime ?? currentTime);
  };

  const setVol = (val) => {
    const v = videoRef.current;
    setVolume(val); setMuted(val === 0);
    if (v) { v.volume = val; v.muted = val === 0; }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next; setMuted(next);
  };

  const setSpd = (s) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const switchAudioTrack = (idx) => {
    const v = videoRef.current;
    const t = v ? currentTime : 0;
    setAudioTrack(idx);
    if (useTranscode) {
      const url = api.getTranscodeStreamUrl(file.id, t, idx);
      v.src = url; v.load(); v.play().catch(() => {});
    }
  };

  const switchQuality = (label) => {
    const v = videoRef.current;
    const t = v ? currentTime : 0;
    setActiveQuality(label);
    // If encoded variant is ready, it's already an MP4 — no transcode needed
    if (label !== 'original' && qualities[label]?.file_id) {
      setUseTranscode(false); // encoded variants are already AAC/MP4
    }
    if (v) {
      v.pause();
      // Let useEffect re-derive streamUrl from new activeFileId, then reload
      setTimeout(() => { v.load(); v.currentTime = t; v.play().catch(() => {}); }, 50);
    }
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

  // ── Resume handlers ───────────────────────────────────────────────────────
  const doResume = () => {
    const t = resumePrompt.time;
    setResumePrompt(null);
    if (useTranscode) { seekTranscode(t); }
    else { const v = videoRef.current; if (v) { v.currentTime = t; v.play().catch(() => {}); } }
  };
  const dismissResume = () => {
    clearResumeTime(file.id);
    setResumePrompt(null);
  };

  // ── Double-tap seek gesture ───────────────────────────────────────────────
  const handleTouchEnd = (e) => {
    // Don't trigger if touching the seek bar
    if (e.target.closest('[data-seekbar]')) return;
    const touch = e.changedTouches[0];
    const now   = Date.now();
    const rect  = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX  = touch.clientX - rect.left;
    const zone  = relX < rect.width / 3 ? 'left' : relX > rect.width * 2/3 ? 'right' : 'center';
    const diff  = now - tapRef.current.time;
    const sameSide = Math.abs(relX - tapRef.current.x) < rect.width * 0.35;

    if (diff < 300 && sameSide) {
      clearTimeout(tapTimer.current); tapTimer.current = null;
      if (zone !== 'center') {
        const dir = zone === 'left' ? -1 : 1;
        skip(dir * SKIP_SECS);
        setSeekFlash(zone);
        setTimeout(() => setSeekFlash(null), 600);
      } else { togglePlay(); }
      tapRef.current = { time: 0, x: 0 };
    } else {
      tapRef.current = { time: now, x: relX };
      tapTimer.current = setTimeout(() => {
        if (zone === 'center') togglePlay(); else resetHide();
        tapTimer.current = null;
      }, 300);
    }
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); skip(-SKIP_SECS); }
      if (e.key === 'ArrowRight') { e.preventDefault(); skip(SKIP_SECS); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); setVol(Math.min(1, volume + 0.1)); }
      if (e.key === 'ArrowDown')  { e.preventDefault(); setVol(Math.max(0, volume - 0.1)); }
      if (e.key === 'm') toggleMute();
      if (e.key === 'f') toggleFS();
      if (e.key === 'Escape' && !document.fullscreenElement) actions.closeFile();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [playing, muted, volume]);

  if (!file) return null;

  const displayTime = scrubTime ?? currentTime;
  const pct  = duration ? (displayTime / duration) * 100 : 0;
  const bpct = duration ? (buffered    / duration) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">

      {/* ── Top bar ── */}
      <div className={`absolute top-0 left-0 right-0 z-10 px-3 py-2
                       bg-gradient-to-b from-black/80 to-transparent
                       flex items-center gap-2 transition-opacity duration-300
                       ${showCtrl ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 shrink-0">
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate leading-tight">{title}</p>
          <p className="text-white/40 text-[11px] flex items-center gap-2 flex-wrap">
            {formatSize(file.size)}
            {useTranscode && (
              <span className="text-yellow-400/80 font-medium">
                ⚡ {audioCodec} → AAC
              </span>
            )}
          </p>
        </div>
        <a href={streamUrl} download={file.name}
           className="text-white/70 hover:text-white p-2 rounded-lg hover:bg-white/10 shrink-0">
          <Download size={18} />
        </a>
        <button onClick={actions.closeFile}
                className="text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 shrink-0">
          <X size={18} />
        </button>
      </div>

      {/* ── Video + overlays ── */}
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
            className="max-w-full max-h-full z-0"
            preload="auto"
            playsInline
            crossOrigin="anonymous"
            onLoadedMetadata={onMeta}
            onCanPlay={onCanPlay}
            onPlaying={onPlaying}
            onPause={onPause}
            onEnded={onEnded}
            onWaiting={onWaiting}
            onTimeUpdate={onTimeUpdate}
            onProgress={onProgress}
            onError={onError}
          >
            <source src={streamUrl} type={videoType} />
          </video>
        )}

        {/* Spinner */}
        {buffering && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="w-14 h-14 rounded-full border-2 border-white/20 border-t-white animate-spin" />
          </div>
        )}

        {/* Paused icon */}
        {!buffering && !error && !playing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-5">
            <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
              <Play size={28} className="text-white ml-1" fill="white" />
            </div>
          </div>
        )}

        {/* Resume prompt banner */}
        {resumePrompt && (
          <div className="absolute top-16 left-0 right-0 flex justify-center z-20 px-4">
            <div className="bg-black/80 backdrop-blur-sm rounded-xl px-4 py-3 flex items-center gap-3 max-w-sm w-full border border-white/10">
              <Clock size={16} className="text-yellow-400 shrink-0" />
              <span className="text-white text-sm flex-1">Resume from <strong>{fmt(resumePrompt.time)}</strong>?</span>
              <button onClick={doResume}
                      className="bg-white text-black text-xs font-semibold px-3 py-1.5 rounded-lg">
                Resume
              </button>
              <button onClick={dismissResume}
                      className="text-white/50 hover:text-white text-xs px-2 py-1.5">
                Start over
              </button>
            </div>
          </div>
        )}

        {/* Error */}
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

        {/* Seek flash left */}
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

      {/* ── Bottom controls ── */}
      <div className={`absolute bottom-0 left-0 right-0 z-10 px-3 pb-safe pb-5 pt-10
                       bg-gradient-to-t from-black/95 to-transparent
                       transition-opacity duration-300
                       ${showCtrl ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
           onMouseMove={resetHide}>

        {/* Scrub preview time label */}
        {scrubTime !== null && (
          <div className="text-center mb-1">
            <span className="text-white text-xs font-mono bg-black/60 px-2 py-0.5 rounded">
              {fmt(scrubTime)}
            </span>
          </div>
        )}

        {/* Progress / seek bar — tall touch target */}
        <div
          data-seekbar
          ref={seekBarRef}
          className="w-full h-8 flex items-center cursor-pointer mb-1 touch-none"
          onMouseDown={onSeekMouseDown}
          onTouchStart={onSeekTouchStart}
          onTouchMove={onSeekTouchMove}
          onTouchEnd={onSeekTouchEnd}
        >
          <div className="relative w-full h-1.5 bg-white/20 rounded-full group-active:h-2.5 transition-all">
            <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full" style={{ width: `${bpct}%` }} />
            <div className="absolute inset-y-0 left-0 bg-white rounded-full" style={{ width: `${pct}%` }} />
            <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg"
                 style={{ left: `calc(${pct}% - 8px)` }} />
          </div>
        </div>

        {/* Time row */}
        <div className="flex justify-between items-center mb-2 px-0.5">
          <span className="text-white/60 text-xs font-mono tabular-nums">{fmt(displayTime)}</span>
          <span className="text-white/60 text-xs font-mono tabular-nums">{fmt(duration)}</span>
        </div>

        {/* Main controls row */}
        <div className="flex items-center justify-between gap-1">

          {/* Left cluster: play + skip */}
          <div className="flex items-center gap-1">
            <button onClick={() => skip(-SKIP_SECS)}
                    className="text-white/80 hover:text-white p-2">
              <SkipBack size={22} />
            </button>
            <button onClick={togglePlay}
                    className="text-white hover:text-white/80 p-2">
              {playing
                ? <Pause size={28} fill="white" />
                : <Play  size={28} fill="white" className="ml-0.5" />}
            </button>
            <button onClick={() => skip(SKIP_SECS)}
                    className="text-white/80 hover:text-white p-2">
              <SkipForward size={22} />
            </button>
          </div>

          {/* Right cluster: speed + audio + volume + fullscreen */}
          <div className="flex items-center gap-1">

            {/* Quality selector — shown when any variant is available or encoding */}
            {Object.keys(qualities).length > 1 && (
              <select
                value={activeQuality}
                onChange={e => switchQuality(e.target.value)}
                className="bg-black/60 text-white text-xs font-bold border border-white/20
                           rounded-lg px-2 py-1.5 cursor-pointer appearance-none"
                title="Video quality"
              >
                {Object.entries(qualities)
                  .sort((a, b) => {
                    const order = ['original','720p','480p','360p'];
                    return order.indexOf(a[0]) - order.indexOf(b[0]);
                  })
                  .map(([label, info]) => (
                    <option key={label} value={label} disabled={!info.ready} className="bg-black">
                      {label === 'original' ? '🎬 Original' : info.ready ? `📱 ${label}` : `⏳ ${label}`}
                    </option>
                  ))}
              </select>
            )}

            {/* Speed */}
            <select
              value={speed}
              onChange={e => setSpd(parseFloat(e.target.value))}
              className="bg-black/60 text-white text-xs font-bold border border-white/20
                         rounded-lg px-2 py-1.5 cursor-pointer appearance-none text-center"
            >
              {SPEEDS.map(s => <option key={s} value={s} className="bg-black">{s}x</option>)}
            </select>

            {/* Audio track — only when multiple tracks */}
            {audioTracks.length > 1 && (
              <select
                value={audioTrack}
                onChange={e => switchAudioTrack(parseInt(e.target.value))}
                className="bg-black/60 text-white text-xs font-bold border border-white/20
                           rounded-lg px-2 py-1.5 cursor-pointer appearance-none max-w-[90px] truncate"
                title="Switch audio track"
              >
                {audioTracks.map(t => (
                  <option key={t.index} value={t.index} className="bg-black">🎵 {t.label}</option>
                ))}
              </select>
            )}

            {/* Mute — volume slider hidden on mobile */}
            <button onClick={toggleMute} className="text-white/80 hover:text-white p-2">
              {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <input type="range" min="0" max="1" step="0.05"
                   value={muted ? 0 : volume}
                   onChange={e => setVol(parseFloat(e.target.value))}
                   className="w-16 accent-white cursor-pointer hidden sm:block" />

            {/* Fullscreen */}
            <button onClick={toggleFS} className="text-white/80 hover:text-white p-2">
              {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
