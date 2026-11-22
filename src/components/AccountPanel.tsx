import React, { useState } from 'react';
import { LogOut, Trash2, UserCheck } from 'lucide-react';
import type { ZipLinkAuthUser } from '../shared/types.ts';

interface AccountPanelProps {
  user: ZipLinkAuthUser;
  onSignOut: () => Promise<void>;
  onDeleteAccountData: () => Promise<void>;
}

export const AccountPanel: React.FC<AccountPanelProps> = ({
  user,
  onSignOut,
  onDeleteAccountData,
}) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmWord, setConfirmWord] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConfirmDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmWord.trim() !== 'DELETE' || deleting) return;
    setDeleting(true);
    setErrorMsg(null);
    try {
      await onDeleteAccountData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to delete account data.');
      setDeleting(false);
    }
  };

  return (
    <section
      aria-label="Google account session and data controls"
      className="rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2.5 text-sm text-slate-700">
          <UserCheck className="h-4 w-4 text-blue-700 shrink-0" aria-hidden="true" />
          <span>
            Signed in as{' '}
            <strong className="font-semibold text-slate-900">
              {user.name || user.email || 'Google user'}
            </strong>
            {user.email && user.name ? (
              <span className="text-slate-500"> ({user.email})</span>
            ) : null}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-xs text-slate-600">
            Account data isolated by verified Google UID
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>

          <button
            type="button"
            onClick={() => setShowDeleteConfirm((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Delete account data
          </button>
        </div>
      </div>

      {showDeleteConfirm && (
        <form
          onSubmit={handleConfirmDelete}
          className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3 text-xs text-red-950"
        >
          <div className="font-semibold text-sm">
            Permanently delete your private ZipLink account data?
          </div>
          <p className="leading-relaxed">
            This permanently deletes all of your private GitHub workspaces, stored workspace file
            blobs, temporary ZIP-to-GitHub staged archives, encrypted server-side GitHub connection,
            and your Firestore profile document, then signs you out. Any public ZIP share links you
            created separately expire automatically or can be deleted immediately with their
            one-time delete token. To revoke GitHub App permissions on GitHub itself, also remove
            ZipLink in your GitHub Installations settings.
          </p>

          {errorMsg && (
            <div role="alert" className="rounded bg-white px-3 py-2 text-red-900 border border-red-300">
              {errorMsg}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <label htmlFor="confirm-account-delete" className="font-medium">
              Type <code className="font-mono font-bold">DELETE</code> to confirm:
            </label>
            <input
              id="confirm-account-delete"
              type="text"
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              placeholder="DELETE"
              className="w-32 rounded border border-red-300 bg-white px-2.5 py-1 font-mono text-xs text-slate-900"
            />
            <button
              type="submit"
              disabled={confirmWord.trim() !== 'DELETE' || deleting}
              className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800 disabled:bg-red-300"
            >
              {deleting ? 'Deleting data...' : 'Delete my ZipLink data'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDeleteConfirm(false);
                setConfirmWord('');
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
