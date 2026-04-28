import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FileText, BookOpen, Clock, MoreVertical, FolderPlus, FolderMinus, Trash2, Pencil, Copy, Check, X } from 'lucide-react';
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
    setRenaming(false); setLoading(null);
  }

  const currentFolder    = state.fileAssignments[file.id];
  const availableFolders = state.folders.filter(f => f.id !== currentFolder);
  const busy = loading !== null;

  const typeIcon = isPdf
    ? <FileText size={11} className="text-red-400/70" />
    : <BookOpen size={11} className="text-blue-400/70" />;
  const typeLabel = isPdf ? 'PDF' : 'EPUB';
  const typeBadgeColor = isPdf ? 'bg-red-500/10 text-red-400/80' : 'bg-blue-500/10 text-blue-400/80';

  // ── List mode ──────────────────────────────────────────────────────────
  if (listMode) {
    return (
      <div
        className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-ink-800/40
                    border border-transparent hover:border-ink-700/30 transition-all duration-150 ${renaming ? '' : 'cursor-pointer'}`}
        onClick={renaming ? undefined : openFile}
      >
        {/* Type icon */}
        <div className="w-7 h-9 rounded-md flex items-center justify-center shrink-0 text-white"
             style={{ background: color }}>
          {busy ? <span className="text-xs animate-pulse">⌛</span> : <span className="text-[10px] font-bold">{initials}</span>}
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
                className="flex-1 bg-ink-800 text-ink-100 text-xs px-2 py-0.5 rounded border border-ink-600 outline-none focus:border-accent/50" />
              <button onClick={submitRename} className="text-green-400 p-0.5"><Check size={12}/></button>
              <button onClick={() => setRenaming(false)} className="text-red-400 p-0.5"><X size={12}/></button>
            </div>
          ) : (
            <>
              <p className="text-ink-100 text-xs font-medium truncate">{title}</p>
              <div className="flex items-center gap-1 mt-0.5">
                {typeIcon}
                <span className="text-[10px] text-ink-600">{typeLabel}</span>
              </div>
            </>
          )}
        </div>

        <span className="w-16 text-right text-ink-600 text-xs shrink-0 hidden sm:block">{formatSize(file.size)}</span>
        <span className="w-20 text-right text-ink-600 text-xs shrink-0 hidden md:block">{formatRelativeDate(file.date)}</span>

        {/* Progress bar */}
        <div className="w-16 shrink-0 hidden sm:block">
          {pct > 0 && <div className="text-right text-[10px] text-ink-600 mb-0.5">{pct}%</div>}
          <div className="h-0.5 bg-ink-800 rounded-full overflow-hidden">
            {pct > 0 && <div className="h-full bg-accent/60 rounded-full" style={{ width: `${pct}%` }} />}
          </div>
        </div>

        {/* Menu */}
        <div className="w-6 shrink-0 relative" ref={menuRef} onClick={e => e.stopPropagation()}>
          <button onClick={() => setShowMenu(!showMenu)}
            className="opacity-0 group-hover:opacity-100 text-ink-500 hover:text-ink-200 transition-all p-1">
            <MoreVertical size={13} />
          </button>
          {showMenu && <FileMenu {...{ availableFolders, currentFolder, onAssign: assignToFolder, onRemove: removeFromFolder, onDelete: handleDelete, onCopy: handleCopy, onRename: () => { setRenameVal(title); setRenaming(true); setShowMenu(false); }, onClose: () => setShowMenu(false) }} />}
        </div>
      </div>
    );
  }

  // ── Grid card ──────────────────────────────────────────────────────────
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className={`group relative rounded-2xl border border-ink-800/50 overflow-hidden
                  hover:border-ink-700/60 hover:shadow-xl hover:shadow-black/40
                  transition-all duration-200 bg-ink-900 ${renaming ? '' : 'cursor-pointer'}`}
      onClick={renaming ? undefined : openFile}
    >
      {/* Thumbnail / cover */}
      <div className="relative h-36 overflow-hidden flex items-center justify-center"
           style={{ background: thumbnail ? undefined : `linear-gradient(135deg, ${color}cc, ${color}66)` }}>
        {thumbnail ? (
          <img src={thumbnail} alt={title} className="w-full h-full object-cover" />
        ) : (
          <div className="text-center px-2">
            <p className="text-white/90 font-bold font-display text-2xl leading-none mb-1">
              {busy ? '⌛' : initials}
            </p>
            <div className="flex items-center justify-center gap-1 text-white/50">
              {typeIcon}
              <span className="text-[9px] font-mono">{typeLabel}</span>
            </div>
          </div>
        )}

        {/* Progress strip */}
        {pct > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30">
            <div className="h-full bg-accent/70 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* Type badge */}
        <div className={`absolute top-2 left-2 text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${typeBadgeColor}`}>
          {typeLabel}
        </div>

        {/* 3-dot menu */}
        <div ref={menuRef} className="absolute top-2 right-2" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="opacity-0 group-hover:opacity-100 transition-all p-1.5 rounded-lg bg-black/50 backdrop-blur-sm text-white/70 hover:text-white"
          >
            <MoreVertical size={12} />
          </button>
          {showMenu && (
            <div className="absolute top-8 right-0 z-20">
              <FileMenu {...{ availableFolders, currentFolder, onAssign: assignToFolder, onRemove: removeFromFolder, onDelete: handleDelete, onCopy: handleCopy, onRename: () => { setRenameVal(title); setRenaming(true); setShowMenu(false); }, onClose: () => setShowMenu(false) }} />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-2.5 py-2 bg-ink-900">
        {renaming ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
              className="flex-1 bg-ink-800 text-ink-100 text-xs px-2 py-0.5 rounded border border-ink-600 outline-none" />
            <button onClick={submitRename} className="text-green-400"><Check size={11}/></button>
            <button onClick={() => setRenaming(false)} className="text-red-400"><X size={11}/></button>
          </div>
        ) : (
          <p className="text-ink-100 text-xs font-medium truncate leading-snug mb-1" title={title}>{title}</p>
        )}
        <div className="flex items-center justify-between text-ink-600 text-[10px]">
          <span>{formatSize(file.size)}</span>
          <span className="flex items-center gap-0.5"><Clock size={9} />{formatRelativeDate(file.date)}</span>
        </div>
      </div>
    </motion.div>
  );
}

function FileMenu({ availableFolders, currentFolder, onAssign, onRemove, onDelete, onCopy, onRename, onClose }) {
  return (
    <div className="glass rounded-xl shadow-2xl min-w-[160px] py-1.5 z-50" onMouseLeave={onClose}>
      <button onClick={onRename}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-700/40">
        <Pencil size={11} /> Rename
      </button>
      <button onClick={onCopy}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-700/40">
        <Copy size={11} /> Duplicate
      </button>
      <button onClick={onDelete}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10">
        <Trash2 size={11} /> Delete
      </button>
      {(currentFolder || availableFolders.length > 0) && <div className="border-t border-ink-700/40 my-1" />}
      {currentFolder && (
        <button onClick={onRemove}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-400 hover:bg-ink-700/40">
          <FolderMinus size={11} /> Remove from folder
        </button>
      )}
      {availableFolders.length > 0 && (
        <>
          <p className="px-3 py-1 text-[10px] text-ink-600 uppercase tracking-wider">Add to folder</p>
          {availableFolders.map(f => (
            <button key={f.id} onClick={() => onAssign(f.id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-700/40">
              <FolderPlus size={11} /> {f.name}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
