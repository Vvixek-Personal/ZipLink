import type { GitHubRepoSummary, RepoSuggestion, StagedZipFile } from './types.ts';
import type { RemoteTreeEntry } from './gitSync.ts';

const COMMON_GENERIC_FILENAMES = new Set([
  'readme.md',
  'readme',
  'readme.txt',
  'license',
  'license.md',
  'license.txt',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.env.example',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'index.html',
  'index.ts',
  'index.js',
  'main.ts',
  'main.py',
  'app.tsx',
  'app.ts',
  'dockerfile',
  'makefile',
]);

export interface RepoCandidateInput {
  repo: GitHubRepoSummary;
  remoteTree: RemoteTreeEntry[];
}

export interface RankedSuggestionResult {
  suggestions: RepoSuggestion[];
  isAmbiguous: boolean;
  requiresManualSelection: boolean;
  summaryReason: string;
}

function getBasenameLower(filePath: string): string {
  return (filePath.split('/').pop() ?? '').toLowerCase();
}

function getTopDirectories(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const idx = p.indexOf('/');
    if (idx > 0) {
      dirs.add(p.slice(0, idx).toLowerCase());
    }
  }
  return dirs;
}

function extractArchiveBaseHint(archiveName: string): string {
  return archiveName
    .replace(/\.zip$/i, '')
    .replace(/-(main|master|dev|v?\d+(\.\d+)*)$/i, '')
    .toLowerCase();
}

export function scoreRepositoryMatch(params: {
  archiveName: string;
  stagedFiles: StagedZipFile[];
  candidate: RepoCandidateInput;
  claimedRemoteUrlHint?: string | null;
}): RepoSuggestion {
  const { archiveName, stagedFiles, candidate, claimedRemoteUrlHint } = params;
  const { repo, remoteTree } = candidate;

  const remoteByPath = new Map(remoteTree.map((r) => [r.path, r]));
  const remoteBlobShas = new Set(remoteTree.map((r) => r.sha));
  const remotePathsLower = new Set(remoteTree.map((r) => r.path.toLowerCase()));

  let exactHashMatchCount = 0;
  let nonEmptyExactHashCount = 0;
  let pathMatchCount = 0;
  let distinctivePathMatchCount = 0;
  let commonOnlyPathMatchCount = 0;

  // Empty git blob SHA-1: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
  const EMPTY_GIT_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

  for (const sf of stagedFiles) {
    const remoteAtSamePath = remoteByPath.get(sf.relativePath);
    const isCommon = COMMON_GENERIC_FILENAMES.has(getBasenameLower(sf.relativePath));

    if (remoteAtSamePath) {
      pathMatchCount++;
      if (isCommon) {
        commonOnlyPathMatchCount++;
      } else {
        distinctivePathMatchCount++;
      }
      if (remoteAtSamePath.sha === sf.gitBlobSha) {
        exactHashMatchCount++;
        if (sf.gitBlobSha !== EMPTY_GIT_SHA) {
          nonEmptyExactHashCount++;
        }
      }
    } else if (sf.gitBlobSha !== EMPTY_GIT_SHA && remoteBlobShas.has(sf.gitBlobSha)) {
      exactHashMatchCount++;
      nonEmptyExactHashCount++;
    } else if (remotePathsLower.has(sf.relativePath.toLowerCase())) {
      pathMatchCount++;
      if (!isCommon) {
        distinctivePathMatchCount++;
      } else {
        commonOnlyPathMatchCount++;
      }
    }
  }

  // Directory structure overlap
  const stagedDirs = getTopDirectories(stagedFiles.map((f) => f.relativePath));
  const remoteDirs = getTopDirectories(remoteTree.map((f) => f.path));
  let sharedTopDirs = 0;
  for (const d of stagedDirs) {
    if (remoteDirs.has(d)) sharedTopDirs++;
  }

  // Weak hints (explicitly never treated as proof)
  const archiveBase = extractArchiveBaseHint(archiveName);
  const nameHintMatch =
    archiveBase.length >= 3 &&
    (repo.name.toLowerCase() === archiveBase || repo.fullName.toLowerCase().endsWith(`/${archiveBase}`));

  const remoteHintMatch = Boolean(
    claimedRemoteUrlHint &&
      claimedRemoteUrlHint.toLowerCase().includes(repo.fullName.toLowerCase()),
  );

  // Weighted explainable score
  let score = 0;
  score += nonEmptyExactHashCount * 22;
  score += distinctivePathMatchCount * 10;
  score += commonOnlyPathMatchCount * 2;
  score += sharedTopDirs * 4;
  if (nameHintMatch) score += 4; // Weak hint only
  if (remoteHintMatch) score += 5; // Weak hint only

  const totalStaged = Math.max(1, stagedFiles.length);
  const matchRatio = (nonEmptyExactHashCount + distinctivePathMatchCount) / totalStaged;

  const reasons: string[] = [];
  if (nonEmptyExactHashCount > 0) {
    reasons.push(
      `${nonEmptyExactHashCount} file${nonEmptyExactHashCount === 1 ? '' : 's'} match exact Git blob content hashes`,
    );
  }
  if (distinctivePathMatchCount > 0) {
    reasons.push(
      `${distinctivePathMatchCount} distinctive relative file path${distinctivePathMatchCount === 1 ? '' : 's'} match`,
    );
  }
  if (commonOnlyPathMatchCount > 0 && distinctivePathMatchCount === 0 && nonEmptyExactHashCount === 0) {
    reasons.push(
      `Only common filenames matched (${commonOnlyPathMatchCount} file${commonOnlyPathMatchCount === 1 ? '' : 's'}) — not sufficient proof`,
    );
  } else if (commonOnlyPathMatchCount > 0) {
    reasons.push(`${commonOnlyPathMatchCount} common project filename(s) match`);
  }
  if (sharedTopDirs > 0) {
    reasons.push(`${sharedTopDirs} top-level directory name${sharedTopDirs === 1 ? '' : 's'} align`);
  }
  if (nameHintMatch) {
    reasons.push('Archive filename resembles repository name (weak hint only)');
  }
  if (remoteHintMatch) {
    reasons.push('ZIP metadata references this repository URL (hint only)');
  }

  // Confidence discipline: common filenames or name hints alone NEVER produce high confidence!
  let confidence: 'high' | 'medium' | 'low' = 'low';
  const hasStrongContentOrDistinctivePaths =
    nonEmptyExactHashCount >= 2 ||
    (nonEmptyExactHashCount >= 1 && distinctivePathMatchCount >= 1) ||
    (distinctivePathMatchCount >= 3 && matchRatio >= 0.4);

  if (hasStrongContentOrDistinctivePaths && score >= 35) {
    confidence = 'high';
  } else if (nonEmptyExactHashCount >= 1 || distinctivePathMatchCount >= 2 || score >= 20) {
    confidence = 'medium';
  }

  return {
    repoId: repo.id,
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    htmlUrl: repo.htmlUrl,
    private: repo.private,
    confidence,
    score,
    reasons,
    exactHashMatchCount,
    pathMatchCount,
    matchedFileCount: Math.max(exactHashMatchCount, pathMatchCount),
  };
}

export function rankRepositorySuggestions(params: {
  archiveName: string;
  stagedFiles: StagedZipFile[];
  candidates: RepoCandidateInput[];
  claimedRemoteUrlHint?: string | null;
}): RankedSuggestionResult {
  const { archiveName, stagedFiles, candidates, claimedRemoteUrlHint } = params;

  const scored = candidates
    .map((candidate) =>
      scoreRepositoryMatch({ archiveName, stagedFiles, candidate, claimedRemoteUrlHint }),
    )
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName, 'en'));

  if (scored.length === 0) {
    return {
      suggestions: [],
      isAmbiguous: false,
      requiresManualSelection: true,
      summaryReason:
        'No matching repository signals found among your authorized repositories. Select a destination manually.',
    };
  }

  const top = scored[0];
  const runnerUp = scored[1] ?? null;

  // Detect ambiguity: close runner-up score OR only common-filename/hint matches
  const closeRunnerUp = Boolean(
    runnerUp &&
      runnerUp.score >= 12 &&
      (top.score - runnerUp.score <= 15 || runnerUp.score >= top.score * 0.75),
  );

  const isAmbiguous = closeRunnerUp || (top.confidence === 'low' && scored.length > 1);
  const effectiveTopConfidence = isAmbiguous && top.confidence === 'high' ? 'medium' : top.confidence;

  const adjusted = scored.map((s, idx) =>
    idx === 0 && effectiveTopConfidence !== s.confidence
      ? { ...s, confidence: effectiveTopConfidence }
      : s,
  );

  if (isAmbiguous) {
    return {
      suggestions: adjusted.slice(0, 6),
      isAmbiguous: true,
      requiresManualSelection: true,
      summaryReason:
        'Multiple authorized repositories have similar matching signals. Review the reasons below and select a destination manually.',
    };
  }

  if (adjusted[0].confidence === 'low') {
    return {
      suggestions: adjusted.slice(0, 6),
      isAmbiguous: false,
      requiresManualSelection: true,
      summaryReason:
        'Only weak or common-filename signals matched. Choose the target repository manually before proceeding.',
    };
  }

  return {
    suggestions: adjusted.slice(0, 6),
    isAmbiguous: false,
    requiresManualSelection: false,
    summaryReason: `Top suggestion "${adjusted[0].fullName}" has ${adjusted[0].confidence} confidence. Confirm or override the destination before reviewing diffs.`,
  };
}
