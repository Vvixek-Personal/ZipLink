import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Maximize2,
  Minimize2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  ShieldCheck,
  Smartphone,
  Tablet,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AppLimitsInfo,
  CreatePreviewResponse,
  PreviewFileEntry,
  PublicPreviewSession,
} from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { formatUtcDate } from '../utils/fileTree.ts';
import { PreviewFileExplorer } from './PreviewFileExplorer.tsx';

interface PreviewWorkspaceProps {
  limits: AppLimitsInfo | null;
  activeSession: { preview: PublicPreviewSession; ownerToken: string } | null;
  onSessionChange: (session: { preview: PublicPreviewSession; ownerToken: string } | null) => void;
}

type ViewportMode = 'desktop' | 'tablet' | 'mobile';
type ZoomLevel = 0.5 | 0.75 | 1 | 1.25;

function encodeArchivePath(relPath: string): string {
  return relPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export const PreviewWorkspace: React.FC<PreviewWorkspaceProps> = ({
  limits,
  activeSession,
  onSessionChange,
}) => {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'processing'>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Preview browser state
  const [currentHtmlPath, setCurrentHtmlPath] = useState<string>('');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [iframeLoading, setIframeLoading] = useState(false);
  const [iframeError, setIframeError] = useState<string | null>(null);

  const [viewport, setViewport] = useState<ViewportMode>('desktop');
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const preview = activeSession?.preview ?? null;

  const maxCompressedBytes = limits?.maxCompressedBytes ?? 50 * 1024 * 1024;
  const maxExtractedBytes = limits?.maxExtractedBytes ?? 200 * 1024 * 1024;
  const maxEntryCount = limits?.maxEntryCount ?? 500;

  // Initialize navigation when a new preview session becomes active
  useEffect(() => {
    if (!preview) {
      setCurrentHtmlPath('');
      setSelectedFilePath('');
      setPathHistory([]);
      setIsFullscreen(false);
      return;
    }
    setCurrentHtmlPath(preview.defaultEntryPoint);
    setSelectedFilePath(preview.defaultEntryPoint);
    setPathHistory([preview.defaultEntryPoint]);
    setIframeLoading(true);
    setIframeError(null);
    setReloadNonce((n) => n + 1);
  }, [preview?.previewId]);

  // Listen for passive navigation notifications from the sandboxed iframe
  useEffect(() => {
    if (!preview) return;
    const sitePrefixMarker = `/p/${encodeURIComponent(preview.previewId)}/`;

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; pathname?: string } | null;
      if (!data || data.type !== 'ziplink-preview-nav' || typeof data.pathname !== 'string') {
        return;
      }

      const siteIdx = data.pathname.indexOf('/site/');
      if (siteIdx === -1 || !data.pathname.includes(sitePrefixMarker)) return;
      const rawRel = data.pathname.slice(siteIdx + '/site/'.length);
      let decodedRel = '';
      try {
        decodedRel = rawRel
          .split('/')
          .filter(Boolean)
          .map((s) => decodeURIComponent(s))
          .join('/');
      } catch {
        return;
      }
      if (!decodedRel) {
        decodedRel = preview.defaultEntryPoint;
      }

      const matched = preview.files.find((f) => f.relativePath === decodedRel);
      const resolvedPath = matched
        ? matched.relativePath
        : preview.files.find((f) => f.relativePath === `${decodedRel}/index.html`)?.relativePath ||
          decodedRel;

      setCurrentHtmlPath(resolvedPath);
      setSelectedFilePath(resolvedPath);
      setPathHistory((prev) =>
        prev[prev.length - 1] === resolvedPath ? prev : [...prev, resolvedPath],
      );
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [preview]);

  // Escape key exits fullscreen mode
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const navigateToHtmlPage = (relPath: string) => {
    setIframeError(null);
    setIframeLoading(true);
    setCurrentHtmlPath(relPath);
    setSelectedFilePath(relPath);
    setPathHistory((prev) => (prev[prev.length - 1] === relPath ? prev : [...prev, relPath]));
    setReloadNonce((n) => n + 1);
  };

  const handleBack = () => {
    if (pathHistory.length <= 1) return;
    const nextHistory = pathHistory.slice(0, -1);
    const target = nextHistory[nextHistory.length - 1];
    setPathHistory(nextHistory);
    setCurrentHtmlPath(target);
    setSelectedFilePath(target);
    setIframeLoading(true);
    setIframeError(null);
    setReloadNonce((n) => n + 1);
  };

  const handleRefresh = () => {
    setIframeLoading(true);
    setIframeError(null);
    setReloadNonce((n) => n + 1);
  };

  const handleFileUpload = (file: File | null) => {
    setUploadError(null);
    if (!file || isUploading) return;

    if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip') {
      setUploadError('Please select a valid .zip archive file.');
      return;
    }

    if (file.size === 0) {
      setUploadError('The selected ZIP file is empty.');
      return;
    }

    if (file.size > maxCompressedBytes) {
      setUploadError(
        `Archive is ${formatBytes(file.size)}, which exceeds the ${formatBytes(maxCompressedBytes)} compressed upload limit.`,
      );
      return;
    }

    setIsUploading(true);
    setUploadPercent(0);
    setUploadPhase('uploading');

    const formData = new FormData();
    formData.append('archive', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/previews');
    xhr.responseType = 'json';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
        setUploadPercent(pct);
        if (pct >= 100) {
          setUploadPhase('processing');
        }
      }
    };

    xhr.upload.onload = () => {
      setUploadPercent(100);
      setUploadPhase('processing');
    };

    xhr.onload = () => {
      setIsUploading(false);
      setUploadPhase('idle');
      const body = xhr.response as CreatePreviewResponse | { error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && 'preview' in body) {
        // Remove previous temporary preview in background if replacing
        if (activeSession) {
          fetch(`/api/previews/${encodeURIComponent(activeSession.preview.previewId)}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${activeSession.ownerToken}`,
            },
          }).catch(() => undefined);
        }
        onSessionChange({ preview: body.preview, ownerToken: body.ownerToken });
        return;
      }

      const message =
        body && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `Upload failed with status ${xhr.status}.`;
      setUploadError(message);
    };

    xhr.onerror = () => {
      setIsUploading(false);
      setUploadPhase('idle');
      setUploadError('Network error while uploading the website ZIP. Please try again.');
    };

    xhr.send(formData);
  };

  const handleRemovePreview = async () => {
    if (!activeSession || isRemoving) return;
    setIsRemoving(true);
    try {
      await fetch(`/api/previews/${encodeURIComponent(activeSession.preview.previewId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${activeSession.ownerToken}`,
        },
      });
    } catch {
      // Clear local session regardless
    } finally {
      setIsRemoving(false);
      onSessionChange(null);
      setUploadError(null);
    }
  };

  const iframeSrc = useMemo(() => {
    if (!preview || !currentHtmlPath) return '';
    const encoded = encodeArchivePath(currentHtmlPath);
    const separator = reloadNonce > 0 ? `?r=${reloadNonce}` : '';
    return `${preview.siteBaseUrl}/${encoded}${separator}`;
  }, [preview, currentHtmlPath, reloadNonce]);

  const directTabUrl = useMemo(() => {
    if (!preview || !currentHtmlPath) return '';
    return `${preview.siteBaseUrl}/${encodeArchivePath(currentHtmlPath)}`;
  }, [preview, currentHtmlPath]);

  const viewportFrameStyle = useMemo((): React.CSSProperties => {
    const baseWidth = viewport === 'mobile' ? 375 : viewport === 'tablet' ? 768 : undefined;
    if (!baseWidth) {
      return {
        width: zoom === 1 ? '100%' : `${100 / zoom}%`,
        height: zoom === 1 ? '100%' : `${100 / zoom}%`,
        transform: zoom === 1 ? undefined : `scale(${zoom})`,
        transformOrigin: 'top left',
      };
    }
    return {
      width: `${baseWidth}px`,
      height: zoom === 1 ? '100%' : `${100 / zoom}%`,
      transform: zoom === 1 ? undefined : `scale(${zoom})`,
      transformOrigin: 'top left',
    };
  }, [viewport, zoom]);

  // Empty / Upload State
  if (!preview) {
    return (
      <div className="space-y-10">
        <section className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div className="space-y-5">
            <h1
              className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl lg:text-[42px] lg:leading-[1.12]"
              style={{ textWrap: 'balance' }}
            >
              Preview static website ZIP archives directly in your browser
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-slate-600">
              Upload a <code className="font-mono text-sm text-slate-800">.zip</code> containing a
              static site or build output (<code className="font-mono text-xs">index.html</code>,{' '}
              <code className="font-mono text-xs">dist/</code>,{' '}
              <code className="font-mono text-xs">build/</code>,{' '}
              <code className="font-mono text-xs">public/</code>). ZipLink extracts it safely and
              renders the live website inside an isolated browser viewport.
            </p>

            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 text-sm text-slate-700">
              <div className="font-semibold text-slate-900">How ZIP Website Preview works</div>
              <ul className="space-y-2 text-slate-600 leading-relaxed">
                <li>
                  <strong className="font-medium text-slate-900">Automatic entry detection:</strong>{' '}
                  Locates <code className="font-mono text-xs">index.html</code> at the root, inside
                  a project folder, or in common build folders, and lets you switch pages when
                  multiple HTML files exist.
                </li>
                <li>
                  <strong className="font-medium text-slate-900">Sandboxed execution:</strong>{' '}
                  Uploaded HTML, CSS, and client-side JavaScript run inside an isolated sandbox
                  without access to ZipLink cookies, storage, or internal APIs. No server-side code
                  or build scripts are ever executed.
                </li>
                <li>
                  <strong className="font-medium text-slate-900">Temporary &amp; private session:</strong>{' '}
                  Preview sessions are scoped to your session token, expire automatically, and can
                  be removed at any time.
                </li>
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="space-y-1">
              <label htmlFor={fileInputId} className="block text-sm font-semibold text-slate-900">
                Upload static website ZIP
              </label>
              <p className="text-xs text-slate-500">
                Supports HTML, CSS, JS, images, fonts, and relative multi-page navigation.
              </p>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!isUploading) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (isUploading) return;
                const dropped = e.dataTransfer.files?.[0] ?? null;
                handleFileUpload(dropped);
              }}
              className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                isDragging
                  ? 'border-blue-700 bg-blue-50/70'
                  : 'border-slate-300 bg-slate-50/60 hover:border-slate-400'
              }`}
            >
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                disabled={isUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  handleFileUpload(file);
                  e.target.value = '';
                }}
                className="hidden"
              />

              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700">
                <Upload className="h-5 w-5" aria-hidden="true" />
              </div>

              <div className="mt-4 space-y-2.5">
                <p className="text-sm text-slate-700">
                  Drag and drop a static site <code className="font-mono text-xs">.zip</code> here, or
                </p>
                <button
                  type="button"
                  disabled={isUploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center justify-center rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-blue-700"
                >
                  Select website ZIP
                </button>
                <p className="pt-1 font-mono text-xs tabular-nums text-slate-500">
                  Max {formatBytes(maxCompressedBytes)} compressed · {formatBytes(maxExtractedBytes)} extracted · {maxEntryCount} entries
                </p>
              </div>
            </div>

            {isUploading && (
              <div
                aria-live="polite"
                className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                  <span>
                    {uploadPhase === 'processing'
                      ? 'Extracting archive & detecting HTML entry point...'
                      : 'Uploading website ZIP...'}
                  </span>
                  <span className="font-mono tabular-nums">{uploadPercent}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-blue-700 transition-[width] duration-150"
                    style={{ width: `${uploadPercent}%` }}
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
              >
                {uploadError}
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-slate-100 p-3 sm:p-4 gap-3'
          : 'space-y-4'
      }
    >
      {/* Top Preview Metadata & Lifecycle Actions */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-base font-bold text-slate-900 truncate">{preview.archiveName}</h1>
            <span className="font-mono text-xs tabular-nums text-slate-500">
              {preview.totalFiles} files · {formatBytes(preview.totalExtractedBytes)} · Expires{' '}
              {formatUtcDate(preview.expiresAt)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <ShieldCheck className="h-3.5 w-3.5 text-blue-700 shrink-0" aria-hidden="true" />
            <span>
              Sandboxed preview{' '}
              {preview.isCrossOriginIsolated
                ? '(dedicated preview origin)'
                : '(isolated opaque origin)'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {preview.entryPoints.length > 1 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="entry-point-select" className="text-xs font-medium text-slate-600">
                Entry
              </label>
              <select
                id="entry-point-select"
                value={
                  preview.entryPoints.some((ep) => ep.relativePath === currentHtmlPath)
                    ? currentHtmlPath
                    : preview.defaultEntryPoint
                }
                onChange={(e) => navigateToHtmlPage(e.target.value)}
                className="max-w-[210px] rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-blue-700 focus:outline-none"
              >
                {preview.entryPoints.map((ep) => (
                  <option key={ep.relativePath} value={ep.relativePath}>
                    {ep.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            disabled={isUploading}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              handleFileUpload(file);
              e.target.value = '';
            }}
            className="hidden"
          />

          <button
            type="button"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isUploading ? `Uploading ${uploadPercent}%` : 'Upload another ZIP'}</span>
          </button>

          <button
            type="button"
            disabled={isRemoving}
            onClick={() => void handleRemovePreview()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 whitespace-nowrap disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isRemoving ? 'Removing...' : 'Remove preview'}</span>
          </button>
        </div>
      </div>

      {uploadError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-900"
        >
          {uploadError}
        </div>
      )}

      {/* Main Split Workspace: Collapsible Explorer + Browser Stage */}
      <div
        className={`grid gap-4 min-h-0 flex-1 ${
          explorerOpen ? 'lg:grid-cols-[280px_1fr] lg:items-start' : 'grid-cols-1'
        }`}
      >
        {explorerOpen && (
          <div className="order-2 lg:order-1">
            <PreviewFileExplorer
              files={preview.files}
              activeHtmlPath={currentHtmlPath}
              selectedFilePath={selectedFilePath}
              onSelectHtmlFile={navigateToHtmlPage}
              onSelectInspectFile={(file: PreviewFileEntry) => setSelectedFilePath(file.relativePath)}
            />
          </div>
        )}

        <section
          aria-label="Live website preview browser"
          className="order-1 lg:order-2 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden min-w-0 flex-1"
        >
          {/* Browser-Style Address & Viewport Controls Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setExplorerOpen((o) => !o)}
                aria-expanded={explorerOpen}
                aria-label={explorerOpen ? 'Collapse file explorer' : 'Expand file explorer'}
                title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-700"
              >
                {explorerOpen ? (
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                disabled={pathHistory.length <= 1}
                onClick={handleBack}
                aria-label="Back to previous page"
                title="Back"
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-700"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={handleRefresh}
                aria-label="Refresh website preview"
                title="Refresh"
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-700"
              >
                <RotateCw
                  className={`h-4 w-4 ${iframeLoading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            {/* Address Bar */}
            <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5">
              <Globe className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              <input
                type="text"
                readOnly
                aria-label="Preview address bar"
                value={`/${currentHtmlPath}`}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full bg-transparent font-mono text-xs text-slate-800 focus:outline-none"
              />
            </div>

            {/* Viewport & Zoom Controls */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <div
                role="group"
                aria-label="Preview viewport size"
                className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5"
              >
                <button
                  type="button"
                  aria-label="Desktop viewport"
                  aria-pressed={viewport === 'desktop'}
                  title="Desktop viewport"
                  onClick={() => setViewport('desktop')}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    viewport === 'desktop'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Tablet viewport"
                  aria-pressed={viewport === 'tablet'}
                  title="Tablet viewport (768px)"
                  onClick={() => setViewport('tablet')}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    viewport === 'tablet'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Tablet className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Mobile viewport"
                  aria-pressed={viewport === 'mobile'}
                  title="Mobile viewport (375px)"
                  onClick={() => setViewport('mobile')}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    viewport === 'mobile'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <label htmlFor="preview-zoom-select" className="sr-only">
                Preview zoom
              </label>
              <select
                id="preview-zoom-select"
                value={String(zoom)}
                onChange={(e) => setZoom(Number(e.target.value) as ZoomLevel)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 focus:border-blue-700 focus:outline-none"
              >
                <option value="0.5">50%</option>
                <option value="0.75">75%</option>
                <option value="1">100%</option>
                <option value="1.25">125%</option>
              </select>

              <a
                href={directTabUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open preview in new tab"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Open tab</span>
              </a>

              <button
                type="button"
                onClick={() => setIsFullscreen((f) => !f)}
                aria-label={isFullscreen ? 'Exit fullscreen preview' : 'Fullscreen preview'}
                title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-700"
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/* Preview Viewport */}
          <div
            className={`relative overflow-auto bg-slate-100 ${
              isFullscreen ? 'flex-1 min-h-0' : 'h-[620px] flex-none'
            } ${viewport === 'desktop' ? 'p-0' : 'p-4 sm:p-6 flex justify-center items-start'}`}
          >
            {iframeLoading && (
              <div
                aria-live="polite"
                className="pointer-events-none absolute right-3 top-3 z-10 rounded-md border border-slate-200 bg-white/95 px-2.5 py-1 text-xs font-medium text-slate-700 shadow-xs"
              >
                Loading preview...
              </div>
            )}

            {iframeError ? (
              <div className="m-auto max-w-md rounded-xl border border-red-200 bg-white p-6 text-center space-y-3">
                <div className="text-sm font-semibold text-red-900">Unable to load preview</div>
                <p className="text-xs text-slate-600">{iframeError}</p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div
                className={
                  viewport === 'desktop'
                    ? 'h-full w-full overflow-auto bg-white'
                    : 'h-full overflow-auto rounded-lg border border-slate-300 bg-white shadow-sm shrink-0'
                }
                style={
                  viewport === 'desktop'
                    ? undefined
                    : {
                        width: `${Math.round((viewport === 'mobile' ? 375 : 768) * zoom)}px`,
                        maxWidth: '100%',
                      }
                }
              >
                <iframe
                  ref={iframeRef}
                  data-testid="website-preview-iframe"
                  title={`Website preview: ${preview.archiveName} (${currentHtmlPath})`}
                  src={iframeSrc || undefined}
                  sandbox={
                    preview.isCrossOriginIsolated
                      ? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
                      : 'allow-scripts allow-forms allow-modals allow-popups'
                  }
                  referrerPolicy="no-referrer"
                  style={viewportFrameStyle}
                  onLoad={() => {
                    setIframeLoading(false);
                    setIframeError(null);
                  }}
                  onError={() => {
                    setIframeLoading(false);
                    setIframeError('The preview frame failed to load.');
                  }}
                  className="block border-0 bg-white"
                />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
