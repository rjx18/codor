import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const VIEWER_ROOM = '/?room=eng&token=next-e2e-viewer-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page, url = ROOM): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

// A fail-on-interrupt turn keeps @fable running (Working) until interrupted, at
// which point the run finalizes Interrupted — exactly the stop path, in the fake.
async function startFableWorking(page: Page): Promise<void> {
  await enqueue([{ kind: 'fail-on-interrupt' }]);
  const input = page.getByTestId('composer-input');
  await expect(input).toHaveValue(/@\w+ /);
  await input.fill('@fable keep working until I stop you');
  await input.press('Enter');
  await expect(page.getByTestId('member-fable')).toContainText('Working');
}

test.describe('agent stop control', () => {
  test('owner stops a working agent from its card; the run ends Interrupted', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('member-hydrate-stop')).toHaveCount(0); // idle → no stop

    await startFableWorking(page);
    const stop = page.getByTestId('member-fable-stop');
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(page.getByTestId('member-fable')).toContainText('Idle');
    await expect(page.getByTestId('member-fable-stop')).toHaveCount(0);
    await expect(page.locator('[data-run-status="interrupted"]')).toHaveCount(1);
  });

  test('the sticky typing chip carries a stop that interrupts its agent', async ({ page }) => {
    await openRoom(page);
    await startFableWorking(page);
    // fable's is the most-recently-started run, so the chip names fable.
    await expect(page.locator('[aria-label="@fable is working"]')).toBeVisible();
    const chipStop = page.getByTestId('typing-stop-fable');
    await expect(chipStop).toBeVisible();
    await chipStop.click();
    // fable left the chip; it falls back to the still-running scout.
    await expect(page.locator('[aria-label="@fable is working"]')).toHaveCount(0);
    await expect(page.getByTestId('member-fable')).toContainText('Idle');
  });

  test('a non-privileged member sees no stop controls', async ({ page }) => {
    await openRoom(page, VIEWER_ROOM);
    await expect(page.getByTestId('live-activity')).toBeVisible(); // scout is working
    await expect(page.locator('[data-testid$="-stop"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="typing-stop-"]')).toHaveCount(0);
  });

  test('the working state with stop controls is axe-clean', async ({ page }) => {
    await openRoom(page);
    await startFableWorking(page);
    await expect(page.getByTestId('member-fable-stop')).toBeVisible();
    await page.waitForTimeout(300);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.getByTestId('member-fable-stop').click(); // finalize so later specs see fable idle
    await expect(page.getByTestId('member-fable')).toContainText('Idle');
  });
});
