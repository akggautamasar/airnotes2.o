import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Bookmark } from 'lucide-react';

const THUMB_SCALE = 0.18;

export default function ThumbnailSidebar({ pdfDoc, numPages, currentPage, onGoTo, bookmarks, readerMode }) {
  const [thumbs, setThumbs] = useState({});
  const containerRef = useRef(null);
  const observerRef = useRef(null);
  const renderQueueRef = useRef([]);
  const renderingRef = useRef(false);

  const bookmarkedPages = new Set(bookmarks.map(b => b.page));

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          const pageNum = parseInt(entry.target.dataset.page);
          if (entry.isIntersecting && !thumbs[pageNum]) enqueue(pageNum);
        });
      },
      { root: containerRef.current, rootMargin: '200px', threshold: 0 }
    );
    return () => observerRef.current?.disconnect();
  }, [thumbs]);

  function enqueue(pageNum) {
    if (!renderQueueRef.current.includes(pageNum)) {
      renderQueueRef.current.push(pageNum);
      processQueue();
    }
  }

  const processQueue = useCallback(async () => {
    if (renderingRef.current || renderQueueRef.current.length === 0) return;
    renderingRef.current = true;
    const pageNum = renderQueueRef.current.shift();
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: THUMB_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      setThumbs(prev => ({ ...prev, [pageNum]: canvas.toDataURL('image/jpeg', 0.7) }));
    } catch (e) {
      if (e.name !== 'RenderingCancelledException') console.warn('Thumb error:', e);
    } finally {
      renderingRef.current = false;
      setTimeout(processQueue, 20);
    }
  }, [pdfDoc]);

  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-page="${currentPage}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentPage]);

  const bg = readerMode === 'dark' ? '#0a0806' : readerMode === 'sepia' ? '#e8e2d8' : '#e0e0e0';
  const border = readerMode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.1)';
  const activeBorder = readerMode === 'sepia' ? '#7d6344' : '#967852';
  const inactiveBg = readerMode === 'dark' ? '#1c1610' : readerMode === 'sepia' ? '#d8d0c2' : '#c8c8c8';

  return (
    <div ref={containerRef}
      className="w-[120px] md:w-36 flex-shrink-0 overflow-y-auto border-r flex flex-col gap-2 py-3 px-2"
      style={{ background: bg, borderColor: border }}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => {
        const isActive = pageNum === currentPage;
        return (
          <div
            key={pageNum}
            ref={el => { if (el && observerRef.current) observerRef.current.observe(el); }}
            data-page={pageNum}
            onClick={() => onGoTo(pageNum)}
            className="relative cursor-pointer rounded-lg overflow-hidden flex-shrink-0 transition-all"
            style={{ border: `2px solid ${isActive ? activeBorder : 'transparent'}` }}
          >
            {thumbs[pageNum] ? (
              <img src={thumbs[pageNum]} alt={`Page ${pageNum}`} className="w-full block" />
            ) : (
              <div className="w-full aspect-[3/4] flex items-center justify-center text-xs opacity-20"
                style={{ background: inactiveBg }}>{pageNum}</div>
            )}
            {bookmarkedPages.has(pageNum) && (
              <div className="absolute top-1 right-1">
                <Bookmark size={10} className="text-amber-400 fill-amber-400" />
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 text-center text-[9px] py-0.5 font-mono"
              style={{ background: isActive ? `${activeBorder}cc` : 'rgba(0,0,0,0.4)', color: '#fff' }}>
              {pageNum}
            </div>
          </div>
        );
      })}
    </div>
  );
}
