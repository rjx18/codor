import { expect, test } from '@playwright/test';

// harn:assume channel-create-dialog-uses-authoritative-result ref=channel-create-browser-regression
test('channel dialog uses contained folders, starting agents, colors, and authoritative collision ids', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('create-room').click();
  const dialog = page.getByTestId('create-room-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('create-room-name').fill('Demo Site');
  await expect(page.getByTestId('create-room-id')).toHaveText('id: demo-site');
  await page.getByTestId('channel-color-coral').click();

  await page.getByTestId('browse-folders').click();
  const picker = page.getByTestId('folder-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Home' })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Parent' })).toHaveCount(0);
  await expect(page.getByTestId('folder-use')).toBeEnabled();
  await page.getByTestId('folder-use').click();
  await expect(page.getByTestId('create-room-cwd')).not.toHaveValue('');

  await page.getByTestId('create-room-harness').selectOption('fake');
  await expect(page.getByTestId('create-room-agent-name')).toHaveValue('codor');
  await page.getByTestId('create-room-submit').click();

  await expect(page).toHaveURL(/\?room=demo-site$/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('member-codor')).toBeVisible();
  await expect(page.getByTestId('room-color-demo-site')).toBeVisible();
  await expect(page.getByTestId('header-room-color')).toBeVisible();
  expect(await page.getByTestId('header-room-color').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(216, 106, 100)');

  await page.getByTestId('create-room').click();
  await page.getByTestId('create-room-name').fill('Demo Site');
  await expect(page.getByTestId('create-room-id')).toHaveText('id: demo-site');
  await page.getByTestId('channel-color-cyan').click();
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/\?room=demo-site-2$/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('room-color-demo-site-2')).toBeVisible();
  expect(await page.getByTestId('header-room-color').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(103, 183, 199)');
});
// harn:end channel-create-dialog-uses-authoritative-result
