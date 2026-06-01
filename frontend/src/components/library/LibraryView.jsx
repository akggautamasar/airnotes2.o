import React, { useEffect, useState, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Grid, List, RefreshCw, AlertCircle, Loader2,
         Sun, Moon, ArrowUpDown, Trash2, X, CheckSquare } from 'lucide-react';
import { Folder as FolderIcon } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore } from '../../utils/storage';
import { getThumbnailUrl, hasThumbnail, isThumbnailReady, loadReadyThumbnails } from '../../utils/thumbnails';
import FileCard from './FileCard';
import FolderLockModal from '../ui/FolderLockModal';
import ChannelView from '../channels/ChannelView';

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const itemV     = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22,1,0.36,1] } } };

const SORT_OPTIONS = [
  { value: 'date',  label: 'Date added' },
  { value: 'name',  label: 'Name' },
  { value: 'size',  label: 'File size' },
  { value: 'type',  label: 'Type' },
];

function sortFiles(files, sortBy, sortOrder, progresses) {
  const dir = sortOrder === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    let va, vb;
    if (sortBy === 'date') { va = a.date || 0; vb = b.date || 0; }
    else if (sortBy === 'name') { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); return dir * va.localeCompare(vb); }
    else if (sortBy === 'size') { va = a.size || 0; vb = b.size || 0; }
    else if (sortBy === 'type') { va = a.type || ''; vb = b.type || ''; return dir * va.localeCompare(vb); }
    else { va = a.date || 0; vb = b.date || 0; }
    return dir * (va - vb);
  });
}

function estimateTimeLeft(file, progress) {
  if (!progress || !progress.percent || progress.percent >= 99) return null;
  const remaining = 1 - (progress.percent / 100);
  if (file.type === 'video' && progress.duration) {
    const secsLeft = remaining * progress.duration;
    if (secsLeft < 60) return `${Math.ceil(secsLeft)}s left`;
    const m = Math.ceil(secsLeft / 60);
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m left` : `${m}m left`;
  }
  if (file.type === 'pdf' || file.type === 'epub') {
    const estMinutes = Math.ceil(remaining * 60);
    return estMinutes >= 60 ? `~${Math.floor(estMinutes/60)}h left` : `~${estMinutes}m left`;
  }
  return null;
}

export default function LibraryView({ onSearch }) {
  const { state, actions } = useApp();
  const [progresses, setProgresses] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [lockModal, setLockModal]   = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [showSort, setShowSort]     = useState(false);
  const [trashFiles, setTrashFiles] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const sortRef = useRef(null);

  useEffect(() => { loadReadyThumbnails(); }, []);
  useEffect(() => { loadProgress(); }, []);
  useEffect(() => {
    if (!showSort) return;
    const h = (e) => { if (sortRef.current && !sortRef.current.contains(e.target)) setShowSort(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showSort]);

  useEffect(() => {
    if (state.activeSection === 'trash') loadTrash();
  }, [state.activeSection]);

  async function loadProgress() {
    try {
      const all = await progressStore.getAll();
      const map = {};
      all.forEach(p => { map[p.fileId] = p; });
      setProgresses(map);
    } catch {}
  }

  async function loadTrash() {
    setTrashLoading(true);
    try {
      const res = await api.getTrash();
      setTrashFiles(res.files || []);
      actions.setTrashCount(res.total || 0);
    } catch {}
    setTrashLoading(false);
  }

  async function handleRestore(fileId, permanent = false) {
    setTrashFiles(t => t.filter(f => f.id !== fileId));
    actions.setTrashCount(Math.max(0, state.trashCount - 1));
    if (!permanent) {
      try {
        const res = await api.restoreFromTrash(fileId);
        actions.setFiles([res.file, ...state.files]);
      } catch (e) { alert(e.message); }
    }
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

  // Determine display files
  const displayFiles = useMemo(() => {
    let files = state.files;
    const { activeSection, activeFolderId, fileAssignments, activeTag } = state;

    if (activeFolderId) {
      files = files.filter(f => fileAssignments[f.id] === activeFolderId);
    } else if (activeSection === 'recent') {
      const recentIds = state.recentFiles.map(r => r.fileId);
      files = recentIds.map(id => files.find(f => f.id === id)).filter(Boolean);
    } else if (activeSection === 'continue') {
      files = files.filter(f => progresses[f.id] && progresses[f.id].percent < 100);
      files.sort((a, b) => (progresses[b.id]?.updatedAt || 0) - (progresses[a.id]?.updatedAt || 0));
    } else if (activeSection === 'favorites') {
      files = state.favorites.map(id => files.find(f => f.id === id)).filter(Boolean);
    } else if (activeSection === 'tag' && activeTag) {
      files = files.filter(f => (state.fileTags[f.id] || []).includes(activeTag));
    }

    if (typeFilter !== 'all') {
      files = files.filter(f => f.type === typeFilter);
    }

    if (activeSection !== 'continue') {
      files = sortFiles(files, state.sortBy, state.sortOrder, progresses);
    }

    return files;
  }, [state.files, state.activeSection, state.activeFolderId, state.fileAssignments,
      state.recentFiles, state.favorites, state.fileTags, state.activeTag,
      progresses, typeFilter, state.sortBy, state.sortOrder]);

  const activeFolderObj = state.activeFolderId ? state.folders.find(f => f.id === state.activeFolderId) : null;
  const folderIsLocked  = activeFolderObj?.locked && !state.unlockedFolders.includes(state.activeFolderId);

  const sectionTitle = useMemo(() => {
    if (activeFolderObj) return activeFolderObj.name;
    if (state.activeSection === 'recent')    return 'Recently Opened';
    if (state.activeSection === 'continue')  return 'Continue Reading';
    if (state.activeSection === 'favorites') return 'Favorites';
    if (state.activeSection === 'trash')     return 'Trash';
    if (state.activeSection === 'tag')       return `#${state.activeTag}`;
    return 'All Files';
  }, [state.activeSection, activeFolderObj, state.activeTag]);

  const selectedCount = state.selectedFiles.size;

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
            <button onClick={() => setLockModal({ folder: activeFolderObj, mode: 'enter' })} className="btn-primary px-5 py-2.5 rounded-xl text-sm">
              Unlock Folder
            </button>
          </div>
        </div>
        {lockModal && <FolderLockModal folder={lockModal.folder} mode={lockModal.mode} onClose={() => setLockModal(null)} onSuccess={() => setLockModal(null)} />}
      </>
    );
  }

  if (state.activeSection === 'channel') return <ChannelView />;

  // ── Trash view ─────────────────────────────────────────────────────────────
  if (state.activeSection === 'trash') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-800/40 shrink-0">
          <Trash2 size={15} className="text-ink-500" />
          <h2 className="font-display font-semibold text-ink-100 text-base">Trash</h2>
          <span className="text-ink-600 text-xs">({trashFiles.length})</span>
          <div className="ml-auto">
            {trashFiles.length > 0 && (
              <button
                onClick={async () => {
                  if (!confirm('Permanently delete all files in trash?')) return;
                  await api.emptyTrash().catch(e => alert(e.message));
                  setTrashFiles([]);
                  actions.setTrashCount(0);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 rounded-xl transition"
              >
                <Trash2 size={12} /> Empty Trash
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {trashLoading ? (
            <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-ink-600" /></div>
          ) : trashFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="text-4xl mb-3">🗑️</div>
              <p className="text-ink-300 font-medium mb-1">Trash is empty</p>
              <p className="text-ink-600 text-sm">Deleted files will appear here</p>
            </div>
          ) : (
            <div className="max-w-3xl space-y-0.5">
              {trashFiles.map(file => (
                <FileCard key={file.id} file={file} trashMode onRestoreFromTrash={handleRestore} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Bulk action bar */}
      <AnimatePresence>
        {selectedCount > 0 && (
          <motion.div
            initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
            className="flex items-center gap-3 px-5 py-2.5 bg-accent/10 border-b border-accent/20 text-sm shrink-0"
          >
            <CheckSquare size={15} className="text-accent" />
            <span className="text-ink-200 font-medium">{selectedCount} selected</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => actions.selectAll(displayFiles.map(f => f.id))}
                className="px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100 hover:bg-ink-700/50 rounded-lg transition">
                Select all
              </button>
              {/* Move to folder */}
              {state.folders.length > 0 && (
                <select
                  onChange={async e => {
                    const fid = e.target.value;
                    if (!fid) return;
                    await api.bulkMove([...state.selectedFiles], fid === '__none__' ? null : fid).catch(alert);
                    if (fid === '__none__') {
                      [...state.selectedFiles].forEach(id => actions.unassignFile(id));
                    } else {
                      [...state.selectedFiles].forEach(id => actions.assignFile(id, fid));
                    }
                    actions.clearSelection();
                  }}
                  defaultValue=""
                  className="bg-ink-800 border border-ink-700 text-ink-300 text-xs rounded-lg px-2 py-1.5 cursor-pointer"
                >
                  <option value="" disabled>Move to…</option>
                  <option value="__none__">Remove from folder</option>
                  {state.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
              <button
                onClick={async () => {
                  if (!confirm(`Move ${selectedCount} file(s) to Trash?`)) return;
                  const ids = [...state.selectedFiles];
                  await api.bulkDelete(ids).catch(alert);
                  actions.setFiles(state.files.filter(f => !ids.includes(f.id)));
                  actions.setTrashCount(state.trashCount + ids.length);
                  actions.clearSelection();
                }}
                className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 rounded-lg transition flex items-center gap-1"
              >
                <Trash2 size={12} /> Delete
              </button>
              <button onClick={() => actions.clearSelection()}
                className="p-1.5 text-ink-500 hover:text-ink-300 transition"><X size={14} /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-800/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {activeFolderObj && <FolderIcon size={16} className="text-ink-500 shrink-0" />}
          <h2 className="font-display font-semibold text-ink-100 text-base truncate">{sectionTitle}</h2>
          <span className="text-ink-600 text-xs">({displayFiles.length})</span>
        </div>

        <div className="flex items-center gap-1 ml-auto shrink-0">
          {/* Type filter */}
          <div className="flex items-center bg-ink-800/60 rounded-lg p-0.5 mr-1">
            {['all','pdf','epub','video'].map(t => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${typeFilter === t ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}>
                {t === 'all' ? 'All' : t.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Sort dropdown */}
          <div className="relative" ref={sortRef}>
            <button
              onClick={() => setShowSort(v => !v)}
              className="flex items-center gap-1 p-1.5 rounded-lg text-ink-500 hover:text-ink-300 transition-colors mr-1"
              title="Sort"
            >
              <ArrowUpDown size={14} />
            </button>
            {showSort && (
              <div className="absolute right-0 top-full mt-1 glass rounded-xl shadow-xl min-w-[160px] py-1 z-50 border border-ink-700/40">
                <p className="px-3 py-1 text-[10px] text-ink-600 uppercase tracking-widest">Sort by</p>
                {SORT_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (state.sortBy === opt.value) {
                        actions.setSort(opt.value, state.sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        actions.setSort(opt.value, 'desc');
                      }
                      setShowSort(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs transition hover:bg-ink-800/50
                      ${state.sortBy === opt.value ? 'text-accent' : 'text-ink-300'}`}
                  >
                    {opt.label}
                    {state.sortBy === opt.value && (
                      <span className="text-accent text-[10px]">{state.sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme toggle */}
          <button onClick={() => actions.setAppTheme(state.appTheme === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-300 transition-colors mr-1">
            {state.appTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

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
          <EmptyState section={state.activeSection} folder={activeFolderObj} tag={state.activeTag} />
        ) : state.viewMode === 'grid' ? (
          <motion.div variants={container} initial="hidden" animate="show"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {displayFiles.map(file => (
              <motion.div key={file.id} variants={itemV}>
                <FileCard
                  file={file}
                  progress={progresses[file.id]}
                  thumbnailUrl={hasThumbnail(file.type) && isThumbnailReady(file.id) ? getThumbnailUrl(file.id) : undefined}
                  onProgressUpdate={loadProgress}
                  isSelected={state.selectedFiles.has(file.id)}
                  isFav={state.favorites.includes(file.id)}
                  fileTags={state.fileTags[file.id] || []}
                  hasSelection={selectedCount > 0}
                />
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <div className="max-w-4xl">
            <div className="flex items-center gap-4 px-3 py-2 mb-1 text-[11px] text-ink-600 uppercase tracking-widest font-semibold border-b border-ink-800/40">
              <span className="w-5 shrink-0" />
              <span className="flex-1">Name</span>
              <span className="w-16 text-right hidden sm:block">Size</span>
              <span className="w-20 text-right hidden md:block">Added</span>
              <span className="w-20 text-right hidden sm:block">Progress</span>
              {state.activeSection === 'continue' && <span className="w-24 text-right hidden md:block">Time left</span>}
              <span className="w-6" />
            </div>
            <motion.div variants={container} initial="hidden" animate="show" className="space-y-0.5">
              {displayFiles.map(file => {
                const timeLeft = state.activeSection === 'continue' ? estimateTimeLeft(file, progresses[file.id]) : null;
                return (
                  <motion.div key={file.id} variants={itemV} className="relative">
                    <FileCard
                      file={file}
                      progress={progresses[file.id]}
                      thumbnailUrl={hasThumbnail(file.type) && isThumbnailReady(file.id) ? getThumbnailUrl(file.id) : undefined}
                      listMode
                      onProgressUpdate={loadProgress}
                      isSelected={state.selectedFiles.has(file.id)}
                      isFav={state.favorites.includes(file.id)}
                      fileTags={state.fileTags[file.id] || []}
                      hasSelection={selectedCount > 0}
                    />
                    {timeLeft && state.activeSection === 'continue' && (
                      <span className="absolute right-10 top-1/2 -translate-y-1/2 text-[10px] text-accent/70 hidden md:block pointer-events-none">
                        {timeLeft}
                      </span>
                    )}
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        )}
      </div>

      {lockModal && <FolderLockModal folder={lockModal.folder} mode={lockModal.mode} onClose={() => setLockModal(null)} onSuccess={() => setLockModal(null)} />}
    </div>
  );
}

function EmptyState({ section, folder, tag }) {
  const msg = folder
    ? { icon: '📂', title: 'Folder is empty', sub: 'Move files here from the main library' }
    : section === 'recent'
    ? { icon: '🕐', title: 'No recent files', sub: 'Files you open will appear here' }
    : section === 'continue'
    ? { icon: '📖', title: 'Nothing in progress', sub: 'Files you start reading will appear here' }
    : section === 'favorites'
    ? { icon: '⭐', title: 'No favorites yet', sub: 'Star files to save them here' }
    : section === 'tag'
    ? { icon: '🏷️', title: `No files tagged #${tag}`, sub: 'Tag files from their context menu' }
    : { icon: '📚', title: 'Library is empty', sub: 'Upload PDFs or EPUBs via your Telegram bot' };

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <div className="text-4xl mb-3">{msg.icon}</div>
      <p className="text-ink-300 font-medium mb-1">{msg.title}</p>
      <p className="text-ink-600 text-sm">{msg.sub}</p>
    </div>
  );
}
