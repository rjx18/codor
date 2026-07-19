import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('channel switching', () => {
  test('clicking a rail row switches in place — no reload, URL and back both work', async ({ page }) => {
    await openRoom(page);
    // A marker that survives only if the page never reloads.
    await page.evaluate(() => { (window as unknown as { __stay: boolean }).__stay = true; });

    await page.getByTestId('room-link-design').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');
    await expect(page.locator('.nx-prose', { hasText: 'pricing page comps' })).toBeVisible();
    await expect(page).toHaveURL(/room=design/);
    expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);

    await page.goBack();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page).toHaveURL(/room=eng/);
    expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  });
});

test.describe('channel creation', () => {
  test('the dialog picks a folder, creates the channel, and lands in it', async ({ page }, testInfo) => {
    // A fixed name is not repeat-safe: a second run creates `growth-2` beside
    // `growth`, and a name-based locator then matches both.
    const name = `Growth ${String(testInfo.repeatEachIndex)}-${String(testInfo.retry)}`;
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('create-go')).toBeDisabled();

    await dialog.getByTestId('create-name').fill(name);
    await dialog.getByTestId('folder-open').click();
    await expect(dialog.getByTestId('folder-picker')).toBeVisible();

    await dialog.getByTestId('create-go').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText(name, { timeout: 10_000 });
    await expect(page).toHaveURL(/room=/);
    await expect(page.getByTestId(/room-link-/).filter({ hasText: name })).toBeVisible();
    await expect(page.getByTestId('timeline-empty').or(page.locator('.nx-system').first())).toBeVisible();
  });
});
