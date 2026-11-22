import React from 'react';
import type { GitHubConfigStatus, ZipLinkAuthUser } from '../shared/types.ts';

export type TopBarRoute = 'upload' | 'share' | 'delete' | 'workspaces' | 'zip-to-github';

interface TopBarProps {
  activeRoute: TopBarRoute;
  authUser: ZipLinkAuthUser | null;
  firebaseConfigured: boolean;
  signingIn?: boolean;
  githubStatus: GitHubConfigStatus | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onNavigate: (path: string) => void;
  onNavigateHome: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeRoute,
  authUser,
  firebaseConfigured,
  signingIn = false,
  githubStatus,
  onSignIn,
  onSignOut,
  onNavigate,
  onNavigateHome,
}) => {
  const handleHomeClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onNavigateHome();
  };

  const handleLinkClick = (path: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onNavigate(path);
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
        <a
          href="/"
          onClick={handleHomeClick}
          className="whitespace-nowrap shrink-0 text-lg font-bold tracking-tight text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
        >
          ZipLink
        </a>

        <nav
          aria-label="Primary"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          <a
            href="/"
            onClick={handleHomeClick}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4 ${
              activeRoute === 'upload' ? 'text-slate-900 font-semibold' : ''
            }`}
          >
            Share ZIP
          </a>
          <a
            href="/workspaces"
            onClick={handleLinkClick('/workspaces')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4 ${
              activeRoute === 'workspaces' ? 'text-slate-900 font-semibold' : ''
            }`}
          >
            GitHub workspaces
          </a>
          <a
            href="/zip-to-github"
            onClick={handleLinkClick('/zip-to-github')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4 ${
              activeRoute === 'zip-to-github' ? 'text-slate-900 font-semibold' : ''
            }`}
          >
            ZIP to GitHub
          </a>
          <a
            href="/#limits"
            onClick={(e) => {
              if (activeRoute !== 'upload') {
                e.preventDefault();
                onNavigateHome();
                setTimeout(() => {
                  document.getElementById('limits')?.scrollIntoView({ behavior: 'smooth' });
                }, 60);
              }
            }}
            className="whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4"
          >
            Security &amp; limits
          </a>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          {authUser ? (
            <>
              <span
                className="hidden lg:inline max-w-[180px] truncate text-xs font-medium text-slate-600"
                title={authUser.email ?? authUser.name ?? undefined}
              >
                {authUser.email || authUser.name || 'Signed in'}
              </span>
              {githubStatus?.connected && githubStatus.user ? (
                <button
                  type="button"
                  onClick={() => onNavigate('/workspaces')}
                  className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                >
                  GitHub: @{githubStatus.user.login}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate('/workspaces')}
                  className="whitespace-nowrap shrink-0 rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                >
                  Connect GitHub
                </button>
              )}
              <button
                type="button"
                onClick={onSignOut}
                className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              >
                Sign out
              </button>
            </>
          ) : firebaseConfigured ? (
            <button
              type="button"
              disabled={signingIn}
              onClick={onSignIn}
              className="whitespace-nowrap shrink-0 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {signingIn ? 'Signing in...' : 'Sign in with Google'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('/workspaces')}
              className="whitespace-nowrap shrink-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              Workspaces
            </button>
          )}
        </div>
      </div>

      {/* Compact mobile navigation row */}
      <nav
        aria-label="Mobile navigation"
        className="flex md:hidden items-center gap-4 overflow-x-auto border-t border-slate-100 px-4 py-2 text-xs font-medium text-slate-600"
      >
        <a
          href="/"
          onClick={handleHomeClick}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeRoute === 'upload' ? 'text-blue-700 font-semibold' : ''
          }`}
        >
          Share ZIP
        </a>
        <a
          href="/workspaces"
          onClick={handleLinkClick('/workspaces')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeRoute === 'workspaces' ? 'text-blue-700 font-semibold' : ''
          }`}
        >
          GitHub workspaces
        </a>
        <a
          href="/zip-to-github"
          onClick={handleLinkClick('/zip-to-github')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeRoute === 'zip-to-github' ? 'text-blue-700 font-semibold' : ''
          }`}
        >
          ZIP to GitHub
        </a>
      </nav>
    </header>
  );
};
