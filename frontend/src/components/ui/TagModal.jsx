import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Tag, Plus, Check } from 'lucide-react';
import { api } from '../../utils/api';
import { useApp } from '../../store/AppContext';
import { cleanFileName } from '../../utils/format';

const TAG_COLORS = [
  'bg-red-500/20 text-red-400 border-red-500/30',
  'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'bg-green-500/20 text-green-400 border-green-500/30',
  'bg-teal-500/20 text-teal-400 border-teal-500/30',
  'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'bg-purple-500/20 text-purple-400 border-purple-500/30',
  'bg-pink-500/20 text-pink-400 border-pink-500/30',
];

export function tagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export default function TagModal({ file, onClose }) {
  const { state, actions } = useApp();
  const currentTags = state.fileTags[file.id] || [];
  const [tags, setTags]     = useState([...currentTags]);
  const [input, setInput]   = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  const title = cleanFileName(file.name);
  const suggestions = state.allTags.filter(t => !tags.includes(t) && t.includes(input.toLowerCase()));

  function addTag(tag) {
    const clean = tag.trim().toLowerCase();
    if (!clean || tags.includes(clean)) return;
    setTags(t => [...t, clean]);
    setInput('');
    inputRef.current?.focus();
  }

  function removeTag(tag) { setTags(t => t.filter(x => x !== tag)); }

  async function save() {
    setSaving(true);
    try {
      await api.setFileTags(file.id, tags);
      actions.setFileTags(file.id, tags);
      // Update allTags
      const allTagsRes = await api.getAllTags();
      actions.setAllTags(allTagsRes.tags || []);
      onClose();
    } catch (e) { alert(e.message); }
    setSaving(false);
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <motion.div
        className="relative glass rounded-2xl w-full max-w-sm shadow-2xl"
        initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-700/40">
          <Tag size={15} className="text-accent shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink-100">Edit Tags</p>
            <p className="text-xs text-ink-500 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-ink-500 hover:text-ink-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Current tags */}
          <div className="flex flex-wrap gap-1.5 min-h-[32px]">
            {tags.length === 0 && <p className="text-ink-700 text-xs">No tags yet</p>}
            {tags.map(tag => (
              <span key={tag} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs border ${tagColor(tag)}`}>
                {tag}
                <button onClick={() => removeTag(tag)} className="opacity-60 hover:opacity-100 transition-opacity ml-0.5">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>

          {/* Input */}
          <div>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && input.trim()) { e.preventDefault(); addTag(input); }
                  if (e.key === ',' && input.trim()) { e.preventDefault(); addTag(input.replace(',', '')); }
                }}
                placeholder="Add tag… (Enter or comma to add)"
                className="flex-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-xs text-ink-100 outline-none focus:border-accent/50 placeholder:text-ink-600"
                autoFocus
              />
              <button
                onClick={() => addTag(input)}
                disabled={!input.trim()}
                className="p-2 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-30 transition-colors"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Suggestions */}
            {input && suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {suggestions.slice(0, 8).map(t => (
                  <button
                    key={t}
                    onClick={() => addTag(t)}
                    className={`px-2 py-0.5 rounded-lg text-xs border opacity-70 hover:opacity-100 transition-opacity ${tagColor(t)}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* All tags quick-add */}
          {state.allTags.length > 0 && (
            <div>
              <p className="text-[10px] text-ink-600 uppercase tracking-widest mb-2">Existing tags</p>
              <div className="flex flex-wrap gap-1.5">
                {state.allTags.filter(t => !tags.includes(t)).slice(0, 12).map(t => (
                  <button
                    key={t}
                    onClick={() => addTag(t)}
                    className={`px-2 py-0.5 rounded-lg text-xs border opacity-60 hover:opacity-100 transition-opacity ${tagColor(t)}`}
                  >
                    + {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-xl text-sm text-ink-400 hover:text-ink-200 hover:bg-ink-800/50 transition-colors">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 btn-primary py-2 rounded-xl text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Check size={13} /> {saving ? 'Saving…' : 'Save Tags'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
