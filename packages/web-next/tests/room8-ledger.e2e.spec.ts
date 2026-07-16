import { expect, test } from '@playwright/test';

const LEDGER = '/ledger?room=eng&token=next-e2e-token';

test.describe('ledger graph', () => {
  test('renders the vault graph with edges and type filters', async ({ page }) => {
    await page.goto(LEDGER);
    const svg = page.getByTestId('ledger-svg');
    await expect(svg).toBeVisible();
    await expect(svg.locator('.nx-ledger-node')).toHaveCount(4);
    expect(await svg.locator('.nx-ledger-edge').count()).toBeGreaterThanOrEqual(3);

    // Hiding a type removes its nodes; toggling back restores them.
    await page.getByTestId('ledger-filter-decision').click();
    await expect(svg.locator('.nx-ledger-node')).toHaveCount(2);
    await page.getByTestId('ledger-filter-decision').click();
    await expect(svg.locator('.nx-ledger-node')).toHaveCount(4);
  });

  test('clicking a node opens its note body read-only', async ({ page }) => {
    await page.goto(LEDGER);
    await page.getByTestId('ledger-node-risk-limits').click();
    const note = page.getByTestId('ledger-note');
    await expect(note).toContainText('risk-limits');
    await expect(note).toContainText('constraint');
    await expect(note.locator('.nx-ledger-body')).toContainText('Keep exposure below 2%');
  });

  test('is axe-clean', async ({ page }) => {
    await page.goto(LEDGER);
    await expect(page.getByTestId('ledger-svg')).toBeVisible();
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
