/**
 * Server-side persistent thumbnails with request throttling.
 * Max 2 concurrent thumbnail requests to avoid hammering the server.
 * Each thumbnail is cached by the browser after first load (1 year cache header).
 */

function getBase() {
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

// ── Global throttle queue ─────────────────────────────────────────────────────
// Limits concurrent thumbnail fetches to 2 so we don't hammer the backend
const _queue = [];
let _active = 0;
const MAX_CONCURRENT = 2;

function _next() {
  while (_active < MAX_CONCURRENT && _queue.length > 0) {
    const { resolve } = _queue.shift();
    _active++;
    resolve();
  }
}

export function acquireThumbSlot() {
  return new Promise(resolve => {
    _queue.push({ resolve });
    _next();
  });
}

export function releaseThumbSlot() {
  _active = Math.max(0, _active - 1);
  _next();
}

// Legacy no-ops
export async function generatePdfThumbnail() { return null; }
export async function generateThumbnailsBatch() { return {}; }
