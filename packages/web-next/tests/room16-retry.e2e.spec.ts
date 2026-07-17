import { expect, test, type Page } from '@playwright/test';

// The recovery room carries a real failed run (bound delivery intact) so retry
// has something to act on, isolated from eng. 'recovery' owner vs a room-scoped
// member let the owner/admin gate be proven here.
const RECOVERY = '/?room=recovery&token=next-e2e-token';
const RECOVERY_MEMBER = '/?room=recovery&token=next-e2e-recovery-viewer-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('run retry', () => {
  test('an owner retries a failed run into a fresh live run', async ({ page }) => {
    await openRoom(page, RECOVERY);
    const run = page.locator('article[data-testid^="run-"]').first();
    await expect(run).toBeVisible();
    const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');

    await enqueue([{ kind: 'complete', final_text: 'deploy recovered' }]);
    await run.hover();
    await page.getByTestId(`run-${runId}-retry`).click();

    // A fresh run runs the re-delivered instruction; the failed row still stands.
    await expect(page.locator('.nx-prose', { hasText: 'deploy recovered' })).toBeVisible();
    await expect(page.getByTestId(`run-${runId}`)).toBeVisible();
  });

  test('a non-privileged member sees no Retry action', async ({ page }) => {
    await openRoom(page, RECOVERY_MEMBER);
    await expect(page.locator('article[data-testid^="run-"]').first()).toBeVisible(); // runs are readable
    await expect(page.locator('[data-testid$="-retry"]')).toHaveCount(0);
  });

  test('a failed run with its Retry action is axe-clean', async ({ page }) => {
    await openRoom(page, RECOVERY);
    await expect(page.locator('[data-testid$="-retry"]').first()).toBeVisible();
    await page.waitForTimeout(300);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
