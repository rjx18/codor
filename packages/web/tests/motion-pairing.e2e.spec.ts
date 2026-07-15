import { expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return (await response.json()) as T;
}

// harn:assume web-motion-is-purposeful-and-reduced-motion-safe-v5 ref=motion-browser-regression
test('running shimmer finalizes and reduced motion becomes a static accent', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await control('/enqueue', {
    turns: [{
      kind: 'complete',
      final_text: 'motion complete',
      item_delay_ms: 250,
      delay_ms: 500,
      items: [
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'motion-1', tool: 'Bash', title: 'pnpm test' } },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'motion-1', status: 'ok', output_text: 'ok' } },
      ],
    }],
  });
  await page.getByTestId('composer-input').fill('@alpha verify motion');
  await page.getByTestId('composer-send').click();
  const run = page.locator('[data-run-status="running"]').last();
  await expect(run).toBeVisible();
  const runTestId = await run.getAttribute('data-testid');
  if (!runTestId) throw new Error('running message has no test id');
  const stableRun = page.getByTestId(runTestId);
  const heading = run.locator('.wr-run-heading.wr-shimmer');
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => getComputedStyle(element, '::after').animationName))
    .toBe('wr-shimmer-wave');
  expect(await run.getByTestId(/run-\d+-status/).evaluate((element) => getComputedStyle(element).gap))
    .toBe('4px');
  await expect(stableRun).toHaveAttribute('data-run-status', 'completed');
  await expect(stableRun.locator('.wr-run-heading.wr-shimmer')).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await control('/enqueue', {
    turns: [{ kind: 'complete', final_text: 'reduced complete', delay_ms: 400 }],
  });
  await page.getByTestId('composer-input').fill('@alpha verify reduced motion');
  await page.getByTestId('composer-send').click();
  const reducedRun = page.locator('[data-run-status="running"]').last();
  const reducedRunTestId = await reducedRun.getAttribute('data-testid');
  if (!reducedRunTestId) throw new Error('reduced-motion message has no test id');
  const stableReducedRun = page.getByTestId(reducedRunTestId);
  const reducedHeading = reducedRun.locator('.wr-run-heading.wr-shimmer');
  await expect(reducedHeading).toBeVisible();
  expect(await reducedHeading.evaluate((element) => ({
    animation: getComputedStyle(element, '::after').animationName,
    accent: getComputedStyle(element).boxShadow,
  }))).toMatchObject({ animation: 'none', accent: expect.stringContaining('inset') });
  await expect(stableReducedRun).toHaveAttribute('data-run-status', 'completed');

  await control('/enqueue', { turns: [{ kind: 'complete', final_text: '<ACK_OK>' }] });
  await page.getByTestId('composer-input').fill('@alpha status noted');
  await page.getByTestId('composer-send').click();
  const ack = page.getByTestId('ack-alpha');
  await expect(ack).toHaveText(/@alpha acknowledged/);
  await expect(ack.locator('[data-testid$="-toggle"]')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
// harn:end web-motion-is-purposeful-and-reduced-motion-safe-v5

// harn:assume unpaired-browser-always-has-enrollment-path ref=pairing-gate-browser-regression
test('an unpaired app visit offers trusted progress and a manual pairing-link path', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pairingRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.route('**/api/pairing/**', async (route) => {
    pairingRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trusted_enrollment: false }),
    });
  });
  await page.goto('/?room=eng');
  await expect(page.getByTestId('trusted-pairing-progress')).toBeVisible();
  const manual = page.getByTestId('manual-pairing');
  await expect(manual).toBeVisible();
  await expect(manual).toContainText('codor pair');
  await expect(page.getByTestId('pairing-code').locator('input')).toHaveCount(8);
  await expect(page.getByTestId('pairing-code-0')).toBeFocused();
  await expect(page.getByTestId('pairing-link')).toHaveAttribute('type', 'password');

  const offer = await control<{ url: string }>('/pair-offer');
  await page.getByTestId('pairing-link').fill(offer.url);
  await page.getByRole('button', { name: 'Open pairing link' }).click();
  await page.waitForURL('**/pair?**');
  await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeVisible();
  expect(pairingRequests).toEqual(['GET /api/pairing/status']);
  expect(consoleErrors).toEqual([]);
});
// harn:end unpaired-browser-always-has-enrollment-path
