import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type {
  GitHubBranchSummary,
  GitHubConfigStatus,
  GitHubConnectionRecord,
  GitHubRepoSummary,
  GitHubWorkspaceRecord,
  MergePullRequestResult,
  PullCheckResult,
  PushToGitHubResult,
  StagedZipFile,
  WorkspaceBaseFile,
  WorkspaceConflict,
  WorkspaceDiffSummary,
  WorkspaceFileEntry,
  WorkspaceSummary,
  ZipStageRecord,
  ZipToGitHubPlan,
} from '../shared/types.ts';
import {
  computeThreeWayPullPlan,
  computeWorkspaceDiffItems,
  computeZipToGitHubPlan,
  normalizeTargetFolder,
} from '../shared/gitSync.ts';
import { rankRepositorySuggestions, type RepoCandidateInput } from '../shared/repoMatcher.ts';
import {
  classifyTextContent,
  detectSensitiveFilenames,
  formatBytes,
  isActiveWebContent,
  validateArchiveEntryPath,
} from '../shared/zipSecurity.ts';
import type { ZipLinkConfig } from './config.ts';
import {
  computeGitBlobSha1,
  computeSha256Hex,
  decryptSecret,
  encryptSecret,
} from './gitHash.ts';
import {
  GitHubRemoteMovedError,
  type AuthorizedReposResult,
  type GitCommitTreeChange,
  type GitHubClient,
} from './githubClient.ts';
import type { StorageProvider } from './storage.ts';
import { safelyExtractZipToTempDir } from './zipExtractor.ts';

export class WorkspaceServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'WorkspaceServiceError';
    this.statusCode = statusCode;
  }
}

export function validateNewBranchName(branchName: string, protectedBranches: string[]): string {
  const trimmed = branchName.trim();
  if (!trimmed) {
    throw new WorkspaceServiceError('Please enter a new branch name.', 400);
  }
  if (
    trimmed.length < 2 ||
    trimmed.length > 120 ||
    !/^[A-Za-z0-9._/-]+$/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.endsWith('.lock') ||
    trimmed.endsWith('.')
  ) {
    throw new WorkspaceServiceError(
      'Branch name contains invalid Git ref characters or formatting.',
      400,
    );
  }
  for (const b of protectedBranches) {
    if (trimmed === b) {
      throw new WorkspaceServiceError(
        `Refusing to push directly to "${b}". Enter a new feature/review branch name instead.`,
        400,
      );
    }
  }
  return trimmed;
}

export function toWorkspaceSummary(ws: GitHubWorkspaceRecord): WorkspaceSummary {
  const dirtyCount = computeWorkspaceDiffItems({
    baseFiles: ws.baseFiles,
    workspaceFiles: ws.files,
  }).length;
  return {
    workspaceId: ws.workspaceId,
    repoFullName: ws.repoFullName,
    defaultBranch: ws.defaultBranch,
    branch: ws.branch,
    baseCommitSha: ws.baseCommitSha,
    lastSyncedAt: ws.lastSyncedAt,
    updatedAt: ws.updatedAt,
    status: ws.status,
    fileCount: ws.files.filter((f) => !f.deletedInWorkspace).length,
    dirtyCount,
    conflictCount: ws.conflicts.filter((c) => c.resolution === 'unresolved').length,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }

  const runners = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => next());
  await Promise.all(runners);
  return results;
}

export class WorkspaceService {
  private readonly config: ZipLinkConfig;
  private readonly storage: StorageProvider;
  private readonly githubClient: GitHubClient;
  private readonly nowFn: () => number;

  constructor(params: {
    config: ZipLinkConfig;
    storage: StorageProvider;
    githubClient: GitHubClient;
    now?: () => number;
  }) {
    this.config = params.config;
    this.storage = params.storage;
    this.githubClient = params.githubClient;
    this.nowFn = params.now ?? (() => Date.now());
  }

  getConfigStatus(
    currentBaseUrl: string,
    connection: GitHubConnectionRecord | null,
  ): GitHubConfigStatus {
    const missingVars: string[] = [];
    if (!this.config.githubClientId) missingVars.push('GITHUB_CLIENT_ID');
    if (!this.config.githubClientSecret) missingVars.push('GITHUB_CLIENT_SECRET');
    if (!this.config.githubAppSlug) missingVars.push('GITHUB_APP_SLUG');

    const configured = missingVars.length === 0;
    const appSlug = this.config.githubAppSlug || null;
    const installUrl = appSlug
      ? `${this.config.githubAuthBaseUrl}/apps/${encodeURIComponent(appSlug)}/installations/new`
      : null;

    const cleanCurrent = currentBaseUrl.replace(/\/+$/, '');
    const devOrigin = this.config.appUrl || cleanCurrent;

    return {
      configured,
      missingVars,
      appSlug,
      installUrl,
      callbackUrls: {
        development: `${devOrigin}/api/github/callback`,
        current: `${cleanCurrent}/api/github/callback`,
      },
      connected: Boolean(connection),
      user: connection ? connection.user : null,
    };
  }

  async getValidAccessToken(connection: GitHubConnectionRecord): Promise<string> {
    const accessToken = decryptSecret(connection.encryptedAccessToken, this.config.sessionKey);
    if (!accessToken) {
      throw new WorkspaceServiceError(
        'GitHub connection credentials are invalid. Please reconnect GitHub.',
        401,
      );
    }

    const nowMs = this.nowFn();
    if (connection.tokenExpiresAtMs && connection.tokenExpiresAtMs <= nowMs + 60 * 1000) {
      const refreshToken = connection.encryptedRefreshToken
        ? decryptSecret(connection.encryptedRefreshToken, this.config.sessionKey)
        : null;
      if (!refreshToken) {
        throw new WorkspaceServiceError('GitHub session expired. Please reconnect GitHub.', 401);
      }

      const refreshed = await this.githubClient.refreshUserToken(refreshToken);
      const updatedConn: GitHubConnectionRecord = {
        ...connection,
        encryptedAccessToken: encryptSecret(refreshed.accessToken, this.config.sessionKey),
        encryptedRefreshToken: refreshed.refreshToken
          ? encryptSecret(refreshed.refreshToken, this.config.sessionKey)
          : connection.encryptedRefreshToken,
        tokenExpiresAtMs: refreshed.expiresInSeconds
          ? nowMs + refreshed.expiresInSeconds * 1000
          : null,
        updatedAtMs: nowMs,
      };
      await this.storage.saveGitHubConnection(updatedConn);
      return refreshed.accessToken;
    }

    return accessToken;
  }

  async listAuthorizedRepos(connection: GitHubConnectionRecord): Promise<AuthorizedReposResult> {
    const token = await this.getValidAccessToken(connection);
    return this.githubClient.listAuthorizedRepos(token);
  }

  async assertAuthorizedRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepoSummary> {
    const { repos } = await this.githubClient.listAuthorizedRepos(accessToken);
    const fullNameLower = `${owner}/${repo}`.toLowerCase();
    const match = repos.find((r) => r.fullName.toLowerCase() === fullNameLower);
    if (!match) {
      throw new WorkspaceServiceError(
        `Repository "${owner}/${repo}" is not in your ZipLink GitHub App authorized repositories.`,
        403,
      );
    }
    return match;
  }

  async listRepoBranches(
    connection: GitHubConnectionRecord,
    owner: string,
    repo: string,
  ): Promise<GitHubBranchSummary[]> {
    const token = await this.getValidAccessToken(connection);
    await this.assertAuthorizedRepo(token, owner, repo);
    return this.githubClient.listBranches(token, owner, repo);
  }

  async getOwnedWorkspace(workspaceId: string, ownerUid: string): Promise<GitHubWorkspaceRecord> {
    const ws = await this.storage.getWorkspace(workspaceId);
    if (!ws || ws.ownerUid !== ownerUid) {
      throw new WorkspaceServiceError('Workspace not found.', 404);
    }
    return ws;
  }

  private recomputeStatus(ws: GitHubWorkspaceRecord): GitHubWorkspaceRecord['status'] {
    if (ws.conflicts.some((c) => c.resolution === 'unresolved')) {
      return 'conflicts';
    }
    if (ws.pendingUpstreamDeletions.some((d) => !d.confirmed)) {
      return 'pending_deletions';
    }
    const diffItems = computeWorkspaceDiffItems({
      baseFiles: ws.baseFiles,
      workspaceFiles: ws.files,
    });
    return diffItems.length > 0 ? 'modified' : 'clean';
  }

  async importRepositoryWorkspace(params: {
    connection: GitHubConnectionRecord;
    owner: string;
    repo: string;
    branch: string;
  }): Promise<GitHubWorkspaceRecord> {
    const token = await this.getValidAccessToken(params.connection);
    const authRepo = await this.assertAuthorizedRepo(token, params.owner, params.repo);
    const targetBranch = params.branch.trim() || authRepo.defaultBranch;

    const head = await this.githubClient.getBranchHead(
      token,
      authRepo.owner,
      authRepo.name,
      targetBranch,
    );
    const remoteTree = await this.githubClient.getTreeRecursive(
      token,
      authRepo.owner,
      authRepo.name,
      head.treeSha,
      this.config.maxEntryCount,
    );

    const declaredTotalBytes = remoteTree.reduce((sum, e) => sum + e.sizeBytes, 0);
    if (declaredTotalBytes > this.config.maxExtractedBytes) {
      throw new WorkspaceServiceError(
        `Repository branch exceeds the ${formatBytes(this.config.maxExtractedBytes)} workspace size limit.`,
        413,
      );
    }

    const workspaceId = crypto.randomBytes(18).toString('base64url');
    const nowIso = new Date(this.nowFn()).toISOString();

    let downloadedBytesTotal = 0;
    const baseFiles: WorkspaceBaseFile[] = [];
    const files: WorkspaceFileEntry[] = [];

    try {
      await runWithConcurrency(remoteTree, 6, async (entry) => {
        const bytes = await this.githubClient.getBlobRaw(
          token,
          authRepo.owner,
          authRepo.name,
          entry.sha,
        );
        downloadedBytesTotal += bytes.byteLength;
        if (downloadedBytesTotal > this.config.maxExtractedBytes) {
          throw new WorkspaceServiceError(
            `Repository content exceeded the ${formatBytes(this.config.maxExtractedBytes)} workspace size limit.`,
            413,
          );
        }

        const contentSha256 = computeSha256Hex(bytes);
        const gitBlobSha = computeGitBlobSha1(bytes);
        const cls = classifyTextContent(entry.path, bytes);
        const isActiveContent = isActiveWebContent(entry.path);

        const baseBlobId = crypto.randomUUID();
        await this.storage.saveWorkspaceBlob(workspaceId, baseBlobId, bytes);

        baseFiles.push({
          path: entry.path,
          sizeBytes: bytes.byteLength,
          contentSha256,
          gitBlobSha,
          mode: entry.mode || '100644',
          isText: cls.isText,
          blobId: baseBlobId,
        });

        files.push({
          id: crypto.randomUUID(),
          path: entry.path,
          basePath: entry.path,
          sizeBytes: bytes.byteLength,
          contentSha256,
          baseSha256: contentSha256,
          gitBlobSha,
          baseGitBlobSha: gitBlobSha,
          mode: entry.mode || '100644',
          isText: cls.isText,
          isActiveContent,
          blobId: baseBlobId,
          baseBlobId,
          deletedInWorkspace: false,
          updatedAt: nowIso,
        });
      });
    } catch (err) {
      await this.storage.deleteWorkspace(workspaceId).catch(() => undefined);
      throw err;
    }

    baseFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));

    const workspace: GitHubWorkspaceRecord = {
      workspaceId,
      ownerUid: params.connection.uid,
      ownerGithubId: params.connection.user.id,
      ownerLogin: params.connection.user.login,
      repoId: authRepo.id,
      repoOwner: authRepo.owner,
      repoName: authRepo.name,
      repoFullName: authRepo.fullName,
      repoHtmlUrl: authRepo.htmlUrl,
      defaultBranch: authRepo.defaultBranch,
      branch: targetBranch,
      baseCommitSha: head.commitSha,
      baseTreeSha: head.treeSha,
      lastSyncedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'clean',
      files,
      baseFiles,
      pendingPullCommitSha: null,
      pendingPullTreeSha: null,
      pendingUpdates: [],
      pendingUpstreamDeletions: [],
      conflicts: [],
    };

    await this.storage.saveWorkspace(workspace);
    return workspace;
  }

  async readWorkspaceFile(params: {
    workspaceId: string;
    ownerUid: string;
    fileId: string;
  }): Promise<{ file: WorkspaceFileEntry; bytes: Buffer }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const file = ws.files.find((f) => f.id === params.fileId && !f.deletedInWorkspace);
    if (!file) {
      throw new WorkspaceServiceError('File not found in workspace.', 404);
    }
    const bytes = await this.storage.getWorkspaceBlob(ws.workspaceId, file.blobId);
    if (!bytes) {
      throw new WorkspaceServiceError('Stored workspace file blob is missing.', 404);
    }
    return { file, bytes };
  }

  async updateTextFile(params: {
    workspaceId: string;
    ownerUid: string;
    fileId: string;
    content: string;
  }): Promise<{ workspace: GitHubWorkspaceRecord; file: WorkspaceFileEntry }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const file = ws.files.find((f) => f.id === params.fileId && !f.deletedInWorkspace);
    if (!file) {
      throw new WorkspaceServiceError('File not found in workspace.', 404);
    }
    if (!file.isText) {
      throw new WorkspaceServiceError(
        'Binary files cannot be edited as text. Upload a replacement binary file instead.',
        415,
      );
    }

    const bytes = Buffer.from(params.content, 'utf8');
    if (bytes.byteLength > this.config.maxTextPreviewBytes) {
      throw new WorkspaceServiceError(
        `Edited file exceeds the ${formatBytes(this.config.maxTextPreviewBytes)} text editor limit.`,
        413,
      );
    }

    const newBlobId = crypto.randomUUID();
    await this.storage.saveWorkspaceBlob(ws.workspaceId, newBlobId, bytes);

    const oldBlobId = file.blobId;
    const nowIso = new Date(this.nowFn()).toISOString();
    file.blobId = newBlobId;
    file.sizeBytes = bytes.byteLength;
    file.contentSha256 = computeSha256Hex(bytes);
    file.gitBlobSha = computeGitBlobSha1(bytes);
    file.updatedAt = nowIso;

    if (oldBlobId && oldBlobId !== file.baseBlobId) {
      await this.storage.deleteWorkspaceBlob(ws.workspaceId, oldBlobId).catch(() => undefined);
    }

    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);
    return { workspace: ws, file };
  }

  async createFile(params: {
    workspaceId: string;
    ownerUid: string;
    filePath: string;
    bytes: Buffer;
    forceText?: boolean;
  }): Promise<{ workspace: GitHubWorkspaceRecord; file: WorkspaceFileEntry }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const check = validateArchiveEntryPath(params.filePath);
    if (!check.valid || !check.normalizedPath || check.isDirectory) {
      throw new WorkspaceServiceError(check.reason || 'Invalid file path.', 400);
    }
    const normalizedPath = check.normalizedPath;

    const existingActive = ws.files.find(
      (f) => f.path === normalizedPath && !f.deletedInWorkspace,
    );
    if (existingActive) {
      throw new WorkspaceServiceError(`A file already exists at "${normalizedPath}".`, 409);
    }

    const activeCount = ws.files.filter((f) => !f.deletedInWorkspace).length;
    if (activeCount >= this.config.maxEntryCount) {
      throw new WorkspaceServiceError(
        `Workspace cannot exceed ${this.config.maxEntryCount} files.`,
        413,
      );
    }

    const totalBytes =
      ws.files
        .filter((f) => !f.deletedInWorkspace)
        .reduce((sum, f) => sum + f.sizeBytes, 0) + params.bytes.byteLength;
    if (totalBytes > this.config.maxExtractedBytes) {
      throw new WorkspaceServiceError(
        `Workspace total size cannot exceed ${formatBytes(this.config.maxExtractedBytes)}.`,
        413,
      );
    }

    const blobId = crypto.randomUUID();
    await this.storage.saveWorkspaceBlob(ws.workspaceId, blobId, params.bytes);

    const cls = classifyTextContent(normalizedPath, params.bytes);
    const isText = params.forceText ? true : cls.isText;
    const nowIso = new Date(this.nowFn()).toISOString();
    const contentSha256 = computeSha256Hex(params.bytes);
    const gitBlobSha = computeGitBlobSha1(params.bytes);

    const tombstone = ws.files.find(
      (f) => f.deletedInWorkspace && f.basePath === normalizedPath,
    );

    let resultFile: WorkspaceFileEntry;
    if (tombstone) {
      tombstone.path = normalizedPath;
      tombstone.sizeBytes = params.bytes.byteLength;
      tombstone.contentSha256 = contentSha256;
      tombstone.gitBlobSha = gitBlobSha;
      tombstone.isText = isText;
      tombstone.isActiveContent = isActiveWebContent(normalizedPath);
      tombstone.blobId = blobId;
      tombstone.deletedInWorkspace = false;
      tombstone.updatedAt = nowIso;
      resultFile = tombstone;
    } else {
      resultFile = {
        id: crypto.randomUUID(),
        path: normalizedPath,
        basePath: null,
        sizeBytes: params.bytes.byteLength,
        contentSha256,
        baseSha256: null,
        gitBlobSha,
        baseGitBlobSha: null,
        mode: '100644',
        isText,
        isActiveContent: isActiveWebContent(normalizedPath),
        blobId,
        baseBlobId: null,
        deletedInWorkspace: false,
        updatedAt: nowIso,
      };
      ws.files.push(resultFile);
    }

    ws.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);
    return { workspace: ws, file: resultFile };
  }

  async replaceBinaryFile(params: {
    workspaceId: string;
    ownerUid: string;
    fileId: string;
    bytes: Buffer;
  }): Promise<{ workspace: GitHubWorkspaceRecord; file: WorkspaceFileEntry }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const file = ws.files.find((f) => f.id === params.fileId && !f.deletedInWorkspace);
    if (!file) {
      throw new WorkspaceServiceError('File not found in workspace.', 404);
    }

    const otherBytes = ws.files
      .filter((f) => !f.deletedInWorkspace && f.id !== file.id)
      .reduce((sum, f) => sum + f.sizeBytes, 0);
    if (otherBytes + params.bytes.byteLength > this.config.maxExtractedBytes) {
      throw new WorkspaceServiceError(
        `Workspace total size cannot exceed ${formatBytes(this.config.maxExtractedBytes)}.`,
        413,
      );
    }

    const newBlobId = crypto.randomUUID();
    await this.storage.saveWorkspaceBlob(ws.workspaceId, newBlobId, params.bytes);

    const oldBlobId = file.blobId;
    const nowIso = new Date(this.nowFn()).toISOString();
    const cls = classifyTextContent(file.path, params.bytes);

    file.blobId = newBlobId;
    file.sizeBytes = params.bytes.byteLength;
    file.contentSha256 = computeSha256Hex(params.bytes);
    file.gitBlobSha = computeGitBlobSha1(params.bytes);
    file.isText = cls.isText;
    file.updatedAt = nowIso;

    if (oldBlobId && oldBlobId !== file.baseBlobId) {
      await this.storage.deleteWorkspaceBlob(ws.workspaceId, oldBlobId).catch(() => undefined);
    }

    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);
    return { workspace: ws, file };
  }

  async renameFile(params: {
    workspaceId: string;
    ownerUid: string;
    fileId: string;
    newPath: string;
  }): Promise<{ workspace: GitHubWorkspaceRecord; file: WorkspaceFileEntry }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const file = ws.files.find((f) => f.id === params.fileId && !f.deletedInWorkspace);
    if (!file) {
      throw new WorkspaceServiceError('File not found in workspace.', 404);
    }

    const check = validateArchiveEntryPath(params.newPath);
    if (!check.valid || !check.normalizedPath || check.isDirectory) {
      throw new WorkspaceServiceError(check.reason || 'Invalid target file path.', 400);
    }
    const normalizedNewPath = check.normalizedPath;
    if (normalizedNewPath === file.path) {
      return { workspace: ws, file };
    }

    const collision = ws.files.find(
      (f) => f.path === normalizedNewPath && !f.deletedInWorkspace && f.id !== file.id,
    );
    if (collision) {
      throw new WorkspaceServiceError(
        `Cannot rename: "${normalizedNewPath}" already exists in the workspace.`,
        409,
      );
    }

    const nowIso = new Date(this.nowFn()).toISOString();
    file.path = normalizedNewPath;
    file.isActiveContent = isActiveWebContent(normalizedNewPath);
    file.updatedAt = nowIso;

    ws.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);
    return { workspace: ws, file };
  }

  async deleteWorkspaceFile(params: {
    workspaceId: string;
    ownerUid: string;
    fileId: string;
  }): Promise<GitHubWorkspaceRecord> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.ownerUid);
    const idx = ws.files.findIndex((f) => f.id === params.fileId && !f.deletedInWorkspace);
    if (idx === -1) {
      throw new WorkspaceServiceError('File not found in workspace.', 404);
    }

    const file = ws.files[idx];
    const nowIso = new Date(this.nowFn()).toISOString();
    if (file.basePath) {
      file.deletedInWorkspace = true;
      file.updatedAt = nowIso;
    } else {
      if (file.blobId) {
        await this.storage.deleteWorkspaceBlob(ws.workspaceId, file.blobId).catch(() => undefined);
      }
      ws.files.splice(idx, 1);
    }

    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);
    return ws;
  }

  async checkPullUpdates(params: {
    connection: GitHubConnectionRecord;
    workspaceId: string;
  }): Promise<PullCheckResult> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.connection.uid);
    const token = await this.getValidAccessToken(params.connection);

    const head = await this.githubClient.getBranchHead(token, ws.repoOwner, ws.repoName, ws.branch);
    if (
      head.commitSha === ws.baseCommitSha &&
      ws.conflicts.length === 0 &&
      ws.pendingUpstreamDeletions.length === 0
    ) {
      return {
        upToDate: true,
        baseCommitSha: ws.baseCommitSha,
        latestCommitSha: head.commitSha,
        safeUpdates: [],
        upstreamDeletions: [],
        conflicts: [],
        appliedAutomatically: false,
        workspace: ws,
      };
    }

    const remoteTree = await this.githubClient.getTreeRecursive(
      token,
      ws.repoOwner,
      ws.repoName,
      head.treeSha,
      this.config.maxEntryCount,
    );

    const plan = computeThreeWayPullPlan({
      baseFiles: ws.baseFiles,
      workspaceFiles: ws.files,
      remoteFiles: remoteTree,
    });

    const nowIso = new Date(this.nowFn()).toISOString();

    if (plan.alreadyInSync) {
      ws.baseCommitSha = head.commitSha;
      ws.baseTreeSha = head.treeSha;
      ws.lastSyncedAt = nowIso;
      ws.updatedAt = nowIso;
      ws.pendingPullCommitSha = null;
      ws.pendingPullTreeSha = null;
      ws.pendingUpdates = [];
      ws.pendingUpstreamDeletions = [];
      ws.conflicts = [];
      ws.status = this.recomputeStatus(ws);
      await this.storage.saveWorkspace(ws);
      return {
        upToDate: true,
        baseCommitSha: ws.baseCommitSha,
        latestCommitSha: head.commitSha,
        safeUpdates: [],
        upstreamDeletions: [],
        conflicts: [],
        appliedAutomatically: false,
        workspace: ws,
      };
    }

    if (plan.conflicts.length === 0 && plan.upstreamDeletions.length === 0) {
      const downloadedUpdates = await runWithConcurrency(plan.safeUpdates, 6, async (upd) => {
        const bytes = await this.githubClient.getBlobRaw(
          token,
          ws.repoOwner,
          ws.repoName,
          upd.remoteGitBlobSha,
        );
        return { upd, bytes };
      });

      const verifyHead = await this.githubClient.getBranchHead(
        token,
        ws.repoOwner,
        ws.repoName,
        ws.branch,
      );
      if (verifyHead.commitSha !== head.commitSha) {
        throw new GitHubRemoteMovedError(
          `Remote branch "${ws.branch}" moved while pulling (${verifyHead.commitSha.slice(0, 7)}). Pull again to review the latest state.`,
          verifyHead.commitSha,
        );
      }

      for (const { upd, bytes } of downloadedUpdates) {
        await this.applyRemoteFileToBothBaseAndWorkspace(ws, upd.path, upd.mode, bytes, nowIso);
      }

      ws.baseCommitSha = head.commitSha;
      ws.baseTreeSha = head.treeSha;
      ws.lastSyncedAt = nowIso;
      ws.updatedAt = nowIso;
      ws.pendingPullCommitSha = null;
      ws.pendingPullTreeSha = null;
      ws.pendingUpdates = [];
      ws.pendingUpstreamDeletions = [];
      ws.conflicts = [];
      ws.status = this.recomputeStatus(ws);
      await this.storage.saveWorkspace(ws);

      return {
        upToDate: false,
        baseCommitSha: ws.baseCommitSha,
        latestCommitSha: head.commitSha,
        safeUpdates: plan.safeUpdates,
        upstreamDeletions: [],
        conflicts: [],
        appliedAutomatically: true,
        workspace: ws,
      };
    }

    for (const conflict of plan.conflicts) {
      if (conflict.remoteGitBlobSha) {
        try {
          const remoteBytes = await this.githubClient.getBlobRaw(
            token,
            ws.repoOwner,
            ws.repoName,
            conflict.remoteGitBlobSha,
          );
          const remoteCls = classifyTextContent(conflict.path, remoteBytes);
          conflict.remoteSha256 = computeSha256Hex(remoteBytes);
          conflict.remoteSizeBytes = remoteBytes.byteLength;
          conflict.remoteIsText = remoteCls.isText;
          if (!remoteCls.isText) {
            conflict.isBinary = true;
          }
        } catch {
          // Leave existing classification
        }
      }
    }

    ws.pendingPullCommitSha = head.commitSha;
    ws.pendingPullTreeSha = head.treeSha;
    ws.pendingUpdates = plan.safeUpdates;
    ws.pendingUpstreamDeletions = plan.upstreamDeletions;
    ws.conflicts = plan.conflicts;
    ws.updatedAt = nowIso;
    ws.status = this.recomputeStatus(ws);
    await this.storage.saveWorkspace(ws);

    return {
      upToDate: false,
      baseCommitSha: ws.baseCommitSha,
      latestCommitSha: head.commitSha,
      safeUpdates: plan.safeUpdates,
      upstreamDeletions: plan.upstreamDeletions,
      conflicts: plan.conflicts,
      appliedAutomatically: false,
      workspace: ws,
    };
  }

  private async applyRemoteFileToBothBaseAndWorkspace(
    ws: GitHubWorkspaceRecord,
    filePath: string,
    mode: string,
    bytes: Buffer,
    nowIso: string,
  ): Promise<void> {
    const newBlobId = crypto.randomUUID();
    await this.storage.saveWorkspaceBlob(ws.workspaceId, newBlobId, bytes);

    const contentSha256 = computeSha256Hex(bytes);
    const gitBlobSha = computeGitBlobSha1(bytes);
    const cls = classifyTextContent(filePath, bytes);
    const isActiveContent = isActiveWebContent(filePath);

    const baseIdx = ws.baseFiles.findIndex((b) => b.path === filePath);
    if (baseIdx >= 0) {
      ws.baseFiles[baseIdx] = {
        path: filePath,
        sizeBytes: bytes.byteLength,
        contentSha256,
        gitBlobSha,
        mode,
        isText: cls.isText,
        blobId: newBlobId,
      };
    } else {
      ws.baseFiles.push({
        path: filePath,
        sizeBytes: bytes.byteLength,
        contentSha256,
        gitBlobSha,
        mode,
        isText: cls.isText,
        blobId: newBlobId,
      });
    }

    const wsIdx = ws.files.findIndex((f) => f.path === filePath || f.basePath === filePath);
    if (wsIdx >= 0) {
      const old = ws.files[wsIdx];
      if (old.blobId && old.blobId !== newBlobId) {
        await this.storage.deleteWorkspaceBlob(ws.workspaceId, old.blobId).catch(() => undefined);
      }
      ws.files[wsIdx] = {
        ...old,
        path: filePath,
        basePath: filePath,
        sizeBytes: bytes.byteLength,
        contentSha256,
        baseSha256: contentSha256,
        gitBlobSha,
        baseGitBlobSha: gitBlobSha,
        mode,
        isText: cls.isText,
        isActiveContent,
        blobId: newBlobId,
        baseBlobId: newBlobId,
        deletedInWorkspace: false,
        updatedAt: nowIso,
      };
    } else {
      ws.files.push({
        id: crypto.randomUUID(),
        path: filePath,
        basePath: filePath,
        sizeBytes: bytes.byteLength,
        contentSha256,
        baseSha256: contentSha256,
        gitBlobSha,
        baseGitBlobSha: gitBlobSha,
        mode,
        isText: cls.isText,
        isActiveContent,
        blobId: newBlobId,
        baseBlobId: newBlobId,
        deletedInWorkspace: false,
        updatedAt: nowIso,
      });
    }
  }

  async getConflictPreview(params: {
    connection: GitHubConnectionRecord;
    workspaceId: string;
    conflictPath: string;
  }): Promise<{
    path: string;
    kind: WorkspaceConflict['kind'];
    isBinary: boolean;
    workspaceText: string | null;
    remoteText: string | null;
    baseText: string | null;
  }> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.connection.uid);
    const conflict = ws.conflicts.find((c) => c.path === params.conflictPath);
    if (!conflict) {
      throw new WorkspaceServiceError('Conflict entry not found.', 404);
    }

    const token = await this.getValidAccessToken(params.connection);
    const wsFile = ws.files.find((f) => f.path === conflict.path && !f.deletedInWorkspace);
    const baseFile = ws.baseFiles.find((b) => b.path === conflict.path);

    let workspaceText: string | null = null;
    let baseText: string | null = null;
    let remoteText: string | null = null;

    if (!conflict.isBinary) {
      if (wsFile && wsFile.isText && wsFile.sizeBytes <= this.config.maxTextPreviewBytes) {
        const buf = await this.storage.getWorkspaceBlob(ws.workspaceId, wsFile.blobId);
        workspaceText = buf ? buf.toString('utf8') : null;
      }
      if (baseFile && baseFile.isText && baseFile.sizeBytes <= this.config.maxTextPreviewBytes) {
        const buf = await this.storage.getWorkspaceBlob(ws.workspaceId, baseFile.blobId);
        baseText = buf ? buf.toString('utf8') : null;
      }
      if (conflict.remoteGitBlobSha) {
        const remoteBuf = await this.githubClient.getBlobRaw(
          token,
          ws.repoOwner,
          ws.repoName,
          conflict.remoteGitBlobSha,
        );
        const cls = classifyTextContent(conflict.path, remoteBuf);
        if (cls.isText && remoteBuf.byteLength <= this.config.maxTextPreviewBytes) {
          remoteText = remoteBuf.toString('utf8');
        }
      }
    }

    return {
      path: conflict.path,
      kind: conflict.kind,
      isBinary: conflict.isBinary,
      workspaceText,
      remoteText,
      baseText,
    };
  }

  async applyPullResolutions(params: {
    connection: GitHubConnectionRecord;
    workspaceId: string;
    conflictResolutions: Record<string, 'keep_workspace' | 'use_github'>;
    confirmedDeletionPaths: string[];
  }): Promise<GitHubWorkspaceRecord> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.connection.uid);
    if (!ws.pendingPullCommitSha || !ws.pendingPullTreeSha) {
      throw new WorkspaceServiceError('No pending GitHub pull updates to apply.', 400);
    }

    const confirmedSet = new Set(params.confirmedDeletionPaths);
    for (const del of ws.pendingUpstreamDeletions) {
      if (!confirmedSet.has(del.path)) {
        throw new WorkspaceServiceError(
          `Upstream deletion confirmation required for "${del.path}".`,
          400,
        );
      }
    }

    for (const conflict of ws.conflicts) {
      const choice = params.conflictResolutions[conflict.path];
      if (choice !== 'keep_workspace' && choice !== 'use_github') {
        throw new WorkspaceServiceError(
          `Please choose Keep workspace or Use GitHub for conflict "${conflict.path}".`,
          400,
        );
      }
    }

    const token = await this.getValidAccessToken(params.connection);
    const currentHead = await this.githubClient.getBranchHead(
      token,
      ws.repoOwner,
      ws.repoName,
      ws.branch,
    );
    if (currentHead.commitSha !== ws.pendingPullCommitSha) {
      throw new GitHubRemoteMovedError(
        `Remote branch "${ws.branch}" moved to ${currentHead.commitSha.slice(0, 7)} while reviewing updates. Refresh pull updates before applying.`,
        currentHead.commitSha,
      );
    }

    const nowIso = new Date(this.nowFn()).toISOString();

    const downloadedSafe = await runWithConcurrency(ws.pendingUpdates, 6, async (upd) => {
      const bytes = await this.githubClient.getBlobRaw(
        token,
        ws.repoOwner,
        ws.repoName,
        upd.remoteGitBlobSha,
      );
      return { upd, bytes };
    });

    for (const { upd, bytes } of downloadedSafe) {
      await this.applyRemoteFileToBothBaseAndWorkspace(ws, upd.path, upd.mode, bytes, nowIso);
    }

    for (const del of ws.pendingUpstreamDeletions) {
      ws.baseFiles = ws.baseFiles.filter((b) => b.path !== del.path);
      ws.files = ws.files.filter((f) => f.path !== del.path && f.basePath !== del.path);
    }

    for (const conflict of ws.conflicts) {
      const choice = params.conflictResolutions[conflict.path];
      if (choice === 'use_github') {
        if (!conflict.remoteGitBlobSha) {
          ws.baseFiles = ws.baseFiles.filter((b) => b.path !== conflict.path);
          ws.files = ws.files.filter((f) => f.path !== conflict.path && f.basePath !== conflict.path);
        } else {
          const remoteBytes = await this.githubClient.getBlobRaw(
            token,
            ws.repoOwner,
            ws.repoName,
            conflict.remoteGitBlobSha,
          );
          await this.applyRemoteFileToBothBaseAndWorkspace(
            ws,
            conflict.path,
            conflict.remoteMode || '100644',
            remoteBytes,
            nowIso,
          );
        }
      } else if (choice === 'keep_workspace') {
        if (!conflict.remoteGitBlobSha) {
          ws.baseFiles = ws.baseFiles.filter((b) => b.path !== conflict.path);
          const wsFile = ws.files.find((f) => f.path === conflict.path);
          if (wsFile) {
            wsFile.basePath = null;
            wsFile.baseSha256 = null;
            wsFile.baseGitBlobSha = null;
            wsFile.baseBlobId = null;
          }
        } else {
          const remoteBytes = await this.githubClient.getBlobRaw(
            token,
            ws.repoOwner,
            ws.repoName,
            conflict.remoteGitBlobSha,
          );
          const remoteBlobId = crypto.randomUUID();
          await this.storage.saveWorkspaceBlob(ws.workspaceId, remoteBlobId, remoteBytes);

          const remoteSha256 = computeSha256Hex(remoteBytes);
          const remoteGitSha = computeGitBlobSha1(remoteBytes);
          const remoteCls = classifyTextContent(conflict.path, remoteBytes);

          const baseIdx = ws.baseFiles.findIndex((b) => b.path === conflict.path);
          const newBase: WorkspaceBaseFile = {
            path: conflict.path,
            sizeBytes: remoteBytes.byteLength,
            contentSha256: remoteSha256,
            gitBlobSha: remoteGitSha,
            mode: conflict.remoteMode || '100644',
            isText: remoteCls.isText,
            blobId: remoteBlobId,
          };
          if (baseIdx >= 0) {
            ws.baseFiles[baseIdx] = newBase;
          } else {
            ws.baseFiles.push(newBase);
          }

          const wsFile = ws.files.find((f) => f.path === conflict.path);
          if (wsFile) {
            wsFile.basePath = conflict.path;
            wsFile.baseSha256 = remoteSha256;
            wsFile.baseGitBlobSha = remoteGitSha;
            wsFile.baseBlobId = remoteBlobId;
          } else {
            ws.files.push({
              id: crypto.randomUUID(),
              path: conflict.path,
              basePath: conflict.path,
              sizeBytes: remoteBytes.byteLength,
              contentSha256: remoteSha256,
              baseSha256: remoteSha256,
              gitBlobSha: remoteGitSha,
              baseGitBlobSha: remoteGitSha,
              mode: conflict.remoteMode || '100644',
              isText: remoteCls.isText,
              isActiveContent: isActiveWebContent(conflict.path),
              blobId: remoteBlobId,
              baseBlobId: remoteBlobId,
              deletedInWorkspace: true,
              updatedAt: nowIso,
            });
          }
        }
      }
    }

    ws.baseFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    ws.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));

    ws.baseCommitSha = ws.pendingPullCommitSha;
    ws.baseTreeSha = ws.pendingPullTreeSha;
    ws.lastSyncedAt = nowIso;
    ws.updatedAt = nowIso;
    ws.pendingPullCommitSha = null;
    ws.pendingPullTreeSha = null;
    ws.pendingUpdates = [];
    ws.pendingUpstreamDeletions = [];
    ws.conflicts = [];
    ws.status = this.recomputeStatus(ws);

    await this.storage.saveWorkspace(ws);
    return ws;
  }

  async getWorkspaceDiff(params: {
    connection: GitHubConnectionRecord;
    workspaceId: string;
  }): Promise<WorkspaceDiffSummary> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.connection.uid);
    const token = await this.getValidAccessToken(params.connection);
    const head = await this.githubClient.getBranchHead(token, ws.repoOwner, ws.repoName, ws.branch);

    const blobTexts = new Map<string, string>();
    const neededBlobIds = new Set<string>();
    for (const wf of ws.files) {
      if (!wf.deletedInWorkspace && wf.isText && wf.sizeBytes <= this.config.maxTextPreviewBytes) {
        neededBlobIds.add(wf.blobId);
      }
    }
    for (const bf of ws.baseFiles) {
      if (bf.isText && bf.sizeBytes <= this.config.maxTextPreviewBytes) {
        neededBlobIds.add(bf.blobId);
      }
    }

    await runWithConcurrency([...neededBlobIds], 8, async (blobId) => {
      const buf = await this.storage.getWorkspaceBlob(ws.workspaceId, blobId);
      if (buf) {
        blobTexts.set(blobId, buf.toString('utf8'));
      }
    });

    const items = computeWorkspaceDiffItems({
      baseFiles: ws.baseFiles,
      workspaceFiles: ws.files,
      readTextPair: (baseBlobId, currentBlobId) => ({
        baseText: baseBlobId ? (blobTexts.get(baseBlobId) ?? null) : null,
        currentText: blobTexts.get(currentBlobId) ?? null,
      }),
    });

    return {
      baseCommitSha: ws.baseCommitSha,
      remoteCommitSha: head.commitSha,
      remoteMoved: head.commitSha !== ws.baseCommitSha,
      hasChanges: items.length > 0,
      items,
    };
  }

  async pushWorkspaceToGitHub(params: {
    connection: GitHubConnectionRecord;
    workspaceId: string;
    newBranchName: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    createPullRequest?: boolean;
  }): Promise<PushToGitHubResult> {
    const ws = await this.getOwnedWorkspace(params.workspaceId, params.connection.uid);

    if (ws.conflicts.some((c) => c.resolution === 'unresolved')) {
      throw new WorkspaceServiceError(
        'Resolve all pull conflicts before pushing changes to GitHub.',
        409,
      );
    }
    if (ws.pendingUpstreamDeletions.some((d) => !d.confirmed)) {
      throw new WorkspaceServiceError(
        'Confirm pending upstream file deletions before pushing changes to GitHub.',
        409,
      );
    }

    const cleanBranchName = validateNewBranchName(params.newBranchName, [
      ws.branch,
      ws.defaultBranch,
    ]);
    const token = await this.getValidAccessToken(params.connection);
    const authRepo = await this.assertAuthorizedRepo(token, ws.repoOwner, ws.repoName);

    const currentHead = await this.githubClient.getBranchHead(
      token,
      ws.repoOwner,
      ws.repoName,
      ws.branch,
    );
    if (currentHead.commitSha !== ws.baseCommitSha) {
      throw new GitHubRemoteMovedError(
        `Remote branch "${ws.branch}" moved to ${currentHead.commitSha.slice(0, 7)} since your last pull. Run "Pull latest" and review changes before pushing.`,
        currentHead.commitSha,
      );
    }

    const diffItems = computeWorkspaceDiffItems({
      baseFiles: ws.baseFiles,
      workspaceFiles: ws.files,
    });
    if (diffItems.length === 0) {
      throw new WorkspaceServiceError('There are no workspace changes to push.', 400);
    }

    const changeMap = new Map<string, GitCommitTreeChange>();
    const activeByPath = new Map(
      ws.files.filter((f) => !f.deletedInWorkspace).map((f) => [f.path, f]),
    );

    for (const item of diffItems) {
      if (item.status === 'deleted') {
        changeMap.set(item.path, { path: item.path, delete: true });
      } else if (item.status === 'renamed' && item.previousPath) {
        changeMap.set(item.previousPath, { path: item.previousPath, delete: true });
      }
    }

    for (const item of diffItems) {
      if (item.status === 'added' || item.status === 'modified' || item.status === 'renamed') {
        const wf = activeByPath.get(item.path);
        if (!wf) continue;
        const bytes = await this.storage.getWorkspaceBlob(ws.workspaceId, wf.blobId);
        if (!bytes) {
          throw new WorkspaceServiceError(`Missing stored blob for "${wf.path}".`, 500);
        }
        changeMap.set(wf.path, {
          path: wf.path,
          mode: wf.mode || '100644',
          contentBytes: bytes,
        });
      }
    }

    const commitMessage =
      params.commitMessage.trim() || `Update ${diffItems.length} file(s) from ZipLink workspace`;
    const prTitle = params.prTitle.trim() || commitMessage;
    const prBody =
      params.prBody.trim() ||
      `Changes edited in a private ZipLink workspace targeting \`${ws.branch}\` (${diffItems.length} file(s)).`;

    return this.githubClient.pushChangesToNewBranchAndPr({
      accessToken: token,
      owner: ws.repoOwner,
      repo: ws.repoName,
      baseBranch: ws.branch,
      expectedBaseCommitSha: ws.baseCommitSha,
      baseTreeSha: ws.baseTreeSha,
      newBranchName: cleanBranchName,
      commitMessage,
      prTitle,
      prBody,
      changes: [...changeMap.values()],
      createPullRequest: params.createPullRequest !== false,
      repoPermissions: authRepo.permissions,
    });
  }

  async mergePullRequest(params: {
    connection: GitHubConnectionRecord;
    owner: string;
    repo: string;
    pullNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    confirmed: boolean;
  }): Promise<MergePullRequestResult> {
    if (!params.confirmed) {
      throw new WorkspaceServiceError(
        'Explicit confirmation is required before merging a Pull Request.',
        400,
      );
    }
    if (!Number.isInteger(params.pullNumber) || params.pullNumber <= 0) {
      throw new WorkspaceServiceError('Invalid Pull Request number.', 400);
    }

    const token = await this.getValidAccessToken(params.connection);
    await this.assertAuthorizedRepo(token, params.owner, params.repo);

    return this.githubClient.mergePullRequest({
      accessToken: token,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      mergeMethod: params.mergeMethod,
      commitTitle: params.commitTitle,
    });
  }

  // --------------------------------------------------------------------------
  // ZIP-to-GitHub Staging, Repository Matching & Push
  // --------------------------------------------------------------------------

  async stageZipForGitHub(params: {
    connection: GitHubConnectionRecord;
    zipFilePath: string;
    archiveName: string;
    extractTempDir: string;
  }): Promise<ZipStageRecord> {
    const token = await this.getValidAccessToken(params.connection);
    const extracted = await safelyExtractZipToTempDir({
      zipFilePath: params.zipFilePath,
      extractTempDir: params.extractTempDir,
      limits: {
        maxExtractedBytes: this.config.maxExtractedBytes,
        maxEntryCount: this.config.maxEntryCount,
        maxTextPreviewBytes: this.config.maxTextPreviewBytes,
      },
    });

    const stagedFiles: StagedZipFile[] = [];
    let claimedRemoteUrlHint: string | null = null;

    for (const item of extracted.files) {
      const blobPath = extracted.extractedBlobPaths.get(item.file.id);
      if (!blobPath) continue;
      const bytes = await fsp.readFile(blobPath);
      const gitBlobSha = computeGitBlobSha1(bytes);

      if (
        !claimedRemoteUrlHint &&
        item.textContent &&
        item.file.relativePath.toLowerCase() === 'package.json'
      ) {
        try {
          const pkg = JSON.parse(item.textContent) as { repository?: string | { url?: string } };
          if (typeof pkg.repository === 'string') {
            claimedRemoteUrlHint = pkg.repository;
          } else if (pkg.repository && typeof pkg.repository.url === 'string') {
            claimedRemoteUrlHint = pkg.repository.url;
          }
        } catch {
          // Ignore malformed package.json
        }
      }

      stagedFiles.push({
        id: item.file.id,
        relativePath: item.file.relativePath,
        sizeBytes: item.file.sizeBytes,
        contentSha256: item.file.sha256,
        gitBlobSha,
        isText: item.file.isText,
        isActiveContent: item.file.isActiveContent,
      });
    }

    const { repos } = await this.githubClient.listAuthorizedRepos(token);
    const candidateRepos = repos.slice(0, 10);

    const candidates: RepoCandidateInput[] = [];
    await runWithConcurrency(candidateRepos, 4, async (repo) => {
      try {
        const head = await this.githubClient.getBranchHead(
          token,
          repo.owner,
          repo.name,
          repo.defaultBranch,
        );
        const remoteTree = await this.githubClient.getTreeRecursive(
          token,
          repo.owner,
          repo.name,
          head.treeSha,
          this.config.maxEntryCount,
        );
        candidates.push({ repo, remoteTree });
      } catch {
        // Ignore empty or unreachable repo branch during suggestion scan
      }
    });

    const ranked = rankRepositorySuggestions({
      archiveName: params.archiveName,
      stagedFiles,
      candidates,
      claimedRemoteUrlHint,
    });

    const nowMs = this.nowFn();
    const stage: ZipStageRecord = {
      stageId: crypto.randomBytes(18).toString('base64url'),
      ownerUid: params.connection.uid,
      ownerGithubId: params.connection.user.id,
      archiveName: params.archiveName,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 2 * 60 * 60 * 1000,
      totalFiles: stagedFiles.length,
      totalExtractedBytes: extracted.totalExtractedBytes,
      sensitiveWarnings: detectSensitiveFilenames(stagedFiles.map((f) => f.relativePath)),
      files: stagedFiles,
      suggestions: ranked.suggestions,
      isAmbiguous: ranked.isAmbiguous,
      requiresManualSelection: ranked.requiresManualSelection,
      suggestionSummary: ranked.summaryReason,
    };

    await this.storage.saveZipStage({
      stage,
      blobTempPaths: extracted.extractedBlobPaths,
    });

    return stage;
  }

  async getOwnedActiveStage(stageId: string, ownerUid: string): Promise<ZipStageRecord> {
    const stage = await this.storage.getZipStage(stageId);
    if (!stage || stage.ownerUid !== ownerUid) {
      throw new WorkspaceServiceError('Staged ZIP upload not found.', 404);
    }
    if (stage.expiresAtMs <= this.nowFn()) {
      await this.storage.deleteZipStage(stageId).catch(() => undefined);
      throw new WorkspaceServiceError(
        'Staged ZIP upload expired. Please re-upload the ZIP archive.',
        410,
      );
    }
    return stage;
  }

  async planZipToGitHub(params: {
    connection: GitHubConnectionRecord;
    stageId: string;
    owner: string;
    repo: string;
    branch: string;
    targetFolder: string;
    mode: 'add_update' | 'mirror';
  }): Promise<{ plan: ZipToGitHubPlan; stage: ZipStageRecord; repoSummary: GitHubRepoSummary }> {
    const stage = await this.getOwnedActiveStage(params.stageId, params.connection.uid);
    const folderCheck = normalizeTargetFolder(params.targetFolder);
    if (!folderCheck.valid) {
      throw new WorkspaceServiceError(folderCheck.reason || 'Invalid target folder.', 400);
    }

    const token = await this.getValidAccessToken(params.connection);
    const authRepo = await this.assertAuthorizedRepo(token, params.owner, params.repo);
    const targetBranch = params.branch.trim() || authRepo.defaultBranch;

    const head = await this.githubClient.getBranchHead(
      token,
      authRepo.owner,
      authRepo.name,
      targetBranch,
    );
    const remoteTree = await this.githubClient.getTreeRecursive(
      token,
      authRepo.owner,
      authRepo.name,
      head.treeSha,
      this.config.maxEntryCount,
    );

    const plan = computeZipToGitHubPlan({
      stageId: stage.stageId,
      repoFullName: authRepo.fullName,
      targetBranch,
      targetFolder: folderCheck.prefix,
      mode: params.mode,
      baseCommitSha: head.commitSha,
      baseTreeSha: head.treeSha,
      stagedFiles: stage.files,
      remoteTreeFiles: remoteTree,
    });

    return { plan, stage, repoSummary: authRepo };
  }

  async pushZipStageToGitHub(params: {
    connection: GitHubConnectionRecord;
    stageId: string;
    owner: string;
    repo: string;
    branch: string;
    targetFolder: string;
    mode: 'add_update' | 'mirror';
    expectedBaseCommitSha: string;
    newBranchName: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    confirmedMirrorDeletions: boolean;
    createPullRequest?: boolean;
  }): Promise<PushToGitHubResult> {
    if (params.mode === 'mirror' && !params.confirmedMirrorDeletions) {
      throw new WorkspaceServiceError(
        'Mirror mode deletes files missing from the ZIP. Explicit deletion confirmation is required.',
        400,
      );
    }

    const { plan, stage, repoSummary } = await this.planZipToGitHub({
      connection: params.connection,
      stageId: params.stageId,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      targetFolder: params.targetFolder,
      mode: params.mode,
    });

    if (params.expectedBaseCommitSha && plan.baseCommitSha !== params.expectedBaseCommitSha) {
      throw new GitHubRemoteMovedError(
        `Remote branch "${plan.targetBranch}" moved to ${plan.baseCommitSha.slice(0, 7)}. Review the refreshed diff before pushing.`,
        plan.baseCommitSha,
      );
    }

    const cleanBranch = validateNewBranchName(params.newBranchName, [
      plan.targetBranch,
      repoSummary.defaultBranch,
    ]);

    if (params.mode === 'mirror' && plan.deletions.length > 0 && !params.confirmedMirrorDeletions) {
      throw new WorkspaceServiceError(
        'Confirm the listed mirror deletions before pushing to GitHub.',
        400,
      );
    }

    const stagedByPath = new Map(stage.files.map((f) => [f.relativePath, f]));
    const changes: GitCommitTreeChange[] = [];

    if (params.mode === 'mirror') {
      for (const del of plan.deletions) {
        changes.push({ path: del.targetPath, delete: true });
      }
    }

    for (const item of [...plan.additions, ...plan.collisions]) {
      const sf = stagedByPath.get(item.stagedPath);
      if (!sf) continue;
      const bytes = await this.storage.getZipStageBlob(stage.stageId, sf.id);
      if (!bytes) {
        throw new WorkspaceServiceError(`Missing staged file blob for "${sf.relativePath}".`, 500);
      }
      changes.push({
        path: item.targetPath,
        mode: '100644',
        contentBytes: bytes,
      });
    }

    if (changes.length === 0) {
      throw new WorkspaceServiceError(
        'No file differences detected between the ZIP archive and the selected branch.',
        400,
      );
    }

    const token = await this.getValidAccessToken(params.connection);
    const commitMessage =
      params.commitMessage.trim() || `Import ${stage.archiveName} via ZipLink`;
    const prTitle = params.prTitle.trim() || commitMessage;
    const prBody =
      params.prBody.trim() ||
      `Imported files from \`${stage.archiveName}\` (${plan.additions.length} added, ${plan.collisions.length} updated, ${plan.deletions.length} deleted).`;

    const result = await this.githubClient.pushChangesToNewBranchAndPr({
      accessToken: token,
      owner: repoSummary.owner,
      repo: repoSummary.name,
      baseBranch: plan.targetBranch,
      expectedBaseCommitSha: plan.baseCommitSha,
      baseTreeSha: plan.baseTreeSha,
      newBranchName: cleanBranch,
      commitMessage,
      prTitle,
      prBody,
      changes,
      createPullRequest: params.createPullRequest !== false,
      repoPermissions: repoSummary.permissions,
    });

    await this.storage.deleteZipStage(stage.stageId).catch(() => undefined);
    return result;
  }
}
