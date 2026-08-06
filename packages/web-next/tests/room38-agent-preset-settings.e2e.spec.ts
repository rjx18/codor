import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
const OWNER = 'next-e2e-token';

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${OWNER}`,
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  let body = undefined as T;
  try { body = await response.json() as T; } catch { /* 204 */ }
  return { response, body };
}

async function createPreset(input: Record<string, unknown>): Promise<string> {
  const { response, body } = await api<{ preset: { id: string } }>('/api/agent-presets', {
    method: 'POST', body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return body.preset.id;
}

async function setRoster(presetIds: string[]): Promise<void> {
  const { response } = await api('/api/default-roster', {
    method: 'PUT', body: JSON.stringify({ preset_ids: presetIds }),
  });
  expect(response.status).toBe(200);
}

async function cleanupPhase4Data(): Promise<void> {
  await setRoster([]);
  const { response, body } = await api<{ presets: { id: string; label: string }[] }>('/api/agent-presets');
  if (!response.ok) return;
  for (const preset of body.presets) {
    if (!preset.label.startsWith('P4 ')) continue;
    await api(`/api/agent-presets/${preset.id}`, { method: 'DELETE' });
  }
}

async function openSettings(page: Page, token = OWNER): Promise<void> {
  await page.goto(`/settings?room=eng&token=${token}`);
  await expect(page.locator('.nx-settings-head h1')).toHaveText('Settings');
  await expect(page.getByTestId('agent-preset-settings')).toBeVisible();
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(`/?room=eng&token=${OWNER}`);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

async function idForRow(page: Page, label: string): Promise<string> {
  const row = page.locator('.nx-preset-row', { hasText: label });
  const testid = await row.getAttribute('data-testid');
  expect(testid).toMatch(/^preset-row-/);
  return testid!.slice('preset-row-'.length);
}

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return await response.json() as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 4 Settings and default-roster UI', () => {
  test.beforeEach(async () => { await cleanupPhase4Data(); });
  test.afterEach(async () => { await cleanupPhase4Data(); });

  test('Settings maps native, named, and custom presets and saves one ordered roster', async ({ page }) => {
    await openSettings(page);
    const settings = page.getByTestId('agent-preset-settings');

    const nativeLabel = `P4 native ${Date.now()}`;
    await page.getByTestId('preset-add').click();
    await expect(page.getByTestId('preset-label')).toBeFocused();
    await page.getByTestId('preset-label').fill(nativeLabel);
    await page.getByTestId('preset-handle').fill('p4-native');
    await page.getByTestId('preset-display-name').fill('P4 Native');
    await page.getByTestId('preset-harness-fake').click();
    await page.getByTestId('preset-save').click();
    await expect(settings.locator('.nx-preset-row', { hasText: nativeLabel })).toBeVisible();
    const nativeId = await idForRow(page, nativeLabel);

    const namedLabel = `P4 named ${Date.now()}`;
    await page.getByTestId('preset-add').click();
    await page.getByTestId('preset-label').fill(namedLabel);
    await page.getByTestId('preset-handle').fill('p4-named');
    await page.getByTestId('preset-harness-acp:kimi').click();
    await page.getByTestId('preset-save').click();
    await expect(settings.locator('.nx-preset-row', { hasText: namedLabel })).toBeVisible();
    const namedId = await idForRow(page, namedLabel);

    const customId = await createPreset({
      label: `P4 custom ${Date.now()}`, handle: 'p4-custom', harness: 'acp',
      acp_launch: { executable: process.execPath, argv: ['--p4-custom'] },
    });
    await page.getByTestId('preset-refresh').click();
    await expect(page.getByTestId(`preset-row-${customId}`)).toBeVisible();
    await page.getByTestId(`preset-edit-${customId}`).click();
    await expect(page.getByTestId('preset-acp-executable')).toHaveValue(process.execPath);
    await page.getByTestId('preset-label').fill(`P4 custom edited ${Date.now()}`);
    await page.getByTestId('preset-save').click();
    await expect(page.getByTestId(`preset-row-${customId}`)).toContainText('P4 custom edited');

    const addSelect = page.getByTestId('roster-add-select');
    await addSelect.selectOption(nativeId);
    await page.getByTestId('roster-add').click();
    await addSelect.selectOption(namedId);
    await page.getByTestId('roster-add').click();
    await page.getByTestId(`roster-up-${namedId}`).click();
    let rosterSaveCount = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/default-roster') rosterSaveCount += 1;
    });
    await page.getByTestId('roster-save').click();
    await expect(page.getByTestId('roster-row-' + namedId)).toBeVisible();
    expect(rosterSaveCount).toBe(1);
    const rosterRows = await page.getByTestId('roster-list').locator('.nx-roster-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
    expect(rosterRows).toEqual([`roster-row-${namedId}`, `roster-row-${nativeId}`]);

    await page.getByTestId(`preset-delete-${nativeId}`).click();
    await page.getByTestId('preset-delete-confirm').click();
    await expect(page.getByTestId('preset-delete-error')).toContainText(/roster|referenced|conflict/i);
    await page.getByTestId('preset-delete-dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId(`roster-remove-${nativeId}`).click();
    await page.getByTestId('roster-save').click();
    await page.getByTestId(`preset-delete-${nativeId}`).click();
    await page.getByTestId('preset-delete-confirm').click();
    await expect(page.getByTestId(`preset-row-${nativeId}`)).toHaveCount(0);

    await page.getByTestId(`roster-remove-${namedId}`).click();
    await page.getByTestId('roster-save').click();
    await expect(page.getByText(/Empty roster/)).toBeVisible();
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('tab', { name: theme }).click();
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    }
  });

  test('preset draft survives stale, delayed, and referenced-delete failures', async ({ page }) => {
    const id = await createPreset({ label: `P4 recovery ${Date.now()}`, handle: 'p4-recovery', harness: 'fake' });
    await setRoster([id]);
    await openSettings(page);

    await page.route(`${API}/api/agent-presets/${id}`, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'preset no longer exists' }) });
        return;
      }
      await route.continue();
    });
    await page.getByTestId(`preset-edit-${id}`).click();
    await page.getByTestId('preset-label').fill('P4 stale draft preserved');
    await page.getByTestId('preset-save').click();
    await expect(page.getByTestId('preset-editor-dialog')).toBeVisible();
    await expect(page.getByTestId('preset-editor-error')).toContainText(/no longer exists/i);
    await expect(page.getByTestId('preset-label')).toHaveValue('P4 stale draft preserved');
    await page.unroute(`${API}/api/agent-presets/${id}`);
    await page.getByTestId('preset-save').click();
    await expect(page.getByTestId(`preset-row-${id}`)).toContainText('P4 stale draft preserved');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${API}/api/agent-presets/${id}`, async (route) => {
      if (route.request().method() === 'PUT') {
        await gate;
        await route.continue();
        return;
      }
      await route.continue();
    });
    await page.getByTestId(`preset-edit-${id}`).click();
    await page.getByTestId('preset-label').fill('P4 delayed saved');
    await page.getByTestId('preset-save').click();
    await expect(page.getByTestId('preset-save')).toBeDisabled();
    release();
    await expect(page.getByTestId(`preset-row-${id}`)).toContainText('P4 delayed saved');
    await page.unroute(`${API}/api/agent-presets/${id}`);

    await page.getByTestId(`preset-delete-${id}`).click();
    await page.getByTestId('preset-delete-confirm').click();
    await expect(page.getByTestId('preset-delete-error')).toContainText(/roster|referenced|conflict/i);
    await page.getByTestId('preset-delete-dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId(`roster-remove-${id}`).click();
    await page.getByTestId('roster-save').click();
    await page.getByTestId(`preset-delete-${id}`).click();
    await page.getByTestId('preset-delete-confirm').click();
    await expect(page.getByTestId(`preset-row-${id}`)).toHaveCount(0);
  });

  test('Settings retries reads and preserves a dirty roster through failed save and reload', async ({ page }) => {
    const first = await createPreset({ label: `P4 roster first ${Date.now()}`, handle: 'p4-roster-first', harness: 'fake' });
    const second = await createPreset({ label: `P4 roster second ${Date.now()}`, handle: 'p4-roster-second', harness: 'fake' });
    await setRoster([first]);

    await page.route(`${API}/api/agent-presets`, async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary list failure' }) });
    }, { times: 1 });
    await openSettings(page);
    await expect(page.getByTestId('preset-list-error')).toBeVisible();
    await page.unroute(`${API}/api/agent-presets`);
    await page.getByTestId('preset-list-retry').click();
    await expect(page.getByTestId(`preset-row-${first}`)).toBeVisible();

    await page.getByTestId('roster-add-select').selectOption(second);
    await page.getByTestId('roster-add').click();
    await page.route(`${API}/api/default-roster`, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary roster failure' }) });
        return;
      }
      await route.continue();
    });
    await page.getByTestId('roster-save').click();
    await expect(page.getByTestId('roster-save-error')).toContainText(/temporary roster failure/i);
    await expect(page.getByTestId(`roster-row-${second}`)).toBeVisible();
    await page.unroute(`${API}/api/default-roster`);
    await page.getByTestId('roster-save').click();
    await expect(page.getByTestId('roster-save-error')).toHaveCount(0);

    await setRoster([first]);
    await page.getByTestId('roster-refresh').click();
    await expect(page.getByTestId(`roster-row-${second}`)).toHaveCount(0);
    await expect(page.getByTestId(`roster-row-${first}`)).toBeVisible();
  });

  test('a failed default-roster read leaves legacy Starting agent usable', async ({ page }) => {
    const rosterPreset = await createPreset({ label: `P4 read recovery ${Date.now()}`, handle: 'p4-read-recovery', harness: 'fake' });
    await setRoster([rosterPreset]);
    await openRoom(page);
    await page.route(`${API}/api/default-roster`, async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'roster temporarily unavailable' }) });
    }, { times: 1 });
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog.getByTestId('create-roster-error')).toBeVisible();
    await expect(dialog.getByTestId('create-agent-none-note')).toBeVisible();
    await dialog.getByTestId('create-harness-fake').click();
    await expect(dialog.getByTestId('create-agent-name')).toBeVisible();
    await page.unroute(`${API}/api/default-roster`);
    await dialog.getByTestId('create-roster-retry').click();
    await expect(dialog.getByTestId('create-roster-select')).toBeVisible();
    await dialog.getByTestId('create-close').click();
  });

  test('lower roles receive no preset or roster management reads', async ({ page }) => {
    const managementRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/agent-presets' || path.startsWith('/api/agent-presets/') || path === '/api/default-roster') managementRequests.push(path);
    });
    await page.goto(`/?room=eng&token=next-e2e-viewer-token`);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.goto(`/settings?room=eng&token=next-e2e-viewer-token`);
    await expect(page.locator('.nx-settings-head h1')).toHaveText('Settings');
    await expect(page.getByTestId('agent-preset-settings')).toHaveCount(0);
    expect(managementRequests).toEqual([]);
  });

  test('Settings, roster ordering, and both creation choices fit at 390px', async ({ page }) => {
    const first = await createPreset({ label: `P4 phone first ${Date.now()}`, handle: 'p4-phone-first', harness: 'fake' });
    const second = await createPreset({ label: `P4 phone second ${Date.now()}`, handle: 'p4-phone-second', harness: 'fake' });
    await setRoster([first, second]);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page);
    await expect(page.getByTestId(`preset-row-${first}`)).toBeVisible();
    await expect(page.getByTestId(`roster-row-${first}`)).toBeVisible();

    const settingsMetrics = await page.evaluate(() => {
      const selectors = [
        '[data-testid="preset-add"]', '[data-testid="preset-refresh"]',
        '[data-testid^="preset-edit-"]', '[data-testid^="preset-delete-"]',
        '[data-testid="roster-refresh"]', '[data-testid="roster-add"]', '[data-testid="roster-save"]',
        '[data-testid^="roster-up-"]', '[data-testid^="roster-down-"]', '[data-testid^="roster-remove-"]',
      ].join(',');
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        targets: [...document.querySelectorAll<HTMLElement>(selectors)].map((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      };
    });
    expect(settingsMetrics.overflow).toBeLessThanOrEqual(1);
    expect(settingsMetrics.targets.length).toBeGreaterThan(6);
    expect(settingsMetrics.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);

    await page.getByTestId('preset-add').click();
    const editor = page.getByTestId('preset-editor-dialog');
    await expect(page.getByTestId('preset-label')).toBeFocused();
    const dialogMetrics = await editor.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.nx-dialog-body');
      const actions = element.querySelector<HTMLElement>('.nx-dialog-actions');
      return {
        overflow: element.scrollWidth - element.clientWidth,
        bodyScrolls: body !== null && body.scrollHeight >= body.clientHeight,
        actionsVisible: actions !== null && actions.getBoundingClientRect().bottom <= window.innerHeight,
      };
    });
    expect(dialogMetrics.overflow).toBeLessThanOrEqual(1);
    expect(dialogMetrics.bodyScrolls).toBe(true);
    expect(dialogMetrics.actionsVisible).toBe(true);
    await page.getByTestId('preset-editor-cancel').click();
    await expect(page.getByTestId('preset-add')).toBeFocused();

    await openRoom(page);
    await page.getByTestId('mobile-back').click();
    await page.getByTestId('create-room').click();
    const createDialog = page.getByTestId('create-channel-dialog');
    await expect(createDialog.getByTestId('create-roster-select')).toBeVisible();
    const createMetrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      choiceHeight: document.querySelector<HTMLElement>('[data-testid="create-roster-select"]')?.getBoundingClientRect().height ?? 0,
      reloadHeight: document.querySelector<HTMLElement>('[data-testid="create-roster-refresh"]')?.getBoundingClientRect().height ?? 0,
    }));
    expect(createMetrics.overflow).toBeLessThanOrEqual(1);
    expect(createMetrics.choiceHeight).toBeGreaterThanOrEqual(44);
    expect(createMetrics.reloadHeight).toBeGreaterThanOrEqual(44);
    await createDialog.getByTestId('create-close').click();

    await page.route('**/api/rooms/summary?*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }) });
    }, { times: 1 });
    await page.goto(`/?token=${OWNER}`);
    const onboarding = page.getByTestId('first-channel-onboarding');
    await expect(onboarding.getByTestId('first-roster-select')).toBeVisible();
    const firstMetrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      choiceHeight: document.querySelector<HTMLElement>('[data-testid="first-roster-select"]')?.getBoundingClientRect().height ?? 0,
    }));
    expect(firstMetrics.overflow).toBeLessThanOrEqual(1);
    expect(firstMetrics.choiceHeight).toBeGreaterThanOrEqual(44);
  });

  test('normal Create Channel selects the roster exclusively and preserves a failed draft', async ({ page }) => {
    const rosterPreset = await createPreset({ label: `P4 normal roster ${Date.now()}`, handle: 'p4-normal', harness: 'fake' });
    await setRoster([rosterPreset]);
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog.getByTestId('create-roster-select')).toBeVisible();
    await dialog.getByTestId('create-name').fill('P4 roster channel');
    await dialog.getByTestId('create-folder-alpha-project').click();
    await dialog.getByTestId('create-advanced').locator('summary').click();
    await dialog.getByTestId('create-harness-acp').click();
    await dialog.getByTestId('create-acp-executable').fill(process.execPath);
    await dialog.getByTestId('create-acp-args').fill('--draft-arg\n--literal=x');
    await dialog.getByTestId('create-policy-full-access').click();
    await dialog.getByTestId('create-agent-name').fill('draft-agent');
    await dialog.getByTestId('create-refresh-adapters').click();
    await expect(dialog.getByTestId('create-refresh-adapters')).toBeEnabled();
    await dialog.getByTestId('create-roster-select').click();
    await expect(dialog.getByTestId('create-agent-name')).toHaveCount(0);
    await dialog.getByTestId('create-roster-select').click();
    await expect(dialog.getByTestId('create-agent-name')).toHaveValue('draft-agent');
    await expect(dialog.getByTestId('create-harness-acp')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('create-acp-executable')).toHaveValue(process.execPath);
    await expect(dialog.getByTestId('create-acp-args')).toHaveValue('--draft-arg\n--literal=x');
    await expect(dialog.getByTestId('create-policy-full-access')).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByTestId('create-roster-select').click();

    await page.route('**/api/rooms', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'temporary create failure' }) });
        return;
      }
      await route.continue();
    });
    const failedRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms');
    await dialog.getByTestId('create-go').click();
    const failedPayload = (await failedRequest).postDataJSON();
    expect(failedPayload).toMatchObject({ default_roster: true });
    expect(failedPayload).not.toHaveProperty('starting_agent');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('create-roster-select')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('alert')).toContainText('temporary create failure');
    await page.unroute('**/api/rooms');

    const roomName = `P4 roster retry ${Date.now()}`;
    await dialog.getByTestId('create-name').fill(roomName);
    const successRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms');
    await dialog.getByTestId('create-go').click();
    expect((await successRequest).postDataJSON()).toMatchObject({ default_roster: true });
    await expect(page).toHaveURL(new RegExp(`room=${roomName.toLowerCase().replaceAll(' ', '-')}`), { timeout: 15_000 });
  });

  test('first-channel onboarding uses the same roster choice and wire contract', async ({ page }) => {
    const rosterPreset = await createPreset({ label: `P4 first roster ${Date.now()}`, handle: 'p4-first', harness: 'fake' });
    await setRoster([rosterPreset]);
    await page.route('**/api/rooms/summary?*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }) });
    }, { times: 1 });
    await page.goto(`/?token=${OWNER}`);
    const onboarding = page.getByTestId('first-channel-onboarding');
    await expect(onboarding).toBeVisible();
    await onboarding.getByTestId('first-folder-alpha-project').click();
    await onboarding.getByTestId('first-channel-name').fill('P4 first channel');
    await onboarding.getByTestId('first-harness-fake').click();
    await onboarding.getByTestId('first-agent-name').fill('first-draft');
    await onboarding.getByTestId('first-roster-select').click();
    await expect(onboarding.getByTestId('first-agent-name')).toHaveCount(0);
    await onboarding.getByTestId('first-roster-select').click();
    await expect(onboarding.getByTestId('first-agent-name')).toHaveValue('first-draft');
    await onboarding.getByTestId('first-roster-select').click();
    const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/rooms');
    await onboarding.getByTestId('first-channel-create').click();
    const payload = (await request).postDataJSON();
    expect(payload).toMatchObject({ default_roster: true });
    expect(payload).not.toHaveProperty('starting_agent');
    await expect(page).toHaveURL(/room=p4-first-channel/, { timeout: 15_000 });
  });

  test('active hosted Settings and Create Channel stay on the relay transport', async ({ page }) => {
    test.setTimeout(180_000);
    const rosterPreset = await createPreset({ label: `P4 hosted roster ${Date.now()}`, handle: 'p4-hosted', harness: 'fake' });
    await setRoster([rosterPreset]);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, relayUrl);
    const directApiHits: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(`${SPA_ORIGIN}/api/`)) directApiHits.push(request.url());
    });
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('agent-preset-settings')).toBeVisible({ timeout: 30_000 });
    const hostedLabel = `P4 hosted ui ${Date.now()}`;
    await page.getByTestId('preset-add').click();
    await page.getByTestId('preset-label').fill(hostedLabel);
    await page.getByTestId('preset-handle').fill('p4-hosted-ui');
    await page.getByTestId('preset-harness-fake').click();
    await page.getByTestId('preset-save').click();
    await expect(page.getByText(hostedLabel, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to the channel' }).click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog.getByTestId('create-roster-select')).toBeVisible({ timeout: 30_000 });
    await dialog.getByTestId('create-roster-select').click();
    await dialog.getByTestId('create-name').fill(`P4 hosted channel ${Date.now()}`);
    await dialog.getByTestId('create-folder-alpha-project').click();
    await dialog.getByTestId('create-go').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    const dataLeaks = directApiHits.filter((url) => !url.includes('/api/pairing/'));
    expect(dataLeaks).toEqual([]);
  });
});
