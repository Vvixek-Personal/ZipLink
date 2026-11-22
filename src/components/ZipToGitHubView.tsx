import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileArchive,
  GitBranch,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import type {
  AppLimitsInfo,
  GitHubBranchSummary,
  GitHubConfigStatus,
  GitHubRepoSummary,
  MergePullRequestResult,
  PushToGitHubResult,
  SensitiveFileWarning,
  ZipStageRecord,
  ZipToGitHubPlan,
} from '../shared/types.ts';
import { inspectZipFileInBrowser } from '../shared/zipInspect.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { apiRequestJson, getAuthToken, mergeGitHubPullRequest } from '../utils/githubApi.ts';
import { GitHubConnectionBanner } from './GitHubConnectionBanner.tsx';

interface ZipToGitHubViewProps {
  limits: AppLimitsInfo | null;
  githubStatus: GitHubConfigStatus | null;
  statusLoading: boolean;
  authEmail?: string | null;
  onRefreshStatus: () => Promise<void>;
  onNavigateWorkspaces: () => void;
}

export const ZipToGitHubView: React.FC<ZipToGitHubViewProps> = ({
  limits,
  githubStatus,
  statusLoading,
  authEmail,
  onRefreshStatus,
  onNavigateWorkspaces,
}) => {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sensitiveWarnings, setSensitiveWarnings] = useState<SensitiveFileWarning[]>([]);
  const [confirmedSensitive, setConfirmedSensitive] = useState(false);
  const [invalidEntries, setInvalidEntries] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);

  const [stage, setStage] = useState<ZipStageRecord | null>(null);
  const [authorizedRepos, setAuthorizedRepos] = useState<GitHubRepoSummary[]>([]);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState('');
  const [branches, setBranches] = useState<GitHubBranchSummary[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [targetFolder, setTargetFolder] = useState('');
  const [mode, setMode] = useState<'add_update' | 'mirror'>('add_update');

  const [plan, setPlan] = useState<ZipToGitHubPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmedMirrorDeletions, setConfirmedMirrorDeletions] = useState(false);

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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const maxCompressedBytes = limits?.maxCompressedBytes ?? 50 * 1024 * 1024;
  const maxExtractedBytes = limits?.maxExtractedBytes ?? 200 * 1024 * 1024;
  const maxEntryCount = limits?.maxEntryCount ?? 500;

  const loadAuthorizedRepos = useCallback(async () => {
    if (!githubStatus?.connected) {
      setAuthorizedRepos([]);
      return;
    }
    try {
      const res = await apiRequestJson<{ repos: GitHubRepoSummary[] }>('/api/github/repos');
      setAuthorizedRepos(res.repos);
    } catch {
      // ignore until needed
    }
  }, [githubStatus?.connected]);

  useEffect(() => {
    void loadAuthorizedRepos();
  }, [loadAuthorizedRepos]);

  useEffect(() => {
    if (!githubStatus?.connected || !selectedRepoFullName) {
      setBranches([]);
      return;
    }
    const repo = authorizedRepos.find((r) => r.fullName === selectedRepoFullName);
    if (!repo) return;

    setSelectedBranch(repo.defaultBranch);
    apiRequestJson<{ branches: GitHubBranchSummary[] }>(
      `/api/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`,
    )
      .then((res) => {
        setBranches(res.branches);
        if (res.branches.length > 0) {
          const def = res.branches.find((b) => b.name === repo.defaultBranch);
          setSelectedBranch(def ? def.name : res.branches[0].name);
        }
      })
      .catch(() => setBranches([]));
  }, [githubStatus?.connected, selectedRepoFullName, authorizedRepos]);

  const handleFileSelection = async (file: File | null) => {
    setErrorMsg(null);
    setSensitiveWarnings([]);
    setConfirmedSensitive(false);
    setInvalidEntries([]);
    setStage(null);
    setPlan(null);
    setPushResult(null);

    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size === 0) {
      setSelectedFile(null);
      setErrorMsg('The selected file is empty.');
      return;
    }
    if (file.size > maxCompressedBytes) {
      setSelectedFile(null);
      setErrorMsg(
        `Archive (${formatBytes(file.size)}) exceeds the ${formatBytes(maxCompressedBytes)} upload limit.`,
      );
      return;
    }

    setSelectedFile(file);
    try {
      const inspection = await inspectZipFileInBrowser(file);
      setSensitiveWarnings(inspection.sensitiveWarnings);
      setInvalidEntries(inspection.invalidEntries);
    } catch {
      // Server validates authoritatively
    }
  };

  const handleStageZip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || uploading) return;
    if (sensitiveWarnings.length > 0 && !confirmedSensitive) {
      setErrorMsg('Please confirm the sensitive-file notice before uploading to staging.');
      return;
    }

    setErrorMsg(null);
    setUploading(true);
    setUploadPercent(0);
    setMergeResult(null);
    setMergeError(null);
    setConfirmMergeChecked(false);

    const token = await getAuthToken();
    if (!token) {
      setUploading(false);
      setErrorMsg('Please sign in with Google again before staging a ZIP.');
      return;
    }

    const formData = new FormData();
    formData.append('archive', selectedFile);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/zip-to-github/stage');
    xhr.setRequestHeader('X-ZipLink-Client', '1');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        setUploadPercent(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && body?.stage) {
        const nextStage = body.stage as ZipStageRecord;
        setStage(nextStage);
        setPlan(null);
        setPushResult(null);

        if (
          !nextStage.requiresManualSelection &&
          nextStage.suggestions.length > 0 &&
          nextStage.suggestions[0].confidence === 'high'
        ) {
          setSelectedRepoFullName(nextStage.suggestions[0].fullName);
        } else {
          setSelectedRepoFullName('');
        }
        return;
      }
      const errText =
        body && typeof body.error === 'string'
          ? body.error
          : `ZIP staging failed with status ${xhr.status}.`;
      setErrorMsg(errText);
    };

    xhr.onerror = () => {
      setUploading(false);
      setErrorMsg('Network error uploading ZIP for GitHub staging.');
    };

    xhr.send(formData);
  };

  const handlePreviewPlan = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!stage || !selectedRepoFullName || planning) return;
    const repo = authorizedRepos.find((r) => r.fullName === selectedRepoFullName);
    if (!repo) {
      setErrorMsg('Select a repository from your authorized list.');
      return;
    }

    setPlanning(true);
    setErrorMsg(null);
    setConfirmedMirrorDeletions(false);

    try {
      const res = await apiRequestJson<{ plan: ZipToGitHubPlan }>(
        `/api/zip-to-github/stage/${encodeURIComponent(stage.stageId)}/plan`,
        {
          method: 'POST',
          body: JSON.stringify({
            owner: repo.owner,
            repo: repo.name,
            branch: selectedBranch || repo.defaultBranch,
            targetFolder,
            mode,
          }),
        },
      );
      setPlan(res.plan);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      setNewBranchName((prev) => prev || `ziplink/import-${stamp}`);
      setCommitMessage((prev) => prev || `Import ${stage.archiveName} into ${repo.fullName}`);
      setPrTitle((prev) => prev || `Import ${stage.archiveName}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to preview ZIP changes.');
    } finally {
      setPlanning(false);
    }
  };

  const handlePushStage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stage || !plan || pushing) return;
    const repo = authorizedRepos.find((r) => r.fullName === selectedRepoFullName);
    if (!repo) return;

    setPushing(true);
    setErrorMsg(null);
    setMergeResult(null);
    setMergeError(null);
    setConfirmMergeChecked(false);
    try {
      const res = await apiRequestJson<PushToGitHubResult>(
        `/api/zip-to-github/stage/${encodeURIComponent(stage.stageId)}/push`,
        {
          method: 'POST',
          body: JSON.stringify({
            owner: repo.owner,
            repo: repo.name,
            branch: plan.targetBranch,
            targetFolder: plan.targetFolder,
            mode: plan.mode,
            expectedBaseCommitSha: plan.baseCommitSha,
            newBranchName,
            commitMessage,
            prTitle,
            prBody,
            confirmedMirrorDeletions,
            createPullRequest: createPr,
          }),
        },
      );
      setPushResult(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed pushing staged ZIP to GitHub.');
    } finally {
      setPushing(false);
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

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Upload a ZIP to GitHub safely
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-slate-600">
            Separate from public ZIP sharing. Safely extract a ZIP on the server, inspect
            explainable destination suggestions among your authorized repositories, review every
            collision or deletion, and open a review Pull Request on a new branch.
          </p>
        </div>
        <button
          type="button"
          onClick={onNavigateWorkspaces}
          className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          Back to Workspaces
        </button>
      </div>

      <GitHubConnectionBanner
        status={githubStatus}
        loading={statusLoading}
        authEmail={authEmail}
        onRefreshStatus={onRefreshStatus}
      />

      {errorMsg && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {errorMsg}
        </div>
      )}

      {githubStatus?.connected && !stage && (
        <form
          onSubmit={handleStageZip}
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-5 max-w-2xl"
        >
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-900">
              1. Select ZIP archive (staged privately, never published as a share link)
            </h2>
            <p className="text-xs text-slate-500">
              Enforces {formatBytes(maxCompressedBytes)} compressed,{' '}
              {formatBytes(maxExtractedBytes)} extracted, and {maxEntryCount} entry limits.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!uploading) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (!uploading) void handleFileSelection(e.dataTransfer.files?.[0] ?? null);
            }}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              isDragging ? 'border-blue-700 bg-blue-50/70' : 'border-slate-300 bg-slate-50/60'
            }`}
          >
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept=".zip,application/zip"
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              onChange={(e) => void handleFileSelection(e.target.files?.[0] ?? null)}
            />
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700">
              {selectedFile ? (
                <FileArchive className="h-5 w-5 text-blue-700" aria-hidden="true" />
              ) : (
                <Upload className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            {selectedFile ? (
              <div className="mt-3 space-y-1">
                <div className="font-medium text-slate-900">{selectedFile.name}</div>
                <div className="font-mono text-xs text-slate-500">
                  {formatBytes(selectedFile.size)}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs font-medium text-blue-700 hover:underline pt-1"
                >
                  Choose another ZIP
                </button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-slate-700">Drag and drop a ZIP file here, or</p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
                >
                  Browse files
                </button>
              </div>
            )}
          </div>

          {invalidEntries.length > 0 && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 flex items-center gap-2"
            >
              <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              Unsafe entry paths detected inside archive; server upload will reject it.
            </div>
          )}

          {sensitiveWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-xs text-amber-950">
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden="true" />
                Likely sensitive files detected ({sensitiveWarnings.length}) — not a complete secrets
                scan
              </div>
              <ul className="font-mono space-y-0.5 max-h-24 overflow-y-auto bg-white/80 rounded border border-amber-200 p-2">
                {sensitiveWarnings.map((w) => (
                  <li key={w.relativePath}>
                    {w.relativePath} — {w.reason}
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={confirmedSensitive}
                  onChange={(e) => setConfirmedSensitive(e.target.checked)}
                />
                <span>I confirm these files are safe to stage for GitHub review.</span>
              </label>
            </div>
          )}

          {uploading && (
            <div className="text-xs font-mono text-slate-600">
              Uploading &amp; matching against authorized repos... {uploadPercent}%
            </div>
          )}

          <button
            type="submit"
            disabled={
              !selectedFile ||
              uploading ||
              (sensitiveWarnings.length > 0 && !confirmedSensitive)
            }
            className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600"
          >
            {uploading ? 'Extracting & scanning authorized repos...' : 'Analyze ZIP & suggest destination'}
          </button>
        </form>
      )}

      {githubStatus?.connected && stage && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  2. Choose destination repository &amp; branch for {stage.archiveName}
                </h2>
                <p className="text-xs text-slate-500 font-mono">
                  {stage.totalFiles} files extracted · {formatBytes(stage.totalExtractedBytes)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStage(null);
                  setPlan(null);
                  setPushResult(null);
                }}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                Upload a different ZIP
              </button>
            </div>

            <div
              className={`rounded-lg border p-3.5 text-xs ${
                stage.requiresManualSelection || stage.isAmbiguous
                  ? 'border-amber-300 bg-amber-50 text-amber-950'
                  : 'border-blue-200 bg-blue-50 text-blue-950'
              }`}
            >
              {stage.suggestionSummary}
            </div>

            {stage.suggestions.length > 0 && (
              <div className="space-y-3">
                <div className="text-xs font-semibold text-slate-700">
                  Suggested authorized repositories
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {stage.suggestions.map((s) => {
                    const isPicked = selectedRepoFullName === s.fullName;
                    return (
                      <div
                        key={s.repoId}
                        className={`rounded-lg border p-4 space-y-2.5 ${
                          isPicked ? 'border-blue-700 bg-blue-50/40' : 'border-slate-200 bg-slate-50/60'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-sm text-slate-900">{s.fullName}</div>
                            <div className="text-xs text-slate-600 font-mono">
                              Confidence: {s.confidence} · {s.exactHashMatchCount} exact hash match(es)
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedRepoFullName(s.fullName);
                              setPlan(null);
                            }}
                            className={`rounded-md px-3 py-1 text-xs font-semibold ${
                              isPicked
                                ? 'bg-blue-700 text-white'
                                : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                            }`}
                          >
                            {isPicked ? 'Selected' : 'Use repo'}
                          </button>
                        </div>

                        <ul className="space-y-1 text-xs text-slate-600 list-disc pl-4">
                          {s.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Manual selection / override */}
            <form onSubmit={handlePreviewPlan} className="border-t border-slate-200 pt-5 space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="z2g-repo" className="block text-xs font-semibold text-slate-700 mb-1">
                    Destination repository (manual override)
                  </label>
                  <select
                    id="z2g-repo"
                    value={selectedRepoFullName}
                    onChange={(e) => {
                      setSelectedRepoFullName(e.target.value);
                      setPlan(null);
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Select repository...</option>
                    {authorizedRepos.map((r) => (
                      <option key={r.id} value={r.fullName}>
                        {r.fullName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="z2g-branch" className="block text-xs font-semibold text-slate-700 mb-1">
                    Target base branch
                  </label>
                  <select
                    id="z2g-branch"
                    value={selectedBranch}
                    disabled={!selectedRepoFullName}
                    onChange={(e) => {
                      setSelectedBranch(e.target.value);
                      setPlan(null);
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
                  >
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="z2g-folder" className="block text-xs font-semibold text-slate-700 mb-1">
                    Target folder (optional)
                  </label>
                  <input
                    id="z2g-folder"
                    type="text"
                    value={targetFolder}
                    onChange={(e) => {
                      setTargetFolder(e.target.value);
                      setPlan(null);
                    }}
                    placeholder="Root directory (or e.g. packages/app)"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-slate-700">Update mode</legend>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="z2g-mode"
                      checked={mode === 'add_update'}
                      onChange={() => {
                        setMode('add_update');
                        setPlan(null);
                      }}
                    />
                    <span>
                      <strong>Add or update files</strong> (default — keeps repo files absent from
                      ZIP)
                    </span>
                  </label>

                  <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="z2g-mode"
                      checked={mode === 'mirror'}
                      onChange={() => {
                        setMode('mirror');
                        setPlan(null);
                      }}
                    />
                    <span>
                      <strong>Mirror ZIP exactly</strong> (deletes repository files missing from
                      ZIP after confirmation)
                    </span>
                  </label>
                </div>
              </fieldset>

              <button
                type="submit"
                disabled={!selectedRepoFullName || planning}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-600"
              >
                {planning ? 'Checking GitHub tree & collisions...' : 'Preview file plan & collisions'}
              </button>
            </form>
          </div>

          {plan && !pushResult && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-slate-900">
                  3. Review changes for {plan.repoFullName} ({plan.targetBranch})
                </h2>
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-slate-600">
                  <span>Base {plan.baseCommitSha.slice(0, 7)}</span>
                  <span>·</span>
                  <span>{plan.additions.length} additions</span>
                  <span>·</span>
                  <span>{plan.collisions.length} overwrites/collisions</span>
                  <span>·</span>
                  <span>{plan.unchanged.length} unchanged</span>
                  {plan.mode === 'mirror' && (
                    <>
                      <span>·</span>
                      <span className="text-red-700 font-semibold">
                        {plan.deletions.length} deletions
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {plan.collisions.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
                    <div className="text-xs font-semibold text-amber-950">
                      Path collisions ({plan.collisions.length}) — existing files with different
                      contents
                    </div>
                    <ul className="max-h-40 overflow-y-auto space-y-1 font-mono text-[11px] text-amber-900">
                      {plan.collisions.map((c) => (
                        <li key={c.targetPath}>
                          {c.targetPath} ({formatBytes(c.existingSizeBytes)} -&gt;{' '}
                          {formatBytes(c.sizeBytes)})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.additions.length > 0 && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-2">
                    <div className="text-xs font-semibold text-emerald-950">
                      New files to add ({plan.additions.length})
                    </div>
                    <ul className="max-h-40 overflow-y-auto space-y-1 font-mono text-[11px] text-emerald-900">
                      {plan.additions.map((a) => (
                        <li key={a.targetPath}>
                          + {a.targetPath} ({formatBytes(a.sizeBytes)})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {plan.mode === 'mirror' && plan.deletions.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
                  <div className="text-xs font-semibold text-red-950">
                    Mirror deletions ({plan.deletions.length}) — these repository files will be
                    deleted because they are missing from the ZIP:
                  </div>
                  <ul className="max-h-40 overflow-y-auto space-y-1 font-mono text-[11px] text-red-900">
                    {plan.deletions.map((d) => (
                      <li key={d.targetPath}>
                        - {d.targetPath} ({formatBytes(d.sizeBytes)})
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2 text-xs font-medium text-red-950 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmedMirrorDeletions}
                      onChange={(e) => setConfirmedMirrorDeletions(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I have reviewed the deletion list above and explicitly confirm deleting these{' '}
                      {plan.deletions.length} file(s).
                    </span>
                  </label>
                </div>
              )}

              <form onSubmit={handlePushStage} className="border-t border-slate-200 pt-5 space-y-4 max-w-xl">
                <div>
                  <label htmlFor="z2g-new-branch" className="block text-xs font-semibold text-slate-700 mb-1">
                    New branch name (never pushes directly to {plan.targetBranch})
                  </label>
                  <div className="relative">
                    <GitBranch
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                      aria-hidden="true"
                    />
                    <input
                      id="z2g-new-branch"
                      type="text"
                      required
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 font-mono text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="z2g-commit" className="block text-xs font-semibold text-slate-700 mb-1">
                    Commit message
                  </label>
                  <input
                    id="z2g-commit"
                    type="text"
                    required
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={createPr}
                    onChange={(e) => setCreatePr(e.target.checked)}
                  />
                  Open Pull Request targeting {plan.targetBranch} (recommended)
                </label>

                {createPr && (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="Pull Request title"
                      aria-label="Pull Request title"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <textarea
                      rows={2}
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                      placeholder="Optional Pull Request summary"
                      aria-label="Pull Request summary"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={
                    pushing ||
                    (plan.additions.length === 0 &&
                      plan.collisions.length === 0 &&
                      plan.deletions.length === 0) ||
                    (plan.mode === 'mirror' &&
                      plan.deletions.length > 0 &&
                      !confirmedMirrorDeletions)
                  }
                  className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600"
                >
                  {pushing ? 'Creating commit & branch on GitHub...' : 'Push ZIP changes to new branch'}
                </button>
              </form>
            </div>
          )}

          {pushResult && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 space-y-3 text-sm text-emerald-950">
              <div className="flex items-center gap-2 font-bold">
                <Check className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                Pushed staged ZIP commit {pushResult.commitSha.slice(0, 7)} to branch &ldquo;
                {pushResult.branch}&rdquo;
              </div>

              {pushResult.prWarning && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                  {pushResult.prWarning}
                </div>
              )}

              <div className="flex flex-wrap gap-4 text-xs font-semibold">
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
                  Compare on GitHub
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
                          reviewing the Pull Request on GitHub.
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
                          <label htmlFor="z2g-merge-method" className="font-medium text-slate-700">
                            Method:
                          </label>
                          <select
                            id="z2g-merge-method"
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
        </div>
      )}
    </div>
  );
};
