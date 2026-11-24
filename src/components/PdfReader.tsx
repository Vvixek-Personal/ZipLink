import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  PasswordResponses,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Lock,
  Maximize2,
  Minimize2,
  ScanText,
  Search,
  ShieldCheck,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ShareFileEntry } from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import {
  classifyDocumentTextCoverage,
  classifyPdfPageText,
  extractPageTextFromItems,
  formatExtractedPages,
  parsePageRange,
  sanitizePdfExportBaseName,
  searchPdfPagesText,
  validateAndComputeRenderDimensions,
  type PdfPageTextKind,
} from '../shared/pdfUtils.ts';
import { PdfImageExportPanel } from './PdfImageExportPanel.tsx';
import { PdfOcrPanel, type OcrPageResult } from './PdfOcrPanel.tsx';

// Configure PDF.js worker using local Vite bundle asset (zero external CDN calls)
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReaderProps {
  shareId: string;
  file: ShareFileEntry;
  effectiveTheme: 'light' | 'dark';
}

type ReaderTab = 'document' | 'extracted' | 'images' | 'ocr';
type FitMode = 'custom' | 'fit-width' | 'fit-page';
type ExtractedScope = 'all' | 'current' | 'range';
type ExtractedSource = 'pdf-text' | 'ocr' | 'combined';

async function copyTextSafe(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function triggerDownloadText(text: string, filename: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function highlightTextLayerSpans(
  layerEl: HTMLElement,
  query: string,
  activePageMatchIndex: number | null,
) {
  const needle = query.trim().toLowerCase();
  const spans = Array.from(layerEl.querySelectorAll('span'));
  let runningHit = 0;

  for (const span of spans) {
    // Restore plain text first before applying highlights
    const raw = span.textContent ?? '';
    if (!needle || !raw) {
      if (span.querySelector('mark')) {
        span.textContent = raw;
      }
      continue;
    }

    const lower = raw.toLowerCase();
    if (!lower.includes(needle)) {
      if (span.querySelector('mark')) {
        span.textContent = raw;
      }
      continue;
    }

    const frag = document.createDocumentFragment();
    let cursor = 0;
    while (cursor < raw.length) {
      const idx = lower.indexOf(needle, cursor);
      if (idx === -1) {
        frag.appendChild(document.createTextNode(raw.slice(cursor)));
        break;
      }
      if (idx > cursor) {
        frag.appendChild(document.createTextNode(raw.slice(cursor, idx)));
      }
      const mark = document.createElement('mark');
      const isCurrentHit = activePageMatchIndex !== null && runningHit === activePageMatchIndex;
      mark.className = isCurrentHit
        ? 'pdf-search-hit pdf-search-hit-active'
        : 'pdf-search-hit';
      mark.textContent = raw.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      runningHit++;
      cursor = idx + needle.length;
    }
    span.textContent = '';
    span.appendChild(frag);
  }
}

export const PdfReader: React.FC<PdfReaderProps> = ({ shareId, file }) => {
  const [activeTab, setActiveTab] = useState<ReaderTab>('document');

  // Download & PDF document loading state
  const [downloadProgress, setDownloadProgress] = useState<{
    loaded: number;
    total: number;
  }>({ loaded: 0, total: file.sizeBytes });
  const [loadingPhase, setLoadingPhase] = useState<'fetching' | 'parsing' | 'ready' | 'password' | 'error'>(
    'fetching',
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');

  // Zoom & viewport sizing
  const [fitMode, setFitMode] = useState<FitMode>('fit-width');
  const [zoomScale, setZoomScale] = useState<number>(1.2);
  const [viewportWidth, setViewportWidth] = useState<number>(780);
  const [viewportHeight, setViewportHeight] = useState<number>(640);
  const [currentPageSizePt, setCurrentPageSizePt] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [pageRenderError, setPageRenderError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Per-page extracted text, scanned/text classification, and optional OCR results
  const [pagesText, setPagesText] = useState<Record<number, string>>({});
  const [pageKinds, setPageKinds] = useState<Record<number, PdfPageTextKind>>({});
  const [ocrResults, setOcrResults] = useState<Record<number, OcrPageResult>>({});

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIncludeOcr, setSearchIncludeOcr] = useState(true);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  // Extracted text export tab state
  const [extractedScope, setExtractedScope] = useState<ExtractedScope>('all');
  const [extractedRange, setExtractedRange] = useState('1');
  const [extractedSource, setExtractedSource] = useState<ExtractedSource>('combined');

  // Copy feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFeedbackMsg, setCopyFeedbackMsg] = useState<string | null>(null);

  const rawBytesRef = useRef<Uint8Array | null>(null);
  const activePdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const scrollStageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerInstanceRef = useRef<TextLayer | null>(null);
  const textScanCancelRef = useRef<boolean>(false);

  const triggerCopy = useCallback(async (key: string, text: string, label?: string) => {
    const ok = await copyTextSafe(text);
    if (ok) {
      setCopiedKey(key);
      if (label) setCopyFeedbackMsg(label);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
        setCopyFeedbackMsg(null);
      }, 2200);
    }
  }, []);

  const openPdfFromBytes = useCallback(async (bytes: Uint8Array, password?: string) => {
    textScanCancelRef.current = true;
    try {
      await activePdfDocRef.current?.cleanup();
    } catch {
      // ignore
    }
    try {
      await loadingTaskRef.current?.destroy();
    } catch {
      // ignore
    }
    activePdfDocRef.current = null;
    loadingTaskRef.current = null;
    setPdfDoc(null);

    setLoadingPhase('parsing');
    setLoadError(null);

    // Pass a copy because PDF.js transfers the ArrayBuffer to its worker
    const copy = bytes.slice();
    const task = getDocument({
      data: copy,
      password,
      enableXfa: false,
      disableFontFace: false,
    });
    loadingTaskRef.current = task;

    try {
      const doc = await task.promise;
      // Never retain password in state after successful open
      setPasswordInput('');
      setPasswordError(null);

      activePdfDocRef.current = doc;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);
      setPageInput('1');
      setExtractedRange(doc.numPages > 1 ? `1-${Math.min(5, doc.numPages)}` : '1');
      setPagesText({});
      setPageKinds({});
      setOcrResults({});
      setLoadingPhase('ready');
    } catch (err) {
      if (err instanceof PasswordException) {
        setLoadingPhase('password');
        if (err.code === PasswordResponses.INCORRECT_PASSWORD) {
          setPasswordError('Incorrect password. Please try again.');
        } else {
          setPasswordError(null);
        }
        return;
      }
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'This PDF appears to be malformed, corrupted, or uses an unsupported format.';
      setLoadError(`Unable to open PDF: ${message}`);
      setLoadingPhase('error');
    }
  }, []);

  // Fetch PDF file bytes via authorized ZipLink endpoint
  useEffect(() => {
    const controller = new AbortController();
    textScanCancelRef.current = true;
    rawBytesRef.current = null;
    setPdfDoc(null);
    setTotalPages(0);
    setCurrentPage(1);
    setPageInput('1');
    setPagesText({});
    setPageKinds({});
    setOcrResults({});
    setSearchQuery('');
    setPasswordInput('');
    setPasswordError(null);
    setLoadError(null);
    setActiveTab('document');
    setLoadingPhase('fetching');
    setDownloadProgress({ loaded: 0, total: file.sizeBytes });

    const fetchPdf = async () => {
      try {
        const res = await fetch(
          `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(`Server returned ${res.status} when loading PDF.`);
        }

        const contentLength = Number(res.headers.get('content-length') || file.sizeBytes || 0);
        let bytes: Uint8Array;

        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let loaded = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loaded += value.length;
              setDownloadProgress({ loaded, total: contentLength || loaded });
            }
          }
          bytes = new Uint8Array(loaded);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer());
          bytes = buf;
          setDownloadProgress({ loaded: buf.length, total: buf.length });
        }

        if (controller.signal.aborted) return;
        rawBytesRef.current = bytes;
        await openPdfFromBytes(bytes);
      } catch (err) {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to download PDF for viewing.');
        setLoadingPhase('error');
      }
    };

    void fetchPdf();

    return () => {
      controller.abort();
      textScanCancelRef.current = true;
      rawBytesRef.current = null;
      void activePdfDocRef.current?.cleanup().catch(() => undefined);
      void loadingTaskRef.current?.destroy().catch(() => undefined);
      activePdfDocRef.current = null;
      loadingTaskRef.current = null;
    };
  }, [shareId, file.id, file.sizeBytes, openPdfFromBytes]);

  // Measure container width/height for Fit Width & Fit Page modes
  useEffect(() => {
    const el = scrollStageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateSize = () => {
      setViewportWidth(Math.max(280, el.clientWidth - 32));
      setViewportHeight(Math.max(320, el.clientHeight - 32));
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loadingPhase, activeTab]);

  // Fullscreen listener
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Incremental, low-memory background text extraction & page-by-page classification
  useEffect(() => {
    if (!pdfDoc || totalPages <= 0) return;
    let cancelled = false;
    textScanCancelRef.current = false;

    const scanPagesText = async () => {
      // Inspect current page first, then rest sequentially
      const order: number[] = [currentPage];
      for (let p = 1; p <= totalPages; p++) {
        if (p !== currentPage) order.push(p);
      }

      for (const pageNum of order) {
        if (cancelled || textScanCancelRef.current) break;
        if (pagesText[pageNum] !== undefined) continue;

        try {
          const page = await pdfDoc.getPage(pageNum);
          try {
            const textContent = await page.getTextContent();
            if (cancelled || textScanCancelRef.current) break;
            const text = extractPageTextFromItems(
              textContent.items as Array<{ str?: string; hasEOL?: boolean }>,
            );
            const cls = classifyPdfPageText(text);
            setPagesText((prev) => (prev[pageNum] !== undefined ? prev : { ...prev, [pageNum]: text }));
            setPageKinds((prev) =>
              prev[pageNum] !== undefined ? prev : { ...prev, [pageNum]: cls.kind },
            );
          } finally {
            page.cleanup();
          }
        } catch {
          // Leave page unclassified if individual page text fails
        }
        // Yield to UI thread so large multi-page PDFs stay responsive
        await new Promise((r) => setTimeout(r, 8));
      }
    };

    void scanPagesText();
    return () => {
      cancelled = true;
      textScanCancelRef.current = true;
    };
    // Run when pdfDoc opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, totalPages]);

  const effectiveScale = useMemo(() => {
    if (!currentPageSizePt) return zoomScale;
    if (fitMode === 'fit-width') {
      const s = viewportWidth / currentPageSizePt.width;
      return Math.min(3.0, Math.max(0.4, Math.round(s * 100) / 100));
    }
    if (fitMode === 'fit-page') {
      const sW = viewportWidth / currentPageSizePt.width;
      const sH = viewportHeight / currentPageSizePt.height;
      return Math.min(3.0, Math.max(0.4, Math.round(Math.min(sW, sH) * 100) / 100));
    }
    return zoomScale;
  }, [fitMode, zoomScale, viewportWidth, viewportHeight, currentPageSizePt]);

  // Combined searchable text per page (PDF text layer + optional OCR results)
  const searchablePagesText = useMemo(() => {
    const out: Record<number, string> = {};
    for (let p = 1; p <= totalPages; p++) {
      const pdfTxt = pagesText[p] ?? '';
      const ocrTxt = searchIncludeOcr ? ocrResults[p]?.text ?? '' : '';
      if (pdfTxt && ocrTxt && pageKinds[p] === 'scanned') {
        out[p] = ocrTxt;
      } else {
        out[p] = pdfTxt || ocrTxt;
      }
    }
    return out;
  }, [pagesText, ocrResults, pageKinds, searchIncludeOcr, totalPages]);

  const searchMatches = useMemo(() => {
    return searchPdfPagesText(searchablePagesText, searchQuery, totalPages);
  }, [searchablePagesText, searchQuery, totalPages]);

  const activeMatch =
    searchMatches.length > 0
      ? searchMatches[Math.min(activeMatchIdx, searchMatches.length - 1)]
      : null;

  // Render ONLY the currently visible page canvas + TextLayer
  useEffect(() => {
    if (!pdfDoc || loadingPhase !== 'ready' || activeTab !== 'document') return;
    let cancelled = false;

    const renderCurrentPage = async () => {
      setPageRenderError(null);
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // ignore
      }
      try {
        textLayerInstanceRef.current?.cancel();
      } catch {
        // ignore
      }

      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) {
          page.cleanup();
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        setCurrentPageSizePt((prev) =>
          prev && prev.width === baseViewport.width && prev.height === baseViewport.height
            ? prev
            : { width: baseViewport.width, height: baseViewport.height },
        );

        let targetScale = zoomScale;
        if (fitMode === 'fit-width') {
          targetScale = Math.min(3.0, Math.max(0.4, viewportWidth / baseViewport.width));
        } else if (fitMode === 'fit-page') {
          targetScale = Math.min(
            3.0,
            Math.max(
              0.4,
              Math.min(viewportWidth / baseViewport.width, viewportHeight / baseViewport.height),
            ),
          );
        }

        const dimCheck = validateAndComputeRenderDimensions(
          baseViewport.width,
          baseViewport.height,
          targetScale,
        );
        if (!dimCheck.ok) {
          setPageRenderError(dimCheck.reason);
          page.cleanup();
          return;
        }

        const viewport = page.getViewport({ scale: targetScale });
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!canvas || !textLayerDiv) {
          page.cleanup();
          return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = Math.max(1, Math.floor(viewport.width));
        const cssHeight = Math.max(1, Math.floor(viewport.height));

        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          setPageRenderError('Could not initialize 2D canvas context for PDF rendering.');
          page.cleanup();
          return;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
        });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;

        if (cancelled) {
          page.cleanup();
          return;
        }

        // Render selectable text layer aligned with canvas
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.width = `${cssWidth}px`;
        textLayerDiv.style.height = `${cssHeight}px`;
        textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale));

        const textContent = await page.getTextContent();
        if (cancelled) {
          page.cleanup();
          return;
        }

        const pageText = extractPageTextFromItems(
          textContent.items as Array<{ str?: string; hasEOL?: boolean }>,
        );
        const cls = classifyPdfPageText(pageText);
        setPagesText((prev) => (prev[currentPage] !== undefined ? prev : { ...prev, [currentPage]: pageText }));
        setPageKinds((prev) =>
          prev[currentPage] !== undefined ? prev : { ...prev, [currentPage]: cls.kind },
        );

        const tl = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        textLayerInstanceRef.current = tl;
        await tl.render();
        textLayerInstanceRef.current = null;

        if (!cancelled && searchQuery.trim()) {
          const hitIndexOnThisPage =
            activeMatch && activeMatch.pageNumber === currentPage
              ? activeMatch.matchIndexOnPage
              : null;
          highlightTextLayerSpans(textLayerDiv, searchQuery, hitIndexOnThisPage);
        }

        page.cleanup();
      } catch (err) {
        if (err instanceof RenderingCancelledException || cancelled) return;
        setPageRenderError(
          err instanceof Error ? err.message : 'Unable to render this PDF page cleanly.',
        );
      }
    };

    void renderCurrentPage();

    return () => {
      cancelled = true;
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // ignore
      }
      try {
        textLayerInstanceRef.current?.cancel();
      } catch {
        // ignore
      }
    };
    // Re-apply highlights dynamically via effect below when only search changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, loadingPhase, activeTab, currentPage, fitMode, zoomScale, viewportWidth, viewportHeight]);

  // Apply search highlights on already-rendered text layer when query/activeMatch changes
  useEffect(() => {
    const el = textLayerRef.current;
    if (!el || activeTab !== 'document') return;
    const hitIndexOnPage =
      activeMatch && activeMatch.pageNumber === currentPage
        ? activeMatch.matchIndexOnPage
        : null;
    highlightTextLayerSpans(el, searchQuery, hitIndexOnPage);
  }, [searchQuery, activeMatch, currentPage, activeTab]);

  // Keyboard page navigation (when focus isn't inside an input)
  useEffect(() => {
    if (loadingPhase !== 'ready' || activeTab !== 'document' || totalPages <= 1) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        setCurrentPage((p) => {
          const next = Math.min(totalPages, p + 1);
          setPageInput(String(next));
          return next;
        });
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setCurrentPage((p) => {
          const prev = Math.max(1, p - 1);
          setPageInput(String(prev));
          return prev;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loadingPhase, activeTab, totalPages]);

  const goToPage = (pageNum: number) => {
    const clamped = Math.min(Math.max(1, pageNum), Math.max(1, totalPages));
    setCurrentPage(clamped);
    setPageInput(String(clamped));
  };

  const handleStepMatch = (dir: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const nextIdx = (activeMatchIdx + dir + searchMatches.length) % searchMatches.length;
    setActiveMatchIdx(nextIdx);
    const hit = searchMatches[nextIdx];
    if (hit && hit.pageNumber !== currentPage) {
      goToPage(hit.pageNumber);
    }
  };

  const handleToggleFullscreen = async () => {
    const el = readerContainerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Fallback safely ignored if fullscreen blocked by iframe policy
    }
  };

  const handleCopySelection = async () => {
    const selected = window.getSelection()?.toString() ?? '';
    if (!selected.trim()) {
      setCopyFeedbackMsg('Select text on the PDF page first, or use "Copy page text".');
      setTimeout(() => setCopyFeedbackMsg(null), 2600);
      return;
    }
    await triggerCopy('selection', selected, 'Selected text copied.');
  };

  const documentCoverage = useMemo(() => {
    const orderedKinds = Array.from({ length: totalPages }, (_, idx) => pageKinds[idx + 1]);
    return classifyDocumentTextCoverage(orderedKinds, totalPages);
  }, [pageKinds, totalPages]);

  // Resolved pages & text for Extracted Text tab
  const extractedRangeResolved = useMemo(() => {
    if (totalPages <= 0) return { pages: [] as number[], error: 'No pages' };
    if (extractedScope === 'all') {
      return { pages: Array.from({ length: totalPages }, (_, i) => i + 1), error: null };
    }
    if (extractedScope === 'current') {
      return { pages: [currentPage], error: null };
    }
    return parsePageRange(extractedRange, totalPages);
  }, [extractedScope, extractedRange, currentPage, totalPages]);

  const extractedPreviewText = useMemo(() => {
    if (extractedRangeResolved.error || extractedRangeResolved.pages.length === 0) return '';
    const items = extractedRangeResolved.pages.map((p) => {
      const pdfTxt = pagesText[p] ?? '';
      const ocrTxt = ocrResults[p]?.text ?? '';
      if (extractedSource === 'ocr') {
        return { pageNumber: p, text: ocrTxt, source: 'ocr' as const };
      }
      if (extractedSource === 'combined') {
        if (pageKinds[p] === 'scanned' && ocrTxt) {
          return { pageNumber: p, text: ocrTxt, source: 'ocr' as const };
        }
        return { pageNumber: p, text: pdfTxt, source: 'pdf-text' as const };
      }
      return { pageNumber: p, text: pdfTxt, source: 'pdf-text' as const };
    });
    return formatExtractedPages({
      pages: items,
      format: 'txt',
      filename: file.relativePath,
      emptyPagePlaceholder: '[Scanned/image page — no selectable text layer]',
    });
  }, [extractedRangeResolved, extractedSource, pagesText, ocrResults, pageKinds, file.relativePath]);

  const currentPageKind = pageKinds[currentPage];
  const currentPageText = pagesText[currentPage] ?? '';
  const hasOcrResults = Object.keys(ocrResults).length > 0;

  if (loadingPhase === 'fetching' || loadingPhase === 'parsing') {
    const pct =
      downloadProgress.total > 0
        ? Math.min(100, Math.round((downloadProgress.loaded / downloadProgress.total) * 100))
        : 0;
    return (
      <div className="p-8 space-y-4" aria-busy="true" aria-label="Loading PDF document">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {loadingPhase === 'fetching'
              ? 'Loading PDF bytes into browser...'
              : 'Parsing PDF structure in browser...'}
          </div>
          <div className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {formatBytes(downloadProgress.loaded)} / {formatBytes(downloadProgress.total)} ({pct}%)
          </div>
        </div>
        <div className="h-2 max-w-md overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className="h-full bg-blue-700 dark:bg-blue-500 transition-[width] duration-150"
            style={{ width: `${loadingPhase === 'parsing' ? 100 : pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (loadingPhase === 'password') {
    return (
      <div className="p-8 max-w-md mx-auto space-y-4">
        <div className="flex items-center gap-2.5 text-slate-900 dark:text-slate-100">
          <Lock className="h-5 w-5 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
          <h3 className="text-base font-semibold">Password-protected PDF</h3>
        </div>
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          Enter the document password to unlock and read it locally in your browser. Passwords are
          never logged, sent to the server, or stored.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!rawBytesRef.current || !passwordInput) return;
            void openPdfFromBytes(rawBytesRef.current, passwordInput);
          }}
          className="space-y-3"
        >
          <div>
            <label htmlFor="pdf-password-input" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              PDF password
            </label>
            <input
              id="pdf-password-input"
              type="password"
              autoFocus
              required
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter PDF password"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          {passwordError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
            >
              {passwordError}
            </div>
          )}
          <button
            type="submit"
            disabled={!passwordInput}
            className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            Unlock PDF
          </button>
        </form>
      </div>
    );
  }

  if (loadingPhase === 'error' || !pdfDoc) {
    return (
      <div className="p-8 space-y-4">
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-900 space-y-2 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Could not render PDF</span>
          </div>
          <p>{loadError || 'This PDF could not be opened.'}</p>
        </div>
        <a
          href={`/s/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Download raw PDF</span>
        </a>
      </div>
    );
  }

  return (
    <div
      ref={readerContainerRef}
      data-testid="pdf-reader"
      className="flex flex-col bg-white dark:bg-slate-900"
    >
      {/* Top Privacy & Document Classification Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/70 dark:text-slate-300">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" aria-hidden="true" />
          <span>
            Browser PDF.js reader &middot; Scripts &amp; actions disabled &middot; Original PDF
            unchanged
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
          {documentCoverage.kind === 'text' && (
            <span className="font-semibold text-emerald-700 dark:text-emerald-400">
              Text-based PDF ({documentCoverage.textPageCount}/{totalPages} pages)
            </span>
          )}
          {documentCoverage.kind === 'scanned' && (
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              Scanned/image-only PDF ({documentCoverage.scannedPageCount}/{totalPages} pages)
            </span>
          )}
          {documentCoverage.kind === 'hybrid' && (
            <span className="font-semibold text-blue-700 dark:text-blue-400">
              Hybrid PDF ({documentCoverage.textPageCount} text, {documentCoverage.scannedPageCount}{' '}
              scanned)
            </span>
          )}
        </div>
      </div>

      {/* Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <div
          role="tablist"
          aria-label="PDF reader sections"
          className="inline-flex flex-wrap items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'document'}
            onClick={() => setActiveTab('document')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
              activeTab === 'document'
                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Document</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'extracted'}
            onClick={() => setActiveTab('extracted')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
              activeTab === 'extracted'
                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Extracted text</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'images'}
            onClick={() => setActiveTab('images')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
              activeTab === 'images'
                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Export images</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ocr'}
            onClick={() => setActiveTab('ocr')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
              activeTab === 'ocr'
                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            <ScanText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>OCR (Optional)</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleToggleFullscreen()}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 whitespace-nowrap"
        >
          {isFullscreen ? (
            <>
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Exit fullscreen</span>
            </>
          ) : (
            <>
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Fullscreen</span>
            </>
          )}
        </button>
      </div>

      {/* TAB 1: DOCUMENT VIEWER */}
      {activeTab === 'document' && (
        <div>
          {/* Navigation, Zoom, Search & Copy Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-950/50">
            {/* Page Nav */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Previous page"
                disabled={currentPage <= 1}
                onClick={() => goToPage(currentPage - 1)}
                className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = Number.parseInt(pageInput, 10);
                  if (Number.isFinite(parsed)) goToPage(parsed);
                  else setPageInput(String(currentPage));
                }}
                className="flex items-center gap-1 text-xs font-mono tabular-nums"
              >
                <label htmlFor="pdf-page-jump" className="sr-only">
                  Page number
                </label>
                <input
                  id="pdf-page-jump"
                  type="text"
                  inputMode="numeric"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => {
                    const parsed = Number.parseInt(pageInput, 10);
                    if (Number.isFinite(parsed)) goToPage(parsed);
                    else setPageInput(String(currentPage));
                  }}
                  className="w-12 rounded-md border border-slate-300 bg-white px-2 py-1 text-center text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <span className="text-slate-600 dark:text-slate-400">/ {totalPages}</span>
              </form>
              <button
                type="button"
                aria-label="Next page"
                disabled={currentPage >= totalPages}
                onClick={() => goToPage(currentPage + 1)}
                className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Zoom & Fit Controls */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => {
                  setFitMode('custom');
                  setZoomScale((s) => Math.max(0.4, Math.round((s - 0.15) * 100) / 100));
                }}
                className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span
                data-testid="pdf-zoom-label"
                className="min-w-12 text-center font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300"
              >
                {Math.round(effectiveScale * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => {
                  setFitMode('custom');
                  setZoomScale((s) => Math.min(3.0, Math.round((s + 0.15) * 100) / 100));
                }}
                className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-pressed={fitMode === 'fit-width'}
                onClick={() => setFitMode('fit-width')}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  fitMode === 'fit-width'
                    ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                }`}
              >
                Fit width
              </button>
              <button
                type="button"
                aria-pressed={fitMode === 'fit-page'}
                onClick={() => setFitMode('fit-page')}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  fitMode === 'fit-page'
                    ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                }`}
              >
                Fit page
              </button>
            </div>

            {/* Search & Copy */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative flex items-center">
                <Search
                  className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400"
                  aria-hidden="true"
                />
                <label htmlFor="pdf-search-input" className="sr-only">
                  Search in PDF
                </label>
                <input
                  id="pdf-search-input"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => {
                    const q = e.target.value;
                    setSearchQuery(q);
                    setActiveMatchIdx(0);
                    if (q.trim()) {
                      const nextMatches = searchPdfPagesText(searchablePagesText, q, totalPages);
                      if (nextMatches[0] && nextMatches[0].pageNumber !== currentPage) {
                        goToPage(nextMatches[0].pageNumber);
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleStepMatch(e.shiftKey ? -1 : 1);
                    }
                  }}
                  placeholder="Search PDF text..."
                  className="w-40 sm:w-48 rounded-md border border-slate-300 bg-white py-1 pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              {searchQuery.trim() && (
                <div className="flex items-center gap-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  <span data-testid="pdf-search-count">
                    {searchMatches.length === 0
                      ? '0 matches'
                      : `${Math.min(activeMatchIdx + 1, searchMatches.length)} / ${searchMatches.length}`}
                  </span>
                  <button
                    type="button"
                    aria-label="Previous search match"
                    disabled={searchMatches.length === 0}
                    onClick={() => handleStepMatch(-1)}
                    className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800"
                  >
                    &uarr;
                  </button>
                  <button
                    type="button"
                    aria-label="Next search match"
                    disabled={searchMatches.length === 0}
                    onClick={() => handleStepMatch(1)}
                    className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800"
                  >
                    &darr;
                  </button>
                </div>
              )}

              {hasOcrResults && (
                <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer ml-1">
                  <input
                    type="checkbox"
                    checked={searchIncludeOcr}
                    onChange={(e) => setSearchIncludeOcr(e.target.checked)}
                  />
                  <span>OCR</span>
                </label>
              )}

              <button
                type="button"
                onClick={() => void handleCopySelection()}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 whitespace-nowrap"
              >
                {copiedKey === 'selection' ? 'Selection copied' : 'Copy selected'}
              </button>

              <button
                type="button"
                disabled={!currentPageText && !ocrResults[currentPage]?.text}
                onClick={() =>
                  void triggerCopy(
                    'currentPageText',
                    currentPageText || ocrResults[currentPage]?.text || '',
                    `Copied text from page ${currentPage}.`,
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 whitespace-nowrap"
              >
                {copiedKey === 'currentPageText' ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Page copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    <span>Copy page text</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Per-Page Scanned/Image Classification Banner */}
          {currentPageKind === 'scanned' && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <div>
                <strong>Scanned/image page (Page {currentPage}):</strong> Little or no selectable
                text was found on this page. You can still inspect it, export it as an image, or run
                optional local English OCR (OCR may be needed to extract text).
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveTab('images')}
                  className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-200"
                >
                  Export image
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('ocr')}
                  className="rounded-md bg-amber-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-800"
                >
                  Optional OCR
                </button>
              </div>
            </div>
          )}

          {copyFeedbackMsg && (
            <div
              role="status"
              className="border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
            >
              {copyFeedbackMsg}
            </div>
          )}

          {/* Rendered White Paper Stage (readable even in Dark Mode) */}
          <div
            ref={scrollStageRef}
            className="overflow-auto bg-slate-200/80 p-4 min-h-[520px] max-h-[75vh] flex justify-center items-start dark:bg-slate-950"
          >
            {pageRenderError ? (
              <div
                role="alert"
                className="max-w-lg rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
              >
                {pageRenderError}
              </div>
            ) : (
              <div
                data-testid="pdf-page-surface"
                className="relative bg-white text-slate-900 shadow-sm ring-1 ring-slate-300/80 select-text shrink-0"
              >
                <canvas ref={canvasRef} className="block" />
                <div ref={textLayerRef} className="textLayer" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: EXTRACTED TEXT VIEW & .TXT / .MD EXPORT */}
      {activeTab === 'extracted' && (
        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Extracted text
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Escaped plain-text extraction grouped by page number (<code className="font-mono">## Page N</code>).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={Boolean(extractedRangeResolved.error) || !extractedPreviewText}
                onClick={() => void triggerCopy('extractedAll', extractedPreviewText)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {copiedKey === 'extractedAll' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Copy text</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={Boolean(extractedRangeResolved.error) || !extractedPreviewText}
                onClick={() =>
                  triggerDownloadText(
                    extractedPreviewText,
                    `${sanitizePdfExportBaseName(file.relativePath)}-text.txt`,
                    'text/plain;charset=utf-8',
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download .txt</span>
              </button>

              <button
                type="button"
                disabled={Boolean(extractedRangeResolved.error) || !extractedPreviewText}
                onClick={() => {
                  const md = formatExtractedPages({
                    pages: extractedRangeResolved.pages.map((p) => {
                      const pdfTxt = pagesText[p] ?? '';
                      const ocrTxt = ocrResults[p]?.text ?? '';
                      if (extractedSource === 'ocr') {
                        return { pageNumber: p, text: ocrTxt, source: 'ocr' as const };
                      }
                      if (extractedSource === 'combined' && pageKinds[p] === 'scanned' && ocrTxt) {
                        return { pageNumber: p, text: ocrTxt, source: 'ocr' as const };
                      }
                      return { pageNumber: p, text: pdfTxt, source: 'pdf-text' as const };
                    }),
                    format: 'md',
                    filename: file.relativePath,
                    emptyPagePlaceholder: '[Scanned/image page — no selectable text layer]',
                  });
                  triggerDownloadText(
                    md,
                    `${sanitizePdfExportBaseName(file.relativePath)}-text.md`,
                    'text/markdown;charset=utf-8',
                  );
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-45 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download .md</span>
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs dark:border-slate-800 dark:bg-slate-950/60">
            <div className="space-y-2">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Page selection</div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="ext-scope"
                    checked={extractedScope === 'all'}
                    onChange={() => setExtractedScope('all')}
                  />
                  <span>All pages (1&ndash;{totalPages})</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="ext-scope"
                    checked={extractedScope === 'current'}
                    onChange={() => setExtractedScope('current')}
                  />
                  <span>Current (Page {currentPage})</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="ext-scope"
                    checked={extractedScope === 'range'}
                    onChange={() => setExtractedScope('range')}
                  />
                  <span>Range</span>
                </label>
              </div>
              {extractedScope === 'range' && (
                <div>
                  <label htmlFor="extracted-range-input" className="sr-only">
                    Page range for extracted text
                  </label>
                  <input
                    id="extracted-range-input"
                    type="text"
                    value={extractedRange}
                    onChange={(e) => setExtractedRange(e.target.value)}
                    placeholder="e.g. 1-3, 5"
                    className="w-44 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              )}
              {extractedRangeResolved.error && (
                <div className="text-red-700 dark:text-red-400">{extractedRangeResolved.error}</div>
              )}
            </div>

            <div className="space-y-2">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Text source</div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="ext-source"
                    checked={extractedSource === 'combined'}
                    onChange={() => setExtractedSource('combined')}
                  />
                  <span>PDF text + OCR</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="ext-source"
                    checked={extractedSource === 'pdf-text'}
                    onChange={() => setExtractedSource('pdf-text')}
                  />
                  <span>PDF text layer only</span>
                </label>
                {hasOcrResults && (
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="ext-source"
                      checked={extractedSource === 'ocr'}
                      onChange={() => setExtractedSource('ocr')}
                    />
                    <span>OCR results only</span>
                  </label>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Note: Copying or exporting extracted text does not guarantee another AI provider can
                accept or process it; you must follow that provider&rsquo;s rules.
              </p>
            </div>
          </div>

          <pre
            data-testid="pdf-extracted-text-output"
            className="max-h-[480px] overflow-auto rounded-lg border border-slate-200 bg-white p-4 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
          >
            {extractedPreviewText || 'Loading extracted text...'}
          </pre>
        </div>
      )}

      {/* TAB 3: EXPORT PDF PAGES AS IMAGES */}
      {activeTab === 'images' && (
        <PdfImageExportPanel
          pdfDoc={pdfDoc}
          filename={file.relativePath}
          currentPage={currentPage}
          totalPages={totalPages}
          currentPageSizePt={currentPageSizePt}
        />
      )}

      {/* TAB 4: OPTIONAL LOCAL OCR */}
      {activeTab === 'ocr' && (
        <PdfOcrPanel
          pdfDoc={pdfDoc}
          filename={file.relativePath}
          currentPage={currentPage}
          totalPages={totalPages}
          pageKinds={pageKinds}
          ocrResults={ocrResults}
          onOcrPageComplete={(res) =>
            setOcrResults((prev) => ({ ...prev, [res.pageNumber]: res }))
          }
          onCopyText={triggerCopy}
          copiedKey={copiedKey}
        />
      )}
    </div>
  );
};
