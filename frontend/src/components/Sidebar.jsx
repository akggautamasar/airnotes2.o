import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Home, Clock, FolderOpen, Folder, Plus, ChevronRight,
  Lock, Unlock, Trash2, Pencil, Check, X, MoreHorizontal,
  BookMarked, Search, RefreshCw, LogOut, Globe, Star, Hash,
} from 'lucide-react';
import { useApp } from '../store/AppContext';
import { api } from '../utils/api';
import FolderLockModal from './ui/FolderLockModal';

export default function Sidebar({ onSearch, onRefresh }) {
  const { state, actions } = useApp();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName]   = useState('');
  const [saving, setSaving]   = useState(false);
  const [lockModal, setLockModal] = useState(null);

  const navItems = [
    { key: 'library',   icon: Home,      label: 'All Files',        count: state.files.length },
    { key: 'favorites', icon: Star,       label: 'Favorites',        count: state.favorites.length },
    { key: 'recent',    icon: Clock,      label: 'Recent',           count: state.recentFiles.length },
    { key: 'continue',  icon: BookMarked, label: 'Continue Reading', count: Object.keys(state.progress || {}).length },
  ];

  async function createFolder() {
    if (!newFolderName.trim() || saving) return;
    setSaving(true);
    try {
      const res = await api.createFolder(newFolderName.trim());
      const f = res.folder;
      actions.addFolder({
        id: f.id, name: f.name, parentId: f.parent_id,
        locked: f.locked || false, passwordHash: f.password_hash || null,
        createdAt: f.created_at, fileCount: 0,
      });
    } catch (e) { console.error(e); }
    setNewFolderName('');
    setCreatingFolder(false);
    setSaving(false);
  }

  function handleLogout() {
    if (confirm('Sign out of AirNotes?')) actions.logout();
  }

  const rootFolders  = state.folders.filter(f => !f.parentId);
  const childFolders = (parentId) => state.folders.filter(f => f.parentId === parentId);

  return (
    <>
      <aside className="w-56 h-full bg-ink-900 border-r border-ink-800/50 flex flex-col">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-ink-800/40 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-ink-800 border border-ink-700/50 flex items-center justify-center text-base">✦</div>
            <div>
              <h1 className="font-display text-sm font-bold text-ink-50 leading-none">AirNotes</h1>
              <p className="text-[10px] text-accent/70 font-mono mt-0.5">2.0</p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-3 shrink-0">
          <button onClick={onSearch}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-ink-800/60 border border-ink-700/30 text-ink-400 text-xs hover:bg-ink-800 hover:text-ink-200 transition-all">
            <Search size={13} />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="text-[10px] bg-ink-700/50 px-1.5 py-0.5 rounded text-ink-500 font-mono">⌘K</kbd>
          </button>
        </div>

        {/* Nav */}
        <nav className="px-3 space-y-0.5 shrink-0">
          {navItems.map(item => (
            <button
              key={item.key}
              onClick={() => actions.setActiveSection(item.key)}
              className={`sidebar-item ${state.activeSection === item.key && !state.activeFolderId ? 'active' : ''}`}
            >
              <item.icon size={14} className="shrink-0" />
              <span className="flex-1 text-left text-xs">{item.label}</span>
              {item.count > 0 && (
                <span className="text-[10px] bg-ink-800 text-ink-500 px-1.5 py-0.5 rounded-full shrink-0">{item.count}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="mx-3 my-2 border-t border-ink-800/40 shrink-0" />

        {/* Channels */}
        {state.channels.length > 0 && (
          <>
            <div className="px-3 mb-1 shrink-0">
              <div className="flex items-center px-1 py-1.5 mb-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-600">Channels</span>
              </div>
              <button
                onClick={() => actions.setActiveChannel('__all__')}
                className={`sidebar-item ${state.activeSection === 'channel' && state.activeChannelId === '__all__' ? 'active' : ''}`}>
                <Globe size={13} className="shrink-0 text-accent/60" />
                <span className="flex-1 text-left text-xs">All Channels</span>
                <span className="text-[10px] bg-ink-800 text-ink-500 px-1.5 py-0.5 rounded-full shrink-0">
                  {state.channels.reduce((s, c) => s + (c.file_count || 0), 0)}
                </span>
              </button>
              {state.channels.map(ch => (
                <button key={ch.str_id} onClick={() => actions.setActiveChannel(ch.str_id)}
                  className={`sidebar-item ${state.activeSection === 'channel' && state.activeChannelId === ch.str_id ? 'active' : ''}`}>
                  <Hash size={13} className="shrink-0 text-accent/50" />
                  <span className="flex-1 text-left text-xs truncate">{ch.name}</span>
                  {ch.file_count > 0 && (
                    <span className="text-[10px] bg-ink-800 text-ink-500 px-1.5 py-0.5 rounded-full shrink-0">{ch.file_count}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="mx-3 my-1 border-t border-ink-800/40 shrink-0" />
          </>
        )}

        {/* Folders */}
        <div className="flex-1 overflow-y-auto px-3 pb-2">
          <div className="flex items-center justify-between px-1 py-1.5 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-600">Folders</span>
            <button onClick={() => setCreatingFolder(true)}
              className="text-ink-600 hover:text-ink-300 transition-colors p-0.5 rounded" title="New folder">
              <Plus size={12} />
            </button>
          </div>

          {creatingFolder && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex gap-1 mb-2">
              <input
                autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); } }}
                placeholder="Folder name…"
                className="flex-1 bg-ink-800 border border-ink-700 rounded-lg px-2 py-1 text-xs text-ink-100 outline-none focus:border-accent/50"
              />
              <button onClick={createFolder} disabled={saving} className="text-accent p-1"><Check size={11} /></button>
              <button onClick={() => { setCreatingFolder(false); setNewFolderName(''); }} className="text-ink-500 p-1"><X size={11} /></button>
            </motion.div>
          )}

          <div className="space-y-0.5">
            {rootFolders.map(folder => (
              <FolderTree
                key={folder.id}
                folder={folder}
                depth={0}
                children={childFolders(folder.id)}
                childFoldersFn={childFolders}
                isActive={state.activeFolderId === folder.id}
                isUnlocked={state.unlockedFolders.includes(folder.id)}
                fileCount={Object.values(state.fileAssignments).filter(id => id === folder.id).length}
                activeFolderId={state.activeFolderId}
                unlockedFolders={state.unlockedFolders}
                fileAssignments={state.fileAssignments}
                onSelectFolder={actions.setActiveFolder}
                onSelect={() => actions.setActiveFolder(folder.id)}
                onLockToggle={() => setLockModal({ folder, mode: folder.locked ? 'unlock' : 'lock' })}
                onDelete={async (id, name) => {
                  if (!confirm(`Delete folder "${name}"?`)) return;
                  try { await api.deleteFolder(id); actions.removeFolder(id); } catch (e) { alert(e.message); }
                }}
                onRename={async (id, name) => {
                  try { await api.updateFolder(id, { name }); actions.updateFolder({ id, name }); } catch (e) { alert(e.message); }
                }}
              />
            ))}
            {state.folders.length === 0 && !creatingFolder && (
              <p className="text-ink-700 text-xs px-1 py-3 text-center">No folders yet</p>
            )}
          </div>
        </div>

        {/* Bottom */}
        <div className="px-3 py-3 border-t border-ink-800/40 space-y-0.5 shrink-0">
          <button onClick={onRefresh} className="sidebar-item">
            <RefreshCw size={13} className="shrink-0" />
            <span className="text-xs">Refresh library</span>
          </button>
          <button onClick={handleLogout} className="sidebar-item text-red-400/70 hover:text-red-400 hover:bg-red-500/10">
            <LogOut size={13} className="shrink-0" />
            <span className="text-xs">Sign out</span>
          </button>
        </div>
      </aside>

      {lockModal && (
        <FolderLockModal folder={lockModal.folder} mode={lockModal.mode}
          onClose={() => setLockModal(null)} onSuccess={() => setLockModal(null)} />
      )}
    </>
  );
}

// ── Recursive folder tree item ───────────────────────────────────────────────
const FolderTree = React.memo(function FolderTree({
  folder, depth, children, childFoldersFn, isActive, isUnlocked, fileCount,
  activeFolderId, unlockedFolders, fileAssignments, onSelectFolder,
  onSelect, onLockToggle, onDelete, onRename,
}) {
  const [showMenu, setShowMenu]   = useState(false);
  const [renaming, setRenaming]   = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [expanded, setExpanded]   = useState(true);
  const isLocked   = folder.locked && !isUnlocked;
  const hasChildren = children.length > 0;
  const Icon = isActive ? FolderOpen : (isLocked ? Lock : Folder);

  if (renaming) return (
    <div className="flex gap-1" style={{ paddingLeft: depth * 12 }}>
      <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { onRename(folder.id, renameVal.trim()); setRenaming(false); }
          if (e.key === 'Escape') setRenaming(false);
        }}
        className="flex-1 bg-ink-800 border border-ink-700 rounded-lg px-2 py-1 text-xs text-ink-100 outline-none focus:border-accent/50" />
      <button onClick={() => { onRename(folder.id, renameVal.trim()); setRenaming(false); }} className="text-accent p-1"><Check size={11}/></button>
      <button onClick={() => setRenaming(false)} className="text-ink-500 p-1"><X size={11}/></button>
    </div>
  );

  return (
    <div>
      <div className="relative group" style={{ paddingLeft: depth * 12 }}>
        <button
          onClick={onSelect}
          className={`sidebar-item transition-all ${isActive ? 'active' : ''}`}
        >
          {hasChildren && (
            <button onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              className="shrink-0 text-ink-600 hover:text-ink-400 -ml-0.5 mr-0.5">
              <ChevronRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          )}
          <Icon size={13} className={`shrink-0 ${isLocked ? 'text-amber-500/70' : ''}`} />
          <span className="flex-1 text-left text-xs truncate">{folder.name}</span>
          {fileCount > 0 && <span className="text-[10px] bg-ink-800 text-ink-500 px-1 rounded shrink-0">{fileCount}</span>}
        </button>

        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1 rounded text-ink-600 hover:text-ink-300">
            <MoreHorizontal size={11} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 glass rounded-xl shadow-xl min-w-[148px] py-1 z-50"
              onMouseLeave={() => setShowMenu(false)}>
              <button onClick={() => { setRenameVal(folder.name); setRenaming(true); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800/50">
                <Pencil size={11} /> Rename
              </button>
              <button onClick={() => { onLockToggle(); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800/50">
                {folder.locked ? <Unlock size={11} className="text-amber-400" /> : <Lock size={11} />}
                {folder.locked ? 'Manage lock' : 'Lock folder'}
              </button>
              <div className="border-t border-ink-700/40 my-0.5" />
              <button onClick={() => { onDelete(folder.id, folder.name); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10">
                <Trash2 size={11} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {hasChildren && expanded && (
        <div className="space-y-0.5">
          {children.map(child => (
            <FolderTree
              key={child.id}
              folder={child}
              depth={depth + 1}
              children={childFoldersFn(child.id)}
              childFoldersFn={childFoldersFn}
              isActive={activeFolderId === child.id}
              isUnlocked={unlockedFolders.includes(child.id)}
              fileCount={Object.values(fileAssignments).filter(id => id === child.id).length}
              activeFolderId={activeFolderId}
              unlockedFolders={unlockedFolders}
              fileAssignments={fileAssignments}
              onSelectFolder={onSelectFolder}
              onSelect={() => onSelectFolder(child.id)}
              onLockToggle={() => {}}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  );
});
