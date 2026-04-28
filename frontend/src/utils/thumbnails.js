let _pdfjs = null;
async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('pdfjs-dist');
  _pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url
  ).href;
  return _pdfjs;
}

const _cache = new Map();

export async function generatePdfThumbnail(fileId, streamUrl, authHeaders = {}) {
  if (_cache.has(fileId)) return _cache.get(fileId);
  try {
    const lib  = await getPdfJs();
    const task = lib.getDocument({ url: streamUrl, httpHeaders: authHeaders });
    const pdf  = await task.promise;
    const page = await pdf.getPage(1);
    const DPR  = Math.min(window.devicePixelRatio || 1, 2);

    // Render at 2x DPR for crispness, keep width ~200px equivalent
    const baseVp = page.getViewport({ scale: 1 });
    const scale  = (200 / baseVp.width) * DPR;
    const vp     = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    _cache.set(fileId, dataUrl);
    pdf.destroy();
    return dataUrl;
  } catch (e) {
    console.warn('Thumb failed:', fileId, e?.message);
    return null;
  }
}

export async function generateThumbnailsBatch(files, getStreamUrl, authHeaders, onProgress) {
  const results = {};
  const CONCURRENCY = 3;
  const pdfs = files.filter(f => f.type === 'pdf');
  let done = 0;
  for (let i = 0; i < pdfs.length; i += CONCURRENCY) {
    const batch = pdfs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async f => {
      const url = getStreamUrl(f.id);
      const thumb = await generatePdfThumbnail(f.id, url, authHeaders);
      if (thumb) results[f.id] = thumb;
      done++;
      onProgress?.(done, pdfs.length);
    }));
  }
  return results;
}
