import React, { useId, useRef, useState } from 'react';
import { Upload, AlertTriangle, FileArchive, ShieldAlert, Check } from 'lucide-react';
import type {
  AppLimitsInfo,
  ExpiryOption,
  SensitiveFileWarning,
  UploadSuccessPayload,
} from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { inspectZipFileInBrowser } from '../shared/zipInspect.ts';

interface UploadWorkspaceProps {
  limits: AppLimitsInfo | null;
  onUploadSuccess: (payload: UploadSuccessPayload) => void;
}

const EXPIRY_CHOICES: Array<{ value: ExpiryOption; label: string; detail: string }> = [
  { value: '24h', label: '24 hours', detail: 'Auto-deleted after 1 day' },
  { value: '7d', label: '7 days', detail: 'Default retention' },
  { value: '30d', label: '30 days', detail: 'Maximum retention' },
];

export const UploadWorkspace: React.FC<UploadWorkspaceProps> = ({ limits, onUploadSuccess }) => {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspectedCount, setInspectedCount] = useState<number | null>(null);
  const [sensitiveWarnings, setSensitiveWarnings] = useState<SensitiveFileWarning[]>([]);
  const [invalidEntries, setInvalidEntries] = useState<string[]>([]);
  const [confirmedSensitiveUpload, setConfirmedSensitiveUpload] = useState(false);

  const [expiry, setExpiry] = useState<ExpiryOption>('7d');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'processing'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const maxCompressedBytes = limits?.maxCompressedBytes ?? 50 * 1024 * 1024;
  const maxExtractedBytes = limits?.maxExtractedBytes ?? 200 * 1024 * 1024;
  const maxEntryCount = limits?.maxEntryCount ?? 500;

  const handleFileSelection = async (file: File | null) => {
    setErrorMessage(null);
    setConfirmedSensitiveUpload(false);
    setSensitiveWarnings([]);
    setInvalidEntries([]);
    setInspectedCount(null);

    if (!file) {
      setSelectedFile(null);
      return;
    }

    if (file.size === 0) {
      setSelectedFile(null);
      setErrorMessage('The selected file is empty.');
      return;
    }

    if (file.size > maxCompressedBytes) {
      setSelectedFile(null);
      setErrorMessage(
        `Archive is ${formatBytes(file.size)}, which exceeds the ${formatBytes(maxCompressedBytes)} compressed upload limit.`,
      );
      return;
    }

    setSelectedFile(file);

    try {
      const inspection = await inspectZipFileInBrowser(file);
      setInspectedCount(inspection.fileCount);
      setSensitiveWarnings(inspection.sensitiveWarnings);
      setInvalidEntries(inspection.invalidEntries);
    } catch {
      // Server performs authoritative ZIP validation
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    const dropped = e.dataTransfer.files?.[0] ?? null;
    void handleFileSelection(dropped);
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || isUploading) return;

    if (sensitiveWarnings.length > 0 && !confirmedSensitiveUpload) {
      setErrorMessage('Please confirm the sensitive-file warning before publishing.');
      return;
    }

    setErrorMessage(null);
    setIsUploading(true);
    setUploadPercent(0);
    setUploadPhase('uploading');

    const formData = new FormData();
    formData.append('archive', selectedFile);
    formData.append('expiry', expiry);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/shares');
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
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && body && body.shareId) {
        onUploadSuccess(body as UploadSuccessPayload);
        return;
      }
      const serverError =
        body && typeof body.error === 'string'
          ? body.error
          : `Upload failed with status ${xhr.status}.`;
      setErrorMessage(serverError);
    };

    xhr.onerror = () => {
      setIsUploading(false);
      setUploadPhase('idle');
      setErrorMessage('Network error while uploading the archive. Please try again.');
    };

    xhr.send(formData);
  };

  const canPublish =
    Boolean(selectedFile) &&
    !isUploading &&
    (sensitiveWarnings.length === 0 || confirmedSensitiveUpload);

  return (
    <div className="space-y-14">
      <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
        <div className="space-y-5">
          <h1
            className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl lg:text-[42px] lg:leading-[1.12]"
            style={{ textWrap: 'balance' }}
          >
            Turn any ZIP archive into an expiring share page and context.md
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-slate-600">
            Upload a ZIP file to safely extract its contents on the server into an unlisted,
            expiring web page with a browsable file tree, individual file downloads, and a
            deterministic <code className="font-mono text-sm text-slate-800">context.md</code> built
            from readable UTF-8 text files.
          </p>

          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">Before you upload</div>
            <ul className="space-y-2 leading-relaxed text-slate-600">
              <li>
                <strong className="font-medium text-slate-900">Unlisted is not private:</strong>{' '}
                Anyone who has the generated URL can view and download every file in the archive.
                Share pages are marked <code className="font-mono text-xs">noindex</code> and are
                not listed publicly.
              </li>
              <li>
                <strong className="font-medium text-slate-900">AI link compatibility:</strong> A
                share URL only works in AI tools that support opening external URLs. If your AI
                tool cannot fetch links, copy or download{' '}
                <code className="font-mono text-xs">context.md</code> directly instead.
              </li>
              <li>
                <strong className="font-medium text-slate-900">No malware scanning:</strong>{' '}
                ZipLink validates archive structure and enforces strict extraction limits, but does
                not run antivirus or malware scans on uploaded files.
              </li>
            </ul>
          </div>
        </div>

        <form
          onSubmit={handleUploadSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-6"
          aria-label="Upload ZIP archive"
        >
          <div>
            <label
              htmlFor={fileInputId}
              className="block text-sm font-semibold text-slate-900 mb-2"
            >
              1. Choose ZIP archive
            </label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!isUploading) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
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
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  void handleFileSelection(file);
                }}
                className="sr-only"
              />

              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700">
                {selectedFile ? (
                  <FileArchive className="h-5 w-5 text-blue-700" aria-hidden="true" />
                ) : (
                  <Upload className="h-5 w-5" aria-hidden="true" />
                )}
              </div>

              {selectedFile ? (
                <div className="mt-3 space-y-1">
                  <div className="font-medium text-slate-900 break-all">{selectedFile.name}</div>
                  <div className="font-mono text-xs tabular-nums text-slate-500">
                    {formatBytes(selectedFile.size)}
                    {inspectedCount !== null ? ` · ${inspectedCount} files detected` : ''}
                  </div>
                  <div className="pt-2">
                    <button
                      type="button"
                      disabled={isUploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="text-sm font-medium text-blue-700 hover:text-blue-800 hover:underline focus-visible:outline-2 focus-visible:outline-blue-700"
                    >
                      Choose a different ZIP
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <p className="text-sm text-slate-700">
                    Drag and drop a <code className="font-mono text-xs">.zip</code> file here, or
                  </p>
                  <button
                    type="button"
                    disabled={isUploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-700"
                  >
                    Browse files
                  </button>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    Max {formatBytes(maxCompressedBytes)} compressed · {formatBytes(maxExtractedBytes)} extracted · {maxEntryCount} entries
                  </p>
                </div>
              )}
            </div>
          </div>

          {invalidEntries.length > 0 && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 space-y-1"
            >
              <div className="font-semibold flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                Unsafe paths detected in archive
              </div>
              <p className="text-red-800">
                This archive contains unsafe entry paths (such as <code className="font-mono text-xs">../</code> or absolute paths) and will be rejected on upload.
              </p>
            </div>
          )}

          {sensitiveWarnings.length > 0 && (
            <div
              role="region"
              aria-label="Sensitive file warning"
              className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 space-y-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <div className="space-y-1">
                  <div className="font-semibold">
                    Likely sensitive files detected ({sensitiveWarnings.length})
                  </div>
                  <p className="text-amber-900 leading-relaxed">
                    Anyone with the share link will be able to read and download these files.
                    Consider removing them from your ZIP before uploading.
                  </p>
                </div>
              </div>

              <ul className="max-h-32 overflow-y-auto rounded-md border border-amber-200 bg-white/80 px-3 py-2 space-y-1 font-mono text-xs text-amber-950">
                {sensitiveWarnings.map((w) => (
                  <li key={w.relativePath} className="truncate" title={`${w.relativePath}: ${w.reason}`}>
                    {w.relativePath} — {w.reason}
                  </li>
                ))}
              </ul>

              <p className="text-xs text-amber-900">
                Note: This warning only checks common filenames (such as <code className="font-mono">.env</code>, private keys, and credential files). It is not a complete secrets scan.
              </p>

              <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  checked={confirmedSensitiveUpload}
                  onChange={(e) => setConfirmedSensitiveUpload(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-amber-400 text-blue-700 focus:ring-blue-700"
                />
                <span className="text-xs font-medium text-amber-950">
                  I understand these files will be accessible via the unlisted share URL and want to publish anyway.
                </span>
              </label>
            </div>
          )}

          <fieldset>
            <legend className="text-sm font-semibold text-slate-900 mb-2">
              2. Link expiration
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {EXPIRY_CHOICES.map((choice) => {
                const selected = expiry === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    disabled={isUploading}
                    aria-pressed={selected}
                    onClick={() => setExpiry(choice.value)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 ${
                      selected
                        ? 'border-blue-700 bg-blue-50 text-blue-950'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 text-sm font-semibold">
                      <span className="whitespace-nowrap">{choice.label}</span>
                      {selected && <Check className="h-3.5 w-3.5 text-blue-700 shrink-0" aria-hidden="true" />}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 leading-tight">
                      {choice.detail}
                    </div>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {isUploading && (
            <div aria-live="polite" className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>
                  {uploadPhase === 'processing'
                    ? 'Validating and extracting archive on server...'
                    : 'Uploading ZIP archive...'}
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

          {errorMessage && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            >
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={!canPublish}
            className="w-full rounded-lg bg-blue-700 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            {isUploading ? 'Processing...' : 'Create share link'}
          </button>
        </form>
      </section>

      <section id="how-it-works" className="border-t border-slate-200 pt-10 space-y-6">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">How ZipLink works</h2>
          <p className="text-sm text-slate-600">
            Deterministic server-side extraction with no AI calls during upload or conversion.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2">
            <div className="text-sm font-semibold text-slate-900">01. Safe server extraction</div>
            <p className="text-sm leading-relaxed text-slate-600">
              Archives are streamed inside an isolated temporary directory. Malformed, encrypted,
              symlinked, or traversal-containing ZIPs are rejected immediately.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2">
            <div className="text-sm font-semibold text-slate-900">02. Deterministic context.md</div>
            <p className="text-sm leading-relaxed text-slate-600">
              Readable UTF-8 files are combined under path headings within a strict size budget,
              while binaries and oversized files are explicitly listed as omitted.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-2">
            <div className="text-sm font-semibold text-slate-900">03. Automatic expiration</div>
            <p className="text-sm leading-relaxed text-slate-600">
              Files are stored under generated internal IDs and permanently removed when their
              expiration arrives or when you trigger your one-time delete link.
            </p>
          </div>
        </div>
      </section>

      <section id="limits" className="border-t border-slate-200 pt-10 space-y-6">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Security &amp; limits</h2>
          <p className="text-sm text-slate-600">
            Enforced server-side during upload and streaming decompression.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <dl className="divide-y divide-slate-200 text-sm">
            <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3">
              <dt className="font-medium text-slate-900">Max compressed ZIP upload</dt>
              <dd className="font-mono tabular-nums text-slate-600 sm:col-span-2">
                {formatBytes(maxCompressedBytes)}
              </dd>
            </div>
            <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3">
              <dt className="font-medium text-slate-900">Max extracted archive size</dt>
              <dd className="font-mono tabular-nums text-slate-600 sm:col-span-2">
                {formatBytes(maxExtractedBytes)} (enforced mid-stream against ZIP bombs)
              </dd>
            </div>
            <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3">
              <dt className="font-medium text-slate-900">Max archive entries</dt>
              <dd className="font-mono tabular-nums text-slate-600 sm:col-span-2">
                {maxEntryCount} entries (nested ZIPs are stored raw, never recursively extracted)
              </dd>
            </div>
            <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3">
              <dt className="font-medium text-slate-900">Active content handling</dt>
              <dd className="text-slate-600 sm:col-span-2">
                HTML, JS, and SVG files are rendered strictly as escaped plain text in previews and
                served as sandboxed downloads with <code className="font-mono text-xs">nosniff</code>.
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
};
