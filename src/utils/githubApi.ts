import type {
  AuthStatusResponse,
  GitHubConfigStatus,
  MergePullRequestResult,
} from '../shared/types.ts';

type TokenProvider = () => Promise<string | null>;

let authTokenProvider: TokenProvider | null = null;

export function setAuthTokenProvider(provider: TokenProvider | null): void {
  authTokenProvider = provider;
}

export async function getAuthToken(): Promise<string | null> {
  if (!authTokenProvider) return null;
  try {
    return await authTokenProvider();
  } catch {
    return null;
  }
}

export async function apiRequestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-ZipLink-Client', '1');
  }
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Authorization')) {
    const token = await getAuthToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const err = new Error(
      typeof data.error === 'string' && data.error
        ? data.error
        : `Request failed with status ${res.status}.`,
    ) as Error & { statusCode?: number; remoteMoved?: boolean; latestCommitSha?: string };
    err.statusCode = res.status;
    err.remoteMoved = data.remoteMoved === true;
    err.latestCommitSha =
      typeof data.latestCommitSha === 'string' ? data.latestCommitSha : undefined;
    throw err;
  }

  return data as T;
}

export async function downloadAuthorizedBlob(url: string, filename: string): Promise<void> {
  const headers = new Headers();
  const token = await getAuthToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `Download failed with status ${res.status}.`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-json
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return apiRequestJson<AuthStatusResponse>('/api/auth/status');
}

export async function fetchGitHubStatus(): Promise<GitHubConfigStatus> {
  return apiRequestJson<GitHubConfigStatus>('/api/github/status');
}

export async function mergeGitHubPullRequest(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  confirmed: boolean;
}): Promise<MergePullRequestResult> {
  return apiRequestJson<MergePullRequestResult>(
    `/api/github/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pullNumber}/merge`,
    {
      method: 'POST',
      body: JSON.stringify({
        mergeMethod: params.mergeMethod ?? 'merge',
        confirmed: params.confirmed,
      }),
    },
  );
}

export async function deleteZipLinkAccountData(): Promise<{
  deleted: boolean;
  deletedWorkspaces: number;
  deletedStages: number;
  disconnectedGitHub: boolean;
}> {
  return apiRequestJson('/api/account/data', {
    method: 'DELETE',
    body: JSON.stringify({ confirmDelete: true }),
  });
}
