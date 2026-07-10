export type ThemeChoice = 'system' | 'dark' | 'light';

export const THEME_STORAGE_KEY = 'wireroom-theme';

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === 'system' || value === 'dark' || value === 'light';
}

// harn:assume web-theme-choice-stays-local ref=local-theme-preference
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemeChoice(choice: ThemeChoice = readThemeChoice()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function storeThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The visual choice still applies for this tab when storage is unavailable.
  }
  applyThemeChoice(choice);
}
// harn:end web-theme-choice-stays-local
