import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;

async function openRoom(page: Page, room = ROOM): Promise<void> {
  await page.goto(room);
  await expect(page.getByTestId('timeline')).toBeVisible();
  const connection = page.getByTestId('connection');
  if (await connection.count() > 0) await expect(connection).toHaveText(/Connected/);
}

async function openSpawn(page: Page, expectedPresetLabel = 'Saved native helper') {
  const mobileKebab = page.getByTestId('mobile-kebab');
  if (await mobileKebab.count() > 0) {
    await mobileKebab.click();
    await page.getByTestId('mobile-context').getByTestId('spawn-agent').click();
  } else {
    await page.getByTestId('spawn-agent').click();
  }
  const dialog = page.getByTestId('spawn-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: `${expectedPresetLabel} preset` })).toBeVisible();
  return dialog;
}

async function presetId(tile: ReturnType<Page['getByTestId']>): Promise<string> {
  const testid = await tile.getAttribute('data-testid');
  expect(testid).toMatch(/^spawn-preset-[0-9A-HJKMNP-TV-Z]{26}$/);
  return testid!.slice('spawn-preset-'.length);
}

async function deletePreset(page: Page, id: string): Promise<void> {
  const response = await page.request.delete(`${API}/api/agent-presets/${id}`, {
    headers: { authorization: 'Bearer next-e2e-token' },
  });
  expect(response.status()).toBe(204);
}

async function createNativePreset(page: Page, label: string): Promise<string> {
  const response = await page.request.post(`${API}/api/agent-presets`, {
    headers: { authorization: 'Bearer next-e2e-token' },
    data: {
      label,
      handle: `phone-${Date.now()}`,
      harness: 'fake',
      policy: 'workspace-write',
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { preset: { id: string } };
  return body.preset.id;
}

function sentFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const payload = frame.payload;
      frames.push(typeof payload === 'string' ? payload : payload.toString());
    });
  });
  return frames;
}

function spawnFrameFor(frames: readonly string[], handle: string): Record<string, unknown> {
  const match = frames
    .map((frame) => {
      try { return JSON.parse(frame) as Record<string, unknown>; } catch { return undefined; }
    })
    .find((frame) => {
      const act = frame?.act as Record<string, unknown> | undefined;
      return frame?.type === 'act' && act?.act === 'spawn' && act.handle === handle;
    });
  expect(match, `a single spawn act for @${handle}`).toBeDefined();
  return match!.act as Record<string, unknown>;
}

test.describe('Phase 2 individual preset Add agent integration', () => {
  test('fresh native selection maps into one editable spawn act and snapshots display name', async ({ page }) => {
    const frames = sentFrames(page);
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Saved native helper preset' });
    const id = await presetId(tile);
    let detailReads = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/agent-presets/${id}`) detailReads += 1;
    });

    await dialog.getByTestId('spawn-purpose').fill('keep this per-add purpose');
    await tile.click();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('saved-native');
    await expect(dialog.getByTestId('spawn-display-name')).toHaveValue('Saved Native');
    await expect(dialog.getByTestId('spawn-policy-workspace-write')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-purpose')).toHaveValue('keep this per-add purpose');
    expect(detailReads).toBe(1);

    await dialog.getByTestId('spawn-handle').fill('native-phase2');
    await dialog.getByTestId('spawn-display-name').fill('Edited Native');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-native-phase2')).toBeVisible({ timeout: 15_000 });

    const act = spawnFrameFor(frames, 'native-phase2');
    expect(frames.filter((frame) => frame.includes('"act":"spawn"') && frame.includes('native-phase2'))).toHaveLength(1);
    expect(act).toMatchObject({ harness: 'fake', handle: 'native-phase2', display_name: 'Edited Native' });
    expect(act).not.toHaveProperty('preset_id');
    expect(act).not.toHaveProperty('roster_id');
  });

  test('named ACP presets use the existing safe selector mapping', async ({ page }) => {
    const frames = sentFrames(page);
    await openRoom(page);
    let dialog = await openSpawn(page);

    const named = dialog.getByRole('button', { name: 'Kimi saved helper preset' });
    await named.click();
    await expect(dialog.getByTestId('spawn-harness-acp:kimi')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-model-input')).toHaveCount(0);
    await dialog.getByTestId('spawn-handle').fill('preset-kimi');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-preset-kimi')).toBeVisible({ timeout: 15_000 });
    const namedAct = spawnFrameFor(frames, 'preset-kimi');
    expect(namedAct).toMatchObject({ harness: 'acp', acp_provider: 'kimi' });
    expect(namedAct).not.toHaveProperty('acp_launch');
  });

  test('custom ACP selection sends a structured launch and no storage reference', async ({ page }) => {
    const frames = sentFrames(page);
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByRole('button', { name: 'Custom saved helper preset' }).click();
    await expect(dialog.getByTestId('spawn-acp-executable')).not.toHaveValue('');
    await dialog.getByTestId('spawn-handle').fill('preset-custom');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-preset-custom')).toBeVisible({ timeout: 15_000 });
    const customAct = spawnFrameFor(frames, 'preset-custom');
    expect(customAct.harness).toBe('acp');
    expect(customAct).toHaveProperty('acp_launch');
    expect(customAct).not.toHaveProperty('acp_provider');
    expect(customAct).not.toHaveProperty('preset_id');
  });

  test('malformed addressed data leaves the current draft untouched and reports a recoverable error', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Model helper preset' });
    const id = await presetId(tile);
    await dialog.getByTestId('spawn-handle').fill('keep-malformed');
    await dialog.getByTestId('spawn-purpose').fill('keep purpose');
    await page.route(`${API}/api/agent-presets/${id}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ preset: { id, label: '' } }),
      });
    });
    await tile.click();
    await expect(dialog.getByTestId('spawn-preset-error')).toBeVisible();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('keep-malformed');
    await expect(dialog.getByTestId('spawn-purpose')).toHaveValue('keep purpose');
    await page.unroute(`${API}/api/agent-presets/${id}`);
  });

  test('a stale model catalog rejects a preset without partial mutation', async ({ page }) => {
    await page.route('**/api/adapters', async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { adapters: { id: string; models?: string[] }[]; discovering?: boolean };
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...body,
          adapters: body.adapters.map((adapter) => adapter.id === 'thinky'
            ? { ...adapter, models: ['thinky/other'] }
            : adapter),
        }),
      });
    });
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Model helper preset' });
    await dialog.getByTestId('spawn-handle').fill('keep-stale');
    await tile.click();
    await expect(dialog.getByTestId('spawn-preset-error')).toBeVisible();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('keep-stale');
    await page.unroute('**/api/adapters');
  });

  test('a built-in choice supersedes a delayed custom selection', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Saved native helper preset' });
    const id = await presetId(tile);
    const detailUrl = `${API}/api/agent-presets/${id}`;
    let release!: () => void;
    let requestStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    const detailStarted = new Promise<void>((resolve) => { requestStarted = resolve; });
    await page.route(detailUrl, async (route) => {
      requestStarted();
      await responseGate;
      await route.continue();
    });

    try {
      await tile.click();
      await detailStarted;
      await expect(tile).toBeDisabled();
      await dialog.getByTestId('spawn-preset-reviewer').click();
      await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/reviewer/);
      await expect(tile).toBeEnabled();
      release();
      await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/reviewer/);
      await expect(dialog.getByTestId('spawn-preset-error')).toHaveCount(0);
    } finally {
      release();
      await page.unroute(detailUrl);
    }
  });

  test('manual edits and submission supersede a delayed custom selection without an extra act', async ({ page }) => {
    const frames = sentFrames(page);
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Saved native helper preset' });
    const id = await presetId(tile);
    const detailUrl = `${API}/api/agent-presets/${id}`;
    let release!: () => void;
    let requestStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    const detailStarted = new Promise<void>((resolve) => { requestStarted = resolve; });
    await page.route(detailUrl, async (route) => {
      requestStarted();
      await responseGate;
      await route.continue();
    });

    try {
      await tile.click();
      await detailStarted;
      await dialog.getByTestId('spawn-handle').fill('manual-race');
      await dialog.getByTestId('spawn-display-name').fill('Manual Race');
      await dialog.getByTestId('spawn-purpose').fill('keep manual values');
      await expect(tile).toBeEnabled();
      await dialog.getByTestId('spawn-go').click();
      await expect(page.getByTestId('member-manual-race')).toBeVisible({ timeout: 15_000 });
      const act = spawnFrameFor(frames, 'manual-race');
      expect(act).toMatchObject({ handle: 'manual-race', display_name: 'Manual Race', purpose: 'keep manual values' });
      expect(frames.filter((frame) => frame.includes('"act":"spawn"') && frame.includes('manual-race'))).toHaveLength(1);
      release();
      await expect(page.getByTestId('spawn-dialog')).toBeHidden();
      expect(frames.filter((frame) => frame.includes('"act":"spawn"') && frame.includes('manual-race'))).toHaveLength(1);
    } finally {
      release();
      await page.unroute(detailUrl);
    }
  });

  test('a schema-valid mismatched detail response is rejected without partial mutation', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Saved native helper preset' });
    const id = await presetId(tile);
    const otherId = await presetId(dialog.getByRole('button', { name: 'Model helper preset' }));
    const otherResponse = await page.request.get(`${API}/api/agent-presets/${otherId}`, {
      headers: { authorization: 'Bearer next-e2e-token' },
    });
    expect(otherResponse.status()).toBe(200);
    const otherBody = await otherResponse.json() as { preset: Record<string, unknown> };
    const detailUrl = `${API}/api/agent-presets/${id}`;
    await page.route(detailUrl, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ preset: { ...otherBody.preset, id: otherId } }),
    }));

    try {
      await dialog.getByTestId('spawn-handle').fill('keep-mismatched');
      await dialog.getByTestId('spawn-purpose').fill('keep mismatch purpose');
      await tile.click();
      await expect(dialog.getByTestId('spawn-preset-error')).toContainText(/did not match requested preset/i);
      await expect(dialog.getByTestId('spawn-handle')).toHaveValue('keep-mismatched');
      await expect(dialog.getByTestId('spawn-purpose')).toHaveValue('keep mismatch purpose');
      await expect(dialog.getByTestId('spawn-display-name')).toHaveValue('');
    } finally {
      await page.unroute(detailUrl);
    }
  });

  test('a selected preset keeps the ordinary spawn failure recovery path', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByRole('button', { name: 'Saved native helper preset' }).click();
    await expect(dialog.getByTestId('spawn-display-name')).toHaveValue('Saved Native');
    await dialog.getByTestId('spawn-purpose').fill('preserve this purpose');
    await dialog.getByTestId('spawn-display-name').fill('Edited before failure');
    await dialog.getByTestId('spawn-handle').fill('all');
    await dialog.getByTestId('spawn-go').click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('spawn-error')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('all');
    await expect(dialog.getByTestId('spawn-display-name')).toHaveValue('Edited before failure');
    await expect(dialog.getByTestId('spawn-purpose')).toHaveValue('preserve this purpose');
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
  });

  test('deleting a preset after selection cannot change the detached draft', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Custom saved helper preset' });
    const id = await presetId(tile);
    await tile.click();
    await expect(dialog.getByTestId('spawn-display-name')).toHaveValue('Custom Helper');
    await deletePreset(page, id);
    await dialog.getByTestId('spawn-display-name').fill('Detached Custom');
    await dialog.getByTestId('spawn-handle').fill('detached-custom');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-detached-custom')).toBeVisible({ timeout: 15_000 });
  });

  test('deletion between list and selection reports the addressed 404 without changing the draft', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const tile = dialog.getByRole('button', { name: 'Saved native helper preset' });
    const id = await presetId(tile);
    await dialog.getByTestId('spawn-handle').fill('keep-deleted');
    await deletePreset(page, id);
    await tile.click();
    await expect(dialog.getByTestId('spawn-preset-error')).toContainText(/404|no such agent preset/i);
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('keep-deleted');
  });

  test('built-ins remain usable through saved-preset loading failure and keyboard selection works', async ({ page }) => {
    await page.route('**/api/agent-presets', (route) => route.abort());
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('spawn-preset-reviewer')).toBeVisible();
    await expect(dialog.getByTestId('spawn-preset-error')).toBeVisible();
    await dialog.getByTestId('spawn-preset-reviewer').focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/reviewer/);
    await page.unroute('**/api/agent-presets');
  });

  test('underprivileged members have no Add agent trigger and make no preset request', async ({ page }) => {
    const presetRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/agent-presets')) presetRequests.push(request.url());
    });
    await openRoom(page, '/?room=eng&token=next-e2e-viewer-token');
    await expect(page.getByTestId('spawn-agent')).toHaveCount(0);
    expect(presetRequests).toEqual([]);
  });

  test('the saved-preset dialog is axe-clean and its tiles fit at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const label = `Phone geometry helper ${Date.now()}`;
    const id = await createNativePreset(page, label);
    await openRoom(page);
    const dialog = await openSpawn(page, label);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    for (const tile of await dialog.locator('.nx-custom-preset').all()) {
      const box = await tile.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.right ?? 0).toBeLessThanOrEqual(390);
    }
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    await deletePreset(page, id);
  });
});
