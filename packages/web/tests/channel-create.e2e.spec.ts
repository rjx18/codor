import { expect, test } from '@playwright/test';

// harn:assume channel-accent-projects-accessibly-across-themes ref=channel-create-browser-regression
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
  // The selected picker swatch renders the SAME accessible projection the rail dot and header
  // chip will show once the channel exists. Capture it here to compare all three surfaces.
  await expect(page.getByTestId('channel-color-coral')).toHaveAttribute('aria-pressed', 'true');
  const coralSwatch = await page.getByTestId('channel-color-coral').locator('.wr-swatch-fill').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(coralSwatch).not.toBe('rgba(0, 0, 0, 0)');

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
  // harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=starting-agent-browser-regression
  await page.getByTestId('create-room-agent-name').fill('switchboard');
  await expect(page.getByTestId('create-room-agent-handle')).toHaveCount(0);
  await page.getByTestId('create-room-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('reserved agent handle');

  await page.getByTestId('create-room-agent-name').fill('Richard');
  await page.getByTestId('create-room-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('@richard is already in use');

  await page.getByTestId('create-room-agent-name').fill('Review Lead');
  await expect(page.getByTestId('create-room-agent-handle')).toHaveText('@review-lead');
  await page.getByTestId('create-room-submit').click();

  await expect(page).toHaveURL(/\?room=demo-site$/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('member-review-lead')).toBeVisible();
  const detailResponse = await page.request.get('/api/rooms/demo-site/members', {
    headers: { authorization: 'Bearer e2e-token' },
  });
  expect(detailResponse.ok()).toBe(true);
  const details = await detailResponse.json() as { members: { member: { handle: string; display_name: string } }[] };
  expect(details.members.map((detail) => detail.member)).toContainEqual(
    expect.objectContaining({ handle: 'review-lead', display_name: 'Review Lead' }),
  );
  // harn:end starting-agent-name-derives-one-valid-identity-v6
  await expect(page.getByTestId('room-color-demo-site')).toBeVisible();
  await expect(page.getByTestId('header-room-color')).toBeVisible();
  // One projected accent, byte-identical on the picker swatch, the rail dot and the header chip.
  const railCoral = await page.getByTestId('room-color-demo-site').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const headerCoral = await page.getByTestId('header-room-color').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(railCoral, 'rail dot equals the selected swatch').toBe(coralSwatch);
  expect(headerCoral, 'header chip equals the selected swatch').toBe(coralSwatch);

  // The accent re-reads the live --cd-* backgrounds on every theme change, so the picker swatch,
  // the rail dot and the header chip must move together and never keep a stale inline colour.
  // Re-open the picker so all three surfaces are mounted at once, then flip the theme explicitly
  // and via a live system preference and re-read each after both.
  await page.getByTestId('create-room').click();
  await page.getByTestId('create-room-name').fill('Theme Probe');
  await page.getByTestId('channel-color-coral').click();
  await expect(page.getByTestId('channel-color-coral')).toHaveAttribute('aria-pressed', 'true');
  const readTriple = async (): Promise<[string, string, string]> => [
    await page.getByTestId('channel-color-coral').locator('.wr-swatch-fill').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
    await page.getByTestId('room-color-demo-site').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
    await page.getByTestId('header-room-color').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ];
  const unitedColour = (triple: [string, string, string], label: string): string => {
    expect(triple[1], `${label}: rail dot equals the selected swatch`).toBe(triple[0]);
    expect(triple[2], `${label}: header chip equals the selected swatch`).toBe(triple[0]);
    return triple[0];
  };

  const lightColour = unitedColour(await readTriple(), 'light');

  // (a) An explicit data-theme flip to dark: all three re-project to a new, still-united colour.
  await page.evaluate(() => {
    localStorage.setItem('codor-theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await readTriple())[1]).not.toBe(lightColour);
  const darkColour = unitedColour(await readTriple(), 'explicit dark');
  expect(darkColour, 'an explicit theme change re-projects the accent').not.toBe(lightColour);

  // Return to an explicit light baseline before the live system flip.
  await page.evaluate(() => {
    localStorage.setItem('codor-theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(async () => (await readTriple())[1]).not.toBe(darkColour);
  const relitColour = unitedColour(await readTriple(), 'relit light');

  // (b) A LIVE system change: no explicit choice, the OS preference flips to dark. The surfaces
  // re-read the theme's backgrounds through the media query and re-project together.
  await page.evaluate(() => {
    localStorage.setItem('codor-theme', 'system');
    delete document.documentElement.dataset.theme;
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await readTriple())[1]).not.toBe(relitColour);
  const systemDarkColour = unitedColour(await readTriple(), 'system dark');
  expect(systemDarkColour, 'a live system theme change re-projects the accent').not.toBe(relitColour);

  // Restore the light default and dismiss the probe dialog before the collision-id flow reopens it.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('codor-theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-room-dialog')).toHaveCount(0);

  await page.getByTestId('create-room').click();
  await page.getByTestId('create-room-name').fill('Demo Site');
  await expect(page.getByTestId('create-room-id')).toHaveText('id: demo-site');
  await page.getByTestId('channel-color-cyan').click();
  await expect(page.getByTestId('channel-color-cyan')).toHaveAttribute('aria-pressed', 'true');
  const cyanSwatch = await page.getByTestId('channel-color-cyan').locator('.wr-swatch-fill').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(cyanSwatch).not.toBe('rgba(0, 0, 0, 0)');
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/\?room=demo-site-2$/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('room-color-demo-site-2')).toBeVisible();
  // harn:assume spawn-default-cwd-is-absolute-or-empty ref=spawn-cwd-browser-regression
  await page.getByTestId('spawn-agent').click();
  await expect(page.getByTestId('spawn-cwd')).not.toHaveValue('.');
  await expect(page.getByTestId('spawn-cwd')).toHaveValue(/^\//);
  // harn:end spawn-default-cwd-is-absolute-or-empty
  const railCyan = await page.getByTestId('room-color-demo-site-2').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const headerCyan = await page.getByTestId('header-room-color').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(railCyan, 'rail dot equals the selected swatch').toBe(cyanSwatch);
  expect(headerCyan, 'header chip equals the selected swatch').toBe(cyanSwatch);
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
// harn:end channel-accent-projects-accessibly-across-themes
