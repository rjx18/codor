import { expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

async function enqueue(turns: unknown[]): Promise<void> {
  const response = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!response.ok) throw new Error(`enqueue failed: ${await response.text()}`);
}

// harn:assume web-waits-are-visible-across-live-surfaces-v5 ref=live-collaboration-browser-regression
// harn:assume posted-message-mentions-alone-look-effective ref=effective-mention-browser-regression
// harn:assume interim-posts-stay-flat-beside-their-live-run ref=interim-flat-browser-regression
test('live collaboration stays legible across waits, interim posts, themes, and widths', async ({ page, request }) => {
  const authorization = { authorization: 'Bearer e2e-token' };
  const spawned = await request.post('/api/rooms/eng/members', {
    headers: authorization,
    data: { harness: 'fake', handle: 'beta', cwd: process.cwd() },
  });
  expect(spawned.ok()).toBe(true);

  await enqueue([
    {
      kind: 'complete',
      final_text: 'Alpha completed after coordinating with beta.',
      steps: [
        { kind: 'interim_post', body: '@beta can you verify the live fixture?', awaiting_reply: true },
        { kind: 'wait', reason: 'reply', peers: ['beta'], duration_ms: 20_000 },
      ],
    },
    {
      kind: 'complete',
      final_text: '@alpha the fixture is verified.',
      items: [
        {
          type: 'run.item',
          item_type: 'text_delta',
          payload: { text: 'Checking @alpha in working prose stays inert.' },
        },
      ],
      delay_ms: 20_000,
    },
  ]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('codor-theme', 'system'));
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.getByTestId('composer-input').fill('@alpha coordinate with beta');
  await page.getByTestId('composer-send').click();

  const alphaRun = page.locator('[data-testid^="run-"][data-run-status]').filter({
    has: page.locator('.wr-run-identity strong', { hasText: '@alpha' }),
  });
  const betaRun = page.locator('[data-testid^="run-"][data-run-status]').filter({
    has: page.locator('.wr-run-identity strong', { hasText: '@beta' }),
  });
  const interim = page.locator('.wr-message').filter({ hasText: 'can you verify the live fixture?' });
  await expect(alphaRun).toHaveAttribute('data-run-status', 'running');
  await expect(betaRun).toHaveAttribute('data-run-status', 'running');
  await expect(interim).toBeVisible();
  await expect(alphaRun.locator('.wr-run-heading')).toHaveAttribute('data-live-state', 'waiting');
  await expect(alphaRun.locator('.wr-run-heading')).not.toHaveClass(/wr-shimmer/);
  await expect(betaRun.locator('.wr-run-heading')).toHaveAttribute('data-live-state', 'working');
  await expect(betaRun.locator('.wr-run-heading')).toHaveClass(/wr-shimmer/);

  expect(await interim.evaluate((node) => node.parentElement?.classList.contains('wr-timeline'))).toBe(true);
  await expect(interim.locator('.wr-effective-mention')).toHaveText('@beta');
  await expect(betaRun.locator('.wr-run-prose')).toContainText('Checking @alpha');
  await expect(betaRun.locator('.wr-run-prose .wr-effective-mention')).toHaveCount(0);

  const activity = page.getByTestId('live-activity');
  await expect(activity).toContainText('@alpha is waiting for @beta');
  await expect(activity).toContainText('@beta is working');
  const desktopMember = page.getByTestId('context-rail').getByTestId('member-alpha');
  await expect(desktopMember.getByTestId('member-alpha-waiting')).toContainText('waiting for @beta');
  const memberElapsed = desktopMember.getByTestId('member-alpha-wait-elapsed');
  await expect(memberElapsed).toHaveText(/^\d+s$/);
  await page.waitForTimeout(500);
  const firstElapsed = await memberElapsed.textContent();
  expect(firstElapsed).not.toBeNull();
  await page.waitForTimeout(1_200);
  expect(await memberElapsed.textContent()).not.toBe(firstElapsed);

  const themeColors: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toContain(theme);
    themeColors.push(await interim.locator('.wr-effective-mention').evaluate(
      (node) => getComputedStyle(node).color,
    ));
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(alphaRun).toBeVisible();
      await expect(interim).toBeVisible();
      await expect(activity).toBeVisible();
      const geometry = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const selectors = ['[data-testid="live-activity"]', '.wr-message', '[data-testid^="run-"][data-run-status]'];
        return {
          viewport,
          scrollWidth: document.documentElement.scrollWidth,
          boxes: selectors.map((selector) => {
            const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          }),
        };
      });
      expect(geometry.scrollWidth).toBe(geometry.viewport);
      for (const box of geometry.boxes) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(geometry.viewport + 1);
      }
    }
  }
  expect(themeColors[0]).not.toBe(themeColors[1]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open channel context' }).click();
  const context = page.getByRole('dialog', { name: 'Channel context' });
  await expect(context.getByTestId('member-alpha-waiting')).toContainText('waiting for @beta');
  expect(await context.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
// harn:end interim-posts-stay-flat-beside-their-live-run
// harn:end posted-message-mentions-alone-look-effective
// harn:end web-waits-are-visible-across-live-surfaces-v5
