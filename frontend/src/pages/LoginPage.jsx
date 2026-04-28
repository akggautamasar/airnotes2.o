import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useApp } from '../store/AppContext';
import { api } from '../utils/api';

export default function LoginPage() {
  const { actions } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await api.login(password);
      localStorage.setItem('airnotes_token', res.token);
      actions.setAuth(true);
    } catch (err) {
      setError(err.message || 'Invalid password');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-ink-950 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-accent/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-[300px] h-[300px] bg-teal/5 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-sm"
      >
        {/* Logo block */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-ink-800 border border-ink-700/50 mb-5 shadow-2xl">
            <span className="text-3xl select-none">✦</span>
          </div>
          <h1 className="font-display text-3xl font-bold text-paper-50 mb-2 tracking-tight">AirNotes 2.0</h1>
          <p className="text-ink-400 text-sm">Your Telegram-powered PDF & EPUB library</p>
        </div>

        <form onSubmit={handleLogin} className="glass rounded-2xl p-7 shadow-2xl">
          <label className="block text-ink-300 text-xs font-semibold uppercase tracking-widest mb-2">
            Access Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoFocus
            className="input-base w-full mb-4 text-base"
          />

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-4 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2"
            >
              {error}
            </motion.div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="btn-primary w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Signing in…</>
              : 'Enter Library →'
            }
          </button>
        </form>

        <p className="text-center text-ink-600 text-xs mt-6">
          Files stored privately in your Telegram channel
        </p>
      </motion.div>
    </div>
  );
}
