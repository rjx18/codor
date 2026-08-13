import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  const connection = page.getByTestId('connection');
  // The compact mobile header intentionally omits the desktop connection pill;
  // the hydrated timeline is the shared readiness signal in that layout.
  if (await connection.count() > 0) {
    await expect(connection).toHaveClass(/is-live/, { timeout: 20_000 });
  }
}

// harn:assume scheduled-cards-are-accessible-authoritative-and-nonduplicating ref=scheduled-card-browser-regression
test.describe('scheduled-message browser journey', () => {
  test('creates, reloads, cancels, and retains one pending card with a 44px target', async ({ page }) => {
    await openRoom(page);
    const marker = `cancel-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1h] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Pending');
    const cancel = card.getByRole('button', { name: /cancel scheduled message/i });
    const box = await cancel.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await cancel.click();
    await expect(card).toContainText('Cancelled', { timeout: 20_000 });
    await page.reload();
    await expect(page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker })).toContainText('Cancelled');
  });

  test('renders a local offset clock and reconciles a due schedule into one ordinary message', async ({ page }) => {
    await openRoom(page);
    const marker = `due-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1s] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('.nx-schedule-card-time')).toContainText(/\d/);
    await expect(page.locator('.nx-prose', { hasText: marker })).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveCount(0);
    await expect(page.locator('.nx-prose', { hasText: marker })).toHaveCount(1);
  });

  test('passes Axe on the compact schedule surface in a 390px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    const marker = `a11y-${Date.now()}`;
    await input.fill(`[send_in=1h] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    const report = await new AxeBuilder({ page }).include('[data-testid^="schedule-card-"]').analyze();
    expect(report.violations).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);
  });
});
// harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
