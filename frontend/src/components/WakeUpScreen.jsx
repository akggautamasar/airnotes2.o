import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

export default function WakeUpScreen({ waking }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen bg-ink-950 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-accent/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-[300px] h-[300px] bg-teal/5 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative text-center max-w-sm w-full"
      >
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-ink-800 border border-ink-700/50 mb-5 shadow-2xl">
          <span className="text-3xl select-none">✦</span>
        </div>

        <h1 className="font-display text-3xl font-bold text-paper-50 mb-2 tracking-tight">AirNotes 2.0</h1>

        {waking ? (
          <>
            <p className="text-ink-300 text-sm mb-1">Server is waking up…</p>
            <p className="text-ink-500 text-xs mb-5">Free-tier cold start takes about 30–60 seconds</p>

            <div className="glass rounded-xl px-5 py-4 mb-5 text-left">
              <div className="flex items-center justify-between mb-3">
                <span className="text-ink-400 text-xs">Starting server</span>
                <span className="text-ink-300 text-xs font-mono">{elapsed}s</span>
              </div>
              <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-accent/60 rounded-full"
                  animate={{ width: `${Math.min((elapsed / 60) * 100, 92)}%` }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                />
              </div>
              {elapsed >= 30 && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-ink-600 text-xs mt-3"
                >
                  Taking a bit longer than usual — please wait…
                </motion.p>
              )}
            </div>
          </>
        ) : (
          <p className="text-ink-400 text-sm mb-5">Connecting to server…</p>
        )}

        <div className="flex justify-center">
          <span className="w-5 h-5 border-2 border-ink-700 border-t-accent rounded-full animate-spin" />
        </div>
      </motion.div>
    </div>
  );
}
