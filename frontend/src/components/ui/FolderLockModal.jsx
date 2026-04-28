import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, Unlock, Eye, EyeOff, X, ShieldCheck } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../utils/api';

async function sha256(str) {
  const buf  = new TextEncoder().encode(str + '_airnotes_v2_salt');
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export default function FolderLockModal({ folder, mode, onClose, onSuccess }) {
  // mode: 'lock' | 'unlock' | 'enter'
  const { actions } = useApp();
  const [password, setPassword]   = useState('');
  const [confirm,  setConfirm]    = useState('');
  const [showPw,   setShowPw]     = useState(false);
  const [error,    setError]      = useState('');
  const [loading,  setLoading]    = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setLoading(true);

    try {
      if (mode === 'lock') {
        if (password.length < 4) { setError('Password must be at least 4 characters'); setLoading(false); return; }
        if (password !== confirm)  { setError('Passwords do not match'); setLoading(false); return; }
        const hash = await sha256(password);
        await api.updateFolder(folder.id, { locked: true, password_hash: hash });
        actions.updateFolder({ id: folder.id, locked: true, passwordHash: hash });
        onSuccess?.();
        onClose();

      } else if (mode === 'unlock' || mode === 'enter') {
        const hash = await sha256(password);
        const res  = await api.verifyFolderPassword(folder.id, hash);
        if (res.valid) {
          if (mode === 'unlock') {
            await api.updateFolder(folder.id, { locked: false, password_hash: null });
            actions.updateFolder({ id: folder.id, locked: false, passwordHash: null });
          } else {
            actions.unlockFolder(folder.id);
          }
          onSuccess?.();
          onClose();
        } else {
          setError('Incorrect password');
        }
      }
    } catch (err) {
      if (err.message?.includes('403') || err.message?.toLowerCase().includes('invalid')) {
        setError('Incorrect password');
      } else {
        setError(err.message || 'Something went wrong');
      }
    }
    setLoading(false);
  }

  const config = {
    lock:   { icon: Lock,        title: 'Lock folder',         sub: `Set a password for "${folder.name}"`,   btn: 'Lock folder',   color: 'text-amber-400' },
    unlock: { icon: Unlock,      title: 'Remove lock',         sub: `Verify password to unlock "${folder.name}"`, btn: 'Remove lock', color: 'text-green-400' },
    enter:  { icon: ShieldCheck, title: 'Folder is locked',    sub: `Enter the password for "${folder.name}"`, btn: 'Unlock',       color: 'text-accent' },
  }[mode];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={e => e.target === e.currentTarget && onClose()}
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0, y: 16 }}
          animate={{ scale: 1,    opacity: 1, y: 0  }}
          exit   ={{ scale: 0.92, opacity: 0, y: 16 }}
          transition={{ duration: 0.22, ease: [0.22,1,0.36,1] }}
          className="glass rounded-2xl p-6 w-full max-w-sm shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl bg-ink-800 flex items-center justify-center ${config.color}`}>
                <config.icon size={18} />
              </div>
              <div>
                <h3 className="font-semibold text-ink-100 text-sm">{config.title}</h3>
                <p className="text-ink-500 text-xs mt-0.5">{config.sub}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-ink-600 hover:text-ink-300 p-1 -mt-1 -mr-1">
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Password */}
            <div className="relative">
              <input
                ref={inputRef}
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setError(''); }}
                placeholder="Password"
                className="input-base w-full pr-9"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-300"
              >
                {showPw ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>

            {/* Confirm (only for locking) */}
            {mode === 'lock' && (
              <input
                type={showPw ? 'text' : 'password'}
                value={confirm}
                onChange={e => { setConfirm(e.target.value); setError(''); }}
                placeholder="Confirm password"
                className="input-base w-full"
                autoComplete="new-password"
              />
            )}

            {/* Error */}
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
              >
                {error}
              </motion.p>
            )}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2.5 rounded-xl bg-ink-800 hover:bg-ink-700 text-ink-300 text-sm transition-colors">
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !password || (mode === 'lock' && !confirm)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50
                  ${mode === 'lock' ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400' :
                    mode === 'unlock' ? 'bg-green-500/20 hover:bg-green-500/30 text-green-400' :
                    'btn-primary'}`}
              >
                {loading
                  ? <><span className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" /> Checking…</>
                  : config.btn
                }
              </button>
            </div>
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
