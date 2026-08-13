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

  test('keeps explicit same-instant schedules in deterministic creation order with a named zone', async ({ page }) => {
    await openRoom(page);
    const due = new Date(Date.now() + 60 * 60_000).toISOString();
    const first = `same-instant-first-${Date.now()}`;
    const second = `same-instant-second-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    for (const marker of [first, second]) {
      await input.fill(`[send_at=${due}] @fable ${marker}`);
      await page.getByTestId('composer-send').click();
      await expect(page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker })).toBeVisible({ timeout: 20_000 });
    }
    const previews = await page.locator('.nx-schedule-card-preview').allTextContents();
    expect(previews.findIndex((text) => text.includes(first))).toBeLessThan(
      previews.findIndex((text) => text.includes(second)),
    );
    await expect(page.locator('[data-testid^="schedule-card-"]').filter({ hasText: first }).locator('.nx-schedule-card-time'))
      .toContainText(/GMT|UTC/);
  });

  test('retains a card across disconnect and reconnect, then cancels once live', async ({ page }) => {
    await openRoom(page);
    const marker = `reconnect-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1h] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (window as unknown as { __codor: { disconnect(): void } }).__codor.disconnect());
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /cancel scheduled message/i })).toBeDisabled();
    await page.evaluate(() => (window as unknown as { __codor: { reconnect(): void } }).__codor.reconnect());
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(card.getByRole('button', { name: /cancel scheduled message/i })).toBeEnabled({ timeout: 20_000 });
    await card.getByRole('button', { name: /cancel scheduled message/i }).click();
    await expect(card).toContainText('Cancelled', { timeout: 20_000 });
  });

  test('cancels from the focused target by keyboard without optimistic removal', async ({ page }) => {
    await openRoom(page);
    const marker = `keyboard-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1h] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    const cancel = card.getByRole('button', { name: /cancel scheduled message/i });
    await cancel.focus();
    await cancel.press('Enter');
    await expect(card).toContainText('Cancelled', { timeout: 20_000 });
    expect(await page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker }).count()).toBe(1);
  });

  test('allows one winner when cancellation meets the due claim', async ({ page }) => {
    await openRoom(page);
    const marker = `race-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1s] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    const card = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(850);
    const cancel = card.getByRole('button', { name: /cancel scheduled message/i });
    if (await cancel.isEnabled()) await cancel.click();
    await expect.poll(async () => {
      const cardText = await card.textContent();
      const delivered = await page.locator('.nx-prose', { hasText: marker }).count();
      return cardText?.includes('Cancelled') ? 'cancelled'
        : delivered === 1 && (await card.count()) === 0 ? 'delivered' : 'pending';
    }, { timeout: 20_000 }).toMatch(/cancelled|delivered/);
    expect(await page.locator('.nx-prose', { hasText: marker }).count()).toBeLessThanOrEqual(1);
  });

  test('passes full scheduled-surface Axe in explicit light and dark themes', async ({ page }) => {
    await openRoom(page);
    const marker = `themes-${Date.now()}`;
    const input = page.getByTestId('composer-input');
    await input.fill(`[send_in=1h] @fable ${marker}`);
    await page.getByTestId('composer-send').click();
    await expect(page.locator('[data-testid^="schedule-card-"]').filter({ hasText: marker })).toBeVisible({ timeout: 20_000 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((choice) => { document.documentElement.dataset.theme = choice; }, theme);
      const report = await new AxeBuilder({ page }).include('[data-testid="timeline"]').analyze();
      expect(report.violations, `${theme} theme`).toEqual([]);
    }
  });
});
// harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
