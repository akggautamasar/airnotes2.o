// IndexedDB-backed stores for progress, bookmarks, and recently-opened files
// Falls back gracefully if IDB is unavailable

const DB_NAME = 'airnotes_v2';
const DB_VER  = 2;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('progress'))  db.createObjectStore('progress',  { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains('bookmarks')) db.createObjectStore('bookmarks', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('recent'))    db.createObjectStore('recent',    { keyPath: 'fileId' });
    };
    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = e => reject(e.target.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    if (req?.onsuccess !== undefined) {
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    } else {
      t.oncomplete = () => resolve();
      t.onerror    = e => reject(e.target.error);
    }
  }));
}

// ── Progress store ────────────────────────────────────────────────────────────
export const progressStore = {
  save: async (fileId, currentPage, totalPages = 0, extra = {}) => {
    const pct = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;
    await tx('progress', 'readwrite', s => s.put({ fileId, currentPage, totalPages, percent: pct, updatedAt: Date.now(), ...extra }));
  },
  get: async (fileId) => {
    try { return await tx('progress', 'readonly', s => s.get(fileId)); } catch { return null; }
  },
  getAll: async () => {
    return new Promise((resolve, reject) => {
      openDB().then(db => {
        const t = db.transaction('progress', 'readonly');
        const req = t.objectStore('progress').getAll();
        req.onsuccess = e => resolve(e.target.result || []);
        req.onerror   = e => reject(e.target.error);
      }).catch(() => resolve([]));
    });
  },
};

// ── Bookmark store ────────────────────────────────────────────────────────────
export const bookmarkStore = {
  add: async (fileId, page, label = '') => {
    const key = `${fileId}:${page}`;
    await tx('bookmarks', 'readwrite', s => s.put({ key, fileId, page, label, createdAt: Date.now() }));
  },
  remove: async (fileId, page) => {
    await tx('bookmarks', 'readwrite', s => s.delete(`${fileId}:${page}`));
  },
  isBookmarked: async (fileId, page) => {
    try {
      const r = await tx('bookmarks', 'readonly', s => s.get(`${fileId}:${page}`));
      return !!r;
    } catch { return false; }
  },
  getAll: async (fileId) => {
    return new Promise((resolve, reject) => {
      openDB().then(db => {
        const t = db.transaction('bookmarks', 'readonly');
        const req = t.objectStore('bookmarks').getAll();
        req.onsuccess = e => {
          const all = e.target.result || [];
          resolve(fileId ? all.filter(b => b.fileId === fileId) : all);
        };
        req.onerror = e => reject(e.target.error);
      }).catch(() => resolve([]));
    });
  },
};

// ── Recent store ──────────────────────────────────────────────────────────────
export const recentStore = {
  add: async (fileId, fileName) => {
    await tx('recent', 'readwrite', s => s.put({ fileId, fileName, openedAt: Date.now() }));
  },
  getAll: async () => {
    return new Promise((resolve, reject) => {
      openDB().then(db => {
        const t = db.transaction('recent', 'readonly');
        const req = t.objectStore('recent').getAll();
        req.onsuccess = e => {
          const all = (e.target.result || []).sort((a, b) => b.openedAt - a.openedAt);
          resolve(all.slice(0, 20));
        };
        req.onerror = e => reject(e.target.error);
      }).catch(() => resolve([]));
    });
  },
};
