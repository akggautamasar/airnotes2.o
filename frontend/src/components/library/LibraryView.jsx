import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Grid, List, RefreshCw, AlertCircle, BookOpen, Loader2, BookMarked, Clock, Folder as FolderIcon } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore, recentStore } from '../../utils/storage';
import { generateThumbnailsBatch } from '../../utils/thumbnails';
import FileCard from './FileCard';
import FolderLockModal from '../ui/FolderLockModal';

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const itemV     = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22,1,0.36,1] } } };

export default function LibraryView({ onSearch }) {
  const { state, actions } = useApp();
  const [progresses, setProgresses]     = useState({});
  const [thumbnails, setThumbnails]     = useState({});
  const [refreshing, setRefreshing]     = useState(false);
  const [thumbLoading, setThumbLoading] = useState(false);
  const [lockModal, setLockModal]       = useState(null);
  const [typeFilter, setTypeFilter]     = useState('all'); // 'all'|'pdf'|'epub'

  useEffect(() => { loadProgress(); }, []);
  useEffect(() => {
    if (state.files.length > 0) generateThumbs();
  }, [state.files]);

  async function loadProgress() {
    try {
      const all = await progressStore.getAll();
      const map = {};
      all.forEach(p => { map[p.fileId] = p; });
      setProgresses(map);
    } catch {}
  }

  async function generateThumbs() {
    const pdfs = state.files.filter(f => f.type === 'pdf' && !thumbnails[f.id]);
    if (pdfs.length === 0) return;
    setThumbLoading(true);
    try {
      const newThumbs = await generateThumbnailsBatch(
        pdfs, api.getStreamUrl, api.authHeaders(),
        () => {}
      );
      setThumbnails(prev => ({ ...prev, ...newThumbs }));
    } catch {}
    setThumbLoading(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await api.refresh();
      const res = await api.getFiles();
      actions.setFiles(res.files || []);
    } catch {}
    setRefreshing(false);
  }

  // Determine which files to show
  const displayFiles = useMemo(() => {
    let files = state.files;
    const { activeSection, activeFolderId, fileAssignments } = state;

    if (activeFolderId) {
      files = files.filter(f => fileAssignments[f.id] === activeFolderId);
    } else if (activeSection === 'recent') {
      const recentIds = state.recentFiles.map(r => r.fileId);
      files = recentIds.map(id => files.find(f => f.id === id)).filter(Boolean);
    } else if (activeSection === 'continue') {
      files = files.filter(f => progresses[f.id] && progresses[f.id].percent < 100);
      files.sort((a, b) => (progresses[b.id]?.updatedAt || 0) - (progresses[a.id]?.updatedAt || 0));
    }

    if (typeFilter !== 'all') {
      files = files.filter(f => f.type === typeFilter);
    }

    return files;
  }, [state.files, state.activeSection, state.activeFolderId, state.fileAssignments, state.recentFiles, progresses, typeFilter]);

  // Folder locked gate
  const activeFolderObj = state.activeFolderId ? state.folders.find(f => f.id === state.activeFolderId) : null;
  const folderIsLocked  = activeFolderObj?.locked && !state.unlockedFolders.includes(state.activeFolderId);

  // Section title
  const sectionTitle = useMemo(() => {
    if (activeFolderObj) return activeFolderObj.name;
    if (state.activeSection === 'recent')   return 'Recently Opened';
    if (state.activeSection === 'continue') return 'Continue Reading';
    return 'All Files';
  }, [state.activeSection, activeFolderObj]);

  if (state.filesLoading && state.files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={28} className="animate-spin text-ink-500 mx-auto mb-3" />
          <p className="text-ink-500 text-sm">Loading your library…</p>
        </div>
      </div>
    );
  }

  if (state.filesError) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <AlertCircle size={32} className="text-red-400 mx-auto mb-3" />
          <p className="text-ink-300 text-sm mb-4">{state.filesError}</p>
          <button onClick={handleRefresh} className="btn-primary px-4 py-2 rounded-xl text-sm">
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (folderIsLocked) {
    return (
      <>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🔒</span>
            </div>
            <h3 className="text-ink-200 font-semibold mb-1">{activeFolderObj.name}</h3>
            <p className="text-ink-500 text-sm mb-5">This folder is password protected</p>
            <button
              onClick={() => setLockModal({ folder: activeFolderObj, mode: 'enter' })}
              className="btn-primary px-5 py-2.5 rounded-xl text-sm"
            >
              Unlock Folder
            </button>
          </div>
        </div>
        {lockModal && (
          <FolderLockModal
            folder={lockModal.folder}
            mode={lockModal.mode}
            onClose={() => setLockModal(null)}
            onSuccess={() => setLockModal(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-800/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {activeFolderObj && <FolderIcon size={16} className="text-ink-500 shrink-0" />}
          <h2 className="font-display font-semibold text-ink-100 text-base truncate">{sectionTitle}</h2>
          <span className="text-ink-600 text-xs">({displayFiles.length})</span>
        </div>

        <div className="flex items-center gap-1 ml-auto shrink-0">
          {/* Type filter */}
          <div className="flex items-center bg-ink-800/60 rounded-lg p-0.5 mr-2">
            {['all','pdf','epub'].map(t => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${typeFilter === t ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}>
                {t === 'all' ? 'All' : t.toUpperCase()}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <button onClick={() => actions.setViewMode('grid')}
            className={`p-1.5 rounded-lg transition-colors ${state.viewMode === 'grid' ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}>
            <Grid size={15} />
          </button>
          <button onClick={() => actions.setViewMode('list')}
            className={`p-1.5 rounded-lg transition-colors ${state.viewMode === 'list' ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}>
            <List size={15} />
          </button>

          <button onClick={handleRefresh} disabled={refreshing}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-300 transition-colors ml-1">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {displayFiles.length === 0 ? (
          <EmptyState section={state.activeSection} folder={activeFolderObj} />
        ) : state.viewMode === 'grid' ? (
          <motion.div
            variants={container} initial="hidden" animate="show"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
          >
            {displayFiles.map(file => (
              <motion.div key={file.id} variants={itemV}>
                <FileCard
                  file={file}
                  progress={progresses[file.id]}
                  thumbnail={thumbnails[file.id]}
                  onProgressUpdate={loadProgress}
                />
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <div className="max-w-4xl">
            {/* List header */}
            <div className="flex items-center gap-4 px-3 py-2 mb-1 text-[11px] text-ink-600 uppercase tracking-widest font-semibold border-b border-ink-800/40">
              <span className="flex-1">Name</span>
              <span className="w-16 text-right hidden sm:block">Size</span>
              <span className="w-20 text-right hidden md:block">Added</span>
              <span className="w-16 text-right hidden sm:block">Progress</span>
              <span className="w-6" />
            </div>
            <motion.div variants={container} initial="hidden" animate="show" className="space-y-0.5">
              {displayFiles.map(file => (
                <motion.div key={file.id} variants={itemV}>
                  <FileCard
                    file={file}
                    progress={progresses[file.id]}
                    thumbnail={thumbnails[file.id]}
                    listMode
                    onProgressUpdate={loadProgress}
                  />
                </motion.div>
              ))}
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ section, folder }) {
  const msg = folder
    ? { icon: '📂', title: 'Folder is empty', sub: 'Move files here from the main library' }
    : section === 'recent'
    ? { icon: '🕐', title: 'No recent files', sub: 'Files you open will appear here' }
    : section === 'continue'
    ? { icon: '📖', title: 'Nothing in progress', sub: 'Files you start reading will appear here' }
    : { icon: '📚', title: 'Library is empty', sub: 'Upload PDFs or EPUBs via your Telegram bot' };

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <div className="text-4xl mb-3">{msg.icon}</div>
      <p className="text-ink-300 font-medium mb-1">{msg.title}</p>
      <p className="text-ink-600 text-sm">{msg.sub}</p>
    </div>
  );
}
