import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Pencil,
} from 'lucide-react';
import type { UploadSuccessPayload } from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { isPdfFilename } from '../shared/pdfUtils.ts';
import { buildSuggestedPrompt, formatUtcDate } from '../utils/fileTree.ts';

interface UploadSuccessProps {
  result: UploadSuccessPayload;
  onOpenShare: (shareId: string, editToken?: string) => void;
  onResetToUpload: () => void;
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export const UploadSuccess: React.FC<UploadSuccessProps> = ({
  result,
  onOpenShare,
  onResetToUpload,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletedDone, setDeletedDone] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const suggestedPrompt = buildSuggestedPrompt(result.contextUrl, result.archiveName);

  const handleCopy = async (key: string, value: string) => {
    const ok = await copyTextSafe(value);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 2200);
    }
  };

  const handleDownloadContextMd = () => {
    const blob = new Blob([result.contextMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'context.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImmediateDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(result.shareId)}`, {
        method: 'DELETE',
        headers: {
          'X-Delete-Token': result.deleteToken,
        },
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || `Delete failed (${res.status}).`);
      }
      setDeletedDone(true);
      setConfirmingDelete(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete share.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (deletedDone) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-8 space-y-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3 text-slate-900 dark:text-slate-100">
          <CheckCircle2 className="h-6 w-6 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
          <h1 className="text-2xl font-bold tracking-tight">Share permanently deleted</h1>
        </div>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          All extracted files, <code className="font-mono text-xs">context.md</code>, and metadata
          for <strong>{result.archiveName}</strong> have been removed from storage. Any existing
          links to this share now return an unavailable error.
        </p>
        <div>
          <button
            type="button"
            onClick={onResetToUpload}
            className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            Upload another ZIP
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 text-sm font-semibold">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Share link ready</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 break-all">
              {result.archiveName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-400 font-mono tabular-nums">
              <span>
                {result.totalFiles} {result.totalFiles === 1 ? 'file' : 'files'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(result.totalExtractedBytes)} extracted</span>
              <span aria-hidden="true">·</span>
              <span>{result.contextIncludedCount} in context.md</span>
              {result.contextOmittedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{result.contextOmittedCount} omitted</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>Expires {formatUtcDate(result.expiresAt)}</span>
            </div>
          </div>

          <div className="flex flex-wrap shrink-0 items-center gap-2">
            {result.totalFiles === 1 && isPdfFilename(result.archiveName) ? (
              <button
                type="button"
                onClick={() => onOpenShare(result.shareId)}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <span>Open PDF reader</span>
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onOpenShare(result.shareId, result.editToken)}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span>Open owner editor</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenShare(result.shareId)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <span>Open read-only share</span>
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">Unlisted, not private:</strong>{' '}
          Anyone with the public share URL can view and download these files in read-only mode until{' '}
          <span className="font-mono">{formatUtcDate(result.expiresAt)}</span>. Only the owner edit
          token grants write access.
        </div>

        {result.sensitiveWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 space-y-1 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
              <span>
                Reminder: {result.sensitiveWarnings.length} sensitive-looking filename(s) included
              </span>
            </div>
            <p className="text-amber-900 dark:text-amber-300">
              If you published this archive by mistake, use the immediate delete button below.
            </p>
          </div>
        )}

        <div className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-800">
          <div className="space-y-1.5">
            <label htmlFor="share-url-input" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Public read-only share URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="share-url-input"
                type="text"
                readOnly
                value={result.shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => void handleCopy('shareUrl', result.shareUrl)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                {copiedKey === 'shareUrl' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Copy share URL</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="context-url-input" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Direct context.md URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="context-url-input"
                type="text"
                readOnly
                value={result.contextUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => void handleCopy('contextUrl', result.contextUrl)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                {copiedKey === 'contextUrl' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Copy context.md URL</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Suggested AI prompt (optional)
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Only works in AI tools that support opening external URLs. Otherwise, copy or
                download <code className="font-mono">context.md</code> below and attach it directly.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleCopy('prompt', suggestedPrompt)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                {copiedKey === 'prompt' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Prompt copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Copy prompt</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3.5 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
            {suggestedPrompt}
          </pre>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleCopy('contextContent', result.contextMd)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copiedKey === 'contextContent' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                  <span>context.md copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy context.md content</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownloadContextMd}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download context.md</span>
            </button>

            <a
              href={result.manifestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline px-2 py-2 dark:text-blue-400 dark:hover:text-blue-300"
            >
              View manifest.json
            </a>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100">
            <KeyRound className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" aria-hidden="true" />
            <h2 className="text-base font-semibold">
              Owner edit link &amp; token (shown once — keep private)
            </h2>
          </div>
          <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
            Keep this private link or token to edit files, view diffs, and restore originals in this
            workspace. The raw token is stored only as a SHA-256 hash on the server and cannot be
            recovered later.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="edit-url-input" className="sr-only">
              Private owner edit URL
            </label>
            <input
              id="edit-url-input"
              type="text"
              readOnly
              value={result.editUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => void handleCopy('editUrl', result.editUrl)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copiedKey === 'editUrl' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy edit link</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-xs text-slate-600 dark:text-slate-400 break-all">
            Edit token: <span className="text-slate-900 dark:text-slate-100 select-all">{result.editToken}</span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              One-time delete link &amp; token (shown once)
            </h2>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Save this link or token now if you want to delete this share before it expires. For
              security, the raw token is not stored on the server and cannot be recovered later.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="delete-url-input" className="sr-only">
              One-time delete URL
            </label>
            <input
              id="delete-url-input"
              type="text"
              readOnly
              value={result.deleteUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => void handleCopy('deleteUrl', result.deleteUrl)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copiedKey === 'deleteUrl' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy delete link</span>
                </>
              )}
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pt-1">
            <div className="font-mono text-xs text-slate-600 dark:text-slate-400 break-all">
              Token: <span className="text-slate-900 dark:text-slate-100 select-all">{result.deleteToken}</span>
            </div>

            {!confirmingDelete ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-300 bg-white px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-slate-800 dark:text-red-400 dark:hover:bg-red-950/50 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Delete immediately</span>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => void handleImmediateDelete()}
                  className="rounded-lg bg-red-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting...' : 'Confirm permanent delete'}
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {deleteError && (
            <div role="alert" className="text-xs text-red-700 dark:text-red-400">
              {deleteError}
            </div>
          )}
        </div>
      </div>

      <div aria-live="polite" className="sr-only">
        {copiedKey ? 'Copied to clipboard.' : ''}
      </div>
    </div>
  );
};
