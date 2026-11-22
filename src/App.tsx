import { useEffect, useState } from 'react';
import type { AppLimitsInfo, ThemePreference, UploadSuccessPayload } from './shared/types.ts';
import {
  applyThemeToDocument,
  getSavedThemePreference,
  saveThemePreference,
} from './utils/theme.ts';
import { TopBar } from './components/TopBar.tsx';
import { UploadWorkspace } from './components/UploadWorkspace.tsx';
import { UploadSuccess } from './components/UploadSuccess.tsx';
import { ShareView } from './components/ShareView.tsx';
import { DeleteShareView } from './components/DeleteShareView.tsx';
import { ModalDialog } from './components/ConfirmModal.tsx';

type RouteState =
  | { view: 'upload' }
  | { view: 'share'; shareId: string; editToken: string }
  | { view: 'delete'; shareId: string; token: string };

function extractEditTokenFromLocation(): string {
  const hash = window.location.hash || '';
  if (hash.startsWith('#')) {
    const hashParams = new URLSearchParams(hash.slice(1));
    const fromHash = hashParams.get('edit');
    if (fromHash) return fromHash;
  }
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('edit') ?? '';
}

function parseLocationRoute(): RouteState {
  const pathname = window.location.pathname;
  const shareMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})\/?$/);
  if (shareMatch) {
    return {
      view: 'share',
      shareId: shareMatch[1],
      editToken: extractEditTokenFromLocation(),
    };
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

  return { view: 'upload' };
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => parseLocationRoute());
  const [uploadSuccess, setUploadSuccess] = useState<UploadSuccessPayload | null>(null);
  const [limits, setLimits] = useState<AppLimitsInfo | null>(null);

  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    getSavedThemePreference(),
  );
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() =>
    applyThemeToDocument(getSavedThemePreference()),
  );
  const [shareDirty, setShareDirty] = useState(false);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);

  useEffect(() => {
    setEffectiveTheme(applyThemeToDocument(themePreference));
    saveThemePreference(themePreference);

    if (themePreference !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      setEffectiveTheme(applyThemeToDocument('system'));
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [themePreference]);

  useEffect(() => {
    const handleLocationChange = () => {
      setRoute(parseLocationRoute());
    };
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  useEffect(() => {
    fetch('/api/limits')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setLimits(data as AppLimitsInfo);
      })
      .catch(() => undefined);
  }, []);

  // Ensure share and delete pages declare noindex in DOM as well as HTTP X-Robots-Tag
  useEffect(() => {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (route.view === 'share' || route.view === 'delete') {
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
    if (window.location.pathname + window.location.search + window.location.hash !== path) {
      window.history.pushState(null, '', path);
    }
    setRoute(parseLocationRoute());
    setShareDirty(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const performNavigateHome = () => {
    setUploadSuccess(null);
    setLeavePromptOpen(false);
    navigateTo('/');
  };

  const handleNavigateHome = () => {
    if (route.view === 'share' && shareDirty) {
      setLeavePromptOpen(true);
      return;
    }
    performNavigateHome();
  };

  const activeTopBarRoute =
    route.view === 'share' ? 'share' : route.view === 'delete' ? 'delete' : 'upload';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <TopBar
        activeRoute={activeTopBarRoute}
        onNavigateHome={handleNavigateHome}
        themePreference={themePreference}
        onThemeChange={setThemePreference}
      />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
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
            onOpenShare={(shareId, editToken) => {
              const target = editToken
                ? `/s/${encodeURIComponent(shareId)}#edit=${encodeURIComponent(editToken)}`
                : `/s/${encodeURIComponent(shareId)}`;
              navigateTo(target);
            }}
            onResetToUpload={performNavigateHome}
          />
        )}

        {route.view === 'share' && (
          <ShareView
            shareId={route.shareId}
            initialEditToken={route.editToken}
            effectiveTheme={effectiveTheme}
            maxTextPreviewBytes={limits?.maxTextPreviewBytes}
            onNavigateHome={performNavigateHome}
            onDirtyChange={setShareDirty}
          />
        )}

        {route.view === 'delete' && (
          <DeleteShareView
            shareId={route.shareId}
            initialToken={route.token}
            onNavigateHome={performNavigateHome}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-xs text-slate-500 dark:text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>
            ZipLink · Unlisted, expiring archive sharing, code editor &amp; deterministic context.md
          </span>
          <span>
            {limits?.storageDriver === 'gcs'
              ? 'Storage: Google Cloud Storage + Firestore'
              : 'Storage: Isolated server storage'}
          </span>
        </div>
      </footer>

      <ModalDialog
        open={leavePromptOpen}
        title="Leave with unsaved changes?"
        onClose={() => setLeavePromptOpen(false)}
      >
        <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
          <p>
            You have unsaved edits in this workspace. If you navigate away now, those unsaved
            changes will be lost.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setLeavePromptOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Stay in editor
            </button>
            <button
              type="button"
              onClick={performNavigateHome}
              className="rounded-lg bg-amber-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-800"
            >
              Discard &amp; leave
            </button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
