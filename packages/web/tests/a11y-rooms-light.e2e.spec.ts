import { expect, test } from '@playwright/test';

import { sweepRoomStates } from './a11y-shared.js';

test.use({ viewport: { width: 1440, height: 900 } });

// harn:assume web-theme-accessible-modes ref=axe-room-matrix-light
test('every read-only room, dialog, settings, ledger and pairing state is axe-clean in light', async ({ page }) => {
  test.slow();
  const found = await sweepRoomStates(page, 'light');
  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-theme-accessible-modes
