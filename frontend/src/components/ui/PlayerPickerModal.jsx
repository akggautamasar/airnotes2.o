import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Zap, Monitor, ExternalLink, Download, Music, Image } from 'lucide-react';
import { useApp } from '../../store/AppContext';

export default function PlayerPickerModal({ file, streamUrl, onClose }) {
  const { actions } = useApp();

  if (!file) return null;

  const isVideo = file.type === 'video';
  const isPdf   = file.type === 'pdf';
  const isEpub  = file.type === 'epub';
  const isAudio = file.type === 'audio';
  const isImage = file.type === 'image';

  const openFastPlayer = () => {
    const backendBase = import.meta.env.VITE_API_URL?.replace(/\/api$/, '') || '';
    const playerUrl = `${backendBase}/player?url=${encodeURIComponent(streamUrl)}&name=${encodeURIComponent(file.name)}&id=${encodeURIComponent(file.id)}`;
    window.open(playerUrl, '_blank');
    onClose();
  };

  const openBuiltIn = () => {
    actions.openFile(file);
    onClose();
  };

  const openDirect = () => {
    window.open(streamUrl, '_blank');
    onClose();
  };

  const options = [];

  if (isVideo) {
    options.push({
      icon: <Zap size={22} className="text-yellow-400" />,
      label: 'Fast Player',
      desc: 'Optimized player — resume, speed control, PiP',
      action: openFastPlayer,
      highlight: true,
    });
    options.push({
      icon: <Monitor size={22} className="text-accent" />,
      label: 'Built-in Player',
      desc: 'Play inside the app with transcoding support',
      action: openBuiltIn,
    });
  }

  if (isPdf || isEpub) {
    options.push({
      icon: <Monitor size={22} className="text-accent" />,
      label: 'Open Reader',
      desc: isPdf ? 'PDF reader with annotations' : 'EPUB reader',
      action: openBuiltIn,
      highlight: true,
    });
  }

  if (isAudio) {
    options.push({
      icon: <Music size={22} className="text-purple-400" />,
      label: 'Play Audio',
      desc: 'Built-in audio player',
      action: openBuiltIn,
      highlight: true,
    });
  }

  if (isImage) {
    options.push({
      icon: <Image size={22} className="text-green-400" />,
      label: 'View Image',
      desc: 'Full-size image viewer',
      action: openBuiltIn,
      highlight: true,
    });
  }

  options.push({
    icon: <ExternalLink size={22} className="text-ink-400" />,
    label: 'Open in Browser',
    desc: 'Stream directly in a new tab',
    action: openDirect,
  });

  options.push({
    icon: <Download size={22} className="text-ink-400" />,
    label: 'Download',
    desc: 'Save file to your device',
    action: () => {
      const a = document.createElement('a');
      a.href = streamUrl;
      a.download = file.name;
      a.click();
      onClose();
    },
  });

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
          transition={{ type: 'spring', damping: 24, stiffness: 300 }}
          className="w-full max-w-sm bg-ink-900 border border-ink-700/50 rounded-2xl overflow-hidden shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between p-4 border-b border-ink-800/50">
            <div className="flex-1 min-w-0 pr-3">
              <p className="text-xs text-ink-500 mb-0.5">Open with</p>
              <p className="text-sm font-semibold text-ink-100 truncate">{file.name}</p>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors shrink-0">
              <X size={15} />
            </button>
          </div>

          {/* Options */}
          <div className="p-2">
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={opt.action}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all text-left
                  ${opt.highlight
                    ? 'bg-accent/10 border border-accent/20 hover:bg-accent/15 mb-1'
                    : 'hover:bg-ink-800/60'
                  }`}
              >
                <div className="shrink-0">{opt.icon}</div>
                <div>
                  <p className={`text-sm font-semibold ${opt.highlight ? 'text-ink-100' : 'text-ink-300'}`}>{opt.label}</p>
                  <p className="text-xs text-ink-500">{opt.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
