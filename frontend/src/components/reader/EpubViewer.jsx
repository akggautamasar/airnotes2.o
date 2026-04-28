import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, Sun, Moon, Minus, Plus, AlignJustify } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore } from '../../utils/storage';
import { cleanFileName } from '../../utils/format';

export default function EpubViewer() {
  const { state, actions } = useApp();
  const file  = state.openFile;
  const title = cleanFileName(file?.name || '');

  const [book, setBook]         = useState(null);
  const [rendition, setRendition] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [fontSize, setFontSize] = useState(100); // percent
  const [isDark, setIsDark]     = useState(state.readerMode === 'dark');
  const [toc, setToc]           = useState([]);
  const [showToc, setShowToc]   = useState(false);
  const [currentCfi, setCurrentCfi] = useState(null);

  const viewerRef = useRef(null);
  const bookRef   = useRef(null);

  useEffect(() => {
    if (!file) return;
    loadEpub();
    const keyHandler = (e) => { if (e.key === 'Escape') actions.closeFile(); };
    window.addEventListener('keydown', keyHandler);
    return () => {
      window.removeEventListener('keydown', keyHandler);
      bookRef.current?.destroy?.();
    };
  }, [file?.id]);

  async function loadEpub() {
    setLoading(true); setError('');
    try {
      // Fetch epub as ArrayBuffer
      const res   = await fetch(api.getStreamUrl(file.id), { headers: api.authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf   = await res.arrayBuffer();

      const ePub  = (await import('epubjs')).default;
      const bk    = ePub(buf);
      bookRef.current = bk;

      // Get ToC
      bk.loaded.navigation.then(nav => { setToc(nav.toc || []); });

      // Render
      const rend = bk.renderTo(viewerRef.current, {
        width: '100%', height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      setBook(bk);
      setRendition(rend);

      applyTheme(rend, isDark, fontSize);

      // Restore progress
      const saved = await progressStore.get(file.id);
      if (saved?.cfi) {
        await rend.display(saved.cfi);
      } else {
        await rend.display();
      }

      rend.on('relocated', location => {
        const cfi = location?.start?.cfi;
        if (cfi) {
          setCurrentCfi(cfi);
          progressStore.save(file.id, location.start.displayed?.page || 1, location.start.displayed?.total || 1);
        }
      });
    } catch (e) {
      setError(`Failed to load EPUB: ${e.message}`);
    }
    setLoading(false);
  }

  function applyTheme(rend, dark, size) {
    if (!rend) return;
    const fg = dark ? '#e4e4e7' : '#1a1a1a';
    const bg = dark ? '#141414' : '#ffffff';
    rend.themes.default({
      body: { background: `${bg} !important`, color: `${fg} !important`, 'font-size': `${size}% !important`, 'line-height': '1.7', padding: '0 2em' },
      p:    { color: `${fg} !important` },
      a:    { color: dark ? '#818cf8' : '#4f46e5' },
    });
  }

  useEffect(() => { if (rendition) applyTheme(rendition, isDark, fontSize); }, [isDark, fontSize, rendition]);

  function prev() { rendition?.prev(); }
  function next() { rendition?.next(); }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next();
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rendition]);

  const bg = isDark ? '#141414' : '#f5f5f5';
  const fg = isDark ? '#e4e4e7' : '#1a1a1a';
  const tb = isDark ? '#1a1a1a' : '#ffffff';

  if (!file) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: bg, color: fg }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b"
           style={{ background: tb, borderColor: isDark ? '#2c2c2c' : '#e4e4e4' }}>
        <button onClick={actions.closeFile} className="p-1.5 rounded hover:bg-black/10 transition-colors">
          <X size={16} />
        </button>
        <span className="text-xs font-medium truncate flex-1 min-w-0 opacity-70 hidden sm:block">{title}</span>

        {/* Font size */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setFontSize(s => Math.max(60, s-10))} className="p-1.5 rounded hover:bg-black/10"><Minus size={13}/></button>
          <span className="text-xs font-mono w-10 text-center">{fontSize}%</span>
          <button onClick={() => setFontSize(s => Math.min(200, s+10))} className="p-1.5 rounded hover:bg-black/10"><Plus size={13}/></button>
        </div>

        <div className="w-px h-4 bg-black/15 mx-1" />

        {/* ToC toggle */}
        {toc.length > 0 && (
          <button onClick={() => setShowToc(!showToc)} className={`p-1.5 rounded hover:bg-black/10 ${showToc ? 'bg-black/10' : ''}`}>
            <AlignJustify size={14}/>
          </button>
        )}

        {/* Theme */}
        <button onClick={() => setIsDark(d => !d)} className="p-1.5 rounded hover:bg-black/10">
          {isDark ? <Sun size={14}/> : <Moon size={14}/>}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* ToC panel */}
        {showToc && (
          <motion.div
            initial={{ x: -240 }} animate={{ x: 0 }} exit={{ x: -240 }}
            className="w-56 h-full overflow-y-auto border-r shrink-0 py-3"
            style={{ background: tb, borderColor: isDark ? '#2c2c2c' : '#e4e4e4' }}
          >
            <p className="text-[10px] uppercase tracking-widest font-semibold px-4 py-1 opacity-50 mb-1">Contents</p>
            {toc.map((item, i) => (
              <button key={i} onClick={() => { rendition?.display(item.href); setShowToc(false); }}
                className="w-full text-left px-4 py-1.5 text-xs hover:bg-black/10 truncate">
                {item.label?.trim()}
              </button>
            ))}
          </motion.div>
        )}

        {/* Reader area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: bg }}>
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-xs opacity-50">Loading EPUB…</p>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* epub.js mounts here */}
          <div ref={viewerRef} className="flex-1 overflow-hidden" style={{ background: isDark ? '#141414' : '#ffffff' }} />

          {/* Navigation arrows */}
          {!loading && !error && (
            <div className="flex items-center justify-between px-4 py-3 border-t shrink-0"
                 style={{ borderColor: isDark ? '#1e1e1e' : '#e4e4e4', background: tb }}>
              <button onClick={prev}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl hover:bg-black/10 transition-colors">
                <ChevronLeft size={14}/> Previous
              </button>
              <button onClick={next}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl hover:bg-black/10 transition-colors">
                Next <ChevronRight size={14}/>
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
