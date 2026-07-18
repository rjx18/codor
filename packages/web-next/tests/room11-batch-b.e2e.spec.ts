import { expect, test, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

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

test.describe('one-line tool rows', () => {
  test('expanded batch rows carry icons, tinted counts, and a done mark', async ({ page }) => {
    await openRoom(page);
    const batch = page.getByTestId('tool-batch');
    await revealOlder(page, batch);
    await batch.locator('.nx-batch-line').click();
    const rows = batch.locator('.nx-tool');
    await expect(rows).toHaveCount(2);

    // The shell row: terminal glyph, verbatim command, a done check — no card.
    const shell = rows.filter({ hasText: 'pnpm test --filter auth' });
    await expect(shell.locator('.nx-tool-icon')).toBeVisible();
    await expect(shell.locator('.nx-tool-mark svg')).toHaveAttribute('aria-label', 'done');
    await expect(shell).toHaveCSS('border-style', 'none');

    // The edit row: filename with the ± split into tinted add/del spans.
    const edit = rows.filter({ hasText: 'session.ts' });
    await expect(edit.locator('.nx-stat-add')).toHaveText('+2');
    await expect(edit.locator('.nx-stat-del')).toHaveText('−1');
    const addColor = await edit.locator('.nx-stat-add').evaluate((n) => getComputedStyle(n).color);
    const delColor = await edit.locator('.nx-stat-del').evaluate((n) => getComputedStyle(n).color);
    expect(addColor).not.toBe(delColor);

    // A diff row routes to the live Diff tab focused on its file, not the
    // inspector; eng's tree is clean, so it reports no current changes.
    await edit.click();
    await expect(page.getByTestId('diff-no-current')).toContainText('session.ts');
    await expect(page.getByTestId('run-inspector')).toHaveCount(0);
  });

  test('a single-tool batch renders the line directly with its status mark', async ({ page }) => {
    // One error-result tool inside a run that still completes → a direct row
    // (no "Ran 1 tool" wrapper) wearing ✕, without killing the agent.
    await enqueue([{
      kind: 'complete',
      final_text: 'the check failed',
      items: [
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'f1', tool: 'Bash', title: 'npm run typecheck', input: { command: 'npm run typecheck' } } },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'f1', status: 'error', output_text: 'tsc: 3 errors' } },
      ],
    }]);
    await openRoom(page);
    await postToFable(page, '@fable run the typecheck');
    const run = page.locator('[data-testid^="run-"]', { hasText: 'npm run typecheck' });
    // No batch wrapper around a lone tool.
    await expect(run.getByTestId('tool-batch')).toHaveCount(0);
    const row = run.locator('.nx-tool', { hasText: 'npm run typecheck' });
    await expect(row).toHaveClass(/is-error/);
    await expect(row.locator('.nx-tool-mark svg')).toHaveAttribute('aria-label', 'failed');
  });
});

test.describe('jump control', () => {
  test('arrow-only when merely scrolled up; counts only arrivals while unpinned', async ({ page }) => {
    await openRoom(page);
    const timeline = page.getByTestId('timeline');
    await timeline.evaluate((node) => { node.scrollTop = 0; });
    const jump = page.locator('.nx-jump');
    await expect(jump).toBeVisible();
    await expect(jump).toHaveClass(/is-arrow/);
    await expect(jump).toHaveAttribute('aria-label', 'Back to latest');
    await expect(jump).toHaveText(''); // icon only — nothing arrived yet

    // Messages arriving while unpinned turn it into a counter.
    await enqueue([{ kind: 'complete', final_text: 'noted — standing by' }]);
    await postToFable(page, '@fable acknowledge this while I read history');
    await expect(jump).toHaveText(/\d+ new message/);
    await expect(jump).not.toHaveClass(/is-arrow/);

    // Jumping re-glues and resets the count; the next unpin is an arrow again.
    await jump.click();
    await expect(jump).toBeHidden();
    await timeline.evaluate((node) => { node.scrollTop = 0; });
    await expect(jump).toHaveClass(/is-arrow/);
    await expect(jump).toHaveAttribute('aria-label', 'Back to latest');

    // Scrolling back down re-glues without the button too.
    await timeline.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(jump).toBeHidden();
  });
});

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
