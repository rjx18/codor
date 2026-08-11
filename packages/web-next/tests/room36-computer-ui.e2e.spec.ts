import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe('computer switcher UI', () => {
  test('phone avatar rail, local customization, and Add Computer modal stay keyboard- and axe-safe', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });

    // The switcher lives in the channel rail on phone widths, so enter that
    // surface using the existing mobile navigation first.
    await page.getByTestId('mobile-back').click();
    await expect(page.getByTestId('computer-current')).toBeVisible();
    const rail = page.getByTestId('computer-switcher');
    await expect(rail.locator('[data-computer-avatar="true"]')).toHaveCount(1);
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    expect(railBox!.x).toBeGreaterThanOrEqual(0);
    expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(390);
    const railA11y = await new AxeBuilder({ page }).include('[data-testid="computer-switcher"]').analyze();
    expect(railA11y.violations).toEqual([]);

    // Shift+F10, right-click, and long-press are all browser-local entry points.
    const current = page.getByTestId('computer-current');
    await current.focus();
    await page.keyboard.press('Shift+F10');
    const customize = page.getByTestId('computer-customize-modal');
    await expect(customize).toBeVisible();
    await expect(customize).toContainText('local icon and color');
    const customizeA11y = await new AxeBuilder({ page }).include('[data-testid="computer-customize-modal"]').analyze();
    expect(customizeA11y.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(customize).toHaveCount(0);

    await current.click({ button: 'right' });
    await expect(customize).toBeVisible();
    await page.getByRole('button', { name: /Use 🐈 icon/ }).click();
    await page.getByRole('button', { name: /Use #0f766e avatar color/ }).click();
    await page.keyboard.press('Escape');

    await current.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0 });
    await page.waitForTimeout(650);
    await current.dispatchEvent('pointerup', { pointerType: 'touch', button: 0 });
    await expect(customize).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('computer-add').click();
    const modal = page.getByTestId('computer-add-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('1. Run codor pair');
    await expect(modal).toContainText('2. Enter the eight-character code');
    await expect(modal).toContainText('single-use');
    await expect(modal).toContainText('ten minutes');
    await expect(modal).toContainText('existing private relay');
    await expect(modal.getByTestId('pairing-code-0')).toBeVisible();
    await expect(modal.getByTestId('computer-add-next')).toHaveCount(0);
    await expect(modal.getByTestId('computer-add-back')).toHaveCount(0);
    const sampledEntrance = await modal.evaluate((node) => {
      const animation = node.getAnimations()[0];
      const duration = animation?.effect?.getComputedTiming().duration;
      if (!animation || typeof duration !== 'number') return false;
      animation.pause();
      animation.currentTime = duration / 2;
      return true;
    });
    expect(sampledEntrance).toBe(true);
    const modalA11y = await new AxeBuilder({ page }).include('[data-testid="computer-add-modal"]').analyze();
    expect(modalA11y.violations).toEqual([]);

    await modal.getByTestId('computer-add-copy').click();
    await expect(modal.getByTestId('computer-add-copy')).toHaveText('Copied');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });
});
