import React from 'react';
import { GitBranch, Lock, ShieldCheck } from 'lucide-react';

interface FirebaseAuthGateProps {
  firebaseConfigured: boolean;
  authLoading: boolean;
  signingIn: boolean;
  errorMsg: string | null;
  sectionTitle: string;
  onSignIn: () => void;
  onNavigatePublicShare: () => void;
}

export const FirebaseAuthGate: React.FC<FirebaseAuthGateProps> = ({
  firebaseConfigured,
  authLoading,
  signingIn,
  errorMsg,
  sectionTitle,
  onSignIn,
  onNavigatePublicShare,
}) => {
  if (authLoading) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
        Checking Google sign-in session...
      </div>
    );
  }

  if (!firebaseConfigured) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-amber-300 bg-white p-6 space-y-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          Firebase Authentication setup required
        </h1>
        <p className="text-sm leading-relaxed text-slate-600">
          Private workspaces and GitHub connections require real Google sign-in via Firebase
          Authentication so every user&apos;s data stays strictly isolated. Public unlisted ZIP
          sharing remains available on the home page.
        </p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700 space-y-1.5">
          <div className="font-semibold text-slate-900">What the deployment owner must check</div>
          <p>
            Ensure <code className="font-mono">firebase-applet-config.json</code> is present with a
            real Firebase project ID and Google sign-in provider enabled in Firebase Auth, and add
            your deployment hostnames to Firebase Authorized Domains.
          </p>
        </div>
        <button
          type="button"
          onClick={onNavigatePublicShare}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          Back to Share ZIP
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-700">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Private ZipLink Account Required
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{sectionTitle}</h1>
        <p className="text-sm leading-relaxed text-slate-600">
          Sign in with your Google account to open your isolated ZipLink workspace. Your server-side
          ID token is verified on every private request so no other user can view, edit, delete, or
          push your workspaces or staged ZIPs.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 text-xs">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 font-semibold text-slate-900">
            <ShieldCheck className="h-4 w-4 text-emerald-700" aria-hidden="true" />
            Google Sign-In = Your Account
          </div>
          <p className="leading-relaxed text-slate-600">
            Creates a private workspace silo tied to your verified Google account. Does not grant
            GitHub access on its own.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 font-semibold text-slate-900">
            <GitBranch className="h-4 w-4 text-blue-700" aria-hidden="true" />
            GitHub = Separate Authorization
          </div>
          <p className="leading-relaxed text-slate-600">
            After signing in, authorize GitHub separately and choose only the specific repositories
            you want ZipLink to access.
          </p>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {errorMsg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          disabled={signingIn}
          onClick={onSignIn}
          className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:bg-slate-300 disabled:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          {signingIn ? 'Opening Google Sign-In...' : 'Sign in with Google'}
        </button>

        <button
          type="button"
          onClick={onNavigatePublicShare}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Use public Share ZIP instead
        </button>
      </div>

      <p className="text-xs text-slate-500 border-t border-slate-100 pt-4">
        Note: Public share links (<code className="font-mono">/s/:shareId</code>) are intentionally
        separate from private workspaces and can be opened by anyone who has the share URL.
      </p>
    </div>
  );
};
