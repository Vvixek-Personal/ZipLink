import type { ThemePreference } from '../shared/types.ts';

export const THEME_STORAGE_KEY = 'ziplink-theme';

export function getSavedThemePreference(): ThemePreference {
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') {
      return val;
    }
  } catch {
    // ignore storage access issues
  }
  return 'system';
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // ignore storage access issues
  }
}

export function resolveEffectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function applyThemeToDocument(pref: ThemePreference): 'light' | 'dark' {
  const effective = resolveEffectiveTheme(pref);
  if (typeof document !== 'undefined') {
    if (effective === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }
  return effective;
}
