import React, { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  FolderGit2,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  GitHubBranchSummary,
  GitHubConfigStatus,
  GitHubRepoSummary,
  WorkspaceSummary,
} from '../shared/types.ts';
import { apiRequestJson } from '../utils/githubApi.ts';
import { formatUtcDate } from '../utils/fileTree.ts';
import { GitHubConnectionBanner } from './GitHubConnectionBanner.tsx';

interface WorkspacesHomeProps {
  githubStatus: GitHubConfigStatus | null;
  statusLoading: boolean;
  authEmail?: string | null;
  onRefreshStatus: () => Promise<void>;
  onOpenWorkspace: (workspaceId: string) => void;
  onNavigateZipToGitHub: () => void;
}

function statusDescription(ws: WorkspaceSummary): string {
  if (ws.status === 'conflicts') {
    return `${ws.conflictCount} unresolved pull conflict(s)`;
  }
  if (ws.status === 'pending_deletions') {
    return 'Upstream deletions awaiting confirmation';
  }
  if (ws.status === 'modified') {
    return `${ws.dirtyCount} uncommitted local change(s)`;
  }
  return 'Synced with base commit';
}

export const WorkspacesHome: React.FC<WorkspacesHomeProps> = ({
  githubStatus,
  statusLoading,
  authEmail,
  onRefreshStatus,
  onOpenWorkspace,
  onNavigateZipToGitHub,
}) => {
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);

  const [selectedRepoFullName, setSelectedRepoFullName] = useState('');
  const [branches, setBranches] = useState<GitHubBranchSummary[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [creatingRepo, setCreatingRepo] = useState(false);

  const loadWorkspacesAndRepos = useCallback(async () => {
    if (!githubStatus?.connected) {
      setRepos([]);
      setWorkspaces([]);
      setBranches([]);
      setSelectedRepoFullName('');
      setSelectedBranch('');
      return;
    }

    setErrorMsg(null);
    setReposLoading(true);
    setWorkspacesLoading(true);

    try {
      const [reposRes, wsRes] = await Promise.all([
        apiRequestJson<{ repos: GitHubRepoSummary[]; needsAppInstallation: boolean }>(
          '/api/github/repos',
        ),
        apiRequestJson<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
      ]);

      setRepos(reposRes.repos);
      setNeedsInstall(reposRes.needsAppInstallation);
      setWorkspaces(wsRes.workspaces);

      if (reposRes.repos.length > 0 && !selectedRepoFullName) {
        setSelectedRepoFullName(reposRes.repos[0].fullName);
        setSelectedBranch(reposRes.repos[0].defaultBranch);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed loading GitHub repositories.');
    } finally {
      setReposLoading(false);
      setWorkspacesLoading(false);
    }
  }, [githubStatus?.connected, selectedRepoFullName]);

  useEffect(() => {
    void loadWorkspacesAndRepos();
  }, [loadWorkspacesAndRepos]);

  useEffect(() => {
    if (!githubStatus?.connected || !selectedRepoFullName) {
      setBranches([]);
      return;
    }
    const repo = repos.find((r) => r.fullName === selectedRepoFullName);
    if (!repo) return;

    setBranchesLoading(true);
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
      .catch((err) => {
        setBranches([]);
        setErrorMsg(err instanceof Error ? err.message : 'Unable to load repository branches.');
      })
      .finally(() => setBranchesLoading(false));
  }, [githubStatus?.connected, selectedRepoFullName, repos]);

  const handleImportWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const repo = repos.find((r) => r.fullName === selectedRepoFullName);
    if (!repo || !selectedBranch || importing) return;

    setErrorMsg(null);
    setImporting(true);
    try {
      const res = await apiRequestJson<{ workspace: { workspaceId: string } }>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
          branch: selectedBranch,
        }),
      });
      onOpenWorkspace(res.workspace.workspaceId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed importing repository workspace.');
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    if (deletingId) return;
    setDeletingId(workspaceId);
    setErrorMsg(null);
    try {
      await apiRequestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
      });
      setWorkspaces((prev) => prev.filter((w) => w.workspaceId !== workspaceId));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed deleting workspace.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || creatingRepo) return;
    setCreatingRepo(true);
    setErrorMsg(null);
    try {
      const res = await apiRequestJson<{ repo: GitHubRepoSummary }>('/api/github/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: newRepoName.trim(),
          description: 'Created from ZipLink workspace',
          private: newRepoPrivate,
        }),
      });
      setNewRepoName('');
      setShowCreateRepo(false);
      await loadWorkspacesAndRepos();
      setSelectedRepoFullName(res.repo.fullName);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'GitHub rejected repository creation with the current App permissions.',
      );
    } finally {
      setCreatingRepo(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            GitHub Repository Workspaces
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-slate-600">
            Pull authorized GitHub repositories via the Git Trees API into private, persistent
            ZipLink editing workspaces, resolve conflicts cleanly, and open Pull Requests on new
            branches.
          </p>
        </div>

        <button
          type="button"
          onClick={onNavigateZipToGitHub}
          className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          Push a ZIP to GitHub instead
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

      {githubStatus?.connected && (
        <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
          {/* Import repository branch form */}
          <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-slate-900">
                  Import repository into workspace
                </h2>
                <p className="text-xs text-slate-500">
                  Only repositories authorized via your ZipLink GitHub App installation appear here.
                </p>
              </div>
              <button
                type="button"
                disabled={reposLoading}
                onClick={() => void loadWorkspacesAndRepos()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${reposLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                Refresh
              </button>
            </div>

            {needsInstall || repos.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3 text-sm text-slate-700">
                <div className="font-semibold text-slate-900">
                  No authorized repositories available yet
                </div>
                <p className="text-xs leading-relaxed text-slate-600">
                  Grant ZipLink access to one or more repositories in your GitHub App installation
                  settings, then click Refresh.
                </p>
                {githubStatus.installUrl && (
                  <a
                    href={githubStatus.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    Authorize repositories on GitHub
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
            ) : (
              <form onSubmit={handleImportWorkspace} className="space-y-4">
                <div>
                  <label
                    htmlFor="workspace-repo-select"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Authorized repository
                  </label>
                  <select
                    id="workspace-repo-select"
                    value={selectedRepoFullName}
                    onChange={(e) => setSelectedRepoFullName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-700 focus:outline-none"
                  >
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.fullName}>
                        {repo.fullName} ({repo.private ? 'Private' : 'Public'})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="workspace-branch-select"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Branch to import
                  </label>
                  <select
                    id="workspace-branch-select"
                    value={selectedBranch}
                    disabled={branchesLoading || branches.length === 0}
                    onChange={(e) => setSelectedBranch(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-700 focus:outline-none disabled:bg-slate-100"
                  >
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name} · {b.commitSha.slice(0, 7)}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={importing || !selectedRepoFullName || !selectedBranch}
                  className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600"
                >
                  {importing ? 'Importing Git tree & blobs...' : 'Pull branch into private workspace'}
                </button>
              </form>
            )}

            <div className="border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => setShowCreateRepo((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {showCreateRepo ? 'Cancel new repository' : 'Create new GitHub repository (if permitted)'}
              </button>

              {showCreateRepo && (
                <form onSubmit={handleCreateRepository} className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <div>
                    <label htmlFor="new-repo-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Repository name
                    </label>
                    <input
                      id="new-repo-name"
                      type="text"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="my-project"
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={newRepoPrivate}
                      onChange={(e) => setNewRepoPrivate(e.target.checked)}
                    />
                    Private repository
                  </label>
                  <button
                    type="submit"
                    disabled={creatingRepo || !newRepoName.trim()}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
                  >
                    {creatingRepo ? 'Creating...' : 'Create repository'}
                  </button>
                </form>
              )}
            </div>
          </section>

          {/* Persistent workspaces list */}
          <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900">
                Your private workspaces ({workspaces.length})
              </h2>
              <span className="text-xs text-slate-500">Never auto-published as share links</span>
            </div>

            {workspacesLoading && workspaces.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                Loading workspaces...
              </div>
            ) : workspaces.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-8 text-center space-y-2">
                <FolderGit2 className="mx-auto h-6 w-6 text-slate-400" aria-hidden="true" />
                <div className="text-sm font-medium text-slate-800">No workspaces yet</div>
                <p className="text-xs text-slate-500">
                  Import an authorized repository branch on the left to start editing files safely.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {workspaces.map((ws) => (
                  <li key={ws.workspaceId} className="py-4 first:pt-0 last:pb-0 space-y-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-900 break-all">
                            {ws.repoFullName}
                          </span>
                          <span className="text-slate-300">·</span>
                          <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-700">
                            <GitBranch className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                            {ws.branch}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums">
                          Base {ws.baseCommitSha.slice(0, 7)} · {ws.fileCount} files · Synced{' '}
                          {formatUtcDate(ws.lastSyncedAt)}
                        </div>
                        <div
                          className={`text-xs font-medium ${
                            ws.status === 'conflicts'
                              ? 'text-red-700'
                              : ws.status === 'pending_deletions'
                                ? 'text-amber-700'
                                : ws.status === 'modified'
                                  ? 'text-blue-700'
                                  : 'text-emerald-700'
                          }`}
                        >
                          {statusDescription(ws)}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => onOpenWorkspace(ws.workspaceId)}
                          className="rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === ws.workspaceId}
                          onClick={() => void handleDeleteWorkspace(ws.workspaceId)}
                          aria-label={`Delete workspace ${ws.repoFullName}`}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
