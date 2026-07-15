import { expect, test } from '@playwright/test';

import { sweepRoomStates } from './a11y-shared.js';

test.use({ viewport: { width: 1440, height: 900 } });

// harn:assume web-theme-accessible-modes ref=axe-room-matrix-dark
test('every read-only room, dialog, settings, ledger and pairing state is axe-clean in dark', async ({ page }) => {
  test.slow();
  // Its own daemon, so no light mutation from the light matrix is visible here.
  const found = await sweepRoomStates(page, 'dark');
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-theme-accessible-modes
