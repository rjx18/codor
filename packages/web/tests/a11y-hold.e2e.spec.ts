import { expect, test } from '@playwright/test';

import { BASE, ROOM, control, scan } from './a11y-shared.js';

// harn:assume web-theme-accessible-modes ref=axe-hold-state
test('a held delivery is axe-clean in both themes', async ({ browser }) => {
  // Own daemon: it has held nothing else and bridged nothing, so no other banner rides
  // on top. Each theme runs in its OWN fresh context, so no theme's storage setter
  // survives into the next; a fresh context inherits no fixture options, so baseURL and
  // the viewport are explicit.
  const found: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    // The hold is daemon-side and consumed once seen, so recreate it per theme.
    await control('/hold', { body: '@alpha resume the pocket flow' });
    const context = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.addInitScript((t) => localStorage.setItem('codor-theme', t), theme);
    await page.goto(ROOM);
    await expect(page.getByTestId('hold-banner')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const v of await scan(page)) found.push(`${theme}/room:hold: ${v}`);
    await context.close();
  }
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-theme-accessible-modes
