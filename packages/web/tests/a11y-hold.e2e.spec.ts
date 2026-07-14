import { expect, test } from '@playwright/test';

import { ROOM, control, scan } from './a11y-shared.js';

test.use({ viewport: { width: 1440, height: 900 } });

// harn:assume web-glass-theme-accessible-modes ref=axe-hold-state
test('a held delivery is axe-clean in both themes', async ({ page }) => {
  // Own daemon: it has held nothing else and bridged nothing, so no other banner rides on top.
  const found: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    // A hold is consumed once seen, so each theme gets its own.
    await control('/hold', { body: '@alpha resume the pocket flow' });
    await page.addInitScript((t) => localStorage.setItem('codor-theme', t), theme);
    await page.goto(ROOM);
    await expect(page.getByTestId('hold-banner')).toBeVisible();
    for (const v of await scan(page)) found.push(`${theme}/room:hold: ${v}`);
  }
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-glass-theme-accessible-modes
