import React from 'react';
import type { ThemePreference } from '../shared/types.ts';
import { ThemeSelector } from './ThemeSelector.tsx';

interface TopBarProps {
  activeRoute: 'upload' | 'share' | 'delete';
  onNavigateHome: () => void;
  themePreference: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeRoute,
  onNavigateHome,
  themePreference,
  onThemeChange,
}) => {
  const handleHomeClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onNavigateHome();
  };

  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:gap-8 sm:px-6">
        <a
          href="/"
          onClick={handleHomeClick}
          className="whitespace-nowrap shrink-0 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600"
        >
          ZipLink
        </a>

        <nav
          aria-label="Primary"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
        >
          <a
            href="/"
            onClick={handleHomeClick}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4 ${
              activeRoute === 'upload' ? 'text-slate-900 dark:text-white' : ''
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
            className="whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4"
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
            className="whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4"
          >
            Security &amp; limits
          </a>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <ThemeSelector value={themePreference} onChange={onThemeChange} />
          <button
            type="button"
            onClick={onNavigateHome}
            className="whitespace-nowrap shrink-0 rounded-lg bg-blue-700 px-3.5 py-2 text-xs sm:text-sm font-medium text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            New upload
          </button>
        </div>
      </div>
    </header>
  );
};
