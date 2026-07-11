import { expect, test } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:8138';

async function enqueue(turn: unknown): Promise<void> {
  const response = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns: [turn] }),
  });
  if (!response.ok) throw new Error(`enqueue failed: ${await response.text()}`);
}

// harn:assume normalized-run-evidence-inspector ref=inspector-browser-regression
test('selected output, diff, and image evidence use the sheet and rail at one breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const output = Array.from({ length: 100 }, (_, index) => `line ${String(index + 1).padStart(3, '0')}: browser evidence`).join('\n');
  await enqueue({
    kind: 'complete',
    final_text: 'inspector fixtures ready',
    items: [
      {
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'bash-100', tool: 'Bash', title: 'print 100 lines' },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: 'bash-100', status: 'ok', output_text: output, duration_ms: 120 },
      },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'edit-diff', tool: 'Edit', title: 'packages/web/src/App.tsx' },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: {
          call_id: 'edit-diff', status: 'ok',
          diff: {
            path: 'packages/web/src/App.tsx',
            unified: '--- a/packages/web/src/App.tsx\n+++ b/packages/web/src/App.tsx\n@@ -42,2 +42,2 @@\n-const oldLabel = true;\n+const selectedRow = true;\n',
          },
        },
      },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'image-1', tool: 'Image', title: 'rendered pixel' },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: {
          call_id: 'image-1', status: 'ok',
          image: {
            media_type: 'image/png',
            data_b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
        },
      },
    ],
  });

  await page.getByTestId('composer-input').fill('@alpha prepare inspector fixtures');
  await page.getByTestId('composer-send').click();
  const finalBody = page.getByText('inspector fixtures ready', { exact: true });
  await expect(finalBody).toBeVisible();
  const run = finalBody.locator('xpath=ancestor::*[@data-run-status][1]');
  await expect(run).toHaveAttribute('data-run-status', 'completed');
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');
  const toggle = page.getByTestId(`run-${runId}-toggle`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const rows = run.locator('[data-row-kind="tool"] .wr-run-row-button');
  await expect(rows).toHaveCount(3);

  await rows.nth(0).click();
  const sheet = page.getByRole('dialog', { name: 'Room context' });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  const outputPanel = sheet.getByTestId('inspector-output');
  await expect(outputPanel).toContainText('line 100: browser evidence');
  const outputSize = await outputPanel.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(outputSize.clientHeight).toBeLessThan(outputSize.scrollHeight);
  await sheet.getByRole('button', { name: 'Close room context' }).click();

  await rows.nth(1).click();
  await expect(sheet).toBeVisible();
  const diff = sheet.getByTestId('inspector-diff');
  await expect(diff).toContainText('packages/web/src/App.tsx');
  await expect(diff.locator('.wr-diff-line-add')).toContainText('+const selectedRow = true;');
  await expect(diff.locator('.wr-diff-line-remove')).toContainText('-const oldLabel = true;');
  await sheet.getByRole('button', { name: 'Close room context' }).click();

  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.getByTestId('context-rail');
  await expect(rail).toBeVisible();
  await expect(sheet).toBeHidden();
  await page.getByTestId(`run-${runId}-inspect`).click();
  await expect(rail.getByTestId('inspector-run-facts')).toBeVisible();
  await rows.nth(2).click();
  const image = rail.getByTestId('inspector-image').locator('img');
  await expect(image).toBeVisible();
  expect(await image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
});
// harn:end normalized-run-evidence-inspector
