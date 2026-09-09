import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';

async function openRoom(page: Page, room: string, token = TOKEN, expectConnection = true): Promise<void> {
  await page.goto(`/?room=${room}&token=${token}`);
  await expect(page.getByTestId('timeline')).toBeVisible();
  if (expectConnection) await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function confirmArchive(page: Page, room: string): Promise<void> {
  await page.getByTestId(`room-menu-trigger-${room}`).click();
  await page.getByTestId(`archive-channel-open-${room}`).click();
  await expect(page.getByTestId(`archive-channel-confirm-${room}`)).toBeVisible();
  await page.getByTestId(`archive-channel-confirm-${room}`).click();
}

// harn:assume channel-archive-menu-is-viewport-safe-and-accessible ref=channel-archive-menu-a11y-regression
test.describe('channel archive context menu', () => {
  test('opens from the row without navigation and cancel returns focus', async ({ page }) => {
    await openRoom(page, 'research');
    const trigger = page.getByTestId('room-menu-trigger-research');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('channel-archive-menu-research')).toBeVisible();
    await expect(page).toHaveURL(/room=research/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('channel-archive-menu-research')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.getByTestId('room-link-research').click({ button: 'right' });
    await expect(page.getByTestId('channel-archive-menu-research')).toBeVisible();
    await expect(page).toHaveURL(/room=research/);
    await page.getByTestId('archive-channel-open-research').click();
    await page.getByTestId('archive-channel-cancel-research').click();
    await expect(page.getByTestId('room-link-research')).toBeVisible();
  });

  // harn:assume channel-archive-ui-captures-source-and-authoritative-result ref=channel-archive-discovery-regression
  test('archives an inactive channel while preserving the active draft', async ({ page }) => {
    await openRoom(page, 'eng');
    const draft = page.getByTestId('composer-input');
    await draft.fill('keep this draft while another channel is archived');
    await confirmArchive(page, 'design');
    await expect(page.getByTestId('room-link-design')).toHaveCount(0);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(draft).toHaveValue('keep this draft while another channel is archived');

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('room-link-design')).toHaveCount(0);
  });

  test('archives the active channel and selects another authorized channel', async ({ page }) => {
    await openRoom(page, 'trash');
    await confirmArchive(page, 'trash');
    await expect(page.getByTestId('room-link-trash')).toHaveCount(0);
    await expect(page.locator('.nx-chat-title h1')).not.toHaveText('Trash');
    await expect(page.getByTestId('timeline')).toBeVisible();
  });

  test('coalesces a double activation into one archive result', async ({ page }) => {
    await openRoom(page, 'preview');
    await page.getByTestId('room-menu-trigger-preview').click();
    await page.getByTestId('archive-channel-open-preview').click();
    const confirm = page.getByTestId('archive-channel-confirm-preview');
    // Dispatch both activations in one browser task while the first action is
    // still pending. The menu may close as soon as the authoritative result
    // arrives, so waiting for the first click to settle would no longer test
    // duplicate suppression.
    await confirm.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('room-link-preview')).toHaveCount(0);
    await expect(page.locator('[data-testid^="archive-channel-error-"]')).toHaveCount(0);
  });

  test('does not expose archive to an unauthorized human', async ({ page }) => {
    await openRoom(page, 'eng', 'next-e2e-viewer-token');
    await expect(page.getByTestId('room-menu-trigger-eng')).toHaveCount(0);
    await expect(page.getByTestId('room-link-eng')).toBeVisible();
  });

  test('refuses archive while the source connection is offline', async ({ page }) => {
    await openRoom(page, 'ops');
    await page.evaluate(() => (window as unknown as { __codor?: { disconnect(): void } }).__codor?.disconnect());
    const trigger = page.getByTestId('room-menu-trigger-ops');
    await trigger.click();
    await page.getByTestId('archive-channel-open-ops').click();
    await page.getByTestId('archive-channel-confirm-ops').click();
    await expect(page.getByTestId('archive-channel-error-ops')).toContainText('disconnected');
    await expect(page.getByTestId('room-link-ops')).toBeVisible();
  });

  test('keeps the menu inside a phone viewport and passes Axe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page, 'hydration', TOKEN, false);
    await page.getByTestId('mobile-back').click();
    const trigger = page.getByTestId('room-menu-trigger-hydration');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('channel-archive-menu-hydration');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    const report = await new AxeBuilder({ page }).include('[data-testid="channel-archive-menu-hydration"]').analyze();
    expect(report.violations.map((violation) => violation.id)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
});
// harn:end channel-archive-ui-captures-source-and-authoritative-result
// harn:end channel-archive-menu-is-viewport-safe-and-accessible
