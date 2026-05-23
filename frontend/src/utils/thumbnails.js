/**
 * Server-side persistent thumbnails.
 * Backend generates once, caches forever in folders.json + Telegram backup.
 * Frontend uses a simple <img> tag — browser handles HTTP caching.
 */

export function getThumbnailUrl(fileId) {
  const base = import.meta.env.VITE_API_URL || '';
  const token = localStorage.getItem('airnotes_token') || '';
  return `${base}/api/files/${encodeURIComponent(fileId)}/thumbnail?token=${encodeURIComponent(token)}`;
}

// Only show thumbnail for types the backend can generate covers for
export function hasThumbnail(fileType) {
  return fileType === 'pdf' || fileType === 'epub' || fileType === 'video';
}

// Legacy exports — no-ops
export async function generatePdfThumbnail() { return null; }
export async function generateThumbnailsBatch() { return {}; }
