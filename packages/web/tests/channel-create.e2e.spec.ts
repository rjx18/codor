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

  // harn:assume agent-controls-shared-by-both-dialogs ref=agent-controls-browser-regression
  // The starting agent is configured by tapping tiles and buttons; the only text the
  // common path types is the channel name and the agent handle.
  await expect(page.getByTestId('create-room-harness-fake')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('create-room-model-default')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('create-room-model-custom')).toBeVisible();
  await expect(page.getByTestId('create-room-model-custom-input')).toHaveCount(0);
  await expect(page.getByTestId('create-room-thinking-default')).toBeVisible();
  // harn:end agent-controls-shared-by-both-dialogs
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

test('channel creation stays available when no starting adapters are installed', async ({ page }) => {
  await page.route('**/api/adapters', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ adapters: [] }),
    });
  });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('create-room').click();
  await page.getByTestId('create-room-name').fill('Adapterless Channel');
  await expect(page.getByTestId('create-room-harness-none')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('create-room-agent-name')).toBeDisabled();
  await page.getByTestId('create-room-submit').click();

  await expect(page).toHaveURL(/\?room=adapterless-channel$/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('member-codor')).toHaveCount(0);
});
// harn:end channel-create-dialog-uses-authoritative-result
