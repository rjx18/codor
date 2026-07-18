import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
// The tool-evidence tests read a seeded run, so they open the stable fixtures
// room rather than paging eng's growing history back to reach the same run.
const FIXTURES = '/?room=fixtures&token=next-e2e-token';

async function openRoom(page: Page, url = ROOM): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('diff tab', () => {
  test('a repo with no working changes shows the clean working-tree state', async ({ page }) => {
    // eng's agents run in a plain (non-git) cwd, so the live git tab reads clean —
    // the diff tab now mirrors the repository, not historical run evidence.
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');
  });

  test('preview tab shows the dot-grid empty state without artifacts', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('context-tab-preview').click();
    await expect(page.getByTestId('preview-empty')).toContainText('Nothing to preview yet');
  });
});

test.describe('run inspector', () => {
  test('a non-diff tool card opens the inspector with output and no diff pane', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await batch.locator('.nx-tool', { hasText: 'pnpm test' }).click();
    const inspector = page.getByTestId('run-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByTestId('inspector-output')).toContainText('42 passed');
    await expect(inspector.getByTestId('diff-view')).toHaveCount(0); // diff pane dropped
    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
  });

  test('a diff chip routes to the Diff tab, noting no current changes when clean', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await batch.locator('.nx-tool', { hasText: 'session.ts' }).click();
    // The chip opens the live Diff tab focused on that file; eng's tree is clean.
    await expect(page.getByTestId('diff-no-current')).toContainText('session.ts');
  });
});

test.describe('spawn dialog', () => {
  test('traps focus, requires its fields, and spawns into the roster', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('spawn-go')).toBeDisabled();

    // Tab cycles stay inside the dialog.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    const focusInside = await page.evaluate(() =>
      document.querySelector('[data-testid="spawn-dialog"]')?.contains(document.activeElement),
    );
    expect(focusInside).toBe(true);

    await dialog.getByTestId('spawn-handle').fill('nova');
    await dialog.getByTestId('spawn-cwd').fill('/tmp');
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-nova')).toBeVisible();
    await expect(page.getByTestId('member-nova')).toContainText('Idle');
  });
});

test.describe('usage limits', () => {
  test('member cards show the harness-reported windows; agents without reports show none', async ({ page }) => {
    await openRoom(page);
    const limits = page.getByTestId('member-fable-limits');
    // A window without a percentage keeps the text pill…
    await expect(limits.locator('.nx-limit')).toContainText('5h: allowed · resets');
    // …windows with used_percent render % LEFT gauges, tinted by what remains.
    const warn = limits.locator('.nx-gauge.is-warn');
    await expect(warn).toContainText('weekly');
    await expect(warn).toContainText('18% left');
    await expect(warn.locator('.nx-gauge-fill')).toHaveAttribute('style', /width: 18%/);
    const ok = limits.locator('.nx-gauge.is-ok');
    await expect(ok).toContainText('monthly');
    await expect(ok).toContainText('80% left');
    await expect(page.getByTestId('member-scout-limits')).toHaveCount(0);
  });
});

// harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-browser-smoke
test.describe('context window meter', () => {
  test('member cards derive the ring and tooltip from fixture telemetry', async ({ page }) => {
    await openRoom(page);

    const meter = page.getByTestId('member-fable-context-window');
    await expect(meter).toBeVisible();
    await expect(meter).toHaveClass(/is-amber/);
    await expect(meter).toHaveAttribute('data-percentage', '75');
    await expect(meter).toHaveAttribute('title', /150K \/ 200K tokens · Session cost: \$0\.04/);

    await expect(page.getByTestId('member-scout-context-window')).toHaveClass(/is-pending/);
    await expect(page.getByTestId('member-hydrate-context-window')).toHaveCount(0);
  });
});
// harn:end member-context-window-meter-derived-from-last-usage

test.describe('member lifecycle', () => {
  test('kill confirms into Dead; revive brings the agent back', async ({ page }) => {
    await openRoom(page);
    const fable = page.getByTestId('member-fable');
    await expect(fable).toContainText('Idle');

    await page.getByTestId('member-fable-menu').click();
    await page.locator('.nx-menu button', { hasText: 'Kill…' }).click();
    await page.getByTestId('member-confirm-go').click();
    await expect(fable).toContainText('Dead');

    await page.getByTestId('member-fable-menu').click();
    await page.getByTestId('member-fable-revive').click();
    await expect(fable).toContainText('Idle', { timeout: 10_000 });
  });
});

test.describe('accessibility', () => {
  test('the context panel and open spawn dialog are axe-clean', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
