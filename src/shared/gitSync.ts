import type {
  PendingUpstreamDeletion,
  PendingUpstreamUpdate,
  StagedZipFile,
  WorkspaceBaseFile,
  WorkspaceConflict,
  WorkspaceDiffItem,
  WorkspaceFileEntry,
  ZipToGitHubPlan,
} from './types.ts';
import { validateArchiveEntryPath } from './zipSecurity.ts';

export interface RemoteTreeEntry {
  path: string;
  sha: string; // Git blob SHA-1
  sizeBytes: number;
  mode: string;
  isText?: boolean;
  contentSha256?: string;
}

export interface ThreeWayPullPlan {
  alreadyInSync: boolean;
  safeUpdates: PendingUpstreamUpdate[];
  upstreamDeletions: PendingUpstreamDeletion[];
  conflicts: WorkspaceConflict[];
}

export function computeLineDiff(baseText: string, nextText: string, maxLines = 180): string {
  if (baseText === nextText) return '';
  const a = baseText.split('\n');
  const b = nextText.split('\n');

  // Guard against quadratic memory on huge files
  if (a.length * b.length > 120000) {
    return `@@ -1,${a.length} +1,${b.length} @@\n(File too large for inline line diff; ${a.length} lines -> ${b.length} lines)`;
  }

  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: '-', line: a[i++] });
  }
  while (j < n) {
    ops.push({ kind: '+', line: b[j++] });
  }

  const lines: string[] = [`@@ -1,${m} +1,${n} @@`];
  let shown = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const nearChange =
      op.kind !== ' ' ||
      ops.slice(Math.max(0, k - 2), Math.min(ops.length, k + 3)).some((x) => x.kind !== ' ');
    if (!nearChange) continue;
    lines.push(`${op.kind} ${op.line}`);
    shown++;
    if (shown >= maxLines) {
      lines.push('... (diff truncated)');
      break;
    }
  }
  return lines.join('\n');
}

export function computeThreeWayPullPlan(params: {
  baseFiles: WorkspaceBaseFile[];
  workspaceFiles: WorkspaceFileEntry[];
  remoteFiles: RemoteTreeEntry[];
}): ThreeWayPullPlan {
  const { baseFiles, workspaceFiles, remoteFiles } = params;

  const baseByPath = new Map(baseFiles.map((f) => [f.path, f]));
  const remoteByPath = new Map(remoteFiles.map((f) => [f.path, f]));

  // Map workspace entries by their effective path AND track any renames from basePath
  const workspaceByCurrentPath = new Map<string, WorkspaceFileEntry>();
  const workspaceByBasePath = new Map<string, WorkspaceFileEntry>();
  for (const wf of workspaceFiles) {
    workspaceByCurrentPath.set(wf.path, wf);
    if (wf.basePath) {
      workspaceByBasePath.set(wf.basePath, wf);
    }
  }

  const allPaths = new Set<string>([
    ...baseByPath.keys(),
    ...remoteByPath.keys(),
    ...workspaceFiles.map((w) => w.path),
  ]);

  const safeUpdates: PendingUpstreamUpdate[] = [];
  const upstreamDeletions: PendingUpstreamDeletion[] = [];
  const conflicts: WorkspaceConflict[] = [];

  for (const p of [...allPaths].sort((a, b) => a.localeCompare(b, 'en'))) {
    const base = baseByPath.get(p) ?? null;
    const remote = remoteByPath.get(p) ?? null;
    const wsAtPath = workspaceByCurrentPath.get(p) ?? null;
    const wsRenamedFromHere = workspaceByBasePath.get(p);

    // Case 1: File existed at base path `p`
    if (base) {
      const remoteChanged = Boolean(remote && remote.sha !== base.gitBlobSha);
      const remoteDeleted = !remote;

      // Did workspace rename/move this file away from `p`?
      const movedElsewhere = Boolean(
        wsRenamedFromHere && wsRenamedFromHere.path !== p && !wsRenamedFromHere.deletedInWorkspace,
      );
      const wsDeleted = Boolean(wsAtPath?.deletedInWorkspace) || (!wsAtPath && !movedElsewhere);
      const wsModifiedAtSamePath = Boolean(
        wsAtPath &&
          !wsAtPath.deletedInWorkspace &&
          wsAtPath.basePath === p &&
          wsAtPath.gitBlobSha !== base.gitBlobSha,
      );
      const wsTouched = movedElsewhere || wsDeleted || wsModifiedAtSamePath;

      if (!remoteChanged && !remoteDeleted) {
        // Remote unchanged since base -> keep workspace edits safely
        continue;
      }

      if (remoteDeleted) {
        if (!wsTouched) {
          upstreamDeletions.push({
            path: p,
            sizeBytes: base.sizeBytes,
            baseSha256: base.contentSha256,
            confirmed: false,
          });
        } else if (!wsDeleted) {
          // Remote deleted, workspace modified/moved -> conflict!
          const activeWs = movedElsewhere ? wsRenamedFromHere! : wsAtPath!;
          conflicts.push({
            path: activeWs.path,
            kind: 'modified_vs_deleted',
            isBinary: !base.isText || !activeWs.isText,
            workspaceSha256: activeWs.contentSha256,
            remoteSha256: null,
            baseSha256: base.contentSha256,
            remoteGitBlobSha: null,
            remoteSizeBytes: null,
            remoteMode: null,
            remoteIsText: base.isText,
            resolution: 'unresolved',
          });
        }
        continue;
      }

      // Remote modified
      if (remote && remoteChanged) {
        if (!wsTouched) {
          safeUpdates.push({
            path: p,
            kind: 'modified',
            sizeBytes: remote.sizeBytes,
            remoteGitBlobSha: remote.sha,
            mode: remote.mode,
          });
        } else if (wsAtPath && !wsAtPath.deletedInWorkspace && wsAtPath.gitBlobSha === remote.sha) {
          // Both made the exact same byte-for-byte edit -> safe
          continue;
        } else {
          const activeWs = movedElsewhere ? wsRenamedFromHere! : wsAtPath;
          const kind = wsDeleted ? 'deleted_vs_modified' : 'both_modified';
          conflicts.push({
            path: p,
            kind,
            isBinary: !base.isText || (activeWs ? !activeWs.isText : false) || remote.isText === false,
            workspaceSha256: activeWs && !activeWs.deletedInWorkspace ? activeWs.contentSha256 : null,
            remoteSha256: remote.contentSha256 ?? null,
            baseSha256: base.contentSha256,
            remoteGitBlobSha: remote.sha,
            remoteSizeBytes: remote.sizeBytes,
            remoteMode: remote.mode,
            remoteIsText: remote.isText ?? base.isText,
            resolution: 'unresolved',
          });
        }
      }
      continue;
    }

    // Case 2: File did NOT exist at `p` in base (added remotely and/or added locally)
    if (remote) {
      if (!wsAtPath || wsAtPath.deletedInWorkspace) {
        safeUpdates.push({
          path: p,
          kind: 'added',
          sizeBytes: remote.sizeBytes,
          remoteGitBlobSha: remote.sha,
          mode: remote.mode,
        });
      } else if (wsAtPath.gitBlobSha !== remote.sha) {
        conflicts.push({
          path: p,
          kind: 'both_modified',
          isBinary: !wsAtPath.isText || remote.isText === false,
          workspaceSha256: wsAtPath.contentSha256,
          remoteSha256: remote.contentSha256 ?? null,
          baseSha256: null,
          remoteGitBlobSha: remote.sha,
          remoteSizeBytes: remote.sizeBytes,
          remoteMode: remote.mode,
          remoteIsText: remote.isText ?? wsAtPath.isText,
          resolution: 'unresolved',
        });
      }
    }
  }

  return {
    alreadyInSync:
      safeUpdates.length === 0 && upstreamDeletions.length === 0 && conflicts.length === 0,
    safeUpdates,
    upstreamDeletions,
    conflicts,
  };
}

export function computeWorkspaceDiffItems(params: {
  baseFiles: WorkspaceBaseFile[];
  workspaceFiles: WorkspaceFileEntry[];
  readTextPair?: (baseBlobId: string | null, currentBlobId: string) => {
    baseText: string | null;
    currentText: string | null;
  };
}): WorkspaceDiffItem[] {
  const { baseFiles, workspaceFiles, readTextPair } = params;
  const baseByPath = new Map(baseFiles.map((f) => [f.path, f]));
  const items: WorkspaceDiffItem[] = [];
  const accountedBasePaths = new Set<string>();

  for (const wf of [...workspaceFiles].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    if (wf.deletedInWorkspace) {
      if (wf.basePath && baseByPath.has(wf.basePath)) {
        accountedBasePaths.add(wf.basePath);
        const base = baseByPath.get(wf.basePath)!;
        items.push({
          path: wf.basePath,
          previousPath: null,
          status: 'deleted',
          isBinary: !base.isText,
          sizeBytes: base.sizeBytes,
          patch: null,
        });
      }
      continue;
    }

    if (!wf.basePath) {
      let patch: string | null = null;
      if (wf.isText && readTextPair) {
        const pair = readTextPair(null, wf.blobId);
        if (pair.currentText !== null) {
          patch = computeLineDiff('', pair.currentText);
        }
      }
      items.push({
        path: wf.path,
        previousPath: null,
        status: 'added',
        isBinary: !wf.isText,
        sizeBytes: wf.sizeBytes,
        patch,
      });
      continue;
    }

    accountedBasePaths.add(wf.basePath);
    const base = baseByPath.get(wf.basePath);
    if (!base) continue;

    const renamed = wf.path !== wf.basePath;
    const contentChanged = wf.gitBlobSha !== base.gitBlobSha || wf.contentSha256 !== base.contentSha256;

    if (!renamed && !contentChanged) continue;

    let patch: string | null = null;
    if (contentChanged && wf.isText && base.isText && readTextPair) {
      const pair = readTextPair(base.blobId, wf.blobId);
      if (pair.baseText !== null && pair.currentText !== null) {
        patch = computeLineDiff(pair.baseText, pair.currentText);
      }
    }

    items.push({
      path: wf.path,
      previousPath: renamed ? wf.basePath : null,
      status: renamed ? 'renamed' : 'modified',
      isBinary: !wf.isText || !base.isText,
      sizeBytes: wf.sizeBytes,
      patch,
    });
  }

  for (const base of baseFiles) {
    if (!accountedBasePaths.has(base.path)) {
      items.push({
        path: base.path,
        previousPath: null,
        status: 'deleted',
        isBinary: !base.isText,
        sizeBytes: base.sizeBytes,
        patch: null,
      });
    }
  }

  return items.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function normalizeTargetFolder(rawFolder: string): { valid: boolean; prefix: string; reason?: string } {
  const trimmed = rawFolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return { valid: true, prefix: '' };
  }
  const check = validateArchiveEntryPath(`${trimmed}/placeholder.txt`);
  if (!check.valid) {
    return { valid: false, prefix: '', reason: check.reason || 'Invalid target folder path.' };
  }
  return { valid: true, prefix: trimmed };
}

export function computeZipToGitHubPlan(params: {
  stageId: string;
  repoFullName: string;
  targetBranch: string;
  targetFolder: string;
  mode: 'add_update' | 'mirror';
  baseCommitSha: string;
  baseTreeSha: string;
  stagedFiles: StagedZipFile[];
  remoteTreeFiles: RemoteTreeEntry[];
}): ZipToGitHubPlan {
  const {
    stageId,
    repoFullName,
    targetBranch,
    targetFolder,
    mode,
    baseCommitSha,
    baseTreeSha,
    stagedFiles,
    remoteTreeFiles,
  } = params;

  const remoteByPath = new Map(remoteTreeFiles.map((f) => [f.path, f]));
  const targetedRemotePaths = new Set<string>();

  const additions: ZipToGitHubPlan['additions'] = [];
  const collisions: ZipToGitHubPlan['collisions'] = [];
  const unchanged: ZipToGitHubPlan['unchanged'] = [];
  const deletions: ZipToGitHubPlan['deletions'] = [];

  for (const sf of [...stagedFiles].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'en'),
  )) {
    const targetPath = targetFolder ? `${targetFolder}/${sf.relativePath}` : sf.relativePath;
    targetedRemotePaths.add(targetPath);

    const existing = remoteByPath.get(targetPath);
    if (!existing) {
      additions.push({
        stagedPath: sf.relativePath,
        targetPath,
        sizeBytes: sf.sizeBytes,
        isText: sf.isText,
      });
    } else if (existing.sha === sf.gitBlobSha) {
      unchanged.push({
        stagedPath: sf.relativePath,
        targetPath,
        sizeBytes: sf.sizeBytes,
      });
    } else {
      collisions.push({
        stagedPath: sf.relativePath,
        targetPath,
        sizeBytes: sf.sizeBytes,
        existingSizeBytes: existing.sizeBytes,
        isText: sf.isText,
      });
    }
  }

  // Only list deletions when user explicitly opts into "Mirror ZIP exactly"
  if (mode === 'mirror') {
    const scopePrefix = targetFolder ? `${targetFolder}/` : '';
    for (const rf of [...remoteTreeFiles].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      if (scopePrefix && !rf.path.startsWith(scopePrefix)) {
        continue;
      }
      if (!targetedRemotePaths.has(rf.path)) {
        deletions.push({
          targetPath: rf.path,
          sizeBytes: rf.sizeBytes,
        });
      }
    }
  }

  return {
    stageId,
    repoFullName,
    targetBranch,
    targetFolder,
    mode,
    baseCommitSha,
    baseTreeSha,
    additions,
    collisions,
    unchanged,
    deletions,
  };
}
