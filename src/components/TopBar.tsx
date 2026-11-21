import React from 'react';

interface TopBarProps {
  activeRoute: 'upload' | 'share' | 'delete';
  onNavigateHome: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ activeRoute, onNavigateHome }) => {
  const handleHomeClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onNavigateHome();
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-4 sm:px-6">
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
              activeRoute === 'upload' ? 'text-slate-900' : ''
            }`}
          >
            Upload
          </a>
          <a
            href="/#how-it-works"
            onClick={(e) => {
              if (activeRoute !== 'upload') {
                e.preventDefault();
                onNavigateHome();
                setTimeout(() => {
                  document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
                }, 50);
              }
            }}
            className="whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4"
          >
            How it works
          </a>
          <a
            href="/#limits"
            onClick={(e) => {
              if (activeRoute !== 'upload') {
                e.preventDefault();
                onNavigateHome();
                setTimeout(() => {
                  document.getElementById('limits')?.scrollIntoView({ behavior: 'smooth' });
                }, 50);
              }
            }}
            className="whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 hover:underline underline-offset-4"
          >
            Security &amp; limits
          </a>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onNavigateHome}
            className="whitespace-nowrap shrink-0 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            New upload
          </button>
        </div>
      </div>
    </header>
  );
};
