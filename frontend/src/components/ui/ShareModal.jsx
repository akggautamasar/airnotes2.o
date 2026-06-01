import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Link, Copy, Check, Trash2, Plus, Clock } from 'lucide-react';
import { api } from '../../utils/api';
import { cleanFileName } from '../../utils/format';

const EXPIRY_OPTIONS = [
  { label: '1 hour',   hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days',   hours: 168 },
  { label: '30 days',  hours: 720 },
  { label: 'Never',    hours: 0 },
];

export default function ShareModal({ file, onClose }) {
  const [shares, setShares]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expiry, setExpiry]   = useState(24);
  const [copied, setCopied]   = useState(null);

  const title = cleanFileName(file.name);
  const baseUrl = api.getShareBaseUrl();

  useEffect(() => { loadShares(); }, []);

  async function loadShares() {
    setLoading(true);
    try {
      const res = await api.getFileShares(file.id);
      setShares(res.shares || []);
    } catch {}
    setLoading(false);
  }

  async function createLink() {
    setCreating(true);
    try {
      await api.createShareLink(file.id, expiry);
      await loadShares();
    } catch (e) { alert(e.message); }
    setCreating(false);
  }

  async function revokeLink(token) {
    try {
      await api.revokeShareLink(file.id, token);
      setShares(s => s.filter(sh => sh.token !== token));
    } catch (e) { alert(e.message); }
  }

  function copyLink(token) {
    const url = `${baseUrl}/share/${token}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }

  function formatExpiry(expiresAt) {
    if (!expiresAt) return 'Never expires';
    const d = new Date(expiresAt + 'Z');
    const diff = d - Date.now();
    if (diff < 0) return 'Expired';
    const h = Math.floor(diff / 3600000);
    if (h < 24) return `Expires in ${h}h`;
    return `Expires in ${Math.floor(h / 24)}d`;
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <motion.div
        className="relative glass rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-700/40">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
            <Link size={15} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink-100">Share File</p>
            <p className="text-xs text-ink-500 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-ink-500 hover:text-ink-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Create new link */}
          <div>
            <p className="text-xs font-semibold text-ink-400 uppercase tracking-widest mb-3">Create share link</p>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-ink-800/60 rounded-lg p-0.5 flex-1">
                {EXPIRY_OPTIONS.map(opt => (
                  <button
                    key={opt.hours}
                    onClick={() => setExpiry(opt.hours)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
                      expiry === opt.hours ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={createLink}
              disabled={creating}
              className="mt-3 w-full btn-primary py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Plus size={14} />
              {creating ? 'Creating…' : 'Generate Link'}
            </button>
          </div>

          {/* Existing links */}
          <div>
            <p className="text-xs font-semibold text-ink-400 uppercase tracking-widest mb-3">
              Active links {shares.length > 0 && <span className="text-ink-500">({shares.length})</span>}
            </p>

            {loading ? (
              <p className="text-ink-600 text-xs text-center py-4">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-ink-700 text-xs text-center py-4">No active share links</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {shares.map(sh => (
                  <div key={sh.token} className="flex items-center gap-2 bg-ink-800/40 rounded-xl px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-ink-300 font-mono truncate">{`${baseUrl}/share/${sh.token}`}</p>
                      <p className="text-[10px] text-ink-600 mt-0.5 flex items-center gap-1">
                        <Clock size={9} /> {formatExpiry(sh.expires_at)}
                      </p>
                    </div>
                    <button
                      onClick={() => copyLink(sh.token)}
                      className="p-1.5 rounded-lg text-ink-400 hover:text-accent transition-colors shrink-0"
                      title="Copy link"
                    >
                      {copied === sh.token ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                    </button>
                    <button
                      onClick={() => revokeLink(sh.token)}
                      className="p-1.5 rounded-lg text-ink-500 hover:text-red-400 transition-colors shrink-0"
                      title="Revoke link"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
