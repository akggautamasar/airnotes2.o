import React, { useEffect, useState, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { useApp } from '../store/AppContext';
import { api } from '../utils/api';
import { progressStore, recentStore } from '../utils/storage';
import Sidebar from '../components/Sidebar';
import LibraryView from '../components/library/LibraryView';
import PDFReader from '../components/reader/PDFReader';
import EpubViewer from '../components/reader/EpubViewer';
import SearchModal from '../components/ui/SearchModal';

export default function MainApp() {
  const { state, actions } = useApp();
  const [showSearch, setShowSearch] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const lastCountRef = useRef(0);
  const sseRef = useRef(null);
  const retryRef = useRef(null);

  useEffect(() => {
    api.verify().catch(() => actions.logout());
    loadAll();
    connectSSE();
    return () => { sseRef.current?.close(); clearTimeout(retryRef.current); };
  }, []);

  async function loadAll() {
    actions.setFilesLoading(true);
    try {
      const [filesRes, foldersRes, assignmentsRes] = await Promise.all([
        api.getFiles(),
        api.getFolders(),
        api.getFileAssignments(),
      ]);
      actions.setFiles(filesRes.files || []);
      lastCountRef.current = (filesRes.files || []).length;

      const folders = (foldersRes.folders || []).map(f => ({
        id: f.id, name: f.name, parentId: f.parent_id,
        locked: f.locked || false, passwordHash: f.password_hash || null,
        createdAt: f.created_at, fileCount: f.file_count || 0,
      }));
      actions.setFolders(folders);
      actions.setFileAssignments(assignmentsRes.assignments || {});
    } catch (e) {
      actions.setFilesError(e.message);
    }
    // Load local progress + recent
    try {
      const allProgress = await progressStore.getAll();
      allProgress.forEach(p => actions.saveProgress(p.fileId, p));
      const recent = await recentStore.getAll();
      actions.setRecent(recent);
    } catch {}
  }

  function connectSSE() {
    const token = localStorage.getItem('airnotes_token');
    if (!token) return;
    const BASE_URL = import.meta.env.VITE_API_URL || '/api';
    const url = `${BASE_URL}/events?token=${encodeURIComponent(token)}`;

    function connect() {
      const es = new EventSource(url);
      sseRef.current = es;
      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.event === 'new_file' && payload.file) {
            actions.setFiles(prev => {
              const current = Array.isArray(prev) ? prev : [];
              return current.find(f => f.id === payload.file.id) ? current : [payload.file, ...current];
            });
          }
        } catch {}
      };
      es.onerror = () => {
        es.close();
        retryRef.current = setTimeout(connect, 6000);
      };
    }
    connect();
  }

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); if (!state.openFile) setShowSearch(true); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state.openFile]);

  useEffect(() => { setMobileSidebar(false); }, [state.activeSection, state.activeFolderId]);

  const showPDF  = state.openFile && state.openFile.type === 'pdf';
  const showEpub = state.openFile && state.openFile.type === 'epub';

  return (
    <div className="h-screen flex overflow-hidden bg-ink-950 text-ink-100">
      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {mobileSidebar && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/70 md:hidden"
            onClick={() => setMobileSidebar(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <div className={`fixed md:relative z-50 md:z-auto h-full transition-transform duration-300
                       ${mobileSidebar ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <Sidebar
          onSearch={() => { setShowSearch(true); setMobileSidebar(false); }}
          onRefresh={loadAll}
        />
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile topbar */}
        <div className="flex md:hidden items-center gap-3 px-4 py-3 border-b border-ink-800/60 bg-ink-950 shrink-0">
          <button onClick={() => setMobileSidebar(true)} className="text-ink-400 hover:text-ink-100 p-1 -ml-1">
            <Menu size={20} />
          </button>
          <span className="font-display font-bold text-ink-100 flex-1">AirNotes 2.0</span>
          <button onClick={() => setShowSearch(true)} className="text-ink-400 hover:text-ink-100 p-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </button>
        </div>
        <LibraryView onSearch={() => setShowSearch(true)} />
      </div>

      {/* Readers */}
      <AnimatePresence>
        {showPDF  && <PDFReader key="pdf" />}
        {showEpub && <EpubViewer key="epub" />}
      </AnimatePresence>

      {/* Search modal */}
      <AnimatePresence>
        {showSearch && !state.openFile && (
          <SearchModal onClose={() => setShowSearch(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
