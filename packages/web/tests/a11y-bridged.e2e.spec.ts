import { expect, test } from '@playwright/test';

import { ROOM, control, scan } from './a11y-shared.js';

test.use({ viewport: { width: 1440, height: 900 } });

// harn:assume web-glass-theme-accessible-modes ref=axe-bridged-state
test('a bridged channel is axe-clean in both themes', async ({ page }) => {
  // Own daemon: it has never held a delivery, so the sticky bridge banner cannot sit on
  // leftover hold state.
  await control('/bridge-enable');
  const found: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((t) => localStorage.setItem('codor-theme', t), theme);
    await page.goto(ROOM);
    await expect(page.getByTestId('bridged-room-banner')).toBeVisible();
    for (const v of await scan(page)) found.push(`${theme}/room:bridged: ${v}`);
  }
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-glass-theme-accessible-modes
