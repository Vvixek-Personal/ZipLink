import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import { AlertTriangle, Check, Copy, Download, Loader2, ScanText, ShieldCheck, X } from 'lucide-react';
import {
  formatExtractedPages,
  parsePageRange,
  sanitizePdfExportBaseName,
  validateAndComputeRenderDimensions,
  type PdfPageTextKind,
} from '../shared/pdfUtils.ts';

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  confidence: number;
}

interface PdfOcrPanelProps {
  pdfDoc: PDFDocumentProxy;
  filename: string;
  currentPage: number;
  totalPages: number;
  pageKinds: Record<number, PdfPageTextKind>;
  ocrResults: Record<number, OcrPageResult>;
  onOcrPageComplete: (result: OcrPageResult) => void;
  onCopyText: (key: string, text: string) => Promise<void>;
  copiedKey: string | null;
}

type OcrTargetScope = 'scanned' | 'current' | 'range' | 'all';

function downloadTextBlob(text: string, downloadFilename: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadFilename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const PdfOcrPanel: React.FC<PdfOcrPanelProps> = ({
  pdfDoc,
  filename,
  currentPage,
  totalPages,
  pageKinds,
  ocrResults,
  onOcrPageComplete,
  onCopyText,
  copiedKey,
}) => {
  const scannedPageNumbers = useMemo(() => {
    const out: number[] = [];
    for (let p = 1; p <= totalPages; p++) {
      if (pageKinds[p] === 'scanned') out.push(p);
    }
    return out;
  }, [pageKinds, totalPages]);

  const [scope, setScope] = useState<OcrTargetScope>(
    scannedPageNumbers.length > 0 ? 'scanned' : 'current',
  );
  const [rangeInput, setRangeInput] = useState<string>(
    totalPages > 1 ? `1-${Math.min(3, totalPages)}` : '1',
  );
  const [languageDataConfirmed, setLanguageDataConfirmed] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    currentPageNum: number;
    status: string;
    stepPct: number;
  }>({
    done: 0,
    total: 0,
    currentPageNum: 0,
    status: '',
    stepPct: 0,
  });
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrNotice, setOcrNotice] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const workerRef = useRef<TesseractWorker | null>(null);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      const w = workerRef.current;
      workerRef.current = null;
      if (w) {
        void w.terminate().catch(() => undefined);
      }
    };
  }, [pdfDoc]);

  const resolvedTargetPages = useMemo((): { pages: number[]; error: string | null } => {
    if (totalPages <= 0) return { pages: [], error: 'Document has no pages.' };
    if (scope === 'scanned') {
      if (scannedPageNumbers.length === 0) {
        return {
          pages: [],
          error: 'No scanned/image pages detected yet. Select Current page, Page range, or All pages if you still want to run OCR.',
        };
      }
      return { pages: scannedPageNumbers, error: null };
    }
    if (scope === 'current') {
      return { pages: [Math.min(Math.max(1, currentPage), totalPages)], error: null };
    }
    if (scope === 'all') {
      return { pages: Array.from({ length: totalPages }, (_, i) => i + 1), error: null };
    }
    return parsePageRange(rangeInput, totalPages);
  }, [scope, scannedPageNumbers, currentPage, totalPages, rangeInput]);

  const handleCancelOcr = async () => {
    cancelledRef.current = true;
    const w = workerRef.current;
    workerRef.current = null;
    if (w) {
      await w.terminate().catch(() => undefined);
    }
  };

  const handleStartOcr = async () => {
    if (isRunning || !languageDataConfirmed || resolvedTargetPages.error) return;
    const targetPages = resolvedTargetPages.pages;
    if (targetPages.length === 0) return;

    setIsRunning(true);
    setOcrError(null);
    setOcrNotice(null);
    cancelledRef.current = false;
    setProgress({
      done: 0,
      total: targetPages.length,
      currentPageNum: targetPages[0],
      status: 'Loading local English OCR engine...',
      stepPct: 0,
    });

    const origin = window.location.origin;
    let worker: TesseractWorker | null = null;

    try {
      worker = await createWorker(
        'eng',
        1,
        {
          workerPath: `${origin}/ocr-assets/worker.min.js`,
          corePath: `${origin}/ocr-assets/core`,
          langPath: `${origin}/ocr-assets/tessdata`,
          workerBlobURL: false,
          gzip: true,
          logger: (msg) => {
            if (!cancelledRef.current && msg && typeof msg.progress === 'number') {
              setProgress((prev) => ({
                ...prev,
                status: msg.status || prev.status,
                stepPct: Math.round(msg.progress * 100),
              }));
            }
          },
        },
      );
      workerRef.current = worker;

      if (cancelledRef.current) {
        await worker.terminate().catch(() => undefined);
        workerRef.current = null;
        return;
      }

      for (let i = 0; i < targetPages.length; i++) {
        if (cancelledRef.current) break;

        const pageNumber = targetPages[i];
        setProgress({
          done: i,
          total: targetPages.length,
          currentPageNum: pageNumber,
          status: `Rendering page ${pageNumber} for local OCR...`,
          stepPct: 0,
        });

        const page = await pdfDoc.getPage(pageNumber);
        let canvas: HTMLCanvasElement | null = null;
        try {
          const baseViewport = page.getViewport({ scale: 1 });
          // Use ~2.0x scale when within safe canvas bounds, falling back to 1.25x for huge pages
          let ocrScale = 2.0;
          if (!validateAndComputeRenderDimensions(baseViewport.width, baseViewport.height, ocrScale).ok) {
            ocrScale = 1.25;
          }
          const dimCheck = validateAndComputeRenderDimensions(
            baseViewport.width,
            baseViewport.height,
            ocrScale,
          );
          if (!dimCheck.ok) {
            throw new Error(`Page ${pageNumber}: ${dimCheck.reason}`);
          }

          const viewport = page.getViewport({ scale: ocrScale });
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) {
            throw new Error(`Page ${pageNumber}: Could not allocate 2D context for OCR.`);
          }
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await renderTask.promise;

          if (cancelledRef.current) break;

          setProgress((prev) => ({
            ...prev,
            status: `Recognizing English text on page ${pageNumber}...`,
          }));

          const result = await worker.recognize(canvas);
          if (cancelledRef.current) break;

          onOcrPageComplete({
            pageNumber,
            text: (result.data?.text ?? '').trim(),
            confidence: Math.round(result.data?.confidence ?? 0),
          });

          setProgress({
            done: i + 1,
            total: targetPages.length,
            currentPageNum: pageNumber,
            status: `Completed page ${pageNumber}`,
            stepPct: 100,
          });
        } finally {
          if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 0;
            canvas.height = 0;
          }
          page.cleanup();
        }
      }

      if (cancelledRef.current) {
        setOcrNotice('OCR cancelled. Any pages already processed remain visible below.');
      } else {
        setOcrNotice(
          `Local OCR finished for ${targetPages.length} ${targetPages.length === 1 ? 'page' : 'pages'}. Review recognized text below before copying or exporting.`,
        );
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setOcrError(err instanceof Error ? err.message : 'Browser OCR failed.');
      }
    } finally {
      if (worker) {
        await worker.terminate().catch(() => undefined);
      }
      workerRef.current = null;
      setIsRunning(false);
    }
  };

  const completedOcrList = useMemo(() => {
    return Object.values(ocrResults).sort((a, b) => a.pageNumber - b.pageNumber);
  }, [ocrResults]);

  const formattedOcrTxt = useMemo(() => {
    if (completedOcrList.length === 0) return '';
    return formatExtractedPages({
      pages: completedOcrList.map((r) => ({
        pageNumber: r.pageNumber,
        text: r.text,
        source: 'ocr',
      })),
      format: 'txt',
      filename,
      emptyPagePlaceholder: '[No text recognized by OCR on this page]',
    });
  }, [completedOcrList, filename]);

  const formattedOcrMd = useMemo(() => {
    if (completedOcrList.length === 0) return '';
    return formatExtractedPages({
      pages: completedOcrList.map((r) => ({
        pageNumber: r.pageNumber,
        text: r.text,
        source: 'ocr',
      })),
      format: 'md',
      filename,
      emptyPagePlaceholder: '[No text recognized by OCR on this page]',
    });
  }, [completedOcrList, filename]);

  const overallPct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <div className="p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Optional local OCR (for scanned or image pages)
        </h3>
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          Runs Tesseract.js directly in your browser, one page at a time, leaving the original PDF
          and exported page images unchanged.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 space-y-1.5 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
        <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
          <ShieldCheck className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" aria-hidden="true" />
          <span>Supported language &amp; local data disclosure</span>
        </div>
        <p>
          <strong>Supported OCR language:</strong> English (<code className="font-mono">eng</code>)
          only. No other OCR languages are configured or bundled.
        </p>
        <p>
          Starting OCR downloads the bundled Tesseract WASM core and English language data (~3 MB)
          strictly from this ZipLink server (<code className="font-mono">/ocr-assets/</code>) into
          your browser&mdash;never from a third-party CDN, and never sending your PDF pages or
          recognized text to any AI or external OCR service.
        </p>
      </div>

      <fieldset className="rounded-lg border border-slate-200 p-4 space-y-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
          Select pages for OCR
        </legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="ocr-scope"
              checked={scope === 'scanned'}
              disabled={isRunning}
              onChange={() => setScope('scanned')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">Scanned/image pages only</strong>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                {scannedPageNumbers.length > 0
                  ? `${scannedPageNumbers.length} detected (${scannedPageNumbers.slice(0, 8).join(', ')}${scannedPageNumbers.length > 8 ? '...' : ''})`
                  : 'None detected'}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="ocr-scope"
              checked={scope === 'current'}
              disabled={isRunning}
              onChange={() => setScope('current')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">Current page</strong>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                Page {currentPage}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="ocr-scope"
              checked={scope === 'all'}
              disabled={isRunning}
              onChange={() => setScope('all')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">Whole document</strong>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                Pages 1&ndash;{totalPages}
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="radio"
                name="ocr-scope"
                checked={scope === 'range'}
                disabled={isRunning}
                onChange={() => setScope('range')}
              />
              <strong className="font-semibold">Page range</strong>
            </label>
            {scope === 'range' && (
              <div>
                <label htmlFor="ocr-page-range-input" className="sr-only">
                  OCR page range
                </label>
                <input
                  id="ocr-page-range-input"
                  type="text"
                  disabled={isRunning}
                  value={rangeInput}
                  onChange={(e) => setRangeInput(e.target.value)}
                  placeholder="e.g. 1-3, 5"
                  className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            )}
          </div>
        </div>

        <label className="flex items-start gap-2.5 border-t border-slate-200 pt-3 text-xs text-slate-800 dark:border-slate-800 dark:text-slate-200 cursor-pointer">
          <input
            type="checkbox"
            checked={languageDataConfirmed}
            disabled={isRunning}
            onChange={(e) => setLanguageDataConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
          />
          <span>
            I want to download the bundled English (<code className="font-mono">eng</code>) OCR
            language data (~3 MB) from this ZipLink server and run OCR locally in my browser.
          </span>
        </label>

        {resolvedTargetPages.error && (
          <div className="text-xs text-amber-800 dark:text-amber-300">
            {resolvedTargetPages.error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
            {resolvedTargetPages.error
              ? 'Select valid pages above'
              : `Ready: ${resolvedTargetPages.pages.length} ${resolvedTargetPages.pages.length === 1 ? 'page' : 'pages'} · English (eng)`}
          </span>

          {isRunning ? (
            <button
              type="button"
              onClick={() => void handleCancelOcr()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-800 dark:text-red-400"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Cancel OCR</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!languageDataConfirmed || Boolean(resolvedTargetPages.error)}
              onClick={() => void handleStartOcr()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 dark:bg-blue-600 dark:hover:bg-blue-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
            >
              <ScanText className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Run local OCR (English)</span>
            </button>
          )}
        </div>
      </fieldset>

      {isRunning && (
        <div
          aria-live="polite"
          className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-950/60"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700 dark:text-blue-400" aria-hidden="true" />
              <span>
                {progress.status} ({progress.done + 1} of {progress.total})
              </span>
            </span>
            <span className="font-mono tabular-nums">
              {overallPct}% (step {progress.stepPct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-blue-700 dark:bg-blue-500 transition-[width] duration-150"
              style={{ width: `${overallPct}%` }}
            />
          </div>
        </div>
      )}

      {ocrError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
        >
          {ocrError}
        </div>
      )}

      {ocrNotice && !ocrError && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {ocrNotice}
        </div>
      )}

      {completedOcrList.length > 0 && (
        <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 flex items-start gap-2 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            <div>
              <strong>Separate OCR output &mdash; review carefully:</strong> OCR can make mistakes,
              especially with handwriting, low-quality scans, skewed pages, tables, or unusual
              layouts. Original PDF pages and page images remain unchanged.
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              OCR results ({completedOcrList.length}{' '}
              {completedOcrList.length === 1 ? 'page' : 'pages'})
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void onCopyText('ocrAll', formattedOcrTxt)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {copiedKey === 'ocrAll' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Copied OCR text</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Copy OCR text</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadTextBlob(
                    formattedOcrTxt,
                    `${sanitizePdfExportBaseName(filename)}-ocr.txt`,
                    'text/plain;charset=utf-8',
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download .txt</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadTextBlob(
                    formattedOcrMd,
                    `${sanitizePdfExportBaseName(filename)}-ocr.md`,
                    'text/markdown;charset=utf-8',
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download .md</span>
              </button>
            </div>
          </div>

          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {completedOcrList.map((entry) => (
              <div
                key={entry.pageNumber}
                className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-950/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-xs dark:border-slate-800">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    ## Page {entry.pageNumber} (OCR)
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      Confidence: {entry.confidence}%
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void onCopyText(`ocrPage:${entry.pageNumber}`, entry.text)
                      }
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {copiedKey === `ocrPage:${entry.pageNumber}` ? (
                        <>
                          <Check className="h-3 w-3" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" aria-hidden="true" />
                          <span>Copy page</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
                  {entry.text || '[No English text recognized on this page]'}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
