import React, { createContext, useContext, useReducer, useCallback } from 'react';

const Ctx = createContext(null);

const initialState = {
  isAuthenticated: !!localStorage.getItem('airnotes_token'),
  token: localStorage.getItem('airnotes_token') || '',
  files: [],
  filesLoading: false,
  filesError: null,
  viewMode: localStorage.getItem('viewMode') || 'grid',
  activeSection: 'library',
  searchQuery: '',
  folders: [],
  activeFolderId: null,
  fileAssignments: {},
  openFile: null,
  readerMode: localStorage.getItem('readerMode') || 'dark',
  appTheme: localStorage.getItem('appTheme') || 'dark',
  recentFiles: [],
  progress: {},
  unlockedFolders: [],
  channels: [],
  activeChannelId: null,
  // New feature state
  favorites: [],           // array of file IDs
  fileTags: {},            // { fileId: ['tag1', 'tag2'] }
  allTags: [],             // all unique tag names
  selectedFiles: new Set(),// bulk selection
  sortBy: localStorage.getItem('sortBy') || 'date',
  sortOrder: localStorage.getItem('sortOrder') || 'desc',
  trashCount: 0,
  activeTag: null,         // currently filtered tag
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_AUTH':    return { ...state, isAuthenticated: action.payload };
    case 'LOGOUT':      return { ...initialState, isAuthenticated: false };
    case 'SET_FILES':   return { ...state, files: action.payload, filesLoading: false, filesError: null };
    case 'SET_FILES_LOADING': return { ...state, filesLoading: action.payload };
    case 'SET_FILES_ERROR':   return { ...state, filesError: action.payload, filesLoading: false };
    case 'SET_VIEW_MODE':
      localStorage.setItem('viewMode', action.payload);
      return { ...state, viewMode: action.payload };
    case 'SET_ACTIVE_SECTION': return { ...state, activeSection: action.payload, activeFolderId: null, activeTag: null };
    case 'SET_FOLDERS':        return { ...state, folders: action.payload };
    case 'ADD_FOLDER':         return { ...state, folders: [...state.folders, action.payload] };
    case 'REMOVE_FOLDER':      return { ...state, folders: state.folders.filter(f => f.id !== action.payload) };
    case 'UPDATE_FOLDER':      return { ...state, folders: state.folders.map(f => f.id === action.payload.id ? { ...f, ...action.payload } : f) };
    case 'SET_ACTIVE_FOLDER':  return { ...state, activeFolderId: action.payload, activeSection: 'folder', activeTag: null };
    case 'ASSIGN_FILE':        return { ...state, fileAssignments: { ...state.fileAssignments, [action.fileId]: action.folderId } };
    case 'UNASSIGN_FILE': {
      const a = { ...state.fileAssignments }; delete a[action.fileId]; return { ...state, fileAssignments: a };
    }
    case 'SET_FILE_ASSIGNMENTS': return { ...state, fileAssignments: action.payload };
    case 'OPEN_FILE':   return { ...state, openFile: action.payload };
    case 'CLOSE_FILE':  return { ...state, openFile: null };
    case 'SET_READER_MODE':
      localStorage.setItem('readerMode', action.payload);
      return { ...state, readerMode: action.payload };
    case 'SET_APP_THEME':
      localStorage.setItem('appTheme', action.payload);
      return { ...state, appTheme: action.payload };
    case 'SET_RECENT': return { ...state, recentFiles: action.payload };
    case 'ADD_RECENT': {
      const updated = [action.payload, ...state.recentFiles.filter(r => r.fileId !== action.payload.fileId)].slice(0, 20);
      return { ...state, recentFiles: updated };
    }
    case 'SAVE_PROGRESS': return { ...state, progress: { ...state.progress, [action.fileId]: action.data } };
    case 'UNLOCK_FOLDER': return { ...state, unlockedFolders: [...state.unlockedFolders.filter(id => id !== action.id), action.id] };
    case 'SET_CHANNELS': return { ...state, channels: action.payload };
    case 'ADD_CHANNEL': return { ...state, channels: [...state.channels.filter(c => c.str_id !== action.payload.str_id), action.payload] };
    case 'REMOVE_CHANNEL': return { ...state, channels: state.channels.filter(c => c.str_id !== action.payload) };
    case 'SET_ACTIVE_CHANNEL': return { ...state, activeChannelId: action.payload, activeSection: 'channel', activeFolderId: null, activeTag: null };

    // Favorites
    case 'SET_FAVORITES': return { ...state, favorites: action.payload };
    case 'TOGGLE_FAVORITE': {
      const isFav = state.favorites.includes(action.fileId);
      return { ...state, favorites: isFav ? state.favorites.filter(id => id !== action.fileId) : [...state.favorites, action.fileId] };
    }

    // Tags
    case 'SET_FILE_TAGS': return { ...state, fileTags: { ...state.fileTags, [action.fileId]: action.tags } };
    case 'SET_ALL_TAGS':  return { ...state, allTags: action.payload };
    case 'SET_ACTIVE_TAG': return { ...state, activeTag: action.payload, activeSection: 'tag', activeFolderId: null };

    // Bulk selection
    case 'TOGGLE_SELECT': {
      const s = new Set(state.selectedFiles);
      s.has(action.fileId) ? s.delete(action.fileId) : s.add(action.fileId);
      return { ...state, selectedFiles: s };
    }
    case 'SELECT_ALL': return { ...state, selectedFiles: new Set(action.fileIds) };
    case 'CLEAR_SELECTION': return { ...state, selectedFiles: new Set() };

    // Sort
    case 'SET_SORT': {
      localStorage.setItem('sortBy', action.sortBy);
      localStorage.setItem('sortOrder', action.sortOrder);
      return { ...state, sortBy: action.sortBy, sortOrder: action.sortOrder };
    }

    // Trash
    case 'SET_TRASH_COUNT': return { ...state, trashCount: action.payload };

    default: return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions = {
    setAuth:            useCallback((v) => dispatch({ type: 'SET_AUTH', payload: v }), []),
    logout:             useCallback(() => { localStorage.removeItem('airnotes_token'); dispatch({ type: 'LOGOUT' }); }, []),
    setFiles:           useCallback((f) => dispatch({ type: 'SET_FILES', payload: Array.isArray(f) ? f : [] }), []),
    setFilesLoading:    useCallback((v) => dispatch({ type: 'SET_FILES_LOADING', payload: v }), []),
    setFilesError:      useCallback((e) => dispatch({ type: 'SET_FILES_ERROR', payload: e }), []),
    setViewMode:        useCallback((v) => dispatch({ type: 'SET_VIEW_MODE', payload: v }), []),
    setActiveSection:   useCallback((s) => dispatch({ type: 'SET_ACTIVE_SECTION', payload: s }), []),
    setFolders:         useCallback((f) => dispatch({ type: 'SET_FOLDERS', payload: f }), []),
    addFolder:          useCallback((f) => dispatch({ type: 'ADD_FOLDER', payload: f }), []),
    removeFolder:       useCallback((id) => dispatch({ type: 'REMOVE_FOLDER', payload: id }), []),
    updateFolder:       useCallback((f) => dispatch({ type: 'UPDATE_FOLDER', payload: f }), []),
    setActiveFolder:    useCallback((id) => dispatch({ type: 'SET_ACTIVE_FOLDER', payload: id }), []),
    assignFile:         useCallback((fileId, folderId) => dispatch({ type: 'ASSIGN_FILE', fileId, folderId }), []),
    unassignFile:       useCallback((fileId) => dispatch({ type: 'UNASSIGN_FILE', fileId }), []),
    setFileAssignments: useCallback((a) => dispatch({ type: 'SET_FILE_ASSIGNMENTS', payload: a }), []),
    openFile:           useCallback((f) => dispatch({ type: 'OPEN_FILE', payload: f }), []),
    closeFile:          useCallback(() => dispatch({ type: 'CLOSE_FILE' }), []),
    setReaderMode:      useCallback((m) => dispatch({ type: 'SET_READER_MODE', payload: m }), []),
    setAppTheme:        useCallback((t) => dispatch({ type: 'SET_APP_THEME', payload: t }), []),
    setRecent:          useCallback((r) => dispatch({ type: 'SET_RECENT', payload: r }), []),
    addRecent:          useCallback((r) => dispatch({ type: 'ADD_RECENT', payload: r }), []),
    saveProgress:       useCallback((fileId, data) => dispatch({ type: 'SAVE_PROGRESS', fileId, data }), []),
    unlockFolder:       useCallback((id) => dispatch({ type: 'UNLOCK_FOLDER', id }), []),
    setChannels:        useCallback((c) => dispatch({ type: 'SET_CHANNELS', payload: c }), []),
    addChannel:         useCallback((c) => dispatch({ type: 'ADD_CHANNEL', payload: c }), []),
    removeChannel:      useCallback((id) => dispatch({ type: 'REMOVE_CHANNEL', payload: id }), []),
    setActiveChannel:   useCallback((id) => dispatch({ type: 'SET_ACTIVE_CHANNEL', payload: id }), []),

    // Favorites
    setFavorites:       useCallback((f) => dispatch({ type: 'SET_FAVORITES', payload: f }), []),
    toggleFavorite:     useCallback((fileId) => dispatch({ type: 'TOGGLE_FAVORITE', fileId }), []),

    // Tags
    setFileTags:        useCallback((fileId, tags) => dispatch({ type: 'SET_FILE_TAGS', fileId, tags }), []),
    setAllTags:         useCallback((t) => dispatch({ type: 'SET_ALL_TAGS', payload: t }), []),
    setActiveTag:       useCallback((tag) => dispatch({ type: 'SET_ACTIVE_TAG', payload: tag }), []),

    // Bulk
    toggleSelect:       useCallback((fileId) => dispatch({ type: 'TOGGLE_SELECT', fileId }), []),
    selectAll:          useCallback((fileIds) => dispatch({ type: 'SELECT_ALL', fileIds }), []),
    clearSelection:     useCallback(() => dispatch({ type: 'CLEAR_SELECTION' }), []),

    // Sort
    setSort:            useCallback((sortBy, sortOrder) => dispatch({ type: 'SET_SORT', sortBy, sortOrder }), []),

    // Trash
    setTrashCount:      useCallback((n) => dispatch({ type: 'SET_TRASH_COUNT', payload: n }), []),
  };

  return <Ctx.Provider value={{ state, actions }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
