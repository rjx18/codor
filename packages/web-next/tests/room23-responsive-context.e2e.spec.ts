import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

for (const width of [1024, 1280, 1360]) {
  test(`${width}px exposes Members and compact through the responsive context dialog`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await openRoom(page);

    await expect(page.locator('.nx-app > .nx-context')).toBeHidden();
    const trigger = page.getByTestId('responsive-context-trigger');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByTestId('responsive-context');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('context-tab-members')).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByTestId('member-fable')).toBeVisible();
    await expect(dialog.getByTestId('member-switchboard')).toHaveCount(0);
    await expect(dialog.getByTestId('member-fable-context-window')).toBeVisible();
    await expect(dialog.getByTestId('member-fable-compact')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close channel context' }).click();
    await expect(dialog).toBeHidden();
  });
}

test('1440px keeps the inline context island and needs no duplicate trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoom(page);

  const context = page.locator('.nx-app > .nx-context');
  await expect(context).toBeVisible();
  await expect(page.getByTestId('responsive-context-trigger')).toBeHidden();
  await expect(context.getByTestId('member-fable')).toBeVisible();
  await expect(context.getByTestId('member-switchboard')).toHaveCount(0);
  await expect(context.getByTestId('member-fable-context-window')).toBeVisible();
  await expect(context.getByTestId('member-fable-compact')).toBeVisible();
});

test('mobile keeps its full-screen context sheet with the compact control reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoom(page);

  await expect(page.getByTestId('responsive-context-trigger')).toHaveCount(0);
  await page.getByTestId('mobile-kebab').click();
  const sheet = page.getByTestId('mobile-context');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('member-fable')).toBeVisible();
  await expect(sheet.getByTestId('member-switchboard')).toHaveCount(0);
  await expect(sheet.getByTestId('member-fable-context-window')).toBeVisible();
  await expect(sheet.getByTestId('member-fable-compact')).toBeVisible();
});
