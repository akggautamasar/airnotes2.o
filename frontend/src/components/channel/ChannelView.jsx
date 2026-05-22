import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Hash, RefreshCw, Grid, List, Film, BookOpen, FileText,
  ChevronRight, Globe, Lock, Users, Info, X,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';
import FileCard from '../library/FileCard';

const TYPE_ICONS = { video: Film, pdf: FileText, epub: BookOpen };
const TYPE_FILTERS = ['all', 'video', 'pdf', 'epub'];

function ChannelBadge({ channel }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-[10px] font-mono">
      <Hash size={9} />
      <span>{channel.username ? `@${channel.username}` : `id:${channel.id}`}</span>
    </div>
  );
}

export default function ChannelView() {
  const { state, actions } = useApp();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('all');
  const [viewMode, setViewMode] = useState(state.viewMode);
  const [showInfo, setShowInfo] = useState(false);
  const [channelMeta, setChannelMeta] = useState(null);

  const isAllChannels = state.activeChannelId === '__all__';
  const activeChannel = isAllChannels
    ? null
    : state.channels.find(c => c.str_id === state.activeChannelId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let res;
      if (isAllChannels) {
        res = await api.getAllChannelsFiles(typeFilter !== 'all' ? typeFilter : null);
        setFiles(res.files || []);
        setChannelMeta({ name: 'All Channels', file_count: res.total, channel_count: res.channel_count });
      } else if (activeChannel) {
        res = await api.getChannelFiles(activeChannel.str_id, typeFilter !== 'all' ? typeFilter : null);
        setFiles(res.files || []);
        setChannelMeta({ ...res.channel, file_count: res.total });
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [state.activeChannelId, typeFilter, isAllChannels]);

  useEffect(() => { load(); }, [load]);

  const title = isAllChannels ? 'All Channels' : (activeChannel?.name || 'Channel');
  const subtitle = isAllChannels
    ? `${state.channels.length} channels · ${files.length} files`
    : `${files.length} files${activeChannel?.username ? ` · @${activeChannel.username}` : ''}`;

  // Group files by channel when showing all
  const groupedFiles = isAllChannels
    ? state.channels.reduce((acc, ch) => {
        const chFiles = files.filter(f => String(f.channel_id) === String(ch.id));
        if (chFiles.length) acc[ch.str_id] = { channel: ch, files: chFiles };
        return acc;
      }, {})
    : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-ink-800/50 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
          {isAllChannels ? <Globe size={16} className="text-accent" /> : <Hash size={16} className="text-accent" />}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-ink-100 truncate">{title}</h2>
          <p className="text-[11px] text-ink-500 font-mono">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {!isAllChannels && activeChannel && <ChannelBadge channel={activeChannel} />}
          <button
            onClick={() => setShowInfo(v => !v)}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800/60 transition-colors"
            title="Channel info"
          >
            <Info size={14} />
          </button>
          <button
            onClick={load}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800/60 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setViewMode(v => v === 'grid' ? 'list' : 'grid')}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800/60 transition-colors"
          >
            {viewMode === 'grid' ? <List size={14} /> : <Grid size={14} />}
          </button>
        </div>
      </div>

      {/* Info panel */}
      <AnimatePresence>
        {showInfo && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-ink-800/40"
          >
            <div className="px-6 py-3 bg-ink-900/50 flex items-start gap-4 flex-wrap text-[11px] text-ink-400">
              {isAllChannels ? (
                <>
                  <span className="flex items-center gap-1.5"><Users size={11} className="text-accent" />{state.channels.length} registered channels</span>
                  <span className="flex items-center gap-1.5"><FileText size={11} className="text-accent" />{files.length} total files</span>
                </>
              ) : activeChannel && (
                <>
                  <span className="flex items-center gap-1.5"><Hash size={11} className="text-accent" />{activeChannel.id}</span>
                  {activeChannel.username && <span>@{activeChannel.username}</span>}
                  <span>Registered {new Date(activeChannel.registered_at).toLocaleDateString()}</span>
                  {activeChannel.auto_detected && <span className="text-accent/70">• auto-detected</span>}
                </>
              )}
              <button onClick={() => setShowInfo(false)} className="ml-auto text-ink-600 hover:text-ink-400">
                <X size={11} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Type filter */}
      <div className="flex items-center gap-1 px-6 py-2.5 border-b border-ink-800/30 shrink-0">
        {TYPE_FILTERS.map(t => {
          const Icon = t !== 'all' ? TYPE_ICONS[t] : null;
          const count = t === 'all' ? files.length : files.filter(f => f.type === t).length;
          return (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all capitalize
                ${typeFilter === t
                  ? 'bg-accent/15 text-accent border border-accent/25'
                  : 'text-ink-500 hover:text-ink-300 hover:bg-ink-800/40'
                }`}
            >
              {Icon && <Icon size={11} />}
              {t === 'all' ? 'All' : t.toUpperCase()}
              <span className="text-[9px] font-mono opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 gap-2 text-ink-500 text-sm">
            <RefreshCw size={14} className="animate-spin" /> Loading…
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-ink-500">
            <Hash size={32} className="opacity-20" />
            <p className="text-sm">No files found</p>
            {isAllChannels && (
              <p className="text-xs text-ink-600 text-center max-w-xs">
                Add the bot to your Telegram channels and run <code className="bg-ink-800 px-1 py-0.5 rounded text-accent">/setup_channel</code>
              </p>
            )}
          </div>
        ) : isAllChannels && groupedFiles ? (
          // Grouped by channel
          <div className="px-6 py-4 space-y-8">
            {Object.values(groupedFiles).map(({ channel, files: chFiles }) => (
              <div key={channel.str_id}>
                <button
                  onClick={() => actions.setActiveChannel(channel.str_id)}
                  className="flex items-center gap-2 mb-3 group"
                >
                  <Hash size={13} className="text-accent/70" />
                  <span className="text-sm font-semibold text-ink-200 group-hover:text-ink-50 transition-colors">{channel.name}</span>
                  <span className="text-[10px] text-ink-600 font-mono">{chFiles.length} files</span>
                  <ChevronRight size={11} className="text-ink-600 group-hover:text-ink-400 transition-colors" />
                </button>
                <div className={viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'space-y-1'
                }>
                  {chFiles.slice(0, 8).map(file => (
                    <FileCard key={file.id} file={file} viewMode={viewMode} />
                  ))}
                </div>
                {chFiles.length > 8 && (
                  <button
                    onClick={() => actions.setActiveChannel(channel.str_id)}
                    className="mt-2 text-xs text-accent/70 hover:text-accent transition-colors flex items-center gap-1"
                  >
                    <ChevronRight size={11} /> View all {chFiles.length} files from {channel.name}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          // Flat file list for single channel
          <div className={`px-6 py-4 ${viewMode === 'grid'
            ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
            : 'space-y-1'
          }`}>
            {files.map(file => (
              <FileCard key={file.id} file={file} viewMode={viewMode} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
