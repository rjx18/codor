import { expect, test, type Page } from '@playwright/test';

// The workspace room is bound to a real, seeded-dirty git repo so the diff
// explorer has a live working tree to read. The control port dirties/resets it.
const WORKSPACE = '/?room=workspace&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control(path: string): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(WORKSPACE);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('git diff explorer', () => {
  test('a dirty repo renders file rows with statuses and the tinted viewer', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();

    const files = page.getByTestId('diff-files');
    const modified = files.locator('.nx-diff-file', { hasText: 'app.ts' }).first();
    await expect(modified.locator('.nx-diff-status')).toHaveText('M');
    await expect(modified).toContainText('+2');
    await expect(modified).toContainText('−1');
    await expect(files.locator('.nx-diff-file', { hasText: 'notes.md' }).locator('.nx-diff-status'))
      .toHaveText('?');
    await expect(files.locator('.nx-diff-file', { hasText: 'legacy.ts' }).locator('.nx-diff-status'))
      .toHaveText('D');

    await modified.click();
    const view = page.getByTestId('diff-view');
    await expect(view.locator('.nx-diff-line.is-add').first()).toContainText('version = 2');
  });

  test('an explicit refresh reflects a reset working tree without a reload', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-files')).toBeVisible();

    await control('/git-reset');
    await page.getByTestId('diff-refresh').click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');

    await control('/git-dirty'); // restore for any later run
  });

  test('a chat diff chip opens the Diff tab focused on that file\'s current diff', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);

    // The builder run's Edit chip points at src/app.ts, which the tree changed.
    await page.locator('.nx-tool', { hasText: 'app.ts' }).first().click();

    const view = page.getByTestId('diff-view');
    await expect(view).toBeVisible();
    await expect(view.locator('.nx-diff-line.is-add').first()).toContainText('version = 2');
    await expect(page.getByTestId('diff-files').locator('.nx-diff-file.is-active', { hasText: 'app.ts' }))
      .toBeVisible();
  });

  test('the diff explorer is axe-clean', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-files')).toBeVisible();

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
