import { expect, test } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

test('an incompatible browser is blocked before its room socket and refreshes into the current app', async ({ page }) => {
  let preflights = 0;
  let sockets = 0;
  page.on('websocket', () => { sockets += 1; });
  await page.route('**/api/client-compatibility?**', async (route) => {
    preflights += 1;
    if (preflights === 1) {
      await route.fulfill({
        status: 426,
        contentType: 'application/json',
        body: JSON.stringify({ browser_protocol: 1, minimum_browser_protocol: 2 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        browser_protocol: 1,
        minimum_browser_protocol: 0,
        compatible: true,
      }),
    });
  });

  await page.goto(ROOM);
  const gate = page.getByTestId('upgrade-required');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Codor has been updated');
  await expect(gate).toContainText('server requires 2');
  await expect(page.getByTestId('timeline')).toHaveCount(0);
  expect(sockets).toBe(0);

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`))
    .toEqual([]);

  await gate.getByRole('button', { name: 'Refresh Codor' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
  expect(preflights).toBeGreaterThanOrEqual(2);
  expect(sockets).toBeGreaterThan(0);
});
