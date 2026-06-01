import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { FileText, BookOpen, Film, MoreVertical, FolderPlus, FolderMinus,
         Trash2, Pencil, Copy, Check, X, Star, Link } from 'lucide-react';
import PlayerPickerModal from '../ui/PlayerPickerModal';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import { progressStore, recentStore } from '../../utils/storage';
import { formatSize, formatRelativeDate, cleanFileName, getInitials, stringToColor } from '../../utils/format';

const FileCard = memo(function FileCard({
  file, progress, thumbnailUrl, listMode = false,
  onProgressUpdate, isFav = false,
}) {
  const { state, actions } = useApp();
  const [showMenu, setShowMenu]   = useState(false);
  const [renaming, setRenaming]   = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [loading, setLoading]     = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [thumbVisible, setThumbVisible] = useState(false);
  const [copyDone, setCopyDone]   = useState(false);
  const cardRef   = useRef(null);
  const menuRef   = useRef(null);
  const renameRef = useRef(null);

  useEffect(() => {
    if (!thumbnailUrl) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setThumbVisible(true); obs.disconnect(); } },
      { rootMargin: '150px' }
    );
    if (cardRef.current) obs.observe(cardRef.current);
    return () => obs.disconnect();
  }, [thumbnailUrl]);

  useEffect(() => {
    if (!showMenu) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showMenu]);

  useEffect(() => { if (renaming && renameRef.current) renameRef.current.focus(); }, [renaming]);

  const title    = cleanFileName(file.name);
  const initials = getInitials(file.name);
  const color    = stringToColor(file.name);
  const pct      = progress?.percent || 0;
  const isPdf    = file.type === 'pdf';
  const isEpub   = file.type === 'epub';
  const isVideo  = file.type === 'video';

  const openFile = useCallback(async () => {
    if (renaming) return;
    try {
      await recentStore.add(file.id, file.name);
      actions.addRecent({ fileId: file.id, fileName: file.name, openedAt: Date.now() });
    } catch {}
    setShowPicker(true);
  }, [renaming, file.id, file.name]);

  const toggleFavorite = useCallback(async (e) => {
    e.stopPropagation();
    try {
      if (isFav) { await api.removeFavorite(file.id); }
      else        { await api.addFavorite(file.id); }
      actions.toggleFavorite(file.id);
    } catch {}
  }, [isFav, file.id]);

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
    setLoading(null); setRenaming(false);
  }

  function copyStreamLink() {
    navigator.clipboard.writeText(api.getStreamUrl(file.id)).catch(() => {});
    setCopyDone(true);
    setTimeout(() => setCopyDone(false), 2000);
    setShowMenu(false);
  }

  const currentFolder    = state.fileAssignments[file.id];
  const availableFolders = state.folders.filter(f => f.id !== currentFolder);
  const busy = loading !== null;

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
      <>
        {showPicker && <PlayerPickerModal file={file} streamUrl={api.getStreamUrl(file.id)} onClose={() => setShowPicker(false)} />}
        <div
          className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-ink-800/40
                      border border-transparent hover:border-ink-700/30 transition-all duration-150
                      ${renaming ? '' : 'cursor-pointer'}`}
          onClick={renaming ? undefined : openFile}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0 overflow-hidden" style={{ background: color }}>
            {thumbnailUrl
              ? (thumbVisible ? <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" /> : null)
              : initials}
          </div>

          <div className="flex-1 min-w-0">
            {renaming ? (
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
                  className="flex-1 bg-ink-700 text-ink-100 text-sm rounded px-2 py-0.5 outline-none border border-accent/40" />
                <button onClick={submitRename} className="p-0.5 text-green-400"><Check size={13}/></button>
                <button onClick={() => setRenaming(false)} className="p-0.5 text-ink-500"><X size={13}/></button>
              </div>
            ) : (
              <p className="text-sm text-ink-200 truncate leading-tight">{title}</p>
            )}
            <p className="text-xs text-ink-500 mt-0.5">{formatSize(file.size)} · {formatRelativeDate(file.date)}</p>
          </div>

          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md flex items-center gap-1 shrink-0 ${typeBadgeColor}`}>
            {typeIcon} {typeLabel}
          </span>

          {(isPdf || isEpub) && pct > 0 && (
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="w-14 h-1 bg-ink-700 rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[9px] text-ink-500">{Math.round(pct)}%</span>
            </div>
          )}

          <button onClick={toggleFavorite}
            className={`p-1 shrink-0 transition-colors ${isFav ? 'text-yellow-400' : 'opacity-0 group-hover:opacity-100 text-ink-600 hover:text-yellow-400'}`}>
            <Star size={13} fill={isFav ? 'currentColor' : 'none'} />
          </button>

          <div className="relative" onClick={e => e.stopPropagation()} ref={menuRef}>
            <button onClick={() => setShowMenu(v => !v)}
              className="p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-ink-700/50 text-ink-400 transition">
              <MoreVertical size={14} />
            </button>
            {showMenu && <ContextMenu
              title={title} currentFolder={currentFolder} availableFolders={availableFolders}
              busy={busy} copyDone={copyDone}
              onAssign={assignToFolder} onRemove={removeFromFolder}
              onRename={() => { setRenameVal(title); setRenaming(true); setShowMenu(false); }}
              onCopy={handleCopy} onDelete={handleDelete} onCopyLink={copyStreamLink}
            />}
          </div>
        </div>
      </>
    );
  }

  // ── Grid mode ──────────────────────────────────────────────────────────────
  return (
    <>
      {showPicker && <PlayerPickerModal file={file} streamUrl={api.getStreamUrl(file.id)} onClose={() => setShowPicker(false)} />}

      <div
        ref={cardRef}
        className={`group relative rounded-2xl border bg-ink-900/50
                    hover:border-ink-700/60 hover:bg-ink-800/60 transition-all duration-150 overflow-hidden
                    ${renaming ? '' : 'cursor-pointer'} border-ink-800/50`}
        onClick={renaming ? undefined : openFile}
      >
        <div className="h-28 flex items-center justify-center relative overflow-hidden"
          style={thumbnailUrl ? {} : { background: `${color}18` }}>
          {thumbnailUrl ? (
            thumbVisible
              ? <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" onError={e => { e.target.style.display = 'none'; }} />
              : <div className="w-full h-full bg-ink-800" />
          ) : (
            <span className="text-4xl font-bold select-none" style={{ color: `${color}60` }}>{initials}</span>
          )}

          {isVideo && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
                <Film size={18} className="text-white" />
              </div>
            </div>
          )}

          {(isPdf || isEpub) && pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-ink-800/80">
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          )}

          {/* Star */}
          <button onClick={toggleFavorite}
            className={`absolute top-2 right-8 w-6 h-6 rounded-lg flex items-center justify-center transition-all
              ${isFav ? 'opacity-100 text-yellow-400' : 'opacity-0 group-hover:opacity-100 bg-ink-900/80 text-ink-400 hover:text-yellow-400'}`}>
            <Star size={11} fill={isFav ? 'currentColor' : 'none'} />
          </button>

          {/* Menu */}
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={e => e.stopPropagation()} ref={menuRef}>
            <button onClick={() => setShowMenu(v => !v)}
              className="w-6 h-6 rounded-lg bg-ink-900/80 flex items-center justify-center text-ink-400 hover:text-ink-100">
              <MoreVertical size={12} />
            </button>
            {showMenu && <ContextMenu
              title={title} currentFolder={currentFolder} availableFolders={availableFolders}
              busy={busy} copyDone={copyDone}
              onAssign={assignToFolder} onRemove={removeFromFolder}
              onRename={() => { setRenameVal(title); setRenaming(true); setShowMenu(false); }}
              onCopy={handleCopy} onDelete={handleDelete} onCopyLink={copyStreamLink}
            />}
          </div>
        </div>

        <div className="px-3 py-2.5">
          {renaming ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
                className="flex-1 bg-ink-700 text-ink-100 text-sm rounded px-2 py-0.5 outline-none border border-accent/40" />
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
            <span className="text-[10px] text-ink-500">
              {(isPdf || isEpub) && pct > 0 ? `${Math.round(pct)}%` : formatSize(file.size)}
            </span>
          </div>
        </div>
      </div>
    </>
  );
});

export default FileCard;

// ── Context Menu ───────────────────────────────────────────────────────────────
function ContextMenu({ title, currentFolder, availableFolders, busy, copyDone,
                       onAssign, onRemove, onRename, onCopy, onDelete, onCopyLink }) {
  return (
    <div className="absolute right-0 top-8 z-50 w-44 bg-ink-850 border border-ink-700/60 rounded-xl shadow-2xl overflow-hidden py-1">
      <button onClick={onRename} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
        <Pencil size={12}/> Rename
      </button>
      <button onClick={onCopy} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
        <Copy size={12}/> Duplicate
      </button>
      <button onClick={onCopyLink} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-ink-700/50 transition">
        {copyDone ? <Check size={12} className="text-green-400"/> : <Link size={12}/>}
        {copyDone ? 'Copied!' : 'Copy Link'}
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
