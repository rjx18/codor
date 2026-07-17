import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function postToFable(page: Page, body: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await expect(input).toHaveValue(/@\w+ /); // hydrated — safe to type over
  await input.fill(body);
  await input.press('Enter');
}

test.describe('sticky typing indicator', () => {
  test('one indicator survives scroll and leaves rooms where nobody works', async ({ page }) => {
    await openRoom(page);
    // scout's seeded run never settles, so the indicator names @scout.
    const indicator = page.getByTestId('live-activity');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveCount(1);
    await expect(indicator.locator('.nx-chip')).toBeVisible();
    await expect(page.locator('[aria-label="@scout is working"]')).toBeVisible();
    // The old in-column working row is gone.
    await expect(page.locator('.nx-working-row')).toHaveCount(0);
    // Sticky: still on screen with the transcript scrolled to the top.
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop = 0; });
    await expect(indicator).toBeInViewport();
    // A room with nobody working shows none (its dormant dead agent must not count).
    await page.getByTestId('room-link-design').click();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('live-activity')).toHaveCount(0);
  });
});

test.describe('usage gauges', () => {
  test('live run.limits updates re-tint the gauge and the pill fallback returns', async ({ page }) => {
    await openRoom(page);
    const limits = page.getByTestId('member-fable-limits');
    await expect(limits.locator('.nx-gauge.is-warn')).toContainText('18% left'); // seeded

    // The harness reports a nearly exhausted 5h window → error tint, 8% left.
    await enqueue([{
      kind: 'complete',
      final_text: 'usage numbers refreshed',
      items: [{
        type: 'run.limits',
        limits: [
          { window: 'five_hour', status: 'allowed_warning', used_percent: 92 },
          { window: 'weekly', status: 'allowed_warning', used_percent: 82 },
          { window: 'monthly', status: 'allowed', used_percent: 20 },
        ],
      }],
    }]);
    await postToFable(page, '@fable refresh your usage numbers');
    const error = limits.locator('.nx-gauge.is-error');
    await expect(error).toContainText('5h');
    await expect(error).toContainText('8% left');
    await expect(error.locator('.nx-gauge-fill')).toHaveAttribute('style', /width: 8%/);

    // Restore the seed shape (later specs pin it): pill 5h, warn weekly, ok monthly.
    await enqueue([{
      kind: 'complete',
      final_text: 'usage numbers restored',
      items: [{
        type: 'run.limits',
        limits: [
          { window: 'five_hour', status: 'allowed', resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
          { window: 'weekly', status: 'allowed_warning', used_percent: 82 },
          { window: 'monthly', status: 'allowed', used_percent: 20 },
        ],
      }],
    }]);
    await postToFable(page, '@fable and back to normal');
    await expect(limits.locator('.nx-limit')).toContainText('5h: allowed · resets');
    await expect(limits.locator('.nx-gauge.is-error')).toHaveCount(0);
    await expect(limits.locator('.nx-gauge.is-ok')).toContainText('80% left');
  });
});
