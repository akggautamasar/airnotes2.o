import React, { useState } from 'react';
import { Bookmark, Highlighter, Trash2 } from 'lucide-react';
import { cleanFileName } from '../../utils/format';

export default function AnnotationSidebar({ highlights, bookmarks, currentPage, onGoTo, onDeleteHighlight, readerMode }) {
  const [tab, setTab] = useState('highlights');

  const border = readerMode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.1)';
  const bg = readerMode === 'dark' ? '#0a0806' : readerMode === 'sepia' ? '#e8e2d8' : '#e8e8e8';
  const text = readerMode === 'dark' ? '#e8ddd0' : readerMode === 'sepia' ? '#5c4a32' : '#1a1a1a';

  return (
    <div className="w-56 md:w-64 flex-shrink-0 flex flex-col border-l" style={{ background: bg, borderColor: border, color: text }}>
      {/* Tabs */}
      <div className="flex border-b" style={{ borderColor: border }}>
        {[
          { key: 'highlights', icon: Highlighter, label: 'Highlights', count: highlights.length },
          { key: 'bookmarks',  icon: Bookmark,    label: 'Bookmarks',  count: bookmarks.length },
        ].map(({ key, icon: Icon, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex-1 flex items-center justify-center gap-1 py-2.5 text-xs font-medium transition-all"
            style={{
              opacity: tab === key ? 1 : 0.4,
              borderBottom: tab === key ? `2px solid ${readerMode === 'sepia' ? '#7d6344' : '#967852'}` : '2px solid transparent',
            }}
          >
            <Icon size={12} />
            {label}
            {count > 0 && <span className="text-[10px] opacity-60">({count})</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {tab === 'highlights' && (
          highlights.length === 0 ? (
            <div className="text-center py-8 opacity-30">
              <Highlighter size={24} className="mx-auto mb-2" />
              <p className="text-xs">No highlights yet</p>
              <p className="text-[10px] mt-1">Select text while in highlight mode</p>
            </div>
          ) : (
            highlights.map(h => (
              <div
                key={h.id}
                className={`mb-2 p-2.5 rounded-xl cursor-pointer transition-all highlight-${h.color}
                            ${h.page === currentPage ? 'ring-1 ring-current ring-opacity-30' : 'opacity-70 hover:opacity-100'}`}
                onClick={() => onGoTo(h.page)}
                style={{ color: text }}
              >
                <p className="text-xs italic leading-relaxed line-clamp-3">"{h.text}"</p>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[10px] opacity-50">Page {h.page}</span>
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteHighlight(h.id); }}
                    className="opacity-30 hover:opacity-80 transition-opacity"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            ))
          )
        )}

        {tab === 'bookmarks' && (
          bookmarks.length === 0 ? (
            <div className="text-center py-8 opacity-30">
              <Bookmark size={24} className="mx-auto mb-2" />
              <p className="text-xs">No bookmarks yet</p>
              <p className="text-[10px] mt-1">Click the bookmark icon on any page</p>
            </div>
          ) : (
            bookmarks.map(b => (
              <div
                key={b.id}
                className="mb-1.5 p-2.5 rounded-xl cursor-pointer hover:bg-black/10 transition-all flex items-center gap-2"
                onClick={() => onGoTo(b.page)}
              >
                <Bookmark size={13} className="text-amber-400 fill-amber-400 flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium">{b.label || `Page ${b.page}`}</p>
                  <p className="text-[10px] opacity-40">Page {b.page}</p>
                </div>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );
}
