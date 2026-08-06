import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
const DIRECT_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const OWNER = 'next-e2e-token';

type FixturePreset = {
  id: string;
  label: string;
  handle: string;
  display_name?: string;
};

type Phase5Fixture = {
  a: { presets: FixturePreset[]; roster: FixturePreset[] };
  b: { presets: FixturePreset[]; roster: FixturePreset[] };
};

type Phase5Summary = Phase5Fixture & {
  host: 'a' | 'b';
  rooms: Array<{
    id: string;
    missing?: boolean;
    members?: Array<{ handle: string; display_name?: string; task_ids: string[] }>;
    run_count?: number;
  }>;
};

async function control<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return await response.json() as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: data,
    }));
  }, code);
}

async function openDirectRoom(page: Page): Promise<void> {
  await page.goto(`${DIRECT_ORIGIN}/?room=eng&token=${OWNER}`);
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
  const connection = page.getByTestId('connection');
  if (await connection.count() > 0) await expect(connection).toHaveText(/Connected/);
}

async function openSpawn(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('spawn-agent').click();
  const dialog = page.getByTestId('spawn-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openRosterChannel(
  page: Page,
  name: string,
  expected: readonly FixturePreset[],
  hidden: readonly FixturePreset[],
): Promise<string> {
  await page.getByTestId('create-room').click();
  const dialog = page.getByTestId('create-channel-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('create-name').fill(name);
  await dialog.getByTestId('create-folder-alpha-project').click();
  await dialog.getByTestId('create-roster-select').click();
  const summary = dialog.getByTestId('create-roster-select').locator('.nx-roster-choice-copy > span');
  await expect(summary).toHaveText(expected.map((preset) => `@${preset.handle}`).join(' · '));
  for (const preset of hidden) await expect(summary).not.toContainText(`@${preset.handle}`);
  await expect(dialog.getByTestId('create-roster-select')).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByTestId('create-go').click();
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await expect(page).toHaveURL(new RegExp(`[?&]room=${slug}(?:&|$)`), { timeout: 30_000 });
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
  const room = new URL(page.url()).searchParams.get('room');
  expect(room).toBeTruthy();
  return room!;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByTestId('agent-preset-settings')).toBeVisible({ timeout: 30_000 });
}

async function assertSettingsHost(page: Page, expected: Phase5Fixture['a'], hidden: Phase5Fixture['b']): Promise<void> {
  for (const preset of expected.presets) await expect(page.getByTestId(`preset-row-${preset.id}`)).toBeVisible();
  for (const preset of hidden.presets) await expect(page.getByTestId(`preset-row-${preset.id}`)).toHaveCount(0);
  const rows = await page.getByTestId('roster-list').locator('.nx-roster-row').evaluateAll(
    (items) => items.map((item) => item.getAttribute('data-testid')),
  );
  expect(rows).toEqual(expected.roster.map((preset) => `roster-row-${preset.id}`));
}

async function roomId(page: Page): Promise<string> {
  const id = new URL(page.url()).searchParams.get('room');
  expect(id).toBeTruthy();
  return id!;
}

function memberHandles(summary: Phase5Summary, id: string): string[] {
  return summary.rooms.find((room) => room.id === id)?.members?.map((member) => member.handle) ?? [];
}

async function switchComputer(page: Page, label: string): Promise<void> {
  const current = page.getByTestId('computer-current');
  await expect(current).toBeVisible();
  await current.click();
  const menu = page.locator('.nx-computer-menu');
  await expect(menu).toBeVisible();
  const item = menu.locator('li', { hasText: label });
  await expect(item).toBeVisible();
  await item.getByRole('button').first().click();
  await expect(page.getByTestId('computer-current')).toHaveText(new RegExp(label));
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

// harn:assume hosted-preset-state-follows-only-the-active-computer ref=hosted-preset-active-computer-regression
test.describe('Phase 5 preset, roster, and computer isolation', () => {
  test('direct mode shows only computer A and keeps native Add/channel behavior', async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = await control<Phase5Fixture>('/phase5-fixture');

    await openDirectRoom(page);
    expect(await page.getByTestId('computer-switcher').count()).toBe(0);
    const spawn = await openSpawn(page);
    for (const preset of fixture.a.presets) {
      await expect(spawn.getByRole('button', { name: `${preset.label} preset` })).toBeVisible();
    }
    for (const preset of fixture.b.presets) {
      await expect(spawn.getByRole('button', { name: `${preset.label} preset` })).toHaveCount(0);
    }
    await spawn.getByRole('button', { name: `${fixture.a.presets[0]!.label} preset` }).click();
    await spawn.getByTestId('spawn-handle').fill(fixture.a.presets[0]!.handle);
    await spawn.getByTestId('spawn-go').click();
    await expect(page.getByTestId(`member-${fixture.a.presets[0]!.handle}`)).toBeVisible({ timeout: 30_000 });

    await openRosterChannel(page, 'P5 A roster channel', fixture.a.roster, fixture.b.roster);
    for (const preset of fixture.a.roster) {
      await expect(page.getByTestId(`member-${preset.handle}`)).toBeVisible({ timeout: 30_000 });
    }
    for (const preset of fixture.b.roster) {
      await expect(page.getByTestId(`member-${preset.handle}`)).toHaveCount(0);
    }

    await openSettings(page);
    await assertSettingsHost(page, fixture.a, fixture.b);
    expect(await page.getByTestId('computer-switcher').count()).toBe(0);
  });

  test('hosted preset and roster state follows the active paired computer only', async ({ page }) => {
    test.setTimeout(300_000);
    const fixture = await control<Phase5Fixture>('/phase5-fixture');
    const directApiHits: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(`${SPA_ORIGIN}/api/`)) directApiHits.push(request.url());
    });

    await control('/relay-up');
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((relayUrl) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = relayUrl;
    }, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText(/codor-host-a/);

    await control('/relay-up-b');
    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-current').click();
    await page.getByTestId('computer-add').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('computer-current')).toHaveText(/codor-host-b/);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await page.evaluate(() => {
      (window as unknown as { __phase5Document?: Document }).__phase5Document = document;
    });

    await openSettings(page);
    await assertSettingsHost(page, fixture.b, fixture.a);
    const editedLabel = 'P5 B East Edited';
    const editedId = fixture.b.presets[0]!.id;
    await page.getByTestId(`preset-edit-${editedId}`).click();
    await page.getByTestId('preset-label').fill(editedLabel);
    await page.getByTestId('preset-save').click();
    await expect(page.getByTestId(`preset-row-${editedId}`)).toContainText(editedLabel);
    await page.getByTestId(`roster-up-${fixture.b.presets[1]!.id}`).click();
    await page.getByTestId('roster-save').click();
    const bAfterEdit: Phase5Fixture['b'] = {
      presets: fixture.b.presets.map((preset, index) => index === 0 ? { ...preset, label: editedLabel } : preset),
      roster: [fixture.b.presets[1]!, fixture.b.presets[0]!],
    };

    await page.getByRole('link', { name: 'Back to the channel' }).click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    const spawn = await openSpawn(page);
    await expect(spawn.getByRole('button', { name: `${bAfterEdit.presets[0]!.label} preset` })).toBeVisible();
    for (const preset of fixture.a.presets) {
      await expect(spawn.getByRole('button', { name: `${preset.label} preset` })).toHaveCount(0);
    }
    await spawn.getByRole('button', { name: `${bAfterEdit.presets[0]!.label} preset` }).click();
    await spawn.getByTestId('spawn-handle').fill('p5-b-added');
    await spawn.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-p5-b-added')).toBeVisible({ timeout: 30_000 });
    if (await page.getByTestId('spawn-dialog').count() > 0) {
      await page.getByTestId('spawn-close').click();
    }

    // Switching is a same-document active-host change. A's settings remain its
    // own source/roster truth and never include B's edited preset.
    await switchComputer(page, 'codor-host-a');
    expect(await page.evaluate(() => (
      (window as unknown as { __phase5Document?: Document }).__phase5Document === document
    ))).toBe(true);
    await openSettings(page);
    await assertSettingsHost(page, fixture.a, bAfterEdit);
    await expect(page.getByText(editedLabel, { exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: 'Back to the channel' }).click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await switchComputer(page, 'codor-host-b');
    const bRosterRoom = await openRosterChannel(page, 'P5 B roster channel', bAfterEdit.roster, fixture.a.roster);
    for (const preset of bAfterEdit.roster) {
      await expect(page.getByTestId(`member-${preset.handle}`)).toBeVisible({ timeout: 30_000 });
    }
    for (const preset of fixture.a.roster) {
      await expect(page.getByTestId(`member-${preset.handle}`)).toHaveCount(0);
    }

    const bSummary = await control<Phase5Summary>('/phase5-summary', {
      host: 'b', rooms: ['eng', bRosterRoom],
    });
    expect(bSummary.presets.map((preset) => preset.label)).toEqual([editedLabel, fixture.b.presets[1]!.label]);
    expect(bSummary.roster.map((preset) => preset.id)).toEqual(bAfterEdit.roster.map((preset) => preset.id));
    expect(memberHandles(bSummary, 'eng')).toContain('p5-b-added');
    const bRosterHandles = memberHandles(bSummary, bRosterRoom);
    const expectedBHandles = bAfterEdit.roster.map((preset) => preset.handle);
    expect(bRosterHandles.filter((handle) => expectedBHandles.includes(handle)).sort())
      .toEqual([...expectedBHandles].sort());
    expect(bRosterHandles).not.toEqual(expect.arrayContaining(fixture.a.roster.map((preset) => preset.handle)));

    const aSummary = await control<Phase5Summary>('/phase5-summary', {
      host: 'a', rooms: ['eng', bRosterRoom],
    });
    expect(aSummary.presets.map((preset) => preset.label)).toEqual(fixture.a.presets.map((preset) => preset.label));
    expect(aSummary.roster.map((preset) => preset.id)).toEqual(fixture.a.roster.map((preset) => preset.id));
    expect(memberHandles(aSummary, 'eng')).not.toContain('p5-b-added');
    expect(aSummary.rooms.find((room) => room.id === bRosterRoom)?.missing).toBe(true);
    expect(directApiHits.filter((url) => !url.includes('/api/pairing/'))).toEqual([]);
  });
});
// harn:end hosted-preset-state-follows-only-the-active-computer
