import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { zipSync } from 'fflate';
import { Download, FolderArchive, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { formatBytes } from '../shared/zipSecurity.ts';
import {
  estimateExportImageBytes,
  formatPageExportFilename,
  parsePageRange,
  PDF_IMAGE_EXPORT_LIMITS,
  resolveExportScale,
  sanitizePdfExportBaseName,
  validateAndComputeRenderDimensions,
  type PdfImageFormat,
  type PdfImageResolutionPreset,
} from '../shared/pdfUtils.ts';

interface PdfImageExportPanelProps {
  pdfDoc: PDFDocumentProxy;
  filename: string;
  currentPage: number;
  totalPages: number;
  currentPageSizePt: { width: number; height: number } | null;
}

interface ExportedPageImage {
  pageNumber: number;
  filename: string;
  mimeType: string;
  widthPx: number;
  heightPx: number;
  sizeBytes: number;
  blob: Blob;
  objectUrl: string;
}

type ExportScope = 'current' | 'range' | 'all';

function triggerBlobDownload(url: string, downloadFilename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadFilename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const PdfImageExportPanel: React.FC<PdfImageExportPanelProps> = ({
  pdfDoc,
  filename,
  currentPage,
  totalPages,
  currentPageSizePt,
}) => {
  const [scope, setScope] = useState<ExportScope>('all');
  const [rangeInput, setRangeInput] = useState<string>(totalPages > 1 ? `1-${Math.min(3, totalPages)}` : '1');
  const [format, setFormat] = useState<PdfImageFormat>('png');
  const [resolution, setResolution] = useState<PdfImageResolutionPreset>('standard');

  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; currentPageNum: number }>({
    done: 0,
    total: 0,
    currentPageNum: 0,
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedImages, setExportedImages] = useState<ExportedPageImage[]>([]);
  const [zipBusy, setZipBusy] = useState(false);

  const cancelledRef = useRef(false);
  const activeRenderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const exportedUrlsRef = useRef<string[]>([]);

  const revokeAllExportedUrls = () => {
    for (const url of exportedUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    exportedUrlsRef.current = [];
  };

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      try {
        activeRenderTaskRef.current?.cancel();
      } catch {
        // ignore
      }
      revokeAllExportedUrls();
    };
  }, [pdfDoc]);

  const resolvedPages = useMemo((): { pages: number[]; error: string | null } => {
    if (totalPages <= 0) return { pages: [], error: 'Document has no pages.' };
    if (scope === 'current') {
      return { pages: [Math.min(Math.max(1, currentPage), totalPages)], error: null };
    }
    if (scope === 'all') {
      return {
        pages: Array.from({ length: totalPages }, (_, idx) => idx + 1),
        error: null,
      };
    }
    return parsePageRange(rangeInput, totalPages);
  }, [scope, rangeInput, currentPage, totalPages]);

  const targetScale = resolveExportScale(resolution);

  const preflightCheck = useMemo(() => {
    if (resolvedPages.error) {
      return { ok: false as const, error: resolvedPages.error };
    }
    if (resolvedPages.pages.length > PDF_IMAGE_EXPORT_LIMITS.MAX_BATCH_EXPORT_PAGES) {
      return {
        ok: false as const,
        error: `Selected ${resolvedPages.pages.length} pages, which exceeds the ${PDF_IMAGE_EXPORT_LIMITS.MAX_BATCH_EXPORT_PAGES}-page per-export limit. Use a narrower page range.`,
      };
    }
    if (currentPageSizePt) {
      const dimCheck = validateAndComputeRenderDimensions(
        currentPageSizePt.width,
        currentPageSizePt.height,
        targetScale,
      );
      if (!dimCheck.ok) {
        return { ok: false as const, error: dimCheck.reason };
      }
      const estimate = estimateExportImageBytes({
        widthPx: dimCheck.widthPx,
        heightPx: dimCheck.heightPx,
        format,
        pageCount: resolvedPages.pages.length,
      });
      return {
        ok: true as const,
        sampleWidthPx: dimCheck.widthPx,
        sampleHeightPx: dimCheck.heightPx,
        perPageEstBytes: estimate.perPageBytes,
        totalEstBytes: estimate.totalEstimatedBytes,
      };
    }
    return {
      ok: true as const,
      sampleWidthPx: null,
      sampleHeightPx: null,
      perPageEstBytes: null,
      totalEstBytes: null,
    };
  }, [resolvedPages, currentPageSizePt, targetScale, format]);

  const handleStartExport = async () => {
    if (isExporting || !preflightCheck.ok) return;

    const targetPages = resolvedPages.pages;
    if (targetPages.length === 0) return;

    revokeAllExportedUrls();
    setExportedImages([]);
    setExportError(null);
    setIsExporting(true);
    cancelledRef.current = false;
    setProgress({ done: 0, total: targetPages.length, currentPageNum: targetPages[0] });

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const nextResults: ExportedPageImage[] = [];

    try {
      for (let idx = 0; idx < targetPages.length; idx++) {
        if (cancelledRef.current) break;

        const pageNumber = targetPages[idx];
        setProgress({ done: idx, total: targetPages.length, currentPageNum: pageNumber });

        const page = await pdfDoc.getPage(pageNumber);
        let canvas: HTMLCanvasElement | null = null;
        try {
          const baseViewport = page.getViewport({ scale: 1 });
          const dimCheck = validateAndComputeRenderDimensions(
            baseViewport.width,
            baseViewport.height,
            targetScale,
          );
          if (!dimCheck.ok) {
            throw new Error(`Page ${pageNumber}: ${dimCheck.reason}`);
          }

          const viewport = page.getViewport({ scale: targetScale });
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));

          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) {
            throw new Error(`Page ${pageNumber}: Could not allocate 2D rendering context.`);
          }

          // White paper background so transparent PDFs remain readable
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const renderTask = page.render({
            canvas,
            canvasContext: ctx,
            viewport,
          });
          activeRenderTaskRef.current = renderTask;
          await renderTask.promise;
          activeRenderTaskRef.current = null;

          if (cancelledRef.current) {
            break;
          }

          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas!.toBlob(
              (result) => {
                if (result) resolve(result);
                else reject(new Error(`Page ${pageNumber}: Failed to encode ${format.toUpperCase()} image.`));
              },
              mimeType,
              format === 'jpeg' ? 0.9 : undefined,
            );
          });

          const objectUrl = URL.createObjectURL(blob);
          exportedUrlsRef.current.push(objectUrl);

          nextResults.push({
            pageNumber,
            filename: formatPageExportFilename(filename, pageNumber, format),
            mimeType,
            widthPx: canvas.width,
            heightPx: canvas.height,
            sizeBytes: blob.size,
            blob,
            objectUrl,
          });

          setExportedImages([...nextResults]);
          setProgress({ done: idx + 1, total: targetPages.length, currentPageNum: pageNumber });
        } finally {
          activeRenderTaskRef.current = null;
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
        setExportError(
          nextResults.length > 0
            ? `Export cancelled after rendering ${nextResults.length} of ${targetPages.length} pages.`
            : 'Image export cancelled.',
        );
      }
    } catch (err) {
      if (!cancelledRef.current) {
        const msg = err instanceof Error ? err.message : 'Failed to render PDF pages as images.';
        setExportError(msg);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCancelExport = () => {
    cancelledRef.current = true;
    try {
      activeRenderTaskRef.current?.cancel();
    } catch {
      // ignore
    }
  };

  const handleDownloadAllIndividually = async () => {
    for (const img of exportedImages) {
      triggerBlobDownload(img.objectUrl, img.filename);
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  const handleDownloadZip = async () => {
    if (exportedImages.length === 0 || zipBusy) return;
    setZipBusy(true);
    setExportError(null);
    try {
      const totalRaw = exportedImages.reduce((acc, item) => acc + item.sizeBytes, 0);
      if (totalRaw > PDF_IMAGE_EXPORT_LIMITS.MAX_ESTIMATED_ZIP_BYTES) {
        setExportError(
          `Rendered images total ${formatBytes(totalRaw)}, exceeding the ${formatBytes(PDF_IMAGE_EXPORT_LIMITS.MAX_ESTIMATED_ZIP_BYTES)} in-browser ZIP limit. Download pages individually instead.`,
        );
        return;
      }

      const zipEntries: Record<string, Uint8Array> = {};
      for (const img of exportedImages) {
        zipEntries[img.filename] = new Uint8Array(await img.blob.arrayBuffer());
      }
      // PNG/JPEG are already compressed; level 0 packs instantaneously with minimal memory
      const zippedBytes = zipSync(zipEntries, { level: 0 });
      const zipBuffer = zippedBytes.buffer.slice(
        zippedBytes.byteOffset,
        zippedBytes.byteOffset + zippedBytes.byteLength,
      ) as ArrayBuffer;
      const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const base = sanitizePdfExportBaseName(filename);
      triggerBlobDownload(zipUrl, `${base}-pages.zip`);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to bundle images into ZIP.');
    } finally {
      setZipBusy(false);
    }
  };

  const actualTotalBytes = exportedImages.reduce((sum, img) => sum + img.sizeBytes, 0);
  const progressPct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <div className="p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Export PDF pages as images
        </h3>
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          Renders each selected page sequentially inside your browser as a separate, readable image
          file (for example{' '}
          <code className="font-mono text-slate-800 dark:text-slate-200">
            {formatPageExportFilename(filename, 1, format)}
          </code>
          ) without altering the original PDF or running OCR.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
        <strong className="font-semibold text-slate-900 dark:text-slate-100">
          Local conversion &amp; manual upload:
        </strong>{' '}
        Pages are rendered in your browser and are never sent to an AI model or external service.
        You download these images and upload them manually if needed. Image conversion is suitable
        only when the destination service permits submitting this document&rsquo;s content as
        images&mdash;do not use conversion to bypass restrictions on processing the content itself.
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <fieldset className="rounded-lg border border-slate-200 p-3.5 space-y-2.5 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
            Pages to export
          </legend>
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-scope"
              checked={scope === 'all'}
              disabled={isExporting}
              onChange={() => setScope('all')}
            />
            <span>All pages (1&ndash;{totalPages})</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-scope"
              checked={scope === 'current'}
              disabled={isExporting}
              onChange={() => setScope('current')}
            />
            <span>Current page (Page {currentPage})</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-scope"
              checked={scope === 'range'}
              disabled={isExporting}
              onChange={() => setScope('range')}
            />
            <span>Page range</span>
          </label>
          {scope === 'range' && (
            <div className="pt-1">
              <label htmlFor="image-export-range-input" className="sr-only">
                Page range for image export
              </label>
              <input
                id="image-export-range-input"
                type="text"
                disabled={isExporting}
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                placeholder="e.g. 1-3, 5"
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-3.5 space-y-2.5 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
            Image format
          </legend>
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-format"
              checked={format === 'png'}
              disabled={isExporting}
              onChange={() => setFormat('png')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">PNG</strong> (.png)
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                Lossless sharp text &amp; diagrams
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-format"
              checked={format === 'jpeg'}
              disabled={isExporting}
              onChange={() => setFormat('jpeg')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">JPEG</strong> (.jpg)
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                Smaller files for scanned photos
              </span>
            </span>
          </label>
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-3.5 space-y-2.5 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
            Resolution
          </legend>
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-res"
              checked={resolution === 'standard'}
              disabled={isExporting}
              onChange={() => setResolution('standard')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">Standard</strong> (1.5&times; &middot; ~108 DPI)
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                Balanced speed &amp; file size
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="radio"
              name="img-export-res"
              checked={resolution === 'high'}
              disabled={isExporting}
              onChange={() => setResolution('high')}
              className="mt-0.5"
            />
            <span>
              <strong className="font-semibold">High</strong> (2.5&times; &middot; ~180 DPI)
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                Crisper small print, larger files
              </span>
            </span>
          </label>
        </fieldset>
      </div>

      {preflightCheck.ok ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs dark:border-slate-800 dark:bg-slate-950/50">
          <div className="space-y-0.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
            <div>
              Selected: <strong>{resolvedPages.pages.length}</strong>{' '}
              {resolvedPages.pages.length === 1 ? 'page' : 'pages'}
              {preflightCheck.sampleWidthPx && preflightCheck.sampleHeightPx
                ? ` · ~${preflightCheck.sampleWidthPx}×${preflightCheck.sampleHeightPx} px per page`
                : ''}
            </div>
            {preflightCheck.totalEstBytes !== null && preflightCheck.perPageEstBytes !== null && (
              <div className="text-slate-500 dark:text-slate-400">
                Estimated size: ~{formatBytes(preflightCheck.perPageEstBytes)}/page (~
                {formatBytes(preflightCheck.totalEstBytes)} total)
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isExporting ? (
              <button
                type="button"
                onClick={handleCancelExport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-800 dark:text-red-400 dark:hover:bg-red-950/50"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Cancel</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleStartExport()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  Render {resolvedPages.pages.length}{' '}
                  {resolvedPages.pages.length === 1 ? 'page image' : 'page images'}
                </span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
        >
          {preflightCheck.error}
        </div>
      )}

      {isExporting && (
        <div
          aria-live="polite"
          className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-950/60"
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700 dark:text-blue-400" aria-hidden="true" />
              <span>
                Rendering page {progress.currentPageNum} ({progress.done + 1} of {progress.total})...
              </span>
            </span>
            <span className="font-mono tabular-nums">{progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-blue-700 dark:bg-blue-500 transition-[width] duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {exportError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
        >
          {exportError}
        </div>
      )}

      {exportedImages.length > 0 && (
        <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-mono tabular-nums">
              Ready: {exportedImages.length} {exportedImages.length === 1 ? 'image' : 'images'} (
              {formatBytes(actualTotalBytes)} total)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {exportedImages.length > 1 && (
                <>
                  <button
                    type="button"
                    disabled={isExporting}
                    onClick={() => void handleDownloadAllIndividually()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download all individually</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExporting || zipBusy}
                    onClick={() => void handleDownloadZip()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                  >
                    <FolderArchive className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {zipBusy ? 'Packing ZIP...' : `Download ZIP (${exportedImages.length} images)`}
                    </span>
                  </button>
                </>
              )}
            </div>
          </div>

          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white max-h-72 overflow-y-auto dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-950/60">
            {exportedImages.map((img) => (
              <li
                key={img.filename}
                className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono font-medium text-slate-900 dark:text-slate-100 truncate">
                    {img.filename}
                  </div>
                  <div className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                    Page {img.pageNumber} &middot; {img.widthPx}&times;{img.heightPx} px &middot;{' '}
                    {formatBytes(img.sizeBytes)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => triggerBlobDownload(img.objectUrl, img.filename)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  <span>Download</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
