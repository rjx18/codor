export type ThemeChoice = 'system' | 'dark' | 'light';

export const THEME_STORAGE_KEY = 'codor-theme';

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === 'system' || value === 'dark' || value === 'light';
}

// harn:assume web-theme-choice-stays-local ref=local-theme-preference
// harn:assume web-first-run-color-mode-is-dark ref=dark-first-theme-choice
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemeChoice(choice: ThemeChoice = readThemeChoice()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function storeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The visual choice still applies for this tab when storage is unavailable.
  }
  applyThemeChoice(choice);
}
// harn:end web-first-run-color-mode-is-dark
// harn:end web-theme-choice-stays-local
