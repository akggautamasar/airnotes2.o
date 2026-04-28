import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Sun, Moon, Coffee, Bookmark, BookmarkCheck,
  Maximize2, Minimize2, RotateCcw
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore, bookmarkStore, recentStore } from '../../utils/storage';
import { cleanFileName } from '../../utils/format';

let _pdfjsLib = null;
async function getPdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  _pdfjsLib = await import('pdfjs-dist');
  _pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url
  ).href;
  return _pdfjsLib;
}

const MODES = {
  light: { bg: '#e8e8e8', pageBg: '#ffffff', text: '#1a1a1a', toolbar: '#f5f5f5', border: '#d4d4d4' },
  dark:  { bg: '#141414', pageBg: '#1e1e1e', text: '#e4e4e7', toolbar: '#1a1a1a', border: '#2c2c2c' },
  sepia: { bg: '#e8dcc8', pageBg: '#f5ecd8', text: '#3d2b1f', toolbar: '#ede3cc', border: '#c8b89a' },
};
const NEXT_MODE = { light: 'dark', dark: 'sepia', sepia: 'light' };
const MIN_SCALE = 0.4, MAX_SCALE = 4.0, STEP = 0.2;

export default function PDFReader() {
  const { state, actions } = useApp();
  const file   = state.openFile;
  const mode   = MODES[state.readerMode] || MODES.dark;
  const title  = cleanFileName(file?.name || '');

  const [pdfDoc, setPdfDoc]         = useState(null);
  const [numPages, setNumPages]     = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale]           = useState(1.2);
  const [fitMode, setFitMode]       = useState('width');
  const [loading, setLoading]       = useState(true);
  const [loadPct, setLoadPct]       = useState(0);
  const [error, setError]           = useState('');
  const [pageInput, setPageInput]   = useState('1');
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [renderedSet, setRenderedSet] = useState(new Set());

  const containerRef  = useRef(null);
  const scrollRef     = useRef(null);
  const pageRefs      = useRef({});
  const canvasRefs    = useRef({});
  const renderTasksRef= useRef({});

  // Load PDF
  useEffect(() => {
    if (!file) return;
    loadPDF();
    progressStore.get(file.id).then(p => { if (p?.currentPage) setCurrentPage(p.currentPage); setPageInput(String(p?.currentPage||1)); });
    bookmarkStore.isBookmarked(file.id, 1).then(setIsBookmarked);
    const keyHandler = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) actions.closeFile(); };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [file?.id]);

  async function loadPDF() {
    setLoading(true); setError(''); setLoadPct(0);
    try {
      const lib = await getPdfJs();
      const url = api.getStreamUrl(file.id);
      const task = lib.getDocument({ url, httpHeaders: api.authHeaders() });
      task.onProgress = ({ loaded, total }) => { if (total) setLoadPct(Math.round(loaded/total*100)); };
      const doc = await task.promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
    } catch (e) { setError(`Failed to load PDF: ${e.message}`); }
    setLoading(false);
  }

  // Compute fit scale
  const computeFitScale = useCallback(async (doc) => {
    if (!doc || !scrollRef.current) return 1.2;
    const w = scrollRef.current.clientWidth - 64;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    if (fitMode === 'page') {
      const h = scrollRef.current.clientHeight - 64;
      return Math.min(w / vp.width, h / vp.height);
    }
    return w / vp.width;
  }, [fitMode]);

  useEffect(() => {
    if (!pdfDoc) return;
    computeFitScale(pdfDoc).then(s => setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))));
  }, [pdfDoc, fitMode]);

  // Re-render on scale change
  useEffect(() => {
    if (!pdfDoc) return;
    Object.values(renderTasksRef.current).forEach(t => { try { t?.cancel(); } catch {} });
    renderTasksRef.current = {};
    setRenderedSet(new Set());
  }, [scale, pdfDoc]);

  // Render a single page (high-DPR)
  const renderPage = useCallback(async (pageNum) => {
    if (!pdfDoc || !canvasRefs.current[pageNum]) return;
    if (renderTasksRef.current[`done_${pageNum}`]) return;
    if (renderTasksRef.current[pageNum]) return; // already rendering

    try {
      const page   = await pdfDoc.getPage(pageNum);
      const DPR    = Math.min(window.devicePixelRatio || 1, 2);
      const vp     = page.getViewport({ scale: scale * DPR });
      const canvas = canvasRefs.current[pageNum];
      if (!canvas) return;
      const ctx    = canvas.getContext('2d');
      canvas.width  = vp.width;
      canvas.height = vp.height;
      canvas.style.width  = `${vp.width  / DPR}px`;
      canvas.style.height = `${vp.height / DPR}px`;

      const task = page.render({ canvasContext: ctx, viewport: vp });
      renderTasksRef.current[pageNum] = task;
      await task.promise;
      renderTasksRef.current[`done_${pageNum}`] = true;
      delete renderTasksRef.current[pageNum];
      setRenderedSet(prev => new Set([...prev, pageNum]));
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(`Page ${pageNum}:`, e);
    }
  }, [pdfDoc, scale]);

  // Intersection observer
  useEffect(() => {
    if (!pdfDoc || numPages === 0) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const pn = parseInt(entry.target.dataset.page);
          renderPage(pn);
          if (pn > 1)        renderPage(pn - 1);
          if (pn < numPages) renderPage(pn + 1);
        }
      });
    }, { root: scrollRef.current, rootMargin: '300px', threshold: 0.01 });
    Object.values(pageRefs.current).forEach(el => el && observer.observe(el));
    return () => observer.disconnect();
  }, [pdfDoc, numPages, renderPage]);

  // Scroll spy
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const pivot = el.scrollTop + el.clientHeight / 3;
      for (let p = 1; p <= numPages; p++) {
        const ref = pageRefs.current[p];
        if (ref && ref.offsetTop <= pivot && ref.offsetTop + ref.offsetHeight >= pivot) {
          setCurrentPage(p); setPageInput(String(p));
          if (file) progressStore.save(file.id, p, numPages);
          bookmarkStore.isBookmarked(file?.id, p).then(setIsBookmarked);
          break;
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [numPages, file]);

  function scrollToPage(p) {
    const el = pageRefs.current[p];
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
  }
  function goToPage(p) {
    const c = Math.max(1, Math.min(numPages, p));
    setCurrentPage(c); setPageInput(String(c)); scrollToPage(c);
  }

  function zoomIn()  { setScale(s => Math.min(MAX_SCALE, parseFloat((s+STEP).toFixed(2)))); setFitMode('custom'); }
  function zoomOut() { setScale(s => Math.max(MIN_SCALE, parseFloat((s-STEP).toFixed(2)))); setFitMode('custom'); }

  async function toggleBookmark() {
    if (!file) return;
    if (isBookmarked) { await bookmarkStore.remove(file.id, currentPage); setIsBookmarked(false); }
    else              { await bookmarkStore.add(file.id, currentPage);    setIsBookmarked(true); }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) { containerRef.current?.requestFullscreen?.(); setFullscreen(true); }
    else { document.exitFullscreen?.(); setFullscreen(false); }
  }
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  if (!file) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: mode.bg, color: mode.text }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 sm:gap-2 px-3 py-2 shrink-0 border-b"
           style={{ background: mode.toolbar, borderColor: mode.border }}>
        <button onClick={actions.closeFile} className="p-1.5 rounded-lg hover:bg-black/10 transition-colors">
          <X size={16} />
        </button>
        <span className="text-xs font-medium truncate flex-1 min-w-0 hidden sm:block opacity-70">{title}</span>

        {/* Page nav */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => goToPage(currentPage-1)} disabled={currentPage<=1}
            className="p-1 rounded hover:bg-black/10 disabled:opacity-30"><ChevronLeft size={15}/></button>
          <input type="number" value={pageInput}
            onChange={e => { setPageInput(e.target.value); const n=parseInt(e.target.value); if(!isNaN(n)&&n>=1&&n<=numPages) goToPage(n); }}
            onKeyDown={e => e.key==='Enter' && goToPage(parseInt(pageInput)||1)}
            className="w-10 text-center text-xs border rounded px-1 py-0.5"
            style={{ background:'transparent', borderColor:mode.border, color:mode.text }} />
          <span className="text-xs opacity-50 whitespace-nowrap">/ {numPages}</span>
          <button onClick={() => goToPage(currentPage+1)} disabled={currentPage>=numPages}
            className="p-1 rounded hover:bg-black/10 disabled:opacity-30"><ChevronRight size={15}/></button>
        </div>

        <div className="w-px h-4 bg-black/15 mx-1 hidden sm:block" />

        {/* Zoom */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={zoomOut} className="p-1.5 rounded hover:bg-black/10"><ZoomOut size={14}/></button>
          <button onClick={() => setFitMode(m => m==='width'?'page':'width')}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded border hover:bg-black/10 whitespace-nowrap"
            style={{ borderColor: mode.border }}>
            {Math.round(scale*100)}%
          </button>
          <button onClick={zoomIn} className="p-1.5 rounded hover:bg-black/10"><ZoomIn size={14}/></button>
        </div>

        <div className="w-px h-4 bg-black/15 mx-1 hidden sm:block" />

        <button onClick={toggleBookmark} className="p-1.5 rounded hover:bg-black/10">
          {isBookmarked ? <BookmarkCheck size={15} className="text-yellow-500"/> : <Bookmark size={15}/>}
        </button>
        <button onClick={() => actions.setReaderMode(NEXT_MODE[state.readerMode]||'dark')}
          className="p-1.5 rounded hover:bg-black/10">
          {state.readerMode==='light' ? <Sun size={14}/> : state.readerMode==='sepia' ? <Coffee size={14}/> : <Moon size={14}/>}
        </button>
        <button onClick={toggleFullscreen} className="p-1.5 rounded hover:bg-black/10 hidden sm:flex">
          {fullscreen ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10"
             style={{ background: mode.bg }}>
          <div className="w-48 h-1 rounded-full bg-black/10 overflow-hidden mb-3">
            <motion.div className="h-full bg-accent rounded-full" animate={{ width: `${loadPct}%` }} />
          </div>
          <p className="text-xs opacity-50">Loading… {loadPct}%</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-red-500 text-sm">{error}</p>
          <button onClick={loadPDF} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded border hover:bg-black/10">
            <RotateCcw size={12}/> Retry
          </button>
        </div>
      )}

      {/* Pages */}
      {!error && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-auto" style={{ background: mode.bg }}>
          <div className="flex flex-col items-center py-6 gap-3 px-4">
            {Array.from({ length: numPages }, (_, i) => i+1).map(pn => (
              <div key={pn} ref={el => pageRefs.current[pn] = el} data-page={pn}
                   className="relative shadow-xl" style={{ background: mode.pageBg }}>
                <canvas ref={el => canvasRefs.current[pn] = el} className="block"
                  style={{ filter: state.readerMode==='dark' ? 'brightness(0.9) contrast(1.05)' : state.readerMode==='sepia' ? 'sepia(0.35)' : 'none' }} />
                {!renderedSet.has(pn) && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/5">
                    <div className="w-5 h-5 border-2 border-ink-600/30 border-t-ink-600 rounded-full animate-spin" />
                  </div>
                )}
                <div className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-white/60 pointer-events-none">
                  {pn}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
