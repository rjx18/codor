import { expect, test, type Page } from '@playwright/test';

const SETTINGS = '/settings?room=eng&token=next-e2e-token';

async function openSettings(page: Page): Promise<void> {
  await page.goto(SETTINGS);
  await expect(page.locator('.nx-settings-head h1')).toHaveText('Settings');
}

test.describe('appearance', () => {
  test('the theme choice applies immediately and persists', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-system').click();
  });
});

test.describe('brakes', () => {
  test('turn brake applies through the act and survives a reload', async ({ page }) => {
    await openSettings(page);
    const toggle = page.getByTestId('brake-turn-toggle');
    await expect(toggle).not.toBeChecked(); // seeded channel has brakes off
    await toggle.check();
    await page.getByTestId('brake-turn-value').fill('4');
    await page.getByTestId('brakes-apply').click();
    await expect(page.getByTestId('brakes-apply')).toContainText('Applied');

    await page.reload();
    await expect(page.getByTestId('brake-turn-toggle')).toBeChecked();
    await expect(page.getByTestId('brake-turn-value')).toHaveValue('4');

    // Leave the fixture as found for later tests.
    await page.getByTestId('brake-turn-toggle').uncheck();
    await page.getByTestId('brakes-apply').click();
    await expect(page.getByTestId('brakes-apply')).toContainText('Applied');
  });
});

test.describe('devices', () => {
  test('the list renders and a pairing offer shows QR plus code', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByTestId('device-list')).toBeVisible();
    await page.getByTestId('pair-new-device').click();
    const offer = page.getByTestId('pairing-offer');
    await expect(offer).toBeVisible();
    await expect(offer.getByTestId('pairing-code')).not.toBeEmpty();
    await expect(offer.locator('.nx-pair-qr')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(offer).toBeHidden();
  });
});

test.describe('accessibility', () => {
  test('settings is axe-clean in both themes', async ({ page }) => {
    await openSettings(page);
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(350);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
