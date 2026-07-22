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

    // Refresh is an icon-only circular control with an accessible name — no text
    // label and no separate control row when this single-cwd room has one cwd.
    const refresh = page.getByTestId('diff-refresh');
    await expect(refresh).toHaveAccessibleName('Refresh working tree');
    await expect(refresh).not.toContainText('Refresh');
    await expect(refresh.locator('svg')).toBeVisible();
    const size = await refresh.boundingBox();
    expect(size?.width ?? 0).toBeGreaterThanOrEqual(36);
    await expect(page.getByTestId('diff-cwd')).toHaveCount(0);
    await expect(page.locator('.nx-diff-toolbar')).toHaveCount(0);

    await control('/git-reset');
    await refresh.click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');

    await control('/git-dirty'); // restore for any later run
  });

  // harn:assume transcript-diffs-use-immutable-run-evidence ref=historical-diff-browser-regression
  test('a transcript diff opens its stored patch after the working tree is reset', async ({ page }) => {
    await control('/git-reset');
    await openRoom(page);

    // The builder run permanently stored this patch. The real fixture tree is
    // clean, so rendering it proves the dialog did not query current Git state.
    const chip = page.locator('.nx-tool', { hasText: 'app.ts' }).first();
    await chip.click();

    const dialog = page.getByTestId('historical-diff-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Saved with this run');
    const view = dialog.getByTestId('diff-view');
    await expect(view).toBeVisible();
    await expect(view.locator('.nx-diff-line.is-add').first()).toContainText('version = 2');
    await expect(dialog.getByRole('navigation', { name: 'Stored diff files' })).toContainText('app.ts');
    await expect(page.getByTestId('diff-files')).toHaveCount(0);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(chip).toBeFocused();

    await chip.click();
    await page.getByRole('button', { name: 'Close stored diff' }).click();
    await expect(chip).toBeFocused();

    // The distinct live panel remains available and truthfully reports clean.
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');

    await control('/git-dirty'); // restore for any later run
  });
  // harn:end transcript-diffs-use-immutable-run-evidence

  // harn:assume diff-panel-floats-refresh-and-overlays-history ref=git-history-browser-regression
  test('the History popover overlays the diff, leaves the file list in place, and closes on Escape/outside click', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    const files = page.getByTestId('diff-files');
    await expect(files).toBeVisible();

    // The file list's top must not move when the popover opens over it.
    const before = await files.boundingBox();
    await page.getByTestId('git-history-toggle').click();
    const popover = page.getByTestId('git-history-list');
    await expect(popover).toBeVisible();
    const after = await files.boundingBox();
    expect(Math.round(after?.y ?? -1)).toBe(Math.round(before?.y ?? -2));

    // Escape closes the popover and returns focus to the toggle.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId('git-history-toggle')).toBeFocused();

    // An outside pointer press (the Diff tab header) also closes it.
    await page.getByTestId('git-history-toggle').click();
    await expect(popover).toBeVisible();
    await page.getByTestId('context-tab-diff').click();
    await expect(popover).toHaveCount(0);

    await control('/git-dirty');
  });

  test('at a mobile width the History popover still overlays without moving the file list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await control('/git-dirty');
    // Mobile has no desktop connection pill; wait on the timeline, then open the
    // kebab context sheet where the DiffTab lives.
    await page.goto(WORKSPACE);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('mobile-kebab').click();
    const sheet = page.getByTestId('mobile-context');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('context-tab-diff').click();
    const files = sheet.getByTestId('diff-files');
    await expect(files).toBeVisible();

    const before = await files.boundingBox();
    await sheet.getByTestId('git-history-toggle').click();
    await expect(sheet.getByTestId('git-history-list')).toBeVisible();
    const after = await files.boundingBox();
    expect(Math.round(after?.y ?? -1)).toBe(Math.round(before?.y ?? -2));

    await control('/git-dirty');
  });

  test('history stays explicit and paginates across local branches in a clean tree', async ({ page }) => {
    await control('/git-reset');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();

    await expect(page.getByTestId('git-history-toggle')).toContainText('Working tree / HEAD');
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');
    await page.getByTestId('git-history-toggle').click();
    await expect(page.getByTestId('git-history-commit')).toHaveCount(5);
    await expect(page.getByTestId('git-history-more')).toBeVisible();

    await page.getByTestId('git-history-more').click();
    await expect(page.getByTestId('git-history-commit')).toHaveCount(8);
    await expect(page.getByTestId('git-history-list')).toContainText('feature/local-history');

    await page.getByTestId('git-history-commit').filter({ hasText: 'History fixture 6' }).click();
    const meta = page.getByTestId('git-commit-meta');
    await expect(meta).toContainText('History fixture 6');
    await expect(meta.locator('code')).toHaveText(/^[0-9a-f]{40}$/);
    await expect(page.getByTestId('diff-files')).toContainText('history.txt');
    await expect(page.getByTestId('diff-view').locator('.nx-diff-line.is-add').first()).toContainText('history');
    await expect(page.getByTestId('diff-refresh')).toHaveCount(0);

    // Collapsing the selector and browsing the patch cannot change the selected hash.
    const selectedHash = await meta.locator('code').textContent();
    await page.getByTestId('git-history-toggle').click();
    await expect(meta.locator('code')).toHaveText(selectedHash ?? '');
    await page.getByTestId('git-history-toggle').click();
    await page.getByRole('button', { name: /Working tree \/ HEAD/ }).last().click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');
    await expect(page.getByTestId('diff-refresh')).toBeVisible();

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
    await control('/git-dirty');
  });

  test('history loading failures remain visible and retryable', async ({ page }) => {
    await page.route('**/api/rooms/workspace/git-history**', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture"}' });
    });
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await page.getByTestId('git-history-toggle').click();
    await expect(page.getByTestId('git-history-error')).toContainText('Couldn’t read commit history');
    await expect(page.getByTestId('git-history-error').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('a repository without commits has an explicit history empty state', async ({ page }) => {
    await page.goto('/?room=empty-history&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('context-tab-diff').click();
    await page.getByTestId('git-history-toggle').click();
    await expect(page.getByTestId('git-history-empty')).toHaveText('No commits yet.');
  });
  // harn:end diff-panel-floats-refresh-and-overlays-history

  test('a revisit serves the cached working state instantly, never an empty pane', async ({ page }) => {
    await control('/git-dirty');
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-files')).toBeVisible();

    // Leave and return: the cached copy must render without a loading state.
    await page.getByTestId('context-tab-members').click();
    await expect(page.getByTestId('spawn-agent')).toBeVisible();
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-files')).toBeVisible({ timeout: 500 });
    await expect(page.getByTestId('diff-loading')).toHaveCount(0);

    // A full reload also restores from the saved copy before the fresh read.
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-files')).toBeVisible({ timeout: 1000 });
    await expect(page.getByTestId('diff-loading')).toHaveCount(0);
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
