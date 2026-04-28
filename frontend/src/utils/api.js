const BASE_URL = import.meta.env.VITE_API_URL || '/api';

function getToken() { return localStorage.getItem('airnotes_token'); }

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (res.status === 401) { localStorage.removeItem('airnotes_token'); window.location.reload(); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  login:  (pw) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) }),
  verify: () => request('/auth/verify'),

  getFiles: (type = null, folderId = null) => {
    const p = new URLSearchParams();
    if (type)     p.set('type', type);
    if (folderId) p.set('folder_id', folderId);
    return request(`/files${p.toString() ? '?' + p : ''}`);
  },
  search:     (q, type = null) => request(`/search?q=${encodeURIComponent(q)}${type ? '&type=' + type : ''}`),
  refresh:    () => request('/files/refresh', { method: 'POST' }),
  deleteFile: (id) => request(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  renameFile: (id, name) => request(`/files/${encodeURIComponent(id)}/rename`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  copyFile:   (id) => request(`/files/${encodeURIComponent(id)}/copy`, { method: 'POST' }),
  moveFile:   (id, folderId) => request(`/files/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ folder_id: folderId }) }),

  getFolders:           () => request('/folders'),
  createFolder:         (name) => request('/folders', { method: 'POST', body: JSON.stringify({ name }) }),
  updateFolder:         (id, data) => request(`/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteFolder:         (id) => request(`/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getFolderFiles:       (id) => request(`/folders/${encodeURIComponent(id)}/files`),
  verifyFolderPassword: (id, hash) => request(`/folders/${encodeURIComponent(id)}/verify-password`, { method: 'POST', body: JSON.stringify({ password_hash: hash }) }),
  getFileAssignments:   () => request('/assignments'),

  getStreamUrl: (fileId) => `${BASE_URL}/files/${encodeURIComponent(fileId)}/stream`,
  getStreamUrlWithToken: (fileId) => {
    const t = getToken();
    return `${BASE_URL}/files/${encodeURIComponent(fileId)}/stream${t ? '?token=' + encodeURIComponent(t) : ''}`;
  },
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
};
