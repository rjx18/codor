import { expect, test } from '@playwright/test';

import { BASE, ROOM, control, scan } from './a11y-shared.js';

// harn:assume web-theme-accessible-modes ref=axe-bridged-state
test('a bridged channel is axe-clean in both themes', async ({ browser }) => {
  // The bridge is daemon state, not context state, so enable it once for this spec's
  // daemon - before either theme - and it has never held a delivery, so no hold banner
  // sits under it. Each theme then scans in its own fresh context, so no light setter
  // survives into the dark scan; baseURL and viewport are explicit since a fresh context
  // inherits no fixture options.
  await control('/bridge-enable');
  const found: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript((t) => localStorage.setItem('codor-theme', t), theme);
    await page.goto(ROOM);
    await expect(page.getByTestId('bridged-room-banner')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const v of await scan(page)) found.push(`${theme}/room:bridged: ${v}`);
    await context.close();
  }
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-theme-accessible-modes
