import React, { useState } from 'react';
import { CheckCircle2, Trash2, AlertTriangle } from 'lucide-react';

interface DeleteShareViewProps {
  shareId: string;
  initialToken: string;
  onNavigateHome: () => void;
}

export const DeleteShareView: React.FC<DeleteShareViewProps> = ({
  shareId,
  initialToken,
  onNavigateHome,
}) => {
  const [token, setToken] = useState(initialToken);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || isDeleting) return;
    setIsDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}`, {
        method: 'DELETE',
        headers: {
          'X-Delete-Token': token.trim(),
        },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || `Delete failed (${res.status}).`);
      }
      setDeleted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete share.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (deleted) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-8 space-y-4">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-700 shrink-0" aria-hidden="true" />
          <h1 className="text-xl font-bold text-slate-900">Share deleted</h1>
        </div>
        <p className="text-sm text-slate-600">
          All files and generated outputs for share <code className="font-mono text-xs">{shareId}</code>{' '}
          have been permanently removed.
        </p>
        <button
          type="button"
          onClick={onNavigateHome}
          className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          Back to upload
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleDelete(e)}
      className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-8 space-y-5"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-6 w-6 text-red-700 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-xl font-bold text-slate-900">Delete shared archive</h1>
          <p className="text-sm text-slate-600">
            This immediately and permanently deletes all extracted files,{' '}
            <code className="font-mono text-xs">context.md</code>, and{' '}
            <code className="font-mono text-xs">manifest.json</code> for share{' '}
            <code className="font-mono text-xs">{shareId}</code>.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="delete-token-input" className="block text-xs font-semibold text-slate-700">
          Delete token
        </label>
        <input
          id="delete-token-input"
          type="text"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your one-time delete token"
          className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-700 focus:bg-white focus:outline-none"
        />
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isDeleting || !token.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          <span>{isDeleting ? 'Deleting...' : 'Permanently delete share'}</span>
        </button>
        <button
          type="button"
          onClick={onNavigateHome}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
