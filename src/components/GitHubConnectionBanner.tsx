import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, GitBranch, LogOut, ShieldCheck } from 'lucide-react';
import type { GitHubConfigStatus } from '../shared/types.ts';
import { apiRequestJson } from '../utils/githubApi.ts';

interface GitHubConnectionBannerProps {
  status: GitHubConfigStatus | null;
  loading: boolean;
  authEmail?: string | null;
  onRefreshStatus: () => Promise<void>;
}

export const GitHubConnectionBanner: React.FC<GitHubConnectionBannerProps> = ({
  status,
  loading,
  authEmail,
  onRefreshStatus,
}) => {
  const [connecting, setConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const payload = event.data as { type?: string; error?: string };
      if (payload.type === 'ZIPLINK_GITHUB_AUTH_SUCCESS') {
        setConnecting(false);
        setFallbackUrl(null);
        setErrorMsg(null);
        void onRefreshStatus();
      } else if (payload.type === 'ZIPLINK_GITHUB_AUTH_ERROR') {
        setConnecting(false);
        setErrorMsg(payload.error || 'GitHub authorization was not completed.');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRefreshStatus]);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleConnect = async () => {
    setErrorMsg(null);
    setFallbackUrl(null);
    setConnecting(true);
    try {
      const data = await apiRequestJson<{ authorizeUrl: string }>('/api/github/oauth/url');
      const popup = window.open(
        data.authorizeUrl,
        'ziplink-github-oauth',
        'width=640,height=740,noopener=no',
      );
      if (!popup || popup.closed) {
        setConnecting(false);
        setFallbackUrl(data.authorizeUrl);
        setErrorMsg(
          'Your browser blocked the authorization popup. Open the GitHub authorization link directly below.',
        );
      }
    } catch (err) {
      setConnecting(false);
      setErrorMsg(err instanceof Error ? err.message : 'Unable to start GitHub authorization.');
    }
  };

  const handleDisconnect = async () => {
    setErrorMsg(null);
    try {
      await apiRequestJson('/api/github/logout', { method: 'POST' });
      await onRefreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to disconnect GitHub session.');
    }
  };

  if (loading && !status) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
        Checking GitHub App configuration and session status...
      </div>
    );
  }

  if (!status) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900"
      >
        Unable to reach the server to check GitHub App status.
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="rounded-xl border border-amber-300 bg-white p-6 space-y-5">
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold tracking-tight text-slate-900">
            GitHub App configuration required
          </h2>
          <p className="text-sm leading-relaxed text-slate-600">
            ZipLink does not fake GitHub repositories, commits, or Pull Requests. Configure a real
            GitHub App in your server environment to connect authorized repositories.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2.5 text-sm">
            <div className="font-semibold text-slate-900">Missing server environment variables</div>
            <ul className="space-y-1 font-mono text-xs text-slate-700">
              {status.missingVars.map((v) => (
                <li key={v}>{v}</li>
              ))}
              <li className="text-slate-500">ZIPLINK_SESSION_SECRET (recommended persistent encryption key)</li>
            </ul>
            <p className="text-xs text-slate-600">
              GitHub client secrets, App private keys, and user access tokens stay strictly on the
              server and are encrypted at rest.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2.5 text-sm">
            <div className="font-semibold text-slate-900">Required GitHub App permissions</div>
            <ul className="space-y-1 text-xs text-slate-700">
              <li>Repository Metadata: Read-only</li>
              <li>Repository Contents: Read &amp; write</li>
              <li>Pull requests: Read &amp; write</li>
              <li>Account option: Request user authorization (OAuth) during installation</li>
            </ul>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs">
          <div className="font-semibold text-sm text-slate-900">
            Register these OAuth Callback URLs on your GitHub App
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
              <code className="font-mono text-slate-800 break-all">
                {status.callbackUrls.current}
              </code>
              <button
                type="button"
                onClick={() => void handleCopy('current', status.callbackUrls.current)}
                className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {copiedKey === 'current' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy
                  </>
                )}
              </button>
            </div>
            {status.callbackUrls.development !== status.callbackUrls.current && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                <code className="font-mono text-slate-800 break-all">
                  {status.callbackUrls.development}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopy('dev', status.callbackUrls.development)}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  {copiedKey === 'dev' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!status.connected || !status.user) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-base font-bold text-slate-900">
              <GitBranch className="h-4 w-4 text-blue-700" aria-hidden="true" />
              Connect your GitHub account (separate from Google sign-in)
            </div>
            <p className="text-sm text-slate-600 max-w-2xl">
              Google sign-in{authEmail ? ` (${authEmail})` : ''} only identifies your private
              ZipLink account. Authorize GitHub separately below and choose only the specific
              repositories you want ZipLink to access.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {status.installUrl && (
              <a
                href={status.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Install / Choose repos
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
            <button
              type="button"
              disabled={connecting}
              onClick={() => void handleConnect()}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600 focus-visible:outline-2 focus-visible:outline-blue-700"
            >
              {connecting ? 'Waiting for GitHub...' : 'Connect GitHub'}
            </button>
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 space-y-2"
          >
            <div>{errorMsg}</div>
            {fallbackUrl && (
              <a
                href={fallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-blue-800 underline"
              >
                Open GitHub authorization window
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-3.5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-slate-700">
        <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0" aria-hidden="true" />
        <span>
          Connected as <strong className="font-semibold text-slate-900">@{status.user.login}</strong>
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-600">
          Workspaces stay private unless you explicitly push a branch to GitHub
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0 text-sm">
        {status.installUrl && (
          <a
            href={status.installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:underline"
          >
            Manage repo access
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          onClick={() => void handleDisconnect()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          Disconnect GitHub
        </button>
      </div>
    </div>
  );
};
