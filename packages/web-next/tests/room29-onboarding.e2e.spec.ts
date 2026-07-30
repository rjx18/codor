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
    await expect(onboarding.getByTestId('first-participant-none-note')).toBeVisible();
    await onboarding.getByTestId('first-participant-mode').selectOption('new');
    await expect(onboarding.getByTestId('first-refresh-adapters')).toBeVisible();
    await expect(onboarding.getByText('No supported harnesses found')).toBeVisible();
    // No installed native or detected named provider -> the primary grid is
    // empty, while the deliberate Custom ACP escape hatch stays available.
    await expect(onboarding.locator('.nx-harness-grid').first()
      .locator('[data-testid^="first-harness-"]')).toHaveCount(0);
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

    await page.getByTestId('first-participant-mode').selectOption('new');
    await page.getByTestId('first-harness-fake').click();
    await page.getByTestId('first-channel-create').click();
    await expect(page).toHaveURL(/\?room=stable-plan$/, { timeout: 15_000 });
    await expect(page.getByTestId('room-view')).toBeVisible();
    await expect(page.getByText('@codor', { exact: true }).first()).toBeVisible();
    await expect.poll(() => storedRoomKey(page, 'stable-plan')).toMatchObject({
      room: 'stable-plan', generation: 1,
    });
  });

  // harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=detected-acp-browser-regression
  test('first-channel onboarding offers a detected named provider and seeds it as harness acp + provider id', async ({ page }) => {
    const control = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
    await fetch(`${control}/acp-reset`, { method: 'POST' }); // kimi detected (serial workers=1)
    await showEmptyStateOnce(page);
    await page.goto(await mintPairingUrl());
    await page.getByTestId('confirm-pair-browser').click();
    const paired = page.getByTestId('pairing-offer-state').getByRole('status');
    await expect(paired).toContainText('Paired', { timeout: 15_000 });
    await paired.getByRole('link', { name: 'open your channels' }).click();

    const onboarding = page.getByTestId('first-channel-onboarding');
    await expect(onboarding).toBeVisible();
    await onboarding.getByTestId('first-participant-mode').selectOption('new');
    // The detected named provider is offered here too, with its ACP pill.
    await expect(onboarding.getByTestId('first-harness-acp:kimi')).toBeVisible();
    await expect(onboarding.getByTestId('first-acp-pill-kimi')).toHaveText('ACP');

    await page.getByTestId('first-folder-alpha-project').click();
    await page.getByTestId('first-channel-name').fill('Kimi Onboard');
    await onboarding.getByTestId('first-harness-acp:kimi').click();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/rooms') && r.method() === 'POST'),
      page.getByTestId('first-channel-create').click(),
    ]);
    const agent = (request.postDataJSON() as { starting_agent: Record<string, unknown> }).starting_agent;
    expect(agent.harness).toBe('acp');
    expect(agent.acp_provider).toBe('kimi');
    expect(agent).not.toHaveProperty('acp_launch');
    expect(agent).not.toHaveProperty('model');
  });
  // harn:end agent-selection-shows-detected-acp-and-advanced-custom

  test('the first channel can start with an existing mirrored session', async ({ page }) => {
    await showEmptyStateOnce(page);
    await page.goto(`/?token=${OWNER_TOKEN}`);
    const onboarding = page.getByTestId('first-channel-onboarding');
    await page.getByTestId('first-folder-alpha-project').click();
    await page.getByTestId('first-channel-name').fill('Existing Session Start');
    await onboarding.getByTestId('first-participant-mode').selectOption('existing');

    // Codex and Claude remain first-class choices with complete UUID validation.
    await expect(onboarding.getByTestId('first-join-harness')).toHaveValue('codex');
    await onboarding.getByTestId('first-join-session-ref').fill('019faeb6-e4e4-79b0');
    await expect(onboarding.getByTestId('first-join-session-error'))
      .toContainText('36-character UUID');
    await expect(page.getByTestId('first-channel-create')).toBeDisabled();

    // The isolated browser fixture has one resumable adapter (`fake`), so use
    // the explicit Other path for the real join rather than claiming the UUID
    // belongs to a live Codex process.
    await onboarding.getByTestId('first-join-harness').selectOption('other');
    await onboarding.getByTestId('first-join-custom-harness').fill('fake');
    await onboarding.getByTestId('first-join-session-ref')
      .fill('first-channel-existing-session');
    await onboarding.getByTestId('first-join-role').selectOption('orchestrator');

    const request = page.waitForRequest((candidate) =>
      candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/rooms');
    await page.getByTestId('first-channel-create').click();
    const payload = (await request).postDataJSON() as {
      starting_agent?: unknown;
      starting_session?: Record<string, unknown>;
    };
    expect(payload).not.toHaveProperty('starting_agent');
    expect(payload.starting_session).toMatchObject({
      harness: 'fake',
      handle: 'orchestrator',
      session_ref: 'first-channel-existing-session',
      policy: 'read-only',
    });
    await expect(page).toHaveURL(/\?room=existing-session-start$/, { timeout: 15_000 });
    await expect(page.getByTestId('member-orchestrator')).toContainText('mirrored');
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
