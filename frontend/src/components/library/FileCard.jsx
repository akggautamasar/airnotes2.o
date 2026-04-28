import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FileText, BookOpen, Film, Clock, MoreVertical, FolderPlus, FolderMinus, Trash2, Pencil, Copy, Check, X } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore, recentStore } from '../../utils/storage';
import { formatSize, formatRelativeDate, cleanFileName, getInitials, stringToColor } from '../../utils/format';

export default function FileCard({ file, progress, thumbnail, listMode = false, onProgressUpdate }) {
  const { state, actions } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [loading, setLoading] = useState(null);
  const menuRef  = useRef(null);
  const renameRef= useRef(null);

  const title    = cleanFileName(file.name);
  const initials = getInitials(file.name);
  const color    = stringToColor(file.name);
  const pct      = progress?.percent || 0;
  const isPdf    = file.type === 'pdf';
  const isEpub   = file.type === 'epub';
  const isVideo  = file.type === 'video';

  useEffect(() => {
    if (!showMenu) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showMenu]);

  useEffect(() => { if (renaming && renameRef.current) renameRef.current.focus(); }, [renaming]);

  async function openFile() {
    if (renaming) return;
    actions.openFile(file);
    try {
      await recentStore.add(file.id, file.name);
      actions.addRecent({ fileId: file.id, fileName: file.name, openedAt: Date.now() });
    } catch {}
  }

  async function assignToFolder(folderId) {
    try { await api.moveFile(file.id, folderId); actions.assignFile(file.id, folderId); }
    catch (e) { console.error(e); }
    setShowMenu(false);
  }

  async function removeFromFolder() {
    try { await api.moveFile(file.id, null); actions.unassignFile(file.id); }
    catch (e) { console.error(e); }
    setShowMenu(false);
  }

  async function handleDelete() {
    if (!confirm(`Delete "${title}"?`)) return;
    setLoading('delete'); setShowMenu(false);
    try {
      await api.deleteFile(file.id);
      actions.setFiles(state.files.filter(f => f.id !== file.id));
    } catch (e) { alert(e.message); }
    setLoading(null);
  }

  async function handleCopy() {
    setLoading('copy'); setShowMenu(false);
    try {
      const res = await api.copyFile(file.id);
      actions.setFiles([res.file, ...state.files]);
    } catch (e) { alert(e.message); }
    setLoading(null);
  }

  async function submitRename() {
    const trimmed = renameVal.trim();
    if (!trimmed || trimmed === title) { setRenaming(false); return; }
    setLoading('rename');
    try {
      const res = await api.renameFile(file.id, trimmed);
      actions.setFiles(state.files.map(f => f.id === file.id ? res.file : f));
    } catch (e) { alert(e.message); }
    setLoading(null);
    setRenaming(false);
  }

  const currentFolder    = state.fileAssignments[file.id];
  const availableFolders = state.folders.filter(f => f.id !== currentFolder);
  const busy = loading !== null;

  // ── Type badge ─────────────────────────────────────────────────────────────
  const typeIcon = isPdf
    ? <FileText size={11} className="text-red-400/70" />
    : isEpub
      ? <BookOpen size={11} className="text-blue-400/70" />
      : <Film size={11} className="text-purple-400/70" />;

  const typeLabel = isPdf ? 'PDF' : isEpub ? 'EPUB' : 'VIDEO';

  const typeBadgeColor = isPdf
    ? 'bg-red-500/10 text-red-400/80'
    : isEpub
      ? 'bg-blue-500/10 text-blue-400/80'
      : 'bg-purple-500/10 text-purple-400/80';

  // ── List mode ──────────────────────────────────────────────────────────────
  if (listMode) {
    return (
      <div
        className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-ink-800/40
                    border border-transparent hover:border-ink-700/30 transition-all duration-150 ${renaming ? '' : 'cursor-pointer'}`}
        onClick={renaming ? undefined : openFile}
      >
        {/* Avatar */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
          style={{ background: color }}
        >
          {thumbnail
            ? <img src={thumbnail} alt="" className="w-full h-full object-cover rounded-lg" />
            : initials}
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <input
                ref={renameRef}
                value={renameVal}
                onChange={e => setRenameVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
                className="flex-1 bg-ink-700 text-ink-100 text-sm rounded px-2 py-0.5 outline-none border border-accent/40"
              />
              <button onClick={submitRename} className="p-0.5 text-green-400 hover:text-green-300"><Check size={13}/></button>
              <button onClick={() => setRenaming(false)} className="p-0.5 text-ink-500 hover:text-ink-300"><X size={13}/></button>
            </div>
          ) : (
            <p className="text-sm text-ink-200 truncate leading-tight">{title}</p>
          )}
          <p className="text-xs text-ink-500 mt-0.5">{formatSize(file.size)} · {formatRelativeDate(file.date)}</p>
        </div>

        {/* Badge */}
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md flex items-center gap-1 ${typeBadgeColor}`}>
          {typeIcon} {typeLabel}
        </span>

        {/* Progress bar (PDF/EPUB only) */}
        {(isPdf || isEpub) && pct > 0 && (
          <div className="w-16 h-1 bg-ink-700 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* Menu */}
        <div className="relative" onClick={e => e.stopPropagation()} ref={menuRef}>
          <button
            onClick={() => setShowMenu(v => !v)}
            className="p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-ink-700/50 text-ink-400 transition"
          >
            <MoreVertical size={14} />
          </button>
          {showMenu && <ContextMenu
            file={file} title={title} currentFolder={currentFolder}
            availableFolders={availableFolders} busy={busy}
            onAssign={assignToFolder} onRemove={removeFromFolder}
            onRename={() => { setRenameVal(title); setRenaming(true); setShowMenu(false); }}
            onCopy={handleCopy} onDelete={handleDelete}
          />}
        </div>
      </div>
    );
  }

  // ── Grid mode ──────────────────────────────────────────────────────────────
  return (
    <motion.div
      layout
      whileHover={{ y: -1 }}
      className={`group relative rounded-2xl border border-ink-800/50 bg-ink-900/50
                  hover:border-ink-700/60 hover:bg-ink-800/60 transition-all duration-200
                  overflow-hidden ${renaming ? '' : 'cursor-pointer'}`}
      onClick={renaming ? undefined : openFile}
    >
      {/* Thumbnail / Avatar area */}
      <div
        className="h-28 flex items-center justify-center relative overflow-hidden"
        style={thumbnail ? {} : { background: `${color}18` }}
      >
        {thumbnail ? (
          <img src={thumbnail} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-4xl font-bold select-none" style={{ color: `${color}60` }}>
            {initials}
          </span>
        )}

        {/* Video play icon overlay */}
        {isVideo && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
              <Film size={18} className="text-white" />
            </div>
          </div>
        )}

        {/* Progress overlay (PDF/EPUB only) */}
        {(isPdf || isEpub) && pct > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-ink-800/80">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* Menu button */}
        <div
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={e => e.stopPropagation()}
          ref={menuRef}
        >
          <button
            onClick={() => setShowMenu(v => !v)}
            className="w-6 h-6 rounded-lg bg-ink-900/80 flex items-center justify-center text-ink-400 hover:text-ink-100"
          >
            <MoreVertical size={12} />
          </button>
          {showMenu && <ContextMenu
            file={file} title={title} currentFolder={currentFolder}
            availableFolders={availableFolders} busy={busy}
            onAssign={assignToFolder} onRemove={removeFromFolder}
            onRename={() => { setRenameVal(title); setRenaming(true); setShowMenu(false); }}
            onCopy={handleCopy} onDelete={handleDelete}
          />}
        </div>
      </div>

      {/* Info */}
      <div className="px-3 py-2.5">
        {renaming ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input
              ref={renameRef}
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
              className="flex-1 bg-ink-700 text-ink-100 text-sm rounded px-2 py-0.5 outline-none border border-accent/40"
            />
            <button onClick={submitRename} className="p-0.5 text-green-400"><Check size={12}/></button>
            <button onClick={() => setRenaming(false)} className="p-0.5 text-ink-500"><X size={12}/></button>
          </div>
        ) : (
          <p className="text-sm font-medium text-ink-100 truncate leading-tight">{title}</p>
        )}
        <div className="flex items-center justify-between mt-1.5">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md flex items-center gap-1 ${typeBadgeColor}`}>
            {typeIcon}{typeLabel}
          </span>
          <span className="text-[10px] text-ink-500">{formatSize(file.size)}</span>
        </div>
      </div>
    </motion.div>
  );
}

// ── Shared context menu ────────────────────────────────────────────────────────
function ContextMenu({ file, title, currentFolder, availableFolders, busy, onAssign, onRemove, onRename, onCopy, onDelete }) {
  return (
    <div className="absolute right-0 top-8 z-50 w-44 bg-ink-850 border border-ink-700/60 rounded-xl shadow-2xl overflow-hidden py-1">
      <button onClick={onRename} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
        <Pencil size={12}/> Rename
      </button>
      <button onClick={onCopy} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
        <Copy size={12}/> {loading === 'copy' ? 'Copying…' : 'Duplicate'}
      </button>
      {availableFolders.length > 0 && (
        <div className="border-t border-ink-700/40 pt-1 mt-1">
          <p className="px-3 py-1 text-[10px] text-ink-500 uppercase tracking-wider">Move to folder</p>
          {availableFolders.slice(0, 5).map(f => (
            <button key={f.id} onClick={() => onAssign(f.id)} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
              <FolderPlus size={12}/> {f.name}
            </button>
          ))}
        </div>
      )}
      {currentFolder && (
        <button onClick={onRemove} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition border-t border-ink-700/40">
          <FolderMinus size={12}/> Remove from folder
        </button>
      )}
      <div className="border-t border-ink-700/40 mt-1 pt-1">
        <button onClick={onDelete} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition">
          <Trash2 size={12}/> Delete
        </button>
      </div>
    </div>
  );
}
