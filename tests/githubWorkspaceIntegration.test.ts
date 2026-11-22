import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { createZipLinkApp } from '../src/server/app.ts';
import { FirebaseAuthError, type FirebaseTokenVerifier } from '../src/server/firebaseAuth.ts';
import { computeGitBlobSha1, encryptSecret } from '../src/server/gitHash.ts';
import {
  GitHubApiError,
  GitHubRemoteMovedError,
  type AuthorizedReposResult,
  type GitCommitTreeChange,
  type GitHubClient,
} from '../src/server/githubClient.ts';
import type { RemoteTreeEntry } from '../src/shared/gitSync.ts';
import type {
  GitHubBranchSummary,
  GitHubRepoPermissions,
  GitHubRepoSummary,
  GitHubUser,
  MergePullRequestResult,
  PushToGitHubResult,
  ZipLinkAuthUser,
} from '../src/shared/types.ts';

class MockFirebaseTokenVerifier implements FirebaseTokenVerifier {
  readonly projectId = 'ziplink-test-project';
  tokens = new Map<string, ZipLinkAuthUser>();

  isConfigured(): boolean {
    return true;
  }

  async verifyIdToken(idToken: string): Promise<ZipLinkAuthUser> {
    const user = this.tokens.get(idToken);
    if (!user) {
      throw new FirebaseAuthError('Invalid or expired Firebase ID token.', 401);
    }
    return user;
  }
}

interface MockRepoState {
  summary: GitHubRepoSummary;
  authorizedForToken: Set<string>;
  branches: Map<string, { commitSha: string; treeSha: string; files: Map<string, Buffer> }>;
  blobs: Map<string, Buffer>;
  nextCommitSeq: number;
  pullRequests: Array<{
    number: number;
    title: string;
    head: string;
    base: string;
    url: string;
    merged?: boolean;
  }>;
  failNextPrCreation?: boolean;
  failNextPush?: boolean;
}

class InMemoryGitHubClient implements GitHubClient {
  usersByToken = new Map<string, GitHubUser>();
  repos = new Map<string, MockRepoState>();
  aliceAccessToken = 'ghu_SECRET_ALICE_ACCESS_TOKEN_DO_NOT_LEAK';
  aliceRefreshToken = 'ghr_SECRET_ALICE_REFRESH_TOKEN';
  bobAccessToken = 'ghu_SECRET_BOB_ACCESS_TOKEN_DO_NOT_LEAK';
  bobRefreshToken = 'ghr_SECRET_BOB_REFRESH_TOKEN';

  codeToToken = new Map<string, string>();

  constructor() {
    this.usersByToken.set(this.aliceAccessToken, {
      id: 4242,
      login: 'alice-dev',
      name: 'Alice Dev',
      avatarUrl: null,
    });
    this.usersByToken.set(this.bobAccessToken, {
      id: 7777,
      login: 'bob-dev',
      name: 'Bob Dev',
      avatarUrl: null,
    });
    this.codeToToken.set('valid-code-alice', this.aliceAccessToken);
    this.codeToToken.set('valid-code-bob', this.bobAccessToken);
  }

  seedRepo(params: {
    owner: string;
    name: string;
    id: number;
    defaultBranch?: string;
    authorizedTokens?: string[];
    permissions?: GitHubRepoPermissions;
    files: Record<string, Buffer | string>;
  }): MockRepoState {
    const defaultBranch = params.defaultBranch ?? 'main';
    const fullName = `${params.owner}/${params.name}`;
    const fileMap = new Map<string, Buffer>();
    const blobs = new Map<string, Buffer>();
    for (const [p, val] of Object.entries(params.files)) {
      const buf = typeof val === 'string' ? Buffer.from(val, 'utf8') : val;
      fileMap.set(p, buf);
      blobs.set(computeGitBlobSha1(buf), buf);
    }

    const state: MockRepoState = {
      summary: {
        id: params.id,
        name: params.name,
        fullName,
        owner: params.owner,
        private: true,
        defaultBranch,
        htmlUrl: `https://github.com/${fullName}`,
        description: null,
        pushedAt: '2026-01-10T00:00:00Z',
        permissions: params.permissions ?? {
          admin: false,
          maintain: false,
          push: true,
          pull: true,
        },
      },
      authorizedForToken: new Set(params.authorizedTokens ?? [this.aliceAccessToken]),
      branches: new Map([
        [
          defaultBranch,
          {
            commitSha: `commit-1-${params.name}`,
            treeSha: `tree-1-${params.name}`,
            files: fileMap,
          },
        ],
      ]),
      blobs,
      nextCommitSeq: 2,
      pullRequests: [],
    };
    this.repos.set(fullName, state);
    return state;
  }

  advanceRemoteBranch(
    fullName: string,
    branch: string,
    mutator: (files: Map<string, Buffer>) => void,
  ): string {
    const repo = this.repos.get(fullName)!;
    const b = repo.branches.get(branch)!;
    const nextFiles = new Map(b.files);
    mutator(nextFiles);
    for (const buf of nextFiles.values()) {
      repo.blobs.set(computeGitBlobSha1(buf), buf);
    }
    const seq = repo.nextCommitSeq++;
    const commitSha = `commit-${seq}-${repo.summary.name}`;
    const treeSha = `tree-${seq}-${repo.summary.name}`;
    repo.branches.set(branch, { commitSha, treeSha, files: nextFiles });
    return commitSha;
  }

  async exchangeOAuthCode(code: string) {
    const token = this.codeToToken.get(code);
    if (!token) throw new GitHubApiError('Bad OAuth code', 401);
    return {
      accessToken: token,
      refreshToken: token === this.aliceAccessToken ? this.aliceRefreshToken : this.bobRefreshToken,
      expiresInSeconds: 28800,
    };
  }

  async refreshUserToken() {
    return {
      accessToken: this.aliceAccessToken,
      refreshToken: this.aliceRefreshToken,
      expiresInSeconds: 28800,
    };
  }

  async getAuthenticatedUser(accessToken: string): Promise<GitHubUser> {
    const user = this.usersByToken.get(accessToken);
    if (!user) throw new GitHubApiError('Unauthorized', 401);
    return user;
  }

  async listAuthorizedRepos(accessToken: string): Promise<AuthorizedReposResult> {
    if (!this.usersByToken.has(accessToken)) throw new GitHubApiError('Unauthorized', 401);
    const repos = [...this.repos.values()]
      .filter((r) => r.authorizedForToken.has(accessToken))
      .map((r) => r.summary);
    return { repos, needsAppInstallation: repos.length === 0 };
  }

  async getRepo(accessToken: string, owner: string, repo: string): Promise<GitHubRepoSummary> {
    const r = this.repos.get(`${owner}/${repo}`);
    if (!r || !r.authorizedForToken.has(accessToken)) {
      throw new GitHubApiError('Not found', 404);
    }
    return r.summary;
  }

  async listBranches(_t: string, owner: string, repo: string): Promise<GitHubBranchSummary[]> {
    const r = this.repos.get(`${owner}/${repo}`);
    if (!r) throw new GitHubApiError('Not found', 404);
    return [...r.branches.entries()].map(([name, info]) => ({
      name,
      commitSha: info.commitSha,
      protected: name === r.summary.defaultBranch,
    }));
  }

  async getBranchHead(_t: string, owner: string, repo: string, branch: string) {
    const r = this.repos.get(`${owner}/${repo}`);
    const b = r?.branches.get(branch);
    if (!b) throw new GitHubApiError(`Branch "${branch}" not found`, 404);
    return { commitSha: b.commitSha, treeSha: b.treeSha };
  }

  async getTreeRecursive(
    _t: string,
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<RemoteTreeEntry[]> {
    const r = this.repos.get(`${owner}/${repo}`)!;
    const branch = [...r.branches.values()].find((b) => b.treeSha === treeSha);
    if (!branch) throw new GitHubApiError('Tree not found', 404);
    return [...branch.files.entries()].map(([p, buf]) => ({
      path: p,
      sha: computeGitBlobSha1(buf),
      sizeBytes: buf.byteLength,
      mode: '100644',
    }));
  }

  async getBlobRaw(_t: string, owner: string, repo: string, blobSha: string): Promise<Buffer> {
    const r = this.repos.get(`${owner}/${repo}`)!;
    const buf = r.blobs.get(blobSha);
    if (!buf) throw new GitHubApiError('Blob not found', 404);
    return buf;
  }

  async pushChangesToNewBranchAndPr(params: {
    accessToken: string;
    owner: string;
    repo: string;
    baseBranch: string;
    expectedBaseCommitSha: string;
    baseTreeSha: string;
    newBranchName: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    changes: GitCommitTreeChange[];
    createPullRequest: boolean;
    repoPermissions?: GitHubRepoPermissions;
  }): Promise<PushToGitHubResult> {
    const fullName = `${params.owner}/${params.repo}`;
    const r = this.repos.get(fullName)!;
    if (r.failNextPush) {
      r.failNextPush = false;
      throw new GitHubApiError('GitHub branch push rejected by simulated server failure.', 502);
    }

    const base = r.branches.get(params.baseBranch)!;
    if (base.commitSha !== params.expectedBaseCommitSha) {
      throw new GitHubRemoteMovedError('Remote moved!', base.commitSha);
    }
    if (r.branches.has(params.newBranchName)) {
      throw new GitHubApiError(`Branch "${params.newBranchName}" already exists.`, 422);
    }

    const nextFiles = new Map(base.files);
    for (const ch of params.changes) {
      if (ch.delete) {
        nextFiles.delete(ch.path);
      } else if (ch.contentBytes) {
        nextFiles.set(ch.path, ch.contentBytes);
        r.blobs.set(computeGitBlobSha1(ch.contentBytes), ch.contentBytes);
      }
    }

    const seq = r.nextCommitSeq++;
    const commitSha = `commit-${seq}-${r.summary.name}`;
    const treeSha = `tree-${seq}-${r.summary.name}`;
    r.branches.set(params.newBranchName, { commitSha, treeSha, files: nextFiles });

    let pullRequest: PushToGitHubResult['pullRequest'] = null;
    let prWarning: string | null = null;
    let canMergePullRequest = false;
    if (params.createPullRequest) {
      if (r.failNextPrCreation) {
        r.failNextPrCreation = false;
        prWarning = 'Branch created, but Pull Request creation is disabled for this repository.';
      } else {
        const number = r.pullRequests.length + 1;
        const url = `https://github.com/${fullName}/pull/${number}`;
        pullRequest = { number, url, title: params.prTitle };
        const perms = params.repoPermissions ?? r.summary.permissions;
        canMergePullRequest = Boolean(perms?.push || perms?.maintain || perms?.admin);
        r.pullRequests.push({
          number,
          title: params.prTitle,
          head: params.newBranchName,
          base: params.baseBranch,
          url,
        });
      }
    }

    return {
      pushed: true,
      branch: params.newBranchName,
      baseBranch: params.baseBranch,
      commitSha,
      commitUrl: `https://github.com/${fullName}/commit/${commitSha}`,
      branchUrl: `https://github.com/${fullName}/tree/${params.newBranchName}`,
      compareUrl: `https://github.com/${fullName}/compare/${params.baseBranch}...${params.newBranchName}`,
      pullRequest,
      canMergePullRequest,
      repoOwner: params.owner,
      repoName: params.repo,
      prWarning,
    };
  }

  async mergePullRequest(params: {
    accessToken: string;
    owner: string;
    repo: string;
    pullNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
  }): Promise<MergePullRequestResult> {
    const fullName = `${params.owner}/${params.repo}`;
    const r = this.repos.get(fullName);
    if (!r || !r.authorizedForToken.has(params.accessToken)) {
      throw new GitHubApiError('Not found', 404);
    }
    const perms = r.summary.permissions;
    if (!perms || (!perms.push && !perms.maintain && !perms.admin)) {
      throw new GitHubApiError(
        'Your GitHub user does not have write or merge permission on this repository.',
        403,
      );
    }
    const pr = r.pullRequests.find((p) => p.number === params.pullNumber);
    if (!pr) {
      throw new GitHubApiError('Pull Request not found.', 404);
    }
    pr.merged = true;
    const headBranch = r.branches.get(pr.head);
    if (headBranch) {
      const seq = r.nextCommitSeq++;
      r.branches.set(pr.base, {
        commitSha: `commit-merge-${seq}`,
        treeSha: headBranch.treeSha,
        files: new Map(headBranch.files),
      });
    }
    return {
      merged: true,
      sha: r.branches.get(pr.base)!.commitSha,
      message: `Pull Request successfully merged (${params.mergeMethod ?? 'merge'})`,
    };
  }

  async createRepository(): Promise<GitHubRepoSummary> {
    throw new GitHubApiError('Resource not accessible by integration', 403);
  }
}

async function setupEnv() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ziplink-gh-test-'));
  const mockGh = new InMemoryGitHubClient();
  const mockVerifier = new MockFirebaseTokenVerifier();

  const aliceUser: ZipLinkAuthUser = {
    uid: 'uid-alice-1234',
    email: 'alice@example.com',
    emailVerified: true,
    name: 'Alice Dev',
    picture: null,
  };
  const bobUser: ZipLinkAuthUser = {
    uid: 'uid-bob-5678',
    email: 'bob@example.com',
    emailVerified: true,
    name: 'Bob Dev',
    picture: null,
  };
  const unverifiedUser: ZipLinkAuthUser = {
    uid: 'uid-unverified-9999',
    email: 'unverified@example.com',
    emailVerified: false,
    name: 'Unverified',
    picture: null,
  };

  mockVerifier.tokens.set('token-alice', aliceUser);
  mockVerifier.tokens.set('token-bob', bobUser);
  mockVerifier.tokens.set('token-unverified', unverifiedUser);

  const binaryPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe, 0xed]);

  mockGh.seedRepo({
    owner: 'alice-dev',
    name: 'webapp',
    id: 101,
    authorizedTokens: [mockGh.aliceAccessToken],
    permissions: { admin: false, maintain: false, push: true, pull: true },
    files: {
      'README.md': '# WebApp\nInitial readme\n',
      'src/index.ts': 'export const version = 1;\n',
      'assets/logo.png': binaryPng,
      'docs/notes.md': 'Keep or delete test.\n',
    },
  });
  mockGh.seedRepo({
    owner: 'alice-dev',
    name: 'secret-unauth',
    id: 202,
    authorizedTokens: [],
    files: { 'README.md': 'Secret' },
  });
  mockGh.seedRepo({
    owner: 'alice-dev',
    name: 'readonly-repo',
    id: 303,
    authorizedTokens: [mockGh.aliceAccessToken],
    permissions: { admin: false, maintain: false, push: false, pull: true },
    files: { 'README.md': '# ReadOnly' },
  });
  mockGh.seedRepo({
    owner: 'bob-dev',
    name: 'bob-app',
    id: 404,
    authorizedTokens: [mockGh.bobAccessToken],
    permissions: { admin: true, maintain: true, push: true, pull: true },
    files: { 'README.md': '# Bob App\nPrivate to Bob\n' },
  });

  const { app, config, storage } = await createZipLinkApp({
    config: {
      dataDir: path.join(tempRoot, 'data'),
      githubClientId: 'test-client-id',
      githubClientSecret: 'SUPER_SECRET_CLIENT_SECRET',
      githubAppSlug: 'ziplink-test-app',
    },
    githubClient: mockGh,
    firebaseVerifier: mockVerifier,
    disableRateLimit: true,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Pre-seed Alice's encrypted GitHub connection keyed strictly by Alice's Firebase UID
  await storage.saveGitHubConnection({
    uid: aliceUser.uid,
    user: mockGh.usersByToken.get(mockGh.aliceAccessToken)!,
    encryptedAccessToken: encryptSecret(mockGh.aliceAccessToken, config.sessionKey),
    encryptedRefreshToken: encryptSecret(mockGh.aliceRefreshToken, config.sessionKey),
    tokenExpiresAtMs: Date.now() + 3600_000,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });

  const aliceHeaders = {
    Authorization: 'Bearer token-alice',
    'X-ZipLink-Client': '1',
  };
  const bobHeaders = {
    Authorization: 'Bearer token-bob',
    'X-ZipLink-Client': '1',
  };

  return {
    tempRoot,
    baseUrl,
    mockGh,
    storage,
    config,
    aliceUser,
    bobUser,
    aliceHeaders,
    bobHeaders,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

test('Firebase auth enforcement, per-user workspace/stage isolation, OAuth state binding, and account data deletion', async () => {
  const ctx = await setupEnv();
  try {
    // 1. Unauthenticated & invalid bearer requests are rejected with 401
    for (const [method, endpoint] of [
      ['GET', '/api/github/status'],
      ['GET', '/api/github/oauth/url'],
      ['GET', '/api/github/repos'],
      ['GET', '/api/workspaces'],
      ['POST', '/api/workspaces'],
      ['POST', '/api/zip-to-github/stage'],
      ['DELETE', '/api/account/data'],
    ] as const) {
      const noAuth = await fetch(`${ctx.baseUrl}${endpoint}`, {
        method,
        headers: { 'X-ZipLink-Client': '1' },
      });
      assert.equal(noAuth.status, 401, `${method} ${endpoint} without token must be 401`);

      const badAuth = await fetch(`${ctx.baseUrl}${endpoint}`, {
        method,
        headers: { Authorization: 'Bearer forged-token', 'X-ZipLink-Client': '1' },
      });
      assert.equal(badAuth.status, 401, `${method} ${endpoint} with bad token must be 401`);
    }

    // 2. Unverified Google email is rejected with 403
    const unverifiedRes = await fetch(`${ctx.baseUrl}/api/workspaces`, {
      headers: { Authorization: 'Bearer token-unverified' },
    });
    assert.equal(unverifiedRes.status, 403);

    // 3. Google sign-in alone does NOT grant GitHub access (Bob is signed in, no GitHub connection yet)
    const bobStatusRes = await fetch(`${ctx.baseUrl}/api/github/status`, {
      headers: ctx.bobHeaders,
    });
    assert.equal(bobStatusRes.status, 200);
    const bobStatus = (await bobStatusRes.json()) as { connected: boolean; user: unknown };
    assert.equal(bobStatus.connected, false);
    assert.equal(bobStatus.user, null);

    const bobReposBeforeConnect = await fetch(`${ctx.baseUrl}/api/github/repos`, {
      headers: ctx.bobHeaders,
    });
    assert.equal(bobReposBeforeConnect.status, 403);

    // 4. Alice creates a private workspace AND a staged ZIP AND a separate public share
    const aliceWsRes = await fetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'alice-dev', repo: 'webapp', branch: 'main' }),
    });
    assert.equal(aliceWsRes.status, 201);
    const { workspace: aliceWs } = (await aliceWsRes.json()) as {
      workspace: { workspaceId: string; files: Array<{ id: string; path: string }> };
    };
    const aliceReadme = aliceWs.files.find((f) => f.path === 'README.md')!;

    const stageForm = new FormData();
    stageForm.append(
      'archive',
      new Blob([Buffer.from(zipSync({ 'README.md': Buffer.from('# Test', 'utf8') }))]),
      'alice.zip',
    );
    const aliceStageRes = await fetch(`${ctx.baseUrl}/api/zip-to-github/stage`, {
      method: 'POST',
      headers: ctx.aliceHeaders,
      body: stageForm,
    });
    assert.equal(aliceStageRes.status, 201);
    const { stage: aliceStage } = (await aliceStageRes.json()) as {
      stage: { stageId: string };
    };

    const publicZipForm = new FormData();
    publicZipForm.append(
      'archive',
      new Blob([Buffer.from(zipSync({ 'public.txt': Buffer.from('Public share content', 'utf8') }))]),
      'public-share.zip',
    );
    publicZipForm.append('expiry', '24h');
    const publicShareCreate = await fetch(`${ctx.baseUrl}/api/shares`, {
      method: 'POST',
      body: publicZipForm,
    });
    assert.equal(publicShareCreate.status, 201);
    const { shareId: publicShareId } = (await publicShareCreate.json()) as { shareId: string };

    // 5. Connect Bob via GitHub OAuth flow and verify OAuth state binding & replay protection
    const bobOAuthRes = await fetch(`${ctx.baseUrl}/api/github/oauth/url`, {
      headers: ctx.bobHeaders,
    });
    assert.equal(bobOAuthRes.status, 200);
    const { authorizeUrl } = (await bobOAuthRes.json()) as { authorizeUrl: string };
    const bobOAuthState = new URL(authorizeUrl).searchParams.get('state')!;
    assert.ok(bobOAuthState);

    // Tampered state is rejected
    const tamperedCb = await fetch(
      `${ctx.baseUrl}/api/github/callback?code=valid-code-bob&state=${encodeURIComponent(
        bobOAuthState.slice(0, -4) + 'AAAA',
      )}`,
    );
    assert.equal(tamperedCb.status, 403);

    // Valid callback binds Bob's GitHub account strictly to Bob's UID
    const validBobCb = await fetch(
      `${ctx.baseUrl}/api/github/callback?code=valid-code-bob&state=${encodeURIComponent(bobOAuthState)}`,
    );
    assert.equal(validBobCb.status, 200);

    // Replaying consumed OAuth state fails with 403
    const replayCb = await fetch(
      `${ctx.baseUrl}/api/github/callback?code=valid-code-bob&state=${encodeURIComponent(bobOAuthState)}`,
    );
    assert.equal(replayCb.status, 403);

    // Verify Bob sees only bob-dev/bob-app and NEVER alice-dev/webapp
    const bobReposRes = await fetch(`${ctx.baseUrl}/api/github/repos`, {
      headers: ctx.bobHeaders,
    });
    assert.equal(bobReposRes.status, 200);
    const bobReposJson = (await bobReposRes.json()) as { repos: GitHubRepoSummary[] };
    assert.deepEqual(
      bobReposJson.repos.map((r) => r.fullName),
      ['bob-dev/bob-app'],
    );

    // Create Bob's own workspace
    const bobWsRes = await fetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...ctx.bobHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'bob-dev', repo: 'bob-app', branch: 'main' }),
    });
    assert.equal(bobWsRes.status, 201);
    const { workspace: bobWs } = (await bobWsRes.json()) as { workspace: { workspaceId: string } };

    // 6. Cross-user isolation: Bob NEVER sees Alice's workspace or stage, even with Bob's own valid tokens
    const bobWsListRes = await fetch(`${ctx.baseUrl}/api/workspaces`, { headers: ctx.bobHeaders });
    const bobWsList = (await bobWsListRes.json()) as {
      workspaces: Array<{ workspaceId: string }>;
    };
    assert.deepEqual(
      bobWsList.workspaces.map((w) => w.workspaceId),
      [bobWs.workspaceId],
    );

    const crossWsChecks: Array<[string, string, unknown?]> = [
      ['GET', `/api/workspaces/${aliceWs.workspaceId}`],
      ['DELETE', `/api/workspaces/${aliceWs.workspaceId}`],
      ['GET', `/api/workspaces/${aliceWs.workspaceId}/files/${aliceReadme.id}/content`],
      ['GET', `/api/workspaces/${aliceWs.workspaceId}/files/${aliceReadme.id}/download`],
      [
        'PUT',
        `/api/workspaces/${aliceWs.workspaceId}/files/${aliceReadme.id}/content`,
        { content: 'Hacked' },
      ],
      ['POST', `/api/workspaces/${aliceWs.workspaceId}/pull/check`],
      ['GET', `/api/workspaces/${aliceWs.workspaceId}/diff`],
      ['POST', `/api/workspaces/${aliceWs.workspaceId}/push`, { newBranchName: 'ziplink/hack' }],
      ['GET', `/api/zip-to-github/stage/${aliceStage.stageId}`],
      [
        'POST',
        `/api/zip-to-github/stage/${aliceStage.stageId}/plan`,
        { owner: 'bob-dev', repo: 'bob-app', branch: 'main' },
      ],
    ];

    for (const [method, endpoint, body] of crossWsChecks) {
      const r = await fetch(`${ctx.baseUrl}${endpoint}`, {
        method,
        headers: {
          ...ctx.bobHeaders,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      assert.equal(r.status, 404, `Bob accessing Alice ${method} ${endpoint} must return 404`);
    }

    // 7. Disconnecting GitHub clears only Alice's GitHub token (leaving Alice's account/Bob intact)
    const aliceDisconnectRes = await fetch(`${ctx.baseUrl}/api/github/logout`, {
      method: 'POST',
      headers: ctx.aliceHeaders,
    });
    assert.equal(aliceDisconnectRes.status, 200);

    const aliceStatusAfterDisconnect = (await (
      await fetch(`${ctx.baseUrl}/api/github/status`, { headers: ctx.aliceHeaders })
    ).json()) as { connected: boolean };
    assert.equal(aliceStatusAfterDisconnect.connected, false);

    // Bob's GitHub connection remains intact
    const bobStatusStillConnected = (await (
      await fetch(`${ctx.baseUrl}/api/github/status`, { headers: ctx.bobHeaders })
    ).json()) as { connected: boolean };
    assert.equal(bobStatusStillConnected.connected, true);

    // 8. Delete Alice's account data removes Alice's workspaces & stage, keeping Bob's workspace & public share intact
    const deleteWithoutConfirm = await fetch(`${ctx.baseUrl}/api/account/data`, {
      method: 'DELETE',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDelete: false }),
    });
    assert.equal(deleteWithoutConfirm.status, 400);

    const deleteAliceRes = await fetch(`${ctx.baseUrl}/api/account/data`, {
      method: 'DELETE',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDelete: true }),
    });
    assert.equal(deleteAliceRes.status, 200);
    const deleteJson = (await deleteAliceRes.json()) as {
      deleted: boolean;
      deletedWorkspaces: number;
      deletedStages: number;
    };
    assert.equal(deleteJson.deleted, true);
    assert.equal(deleteJson.deletedWorkspaces, 1);
    assert.equal(deleteJson.deletedStages, 1);

    // Alice's workspace & stage are gone
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/workspaces/${aliceWs.workspaceId}`, { headers: ctx.aliceHeaders }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/zip-to-github/stage/${aliceStage.stageId}`, {
          headers: ctx.aliceHeaders,
        })
      ).status,
      404,
    );

    // Bob's workspace and public ZIP share remain completely intact
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/workspaces/${bobWs.workspaceId}`, { headers: ctx.bobHeaders }))
        .status,
      200,
    );
    assert.equal((await fetch(`${ctx.baseUrl}/api/shares/${publicShareId}`)).status, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('GitHub App workspace lifecycle: secret protection, auth scope, edit, binary preserve, pull conflicts, remote moved, branch/PR push, and permission-gated PR merge', async () => {
  const ctx = await setupEnv();
  try {
    // 1. Status never exposes tokens or client secret; lists only Alice's authorized repos
    const statusRes = await fetch(`${ctx.baseUrl}/api/github/status`, {
      headers: ctx.aliceHeaders,
    });
    assert.equal(statusRes.status, 200);
    const statusText = await statusRes.text();
    assert.equal(statusText.includes(ctx.mockGh.aliceAccessToken), false);
    assert.equal(statusText.includes('SUPER_SECRET_CLIENT_SECRET'), false);

    const reposRes = await fetch(`${ctx.baseUrl}/api/github/repos`, {
      headers: ctx.aliceHeaders,
    });
    const reposJson = (await reposRes.json()) as { repos: GitHubRepoSummary[] };
    assert.deepEqual(
      reposJson.repos.map((r) => r.fullName).sort(),
      ['alice-dev/readonly-repo', 'alice-dev/webapp'],
    );

    // 2. Rejects importing unauthorized repo
    const unauthImport = await fetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'alice-dev', repo: 'secret-unauth', branch: 'main' }),
    });
    assert.equal(unauthImport.status, 403);

    // 3. Import authorized repository & branch into private workspace
    const importRes = await fetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'alice-dev', repo: 'webapp', branch: 'main' }),
    });
    assert.equal(importRes.status, 201);
    const { workspace } = (await importRes.json()) as {
      workspace: {
        workspaceId: string;
        baseCommitSha: string;
        files: Array<{ id: string; path: string; isText: boolean }>;
      };
    };
    assert.equal(workspace.baseCommitSha, 'commit-1-webapp');
    assert.equal(workspace.files.length, 4);

    // Ensure workspace was NOT exposed as public Share link
    const publicCheck = await fetch(`${ctx.baseUrl}/api/shares/${workspace.workspaceId}`);
    assert.equal(publicCheck.status, 404);

    // 4. Edit text file & replace binary file preserving exact bytes
    const indexEntry = workspace.files.find((f) => f.path === 'src/index.ts')!;
    const editRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/files/${indexEntry.id}/content`,
      {
        method: 'PUT',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'export const version = 2;\n' }),
      },
    );
    assert.equal(editRes.status, 200);

    const exactBinaryBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x10, 0x20, 0x89, 0x50]);
    const logoEntry = workspace.files.find((f) => f.path === 'assets/logo.png')!;
    const replaceForm = new FormData();
    replaceForm.append('file', new Blob([exactBinaryBytes]), 'logo.png');
    const replaceRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/files/${logoEntry.id}/replace`,
      {
        method: 'POST',
        headers: ctx.aliceHeaders,
        body: replaceForm,
      },
    );
    assert.equal(replaceRes.status, 200);

    const dlRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/files/${logoEntry.id}/download`,
      { headers: ctx.aliceHeaders },
    );
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.deepEqual(dlBuf, exactBinaryBytes);

    // 5. Remote moves cleanly on docs/notes.md deletion + simultaneous conflict on src/index.ts & assets/logo.png
    ctx.mockGh.advanceRemoteBranch('alice-dev/webapp', 'main', (files) => {
      files.set('src/index.ts', Buffer.from('export const version = 99;\n', 'utf8'));
      files.set('assets/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x02]));
      files.delete('docs/notes.md');
    });

    // Attempting push while remote moved MUST fail 409
    const blockedPushRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/push`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranchName: 'ziplink/should-stop' }),
      },
    );
    assert.equal(blockedPushRes.status, 409);

    // Pull check detects text conflict, binary conflict, and upstream deletion
    const pullCheckRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/pull/check`,
      { method: 'POST', headers: ctx.aliceHeaders },
    );
    assert.equal(pullCheckRes.status, 200);
    const pullData = (await pullCheckRes.json()) as {
      conflicts: Array<{ path: string; isBinary: boolean }>;
      upstreamDeletions: Array<{ path: string }>;
      appliedAutomatically: boolean;
    };
    assert.equal(pullData.appliedAutomatically, false);
    assert.equal(pullData.conflicts.length, 2);
    assert.equal(pullData.conflicts.find((c) => c.path === 'assets/logo.png')?.isBinary, true);
    assert.deepEqual(
      pullData.upstreamDeletions.map((d) => d.path),
      ['docs/notes.md'],
    );

    // Cannot apply without confirming upstream deletion
    const missingConfirmRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/pull/apply`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conflictResolutions: {
            'src/index.ts': 'keep_workspace',
            'assets/logo.png': 'keep_workspace',
          },
          confirmedDeletionPaths: [],
        }),
      },
    );
    assert.equal(missingConfirmRes.status, 400);

    // Apply with explicit confirmation + resolution
    const applyRes = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/pull/apply`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conflictResolutions: {
            'src/index.ts': 'keep_workspace',
            'assets/logo.png': 'keep_workspace',
          },
          confirmedDeletionPaths: ['docs/notes.md'],
        }),
      },
    );
    assert.equal(applyRes.status, 200);

    // 6. Push to new branch + PR (and test default branch refusal + compare fallback)
    const directMainPush = await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/push`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranchName: 'main', commitMessage: 'Bad direct push' }),
      },
    );
    assert.equal(directMainPush.status, 400);

    const repoState = ctx.mockGh.repos.get('alice-dev/webapp')!;
    repoState.failNextPrCreation = true;
    const pushRes = await fetch(`${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/push`, {
      method: 'POST',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newBranchName: 'ziplink/feature-edit',
        commitMessage: 'Update index and binary logo',
        prTitle: 'Update index and binary logo',
        prBody: 'Edited safely in ZipLink',
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushJson = (await pushRes.json()) as PushToGitHubResult;
    assert.equal(pushJson.pushed, true);
    assert.equal(pushJson.branch, 'ziplink/feature-edit');
    assert.equal(pushJson.pullRequest, null);
    assert.ok(pushJson.prWarning);
    assert.match(pushJson.compareUrl, /compare\/main\.\.\.ziplink/);

    // Verify pushed binary bytes on GitHub new branch are byte-for-byte identical
    const pushedBranch = repoState.branches.get('ziplink/feature-edit')!;
    assert.deepEqual(pushedBranch.files.get('assets/logo.png'), exactBinaryBytes);
    // Default branch 'main' was never overwritten directly
    assert.notDeepEqual(repoState.branches.get('main')!.files.get('assets/logo.png'), exactBinaryBytes);

    // 7. Create a second edit -> push PR -> verify PR is NEVER auto-merged, requires confirmed: true & permission
    await fetch(
      `${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/files/${indexEntry.id}/content`,
      {
        method: 'PUT',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'export const version = 3;\n' }),
      },
    );
    const prPushRes = await fetch(`${ctx.baseUrl}/api/workspaces/${workspace.workspaceId}/push`, {
      method: 'POST',
      headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newBranchName: 'ziplink/feature-v3',
        commitMessage: 'Bump version to 3',
        prTitle: 'Bump version to 3',
      }),
    });
    assert.equal(prPushRes.status, 200);
    const prPushJson = (await prPushRes.json()) as PushToGitHubResult;
    assert.ok(prPushJson.pullRequest);
    assert.equal(prPushJson.canMergePullRequest, true);

    const createdPr = repoState.pullRequests.find((p) => p.number === prPushJson.pullRequest!.number)!;
    assert.notEqual(createdPr.merged, true, 'PR must never auto-merge on push');

    // Merge without explicit confirmation must fail with 400
    const unconfirmedMerge = await fetch(
      `${ctx.baseUrl}/api/github/repos/alice-dev/webapp/pulls/${createdPr.number}/merge`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeMethod: 'squash', confirmed: false }),
      },
    );
    assert.equal(unconfirmedMerge.status, 400);

    // Merge on read-only repo without push/maintain/admin permission fails with 403
    const readonlyMerge = await fetch(
      `${ctx.baseUrl}/api/github/repos/alice-dev/readonly-repo/pulls/1/merge`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeMethod: 'merge', confirmed: true }),
      },
    );
    assert.equal(readonlyMerge.status, 403);

    // Confirmed merge on permitted repo succeeds
    const confirmedMerge = await fetch(
      `${ctx.baseUrl}/api/github/repos/alice-dev/webapp/pulls/${createdPr.number}/merge`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeMethod: 'squash', confirmed: true }),
      },
    );
    assert.equal(confirmedMerge.status, 200);
    const mergeResult = (await confirmedMerge.json()) as MergePullRequestResult;
    assert.equal(mergeResult.merged, true);
    assert.equal(createdPr.merged, true);
  } finally {
    await ctx.cleanup();
  }
});

test('ZIP-to-GitHub workflow: suggestions, manual override, collisions, default non-deletion vs mirror mode, and honest API failure handling', async () => {
  const ctx = await setupEnv();
  try {
    const zipBytes = zipSync({
      'README.md': Buffer.from('# WebApp\nInitial readme\n', 'utf8'),
      'src/index.ts': Buffer.from('export const version = 42;\n', 'utf8'),
      'src/added.ts': Buffer.from('export const added = true;\n', 'utf8'),
    });

    const form = new FormData();
    form.append('archive', new Blob([Buffer.from(zipBytes)]), 'export.zip');

    const stageRes = await fetch(`${ctx.baseUrl}/api/zip-to-github/stage`, {
      method: 'POST',
      headers: ctx.aliceHeaders,
      body: form,
    });
    assert.equal(stageRes.status, 201);
    const { stage } = (await stageRes.json()) as {
      stage: {
        stageId: string;
        suggestions: Array<{ fullName: string; exactHashMatchCount: number }>;
      };
    };
    assert.equal(stage.suggestions[0].fullName, 'alice-dev/webapp');
    assert.equal(stage.suggestions[0].exactHashMatchCount, 1);

    // Preview add_update plan (default) -> 1 addition, 1 collision (src/index.ts), 1 unchanged (README.md), 0 deletions
    const planRes = await fetch(
      `${ctx.baseUrl}/api/zip-to-github/stage/${stage.stageId}/plan`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: 'alice-dev',
          repo: 'webapp',
          branch: 'main',
          targetFolder: '',
          mode: 'add_update',
        }),
      },
    );
    assert.equal(planRes.status, 200);
    const { plan } = (await planRes.json()) as {
      plan: {
        baseCommitSha: string;
        additions: Array<{ targetPath: string }>;
        collisions: Array<{ targetPath: string }>;
        unchanged: Array<{ targetPath: string }>;
        deletions: Array<{ targetPath: string }>;
      };
    };
    assert.equal(plan.additions.length, 1);
    assert.equal(plan.collisions.length, 1);
    assert.equal(plan.unchanged.length, 1);
    assert.equal(plan.deletions.length, 0);

    // Mirror mode without explicit confirmation is rejected
    const mirrorBlocked = await fetch(
      `${ctx.baseUrl}/api/zip-to-github/stage/${stage.stageId}/push`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: 'alice-dev',
          repo: 'webapp',
          branch: 'main',
          mode: 'mirror',
          expectedBaseCommitSha: plan.baseCommitSha,
          newBranchName: 'ziplink/mirror-fail',
          confirmedMirrorDeletions: false,
        }),
      },
    );
    assert.equal(mirrorBlocked.status, 400);

    // Failed GitHub push reports error honestly and retains staged ZIP for retry
    const repoState = ctx.mockGh.repos.get('alice-dev/webapp')!;
    repoState.failNextPush = true;
    const failedPush = await fetch(
      `${ctx.baseUrl}/api/zip-to-github/stage/${stage.stageId}/push`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: 'alice-dev',
          repo: 'webapp',
          branch: 'main',
          mode: 'add_update',
          expectedBaseCommitSha: plan.baseCommitSha,
          newBranchName: 'ziplink/zip-import',
          commitMessage: 'Import from ZIP',
        }),
      },
    );
    assert.equal(failedPush.status, 502);

    // Retry succeeds and creates a Pull Request on the new branch
    const successPush = await fetch(
      `${ctx.baseUrl}/api/zip-to-github/stage/${stage.stageId}/push`,
      {
        method: 'POST',
        headers: { ...ctx.aliceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: 'alice-dev',
          repo: 'webapp',
          branch: 'main',
          mode: 'add_update',
          expectedBaseCommitSha: plan.baseCommitSha,
          newBranchName: 'ziplink/zip-import',
          commitMessage: 'Import from ZIP',
          prTitle: 'Import export.zip',
        }),
      },
    );
    assert.equal(successPush.status, 200);
    const pushResult = (await successPush.json()) as PushToGitHubResult;
    assert.equal(pushResult.pushed, true);
    assert.ok(pushResult.pullRequest);
    assert.equal(pushResult.pullRequest.number, 1);

    // Absent files like docs/notes.md were preserved under add_update default
    const importedBranch = repoState.branches.get('ziplink/zip-import')!;
    assert.ok(importedBranch.files.has('docs/notes.md'));
    assert.ok(importedBranch.files.has('src/added.ts'));
  } finally {
    await ctx.cleanup();
  }
});
