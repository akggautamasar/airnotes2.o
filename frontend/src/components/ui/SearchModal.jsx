import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, FileText, BookOpen, Clock, Loader2 } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { formatSize, formatRelativeDate, cleanFileName } from '../../utils/format';

export default function SearchModal({ onClose }) {
  const { state, actions } = useApp();
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef   = useRef(null);
  const debounceRef= useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape')     { e.preventDefault(); onClose(); }
      if (e.key === 'ArrowDown')  { e.preventDefault(); setSelected(s => Math.min(s+1, results.length-1)); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); setSelected(s => Math.max(s-1, 0)); }
      if (e.key === 'Enter'  && results[selected]) { openFile(results[selected]); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [results, selected]);

  const search = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await api.search(q);
      setResults(res.results || []);
      setSelected(0);
    } catch { setResults([]); }
    setLoading(false);
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 280);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Also filter local files for instant feedback
  const localResults = query.trim()
    ? state.files.filter(f => f.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : state.recentFiles.slice(0, 6).map(r => state.files.find(f => f.id === r.fileId)).filter(Boolean);

  const displayResults = results.length > 0 ? results : localResults;

  function openFile(file) {
    actions.openFile(file);
    onClose();
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-start justify-center pt-[15vh] px-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: -12 }}
        animate={{ scale: 1,    opacity: 1, y: 0 }}
        exit   ={{ scale: 0.95, opacity: 0, y: -12 }}
        transition={{ duration: 0.2, ease: [0.22,1,0.36,1] }}
        className="glass rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-ink-800/50">
          {loading
            ? <Loader2 size={16} className="text-ink-500 animate-spin shrink-0" />
            : <Search size={16} className="text-ink-500 shrink-0" />
          }
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search PDFs, EPUBs…"
            className="flex-1 bg-transparent text-ink-100 text-sm outline-none placeholder-ink-600"
          />
          <div className="flex items-center gap-2">
            {query && (
              <button onClick={() => setQuery('')} className="text-ink-600 hover:text-ink-300">
                <X size={14} />
              </button>
            )}
            <kbd className="text-[10px] text-ink-600 border border-ink-700 px-1.5 py-0.5 rounded font-mono">ESC</kbd>
          </div>
        </div>

        {/* Results */}
        <div className="max-h-[420px] overflow-y-auto">
          {!query.trim() && (
            <div className="px-4 py-2 border-b border-ink-800/30">
              <span className="text-[10px] text-ink-600 uppercase tracking-widest font-semibold">
                {state.recentFiles.length > 0 ? 'Recent files' : 'All files'}
              </span>
            </div>
          )}

          {displayResults.length === 0 && query.trim() && !loading && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-ink-400 text-sm">No results for "{query}"</p>
              <p className="text-ink-700 text-xs mt-1">Try a different search term</p>
            </div>
          )}

          {displayResults.map((file, idx) => {
            const isPdf  = file.type === 'pdf';
            const Icon   = isPdf ? FileText : BookOpen;
            const name   = cleanFileName(file.name);
            const isActive = idx === selected;
            const hi = query.trim();

            function highlight(text) {
              if (!hi) return text;
              const i = text.toLowerCase().indexOf(hi.toLowerCase());
              if (i === -1) return text;
              return <>{text.slice(0,i)}<mark className="bg-accent/20 text-accent rounded px-0.5">{text.slice(i,i+hi.length)}</mark>{text.slice(i+hi.length)}</>;
            }

            return (
              <button
                key={file.id}
                onClick={() => openFile(file)}
                onMouseEnter={() => setSelected(idx)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                  ${isActive ? 'bg-accent/10 border-l-2 border-accent' : 'border-l-2 border-transparent hover:bg-ink-800/40'}`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0
                  ${isPdf ? 'bg-red-500/10' : 'bg-blue-500/10'}`}>
                  <Icon size={15} className={isPdf ? 'text-red-400/70' : 'text-blue-400/70'} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-ink-100 text-sm font-medium truncate">{highlight(name)}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] font-semibold ${isPdf ? 'text-red-400/70' : 'text-blue-400/70'}`}>
                      {isPdf ? 'PDF' : 'EPUB'}
                    </span>
                    <span className="text-[10px] text-ink-600">{formatSize(file.size)}</span>
                    <span className="text-[10px] text-ink-700 flex items-center gap-0.5">
                      <Clock size={9}/>{formatRelativeDate(file.date)}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] text-ink-700 shrink-0 hidden sm:block">↵ open</span>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-ink-800/30 flex items-center gap-3 text-[10px] text-ink-700">
          <span><kbd className="bg-ink-800 px-1 rounded">↑↓</kbd> navigate</span>
          <span><kbd className="bg-ink-800 px-1 rounded">↵</kbd> open</span>
          <span><kbd className="bg-ink-800 px-1 rounded">ESC</kbd> close</span>
          <span className="ml-auto">{displayResults.length} result{displayResults.length!==1?'s':''}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
