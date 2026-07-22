import { expect, test, type Page } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const OWNER_TOKEN = 'next-e2e-token';

async function mintPairingUrl(): Promise<string> {
  const response = await fetch(`${API}/api/pairing/offers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: API }),
  });
  expect(response.ok).toBe(true);
  const offer = await response.json() as {
    endpoint: string; pairing_token: string; switchboard_sign_pub: string;
  };
  const url = new URL('/pair', API);
  url.searchParams.set('endpoint', offer.endpoint);
  url.searchParams.set('pairing_token', offer.pairing_token);
  url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
  return url.toString();
}

async function showEmptyStateOnce(page: Page): Promise<void> {
  await page.route('**/api/rooms/summary?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }) });
  }, { times: 1 });
}

async function storedRoomKey(page: Page, room: string): Promise<unknown> {
  return page.evaluate((key) => new Promise((resolve, reject) => {
    const opened = indexedDB.open('codor-crypto-v1', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const request = opened.result.transaction('state').objectStore('state').get(`room:${key}`);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    };
  }), room);
}

test.describe('first-channel onboarding', () => {
  // harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=detected-acp-browser-regression
  test('shows the shared Refresh action and honest empty installed-harness state', async ({ page }) => {
    await page.route('**/api/adapters**', async (route) => {
      const response = await route.fetch();
      const listing = await response.json() as { adapters: { id: string }[] };
      await route.fulfill({ response, body: JSON.stringify({
        ...listing,
        adapters: listing.adapters.map((adapter) => ({ ...adapter, installed: false })),
        discovering: false,
      }) });
    });
    await showEmptyStateOnce(page);
    await page.goto(`/?token=${OWNER_TOKEN}`);
    const onboarding = page.getByTestId('first-channel-onboarding');
    await expect(onboarding.getByTestId('first-refresh-adapters')).toBeVisible();
    await expect(onboarding.getByText('No supported harnesses found')).toBeVisible();
    await expect(onboarding.getByTestId('first-harness-none')).toHaveAttribute('aria-pressed', 'true');
    // No installed native or detected named provider -> the PRIMARY grid offers only None,
    // while the deliberate Custom ACP escape hatch stays available behind Advanced.
    await expect(onboarding.locator('.nx-harness-grid').first()
      .locator('[data-testid^="first-harness-"]:not([data-testid="first-harness-none"])')).toHaveCount(0);
    await expect(onboarding.getByTestId('first-advanced')).toBeVisible();
    await expect(onboarding.getByTestId('first-advanced').getByTestId('first-harness-acp')).toHaveCount(1);
  });
  // harn:end agent-selection-shows-detected-acp-and-advanced-custom

  test('a paired browser creates its first channel, keeps its chosen name, and stores the new key', async ({ page }) => {
    await showEmptyStateOnce(page);
    await page.goto(await mintPairingUrl());
    await page.getByTestId('confirm-pair-browser').click();
    const paired = page.getByTestId('pairing-offer-state').getByRole('status');
    await expect(paired).toContainText('Paired', { timeout: 15_000 });
    await paired.getByRole('link', { name: 'open your channels' }).click();

    const onboarding = page.getByTestId('first-channel-onboarding');
    await expect(onboarding).toBeVisible();
    const name = page.getByTestId('first-channel-name');
    await expect(page.getByTestId('first-folder-alpha-project')).toBeVisible();
    await page.getByTestId('first-folder-alpha-project').click();
    await expect(name).toHaveValue('alpha project');

    await name.fill('Stable Plan');
    await page.getByTestId('first-folder-beta-project').click();
    await expect(name).toHaveValue('Stable Plan');

    await page.getByTestId('first-harness-fake').click();
    await page.getByTestId('first-channel-create').click();
    await expect(page).toHaveURL(/\?room=stable-plan$/, { timeout: 15_000 });
    await expect(page.getByTestId('room-view')).toBeVisible();
    await expect(page.getByText('@codor', { exact: true }).first()).toBeVisible();
    await expect.poll(() => storedRoomKey(page, 'stable-plan')).toMatchObject({
      room: 'stable-plan', generation: 1,
    });
  });

  test('the project folder is required: a valid name alone does not enable the first channel', async ({ page }) => {
    await showEmptyStateOnce(page);
    await page.goto(`/?token=${OWNER_TOKEN}`);
    await expect(page.getByTestId('first-channel-onboarding')).toBeVisible();

    // A valid channel name with no folder chosen: a still-disabled Create
    // isolates the folder requirement rather than a blank name. Filling the
    // name first also marks it edited, so choosing a folder cannot overwrite it.
    await page.getByTestId('first-channel-name').fill('Needs A Folder');
    await expect(page.getByTestId('first-channel-name')).toHaveValue('Needs A Folder');
    await expect(page.getByTestId('first-channel-create')).toBeDisabled();

    // Choosing a project folder is precisely what enables creation.
    await page.getByTestId('first-folder-alpha-project').click();
    await expect(page.getByTestId('first-channel-name')).toHaveValue('Needs A Folder');
    await expect(page.getByTestId('first-channel-create')).toBeEnabled();
  });

  test('the complete empty-state form fits a phone and is axe-clean', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await showEmptyStateOnce(page);
    await page.goto(`/?token=${OWNER_TOKEN}`);
    await expect(page.getByTestId('first-channel-onboarding')).toBeVisible();
    await expect(page.getByTestId('first-folder-alpha-project')).toBeVisible();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
