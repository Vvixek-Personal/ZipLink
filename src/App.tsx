import { useEffect, useState } from 'react';
import type { AppLimitsInfo, UploadSuccessPayload } from './shared/types.ts';
import { TopBar } from './components/TopBar.tsx';
import { UploadWorkspace } from './components/UploadWorkspace.tsx';
import { UploadSuccess } from './components/UploadSuccess.tsx';
import { ShareView } from './components/ShareView.tsx';
import { DeleteShareView } from './components/DeleteShareView.tsx';

type RouteState =
  | { view: 'upload' }
  | { view: 'share'; shareId: string }
  | { view: 'delete'; shareId: string; token: string };

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

  return { view: 'upload' };
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => parseLocationRoute());
  const [uploadSuccess, setUploadSuccess] = useState<UploadSuccessPayload | null>(null);
  const [limits, setLimits] = useState<AppLimitsInfo | null>(null);

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

  const activeTopBarRoute =
    route.view === 'share' ? 'share' : route.view === 'delete' ? 'delete' : 'upload';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar activeRoute={activeTopBarRoute} onNavigateHome={handleNavigateHome} />

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
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
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>
            ZipLink · Unlisted, expiring archive sharing &amp; deterministic context.md conversion
          </span>
          <span>
            {limits?.storageDriver === 'gcs'
              ? 'Storage: Google Cloud Storage + Firestore'
              : 'Storage: Isolated server storage'}
          </span>
        </div>
      </footer>
    </div>
  );
}
