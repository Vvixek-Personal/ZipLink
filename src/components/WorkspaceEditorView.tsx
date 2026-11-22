import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  File,
  FileCode,
  FilePlus2,
  FileText,
  GitBranch,
  GitPullRequest,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  GitHubWorkspaceRecord,
  MergePullRequestResult,
  PullCheckResult,
  PushToGitHubResult,
  WorkspaceDiffSummary,
  WorkspaceFileEntry,
} from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import {
  apiRequestJson,
  downloadAuthorizedBlob,
  mergeGitHubPullRequest,
} from '../utils/githubApi.ts';
import { formatUtcDate } from '../utils/fileTree.ts';

interface WorkspaceEditorViewProps {
  workspaceId: string;
  onBack: () => void;
}

interface ConflictPreviewData {
  path: string;
  kind: string;
  isBinary: boolean;
  workspaceText: string | null;
  remoteText: string | null;
  baseText: string | null;
}

export const WorkspaceEditorView: React.FC<WorkspaceEditorViewProps> = ({
  workspaceId,
  onBack,
}) => {
  const [workspace, setWorkspace] = useState<GitHubWorkspaceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  const [fileQuery, setFileQuery] = useState('');
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [loadedText, setLoadedText] = useState('');
  const [savingFile, setSavingFile] = useState(false);

  // Create file / binary upload / rename state
  const [showNewFileForm, setShowNewFileForm] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameTargetPath, setRenameTargetPath] = useState('');
  const binaryCreateInputRef = useRef<HTMLInputElement>(null);
  const binaryReplaceInputRef = useRef<HTMLInputElement>(null);
  const [pendingBinaryNewPath, setPendingBinaryNewPath] = useState('');

  // Pull & conflicts
  const [pullChecking, setPullChecking] = useState(false);
  const [pullApplying, setPullApplying] = useState(false);
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, 'keep_workspace' | 'use_github'>
  >({});
  const [confirmedDeletions, setConfirmedDeletions] = useState<Set<string>>(() => new Set());
  const [conflictPreviews, setConflictPreviews] = useState<Record<string, ConflictPreviewData>>({});

  // Push & diff panel
  const [showPushPanel, setShowPushPanel] = useState(false);
  const [diffSummary, setDiffSummary] = useState<WorkspaceDiffSummary | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [createPr, setCreatePr] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<PushToGitHubResult | null>(null);
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [confirmMergeChecked, setConfirmMergeChecked] = useState(false);
  const [mergingPr, setMergingPr] = useState(false);
  const [mergeResult, setMergeResult] = useState<MergePullRequestResult | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const activeFiles = useMemo(() => {
    if (!workspace) return [];
    const trimmed = fileQuery.trim().toLowerCase();
    return workspace.files
      .filter((f) => !f.deletedInWorkspace)
      .filter((f) => (!trimmed ? true : f.path.toLowerCase().includes(trimmed)));
  }, [workspace, fileQuery]);

  const selectedFile: WorkspaceFileEntry | null = useMemo(() => {
    if (!workspace || !selectedFileId) return null;
    return workspace.files.find((f) => f.id === selectedFileId && !f.deletedInWorkspace) ?? null;
  }, [workspace, selectedFileId]);

  const isEditorDirty = Boolean(selectedFile?.isText && editorText !== loadedText);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await apiRequestJson<{ workspace: GitHubWorkspaceRecord }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      );
      setWorkspace(res.workspace);
      const firstActive = res.workspace.files.find((f) => !f.deletedInWorkspace);
      if (firstActive && !selectedFileId) {
        setSelectedFileId(firstActive.id);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load workspace.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedFileId]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const loadSelectedFileContent = useCallback(
    async (file: WorkspaceFileEntry | null) => {
      if (!file) {
        setEditorText('');
        setLoadedText('');
        return;
      }
      if (!file.isText) {
        setEditorText('');
        setLoadedText('');
        return;
      }
      setFileLoading(true);
      setErrorMsg(null);
      try {
        const res = await apiRequestJson<{ file: WorkspaceFileEntry; content: string }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(file.id)}/content`,
        );
        setEditorText(res.content);
        setLoadedText(res.content);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to read file content.');
        setEditorText('');
        setLoadedText('');
      } finally {
        setFileLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void loadSelectedFileContent(selectedFile);
  }, [selectedFile?.id, selectedFile?.gitBlobSha, loadSelectedFileContent]);

  const handleSaveTextFile = async () => {
    if (!selectedFile || !selectedFile.isText || savingFile) return;
    setSavingFile(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<{
        workspace: GitHubWorkspaceRecord;
        file: WorkspaceFileEntry;
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(selectedFile.id)}/content`,
        {
          method: 'PUT',
          body: JSON.stringify({ content: editorText }),
        },
      );
      setWorkspace(res.workspace);
      setLoadedText(editorText);
      setNoticeMsg(`Saved changes to ${res.file.path}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to save file.');
    } finally {
      setSavingFile(false);
    }
  };

  const handleCreateTextFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFilePath.trim()) return;
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<{
        workspace: GitHubWorkspaceRecord;
        file: WorkspaceFileEntry;
      }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`, {
        method: 'POST',
        body: JSON.stringify({
          path: newFilePath.trim(),
          content: newFileContent,
        }),
      });
      setWorkspace(res.workspace);
      setSelectedFileId(res.file.id);
      setShowNewFileForm(false);
      setNewFilePath('');
      setNewFileContent('');
      setNoticeMsg(`Created ${res.file.path}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to create file.');
    }
  };

  const handleUploadNewBinary = async (file: File | null) => {
    if (!file) return;
    setErrorMsg(null);
    setNoticeMsg(null);
    const targetPath = pendingBinaryNewPath.trim() || file.name;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', targetPath);

    try {
      const res = await apiRequestJson<{
        workspace: GitHubWorkspaceRecord;
        file: WorkspaceFileEntry;
      }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`, {
        method: 'POST',
        body: formData,
      });
      setWorkspace(res.workspace);
      setSelectedFileId(res.file.id);
      setPendingBinaryNewPath('');
      setNoticeMsg(`Uploaded ${res.file.path} (${formatBytes(res.file.sizeBytes)}).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to upload binary file.');
    }
  };

  const handleReplaceBinary = async (file: File | null) => {
    if (!file || !selectedFile) return;
    setErrorMsg(null);
    setNoticeMsg(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await apiRequestJson<{
        workspace: GitHubWorkspaceRecord;
        file: WorkspaceFileEntry;
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(selectedFile.id)}/replace`,
        {
          method: 'POST',
          body: formData,
        },
      );
      setWorkspace(res.workspace);
      setNoticeMsg(
        `Replaced ${res.file.path} preserving exact binary bytes (${formatBytes(res.file.sizeBytes)}).`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to replace binary file.');
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingFileId || !renameTargetPath.trim()) return;
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<{
        workspace: GitHubWorkspaceRecord;
        file: WorkspaceFileEntry;
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(renamingFileId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ newPath: renameTargetPath.trim() }),
        },
      );
      setWorkspace(res.workspace);
      setRenamingFileId(null);
      setRenameTargetPath('');
      setNoticeMsg(`Renamed file to ${res.file.path}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to rename file.');
    }
  };

  const handleDeleteFile = async (file: WorkspaceFileEntry) => {
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<{ workspace: GitHubWorkspaceRecord }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(file.id)}`,
        { method: 'DELETE' },
      );
      setWorkspace(res.workspace);
      if (selectedFileId === file.id) {
        const next = res.workspace.files.find((f) => !f.deletedInWorkspace);
        setSelectedFileId(next?.id ?? null);
      }
      setNoticeMsg(`Deleted ${file.path} from workspace.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to delete file.');
    }
  };

  const handlePullCheck = async () => {
    if (pullChecking) return;
    setPullChecking(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<PullCheckResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/pull/check`,
        { method: 'POST' },
      );
      setWorkspace(res.workspace);
      setConflictResolutions({});
      setConfirmedDeletions(new Set());
      setConflictPreviews({});

      if (res.upToDate) {
        setNoticeMsg(`Already up to date with GitHub (${res.latestCommitSha.slice(0, 7)}).`);
      } else if (res.appliedAutomatically) {
        setNoticeMsg(
          `Pulled ${res.safeUpdates.length} upstream update(s) safely (${res.latestCommitSha.slice(0, 7)}).`,
        );
      } else {
        setNoticeMsg(
          `Upstream changes require review: ${res.conflicts.length} conflict(s), ${res.upstreamDeletions.length} deletion(s).`,
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed checking GitHub updates.');
    } finally {
      setPullChecking(false);
    }
  };

  const handleLoadConflictPreview = async (conflictPath: string) => {
    try {
      const preview = await apiRequestJson<ConflictPreviewData>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/pull/conflict-preview?path=${encodeURIComponent(conflictPath)}`,
      );
      setConflictPreviews((prev) => ({ ...prev, [conflictPath]: preview }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load conflict diff.');
    }
  };

  const handleApplyPullResolutions = async () => {
    if (!workspace || pullApplying) return;
    setPullApplying(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await apiRequestJson<{ workspace: GitHubWorkspaceRecord }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/pull/apply`,
        {
          method: 'POST',
          body: JSON.stringify({
            conflictResolutions,
            confirmedDeletionPaths: [...confirmedDeletions],
          }),
        },
      );
      setWorkspace(res.workspace);
      setConflictResolutions({});
      setConfirmedDeletions(new Set());
      setConflictPreviews({});
      setNoticeMsg(
        `Pull applied cleanly. Workspace base updated to ${res.workspace.baseCommitSha.slice(0, 7)}.`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to apply pull updates.');
    } finally {
      setPullApplying(false);
    }
  };

  const handleOpenPushReview = async () => {
    if (!workspace) return;
    setShowPushPanel(true);
    setPushResult(null);
    setMergeResult(null);
    setMergeError(null);
    setConfirmMergeChecked(false);
    setDiffLoading(true);
    setErrorMsg(null);
    try {
      const diff = await apiRequestJson<WorkspaceDiffSummary>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/diff`,
      );
      setDiffSummary(diff);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      setNewBranchName((prev) => prev || `ziplink/update-${stamp}`);
      setCommitMessage((prev) => prev || `Update ${diff.items.length} file(s) from ZipLink`);
      setPrTitle((prev) => prev || `ZipLink updates (${workspace.branch})`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to compute workspace diff.');
    } finally {
      setDiffLoading(false);
    }
  };

  const handlePushToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || pushing) return;
    setPushing(true);
    setErrorMsg(null);
    setMergeResult(null);
    setMergeError(null);
    setConfirmMergeChecked(false);
    try {
      const res = await apiRequestJson<PushToGitHubResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/push`,
        {
          method: 'POST',
          body: JSON.stringify({
            newBranchName,
            commitMessage,
            prTitle,
            prBody,
            createPullRequest: createPr,
          }),
        },
      );
      setPushResult(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Push to GitHub failed.');
    } finally {
      setPushing(false);
    }
  };

  const handleDownloadWorkspaceFile = async (file: WorkspaceFileEntry) => {
    setErrorMsg(null);
    try {
      const filename = file.path.split('/').pop() || 'file';
      await downloadAuthorizedBlob(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(file.id)}/download`,
        filename,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to download workspace file.');
    }
  };

  const handleMergePullRequest = async () => {
    if (
      !pushResult?.pullRequest ||
      !pushResult.canMergePullRequest ||
      !pushResult.repoOwner ||
      !pushResult.repoName ||
      !confirmMergeChecked ||
      mergingPr
    ) {
      return;
    }
    setMergingPr(true);
    setMergeError(null);
    try {
      const res = await mergeGitHubPullRequest({
        owner: pushResult.repoOwner,
        repo: pushResult.repoName,
        pullNumber: pushResult.pullRequest.number,
        mergeMethod,
        confirmed: true,
      });
      setMergeResult(res);
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Unable to merge Pull Request.');
    } finally {
      setMergingPr(false);
    }
  };

  if (loading && !workspace) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        Loading workspace...
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900"
        >
          {errorMsg || 'Workspace not found.'}
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to workspaces
        </button>
      </div>
    );
  }

  const hasPendingReview =
    workspace.conflicts.length > 0 || workspace.pendingUpstreamDeletions.length > 0;
  const allConflictsChosen = workspace.conflicts.every(
    (c) => conflictResolutions[c.path] === 'keep_workspace' || conflictResolutions[c.path] === 'use_github',
  );
  const allDeletionsConfirmed = workspace.pendingUpstreamDeletions.every((d) =>
    confirmedDeletions.has(d.path),
  );

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Workspaces
              </button>
              <span>·</span>
              <span>Private workspace</span>
              <span>·</span>
              <span className="font-mono">Base {workspace.baseCommitSha.slice(0, 7)}</span>
              <span>·</span>
              <span>Synced {formatUtcDate(workspace.lastSyncedAt)}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 break-all">
                {workspace.repoFullName}
              </h1>
              <span className="inline-flex items-center gap-1 font-mono text-xs font-medium text-slate-700">
                <GitBranch className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                {workspace.branch}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={pullChecking}
              onClick={() => void handlePullCheck()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:bg-slate-100"
            >
              <RefreshCw
                className={`h-4 w-4 ${pullChecking ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {pullChecking ? 'Checking GitHub...' : 'Pull latest from GitHub'}
            </button>

            <button
              type="button"
              disabled={hasPendingReview}
              onClick={() => void handleOpenPushReview()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600"
            >
              <GitPullRequest className="h-4 w-4" aria-hidden="true" />
              Review &amp; Push to GitHub
            </button>
          </div>
        </div>

        {noticeMsg && (
          <div
            aria-live="polite"
            className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-950"
          >
            {noticeMsg}
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900"
          >
            {errorMsg}
          </div>
        )}
      </div>

      {/* Conflicts & Upstream Deletions Resolution Panel */}
      {hasPendingReview && (
        <section
          aria-label="Pull updates requiring review"
          className="rounded-xl border border-amber-300 bg-amber-50 p-6 space-y-5"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-base font-bold text-amber-950">
              <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0" aria-hidden="true" />
              Pull review required before applying upstream changes
            </div>
            <p className="text-sm text-amber-900">
              Target remote commit{' '}
              <code className="font-mono text-xs">
                {workspace.pendingPullCommitSha?.slice(0, 7)}
              </code>{' '}
              has conflicts or upstream deletions. ZipLink never silently overwrites local edits or
              auto-merges binaries.
            </p>
          </div>

          {workspace.pendingUpstreamDeletions.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-white p-4 space-y-3">
              <div className="text-sm font-semibold text-slate-900">
                Upstream file deletions ({workspace.pendingUpstreamDeletions.length}) — confirmation
                required
              </div>
              <ul className="space-y-2">
                {workspace.pendingUpstreamDeletions.map((del) => (
                  <li key={del.path}>
                    <label className="flex items-start gap-2.5 text-xs text-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={confirmedDeletions.has(del.path)}
                        onChange={(e) => {
                          setConfirmedDeletions((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(del.path);
                            else next.delete(del.path);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <span>
                        Confirm deleting <code className="font-mono font-semibold">{del.path}</code>{' '}
                        ({formatBytes(del.sizeBytes)}) removed on GitHub
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {workspace.conflicts.length > 0 && (
            <div className="space-y-4">
              {workspace.conflicts.map((conflict) => {
                const preview = conflictPreviews[conflict.path];
                const chosen = conflictResolutions[conflict.path];
                return (
                  <div
                    key={conflict.path}
                    className="rounded-lg border border-amber-200 bg-white p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-sm font-semibold text-slate-900">
                          {conflict.path}
                        </div>
                        <div className="text-xs text-slate-600">
                          Conflict type: {conflict.kind.replace(/_/g, ' ')}
                          {conflict.isBinary
                            ? ' · Binary file (cannot be auto-merged — choose one copy)'
                            : ' · Text file'}
                        </div>
                      </div>

                      {!conflict.isBinary && !preview && (
                        <button
                          type="button"
                          onClick={() => void handleLoadConflictPreview(conflict.path)}
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Compare workspace vs GitHub
                        </button>
                      )}
                    </div>

                    {preview && !preview.isBinary && (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <div className="text-xs font-semibold text-slate-700 mb-1.5">
                            ZipLink workspace copy
                          </div>
                          <pre className="max-h-48 overflow-auto font-mono text-xs text-slate-800 whitespace-pre-wrap break-words">
                            {preview.workspaceText ?? '(Deleted in workspace)'}
                          </pre>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <div className="text-xs font-semibold text-slate-700 mb-1.5">
                            GitHub branch copy
                          </div>
                          <pre className="max-h-48 overflow-auto font-mono text-xs text-slate-800 whitespace-pre-wrap break-words">
                            {preview.remoteText ?? '(Deleted on GitHub)'}
                          </pre>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        aria-pressed={chosen === 'keep_workspace'}
                        onClick={() =>
                          setConflictResolutions((prev) => ({
                            ...prev,
                            [conflict.path]: 'keep_workspace',
                          }))
                        }
                        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                          chosen === 'keep_workspace'
                            ? 'border-blue-700 bg-blue-50 text-blue-900'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        Keep workspace copy
                      </button>
                      <button
                        type="button"
                        aria-pressed={chosen === 'use_github'}
                        onClick={() =>
                          setConflictResolutions((prev) => ({
                            ...prev,
                            [conflict.path]: 'use_github',
                          }))
                        }
                        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                          chosen === 'use_github'
                            ? 'border-blue-700 bg-blue-50 text-blue-900'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        Use GitHub copy
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            disabled={pullApplying || !allConflictsChosen || !allDeletionsConfirmed}
            onClick={() => void handleApplyPullResolutions()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-600"
          >
            {pullApplying ? 'Applying pull...' : 'Apply confirmed pull resolutions'}
          </button>
        </section>
      )}

      {/* Push Review Panel */}
      {showPushPanel && (
        <section
          aria-label="Review and push changes to GitHub"
          className="rounded-xl border border-slate-300 bg-white p-6 space-y-5"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-slate-900">
              Review diff &amp; push to new GitHub branch
            </h2>
            <button
              type="button"
              onClick={() => setShowPushPanel(false)}
              className="text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Close
            </button>
          </div>

          {diffLoading && (
            <div className="text-sm text-slate-600">Comparing workspace against base commit...</div>
          )}

          {diffSummary?.remoteMoved && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 space-y-2"
            >
              <div className="font-semibold">
                Remote branch &ldquo;{workspace.branch}&rdquo; has moved to{' '}
                {diffSummary.remoteCommitSha.slice(0, 7)}
              </div>
              <p>
                Pull latest from GitHub and review upstream changes before pushing so nothing is
                overwritten blindly.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowPushPanel(false);
                  void handlePullCheck();
                }}
                className="rounded-md bg-red-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-900"
              >
                Pull &amp; review updates now
              </button>
            </div>
          )}

          {diffSummary && !diffSummary.hasChanges && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              No file changes in this workspace compared to base commit{' '}
              <code className="font-mono text-xs">{diffSummary.baseCommitSha.slice(0, 7)}</code>.
            </div>
          )}

          {diffSummary && diffSummary.hasChanges && !pushResult && (
            <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                <div className="text-xs font-semibold text-slate-700">
                  Changed files ({diffSummary.items.length})
                </div>
                {diffSummary.items.map((item) => (
                  <div
                    key={`${item.status}:${item.path}`}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono font-semibold text-slate-900 break-all">
                        {item.previousPath ? `${item.previousPath} -> ${item.path}` : item.path}
                      </span>
                      <span
                        className={`font-semibold uppercase tracking-wide ${
                          item.status === 'deleted'
                            ? 'text-red-700'
                            : item.status === 'added'
                              ? 'text-emerald-700'
                              : 'text-blue-700'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                    {item.patch && (
                      <pre className="max-h-40 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-800 whitespace-pre-wrap break-all">
                        {item.patch}
                      </pre>
                    )}
                    {item.isBinary && (
                      <div className="text-[11px] text-slate-500 font-mono">
                        Binary file · {formatBytes(item.sizeBytes)}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form onSubmit={handlePushToGitHub} className="space-y-4">
                <div>
                  <label htmlFor="push-branch" className="block text-xs font-semibold text-slate-700 mb-1">
                    New branch name (never silently pushes to {workspace.defaultBranch})
                  </label>
                  <input
                    id="push-branch"
                    type="text"
                    required
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900"
                  />
                </div>

                <div>
                  <label htmlFor="push-commit" className="block text-xs font-semibold text-slate-700 mb-1">
                    Commit message
                  </label>
                  <input
                    id="push-commit"
                    type="text"
                    required
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={createPr}
                    onChange={(e) => setCreatePr(e.target.checked)}
                  />
                  Create Pull Request targeting {workspace.branch} (recommended)
                </label>

                {createPr && (
                  <>
                    <div>
                      <label htmlFor="push-pr-title" className="block text-xs font-semibold text-slate-700 mb-1">
                        Pull Request title
                      </label>
                      <input
                        id="push-pr-title"
                        type="text"
                        value={prTitle}
                        onChange={(e) => setPrTitle(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                    <div>
                      <label htmlFor="push-pr-body" className="block text-xs font-semibold text-slate-700 mb-1">
                        Pull Request description
                      </label>
                      <textarea
                        id="push-pr-body"
                        rows={3}
                        value={prBody}
                        onChange={(e) => setPrBody(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                  </>
                )}

                <button
                  type="submit"
                  disabled={pushing || diffSummary.remoteMoved}
                  className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600"
                >
                  {pushing ? 'Pushing commit & creating branch...' : 'Push to GitHub branch'}
                </button>
              </form>
            </div>
          )}

          {pushResult && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-2.5 text-sm text-emerald-950">
              <div className="flex items-center gap-2 font-bold">
                <Check className="h-4 w-4 text-emerald-700" aria-hidden="true" />
                Pushed commit {pushResult.commitSha.slice(0, 7)} to new branch &ldquo;
                {pushResult.branch}&rdquo;
              </div>

              {pushResult.prWarning && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                  {pushResult.prWarning}
                </div>
              )}

              <div className="flex flex-wrap gap-3 text-xs font-semibold">
                {pushResult.pullRequest && (
                  <a
                    href={pushResult.pullRequest.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-800 underline"
                  >
                    Open Pull Request #{pushResult.pullRequest.number}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
                <a
                  href={pushResult.compareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-800 underline"
                >
                  View compare link
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
                <a
                  href={pushResult.branchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-slate-700 underline"
                >
                  View branch on GitHub
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </div>

              {pushResult.pullRequest &&
                pushResult.canMergePullRequest &&
                pushResult.repoOwner &&
                pushResult.repoName && (
                  <div className="mt-3 rounded-lg border border-emerald-300 bg-white p-4 space-y-3 text-xs text-slate-800">
                    {mergeResult?.merged ? (
                      <div className="font-semibold text-emerald-900">
                        Pull Request #{pushResult.pullRequest.number} merged cleanly (
                        <code className="font-mono">{mergeResult.sha.slice(0, 7)}</code>):{' '}
                        {mergeResult.message}
                      </div>
                    ) : (
                      <>
                        <div className="font-semibold text-slate-900">
                          Optional: Merge Pull Request #{pushResult.pullRequest.number} into{' '}
                          <code className="font-mono">{pushResult.baseBranch}</code>
                        </div>
                        <p className="text-slate-600">
                          ZipLink never merges Pull Requests automatically. Confirm only after
                          reviewing the PR diff on GitHub.
                        </p>

                        {mergeError && (
                          <div
                            role="alert"
                            className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-900"
                          >
                            {mergeError}
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-3">
                          <label htmlFor="ws-merge-method" className="font-medium text-slate-700">
                            Method:
                          </label>
                          <select
                            id="ws-merge-method"
                            value={mergeMethod}
                            onChange={(e) =>
                              setMergeMethod(e.target.value as 'merge' | 'squash' | 'rebase')
                            }
                            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs"
                          >
                            <option value="merge">Create a merge commit</option>
                            <option value="squash">Squash and merge</option>
                            <option value="rebase">Rebase and merge</option>
                          </select>
                        </div>

                        <label className="flex items-start gap-2 cursor-pointer font-medium text-slate-800">
                          <input
                            type="checkbox"
                            checked={confirmMergeChecked}
                            onChange={(e) => setConfirmMergeChecked(e.target.checked)}
                            className="mt-0.5"
                          />
                          <span>
                            I have reviewed Pull Request #{pushResult.pullRequest.number} and confirm
                            merging it into <code className="font-mono">{pushResult.baseBranch}</code>.
                          </span>
                        </label>

                        <button
                          type="button"
                          disabled={!confirmMergeChecked || mergingPr}
                          onClick={() => void handleMergePullRequest()}
                          className="rounded-md bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-600"
                        >
                          {mergingPr ? 'Merging Pull Request...' : 'Confirm & merge Pull Request'}
                        </button>
                      </>
                    )}
                  </div>
                )}

              {pushResult.pullRequest && !pushResult.canMergePullRequest && (
                <div className="text-xs text-emerald-900/90">
                  Pull Request created. Merge controls are disabled because your authorized GitHub
                  token does not report write/maintain/admin merge permission on this repository.
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Workspace Browser + Editor Split */}
      <div className="grid gap-6 lg:grid-cols-[310px_minmax(0,1fr)] lg:items-start">
        <aside className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                Files ({activeFiles.length})
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowNewFileForm((v) => !v)}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                  New text
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingBinaryNewPath('');
                    binaryCreateInputRef.current?.click();
                  }}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  Upload
                </button>
                <input
                  ref={binaryCreateInputRef}
                  type="file"
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    void handleUploadNewBinary(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            <input
              type="search"
              value={fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder="Filter workspace files..."
              aria-label="Filter workspace files"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 focus:border-blue-700 focus:bg-white focus:outline-none"
            />
          </div>

          {showNewFileForm && (
            <form
              onSubmit={handleCreateTextFile}
              className="border-b border-slate-200 bg-slate-50 p-3 space-y-2"
            >
              <input
                type="text"
                required
                placeholder="src/new-file.ts"
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
              />
              <textarea
                rows={3}
                placeholder="Initial text content..."
                value={newFileContent}
                onChange={(e) => setNewFileContent(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-blue-700 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-800"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewFileForm(false)}
                  className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <ul className="max-h-[560px] overflow-y-auto divide-y divide-slate-100">
            {activeFiles.map((f) => {
              const isSelected = selectedFile?.id === f.id;
              const isDirty = !f.basePath || f.path !== f.basePath || f.gitBlobSha !== f.baseGitBlobSha;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedFileId(f.id)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                      isSelected ? 'bg-blue-50 text-blue-950 font-medium' : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {!f.isText ? (
                        <File className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      ) : f.isActiveContent ? (
                        <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-700" aria-hidden="true" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                      )}
                      <span className="truncate font-mono">{f.path}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-slate-400">
                      {isDirty ? '*' : ''} {formatBytes(f.sizeBytes)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* File editor / binary panel */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {!selectedFile ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Select a file from the left to inspect or edit it.
            </div>
          ) : (
            <>
              <div className="border-b border-slate-200 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-mono text-sm font-semibold text-slate-900 break-all">
                    {selectedFile.path}
                  </div>
                  <div className="font-mono text-xs text-slate-500 tabular-nums">
                    {formatBytes(selectedFile.sizeBytes)} · Blob {selectedFile.gitBlobSha.slice(0, 7)}
                    {selectedFile.isActiveContent
                      ? ' · Active format rendered safely as escaped plain text'
                      : ''}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingFileId(selectedFile.id);
                      setRenameTargetPath(selectedFile.path);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Rename
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleDownloadWorkspaceFile(selectedFile)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Download
                  </button>

                  <button
                    type="button"
                    onClick={() => binaryReplaceInputRef.current?.click()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    Replace binary
                  </button>
                  <input
                    ref={binaryReplaceInputRef}
                    type="file"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      void handleReplaceBinary(f);
                      e.target.value = '';
                    }}
                  />

                  <button
                    type="button"
                    onClick={() => void handleDeleteFile(selectedFile)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </button>
                </div>
              </div>

              {renamingFileId === selectedFile.id && (
                <form
                  onSubmit={handleRenameSubmit}
                  className="border-b border-slate-200 bg-slate-50 px-5 py-3 flex flex-wrap items-center gap-2"
                >
                  <input
                    type="text"
                    required
                    value={renameTargetPath}
                    onChange={(e) => setRenameTargetPath(e.target.value)}
                    aria-label="New file path"
                    className="flex-1 min-w-[200px] rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    Apply rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingFileId(null)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700"
                  >
                    Cancel
                  </button>
                </form>
              )}

              {selectedFile.isText ? (
                <div className="p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-500">
                      {isEditorDirty ? 'Unsaved local edits in editor buffer' : 'Saved in workspace'}
                    </span>
                    <button
                      type="button"
                      disabled={savingFile || !isEditorDirty}
                      onClick={() => void handleSaveTextFile()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-500"
                    >
                      <Save className="h-3.5 w-3.5" aria-hidden="true" />
                      {savingFile ? 'Saving...' : 'Save changes'}
                    </button>
                  </div>

                  {fileLoading ? (
                    <div className="py-16 text-center text-sm text-slate-500">Loading file...</div>
                  ) : (
                    <textarea
                      aria-label={`Edit ${selectedFile.path}`}
                      value={editorText}
                      onChange={(e) => setEditorText(e.target.value)}
                      spellCheck={false}
                      rows={22}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-900 focus:border-blue-700 focus:bg-white focus:outline-none"
                    />
                  )}
                </div>
              ) : (
                <div className="p-8 space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 space-y-2 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900">Binary file preserved byte-for-byte</div>
                    <p className="text-xs leading-relaxed text-slate-600">
                      Binary assets are stored verbatim without line-ending conversion or active
                      rendering. Use &ldquo;Replace binary&rdquo; above to upload an exact updated
                      file or &ldquo;Download&rdquo; to inspect it locally.
                    </p>
                    <div className="font-mono text-xs text-slate-600 pt-1">
                      SHA-256: {selectedFile.contentSha256}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};
