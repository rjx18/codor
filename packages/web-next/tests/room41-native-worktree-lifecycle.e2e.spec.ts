// harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-lifecycle-browser-regression
// harn:assume worktree-alias-and-child-metadata-follow-stable-identity ref=worktree-alias-browser-regression
// harn:assume worktree-child-default-roster-is-an-explicit-snapshot ref=child-default-roster-browser-regression
// harn:assume child-files-voice-and-keys-are-isolated ref=conversation-files-voice-key-regression
import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';
const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  // The connection pill lives on the channels surface; the mobile room surface
  // does not render it.
  const connection = page.getByTestId('connection');
  if (await connection.count() > 0) await expect(connection).toHaveText(/Connected/);
}

async function registered(room: string): Promise<{ id: string; alias: string; primary: boolean; conversation_id: string }[]> {
  const { registered: list } = await control<{
    registered: { id: string; alias: string; primary: boolean; conversation_id: string }[];
  }>('/wt-registered', { room });
  return list;
}

async function childMembers(page: Page, conversation: string): Promise<{ handle: string; kind: string; cwd?: string }[]> {
  const response = await page.request.get(`${API}/api/rooms/${conversation}/members`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    members: { member: { handle: string; kind: string; cwd?: string } }[];
  };
  return body.members.map((entry) => entry.member);
}

async function selectFirstChild(page: Page, room: string): Promise<{ id: string; conversation_id: string }> {
  const list = await registered(room);
  const child = list.find((worktree) => !worktree.primary);
  expect(child).toBeDefined();
  await page.getByTestId(`worktree-link-${child!.id}`).click();
  await expect(page.getByTestId(`worktree-link-${child!.id}`)).toHaveAttribute('aria-current', 'page');
  return child!;
}

test.describe('native worktree lifecycle UI', () => {
  test('adopts one discovered candidate from the explicit pre-promotion entry', async ({ page }) => {
    await control('/wt-ops-reset');
    await openRoom(page, `/?room=wtops&token=${TOKEN}`);
    // Unpromoted: no group, but the confirmed Git context offers BOTH
    // lifecycle starts while the group stays hidden.
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('worktree-entry-create')).toBeVisible();
    await expect(page.getByTestId('worktree-entry')).toBeVisible();
    await page.getByTestId('worktree-entry').click();

    const dialog = page.getByTestId('worktree-find-dialog');
    await expect(dialog).toBeVisible();
    // Discovery ran only now, on explicit open.
    const candidate = page.getByTestId(/^worktree-candidate-feature\/found/);
    await expect(candidate).toBeVisible();
    await candidate.click();
    // Adoption requires a NONEMPTY alias: clearing the prefill disables the
    // act until the operator names the child deliberately.
    await page.getByTestId('worktree-adopt-alias').fill('');
    await expect(page.getByTestId('worktree-adopt-submit')).toBeDisabled();
    await page.getByTestId('worktree-adopt-alias').fill('Found Review');
    await expect(page.getByTestId('worktree-adopt-submit')).toBeEnabled();
    await page.getByTestId('worktree-adopt-submit').click();

    // Promotion follows the one selected adoption; the child is selected.
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    const list = await registered('wtops');
    const adopted = list.find((worktree) => worktree.alias === 'found-review');
    expect(adopted).toBeDefined();
    expect(page.url()).toContain(`worktree=${adopted!.id}`);
  });

  test('creates the first child directly from the confirmed pre-promotion entry', async ({ page }) => {
    await control('/wt-ops-reset');
    const suffix = String(Date.now());
    await openRoom(page, `/?room=wtops&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);
    await page.getByTestId('context-tab-diff').click();

    // First Create without ANY prior adoption: the group appears only after
    // the creation promotes the root.
    await page.getByTestId('worktree-entry-create').click();
    const createDialog = page.getByTestId('worktree-create-dialog');
    await expect(createDialog).toBeVisible();
    await page.getByTestId('worktree-create-alias').fill(`First ${suffix}`);
    await page.getByTestId('worktree-create-branch').fill(`feature/first-${suffix}`);
    const target = await control<{ path: string }>('/wt-ops-target', { name: `created-first-${suffix}` });
    await page.getByTestId('worktree-create-path').fill(target.path);
    await page.getByTestId('worktree-create-submit').click();
    await expect(createDialog).toHaveCount(0);

    // The first creation promotes the group and selects the new child.
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    const list = await registered('wtops');
    const created = list.find((worktree) => worktree.alias === `first-${suffix.toLowerCase()}`);
    expect(created).toBeDefined();
    expect(page.url()).toContain(`worktree=${created!.id}`);
    await expect(page.getByTestId(`worktree-link-${created!.id}`)).toHaveAttribute('aria-current', 'page');

    // Promoted now: the pre-promotion entries are gone from the (child's)
    // confirmed Git context; the group owns the controls.
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('worktree-entry')).toHaveCount(0);
    await expect(page.getByTestId('worktree-entry-create')).toHaveCount(0);
    await expect(page.getByTestId('worktree-create-open')).toBeVisible();
  });

  test('creates an empty child and adds an individual preset agent afterwards', async ({ page }) => {
    await control('/wt-ops-reset');
    const suffix = String(Date.now());
    const preset = await page.request.post(`${API}/api/agent-presets`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      data: { label: `Ops helper ${suffix}`, handle: `ops-helper-${suffix.slice(-6)}`, harness: 'fake', policy: 'workspace-write' },
    });
    expect(preset.status()).toBe(201);

    await openRoom(page, `/?room=wtops&token=${TOKEN}`);
    // Group controls appear once promoted (the harness seeds promotion via the
    // first adoption below). Adopt first, then create from the group.
    await page.getByTestId('context-tab-diff').click();
    await page.getByTestId('worktree-entry').click();
    await page.getByTestId(/^worktree-candidate-feature\/found/).click();
    await page.getByTestId('worktree-adopt-submit').click();
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    await page.getByTestId('worktree-create-open').click();
    const createDialog = page.getByTestId('worktree-create-dialog');
    await expect(createDialog).toBeVisible();
    await page.getByTestId('worktree-create-alias').fill(`Empty ${suffix}`);
    await page.getByTestId('worktree-create-branch').fill(`feature/empty-${suffix}`);
    await page.getByTestId('worktree-create-path').fill(`${await opsTarget(page, `created-empty-${suffix}`)}`);
    await page.getByTestId('worktree-create-submit').click();
    await expect(createDialog).toHaveCount(0);

    const list = await registered('wtops');
    const created = list.find((worktree) => worktree.alias === `empty-${suffix.toLowerCase()}`);
    expect(created).toBeDefined();
    // Omission: an agent-empty child.
    expect((await childMembers(page, created!.conversation_id)).filter((member) => member.kind === 'agent'))
      .toEqual([]);

    // Later Add agent keeps using the existing individual-preset flow.
    await page.getByTestId(`worktree-link-${created!.id}`).click();
    await page.getByTestId('context-tab-members').click();
    await page.getByTestId('spawn-agent').click();
    const spawn = page.getByTestId('spawn-dialog');
    await expect(spawn).toBeVisible();
    await spawn.getByRole('button', { name: `Ops helper ${suffix} preset` }).click();
    await spawn.getByTestId('spawn-go').click();
    await expect(spawn).toHaveCount(0);
    await expect.poll(async () =>
      (await childMembers(page, created!.conversation_id))
        .filter((member) => member.kind === 'agent').length,
    { timeout: 15_000 }).toBe(1);
  });

  test('seeds only the new child from the accepted default roster', async ({ page }) => {
    await control('/wt-ops-reset');
    const suffix = String(Date.now());
    const handle = `roster-kid-${suffix.slice(-6)}`;
    const preset = await page.request.post(`${API}/api/agent-presets`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      data: { label: `Roster kid ${suffix}`, handle, harness: 'fake', policy: 'workspace-write' },
    });
    expect(preset.status()).toBe(201);
    const presetId = ((await preset.json()) as { preset: { id: string } }).preset.id;
    const roster = await page.request.put(`${API}/api/default-roster`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      data: { preset_ids: [presetId] },
    });
    expect(roster.status()).toBe(200);

    await openRoom(page, `/?room=wtops&token=${TOKEN}`);
    await page.getByTestId('context-tab-diff').click();
    await page.getByTestId('worktree-entry').click();
    await page.getByTestId(/^worktree-candidate-feature\/found/).click();
    await page.getByTestId('worktree-adopt-submit').click();
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    const createPayloads: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/rooms/wtops/worktrees') && request.method() === 'POST') {
        createPayloads.push(request.postDataJSON());
      }
    });
    await page.getByTestId('worktree-create-open').click();
    await expect(page.getByTestId('worktree-create-roster-select')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('worktree-create-alias').fill(`Seeded ${suffix}`);
    await page.getByTestId('worktree-create-branch').fill(`feature/seeded-${suffix}`);
    await page.getByTestId('worktree-create-path').fill(`${await opsTarget(page, `created-seeded-${suffix}`)}`);
    await page.getByTestId('worktree-create-roster-select').click();
    await page.getByTestId('worktree-create-submit').click();
    await expect(page.getByTestId('worktree-create-dialog')).toHaveCount(0);

    expect(createPayloads.at(-1)).toMatchObject({ default_roster: true });
    const list = await registered('wtops');
    const created = list.find((worktree) => worktree.alias === `seeded-${suffix.toLowerCase()}`);
    expect(created).toBeDefined();
    const members = (await childMembers(page, created!.conversation_id))
      .filter((member) => member.kind === 'agent');
    expect(members.map((member) => member.handle)).toEqual([handle]);
    // Detached snapshot at the canonical child cwd; main stays unseeded.
    expect(members[0]!.cwd).toBeDefined();
    const main = list.find((worktree) => worktree.primary)!;
    expect((await childMembers(page, main.conversation_id)).filter((member) => member.kind === 'agent'))
      .toEqual([]);

    await page.request.put(`${API}/api/default-roster`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      data: { preset_ids: [] },
    });
  });

  test('renames a selected child without moving its URL, transcript, or members', async ({ page }) => {
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    const child = await selectFirstChild(page, 'workspace');
    const urlBefore = page.url();
    const membersBefore = await childMembers(page, child.conversation_id);

    await page.getByTestId(`worktree-manage-${child.id}`).click();
    await page.getByTestId('worktree-rename-input').fill('Renamed Review');
    await page.getByTestId('worktree-rename-submit').click();
    await expect(page.getByTestId('worktree-child-dialog')).toHaveCount(0);

    // The row relabels; the stable selector, transcript, and members stay.
    await expect(page.getByTestId(`worktree-link-${child.id}`)).toContainText('renamed-review');
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByTestId('timeline')).toContainText('review notes live in the child conversation');
    expect(await childMembers(page, child.conversation_id)).toEqual(membersBefore);

    // Restore the seeded alias for the other specs.
    await page.getByTestId(`worktree-manage-${child.id}`).click();
    await page.getByTestId('worktree-rename-input').fill('review');
    await page.getByTestId('worktree-rename-submit').click();
    await expect(page.getByTestId('worktree-child-dialog')).toHaveCount(0);
  });

  test('unregisters with a fallback to main and removes cleanly with branch survival', async ({ page }) => {
    await control('/wt-ops-reset');
    const suffix = String(Date.now());
    await openRoom(page, `/?room=wtops&token=${TOKEN}`);
    await page.getByTestId('context-tab-diff').click();
    await page.getByTestId('worktree-entry').click();
    await page.getByTestId(/^worktree-candidate-feature\/found/).click();
    await page.getByTestId('worktree-adopt-submit').click();
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // Create a child whose removal we can prove branch-preserving.
    await page.getByTestId('worktree-create-open').click();
    await page.getByTestId('worktree-create-alias').fill(`Doomed ${suffix}`);
    await page.getByTestId('worktree-create-branch').fill(`feature/doomed-${suffix}`);
    await page.getByTestId('worktree-create-path').fill(`${await opsTarget(page, `created-doomed-${suffix}`)}`);
    await page.getByTestId('worktree-create-submit').click();
    await expect(page.getByTestId('worktree-create-dialog')).toHaveCount(0);
    const list = await registered('wtops');
    const doomed = list.find((worktree) => worktree.alias === `doomed-${suffix.toLowerCase()}`);
    expect(doomed).toBeDefined();

    await page.getByTestId(`worktree-link-${doomed!.id}`).click();
    await page.getByTestId(`worktree-manage-${doomed!.id}`).click();
    await expect(page.getByTestId('worktree-preview-state')).toContainText(/Clean/, { timeout: 15_000 });
    await page.getByTestId('worktree-remove-open').click();
    await page.getByTestId('worktree-remove-submit').click();
    await expect(page.getByTestId('worktree-child-dialog')).toHaveCount(0);

    // Removed: the row is gone, the selector fell back to main, the branch survived.
    await expect(page.getByTestId(`worktree-link-${doomed!.id}`)).toHaveCount(0);
    expect(page.url()).not.toContain('worktree=');
    const branch = await control<{ exists: boolean }>('/wt-branch', { room: 'wtops', branch: `feature/doomed-${suffix}` });
    expect(branch.exists).toBe(true);

    // Unregister of the adopted child is a separate, non-destructive act.
    const adopted = (await registered('wtops')).find((worktree) => !worktree.primary);
    expect(adopted).toBeDefined();
    await page.getByTestId(`worktree-manage-${adopted!.id}`).click();
    await page.getByTestId('worktree-unregister-open').click();
    await page.getByTestId('worktree-unregister-submit').click();
    await expect(page.getByTestId('worktree-child-dialog')).toHaveCount(0);
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);
  });

  test('refuses a dirty removal truthfully in the preview', async ({ page }) => {
    await page.request.post(`${CONTROL}/wt-dirty`);
    try {
      await openRoom(page, `/?room=workspace&token=${TOKEN}`);
      const child = await selectFirstChild(page, 'workspace');
      await page.getByTestId(`worktree-manage-${child.id}`).click();
      await expect(page.getByTestId('worktree-preview-state')).toContainText(/dirty/, { timeout: 15_000 });
      await expect(page.getByTestId('worktree-preview-state')).toContainText('branch is always preserved');
      await expect(page.getByTestId('worktree-remove-open')).toBeDisabled();
      await page.keyboard.press('Escape');
    } finally {
      await page.request.post(`${CONTROL}/wt-clean`);
    }
  });

  test('keeps dialogs usable at 390px with Escape and focus return', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await page.getByTestId('mobile-back').click();
    await page.getByTestId('worktree-create-open').click();
    const dialog = page.getByTestId('worktree-create-dialog');
    await expect(dialog).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('worktree-create-open')).toBeFocused();
  });

  test('serves the registered projection over a separate-origin relay tunnel', async ({ page }) => {
    test.setTimeout(120_000);
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
    await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
      const data = new DataTransfer();
      data.setData('text/plain', pasted);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });

    await page.goto(`${SPA_ORIGIN}/?room=workspace`);
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('worktree-group')).toBeVisible({ timeout: 30_000 });

    // Pre-promotion access rides the same tunnel: the bounded Git read
    // confirms the repository, BOTH entries appear, and explicit discovery
    // runs — all without a single escaped direct API request.
    await control('/wt-ops-reset');
    await page.goto(`${SPA_ORIGIN}/?room=wtops`);
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('worktree-entry')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('worktree-entry-create')).toBeVisible();
    await page.getByTestId('worktree-entry').click();
    await expect(page.getByTestId(/^worktree-candidate-feature\/found/)).toBeVisible({ timeout: 30_000 });
    expect(directApiHits).toEqual([]);
  });
});

async function opsTarget(page: Page, name: string): Promise<string> {
  // The create target must be an absolute, not-yet-existing path beside the
  // harness's disposable repository.
  const response = await page.request.get(`${API}/api/rooms/wtops/worktrees/registered`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const body = (await response.json()) as { repository: { primary_path: string } | null };
  expect(body.repository).not.toBeNull();
  const root = body.repository!.primary_path.replace(/\/[^/]+$/, '');
  return `${root}/${name}`;
}
// harn:end child-files-voice-and-keys-are-isolated
// harn:end worktree-child-default-roster-is-an-explicit-snapshot
// harn:end worktree-alias-and-child-metadata-follow-stable-identity
// harn:end worktree-lifecycle-ui-is-explicit-and-recoverable
