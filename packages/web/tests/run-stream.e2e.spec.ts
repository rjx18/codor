import { expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

async function control(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
}

async function postToAlpha(page: import('@playwright/test').Page, body: string) {
  await page.getByTestId('composer-input').fill(`@alpha ${body}`);
  await page.getByTestId('composer-send').click();
  return page.locator('[data-testid^="run-"][data-run-status]').last();
}

// harn:assume normalized-run-items-presented-live ref=live-run-stream-regression
test('normalized rows stream in order, elapsed time ticks, and completion collapses', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await control('/enqueue', {
    turns: [{
      kind: 'complete',
      delay_ms: 2600,
      final_text: 'Done - timeline rows are live and the suite passes.',
      usage: { input_tokens: 80, output_tokens: 20, cost_usd: 0.04 },
      items: [
        { type: 'run.item', item_type: 'text_delta', payload: { text: "I'll run the tests first." } },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'bash-1', tool: 'Bash', title: 'pnpm test --filter web' },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: { call_id: 'bash-1', status: 'ok', output_text: 'passed', duration_ms: 2100 },
        },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'edit-1', tool: 'Edit', title: 'packages/web/src/App.tsx' },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: {
            call_id: 'edit-1', status: 'ok', duration_ms: 150,
            diff: { path: 'packages/web/src/App.tsx', unified: '--- a/App.tsx\n+++ b/App.tsx\n-old\n+new\n' },
          },
        },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'bash-2', tool: 'Bash', title: 'pnpm test:all' },
        },
      ],
    }],
  });

  const run = await postToAlpha(page, 'show the live stream');
  await expect(run).toHaveAttribute('data-run-status', 'running');
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');
  await expect(page.getByTestId(`run-${runId}-toggle`)).toHaveAttribute('aria-expanded', 'true');
  const rows = run.locator('[data-run-row]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("I'll run the tests first.");
  await expect(rows.nth(1)).toContainText('Bashpnpm test --filter web');
  await expect(rows.nth(2)).toContainText('Editpackages/web/src/App.tsx');
  await expect(rows.nth(3)).toContainText('Bashpnpm test:allrunning');

  const elapsed = run.getByTestId('run-elapsed');
  const firstElapsed = await elapsed.textContent();
  await expect.poll(() => elapsed.textContent(), { timeout: 2200 }).not.toBe(firstElapsed);
  await expect(page.getByTestId(`run-${runId}-events`)).toBeVisible();
  expect((await page.content()).toLowerCase()).not.toContain('run started');

  await expect(run).toHaveAttribute('data-run-status', 'completed', { timeout: 5000 });
  await expect(page.getByTestId(`run-${runId}-toggle`)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`run-${runId}-events`)).toHaveCount(0);
  await expect(page.getByTestId(`run-${runId}-body`)).toHaveText(
    'Done - timeline rows are live and the suite passes.',
  );
  await expect(page.getByTestId(`run-${runId}-status`)).toContainText(/3 tools\s*·\s*\$0\.04/);

  await page.getByTestId(`run-${runId}-toggle`).click();
  for (const theme of ['dark', 'light']) {
    await page.locator('html').evaluate((element, value) => {
      element.dataset.theme = value;
    }, theme);
    for (const width of [390, 768, 1024, 1300, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(run).toBeVisible();
      const fit = await run.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const childrenFit = [...element.querySelectorAll<HTMLElement>('[data-run-row]')]
          .every((row) => row.scrollWidth <= row.clientWidth + 1);
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          runLeft: rect.left,
          runRight: rect.right,
          childrenFit,
        };
      });
      expect(fit.pageWidth).toBe(fit.viewportWidth);
      expect(fit.runLeft).toBeGreaterThanOrEqual(0);
      expect(fit.runRight).toBeLessThanOrEqual(width + 1);
      expect(fit.childrenFit).toBe(true);
    }
  }
});
// harn:end normalized-run-items-presented-live

// harn:assume live-run-event-cache-bounded ref=bounded-run-stream-regression
test('a 600-event run exposes and recovers its dropped live prefix', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const items = Array.from({ length: 600 }, (_, index) => ({
    type: 'run.item',
    item_type: 'file_change',
    payload: { path: `src/generated-${String(index).padStart(3, '0')}.ts`, change: 'modified' },
  }));
  await control('/enqueue', {
    turns: [{ kind: 'complete', final_text: 'large sequence complete', items, item_delay_ms: 1 }],
  });

  const run = await postToAlpha(page, 'render the large sequence');
  await expect(run).toHaveAttribute('data-run-status', 'running');
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');
  const toggle = page.getByTestId(`run-${runId}-toggle`);
  await expect(run).toHaveAttribute('data-run-status', 'completed', { timeout: 15_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const events = page.getByTestId(`run-${runId}-events`);
  const earlier = page.getByTestId(`run-${runId}-earlier`);
  await expect(earlier).toContainText('101 earlier events');
  expect(Number(await events.getAttribute('data-event-count'))).toBeLessThan(602);
  await earlier.click();
  await expect(events).toHaveAttribute('data-event-count', '602');
  await expect(events.locator('[data-run-row]')).toHaveCount(600);
  await expect(earlier).toHaveCount(0);
});
// harn:end live-run-event-cache-bounded
