export type ExpiryOption = '24h' | '7d' | '30d';

export interface ShareFileEntry {
  id: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  isText: boolean;
  isActiveContent: boolean;
  includedInContextMd: boolean;
  omissionReason: string | null;
}

export interface SensitiveFileWarning {
  relativePath: string;
  reason: string;
}

export interface ShareRecord {
  shareId: string;
  archiveName: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  expiryOption: ExpiryOption;
  totalFiles: number;
  totalExtractedBytes: number;
  contextIncludedCount: number;
  contextOmittedCount: number;
  sensitiveWarnings: SensitiveFileWarning[];
  files: ShareFileEntry[];
  deleteTokenHash: string;
}

export type PublicShareMetadata = Omit<ShareRecord, 'deleteTokenHash'>;

export interface UploadSuccessPayload {
  shareId: string;
  shareUrl: string;
  contextUrl: string;
  manifestUrl: string;
  deleteUrl: string;
  deleteToken: string;
  expiresAt: string;
  expiryOption: ExpiryOption;
  archiveName: string;
  totalFiles: number;
  totalExtractedBytes: number;
  contextIncludedCount: number;
  contextOmittedCount: number;
  sensitiveWarnings: SensitiveFileWarning[];
  contextMd: string;
}

export interface AppLimitsInfo {
  maxCompressedBytes: number;
  maxExtractedBytes: number;
  maxEntryCount: number;
  maxContextMdBytes: number;
  maxTextPreviewBytes: number;
  storageDriver: 'local' | 'gcs';
}

// ============================================================================
// ZipLink User Accounts (Firebase Auth) & Per-User Data Isolation
// ============================================================================

export interface ZipLinkAuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface AuthStatusResponse {
  firebaseConfigured: boolean;
  authenticated: boolean;
  user: ZipLinkAuthUser | null;
}

// ============================================================================
// GitHub Integration, Workspace & ZIP-to-GitHub Types
// ============================================================================

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubConfigStatus {
  configured: boolean;
  missingVars: string[];
  appSlug: string | null;
  installUrl: string | null;
  callbackUrls: {
    development: string;
    current: string;
  };
  connected: boolean;
  user: GitHubUser | null;
}

export interface GitHubRepoPermissions {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  pull: boolean;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  pushedAt: string | null;
  permissions?: GitHubRepoPermissions;
}

export interface GitHubBranchSummary {
  name: string;
  commitSha: string;
  protected: boolean;
}

export interface GitHubConnectionRecord {
  uid: string;
  user: GitHubUser;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PendingOAuthStateRecord {
  nonce: string;
  uid: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface WorkspaceBaseFile {
  path: string;
  sizeBytes: number;
  contentSha256: string;
  gitBlobSha: string;
  mode: string;
  isText: boolean;
  blobId: string;
}

export interface WorkspaceFileEntry {
  id: string;
  path: string;
  basePath: string | null;
  sizeBytes: number;
  contentSha256: string;
  baseSha256: string | null;
  gitBlobSha: string;
  baseGitBlobSha: string | null;
  mode: string;
  isText: boolean;
  isActiveContent: boolean;
  blobId: string;
  baseBlobId: string | null;
  deletedInWorkspace: boolean;
  updatedAt: string;
}

export type WorkspaceStatus = 'clean' | 'modified' | 'conflicts' | 'pending_deletions';

export type ConflictKind = 'both_modified' | 'modified_vs_deleted' | 'deleted_vs_modified';

export type ConflictResolutionChoice = 'unresolved' | 'keep_workspace' | 'use_github';

export interface WorkspaceConflict {
  path: string;
  kind: ConflictKind;
  isBinary: boolean;
  workspaceSha256: string | null;
  remoteSha256: string | null;
  baseSha256: string | null;
  remoteGitBlobSha: string | null;
  remoteSizeBytes: number | null;
  remoteMode: string | null;
  remoteIsText: boolean;
  resolution: ConflictResolutionChoice;
}

export interface PendingUpstreamDeletion {
  path: string;
  sizeBytes: number;
  baseSha256: string;
  confirmed: boolean;
}

export interface PendingUpstreamUpdate {
  path: string;
  kind: 'added' | 'modified';
  sizeBytes: number;
  remoteGitBlobSha: string;
  mode: string;
}

export interface GitHubWorkspaceRecord {
  workspaceId: string;
  ownerUid: string;
  ownerGithubId: number;
  ownerLogin: string;
  repoId: number;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  repoHtmlUrl: string;
  defaultBranch: string;
  branch: string;
  baseCommitSha: string;
  baseTreeSha: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
  status: WorkspaceStatus;
  files: WorkspaceFileEntry[];
  baseFiles: WorkspaceBaseFile[];
  pendingPullCommitSha: string | null;
  pendingPullTreeSha: string | null;
  pendingUpdates: PendingUpstreamUpdate[];
  pendingUpstreamDeletions: PendingUpstreamDeletion[];
  conflicts: WorkspaceConflict[];
}

export interface WorkspaceSummary {
  workspaceId: string;
  repoFullName: string;
  defaultBranch: string;
  branch: string;
  baseCommitSha: string;
  lastSyncedAt: string;
  updatedAt: string;
  status: WorkspaceStatus;
  fileCount: number;
  dirtyCount: number;
  conflictCount: number;
}

export interface WorkspaceDiffItem {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'renamed' | 'deleted';
  isBinary: boolean;
  sizeBytes: number;
  patch: string | null;
}

export interface WorkspaceDiffSummary {
  baseCommitSha: string;
  remoteCommitSha: string;
  remoteMoved: boolean;
  hasChanges: boolean;
  items: WorkspaceDiffItem[];
}

export interface PullCheckResult {
  upToDate: boolean;
  baseCommitSha: string;
  latestCommitSha: string;
  safeUpdates: PendingUpstreamUpdate[];
  upstreamDeletions: PendingUpstreamDeletion[];
  conflicts: WorkspaceConflict[];
  appliedAutomatically: boolean;
  workspace: GitHubWorkspaceRecord;
}

export interface PushToGitHubResult {
  pushed: boolean;
  branch: string;
  baseBranch: string;
  commitSha: string;
  commitUrl: string;
  branchUrl: string;
  compareUrl: string;
  pullRequest: {
    number: number;
    url: string;
    title: string;
  } | null;
  canMergePullRequest?: boolean;
  repoOwner?: string;
  repoName?: string;
  prWarning: string | null;
  workspace?: GitHubWorkspaceRecord;
}

export interface MergePullRequestResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface StagedZipFile {
  id: string;
  relativePath: string;
  sizeBytes: number;
  contentSha256: string;
  gitBlobSha: string;
  isText: boolean;
  isActiveContent: boolean;
}

export interface RepoSuggestion {
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
  private: boolean;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  reasons: string[];
  exactHashMatchCount: number;
  pathMatchCount: number;
  matchedFileCount: number;
}

export interface ZipStageRecord {
  stageId: string;
  ownerUid: string;
  ownerGithubId: number;
  archiveName: string;
  createdAtMs: number;
  expiresAtMs: number;
  totalFiles: number;
  totalExtractedBytes: number;
  sensitiveWarnings: SensitiveFileWarning[];
  files: StagedZipFile[];
  suggestions: RepoSuggestion[];
  isAmbiguous: boolean;
  requiresManualSelection: boolean;
  suggestionSummary: string;
}

export interface ZipToGitHubPlan {
  stageId: string;
  repoFullName: string;
  targetBranch: string;
  targetFolder: string;
  mode: 'add_update' | 'mirror';
  baseCommitSha: string;
  baseTreeSha: string;
  additions: Array<{ stagedPath: string; targetPath: string; sizeBytes: number; isText: boolean }>;
  collisions: Array<{
    stagedPath: string;
    targetPath: string;
    sizeBytes: number;
    existingSizeBytes: number;
    isText: boolean;
  }>;
  unchanged: Array<{ stagedPath: string; targetPath: string; sizeBytes: number }>;
  deletions: Array<{ targetPath: string; sizeBytes: number }>;
}
