import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import type {
  AppLimitsInfo,
  GitHubConfigStatus,
  UploadSuccessPayload,
  ZipLinkAuthUser,
} from './shared/types.ts';
import {
  auth,
  deleteUserProfileDocument,
  isFirebaseClientConfigured,
  signInWithGooglePopup,
  signOutFromZipLink,
  syncUserProfileDocument,
} from './firebase.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { TopBar, type TopBarRoute } from './components/TopBar.tsx';
import { UploadWorkspace } from './components/UploadWorkspace.tsx';
import { UploadSuccess } from './components/UploadSuccess.tsx';
import { ShareView } from './components/ShareView.tsx';
import { DeleteShareView } from './components/DeleteShareView.tsx';
import { WorkspacesHome } from './components/WorkspacesHome.tsx';
import { WorkspaceEditorView } from './components/WorkspaceEditorView.tsx';
import { ZipToGitHubView } from './components/ZipToGitHubView.tsx';
import { FirebaseAuthGate } from './components/FirebaseAuthGate.tsx';
import { AccountPanel } from './components/AccountPanel.tsx';
import {
  deleteZipLinkAccountData,
  fetchGitHubStatus,
  setAuthTokenProvider,
} from './utils/githubApi.ts';

type RouteState =
  | { view: 'upload' }
  | { view: 'share'; shareId: string }
  | { view: 'delete'; shareId: string; token: string }
  | { view: 'workspaces' }
  | { view: 'workspace-detail'; workspaceId: string }
  | { view: 'zip-to-github' };

function mapFirebaseUser(user: User | null): ZipLinkAuthUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.displayName,
    picture: user.photoURL,
  };
}

function parseLocationRoute(): RouteState {
  const pathname = window.location.pathname;
  const shareMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})\/?$/);
  if (shareMatch) {
    return { view: 'share', shareId: shareMatch[1] };
  }

  const deleteMatch = pathname.match(/^\/delete\/([A-Za-z0-9_-]{8,64})\/?$/);
  if (deleteMatch) {
    const params = new URLSearchParams(window.location.search);
    return {
      view: 'delete',
      shareId: deleteMatch[1],
      token: params.get('token') ?? '',
    };
  }

  const wsMatch = pathname.match(/^\/workspaces\/([A-Za-z0-9_-]{8,96})\/?$/);
  if (wsMatch) {
    return { view: 'workspace-detail', workspaceId: wsMatch[1] };
  }

  if (/^\/workspaces\/?$/.test(pathname)) {
    return { view: 'workspaces' };
  }

  if (/^\/zip-to-github\/?$/.test(pathname)) {
    return { view: 'zip-to-github' };
  }

  return { view: 'upload' };
}

function formatSignInError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/popup-closed-by-user') {
    return 'Google sign-in popup was closed before completing authentication.';
  }
  if (code === 'auth/popup-blocked') {
    return 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This hostname is not listed in Firebase Authentication Authorized Domains.';
  }
  return err instanceof Error ? err.message : 'Unable to complete Google sign-in.';
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => parseLocationRoute());
  const [uploadSuccess, setUploadSuccess] = useState<UploadSuccessPayload | null>(null);
  const [limits, setLimits] = useState<AppLimitsInfo | null>(null);

  const [authUser, setAuthUser] = useState<ZipLinkAuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(isFirebaseClientConfigured && Boolean(auth));
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);

  const [githubStatus, setGithubStatus] = useState<GitHubConfigStatus | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);

  const refreshGitHubStatus = useCallback(async () => {
    if (!auth?.currentUser) {
      setGithubStatus(null);
      setGithubLoading(false);
      return;
    }
    setGithubLoading(true);
    try {
      const next = await fetchGitHubStatus();
      setGithubStatus(next);
    } catch {
      // Leave previous state if transient failure
    } finally {
      setGithubLoading(false);
    }
  }, []);

  useEffect(() => {
    setAuthTokenProvider(async () => {
      if (!auth?.currentUser) return null;
      return auth.currentUser.getIdToken();
    });
    return () => setAuthTokenProvider(null);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseLocationRoute());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    fetch('/api/limits')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setLimits(data as AppLimitsInfo);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isFirebaseClientConfigured || !auth) {
      setAuthLoading(false);
      setAuthUser(null);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      const mapped = mapFirebaseUser(firebaseUser);
      setAuthUser(mapped);
      setAuthLoading(false);
      setAuthError(null);

      if (firebaseUser) {
        void syncUserProfileDocument(firebaseUser).catch((err) => {
          console.error('Failed syncing Firestore user profile:', err);
        });
        if (firebaseUser.emailVerified) {
          void refreshGitHubStatus();
        } else {
          setGithubStatus(null);
        }
      } else {
        setGithubStatus(null);
        setGithubLoading(false);
      }
    });

    return () => unsubscribe();
  }, [refreshGitHubStatus]);

  // Ensure share, delete, and private GitHub routes declare noindex in DOM as well as HTTP headers
  useEffect(() => {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const shouldNoIndex = route.view !== 'upload';
    if (shouldNoIndex) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'robots';
        document.head.appendChild(meta);
      }
      meta.content = 'noindex, nofollow, noarchive';
    } else if (meta) {
      meta.remove();
    }
  }, [route.view]);

  const navigateTo = (path: string) => {
    if (window.location.pathname + window.location.search !== path) {
      window.history.pushState(null, '', path);
    }
    setRoute(parseLocationRoute());
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleNavigateHome = () => {
    setUploadSuccess(null);
    navigateTo('/');
  };

  const handleSignIn = async () => {
    setAuthError(null);
    setAccountNotice(null);
    setSigningIn(true);
    try {
      const user = await signInWithGooglePopup();
      if (!user.emailVerified) {
        setAuthError(
          'Your Google account email must be verified before opening private ZipLink workspaces.',
        );
      }
    } catch (err) {
      setAuthError(formatSignInError(err));
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    setAccountNotice(null);
    await signOutFromZipLink();
    setGithubStatus(null);
  };

  const handleDeleteAccountData = async () => {
    const uid = authUser?.uid;
    await deleteZipLinkAccountData();
    if (uid) {
      try {
        await deleteUserProfileDocument(uid);
      } catch {
        // Server data already wiped; best-effort cleanup on Firestore profile document
      }
    }
    await signOutFromZipLink();
    setGithubStatus(null);
    setAccountNotice('Your private ZipLink account data and GitHub connection have been deleted.');
  };

  const activeTopBarRoute: TopBarRoute =
    route.view === 'share'
      ? 'share'
      : route.view === 'delete'
        ? 'delete'
        : route.view === 'workspaces' || route.view === 'workspace-detail'
          ? 'workspaces'
          : route.view === 'zip-to-github'
            ? 'zip-to-github'
            : 'upload';

  const isPrivateRoute =
    route.view === 'workspaces' ||
    route.view === 'workspace-detail' ||
    route.view === 'zip-to-github';
  const hasVerifiedUser = Boolean(authUser && authUser.emailVerified);

  const privateSectionTitle =
    route.view === 'zip-to-github'
      ? 'Sign in with Google to stage a ZIP for GitHub'
      : 'Sign in with Google to open your private GitHub workspaces';

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        <TopBar
          activeRoute={activeTopBarRoute}
          authUser={hasVerifiedUser ? authUser : null}
          firebaseConfigured={isFirebaseClientConfigured && Boolean(auth)}
          signingIn={signingIn}
          githubStatus={githubStatus}
          onSignIn={() => void handleSignIn()}
          onSignOut={() => void handleSignOut()}
          onNavigate={navigateTo}
          onNavigateHome={handleNavigateHome}
        />

        <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
          {accountNotice && (
            <div
              aria-live="polite"
              className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950"
            >
              {accountNotice}
            </div>
          )}

          {route.view === 'upload' && !uploadSuccess && (
            <UploadWorkspace
              limits={limits}
              onUploadSuccess={(payload) => {
                setUploadSuccess(payload);
                window.scrollTo({ top: 0, behavior: 'auto' });
              }}
            />
          )}

          {route.view === 'upload' && uploadSuccess && (
            <UploadSuccess
              result={uploadSuccess}
              onOpenShare={(shareId) => navigateTo(`/s/${encodeURIComponent(shareId)}`)}
              onResetToUpload={handleNavigateHome}
            />
          )}

          {route.view === 'share' && (
            <ShareView shareId={route.shareId} onNavigateHome={handleNavigateHome} />
          )}

          {route.view === 'delete' && (
            <DeleteShareView
              shareId={route.shareId}
              initialToken={route.token}
              onNavigateHome={handleNavigateHome}
            />
          )}

          {isPrivateRoute && !hasVerifiedUser && (
            <FirebaseAuthGate
              firebaseConfigured={isFirebaseClientConfigured && Boolean(auth)}
              authLoading={authLoading}
              signingIn={signingIn}
              errorMsg={
                authUser && !authUser.emailVerified
                  ? 'Please verify your Google account email address to access private workspaces.'
                  : authError
              }
              sectionTitle={privateSectionTitle}
              onSignIn={() => void handleSignIn()}
              onNavigatePublicShare={handleNavigateHome}
            />
          )}

          {isPrivateRoute && hasVerifiedUser && authUser && (
            <div className="space-y-6">
              <AccountPanel
                user={authUser}
                onSignOut={handleSignOut}
                onDeleteAccountData={handleDeleteAccountData}
              />

              {route.view === 'workspaces' && (
                <WorkspacesHome
                  githubStatus={githubStatus}
                  statusLoading={githubLoading}
                  authEmail={authUser.email}
                  onRefreshStatus={refreshGitHubStatus}
                  onOpenWorkspace={(workspaceId) =>
                    navigateTo(`/workspaces/${encodeURIComponent(workspaceId)}`)
                  }
                  onNavigateZipToGitHub={() => navigateTo('/zip-to-github')}
                />
              )}

              {route.view === 'workspace-detail' && (
                <WorkspaceEditorView
                  workspaceId={route.workspaceId}
                  onBack={() => navigateTo('/workspaces')}
                />
              )}

              {route.view === 'zip-to-github' && (
                <ZipToGitHubView
                  limits={limits}
                  githubStatus={githubStatus}
                  statusLoading={githubLoading}
                  authEmail={authUser.email}
                  onRefreshStatus={refreshGitHubStatus}
                  onNavigateWorkspaces={() => navigateTo('/workspaces')}
                />
              )}
            </div>
          )}
        </main>

        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span>
              ZipLink · Unlisted archive sharing, deterministic context.md, &amp; per-user private
              GitHub workspaces
            </span>
            <span>
              {limits?.storageDriver === 'gcs'
                ? 'Storage: Google Cloud Storage + Firestore'
                : 'Storage: Isolated server storage'}
            </span>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
