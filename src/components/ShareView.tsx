import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileWarning,
  GitCompare,
  KeyRound,
  Lock,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  ShieldCheck,
  Undo2,
  WrapText,
} from 'lucide-react';
import type {
  FileConflictPayload,
  FileOriginalPayload,
  FilePreviewPayload,
  PublicShareMetadata,
  SaveFileResponse,
  ShareFileEntry,
} from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { detectLanguageFromPath } from '../shared/language.ts';
import { formatUtcDate } from '../utils/fileTree.ts';
import { FileTree } from './FileTree.tsx';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx';
import { DiffViewer } from './DiffViewer.tsx';
import { ModalDialog } from './ConfirmModal.tsx';

interface ShareViewProps {
  shareId: string;
  initialEditToken?: string;
  effectiveTheme: 'light' | 'dark';
  maxTextPreviewBytes?: number;
  onNavigateHome: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

type SelectedView =
  | { kind: 'context' }
  | { kind: 'manifest' }
  | { kind: 'file'; fileId: string };

type FilePaneMode = 'preview' | 'edit' | 'diff';
type DiffTarget = 'draft-vs-saved' | 'saved-vs-original' | 'draft-vs-conflict';

type PendingAction =
  | { type: 'selectContext' }
  | { type: 'selectManifest' }
  | { type: 'selectFile'; file: ShareFileEntry }
  | { type: 'downloadZip' }
  | { type: 'downloadFile'; file: ShareFileEntry };

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

function triggerUrlDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const ShareView: React.FC<ShareViewProps> = ({
  shareId,
  initialEditToken = '',
  effectiveTheme,
  maxTextPreviewBytes = 512 * 1024,
  onNavigateHome,
  onDirtyChange,
}) => {
  const [share, setShare] = useState<PublicShareMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);

  // Edit authorization state (held in memory / URL hash, never localStorage)
  const [editToken, setEditToken] = useState<string>(initialEditToken);
  const [canEdit, setCanEdit] = useState<boolean>(false);
  const [editAuthError, setEditAuthError] = useState<string | null>(null);
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockChecking, setUnlockChecking] = useState(false);

  const [selectedView, setSelectedView] = useState<SelectedView>({ kind: 'context' });
  const [contextMd, setContextMd] = useState<string | null>(null);
  const [manifestJson, setManifestJson] = useState<string | null>(null);

  // File preview & editing state
  const [fileState, setFileState] = useState<{
    fileId: string;
    savedContent: string | null;
    draftContent: string | null;
    originalContent: string | null;
    sha256: string;
    version: number;
    loading: boolean;
    error: string | null;
  }>({
    fileId: '',
    savedContent: null,
    draftContent: null,
    originalContent: null,
    sha256: '',
    version: 1,
    loading: false,
    error: null,
  });

  const [paneMode, setPaneMode] = useState<FilePaneMode>('preview');
  const [diffTarget, setDiffTarget] = useState<DiffTarget>('draft-vs-saved');
  const [wordWrap, setWordWrap] = useState<boolean>(false);
  const [docResetGen, setDocResetGen] = useState<number>(0);
  const [historyState, setHistoryState] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });

  // Save & restore state
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<FileConflictPayload | null>(null);
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const previewSectionRef = useRef<HTMLElement>(null);
  const editorRef = useRef<CodeEditorHandle>(null);

  const activeFile =
    selectedView.kind === 'file'
      ? share?.files.find((f) => f.id === selectedView.fileId) ?? null
      : null;

  const isDirty = useMemo(() => {
    if (selectedView.kind !== 'file') return false;
    if (fileState.fileId !== selectedView.fileId) return false;
    if (fileState.savedContent === null || fileState.draftContent === null) return false;
    return fileState.draftContent !== fileState.savedContent;
  }, [selectedView, fileState]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Warn browser tab close/refresh when unsaved edits exist
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const scrollPreviewOnMobile = () => {
    if (window.innerWidth < 1024) {
      previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Verify edit token against server
  const verifyEditToken = useCallback(
    async (candidateToken: string): Promise<boolean> => {
      if (!candidateToken.trim()) {
        setCanEdit(false);
        return false;
      }
      try {
        const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}/edit-auth`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${candidateToken.trim()}`,
          },
        });
        if (res.ok) {
          setEditToken(candidateToken.trim());
          setCanEdit(true);
          setEditAuthError(null);
          return true;
        }
        const errBody = await res.json().catch(() => null);
        setCanEdit(false);
        setEditAuthError(errBody?.error || 'Invalid owner edit token.');
        return false;
      } catch {
        setCanEdit(false);
        setEditAuthError('Could not verify edit token.');
        return false;
      }
    },
    [shareId],
  );

  // Sync initialEditToken changes from URL hash
  useEffect(() => {
    if (initialEditToken) {
      setEditToken(initialEditToken);
      void verifyEditToken(initialEditToken);
    } else {
      setEditToken('');
      setCanEdit(false);
      setEditAuthError(null);
    }
  }, [initialEditToken, verifyEditToken]);

  // Initial share metadata + context.md load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setShare(null);
    setContextMd(null);
    setManifestJson(null);
    setSelectedView({ kind: 'context' });
    setPaneMode('preview');
    setSaveStatus('idle');
    setSaveError(null);
    setConflictState(null);

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

  const loadContextMd = async (forceRefresh = false) => {
    if (!forceRefresh && contextMd !== null) return;
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}/context.md`);
      if (res.ok) {
        setContextMd(await res.text());
      }
    } catch {
      // handled gracefully
    }
  };

  const loadManifestJson = async (forceRefresh = false) => {
    if (!forceRefresh && manifestJson !== null) return;
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}/manifest.json`);
      if (res.ok) {
        setManifestJson(await res.text());
      }
    } catch {
      // handled gracefully
    }
  };

  const executeSelectContext = () => {
    setSelectedView({ kind: 'context' });
    setPaneMode('preview');
    setConflictState(null);
    setSaveError(null);
    scrollPreviewOnMobile();
    void loadContextMd();
  };

  const executeSelectManifest = () => {
    setSelectedView({ kind: 'manifest' });
    setPaneMode('preview');
    setConflictState(null);
    setSaveError(null);
    scrollPreviewOnMobile();
    void loadManifestJson();
  };

  const executeSelectFile = async (file: ShareFileEntry) => {
    setSelectedView({ kind: 'file', fileId: file.id });
    setPaneMode('preview');
    setSaveStatus('idle');
    setSaveError(null);
    setConflictState(null);
    scrollPreviewOnMobile();

    if (!file.isText) {
      setFileState({
        fileId: file.id,
        savedContent: null,
        draftContent: null,
        originalContent: null,
        sha256: file.sha256,
        version: file.version,
        loading: false,
        error: null,
      });
      return;
    }

    setFileState({
      fileId: file.id,
      savedContent: null,
      draftContent: null,
      originalContent: null,
      sha256: file.sha256,
      version: file.version,
      loading: true,
      error: null,
    });

    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}/preview`,
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setFileState((prev) => ({
          ...prev,
          loading: false,
          error: errBody?.error || 'Preview unavailable for this file.',
        }));
        return;
      }
      const data = (await res.json()) as FilePreviewPayload;
      setFileState({
        fileId: file.id,
        savedContent: data.content,
        draftContent: data.content,
        originalContent: data.isEdited ? null : data.content,
        sha256: data.sha256,
        version: data.version,
        loading: false,
        error: null,
      });
      setDocResetGen((g) => g + 1);
    } catch {
      setFileState((prev) => ({
        ...prev,
        loading: false,
        error: 'Failed to load file preview.',
      }));
    }
  };

  const ensureOriginalLoaded = async (fileId: string): Promise<string | null> => {
    if (fileState.fileId === fileId && fileState.originalContent !== null) {
      return fileState.originalContent;
    }
    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}/original`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as FileOriginalPayload;
      setFileState((prev) =>
        prev.fileId === fileId ? { ...prev, originalContent: data.content } : prev,
      );
      return data.content;
    } catch {
      return null;
    }
  };

  const handleSaveCurrentFile = useCallback(
    async (overrideExpected?: { sha256: string; version: number }): Promise<boolean> => {
      if (!canEdit || !activeFile || !activeFile.isText) return false;
      if (fileState.fileId !== activeFile.id || fileState.draftContent === null) return false;

      setSaveStatus('saving');
      setSaveError(null);

      const expectedSha256 = overrideExpected?.sha256 ?? fileState.sha256;
      const expectedVersion = overrideExpected?.version ?? fileState.version;

      try {
        const res = await fetch(
          `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(activeFile.id)}`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${editToken}`,
            },
            body: JSON.stringify({
              content: fileState.draftContent,
              expectedSha256,
              expectedVersion,
            }),
          },
        );

        if (res.status === 409) {
          const conflict = (await res.json()) as FileConflictPayload;
          setConflictState(conflict);
          setSaveStatus('error');
          setSaveError(conflict.error);
          return false;
        }

        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
          throw new Error(data?.error || `Save failed (${res.status}).`);
        }

        const saved = data as SaveFileResponse;
        setShare(saved.share);
        setConflictState(null);
        setFileState((prev) => ({
          ...prev,
          savedContent: saved.content,
          draftContent: saved.content,
          sha256: saved.file.sha256,
          version: saved.file.version,
        }));
        setSaveStatus('saved');
        setSaveError(null);

        // Keep generated outputs up to date
        setContextMd(null);
        setManifestJson(null);
        void loadContextMd(true);
        void loadManifestJson(true);

        return true;
      } catch (err) {
        setSaveStatus('error');
        setSaveError(err instanceof Error ? err.message : 'Failed to save changes.');
        return false;
      }
    },
    [canEdit, activeFile, fileState, shareId, editToken],
  );

  const handleDiscardChanges = () => {
    if (fileState.savedContent === null) return;
    setFileState((prev) => ({
      ...prev,
      draftContent: prev.savedContent,
    }));
    setDocResetGen((g) => g + 1);
    setConflictState(null);
    setSaveError(null);
    setSaveStatus('idle');
    if (paneMode === 'diff' && diffTarget === 'draft-vs-saved') {
      setPaneMode('preview');
    }
  };

  const handleOpenRestoreConfirm = async () => {
    if (!activeFile) return;
    await ensureOriginalLoaded(activeFile.id);
    setRestoreModalOpen(true);
  };

  const handleConfirmRestoreOriginal = async () => {
    if (!canEdit || !activeFile || restoreLoading) return;
    setRestoreLoading(true);
    setSaveError(null);

    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(activeFile.id)}/restore`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${editToken}`,
          },
          body: JSON.stringify({
            expectedSha256: fileState.sha256,
            expectedVersion: fileState.version,
          }),
        },
      );

      if (res.status === 409) {
        const conflict = (await res.json()) as FileConflictPayload;
        setConflictState(conflict);
        setRestoreModalOpen(false);
        setSaveStatus('error');
        setSaveError(conflict.error);
        return;
      }

      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(data?.error || `Restore failed (${res.status}).`);
      }

      const restored = data as SaveFileResponse;
      setShare(restored.share);
      setConflictState(null);
      setRestoreModalOpen(false);
      setFileState((prev) => ({
        ...prev,
        savedContent: restored.content,
        draftContent: restored.content,
        originalContent: restored.content,
        sha256: restored.file.sha256,
        version: restored.file.version,
      }));
      setDocResetGen((g) => g + 1);
      setSaveStatus('saved');
      setPaneMode('preview');

      setContextMd(null);
      setManifestJson(null);
      void loadContextMd(true);
      void loadManifestJson(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to restore original file.');
      setRestoreModalOpen(false);
    } finally {
      setRestoreLoading(false);
    }
  };

  const runPendingAction = (action: PendingAction) => {
    switch (action.type) {
      case 'selectContext':
        executeSelectContext();
        break;
      case 'selectManifest':
        executeSelectManifest();
        break;
      case 'selectFile':
        void executeSelectFile(action.file);
        break;
      case 'downloadZip':
        triggerUrlDownload(`/s/${encodeURIComponent(shareId)}/download.zip`);
        break;
      case 'downloadFile':
        triggerUrlDownload(
          `/s/${encodeURIComponent(shareId)}/files/${encodeURIComponent(action.file.id)}`,
        );
        break;
    }
  };

  const guardedAction = (action: PendingAction) => {
    if (isDirty) {
      setPendingAction(action);
      return;
    }
    runPendingAction(action);
  };

  const handleOpenDiffMode = async () => {
    if (!activeFile) return;
    if (isDirty) {
      setDiffTarget('draft-vs-saved');
    } else {
      await ensureOriginalLoaded(activeFile.id);
      setDiffTarget('saved-vs-original');
    }
    setPaneMode('diff');
  };

  const handleSwitchDiffTarget = async (next: DiffTarget) => {
    if (next === 'saved-vs-original' && activeFile) {
      await ensureOriginalLoaded(activeFile.id);
    }
    setDiffTarget(next);
  };

  const triggerCopy = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockInput.trim() || unlockChecking) return;
    setUnlockChecking(true);
    const ok = await verifyEditToken(unlockInput.trim());
    setUnlockChecking(false);
    if (ok) {
      window.history.replaceState(
        null,
        '',
        `/s/${encodeURIComponent(shareId)}#edit=${encodeURIComponent(unlockInput.trim())}`,
      );
      setUnlockModalOpen(false);
      setUnlockInput('');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading shared archive">
        <div className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
          <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        </div>
      </div>
    );
  }

  if (loadError || !share) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 space-y-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3 text-slate-900 dark:text-slate-100">
          <FileWarning className="h-6 w-6 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
          <h1 className="text-xl font-bold tracking-tight">
            {loadError?.status === 410 ? 'Share link expired' : 'Share link unavailable'}
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {loadError?.message || 'This share link could not be found.'}
        </p>
        <div className="pt-2">
          <button
            type="button"
            onClick={onNavigateHome}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            Create a new share
          </button>
        </div>
      </div>
    );
  }

  const publicShareUrl = `${window.location.origin}/s/${encodeURIComponent(share.shareId)}`;
  const activeLanguage = activeFile ? detectLanguageFromPath(activeFile.relativePath) : null;
  const isOverPreviewLimit = activeFile ? activeFile.sizeBytes > maxTextPreviewBytes : false;
  const canEditActiveFile = Boolean(
    canEdit && activeFile && activeFile.isText && !isOverPreviewLimit && !fileState.error,
  );
  const editedCount = share.files.filter((f) => f.isEdited).length;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5 min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 break-all">
              {share.archiveName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              <span>{share.totalFiles} files</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(share.totalExtractedBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{share.contextIncludedCount} in context.md</span>
              {editedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-blue-700 dark:text-blue-400">
                    {editedCount} edited
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>Expires {formatUtcDate(share.expiresAt)}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 font-sans font-semibold text-slate-700 dark:text-slate-200">
                {canEdit ? (
                  <>
                    <Pencil className="h-3 w-3 text-blue-700 dark:text-blue-400" aria-hidden="true" />
                    Owner edit mode
                  </>
                ) : (
                  <>
                    <Lock className="h-3 w-3 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                    Read-only share
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {!canEdit && (
              <button
                type="button"
                onClick={() => {
                  setEditAuthError(null);
                  setUnlockModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Unlock editing</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void triggerCopy('shareLink', publicShareUrl)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copiedId === 'shareLink' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                  <span>Link copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy share URL</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => guardedAction({ type: 'downloadZip' })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{editedCount > 0 ? 'Download edited ZIP' : 'Download ZIP'}</span>
            </button>
            <a
              href={`/s/${encodeURIComponent(share.shareId)}/context.md?download=1`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download context.md</span>
            </a>
          </div>
        </div>

        {editAuthError && !canEdit && (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {editAuthError} Opened in read-only mode.
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">
            {canEdit ? 'Owner workspace:' : 'Unlisted read-only share:'}
          </strong>{' '}
          {canEdit
            ? 'You hold a valid owner edit token. Saved edits persist to server storage, keep original uploads intact for diff/restore until expiry, and automatically update context.md and manifest.json.'
            : 'Public share URLs are strictly read-only. Anyone with this URL can inspect highlighted source code and download files until '}
          {!canEdit && <span className="font-mono">{formatUtcDate(share.expiresAt)}.</span>}
        </div>

        {share.sensitiveWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 flex items-start gap-2.5 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
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

      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:items-start">
        <FileTree
          files={share.files}
          selectedView={selectedView}
          dirtyFileId={isDirty && activeFile ? activeFile.id : null}
          onSelectContext={() => guardedAction({ type: 'selectContext' })}
          onSelectManifest={() => guardedAction({ type: 'selectManifest' })}
          onSelectFile={(f) => guardedAction({ type: 'selectFile', file: f })}
        />

        <section
          ref={previewSectionRef}
          aria-label="Code viewer and editor"
          className="min-w-0 rounded-xl border border-slate-200 bg-white overflow-hidden dark:border-slate-800 dark:bg-slate-900"
        >
          {selectedView.kind === 'context' && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
                <div className="min-w-0">
                  <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    context.md
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Generated output (read-only) · Rebuilt automatically when saved files change
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={wordWrap}
                    onClick={() => setWordWrap((w) => !w)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      wordWrap
                        ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{wordWrap ? 'Wrapped' : 'Wrap lines'}</span>
                  </button>
                  {contextMd !== null && (
                    <button
                      type="button"
                      onClick={() => void triggerCopy('contextMd', contextMd)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                    >
                      {copiedId === 'contextMd' ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    <span>Raw URL</span>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              </div>
              {contextMd === null ? (
                <div className="p-8 text-sm text-slate-500 dark:text-slate-400">
                  Loading context.md...
                </div>
              ) : (
                <CodeEditor
                  docKey={`context:${share.shareId}:${contextMd.length}`}
                  value={contextMd}
                  languageId="markdown"
                  readOnly={true}
                  wordWrap={wordWrap}
                  effectiveTheme={effectiveTheme}
                  ariaLabel="Generated context.md preview"
                />
              )}
            </div>
          )}

          {selectedView.kind === 'manifest' && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
                <div>
                  <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    manifest.json
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Generated output (read-only) · Index of files, sizes, hashes, and edit versions
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={wordWrap}
                    onClick={() => setWordWrap((w) => !w)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      wordWrap
                        ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{wordWrap ? 'Wrapped' : 'Wrap lines'}</span>
                  </button>
                  {manifestJson !== null && (
                    <button
                      type="button"
                      onClick={() => void triggerCopy('manifestJson', manifestJson)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                    >
                      {copiedId === 'manifestJson' ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download</span>
                  </a>
                </div>
              </div>
              {manifestJson === null ? (
                <div className="p-8 text-sm text-slate-500 dark:text-slate-400">
                  Loading manifest.json...
                </div>
              ) : (
                <CodeEditor
                  docKey={`manifest:${share.shareId}:${manifestJson.length}`}
                  value={manifestJson}
                  languageId="json"
                  readOnly={true}
                  wordWrap={wordWrap}
                  effectiveTheme={effectiveTheme}
                  ariaLabel="Generated manifest.json preview"
                />
              )}
            </div>
          )}

          {selectedView.kind === 'file' && activeFile && (
            <div>
              {/* File header & metadata */}
              <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100 break-all">
                        {activeFile.relativePath}
                      </h2>
                      {isDirty && (
                        <span
                          data-testid="unsaved-indicator"
                          className="text-xs font-semibold text-amber-700 dark:text-amber-400"
                        >
                          · Unsaved changes
                        </span>
                      )}
                      {!isDirty && saveStatus === 'saved' && (
                        <span
                          data-testid="saved-indicator"
                          className="text-xs font-semibold text-emerald-700 dark:text-emerald-400"
                        >
                          · Saved
                        </span>
                      )}
                      {saveStatus === 'saving' && (
                        <span className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                          · Saving...
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      <span>{activeLanguage?.label ?? 'Plain Text'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(activeFile.sizeBytes)}</span>
                      <span aria-hidden="true">·</span>
                      <span>v{activeFile.version}</span>
                      {activeFile.isEdited && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-blue-700 dark:text-blue-400">
                            Modified from original
                          </span>
                        </>
                      )}
                      {!activeFile.isText && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Binary / read-only</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Primary file actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {activeFile.isText && !isOverPreviewLimit && fileState.savedContent !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          void triggerCopy(
                            `file:${activeFile.id}`,
                            fileState.draftContent ?? fileState.savedContent ?? '',
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap"
                      >
                        {copiedId === `file:${activeFile.id}` ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
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

                    <button
                      type="button"
                      onClick={() => guardedAction({ type: 'downloadFile', file: activeFile })}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Download file</span>
                    </button>
                  </div>
                </div>

                {/* Editor / Viewer Toolbar */}
                {activeFile.isText && !isOverPreviewLimit && !fileState.loading && !fileState.error && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 dark:border-slate-800">
                    {/* Left: Mode switch (Preview / Edit / Diff) + Wrap */}
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        role="tablist"
                        aria-label="File view mode"
                        className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={paneMode === 'preview'}
                          onClick={() => setPaneMode('preview')}
                          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
                            paneMode === 'preview'
                              ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                          }`}
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Preview</span>
                        </button>

                        {canEditActiveFile && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={paneMode === 'edit'}
                            onClick={() => {
                              setPaneMode('edit');
                              setTimeout(() => editorRef.current?.focus(), 0);
                            }}
                            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
                              paneMode === 'edit'
                                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                            }`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Edit</span>
                          </button>
                        )}

                        {(isDirty || activeFile.isEdited) && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={paneMode === 'diff'}
                            onClick={() => void handleOpenDiffMode()}
                            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-600 ${
                              paneMode === 'diff'
                                ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-300/70 dark:bg-slate-950 dark:text-white dark:ring-slate-600'
                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                            }`}
                          >
                            <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Diff</span>
                          </button>
                        )}
                      </div>

                      {paneMode !== 'diff' && (
                        <button
                          type="button"
                          aria-pressed={wordWrap}
                          onClick={() => setWordWrap((w) => !w)}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                            wordWrap
                              ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                          }`}
                        >
                          <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{wordWrap ? 'Wrapped' : 'Wrap lines'}</span>
                        </button>
                      )}

                      {paneMode === 'edit' && canEditActiveFile && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Undo"
                            title="Undo"
                            disabled={!historyState.canUndo}
                            onClick={() => editorRef.current?.undo()}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                          >
                            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">Undo</span>
                          </button>
                          <button
                            type="button"
                            aria-label="Redo"
                            title="Redo"
                            disabled={!historyState.canRedo}
                            onClick={() => editorRef.current?.redo()}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                          >
                            <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">Redo</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Right: Save, Discard, Restore actions */}
                    {canEditActiveFile && (
                      <div className="flex flex-wrap items-center gap-2">
                        {isDirty && (
                          <button
                            type="button"
                            onClick={handleDiscardChanges}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 whitespace-nowrap"
                          >
                            <span>Discard unsaved changes</span>
                          </button>
                        )}

                        {activeFile.isEdited && (
                          <button
                            type="button"
                            onClick={() => void handleOpenRestoreConfirm()}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:bg-slate-800 dark:text-amber-300 dark:hover:bg-amber-950/40 whitespace-nowrap"
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Restore original file</span>
                          </button>
                        )}

                        {(paneMode === 'edit' || isDirty) && (
                          <button
                            type="button"
                            disabled={!isDirty || saveStatus === 'saving'}
                            onClick={() => void handleSaveCurrentFile()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 dark:bg-emerald-600 dark:hover:bg-emerald-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 whitespace-nowrap"
                          >
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{saveStatus === 'saving' ? 'Saving...' : 'Save'}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Active content safety notice */}
              {activeFile.isActiveContent && (
                <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/70 dark:text-slate-300">
                  <ShieldCheck className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" aria-hidden="true" />
                  <span>
                    Safe source view: active web content (HTML, JS, SVG, XML) is displayed strictly
                    as escaped, syntax-highlighted source text and never executed.
                  </span>
                </div>
              )}

              {/* Conflict banner */}
              {conflictState && (
                <div
                  role="alert"
                  className="border-b border-rose-200 bg-rose-50 px-5 py-3.5 text-xs text-rose-950 space-y-2.5 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
                >
                  <div className="font-semibold flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-rose-700 dark:text-rose-400 shrink-0" aria-hidden="true" />
                    <span>
                      Version conflict (server is at v{conflictState.currentVersion}): {conflictState.error}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {conflictState.currentContent !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          setDiffTarget('draft-vs-conflict');
                          setPaneMode('diff');
                        }}
                        className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-200 dark:hover:bg-rose-950"
                      >
                        Compare draft vs. server version
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (conflictState.currentContent !== null) {
                          setShare((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  files: prev.files.map((f) =>
                                    f.id === conflictState.currentFile.id
                                      ? conflictState.currentFile
                                      : f,
                                  ),
                                }
                              : prev,
                          );
                          setFileState((prev) => ({
                            ...prev,
                            savedContent: conflictState.currentContent,
                            draftContent: conflictState.currentContent,
                            sha256: conflictState.currentSha256,
                            version: conflictState.currentVersion,
                          }));
                          setDocResetGen((g) => g + 1);
                        }
                        setConflictState(null);
                        setSaveError(null);
                        setSaveStatus('idle');
                      }}
                      className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-200 dark:hover:bg-rose-950"
                    >
                      Reload server version
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleSaveCurrentFile({
                          sha256: conflictState.currentSha256,
                          version: conflictState.currentVersion,
                        })
                      }
                      className="rounded-lg bg-rose-700 px-3 py-1.5 font-semibold text-white hover:bg-rose-800"
                    >
                      Overwrite server with my draft
                    </button>
                  </div>
                </div>
              )}

              {/* Non-conflict save error banner */}
              {saveError && !conflictState && (
                <div
                  role="alert"
                  className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
                >
                  {saveError}
                </div>
              )}

              {/* Main body: Binary / Oversized / Loading / Error / Diff / CodeEditor */}
              {!activeFile.isText ? (
                <div className="p-8 text-center space-y-3">
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    This file is binary or non-UTF-8 ({activeFile.omissionReason || 'binary file'})
                    and is read-only. Download the file to inspect it locally.
                  </p>
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/files/${encodeURIComponent(activeFile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download {activeFile.relativePath.split('/').pop()}</span>
                  </a>
                </div>
              ) : fileState.loading ? (
                <div className="p-8 text-sm text-slate-500 dark:text-slate-400">
                  Loading file contents...
                </div>
              ) : fileState.error || isOverPreviewLimit ? (
                <div className="p-8 text-sm text-slate-700 dark:text-slate-300 space-y-3">
                  <p>
                    {fileState.error ||
                      `This file (${formatBytes(activeFile.sizeBytes)}) exceeds the ${formatBytes(maxTextPreviewBytes)} inline preview/editor limit and is read-only.`}
                  </p>
                  <a
                    href={`/s/${encodeURIComponent(share.shareId)}/files/${encodeURIComponent(activeFile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Download file instead</span>
                  </a>
                </div>
              ) : (
                <>
                  {paneMode === 'diff' && (
                    <div>
                      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/60">
                        <span className="font-semibold text-slate-600 dark:text-slate-300">
                          Compare:
                        </span>
                        {isDirty && (
                          <button
                            type="button"
                            aria-pressed={diffTarget === 'draft-vs-saved'}
                            onClick={() => void handleSwitchDiffTarget('draft-vs-saved')}
                            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                              diffTarget === 'draft-vs-saved'
                                ? 'bg-blue-700 text-white'
                                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700'
                            }`}
                          >
                            Unsaved draft vs. Last saved
                          </button>
                        )}
                        {activeFile.isEdited && (
                          <button
                            type="button"
                            aria-pressed={diffTarget === 'saved-vs-original'}
                            onClick={() => void handleSwitchDiffTarget('saved-vs-original')}
                            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                              diffTarget === 'saved-vs-original'
                                ? 'bg-blue-700 text-white'
                                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700'
                            }`}
                          >
                            Last saved vs. Original upload
                          </button>
                        )}
                        {conflictState && conflictState.currentContent !== null && (
                          <button
                            type="button"
                            aria-pressed={diffTarget === 'draft-vs-conflict'}
                            onClick={() => void handleSwitchDiffTarget('draft-vs-conflict')}
                            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                              diffTarget === 'draft-vs-conflict'
                                ? 'bg-rose-700 text-white'
                                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700'
                            }`}
                          >
                            Server v{conflictState.currentVersion} vs. My draft
                          </button>
                        )}
                      </div>

                      {diffTarget === 'draft-vs-saved' && (
                        <DiffViewer
                          leftLabel="Last saved"
                          rightLabel="Unsaved draft"
                          leftText={fileState.savedContent ?? ''}
                          rightText={fileState.draftContent ?? ''}
                        />
                      )}
                      {diffTarget === 'saved-vs-original' && (
                        <DiffViewer
                          leftLabel="Original upload"
                          rightLabel="Last saved"
                          leftText={fileState.originalContent ?? fileState.savedContent ?? ''}
                          rightText={fileState.savedContent ?? ''}
                        />
                      )}
                      {diffTarget === 'draft-vs-conflict' && conflictState && (
                        <DiffViewer
                          leftLabel={`Server v${conflictState.currentVersion}`}
                          rightLabel="My unsaved draft"
                          leftText={conflictState.currentContent ?? ''}
                          rightText={fileState.draftContent ?? ''}
                        />
                      )}
                    </div>
                  )}
                  <div className={paneMode === 'diff' ? 'hidden' : 'block'}>
                    <CodeEditor
                      ref={editorRef}
                      docKey={`${activeFile.id}:${docResetGen}`}
                      value={fileState.draftContent ?? ''}
                      languageId={activeLanguage?.id ?? 'plaintext'}
                      readOnly={paneMode !== 'edit' || !canEditActiveFile}
                      wordWrap={wordWrap}
                      effectiveTheme={effectiveTheme}
                      ariaLabel={`${activeFile.relativePath} code ${paneMode === 'edit' ? 'editor' : 'viewer'}`}
                      onChange={(nextDoc) => {
                        setFileState((prev) => ({ ...prev, draftContent: nextDoc }));
                        if (saveStatus === 'saved') setSaveStatus('idle');
                      }}
                      onSaveShortcut={() => {
                        if (paneMode === 'edit' && canEditActiveFile && isDirty) {
                          void handleSaveCurrentFile();
                        }
                      }}
                      onHistoryStateChange={setHistoryState}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Modal: Unsaved changes confirmation (switch file/view or download) */}
      <ModalDialog
        open={pendingAction !== null}
        title="Unsaved changes"
        onClose={() => setPendingAction(null)}
      >
        <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
          <p>
            You have unsaved edits in{' '}
            <code className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
              {activeFile?.relativePath}
            </code>
            .{' '}
            {pendingAction?.type === 'downloadZip' || pendingAction?.type === 'downloadFile'
              ? 'Downloads serve the saved version on the server. Do you want to save your edits first, discard them, or cancel?'
              : 'Do you want to save your edits before leaving this file?'}
          </p>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const act = pendingAction;
                setPendingAction(null);
                handleDiscardChanges();
                if (act) runPendingAction(act);
              }}
              className="rounded-lg border border-amber-300 bg-white px-3.5 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:bg-slate-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
            >
              {pendingAction?.type === 'downloadZip' || pendingAction?.type === 'downloadFile'
                ? 'Discard & download'
                : 'Discard & continue'}
            </button>
            {canEditActiveFile && (
              <button
                type="button"
                onClick={async () => {
                  const act = pendingAction;
                  const savedOk = await handleSaveCurrentFile();
                  if (savedOk) {
                    setPendingAction(null);
                    if (act) runPendingAction(act);
                  } else {
                    setPendingAction(null);
                  }
                }}
                className="rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                {pendingAction?.type === 'downloadZip' || pendingAction?.type === 'downloadFile'
                  ? 'Save & download'
                  : 'Save & continue'}
              </button>
            )}
          </div>
        </div>
      </ModalDialog>

      {/* Modal: Restore original file confirmation with diff */}
      <ModalDialog
        open={restoreModalOpen}
        title={`Restore original ${activeFile?.relativePath ?? 'file'}?`}
        onClose={() => !restoreLoading && setRestoreModalOpen(false)}
        maxWidthClass="max-w-3xl"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Restoring will replace the current saved file (and any unsaved draft) with the version
            originally uploaded in the ZIP. The changes shown below will be lost:
          </p>

          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <DiffViewer
              leftLabel="Current draft/saved"
              rightLabel="Original upload"
              leftText={fileState.draftContent ?? fileState.savedContent ?? ''}
              rightText={fileState.originalContent ?? ''}
              maxHeightClass="max-h-72"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={restoreLoading}
              onClick={() => setRestoreModalOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={restoreLoading}
              onClick={() => void handleConfirmRestoreOriginal()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{restoreLoading ? 'Restoring...' : 'Confirm restore original'}</span>
            </button>
          </div>
        </div>
      </ModalDialog>

      {/* Modal: Unlock owner editing via edit token */}
      <ModalDialog
        open={unlockModalOpen}
        title="Unlock owner editing"
        onClose={() => setUnlockModalOpen(false)}
      >
        <form onSubmit={(e) => void handleUnlockSubmit(e)} className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Public share links are read-only. Paste the private owner edit token generated when this
            ZIP was uploaded to enable editing, diffing, and restoring.
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor="owner-edit-token-input"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              Owner edit token
            </label>
            <input
              id="owner-edit-token-input"
              type="password"
              required
              value={unlockInput}
              onChange={(e) => setUnlockInput(e.target.value)}
              placeholder="Paste private edit token"
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          {editAuthError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
            >
              {editAuthError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUnlockModalOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={unlockChecking || !unlockInput.trim()}
              className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              {unlockChecking ? 'Verifying...' : 'Unlock editing'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <div aria-live="polite" className="sr-only">
        {copiedId ? 'Copied to clipboard.' : ''}
      </div>
    </div>
  );
};
