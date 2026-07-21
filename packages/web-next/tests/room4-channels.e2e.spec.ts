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
    // The derived id is shown before submit, because that is what everything else
    // addresses the channel by.
    await expect(dialog.getByTestId('create-name').locator('..')).toContainText('id:');

    // The working folder is required: a name alone does not enable creation.
    await expect(dialog.getByTestId('create-go')).toBeDisabled();

    // v2: the picker is inline — no Browse button, no separate confirm step.
    const picker = dialog.getByTestId('create-folder-picker');
    await expect(picker).toBeVisible();

    // Browsing must not commit. Selecting a row does.
    const before = await dialog.getByTestId('create-folder-typed').inputValue();
    const alpha = picker.getByTestId('create-folder-alpha-project');
    await expect(alpha).toBeVisible();
    await alpha.click();
    await expect(alpha).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('create-folder-typed')).toHaveValue(/\/alpha-project$/);

    const selected = await dialog.getByTestId('create-folder-typed').inputValue();
    await dialog.getByTestId('create-open-alpha-project').click();
    await expect(dialog.getByTestId('create-folder-nested')).toBeVisible();
    await expect(dialog.getByTestId('create-folder-typed')).toHaveValue(selected);
    expect(selected).not.toBe(before);

    await dialog.getByTestId('create-go').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText(name, { timeout: 10_000 });
    await expect(page).toHaveURL(/room=/);
    await expect(page.getByTestId(/room-link-/).filter({ hasText: name })).toBeVisible();
    await expect(page.getByTestId('timeline-empty').or(page.locator('.nx-system').first())).toBeVisible();
  });

  test('the working folder is required: a valid name alone does not enable Create', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();

    // A valid channel name is present, so a still-disabled Create cannot be
    // blamed on a blank name — the working folder is what is missing.
    await dialog.getByTestId('create-name').fill('needs-a-folder');
    await expect(dialog.getByTestId('create-name')).toHaveValue('needs-a-folder');
    await expect(dialog.getByTestId('create-go')).toBeDisabled();

    // Choosing a folder is precisely what enables creation.
    await dialog.getByTestId('create-folder-alpha-project').click();
    await expect(dialog.getByTestId('create-go')).toBeEnabled();
  });
});
