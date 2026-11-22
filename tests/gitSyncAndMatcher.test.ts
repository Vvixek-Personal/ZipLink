import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeLineDiff,
  computeThreeWayPullPlan,
  computeWorkspaceDiffItems,
  computeZipToGitHubPlan,
  normalizeTargetFolder,
} from '../src/shared/gitSync.ts';
import { rankRepositorySuggestions } from '../src/shared/repoMatcher.ts';
import type {
  GitHubRepoSummary,
  StagedZipFile,
  WorkspaceBaseFile,
  WorkspaceFileEntry,
} from '../src/shared/types.ts';

function makeBase(path: string, sha: string, isText = true, sizeBytes = 20): WorkspaceBaseFile {
  return {
    path,
    sizeBytes,
    contentSha256: `sha256-${sha}`,
    gitBlobSha: sha,
    mode: '100644',
    isText,
    blobId: `base-${sha}`,
  };
}

function makeWs(
  path: string,
  sha: string,
  basePath: string | null,
  baseSha: string | null,
  opts: { isText?: boolean; deleted?: boolean; sizeBytes?: number } = {},
): WorkspaceFileEntry {
  return {
    id: `id-${path}`,
    path,
    basePath,
    sizeBytes: opts.sizeBytes ?? 20,
    contentSha256: `sha256-${sha}`,
    baseSha256: baseSha ? `sha256-${baseSha}` : null,
    gitBlobSha: sha,
    baseGitBlobSha: baseSha,
    mode: '100644',
    isText: opts.isText ?? true,
    isActiveContent: false,
    blobId: `ws-${sha}`,
    baseBlobId: baseSha ? `base-${baseSha}` : null,
    deletedInWorkspace: opts.deleted ?? false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('computeThreeWayPullPlan: applies safe upstream updates without clobbering local edits on other files', () => {
  const plan = computeThreeWayPullPlan({
    baseFiles: [makeBase('a.txt', 'sha-a1'), makeBase('b.txt', 'sha-b1')],
    workspaceFiles: [
      makeWs('a.txt', 'sha-a-local', 'a.txt', 'sha-a1'),
      makeWs('b.txt', 'sha-b1', 'b.txt', 'sha-b1'),
    ],
    remoteFiles: [
      { path: 'a.txt', sha: 'sha-a1', sizeBytes: 20, mode: '100644' },
      { path: 'b.txt', sha: 'sha-b2', sizeBytes: 24, mode: '100644' },
      { path: 'c.txt', sha: 'sha-c1', sizeBytes: 12, mode: '100644' },
    ],
  });

  assert.equal(plan.alreadyInSync, false);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.upstreamDeletions.length, 0);
  assert.deepEqual(
    plan.safeUpdates.map((u) => [u.path, u.kind]),
    [
      ['b.txt', 'modified'],
      ['c.txt', 'added'],
    ],
  );
});

test('computeThreeWayPullPlan: detects simultaneous text and binary conflicts without auto-merging', () => {
  const plan = computeThreeWayPullPlan({
    baseFiles: [
      makeBase('readme.md', 'sha-r1', true),
      makeBase('logo.png', 'sha-p1', false),
      makeBase('removed.txt', 'sha-rem1', true),
    ],
    workspaceFiles: [
      makeWs('readme.md', 'sha-r-ws', 'readme.md', 'sha-r1', { isText: true }),
      makeWs('logo.png', 'sha-p-ws', 'logo.png', 'sha-p1', { isText: false }),
      makeWs('removed.txt', 'sha-rem1', 'removed.txt', 'sha-rem1', { isText: true }),
    ],
    remoteFiles: [
      { path: 'readme.md', sha: 'sha-r-gh', sizeBytes: 30, mode: '100644', isText: true },
      { path: 'logo.png', sha: 'sha-p-gh', sizeBytes: 90, mode: '100644', isText: false },
    ],
  });

  assert.equal(plan.conflicts.length, 2);
  const logoConflict = plan.conflicts.find((c) => c.path === 'logo.png');
  assert.ok(logoConflict);
  assert.equal(logoConflict.isBinary, true);
  assert.equal(logoConflict.kind, 'both_modified');
  assert.equal(logoConflict.resolution, 'unresolved');

  assert.equal(plan.upstreamDeletions.length, 1);
  assert.equal(plan.upstreamDeletions[0].path, 'removed.txt');
  assert.equal(plan.upstreamDeletions[0].confirmed, false);
});

test('computeWorkspaceDiffItems & computeLineDiff: tracks added, modified, renamed, and deleted files accurately', () => {
  const texts = new Map<string, string>([
    ['base-sha-b1', 'line1\nline2\n'],
    ['ws-sha-b2', 'line1\nline2 updated\nline3\n'],
    ['ws-sha-new', 'hello world\n'],
  ]);

  const diff = computeWorkspaceDiffItems({
    baseFiles: [
      makeBase('keep.txt', 'sha-k'),
      makeBase('mod.txt', 'sha-b1'),
      makeBase('old-name.txt', 'sha-ren'),
      makeBase('gone.txt', 'sha-gone'),
    ],
    workspaceFiles: [
      makeWs('keep.txt', 'sha-k', 'keep.txt', 'sha-k'),
      makeWs('mod.txt', 'sha-b2', 'mod.txt', 'sha-b1'),
      makeWs('new-name.txt', 'sha-ren', 'old-name.txt', 'sha-ren'),
      makeWs('gone.txt', 'sha-gone', 'gone.txt', 'sha-gone', { deleted: true }),
      makeWs('added.txt', 'sha-new', null, null),
    ],
    readTextPair: (baseBlobId, curBlobId) => ({
      baseText: baseBlobId ? (texts.get(baseBlobId) ?? null) : null,
      currentText: texts.get(curBlobId) ?? null,
    }),
  });

  const byStatus = new Map(diff.map((d) => [d.path, d]));
  assert.equal(byStatus.get('added.txt')?.status, 'added');
  assert.equal(byStatus.get('mod.txt')?.status, 'modified');
  assert.match(byStatus.get('mod.txt')?.patch ?? '', /\+ line2 updated/);
  assert.equal(byStatus.get('new-name.txt')?.status, 'renamed');
  assert.equal(byStatus.get('new-name.txt')?.previousPath, 'old-name.txt');
  assert.equal(byStatus.get('gone.txt')?.status, 'deleted');
  assert.equal(computeLineDiff('a\nb', 'a\nb'), '');
});

test('computeZipToGitHubPlan: default add_update preserves existing absent files; mirror lists deletions', () => {
  assert.equal(normalizeTargetFolder('/apps/web/').prefix, 'apps/web');
  assert.equal(normalizeTargetFolder('../bad').valid, false);

  const stagedFiles: StagedZipFile[] = [
    {
      id: '1',
      relativePath: 'src/app.ts',
      sizeBytes: 50,
      contentSha256: 'c1',
      gitBlobSha: 'blob-app-new',
      isText: true,
      isActiveContent: false,
    },
    {
      id: '2',
      relativePath: 'src/same.ts',
      sizeBytes: 20,
      contentSha256: 'c2',
      gitBlobSha: 'blob-same',
      isText: true,
      isActiveContent: false,
    },
    {
      id: '3',
      relativePath: 'src/brand-new.ts',
      sizeBytes: 30,
      contentSha256: 'c3',
      gitBlobSha: 'blob-brand-new',
      isText: true,
      isActiveContent: false,
    },
  ];

  const remoteTreeFiles = [
    { path: 'src/app.ts', sha: 'blob-app-old', sizeBytes: 40, mode: '100644' },
    { path: 'src/same.ts', sha: 'blob-same', sizeBytes: 20, mode: '100644' },
    { path: 'docs/legacy.md', sha: 'blob-legacy', sizeBytes: 15, mode: '100644' },
  ];

  const addUpdatePlan = computeZipToGitHubPlan({
    stageId: 'stage-1',
    repoFullName: 'alice/project',
    targetBranch: 'main',
    targetFolder: '',
    mode: 'add_update',
    baseCommitSha: 'commit-1',
    baseTreeSha: 'tree-1',
    stagedFiles,
    remoteTreeFiles,
  });

  assert.equal(addUpdatePlan.additions.length, 1);
  assert.equal(addUpdatePlan.collisions.length, 1);
  assert.equal(addUpdatePlan.unchanged.length, 1);
  assert.equal(addUpdatePlan.deletions.length, 0);

  const mirrorPlan = computeZipToGitHubPlan({
    stageId: 'stage-1',
    repoFullName: 'alice/project',
    targetBranch: 'main',
    targetFolder: '',
    mode: 'mirror',
    baseCommitSha: 'commit-1',
    baseTreeSha: 'tree-1',
    stagedFiles,
    remoteTreeFiles,
  });

  assert.deepEqual(
    mirrorPlan.deletions.map((d) => d.targetPath),
    ['docs/legacy.md'],
  );
});

test('rankRepositorySuggestions: distinguishes strong hash matches from ambiguous or common-filename-only matches', () => {
  const makeRepo = (id: number, name: string): GitHubRepoSummary => ({
    id,
    name,
    fullName: `alice/${name}`,
    owner: 'alice',
    private: true,
    defaultBranch: 'main',
    htmlUrl: `https://github.com/alice/${name}`,
    description: null,
    pushedAt: '2026-01-01T00:00:00Z',
  });

  const stagedStrong: StagedZipFile[] = [
    {
      id: '1',
      relativePath: 'src/invoiceEngine.ts',
      sizeBytes: 120,
      contentSha256: 'x1',
      gitBlobSha: 'sha-invoice',
      isText: true,
      isActiveContent: false,
    },
    {
      id: '2',
      relativePath: 'src/taxCalculator.ts',
      sizeBytes: 90,
      contentSha256: 'x2',
      gitBlobSha: 'sha-tax',
      isText: true,
      isActiveContent: false,
    },
  ];

  const strongResult = rankRepositorySuggestions({
    archiveName: 'random-export.zip',
    stagedFiles: stagedStrong,
    candidates: [
      {
        repo: makeRepo(1, 'billing-core'),
        remoteTree: [
          { path: 'src/invoiceEngine.ts', sha: 'sha-invoice', sizeBytes: 120, mode: '100644' },
          { path: 'src/taxCalculator.ts', sha: 'sha-tax', sizeBytes: 90, mode: '100644' },
        ],
      },
      {
        repo: makeRepo(2, 'random-export'), // Name matches archive only!
        remoteTree: [{ path: 'README.md', sha: 'sha-other', sizeBytes: 10, mode: '100644' }],
      },
    ],
  });

  assert.equal(strongResult.suggestions[0].fullName, 'alice/billing-core');
  assert.equal(strongResult.suggestions[0].confidence, 'high');
  assert.equal(strongResult.requiresManualSelection, false);
  assert.match(strongResult.suggestions[0].reasons.join(' '), /exact Git blob content hashes/);

  // Common filenames only must never produce high confidence or auto-selection
  const commonOnlyResult = rankRepositorySuggestions({
    archiveName: 'my-app.zip',
    stagedFiles: [
      {
        id: '1',
        relativePath: 'README.md',
        sizeBytes: 10,
        contentSha256: 'c1',
        gitBlobSha: 'unique-new-readme',
        isText: true,
        isActiveContent: false,
      },
      {
        id: '2',
        relativePath: 'package.json',
        sizeBytes: 10,
        contentSha256: 'c2',
        gitBlobSha: 'unique-new-pkg',
        isText: true,
        isActiveContent: false,
      },
    ],
    candidates: [
      {
        repo: makeRepo(10, 'repo-one'),
        remoteTree: [
          { path: 'README.md', sha: 'old-1', sizeBytes: 10, mode: '100644' },
          { path: 'package.json', sha: 'old-2', sizeBytes: 10, mode: '100644' },
        ],
      },
      {
        repo: makeRepo(11, 'repo-two'),
        remoteTree: [
          { path: 'README.md', sha: 'old-3', sizeBytes: 10, mode: '100644' },
          { path: 'package.json', sha: 'old-4', sizeBytes: 10, mode: '100644' },
        ],
      },
    ],
  });

  assert.equal(commonOnlyResult.isAmbiguous, true);
  assert.equal(commonOnlyResult.requiresManualSelection, true);
  assert.notEqual(commonOnlyResult.suggestions[0].confidence, 'high');
});
