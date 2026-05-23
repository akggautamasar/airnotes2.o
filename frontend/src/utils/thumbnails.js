/**
 * Server-side persistent thumbnails.
 * Backend generates once, caches forever in folders.json + Telegram backup.
 */

function getBase() {
  // VITE_API_URL is already like https://xxx.onrender.com/api
  // so we just append /files/... directly
  return import.meta.env.VITE_API_URL || '/api';
}

function getToken() {
  return localStorage.getItem('airnotes_token') || '';
}

export function getThumbnailUrl(fileId) {
  const token = getToken();
  const base = getBase();
  return `${base}/files/${encodeURIComponent(fileId)}/thumbnail${token ? '?token=' + encodeURIComponent(token) : ''}`;
}

export function hasThumbnail(fileType) {
  return fileType === 'pdf' || fileType === 'epub' || fileType === 'video';
}

// Legacy no-ops
export async function generatePdfThumbnail() { return null; }
export async function generateThumbnailsBatch() { return {}; }
