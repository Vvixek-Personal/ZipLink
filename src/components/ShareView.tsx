import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileWarning,
  ShieldCheck,
} from 'lucide-react';
import type { PublicShareMetadata, ShareFileEntry } from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { formatUtcDate } from '../utils/fileTree.ts';
import { FileTree } from './FileTree.tsx';

interface ShareViewProps {
  shareId: string;
  onNavigateHome: () => void;
}

type SelectedView =
  | { kind: 'context' }
  | { kind: 'manifest' }
  | { kind: 'file'; fileId: string };

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback
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

export const ShareView: React.FC<ShareViewProps> = ({ shareId, onNavigateHome }) => {
  const [share, setShare] = useState<PublicShareMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);

  const [selectedView, setSelectedView] = useState<SelectedView>({ kind: 'context' });
  const [contextMd, setContextMd] = useState<string | null>(null);
  const [manifestJson, setManifestJson] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<{
    fileId: string;
    content: string | null;
    error: string | null;
    loading: boolean;
  }>({ fileId: '', content: null, error: null, loading: false });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const previewSectionRef = useRef<HTMLElement>(null);

  const scrollPreviewOnMobile = () => {
    if (window.innerWidth < 1024) {
      previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setShare(null);
    setContextMd(null);
    setManifestJson(null);
    setSelectedView({ kind: 'context' });

    const fetchShare = async () => {
      try {
        const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}`);
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          if (!cancelled) {
            setLoadError({
              status: res.status,
              message:
                errBody?.error ||
                (res.status === 410
                  ? 'This share link has expired and its files were deleted.'
                  : 'This share link does not exist, was deleted, or has expired.'),
            });
          }
          return;
        }
        const data = (await res.json()) as PublicShareMetadata;
        if (!cancelled) {
          setShare(data);
        }

        const ctxRes = await fetch(`/api/shares/${encodeURIComponent(shareId)}/context.md`);
        if (ctxRes.ok) {
          const ctxText = await ctxRes.text();
          if (!cancelled) setContextMd(ctxText);
        }
      } catch {
        if (!cancelled) {
          setLoadError({ status: 500, message: 'Failed to load share metadata.' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchShare();
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const handleSelectManifest = async () => {
    setSelectedView({ kind: 'manifest' });
    scrollPreviewOnMobile();
    if (manifestJson !== null) return;
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}/manifest.json`);
      if (res.ok) {
        setManifestJson(await res.text());
      }
    } catch {
      // handled gracefully
    }
  };

  const handleSelectFile = async (file: ShareFileEntry) => {
    setSelectedView({ kind: 'file', fileId: file.id });
    scrollPreviewOnMobile();

    if (!file.isText) {
      setFilePreview({
        fileId: file.id,
        content: null,
        error: null,
        loading: false,
      });
      return;
    }

    setFilePreview({ fileId: file.id, content: null, error: null, loading: true });
    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}/preview`,
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setFilePreview({
          fileId: file.id,
          content: null,
          error: errBody?.error || 'Preview unavailable for this file.',
          loading: false,
        });
        return;
      }
      const data = (await res.json()) as { content: string };
      setFilePreview({
        fileId: file.id,
        content: data.content,
        error: null,
        loading: false,
      });
    } catch {
      setFilePreview({
        fileId: file.id,
        content: null,
        error: 'Failed to load file preview.',
        loading: false,
      });
    }
  };

  const triggerCopy = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading shared archive">
        <div className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white" />
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white" />
          <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white" />
        </div>
      </div>
    );
  }

  if (loadError || !share) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 space-y-4">
        <div className="flex items-center gap-3 text-slate-900">
          <FileWarning className="h-6 w-6 text-amber-700 shrink-0" aria-hidden="true" />
          <h1 className="text-xl font-bold tracking-tight">
            {loadError?.status === 410 ? 'Share link expired' : 'Share link unavailable'}
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-slate-600">
          {loadError?.message || 'This share link could not be found.'}
        </p>
        <div className="pt-2">
          <button
            type="button"
            onClick={onNavigateHome}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            Create a new share
          </button>
        </div>
      </div>
    );
  }

  const activeFile =
    selectedView.kind === 'file'
      ? share.files.find((f) => f.id === selectedView.fileId) ?? null
      : null;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5 min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 break-all">
              {share.archiveName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono tabular-nums text-slate-600">
              <span>{share.totalFiles} files</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(share.totalExtractedBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{share.contextIncludedCount} in context.md</span>
              {share.contextOmittedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{share.contextOmittedCount} omitted</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>Expires {formatUtcDate(share.expiresAt)}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void triggerCopy('shareLink', window.location.href)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-700"
            >
              {copiedId === 'shareLink' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                  <span>Link copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy share URL</span>
                </>
              )}
            </button>
            <a
              href={`/s/${encodeURIComponent(share.shareId)}/context.md?download=1`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-700"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download context.md</span>
            </a>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700">
          <strong className="font-semibold text-slate-900">Unlisted share:</strong> Anyone with
          this URL can view and download these files. Unlisted does not mean private. Files are not
          malware-scanned and are permanently deleted after{' '}
          <span className="font-mono">{formatUtcDate(share.expiresAt)}</span>.
        </div>

        {share.sensitiveWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-700 shrink-0" aria-hidden="true" />
            <div>
              <span className="font-semibold">
                Sensitive filename notice ({share.sensitiveWarnings.length}):
              </span>{' '}
              This archive contains filenames that often hold secrets (such as{' '}
              <code className="font-mono">{share.sensitiveWarnings[0].relativePath}</code>).
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        <FileTree
          files={share.files}
          selectedView={selectedView}
          onSelectContext={() => {
            setSelectedView({ kind: 'context' });
            scrollPreviewOnMobile();
          }}
          onSelectManifest={() => void handleSelectManifest()}
          onSelectFile={(f) => void handleSelectFile(f)}
        />

        <section
          ref={previewSectionRef}
          aria-label="File preview"
          className="min-w-0 rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          {selectedView.kind === 'context' && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
                <div className="min-w-0">
                  <h2 className="font-mono text-sm font-semibold text-slate-900">context.md</h2>
                  <p className="text-xs text-slate-500">
                    Combined readable text files with omitted files listed at the bottom
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {contextMd !== null && (
                    <button
                      type="button"
                      onClick={() => void triggerCopy('contextMd', contextMd)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      {copiedId === 'contextMd' ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  )}
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/context.md`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    <span>Raw URL</span>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              </div>
              <pre className="max-h-[680px] overflow-auto p-5 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                <code>{contextMd ?? 'Loading context.md...'}</code>
              </pre>
            </div>
          )}

          {selectedView.kind === 'manifest' && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
                <div>
                  <h2 className="font-mono text-sm font-semibold text-slate-900">manifest.json</h2>
                  <p className="text-xs text-slate-500">
                    Machine-readable index of extracted files, sizes, hashes, and omissions
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {manifestJson !== null && (
                    <button
                      type="button"
                      onClick={() => void triggerCopy('manifestJson', manifestJson)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      {copiedId === 'manifestJson' ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  )}
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/manifest.json?download=1`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download</span>
                  </a>
                </div>
              </div>
              <pre className="max-h-[680px] overflow-auto p-5 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                <code>{manifestJson ?? 'Loading manifest.json...'}</code>
              </pre>
            </div>
          )}

          {selectedView.kind === 'file' && activeFile && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
                <div className="min-w-0 space-y-0.5">
                  <h2 className="font-mono text-sm font-semibold text-slate-900 break-all">
                    {activeFile.relativePath}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-500">
                    <span>{formatBytes(activeFile.sizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{activeFile.isText ? 'UTF-8 text' : 'Binary / non-text'}</span>
                    {!activeFile.includedInContextMd && activeFile.omissionReason && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Omitted from context.md ({activeFile.omissionReason})</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {filePreview.content !== null && (
                    <button
                      type="button"
                      onClick={() => void triggerCopy(`file:${activeFile.id}`, filePreview.content!)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      {copiedId === `file:${activeFile.id}` ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy text</span>
                        </>
                      )}
                    </button>
                  )}
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/files/${encodeURIComponent(activeFile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download file</span>
                  </a>
                </div>
              </div>

              {activeFile.isActiveContent && (
                <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-xs text-slate-600">
                  <ShieldCheck className="h-4 w-4 text-blue-700 shrink-0" aria-hidden="true" />
                  <span>
                    Safe text preview: active web content (HTML, JS, SVG, XML) is displayed strictly
                    as escaped plain text and never executed.
                  </span>
                </div>
              )}

              {!activeFile.isText ? (
                <div className="p-8 text-center space-y-3">
                  <p className="text-sm text-slate-700">
                    This file is binary or non-UTF-8 ({activeFile.omissionReason || 'binary file'})
                    and cannot be previewed inline.
                  </p>
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/files/${encodeURIComponent(activeFile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download {activeFile.relativePath.split('/').pop()}</span>
                  </a>
                </div>
              ) : filePreview.loading ? (
                <div className="p-8 text-sm text-slate-500">Loading preview...</div>
              ) : filePreview.error ? (
                <div className="p-8 text-sm text-slate-700 space-y-3">
                  <p>{filePreview.error}</p>
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/files/${encodeURIComponent(activeFile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download file instead</span>
                  </a>
                </div>
              ) : (
                <pre
                  data-testid="safe-text-preview"
                  className="max-h-[680px] overflow-auto p-5 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words"
                >
                  <code>{filePreview.content ?? ''}</code>
                </pre>
              )}
            </div>
          )}
        </section>
      </div>

      <div aria-live="polite" className="sr-only">
        {copiedId ? 'Copied to clipboard.' : ''}
      </div>
    </div>
  );
};
