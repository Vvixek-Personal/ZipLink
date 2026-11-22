import type {
  GitHubBranchSummary,
  GitHubRepoPermissions,
  GitHubRepoSummary,
  GitHubUser,
  MergePullRequestResult,
  PushToGitHubResult,
} from '../shared/types.ts';
import type { RemoteTreeEntry } from '../shared/gitSync.ts';
import { validateArchiveEntryPath } from '../shared/zipSecurity.ts';

export class GitHubApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 502) {
    super(message);
    this.name = 'GitHubApiError';
    this.statusCode = statusCode;
  }
}

export class GitHubRemoteMovedError extends GitHubApiError {
  latestCommitSha: string;

  constructor(message: string, latestCommitSha: string) {
    super(message, 409);
    this.name = 'GitHubRemoteMovedError';
    this.latestCommitSha = latestCommitSha;
  }
}

export interface OAuthTokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
}

export interface AuthorizedReposResult {
  repos: GitHubRepoSummary[];
  needsAppInstallation: boolean;
}

export interface GitCommitTreeChange {
  path: string;
  mode?: string;
  contentBytes?: Buffer;
  delete?: boolean;
}

interface RawGitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  html_url: string;
  description: string | null;
  pushed_at: string | null;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    pull?: boolean;
  };
}

export interface GitHubClient {
  exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthTokenExchangeResult>;
  refreshUserToken(refreshToken: string): Promise<OAuthTokenExchangeResult>;
  getAuthenticatedUser(accessToken: string): Promise<GitHubUser>;
  listAuthorizedRepos(accessToken: string): Promise<AuthorizedReposResult>;
  getRepo(accessToken: string, owner: string, repo: string): Promise<GitHubRepoSummary>;
  listBranches(accessToken: string, owner: string, repo: string): Promise<GitHubBranchSummary[]>;
  getBranchHead(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ commitSha: string; treeSha: string }>;
  getTreeRecursive(
    accessToken: string,
    owner: string,
    repo: string,
    treeSha: string,
    maxEntries: number,
  ): Promise<RemoteTreeEntry[]>;
  getBlobRaw(accessToken: string, owner: string, repo: string, blobSha: string): Promise<Buffer>;
  pushChangesToNewBranchAndPr(params: {
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
  }): Promise<PushToGitHubResult>;
  mergePullRequest(params: {
    accessToken: string;
    owner: string;
    repo: string;
    pullNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
  }): Promise<MergePullRequestResult>;
  createRepository(
    accessToken: string,
    params: { name: string; description: string; isPrivate: boolean },
  ): Promise<GitHubRepoSummary>;
}

export class RealGitHubClient implements GitHubClient {
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(params: {
    apiBaseUrl: string;
    authBaseUrl: string;
    clientId: string;
    clientSecret: string;
  }) {
    this.apiBaseUrl = params.apiBaseUrl.replace(/\/+$/, '');
    this.authBaseUrl = params.authBaseUrl.replace(/\/+$/, '');
    this.clientId = params.clientId;
    this.clientSecret = params.clientSecret;
  }

  private async apiRequest<T>(
    accessToken: string,
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ZipLink-Workspace',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed.message === 'string' && parsed.message) ||
        `GitHub API responded with status ${res.status}.`;
      throw new GitHubApiError(msg, res.status);
    }

    return parsed as T;
  }

  async exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthTokenExchangeResult> {
    const res = await fetch(`${this.authBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      const errDesc =
        (typeof data.error_description === 'string' && data.error_description) ||
        (typeof data.error === 'string' && data.error) ||
        'Failed to exchange GitHub authorization code.';
      throw new GitHubApiError(errDesc, 401);
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
    };
  }

  async refreshUserToken(refreshToken: string): Promise<OAuthTokenExchangeResult> {
    const res = await fetch(`${this.authBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new GitHubApiError('GitHub session expired. Please reconnect GitHub.', 401);
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
      expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
    };
  }

  async getAuthenticatedUser(accessToken: string): Promise<GitHubUser> {
    const data = await this.apiRequest<{
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    }>(accessToken, 'GET', '/user');
    return {
      id: data.id,
      login: data.login,
      name: data.name ?? null,
      avatarUrl: data.avatar_url ?? null,
    };
  }

  private mapRepo(raw: RawGitHubRepo): GitHubRepoSummary {
    return {
      id: raw.id,
      name: raw.name,
      fullName: raw.full_name,
      owner: raw.owner.login,
      private: Boolean(raw.private),
      defaultBranch: raw.default_branch || 'main',
      htmlUrl: raw.html_url,
      description: raw.description ?? null,
      pushedAt: raw.pushed_at ?? null,
      permissions: raw.permissions
        ? {
            admin: Boolean(raw.permissions.admin),
            maintain: Boolean(raw.permissions.maintain),
            push: Boolean(raw.permissions.push),
            pull: Boolean(raw.permissions.pull),
          }
        : undefined,
    };
  }

  async listAuthorizedRepos(accessToken: string): Promise<AuthorizedReposResult> {
    // Strictly list only repositories where the user has authorized the GitHub App
    const installationsResp = await this.apiRequest<{
      installations: Array<{ id: number }>;
    }>(accessToken, 'GET', '/user/installations?per_page=100');

    const installations = installationsResp.installations ?? [];
    if (installations.length === 0) {
      return {
        repos: [],
        needsAppInstallation: true,
      };
    }

    const repoMap = new Map<number, GitHubRepoSummary>();
    for (const inst of installations) {
      const reposResp = await this.apiRequest<{
        repositories: RawGitHubRepo[];
      }>(accessToken, 'GET', `/user/installations/${inst.id}/repositories?per_page=100`);

      for (const r of reposResp.repositories ?? []) {
        repoMap.set(r.id, this.mapRepo(r));
      }
    }

    const repos = [...repoMap.values()].sort((a, b) => {
      const timeA = a.pushedAt ? Date.parse(a.pushedAt) : 0;
      const timeB = b.pushedAt ? Date.parse(b.pushedAt) : 0;
      return timeB - timeA || a.fullName.localeCompare(b.fullName, 'en');
    });

    return {
      repos,
      needsAppInstallation: repos.length === 0,
    };
  }

  async getRepo(accessToken: string, owner: string, repo: string): Promise<GitHubRepoSummary> {
    const raw = await this.apiRequest<RawGitHubRepo>(
      accessToken,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    return this.mapRepo(raw);
  }

  async listBranches(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubBranchSummary[]> {
    const data = await this.apiRequest<
      Array<{ name: string; commit: { sha: string }; protected?: boolean }>
    >(
      accessToken,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    );
    return data.map((b) => ({
      name: b.name,
      commitSha: b.commit.sha,
      protected: Boolean(b.protected),
    }));
  }

  async getBranchHead(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ commitSha: string; treeSha: string }> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedBranch = branch
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');

    const refData = await this.apiRequest<{ object: { sha: string } }>(
      accessToken,
      'GET',
      `/repos/${encodedOwner}/${encodedRepo}/git/ref/heads/${encodedBranch}`,
    );
    const commitSha = refData.object.sha;
    const commitData = await this.apiRequest<{ tree: { sha: string } }>(
      accessToken,
      'GET',
      `/repos/${encodedOwner}/${encodedRepo}/git/commits/${encodeURIComponent(commitSha)}`,
    );

    return {
      commitSha,
      treeSha: commitData.tree.sha,
    };
  }

  async getTreeRecursive(
    accessToken: string,
    owner: string,
    repo: string,
    treeSha: string,
    maxEntries: number,
  ): Promise<RemoteTreeEntry[]> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);

    const data = await this.apiRequest<{
      truncated: boolean;
      tree: Array<{
        path: string;
        mode: string;
        type: 'blob' | 'tree' | 'commit';
        sha: string;
        size?: number;
      }>;
    }>(
      accessToken,
      'GET',
      `/repos/${encodedOwner}/${encodedRepo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );

    const result: RemoteTreeEntry[] = [];
    for (const item of data.tree ?? []) {
      if (item.type !== 'blob') continue;
      if (item.mode === '120000') continue;
      const pathCheck = validateArchiveEntryPath(item.path);
      if (!pathCheck.valid || !pathCheck.normalizedPath || pathCheck.isDirectory) continue;

      result.push({
        path: pathCheck.normalizedPath,
        sha: item.sha,
        sizeBytes: item.size ?? 0,
        mode: item.mode || '100644',
      });

      if (result.length > maxEntries) {
        throw new GitHubApiError(
          `Repository exceeds the ${maxEntries}-file workspace limit.`,
          413,
        );
      }
    }

    return result;
  }

  async getBlobRaw(
    accessToken: string,
    owner: string,
    repo: string,
    blobSha: string,
  ): Promise<Buffer> {
    const data = await this.apiRequest<{ content: string; encoding: string }>(
      accessToken,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`,
    );
    if (data.encoding === 'base64') {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64');
    }
    return Buffer.from(data.content || '', 'utf8');
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
    const {
      accessToken,
      owner,
      repo,
      baseBranch,
      expectedBaseCommitSha,
      baseTreeSha,
      newBranchName,
      commitMessage,
      prTitle,
      prBody,
      changes,
      createPullRequest,
    } = params;

    if (newBranchName === baseBranch) {
      throw new GitHubApiError(
        'Cannot silently push directly to the target base branch. Choose a new branch name.',
        400,
      );
    }

    const currentHead = await this.getBranchHead(accessToken, owner, repo, baseBranch);
    if (currentHead.commitSha !== expectedBaseCommitSha) {
      throw new GitHubRemoteMovedError(
        `Remote branch "${baseBranch}" has moved to ${currentHead.commitSha.slice(0, 7)}. Pull and review the latest changes before pushing.`,
        currentHead.commitSha,
      );
    }

    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);

    const treeEntries: Array<{
      path: string;
      mode: string;
      type: 'blob';
      sha: string | null;
    }> = [];

    for (const ch of changes) {
      if (ch.delete) {
        treeEntries.push({
          path: ch.path,
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      } else if (ch.contentBytes) {
        const blobResp = await this.apiRequest<{ sha: string }>(
          accessToken,
          'POST',
          `/repos/${encodedOwner}/${encodedRepo}/git/blobs`,
          {
            content: ch.contentBytes.toString('base64'),
            encoding: 'base64',
          },
        );
        treeEntries.push({
          path: ch.path,
          mode: ch.mode || '100644',
          type: 'blob',
          sha: blobResp.sha,
        });
      }
    }

    const treeResp = await this.apiRequest<{ sha: string }>(
      accessToken,
      'POST',
      `/repos/${encodedOwner}/${encodedRepo}/git/trees`,
      {
        base_tree: baseTreeSha,
        tree: treeEntries,
      },
    );

    const commitResp = await this.apiRequest<{ sha: string; html_url?: string }>(
      accessToken,
      'POST',
      `/repos/${encodedOwner}/${encodedRepo}/git/commits`,
      {
        message: commitMessage,
        tree: treeResp.sha,
        parents: [expectedBaseCommitSha],
      },
    );

    await this.apiRequest<{ ref: string }>(
      accessToken,
      'POST',
      `/repos/${encodedOwner}/${encodedRepo}/git/refs`,
      {
        ref: `refs/heads/${newBranchName}`,
        sha: commitResp.sha,
      },
    );

    const repoBaseHtml = `https://github.com/${owner}/${repo}`;
    const branchUrl = `${repoBaseHtml}/tree/${encodeURIComponent(newBranchName)}`;
    const compareUrl = `${repoBaseHtml}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(newBranchName)}?expand=1`;
    const commitUrl = commitResp.html_url || `${repoBaseHtml}/commit/${commitResp.sha}`;

    let pullRequest: PushToGitHubResult['pullRequest'] = null;
    let prWarning: string | null = null;
    let canMergePullRequest = false;

    if (createPullRequest) {
      try {
        const prResp = await this.apiRequest<{
          number: number;
          html_url: string;
          title: string;
        }>(accessToken, 'POST', `/repos/${encodedOwner}/${encodedRepo}/pulls`, {
          title: prTitle,
          body: prBody,
          head: newBranchName,
          base: baseBranch,
        });
        pullRequest = {
          number: prResp.number,
          url: prResp.html_url,
          title: prResp.title,
        };

        let perms = params.repoPermissions;
        if (!perms) {
          try {
            const summary = await this.getRepo(accessToken, owner, repo);
            perms = summary.permissions;
          } catch {
            perms = undefined;
          }
        }
        canMergePullRequest = Boolean(perms?.push || perms?.maintain || perms?.admin);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Pull Request creation was rejected.';
        prWarning = `Changes were pushed to new branch "${newBranchName}", but the Pull Request could not be created (${reason}). Use the compare link below to open it on GitHub.`;
      }
    }

    return {
      pushed: true,
      branch: newBranchName,
      baseBranch,
      commitSha: commitResp.sha,
      commitUrl,
      branchUrl,
      compareUrl,
      pullRequest,
      canMergePullRequest,
      repoOwner: owner,
      repoName: repo,
      prWarning,
    };
  }

  async mergePullRequest(params: {
    accessToken: string;
    owner: string;
    repo: string;
    pullNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
  }): Promise<MergePullRequestResult> {
    const summary = await this.getRepo(params.accessToken, params.owner, params.repo);
    const perms = summary.permissions;
    if (!perms || (!perms.push && !perms.maintain && !perms.admin)) {
      throw new GitHubApiError(
        'Your GitHub user does not have write or merge permission on this repository.',
        403,
      );
    }

    const encodedOwner = encodeURIComponent(params.owner);
    const encodedRepo = encodeURIComponent(params.repo);
    const mergeMethod = params.mergeMethod ?? 'merge';

    const resp = await this.apiRequest<{
      merged?: boolean;
      sha?: string;
      message?: string;
    }>(
      params.accessToken,
      'PUT',
      `/repos/${encodedOwner}/${encodedRepo}/pulls/${params.pullNumber}/merge`,
      {
        merge_method: mergeMethod,
        ...(params.commitTitle ? { commit_title: params.commitTitle } : {}),
      },
    );

    if (!resp.merged) {
      throw new GitHubApiError(
        resp.message || 'Pull Request could not be merged on GitHub.',
        409,
      );
    }

    return {
      merged: true,
      sha: resp.sha || '',
      message: resp.message || 'Pull Request merged.',
    };
  }

  async createRepository(
    accessToken: string,
    params: { name: string; description: string; isPrivate: boolean },
  ): Promise<GitHubRepoSummary> {
    const raw = await this.apiRequest<RawGitHubRepo>(accessToken, 'POST', '/user/repos', {
      name: params.name,
      description: params.description,
      private: params.isPrivate,
      auto_init: true,
    });
    return this.mapRepo(raw);
  }
}
