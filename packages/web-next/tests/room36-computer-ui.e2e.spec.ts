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

async function openPairedPage(page: Page, viewport?: { width: number; height: number }): Promise<void> {
  if (viewport) await page.setViewportSize(viewport);
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
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe('computer switcher UI', () => {
  test('phone avatar rail, local customization, and Add Computer modal stay keyboard- and axe-safe', async ({ page }) => {
    test.setTimeout(120_000);
    await openPairedPage(page);

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
    const current = page.getByTestId('computer-current');
    await current.focus();
    await expect(current.locator('[role="tooltip"]')).toHaveText('codor-host-a');
    await expect(current.locator('[role="tooltip"]')).toBeVisible();
    await current.hover();
    await expect(current.locator('[role="tooltip"]')).toBeVisible();
    await expect(current.locator('.nx-computer-avatar-status')).toHaveCount(0);

    // The fixture has no simultaneous background activity, so add the same
    // two badge nodes to this real avatar to measure the shipped CSS geometry.
    // harn:assume hosted-avatar-activity-badges-form-bottom-cluster ref=bottom-activity-cluster-regression
    await current.evaluate((button) => {
      const cluster = document.createElement('span');
      cluster.className = 'nx-computer-avatar-activity-badges';
      cluster.dataset.testid = 'computer-avatar-activity-geometry';
      for (const [kind, label] of [['working', '1 working channel'], ['attention', '1 attention channel']] as const) {
        const badge = document.createElement('span');
        badge.className = `nx-computer-avatar-badge is-${kind}`;
        badge.dataset.testid = `computer-avatar-${kind}-geometry`;
        badge.setAttribute('aria-label', label);
        badge.textContent = '1';
        cluster.append(badge);
      }
      button.append(cluster);
    });
    const workingBadge = current.locator('[data-testid="computer-avatar-working-geometry"]');
    const attentionBadge = current.locator('[data-testid="computer-avatar-attention-geometry"]');
    const workingBox = await workingBadge.boundingBox();
    const attentionBox = await attentionBadge.boundingBox();
    expect(workingBox).not.toBeNull();
    expect(attentionBox).not.toBeNull();
    expect(attentionBox!.x).toBeGreaterThan(workingBox!.x);
    expect(Math.abs(attentionBox!.y - workingBox!.y)).toBeLessThanOrEqual(2);
    expect(attentionBox!.x - (workingBox!.x + workingBox!.width)).toBeLessThanOrEqual(4);
    // harn:end hosted-avatar-activity-badges-form-bottom-cluster

    // Shift+F10, right-click, and long-press are all browser-local entry points.
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
    await page.getByRole('button', { name: 'Use Cat icon' }).click();
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

  // harn:assume hosted-computer-rail-precedes-channel-rail-on-desktop ref=desktop-computer-rail-order-regression
  // harn:assume hosted-computer-customization-dialog-is-viewport-safe ref=computer-customization-dialog-regression
  test('desktop puts the computer rail before channels and keeps status/customization safe', async ({ page }) => {
    test.setTimeout(120_000);
    await openPairedPage(page, { width: 1440, height: 900 });
    const app = page.getByTestId('app');
    const childClasses = await app.locator(':scope > *').evaluateAll((nodes) => nodes.map((node) => node.className));
    const computerIndex = childClasses.findIndex((value) => String(value).includes('nx-computer-rail'));
    const channelIndex = childClasses.findIndex((value) => String(value).includes('nx-rail'));
    expect(computerIndex).toBeGreaterThanOrEqual(0);
    expect(channelIndex).toBeGreaterThanOrEqual(0);
    expect(computerIndex).toBeLessThan(channelIndex);

    const computerRail = page.getByTestId('computer-switcher');
    const channelRail = page.locator('.nx-rail').first();
    const computerBox = await computerRail.boundingBox();
    const channelBox = await channelRail.boundingBox();
    expect(computerBox).not.toBeNull();
    expect(channelBox).not.toBeNull();
    expect(computerBox!.x).toBeLessThan(channelBox!.x);
    expect(computerBox!.x + computerBox!.width).toBeLessThanOrEqual(channelBox!.x);

    const current = page.getByTestId('computer-current');
    await expect(current).toHaveClass(/is-connected/);
    const iconContrast = await current.evaluate((element) => {
      const root = document.documentElement;
      const previousTheme = root.getAttribute('data-theme');
      const luminance = (value: string): number => {
        const match = value.match(/rgba?\((\d+),?\s*(\d+),?\s*(\d+)/);
        if (!match) return 0;
        const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const read = () => {
        const style = getComputedStyle(element);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return {
          color: style.color,
          contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        };
      };
      root.dataset.theme = 'light';
      const light = read();
      root.dataset.theme = 'dark';
      const dark = read();
      if (previousTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previousTheme);
      return { light, dark };
    });
    expect(iconContrast.light.color).toBe('rgb(255, 255, 255)');
    expect(iconContrast.dark.color).toBe('rgb(255, 255, 255)');
    expect(iconContrast.light.contrast).toBeGreaterThanOrEqual(4.5);
    expect(iconContrast.dark.contrast).toBeGreaterThanOrEqual(4.5);
    await current.focus();
    await page.keyboard.press('Shift+F10');
    const customize = page.getByTestId('computer-customize-modal');
    await expect(customize).toBeVisible();
    const dialogStyle = await customize.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowY: style.overflowY, maxHeight: style.maxHeight, width: element.getBoundingClientRect().width };
    });
    expect(dialogStyle.overflowY).toBe('auto');
    expect(dialogStyle.maxHeight).not.toBe('none');
    expect(dialogStyle.width).toBeLessThanOrEqual(1440);
    const targetSizes = await customize.locator('button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    expect(Math.min(...targetSizes.map((size) => size.width))).toBeGreaterThanOrEqual(44);
    expect(Math.min(...targetSizes.map((size) => size.height))).toBeGreaterThanOrEqual(44);
    const customizeA11y = await new AxeBuilder({ page }).include('[data-testid="computer-customize-modal"]').analyze();
    expect(customizeA11y.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(customize).toHaveCount(0);

    const disabledStatus = await current.evaluate((element) => {
      element.classList.remove('is-connected');
      element.classList.add('is-repair');
      (element as HTMLButtonElement).disabled = true;
      const style = getComputedStyle(element);
      return { opacity: style.opacity, borderColor: style.borderTopColor };
    });
    expect(disabledStatus.opacity).toBe('1');
    expect(disabledStatus.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(disabledStatus.borderColor).not.toBe('transparent');
  });
});
