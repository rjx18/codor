import { expect, test } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

test.describe('offline shell', () => {
  test('after one visit the app shell serves without a network', async ({ page, context }) => {
    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    // Let the service worker install and precache.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'module' });
      await navigator.serviceWorker.ready;
      return registration.scope;
    });
    await page.waitForTimeout(800);

    await context.setOffline(true);
    await page.reload();
    // The shell paints from the cache; the socket can't connect, and the app
    // says so instead of white-screening.
    await expect(page.getByTestId('app')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('connection')).toHaveText(/Reconnecting/);
    await context.setOffline(false);
  });
});

test.describe('long rooms', () => {
  test('a 400-message back-catalog stays paged: bounded DOM, paging on scroll', async ({ page }) => {
    const seeded = await fetch(`${CONTROL}/seed-bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 400 }),
    });
    expect(seeded.ok).toBe(true);

    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('.nx-prose', { hasText: 'archive note #400' })).toBeVisible();

    // The store trims history to a page; the DOM must not hold 400 turns.
    const before = await page.locator('.nx-turn, .nx-system').count();
    expect(before).toBeLessThan(120);

    // Scrolling to the top pages one more window in with the scroll anchored.
    await page.getByTestId('timeline').evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(async () => page.locator('.nx-turn, .nx-system').count(), { timeout: 10_000 })
      .toBeGreaterThan(before);
  });
});

test.describe('accessibility', () => {
  test('the long room stays axe-clean', async ({ page }) => {
    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
