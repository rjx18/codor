import { expect, test, type Page } from '@playwright/test';

import { BASE, CONTROL } from './ports.js';

test.use({ viewport: { width: 1440, height: 900 } });

async function control<T = { ok: boolean }>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
  return (await res.json()) as T;
}

declare global {
  interface Window {
    __codor: { disconnect(): void; reconnect(): void };
  }
}

test('history pages, room search, and #N permalinks share stable message ids', async ({ page }) => {
  const seeded = await control<HistorySeed>('/seed-history');
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await expect(page.getByTestId(`msg-${seeded.last}`)).toBeVisible();
  await expect(page.getByTestId(`msg-${seeded.first}`)).toHaveCount(0);
  await expect(page.getByTestId(`card-${seeded.approval}`)).toBeVisible();
  await loadCompleteHistory(page, seeded);

  await page.getByTestId('toggle-message-search').click();
  await page.locator('#room-search').fill('archive-entry-0001');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const result = page.getByTestId('search-results').getByRole('link', {
    name: `#${String(seeded.first)}`,
  });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(new RegExp(`#${String(seeded.first)}$`));
  const target = page.locator(`[id="${String(seeded.first)}"]`);
  await expect(target).toBeInViewport();
  const targetStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  expect(targetStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(targetStyle.shadow).toContain('inset');
});

test('ledger changes appear in the room and [[refs]] open a read-only note viewer', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await control('/ledger-init', { name: 'risk-limits', author: 'alpha' });
  await expect(page.getByText('@alpha updated [[risk-limits]]')).toBeVisible();
  await page.waitForTimeout(100);
  await control('/ledger-direct', { name: 'risk-limits', noteBody: 'Keep exposure below 1%.' });
  const notice = page.getByText('@operator updated [[risk-limits]]');
  await expect(notice).toBeVisible();
  const ledgerReference = notice.getByTestId('ledger-ref-risk-limits');
  await ledgerReference.click();
  const dialog = page.getByTestId('ledger-note-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Keep exposure below 1%.');
  await expect(dialog.getByRole('button', { name: 'Close ledger note' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(ledgerReference).toBeFocused();
});

test('ledger graph renders the vault projection and opens a read-only note inspector', async ({ page }) => {
  await control('/ledger-graph-init');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.getByTestId('open-ledger-graph').click();
  await expect(page).toHaveURL(/\/ledger\?room=eng$/);
  await expect(page.getByTestId('ledger-graph-page')).toBeVisible();

  const launch = page.getByTestId('ledger-node-launch-plan');
  const risk = page.getByTestId('ledger-node-risk-limits');
  await expect(launch).toBeVisible();
  await expect(risk).toBeVisible();
  const surface = (await page.getByTestId('ledger-graph-surface').boundingBox())!;
  expect(surface.width).toBeGreaterThan(500);
  expect(surface.height).toBeGreaterThan(500);
  const beforeZoom = await page.getByTestId('ledger-graph-surface').locator('svg > g').getAttribute('transform');
  await page.getByTestId('ledger-graph-surface').hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => page.getByTestId('ledger-graph-surface').locator('svg > g').getAttribute('transform'))
    .not.toBe(beforeZoom);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await risk.click();
  const inspector = page.getByTestId('ledger-inspector');
  await expect(inspector).toContainText('Risk Limits');
  await expect(inspector).toContainText('Keep exposure below 2%.');
  await expect(inspector).toContainText('Launch Plan');
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /delete|add note|create note/i })).toHaveCount(0);

  await page.getByPlaceholder('Search notes').fill('release');
  await expect(page.getByTestId('ledger-node-release-checklist')).toBeVisible();
  await expect(launch).toBeHidden();
  await page.getByRole('button', { name: 'Clear note search' }).click();
  await expect(launch).toBeVisible();

  await page.setViewportSize({ width: 1150, height: 820 });
  await page.reload();
  await expect(page.getByTestId('ledger-inspector')).toBeHidden();
  const intermediateNode = page.getByTestId('ledger-node-launch-plan');
  await intermediateNode.click();
  await expect(page.getByTestId('ledger-inspector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close note inspector' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ledger-inspector')).toBeHidden();
  await expect(intermediateNode).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1150);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId('ledger-node-launch-plan').click();
  const mobileInspector = (await page.getByTestId('ledger-inspector').boundingBox())!;
  expect(mobileInspector.x).toBe(0);
  expect(mobileInspector.width).toBe(390);
  expect(mobileInspector.y + mobileInspector.height).toBeCloseTo(844, 0);
  expect(mobileInspector.height).toBeLessThanOrEqual(844 * 0.58 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('room v1: post → live run → expand → ask → hold release → reconnect shows the finalized message', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');

  // hydrated over WS: room header, members, empty timeline
  await expect(page.getByTestId('member-alpha')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // invariant 3: the destination is literal in the draft, never a separate status line
  await expect(page.getByTestId('implied-recipient')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('@alpha pick the codeword');
  await expect(page.getByTestId('composer-input')).toHaveValue('@alpha pick the codeword');

  // 1. post → the run message appears LIVE (status running)
  await control('/enqueue', {
    turns: [{ kind: 'ask', prompt: 'Which codeword?', options: ['ALPHA', 'BETA'], replyPrefix: 'chose ' }],
  });
  await page.getByTestId('composer-send').click();
  const run = page.locator('[data-testid^="run-"][data-run-status]').first();
  await expect(run).toHaveAttribute('data-run-status', 'running');
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');
  await page.evaluate((id) => { window.location.hash = id; }, runId);
  expect(await run.evaluate((element) => getComputedStyle(element).boxShadow)).toContain('inset');

  // 2. live runs default expanded with journaled events from the redacted blob endpoint
  await expect(page.getByTestId(`run-${runId}-toggle`)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`run-${runId}-events`)).toBeVisible();

  // 3. the ask card raised by the blocked run → answer ALPHA from the room
  const alphaOption = page.locator('[data-testid$="-option-ALPHA"]');
  await expect(alphaOption).toBeVisible();
  const askCard = alphaOption.locator('xpath=ancestor::*[contains(@class, "wr-ask-card")]').first();
  const askId = (await askCard.getAttribute('id'))!;
  await page.evaluate((id) => { window.location.hash = id; }, askId);
  expect(await askCard.evaluate((element) => getComputedStyle(element).boxShadow)).toContain('inset');
  await alphaOption.click();

  // the SAME run message finalizes in place
  await expect(run).toHaveAttribute('data-run-status', 'completed');
  await expect(page.getByTestId(`run-${runId}-body`)).toHaveText('chose ALPHA');
  await expect(page.locator(`[data-testid="run-${runId}"]`)).toHaveCount(1);
  await expect(page.locator('[data-testid$="-option-ALPHA"]')).toBeDisabled();

  // 4. a held delivery surfaces in the banner; releasing it runs the turn
  await control('/enqueue', { turns: [{ kind: 'complete', final_text: 'released work done' }] });
  await control('/hold', {});
  await expect(page.getByTestId('hold-banner')).toBeVisible();
  await page.locator('[data-testid^="release-"]').click();
  await expect(page.getByTestId('hold-banner')).not.toBeVisible();
  await expect(page.getByText('released work done')).toBeVisible();

  // 5. disconnect DURING a run; the turn finalizes while we're away; the
  //    reconnect resubscribes with since_seq and shows the finalized message
  await control('/enqueue', {
    turns: [{ kind: 'ask', prompt: 'Second question?', options: ['YES', 'NO'], replyPrefix: 'said ' }],
  });
  await page.getByTestId('composer-input').fill('@alpha one more');
  await page.getByTestId('composer-send').click();
  const run2 = page.locator('[data-run-status="running"]').first();
  await expect(run2).toBeVisible();
  const run2Id = (await run2.getAttribute('data-testid'))!.replace('run-', '');

  await page.evaluate(() => window.__codor.disconnect());
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'disconnected');

  await control('/answer', { label: 'YES' }); // finalizes server-side, invisibly

  await page.evaluate(() => window.__codor.reconnect());
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // the seq test: the in-place finalization arrived through since_seq hydration
  await expect(page.getByTestId(`run-${run2Id}`)).toHaveAttribute('data-run-status', 'completed');
  await expect(page.getByTestId(`run-${run2Id}-body`)).toHaveText('said YES');
  await expect(page.locator(`[data-testid="run-${run2Id}"]`)).toHaveCount(1);

  // inbox badge: alpha's finalized replies defaulted back to richard? (they
  // were untagged → trigger author = richard) — badge shows unread items
  await expect(page.getByTestId('inbox-badge')).toBeVisible();
});

test('member rail: spawn → run → rename → kill → queued badge → revive', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('spawn-agent').click();
  await expect(page.getByTestId('spawn-dialog')).toBeVisible();
  await page.getByTestId('spawn-handle').fill('beta');
  await page.getByTestId('spawn-cwd').fill(process.cwd());
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-beta')).toBeVisible();
  await page.getByTestId('member-beta-toggle').click();

  await control('/enqueue', { turns: [{ kind: 'complete', final_text: '@richard beta ready' }] });
  await page.getByTestId('composer-input').fill('@beta initialize');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('@richard beta ready')).toBeVisible();

  await page.getByTestId('rename-beta').click();
  await page.getByTestId('rename-beta-handle').fill('gamma');
  await page.getByTestId('rename-beta-submit').click();
  await expect(page.getByTestId('member-gamma')).toBeVisible();

  await page.getByTestId('kill-gamma').click();
  await expect(page.getByTestId('revive-gamma')).toBeEnabled();
  await page.getByTestId('composer-input').fill('@gamma queued while dead');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('member-gamma-queued')).toHaveText('1 queued');

  await control('/enqueue', { turns: [{ kind: 'complete', final_text: '@richard revived work done' }] });
  await page.getByTestId('revive-gamma').click();
  await expect(page.getByText('@richard revived work done')).toBeVisible();
  await expect(page.getByTestId('member-gamma-history')).toContainText('dead > idle');
});

// harn:assume web-spawn-dialog-exposes-canonical-agent-controls ref=spawn-dialog-browser-regression
test('spawn dialog presets canonical controls and replaces removed agents', async ({ page, request }) => {
  const room = `spawn-controls-${String(Date.now())}`;
  const created = await request.post('/api/rooms', {
    headers: { authorization: 'Bearer e2e-token' },
    data: {
      id: room,
      name: 'Spawn controls',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
    },
  });
  expect(created.ok()).toBe(true);

  await page.route('**/api/adapters', async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { adapters: unknown[] };
    await route.fulfill({
      response,
      json: {
        adapters: [...payload.adapters, {
          id: 'opencode',
          capabilities: {
            resume: true,
            discover: true,
            interactiveAttach: false,
            ask: false,
            approvals: 'spawn-time',
            extensions: false,
            thinking: true,
          },
          // The harness reports its own models; the web hardcodes none.
          models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o'],
          models_source: 'discovered',
        }],
      },
    });
  });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('spawn-agent').click();
  await expect(page.getByTestId('spawn-dialog')).toBeVisible();
  await expect(page.getByTestId('spawn-cwd')).toHaveValue(process.cwd());
  await page.getByTestId('spawn-harness-opencode').click();
  await expect(page.getByTestId('spawn-harness-opencode')).toHaveAttribute('aria-pressed', 'true');
  // The models the harness itself reported become buttons — nothing is typed.
  await page.getByTestId('spawn-model-openai/gpt-4o').click();
  await expect(page.getByTestId('spawn-model-openai/gpt-4o')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('spawn-thinking-medium')).toBeEnabled();
  await expect(page.getByTestId('spawn-approval-hint')).toBeVisible();

  await page.getByTestId('spawn-harness-fake').click();
  // A model only means anything to the harness it was chosen under.
  await expect(page.getByTestId('spawn-model-default')).toHaveAttribute('aria-pressed', 'true');
  // The fake harness reports no models, so the operator still gets an escape.
  await expect(page.getByTestId('spawn-model-note')).toBeVisible();
  await page.getByTestId('spawn-model-custom').click();
  await page.getByTestId('spawn-model-custom-input').fill('kept/model');

  await page.getByTestId('spawn-preset-tester').click();
  await expect(page.getByTestId('spawn-harness-fake')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('spawn-handle')).toHaveValue('tester');
  await expect(page.getByTestId('spawn-purpose')).toHaveValue('Runs tests, reproduces bugs, reports results');
  // The policy lives in the ONE shared control now, not a select the dialog rolled itself.
  await expect(page.getByTestId('spawn-policy-workspace-write')).toHaveAttribute('aria-pressed', 'true');
  // And it says what the level actually becomes on this harness, read from the adapter.
  await expect(page.getByTestId('spawn-policy-full-access-native')).toHaveText('bypassPermissions');
  await expect(page.getByTestId('spawn-thinking-medium')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('spawn-thinking-medium')).toBeDisabled();
  await expect(page.getByTestId('spawn-approval-hint')).toHaveCount(0);

  await page.getByTestId('spawn-policy-workspace-write').click();
  await page.getByTestId('spawn-cwd').fill('/tmp');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-tester')).toBeVisible();
  const testerDetails = await request.get(`/api/rooms/${room}/members`, {
    headers: { authorization: 'Bearer e2e-token' },
  });
  expect(testerDetails.ok()).toBe(true);
  const testerMembers = await testerDetails.json() as {
    members: { member: { handle: string; cwd?: string } }[];
  };
  expect(testerMembers.members.find((item) => item.member.handle === 'tester')?.member.cwd).toBe('/tmp');

  await page.getByTestId('spawn-agent').click();
  await page.getByTestId('spawn-preset-tester').click();
  await expect(page.getByTestId('spawn-handle')).toHaveValue('tester-2');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-tester-2')).toBeVisible();

  await page.getByTestId('kill-tester').click();
  await expect(page.getByTestId('remove-tester')).toBeVisible();
  await page.getByTestId('remove-tester').click();
  // Removal is destructive, so it asks first — and names what it is about to destroy.
  await expect(page.getByTestId('remove-tester-confirm')).toContainText('@tester');
  await page.getByTestId('remove-tester-confirmed').click();
  await expect(page.getByTestId('member-tester')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Spawn controls' }).locator('..')).toContainText('2 members');

  await page.getByTestId('spawn-agent').click();
  await page.getByTestId('spawn-preset-tester').click();
  await expect(page.getByTestId('spawn-handle')).toHaveValue('tester');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-tester')).toBeVisible();
});
// harn:end web-spawn-dialog-exposes-canonical-agent-controls

test('parent run expands authoritative extension lifecycle and summary', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await control('/enqueue', {
    turns: [
      {
        kind: 'complete',
        final_text: '@richard extension parent done',
        items: [
          {
            type: 'run.item',
            item_type: 'tool_call',
            payload: {
              tool: 'Agent',
              id: 'toolu-agent-e2e',
              input: { description: 'Inspect cache invalidation' },
            },
          },
          {
            type: 'extension.started',
            parent: 'fake-session-1',
            ext_member: 'a4fdb5021f374a8d1',
            agent_type: 'general-purpose',
          },
          {
            type: 'extension.ended',
            ext_member: 'a4fdb5021f374a8d1',
            summary: 'PONG from extension',
            transcript_path: '/tmp/agent-a4fdb5021f374a8d1.jsonl',
          },
        ],
      },
    ],
  });
  await page.getByTestId('composer-input').fill('@alpha delegate a cache review');
  await page.getByTestId('composer-send').click();
  const body = page.getByText('@richard extension parent done');
  await expect(body).toBeVisible();
  const run = body.locator('..');
  const runId = await run.getAttribute('data-testid');
  await run.getByTestId(`${runId}-toggle`).click();

  await expect(page.getByTestId('member-alpha-ext-a4fdb5')).toBeVisible();
  await expect(page.getByTestId(`${runId}-extensions`)).toContainText('Inspect cache invalidation');
  await expect(page.getByTestId(`${runId}-extensions`)).toContainText('PONG from extension');
  await expect(page.getByTestId(`${runId}-extensions`)).toContainText('finished');
});

test('room settings persist opt-in brakes and meter labels uncosted tokens', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await page.getByTestId('room-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByRole('link', { name: 'Brakes', exact: true }).click();
  await page.getByTestId('turn-brake-enabled').check();
  await page.getByTestId('turn-brake-value').fill('0');
  await page.getByTestId('room-settings-save').click();
  await expect(page.getByText('Enter positive values for enabled brakes and the stall interval.')).toBeVisible();
  await page.getByTestId('turn-brake-value').fill('3');
  await page.getByTestId('stall-minutes').fill('12');
  await page.getByTestId('room-settings-save').click();
  await expect(page.getByText('Channel brake update requested.')).toBeVisible();

  await page.getByRole('link', { name: 'Back to channel' }).click();
  await page.getByTestId('room-settings').click();
  await page.getByRole('link', { name: 'Brakes', exact: true }).click();
  await expect(page.getByTestId('turn-brake-enabled')).toBeChecked();
  await expect(page.getByTestId('turn-brake-value')).toHaveValue('3');
  await expect(page.getByTestId('stall-minutes')).toHaveValue('12');
  await page.getByRole('link', { name: 'Relay', exact: true }).click();
  await page.getByTestId('open-relay-pairing').click();
  const relay = page.getByTestId('relay-pairing');
  await expect(relay).toBeVisible();
  for (const capability of [
    'Push gateway',
    'Rendezvous & NAT relay',
    'Encrypted mailbox',
    'Browser gateway',
    'Hosted integrations',
  ]) {
    await expect(relay.getByText(capability, { exact: true })).toBeVisible();
  }
  await expect(relay).toContainText('Relay never sees');
  await expect(relay).toContainText('$5/month hosted');
  expect(await page.evaluate(() => localStorage.getItem('codor-relay-pairing'))).toBeNull();
  await page.getByRole('link', { name: 'Back to channel' }).click();

  await control('/enqueue', {
    turns: [
      {
        kind: 'complete',
        final_text: '@richard tokens-only browser meter',
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    ],
  });
  await page.getByTestId('composer-input').fill('@alpha meter tokens without cost');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('@richard tokens-only browser meter')).toBeVisible();
  await expect(page.getByTestId('meter')).toContainText('tokens uncosted');
});

// harn:assume human-facing-surfaces-call-rooms-channels ref=web-channel-regression
// harn:assume web-shell-responsive-three-pane ref=responsive-shell-regression
test('desktop channel keeps channels, conversation, and context in stable non-overlapping panes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const rooms = page.getByTestId('room-rail');
  const conversation = page.getByTestId('room-view');
  const context = page.getByTestId('context-rail');
  await expect(rooms).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Rooms' })).toHaveCount(0);
  await expect(conversation).toBeVisible();
  await expect(context).toBeVisible();
  await expect(page.getByTestId('open-room-drawer')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('meter')).toBeVisible();

  const roomBox = (await rooms.boundingBox())!;
  const conversationBox = (await conversation.boundingBox())!;
  const contextBox = (await context.boundingBox())!;
  expect(roomBox.x + roomBox.width).toBeLessThanOrEqual(conversationBox.x + 0.5);
  expect(conversationBox.x + conversationBox.width).toBeLessThanOrEqual(contextBox.x + 0.5);
  // The approved three-pane desktop geometry: a fixed 288px channel rail and 400px context
  // rail, each floating with a 10px inset from the canvas edge.
  expect(Math.round(roomBox.width)).toBe(288);
  expect(Math.round(contextBox.width)).toBe(400);
  expect(Math.round(roomBox.x)).toBe(10);
  expect(Math.round(contextBox.x + contextBox.width)).toBe(1430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

  // Two-pane from 1024 to 1359: the 288px rail stays, the context rail is a drawer trigger.
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.reload();
  await expect(page.getByTestId('room-rail')).toBeVisible();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeVisible();
  expect(Math.round((await page.getByTestId('room-rail').boundingBox())!.width)).toBe(288);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);

  // 1023 is the single-column boundary: the rail collapses behind the off-canvas drawer.
  await page.setViewportSize({ width: 1023, height: 820 });
  await page.reload();
  await expect(page.getByTestId('room-rail')).toBeHidden();
  await expect(page.getByTestId('open-room-drawer')).toBeVisible();

  // 1359 is the two-pane ceiling: the context rail is still a trigger, not a floating pane.
  await page.setViewportSize({ width: 1359, height: 820 });
  await page.reload();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeVisible();

  // 1360 opens the third pane; the trigger gives way to the docked context rail.
  await page.setViewportSize({ width: 1360, height: 820 });
  await page.reload();
  await expect(page.getByTestId('context-rail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeHidden();

  // 720 is the content breakpoint: at 720 the ordinary message stays framed; at 719 it unframes
  // into the mobile prose timeline.
  await page.setViewportSize({ width: 720, height: 900 });
  await page.reload();
  await expect(page.locator('.wr-message').first()).not.toHaveClass(/is-unframed/);
  await page.setViewportSize({ width: 719, height: 900 });
  await page.reload();
  await expect(page.locator('.wr-message').first()).toHaveClass(/is-unframed/);
});
// harn:end web-shell-responsive-three-pane
// harn:end human-facing-surfaces-call-rooms-channels

// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-visual-regression
test('soft-editorial room floats matte panels, rounded cards and desktop avatars, and pins the latest turn across reflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // This asserts the dark glass material. The default is now light, so pin dark
  // explicitly rather than lean on it being the default; the light default is proven by
  // the light-first regression, not here.
  await page.addInitScript(() => localStorage.setItem('codor-theme', 'dark'));
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await control('/enqueue', {
    turns: [{ kind: 'complete', final_text: '@richard visual hierarchy ready' }],
  });
  await page.getByTestId('composer-input').fill('@alpha verify the glass hierarchy');
  await page.getByTestId('composer-send').click();

  const run = page.locator('.wr-run-card').first();
  const message = page.locator('.wr-message').first();
  await expect(run).toBeVisible();
  await expect(message).toBeVisible();
  const hierarchy = await page.evaluate(() => {
    const canvas = getComputedStyle(document.querySelector<HTMLElement>('.wr-canvas')!);
    const header = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-header')!);
    const main = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-main')!);
    const rail = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-rail')!);
    const composer = getComputedStyle(document.querySelector<HTMLElement>('.wr-composer')!);
    const run = getComputedStyle(document.querySelector<HTMLElement>('.wr-run-card')!);
    const message = getComputedStyle(document.querySelector<HTMLElement>('.wr-message')!);
    const meterItem = getComputedStyle(document.querySelector<HTMLElement>('.wr-meter > span')!);
    const avatarEl = document.querySelector<HTMLElement>('.wr-message .wr-actor-mark')!;
    const avatar = getComputedStyle(avatarEl);
    return {
      canvasImage: canvas.backgroundImage,
      headerBackground: header.backgroundColor,
      mainBackground: main.backgroundColor,
      headerMaterial: header.backdropFilter || header.getPropertyValue('-webkit-backdrop-filter'),
      railMaterial: rail.backdropFilter || rail.getPropertyValue('-webkit-backdrop-filter'),
      railShadow: rail.boxShadow,
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
      runBorder: parseFloat(run.borderTopWidth),
      runRadius: parseFloat(run.borderTopLeftRadius),
      runShadow: run.boxShadow,
      messageDisplay: message.display,
      messageColumns: message.gridTemplateColumns,
      messageSize: parseFloat(message.fontSize),
      meterSize: parseFloat(meterItem.fontSize),
      avatarDisplay: avatar.display,
      avatarWidth: avatarEl.getBoundingClientRect().width,
      avatarRadius: parseFloat(avatar.borderTopLeftRadius),
      wiringCount: document.querySelectorAll('.wr-wiring').length,
    };
  });
  expect(hierarchy.canvasImage).toBe('none');
  // The structural panels stay matte (glass is reserved for the composer and other functional
  // overlays), so the header and rail carry no backdrop blur and the header shares the main
  // surface. But the rail is a FLOATING panel now: it casts a soft elevation shadow.
  expect(hierarchy.headerBackground).toBe(hierarchy.mainBackground);
  expect(hierarchy.headerMaterial).toBe('none');
  expect(hierarchy.railMaterial).toBe('none');
  expect(hierarchy.railShadow).not.toBe('none');
  expect(hierarchy.composerMaterial).toContain('blur');
  // The run card is a rounded, softly-elevated card on the v5 radius scale, not a squared row.
  expect(hierarchy.runBorder).toBeGreaterThanOrEqual(1);
  expect(hierarchy.runRadius).toBeGreaterThanOrEqual(8);
  expect(hierarchy.runShadow).not.toBe('none');
  expect(hierarchy.messageDisplay).toBe('grid');
  expect(hierarchy.messageColumns.split(' ')).toHaveLength(2);
  expect(hierarchy.messageSize).toBeGreaterThanOrEqual(14);
  expect(hierarchy.meterSize).toBeGreaterThanOrEqual(12);
  // The framed-desktop message row leads with its avatar mark, not a timestamp gutter: the
  // soft-editorial avatar (>=34px, ~38px as shipped) renders instead of being hidden.
  expect(hierarchy.avatarDisplay).not.toBe('none');
  expect(hierarchy.avatarWidth).toBeGreaterThanOrEqual(34);
  expect(hierarchy.avatarRadius).toBeGreaterThan(0);
  expect(hierarchy.wiringCount).toBe(0);

  const spawn = page.getByTestId('spawn-agent');
  const spawnBox = (await spawn.boundingBox())!;
  expect(spawnBox.width).toBeGreaterThanOrEqual(44);
  expect(spawnBox.height).toBeGreaterThanOrEqual(44);
  await spawn.click();
  await expect(page.getByTestId('spawn-handle')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(spawn).toBeFocused();
  await expect(page.getByTestId('member-alpha-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('member-alpha-toggle').click();
  await expect(page.getByTestId('member-alpha-toggle')).toHaveAttribute('aria-expanded', 'false');

  const searchToggle = page.getByTestId('toggle-message-search');
  await expect(page.getByTestId('message-search')).toHaveCount(0);
  await searchToggle.click();
  await expect(page.locator('#room-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('message-search')).toHaveCount(0);
  await expect(searchToggle).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await control('/enqueue', { turns: [{ kind: 'complete', final_text: 'visual reflow hold released' }] });
  await control('/hold', { body: '@alpha preserve the latest-turn viewport', reason: 'visual reflow regression' });
  await expect(page.getByTestId('hold-banner')).toBeVisible();
  await expect.poll(() => page.getByTestId('timeline').evaluate((timeline) => {
    const last = timeline.lastElementChild;
    if (!last) return false;
    return last.getBoundingClientRect().bottom <= timeline.getBoundingClientRect().bottom + 1 &&
      Math.abs(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) <= 1;
  })).toBe(true);
  await page.locator('[data-testid^="release-"]').last().click();
  await expect(page.getByText('visual reflow hold released')).toBeVisible();
  // The unframed mobile prose timeline drops the per-message avatar the desktop row leads with.
  await expect(page.locator('.wr-message').first()).toBeVisible();
  await expect(page.locator('.wr-message .wr-actor-mark').first()).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByTestId('open-room-drawer').click();
  const drawerMaterial = await page.getByTestId('room-drawer').evaluate((drawer) => {
    const style = getComputedStyle(drawer);
    const footer = getComputedStyle(drawer.querySelector<HTMLElement>('.wr-drawer-footer small')!);
    return {
      background: style.backgroundColor,
      material: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
      footerSize: parseFloat(footer.fontSize),
    };
  });
  expect(drawerMaterial.background).toBe('rgb(28, 25, 23)');
  expect(drawerMaterial.material).toContain('blur(12px)');
  expect(drawerMaterial.footerSize).toBeGreaterThanOrEqual(12);
  await page.getByTestId('room-drawer').getByRole('button', { name: 'Close channels' }).click();

  await page.setViewportSize({ width: 320, height: 700 });
  await page.reload();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const narrowSend = (await page.getByTestId('composer-send').boundingBox())!;
  expect(narrowSend.x + narrowSend.width).toBeLessThanOrEqual(320);
  expect(narrowSend.y + narrowSend.height).toBeLessThanOrEqual(700);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const narrowMaterial = await page.evaluate(() => {
    const canvas = getComputedStyle(document.querySelector<HTMLElement>('.wr-canvas')!);
    const header = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-header')!);
    const main = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-main')!);
    const composer = getComputedStyle(document.querySelector<HTMLElement>('.wr-composer')!);
    const send = getComputedStyle(document.querySelector<HTMLElement>('.wr-send-button')!);
    return {
      canvasImage: canvas.backgroundImage,
      headerBackground: header.backgroundColor,
      mainBackground: main.backgroundColor,
      headerMaterial: header.backdropFilter || header.getPropertyValue('-webkit-backdrop-filter'),
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
      sendShadow: send.boxShadow,
    };
  });
  expect(narrowMaterial.canvasImage).toBe('none');
  expect(narrowMaterial.headerBackground).toBe(narrowMaterial.mainBackground);
  expect(narrowMaterial.headerMaterial).toBe('none');
  expect(narrowMaterial.composerMaterial).toContain('blur');
  expect(narrowMaterial.sendShadow).toBe('none');
});
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference

// harn:assume web-first-run-color-mode-is-light ref=light-first-theme-regression
test('the head script resolves the theme before the entry module runs, on every branch', async ({ browser }) => {
  // Each branch gets its OWN fresh context: init scripts and localStorage accumulate
  // across navigations with undefined evaluation order, so a shared page would let one
  // branch's storage setter run inside another. A fresh context inherits no fixture
  // options either, so baseURL and the viewport are passed explicitly.
  const resolve = async (
    stored: string | null,
    os: 'dark' | 'light',
    initScript?: () => void,
  ): Promise<{ attr: string | null; scheme: string }> => {
    const context = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 1440, height: 900 },
      colorScheme: os,
    });
    const page = await context.newPage();
    // Block the entry module, so what we observe is the FIRST paint - the head script
    // alone. Without it, the attribute would depend only on the CSS media query, catching
    // any prepaint flash.
    await page.route('**/src/main.tsx', (route) => route.abort());
    await page.route('**/assets/*.js', (route) => route.abort());
    if (initScript) await page.addInitScript(initScript);
    else {
      await page.addInitScript((value) => {
        if (value === null) localStorage.removeItem('codor-theme');
        else localStorage.setItem('codor-theme', value);
      }, stored);
    }
    await page.goto('/?room=eng&token=e2e-token');
    const result = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-theme'),
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    await context.close();
    return result;
  };

  // Missing choice on a dark OS resolves to light.
  expect(await resolve(null, 'dark')).toEqual({ attr: 'light', scheme: 'light' });
  // Explicit dark on a light OS is dark.
  expect(await resolve('dark', 'light')).toMatchObject({ attr: 'dark' });
  // Explicit light on a dark OS is light.
  expect(await resolve('light', 'dark')).toMatchObject({ attr: 'light' });
  // System on a dark OS carries no attribute and lands on the dark media result.
  expect(await resolve('system', 'dark')).toEqual({ attr: null, scheme: 'dark' });
  // Invalid stored value on a dark OS resolves to light.
  expect(await resolve('chartreuse', 'dark')).toEqual({ attr: 'light', scheme: 'light' });
  // Throwing storage resolves to light: make getItem throw before the head script runs.
  expect(
    await resolve(null, 'dark', () => {
      const proto = Object.getPrototypeOf(window.localStorage) as Storage;
      Object.defineProperty(proto, 'getItem', {
        configurable: true,
        value: () => {
          throw new Error('storage unavailable');
        },
      });
    }),
  ).toMatchObject({ attr: 'light' });
});
// harn:end web-first-run-color-mode-is-light

// harn:assume run-context-selects-and-follows-live-evidence ref=selected-live-run-context-regression
test('intermediate context sheet follows a selected run through live completion', async ({ page }) => {
  await page.setViewportSize({ width: 1150, height: 800 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('room-rail')).toBeVisible();
  await expect(page.getByTestId('context-rail')).toBeHidden();

  await control('/enqueue', {
    turns: [{ kind: 'ask', prompt: 'Context review decision?', options: ['YES', 'NO'], replyPrefix: 'context ' }],
  });
  await page.getByTestId('composer-input').fill('@alpha inspect this live run');
  await page.getByTestId('composer-send').click();
  const run = page.locator('[data-run-status="running"]').last();
  await expect(run).toBeVisible();
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');
  const stableRun = page.getByTestId(`run-${runId}`);
  const inspect = page.getByTestId(`run-${runId}-inspect`);
  await inspect.click();

  const sheet = page.getByRole('dialog', { name: 'Channel context' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close channel context' })).toBeFocused();
  await expect(sheet.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  const before = Number(await sheet.getByTestId('context-evidence-count').textContent());

  await control('/answer', { label: 'YES' });
  await expect(stableRun).toHaveAttribute('data-run-status', 'completed');
  await expect.poll(async () => Number(await sheet.getByTestId('context-evidence-count').textContent()))
    .toBeGreaterThan(before);

  const membersTab = sheet.getByRole('tab', { name: 'Members' });
  await membersTab.click();
  await expect(membersTab).toHaveAttribute('aria-selected', 'true');
  await membersTab.press('ArrowRight');
  await expect(sheet.getByRole('tab', { name: 'Run' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(inspect).toBeFocused();
});
// harn:end run-context-selects-and-follows-live-evidence

// harn:assume web-room-rail-creates-owner-room ref=room-rail-create-regression
test('desktop room rail creates and enters an owner-seeded room without a bearer URL', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('create-room-dialog')).toBeVisible();
  await page.getByTestId('create-room-name').fill('Glass review room');
  await expect(page.getByTestId('create-room-id')).toHaveText('id: glass-review-room');
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/\?room=glass-review-room$/);
  await expect(page).not.toHaveURL(/token=/);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByRole('heading', { name: 'Glass review room' })).toBeVisible();
});
// harn:end web-room-rail-creates-owner-room

// harn:assume one-control-chooses-an-agent-everywhere ref=shared-policy-control-regression
test('a channel is created with the permission its agent was given', async ({ page, request }) => {
  // F11, end to end through the real contract: the create request has to CARRY the
  // policy. Before the schema had the field, zod stripped it silently at the boundary
  // and the channel's agent spawned with none — while the spawn dialog set one fine.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('create-room-dialog')).toBeVisible();
  await page.getByTestId('create-room-name').fill('Permission room');
  await page.getByTestId('create-room-harness-fake').click();

  // The one shared control — the same one the spawn dialog uses.
  await expect(page.getByTestId('create-room-policy-read-only')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('create-room-policy-full-access').click();
  await expect(page.getByTestId('create-room-policy-full-access')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('create-room-submit').click();

  await expect(page.getByRole('heading', { name: 'Permission room' })).toBeVisible();

  const members = await request.get('/api/rooms/permission-room/members', {
    headers: { authorization: 'Bearer e2e-token' },
  });
  const { members: details } = await members.json() as { members: { member: { kind: string; policy?: string } }[] };
  const agent = details.find((item) => item.member.kind === 'agent')!;
  expect(agent.member.policy, 'the channel-seeded agent must carry the chosen policy').toBe('full-access');
});
// harn:end one-control-chooses-an-agent-everywhere

test('the soft-editorial shell keeps accessible light tokens, matte panels, and glass only on functional surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('codor-theme', 'system'));
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByTestId('composer-input')).toBeVisible();

  const light = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const header = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-header')!);
    const composer = getComputedStyle(document.querySelector<HTMLElement>('.wr-composer')!);
    return {
      colorScheme: root.colorScheme,
      canvas: root.getPropertyValue('--wr-canvas').trim(),
      text: root.getPropertyValue('--wr-text').trim(),
      headerMaterial: header.backdropFilter || header.getPropertyValue('-webkit-backdrop-filter'),
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
      contrast: (() => {
        const luminance = (hex: string): number => {
          const channels = hex.match(/[0-9a-f]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255)
            .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
          return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
        };
        const ratio = (foreground: string, background: string): number => {
          const a = luminance(foreground);
          const b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        return {
          text: ratio(root.getPropertyValue('--wr-text').trim(), root.getPropertyValue('--wr-canvas').trim()),
          active: ratio(root.getPropertyValue('--wr-emerald').trim(), root.getPropertyValue('--wr-canvas').trim()),
          faintCanvas: ratio(root.getPropertyValue('--wr-faint').trim(), root.getPropertyValue('--wr-canvas').trim()),
          faintSelected: ratio(root.getPropertyValue('--wr-faint').trim(), root.getPropertyValue('--wr-surface-selected').trim()),
        };
      })(),
    };
  });
  expect(light.colorScheme).toContain('light');
  expect(light.canvas).toBe('#f5f5f2');
  expect(light.text).toBe('#1b1c1f');
  expect(light.headerMaterial).toBe('none');
  expect(light.composerMaterial).toContain('blur');
  expect(light.contrast.text).toBeGreaterThanOrEqual(4.5);
  expect(light.contrast.active).toBeGreaterThanOrEqual(4.5);
  expect(light.contrast.faintCanvas).toBeGreaterThanOrEqual(4.5);
  expect(light.contrast.faintSelected).toBeGreaterThanOrEqual(4.5);

  await page.getByTestId('composer-input').focus();
  expect(await page.getByTestId('composer-input').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  })).toBe(true);
  await page.getByTestId('toggle-message-search').click();
  await page.locator('#room-search').focus();
  expect(await page.locator('#room-search').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  })).toBe(true);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--wr-canvas').trim(),
  )).not.toBe(light.canvas);
  const darkText = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--wr-text').trim(),
  );
  expect(darkText).not.toBe(light.text);

  await page.setViewportSize({ width: 1150, height: 820 });
  await page.reload();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const intermediate = await page.evaluate(() => {
    const canvas = getComputedStyle(document.querySelector<HTMLElement>('.wr-canvas')!);
    const header = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-header')!);
    const rail = getComputedStyle(document.querySelector<HTMLElement>('.wr-room-rail')!);
    const composer = getComputedStyle(document.querySelector<HTMLElement>('.wr-composer')!);
    return {
      canvasImage: canvas.backgroundImage,
      headerMaterial: header.backdropFilter || header.getPropertyValue('-webkit-backdrop-filter'),
      railMaterial: rail.backdropFilter || rail.getPropertyValue('-webkit-backdrop-filter'),
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
    };
  });
  expect(intermediate.canvasImage).toBe('none');
  expect(intermediate.headerMaterial).toBe('none');
  expect(intermediate.railMaterial).toBe('none');
  expect(intermediate.composerMaterial).toContain('blur');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await expect.poll(() => page.locator('.wr-composer').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
  })).toBe('none');
  await page.getByTestId('toggle-message-search').click();
  const reducedTransparency = await page.evaluate(() => {
    const composer = getComputedStyle(document.querySelector<HTMLElement>('.wr-composer')!);
    const search = getComputedStyle(document.querySelector<HTMLElement>('.wr-search')!);
    return {
      composerBackground: composer.backgroundColor,
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
      searchBackground: search.backgroundColor,
      searchMaterial: search.backdropFilter || search.getPropertyValue('-webkit-backdrop-filter'),
    };
  });
  // Reduced transparency collapses the glass to fully opaque surfaces with no backdrop blur.
  expect(reducedTransparency.composerBackground).not.toContain('rgba');
  expect(reducedTransparency.searchBackground).not.toContain('rgba');
  expect(reducedTransparency.composerMaterial).toBe('none');
  expect(reducedTransparency.searchMaterial).toBe('none');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  expect(await page.locator('.wr-room-link').first().evaluate((element) =>
    parseFloat(getComputedStyle(element).transitionDuration),
  )).toBeLessThanOrEqual(0.001);

  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/settings?room=eng');
  await expect(page.getByTestId('room-settings-save')).toBeVisible();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll);
  await expect(page.getByTestId('room-settings-save')).toBeVisible();
});

// harn:assume web-settings-controls-preserve-product-truth ref=glass-settings-regression
test('restrained settings keep row-based desktop focus, mobile fit, and honest relay boundaries', async ({ page, request }) => {
  const freshRoom = `brake-default-${String(Date.now())}`;
  const created = await request.post('/api/rooms', {
    headers: { authorization: 'Bearer e2e-token' },
    data: {
      id: freshRoom,
      name: 'Brake default room',
      owner: { handle: 'richard', display_name: 'Richard' },
    },
  });
  expect(created.ok()).toBe(true);
  const synced = await request.get(`/api/rooms/${freshRoom}/sync`, {
    headers: { authorization: 'Bearer e2e-token' },
  });
  expect(synced.ok()).toBe(true);
  const freshState = await synced.json() as {
    room: { config: { turn_brake: number | null; spend_brake_usd: number | null } };
  };
  expect(freshState.room.config.turn_brake).toBeNull();
  expect(freshState.room.config.spend_brake_usd).toBeNull();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/settings?room=${freshRoom}&token=e2e-token`);
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const rooms = page.getByTestId('room-rail');
  const categories = page.getByTestId('settings-nav');
  const content = page.locator('.wr-settings-content');
  await expect(rooms).toBeVisible();
  await expect(categories).toBeVisible();
  await expect(content).toBeVisible();
  const roomBox = (await rooms.boundingBox())!;
  const categoryBox = (await categories.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  expect(roomBox.x + roomBox.width).toBeLessThanOrEqual(categoryBox.x + 0.5);
  expect(categoryBox.x + categoryBox.width).toBeLessThanOrEqual(contentBox.x + 0.5);
  const settingsStyle = await page.evaluate(() => {
    const nav = getComputedStyle(document.querySelector<HTMLElement>('.wr-settings-nav')!);
    const content = getComputedStyle(document.querySelector<HTMLElement>('.wr-settings-content')!);
    const row = getComputedStyle(document.querySelector<HTMLElement>('.wr-setting-row')!);
    return {
      navBackground: nav.backgroundColor,
      contentBackground: content.backgroundColor,
      navMaterial: nav.backdropFilter || nav.getPropertyValue('-webkit-backdrop-filter'),
      rowRadius: parseFloat(row.borderTopLeftRadius),
      contentImage: content.backgroundImage,
    };
  });
  expect(settingsStyle.navBackground).toBe(settingsStyle.contentBackground);
  expect(settingsStyle.navMaterial).toBe('none');
  expect(settingsStyle.rowRadius).toBe(0);
  expect(settingsStyle.contentImage).toBe('none');

  // harn:assume web-settings-pairing-match-restrained-reference ref=restrained-settings-pairing-regression
  await expect(page.getByTestId('settings-section-appearance')).toBeVisible();
  await expect(page.getByTestId('settings-section-brakes')).toBeHidden();
  await page.getByRole('link', { name: 'Brakes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Brakes', exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-section-brakes')).toBeVisible();
  await expect(page.getByTestId('settings-section-appearance')).toBeHidden();
  await expect(page.getByTestId('turn-brake-enabled')).not.toBeChecked();
  await expect(page.getByTestId('spend-brake-enabled')).not.toBeChecked();
  const turnToggle = (await page.getByTestId('turn-brake-enabled').boundingBox())!;
  expect(turnToggle.width).toBeGreaterThanOrEqual(44);
  expect(turnToggle.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('spinbutton', { name: 'Turn brake value' })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Spend brake value' })).toBeVisible();
  await expect(page.getByText('Always on · flags inactivity · never kills a run.')).toBeVisible();
  const relayCategory = page.getByRole('link', { name: 'Relay', exact: true });
  await relayCategory.click();
  await page.getByTestId('open-relay-pairing').click();
  const relay = page.getByTestId('relay-pairing');
  await expect(relay.getByText('Relay can see')).toBeVisible();
  await expect(relay.getByText('Relay never sees')).toBeVisible();
  await expect(relay).toContainText('Stores nothing · no mailbox · no retries');
  await expect(relay).toContainText('Web Push endpoint + delivery keys');
  await expect(relay).toContainText('Opaque Codor public key');
  await expect(relay).toContainText('Decrypted channel keys or any private key');
  await expect(relay).toContainText('Hosted roadmap · deferred from the v1 push relay.');
  await expect(relayCategory).toHaveAttribute('aria-current', 'location');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('room-rail')).toBeHidden();
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  await expect(page.getByTestId('settings-section-appearance')).toBeVisible();
  await expect(page.getByTestId('settings-section-privacy')).toBeVisible();
  await expect(page.getByTestId('theme-system')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.locator('#privacy').scrollIntoViewIfNeeded();
  await expect(page.getByText('Local plaintext, content-blind relay.')).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(844);
  await expect(page.getByTestId('theme-system')).toBeVisible();

  await page.setViewportSize({ width: 320, height: 700 });
  await page.reload();
  await expect(page.getByTestId('theme-system')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  // harn:end web-settings-pairing-match-restrained-reference
});
// harn:end web-settings-controls-preserve-product-truth

// harn:assume web-theme-choice-stays-local-v5 ref=theme-choice-regression
test('theme choice applies immediately, survives a tokenless launch, and returns to system', async ({ page }) => {
  await page.goto('/settings?room=eng&token=e2e-token');
  const mutatingApiRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    ) mutatingApiRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.getByTestId('theme-system').focus();
  await page.getByTestId('theme-system').press('ArrowRight');
  await expect(page.getByTestId('theme-dark')).toBeFocused();
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('theme-dark').press('End');
  await expect(page.getByTestId('theme-light')).toBeFocused();
  await page.getByTestId('theme-light').press('Home');
  await expect(page.getByTestId('theme-system')).toBeFocused();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('codor-theme'))).toBe('light');

  await page.goto('/?room=eng');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page).not.toHaveURL(/token=/);

  await page.goto('/settings?room=eng');
  await page.getByTestId('theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await page.evaluate(() => localStorage.getItem('codor-theme'))).toBe('system');
  expect(mutatingApiRequests).toEqual([]);
});
// harn:end web-theme-choice-stays-local-v5

test('authenticated roles remove commands the local matrix does not allow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?room=eng&token=e2e-observer-token');
  await expect(page.getByTestId('member-observer-user')).toBeVisible();
  await expect(page.getByTestId('read-only-room')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
  await expect(page.getByTestId('spawn-agent')).toHaveCount(0);
  await expect(page.getByTestId('create-room')).toHaveCount(0);

  await page.goto('/settings?room=eng&token=e2e-observer-token');
  await expect(page.getByRole('link', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Brakes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Paired devices', exact: true })).toHaveCount(0);

  await page.goto('/?room=eng&token=e2e-admin-token');
  await expect(page.getByTestId('member-admin-user')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('spawn-agent')).toBeVisible();
  await expect(page.getByTestId('create-room')).toHaveCount(0);

  await page.goto('/settings?room=eng&token=e2e-admin-token');
  await expect(page.getByRole('link', { name: 'Brakes', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Relay', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Paired devices', exact: true })).toHaveCount(0);
});

// harn:assume bridged-room-wears-banner-v5 ref=bridged-room-regression
test('bridged rooms permanently disclose the external boundary and attribute relayed authors', async ({ page }) => {
  const seeded = await control<{ message_id: number }>('/bridge-enable', {
    platform: 'slack',
    channel: 'C123',
    senderName: 'Sarah Chen',
    message: '@alpha review [[launch-plan]]',
  });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  const banner = page.getByTestId('bridged-room-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Bridged channel');
  await expect(banner).toContainText('stores this channel\'s content under its own privacy terms');
  await expect(page.getByTestId(`msg-${String(seeded.message_id)}`)).toContainText('via slack: Sarah Chen');

  await page.goto('/settings?room=eng&token=e2e-token');
  await expect(page.getByTestId('bridged-room-banner')).toBeVisible();
  await page.goto('/ledger?room=eng');
  await expect(page.getByTestId('bridged-room-banner')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('bridged-room-banner')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
// harn:end bridged-room-wears-banner-v5

// Long enough that the timeline must scroll at 390x844. Every geometry assertion about
// timeline content depends on this: nothing can be crushed in a timeline that fits.
const PRIOR_HISTORY = [
  'Earlier in this channel:',
  ...Array.from({ length: 24 }, (_, index) => `Step ${String(index + 1)}: inspected the workspace and reported what it found.`),
].join('\n\n');

// harn:assume interaction-cards-stay-readable-on-phone ref=phone-ask-card-browser-regression
test('an approval card is readable and answerable at phone width', async ({ page, request }) => {
  const room = `approve-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  const created = await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Phone approval',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });
  expect(created.ok()).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const command = 'rm -rf ./build && pnpm build --filter @codor/web --verbose';
  // The card must survive a timeline that SCROLLS. A one-message fixture cannot
  // shrink anything, so the version of this test that used one could never fail —
  // and did not, while the operator's own approval cards were crushed to slivers.
  await control('/enqueue', {
    turns: [
      { kind: 'complete', final_text: PRIOR_HISTORY },
      {
        kind: 'ask',
        cardKind: 'approval',
        tool: 'Bash',
        prompt: 'Run this command?',
        detail: command,
        options: ['Allow', 'Deny'],
        replyPrefix: 'chose ',
      },
    ],
  });
  await page.getByTestId('composer-input').fill('@codor what happened so far');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('Earlier in this channel')).toBeVisible();
  await page.getByTestId('composer-input').fill('@codor build it');
  await page.getByTestId('composer-send').click();

  const allow = page.locator('[data-testid$="-option-Allow"]').first();
  await expect(allow).toBeVisible();
  const card = allow.locator('xpath=ancestor::*[contains(@class, "wr-ask-card")]').first();
  const id = (await card.getAttribute('id'))!;

  // The fixture is only meaningful if the timeline actually overflows.
  const overflowing = await page.locator('.wr-timeline').evaluate(
    (node) => node.scrollHeight > node.clientHeight + 8,
  );
  expect(overflowing, 'the timeline must scroll, or this test cannot fail').toBe(true);

  // The card is not crushed by the flex algorithm: it renders at its content height.
  const crushed = await card.evaluate((node) => node.scrollHeight - node.getBoundingClientRect().height);
  expect(crushed, 'the card must render at its full content height').toBeLessThanOrEqual(1);

  // The card must be answerable on the device the operator actually carries.
  await expect(page.getByTestId(`card-${id}-title`)).toHaveText('APPROVAL NEEDED');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  // Every option is a real tap target.
  for (const option of ['Allow', 'Deny']) {
    const box = (await page.locator(`[data-testid$="-option-${option}"]`).first().boundingBox())!;
    expect(box.height, `${option} must be tappable`).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThan(200);
  }

  // The command is the thing being approved: readable, and never truncated away.
  const detail = page.getByTestId(`card-${id}-detail`);
  await expect(detail).toContainText(command.slice(0, 20));
  const size = await detail.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(size).toBeGreaterThanOrEqual(14);

  // And the answer flow still works from the phone.
  await allow.click();
  await expect(page.getByTestId(`card-${id}`)).toHaveCount(0);
  await expect(page.getByText('chose Allow')).toBeVisible();
});
// harn:end interaction-cards-stay-readable-on-phone

// harn:assume timeline-rows-are-never-crushed-v5 ref=timeline-crush-browser-regression
test('a scrolling timeline crushes no row, whatever overflow the row sets', async ({ page, request }) => {
  // The ask card was the row that broke, but it was not special: it was merely the only
  // row that set overflow:hidden, which zeroes a flex item's automatic minimum size and
  // makes it the one child the flex algorithm may crush. Assert the INVARIANT over every
  // row the timeline actually renders, so the next row to set overflow is covered too.
  const room = `crush-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Crush',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // A run row, a chat row, and an approval card — in a timeline tall enough to scroll.
  await control('/enqueue', {
    turns: [
      { kind: 'complete', final_text: PRIOR_HISTORY },
      {
        kind: 'ask',
        cardKind: 'approval',
        tool: 'Write',
        prompt: 'Allow Write?',
        detail: 'app/uwu-bird/page.js',
        options: ['allow once', 'allow always', 'deny'],
      },
    ],
  });
  await page.getByTestId('composer-input').fill('@codor recap');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('Earlier in this channel')).toBeVisible();
  await page.getByTestId('composer-input').fill('@codor write the page');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.wr-ask-card')).toBeVisible();

  const report = await page.locator('.wr-timeline').evaluate((timeline) => ({
    overflowing: timeline.scrollHeight > timeline.clientHeight + 8,
    rows: [...timeline.children]
      .filter((row) => row.getBoundingClientRect().height > 0)
      .map((row) => ({
        cls: row.className.toString(),
        shrink: getComputedStyle(row).flexShrink,
        crushedBy: row.scrollHeight - Math.round(row.getBoundingClientRect().height),
      })),
  }));

  // Without a scrolling timeline nothing can be crushed and this test cannot fail.
  expect(report.overflowing, 'the timeline must scroll').toBe(true);
  expect(report.rows.length).toBeGreaterThan(2);

  for (const row of report.rows) {
    expect(row.shrink, `${row.cls} must not be shrinkable`).toBe('0');
    expect(row.crushedBy, `${row.cls} is crushed below its content`).toBeLessThanOrEqual(1);
  }

  // The card the operator has to answer is fully there, buttons included.
  await expect(page.locator('[data-testid$="-option-deny"]')).toBeVisible();
  await expect(page.locator('[data-testid$="-option-deny"]')).toBeEnabled();
});
// harn:end timeline-rows-are-never-crushed-v5

// harn:assume compact-one-line-tool-rows ref=compact-run-row-browser-regression
test('tool rows say what the tool did, on one line, at every width', async ({ page, request }) => {
  const room = `rows-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Compact rows',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });

  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await control('/enqueue', {
    turns: [{
      kind: 'complete',
      items: [
        {
          type: 'run.item', item_type: 'tool_call',
          // Long enough to wrap onto a second line if it were not ellipsised — the
          // previous version of this test used a 22-character command and so could
          // not have caught the missing one-line rule.
          payload: {
            call_id: 'c1', tool: 'Bash',
            title: 'pnpm test --filter @codor/web --reporter=verbose --run --coverage --no-color --bail=1',
          },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: { call_id: 'c1', status: 'ok', duration_ms: 2000 },
        },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'c2', tool: 'Read', title: '/home/richard/git/codor/src/App.tsx' },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: { call_id: 'c2', status: 'ok', duration_ms: 0 },
        },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'c3', tool: 'Edit', title: 'shell.tsx' },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: {
            call_id: 'c3', status: 'ok', duration_ms: 0,
            diff: { path: 'packages/web/src/shell.tsx', unified: '--- a/x\n+++ b/x\n+one\n+two\n-gone\n' },
          },
        },
      ],
      final_text: '@richard rows rendered',
    }],
  });
  await page.getByTestId('composer-input').fill('@codor go');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('@richard rows rendered')).toBeVisible();

  // The row shows the command, the file, and the diffstat — not "Bash", "Read", "Edit".
  await expect(page.getByText('pnpm test --filter', { exact: false })).toBeVisible();
  await expect(page.getByText('Explored App.tsx')).toBeVisible();
  await expect(page.getByText('+2 −1 shell.tsx')).toBeVisible();

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const heights = await page.locator('[data-run-row][data-row-kind="tool"]').evaluateAll(
      (rows) => rows.map((row) => row.getBoundingClientRect().height),
    );
    expect(heights.length).toBeGreaterThanOrEqual(3);
    // One line each: a two-line row would roughly double this.
    for (const height of heights) expect(height, `row at ${String(width)}px`).toBeLessThanOrEqual(44);
  }
});
// harn:end compact-one-line-tool-rows

// harn:assume empty-and-offline-are-shown-not-blank ref=timeline-state-regression
test('an empty channel greets instead of rendering nothing', async ({ page, request }) => {
  const room = `empty-${String(Date.now())}`;
  await request.post('/api/rooms', {
    headers: { authorization: 'Bearer e2e-token' },
    data: {
      id: room,
      name: 'Empty',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });

  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // F5: this rendered as a blank timeline, indistinguishable from a broken one.
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
  await expect(page.getByTestId('timeline-empty')).toContainText('@codor is ready.');

  // F3: a channel created without a colour still shows an accent in the rail.
  const dot = page.getByTestId(`room-color-${room}`);
  const background = await dot.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');

  // F6: the composer is one row — no heading above it.
  await expect(page.getByText('Message the channel', { exact: true })).toHaveCount(0);
  const input = (await page.getByTestId('composer-input').boundingBox())!;
  const send = (await page.getByTestId('composer-send').boundingBox())!;
  expect(Math.abs(input.height - send.height)).toBeLessThanOrEqual(1);
});
// harn:end empty-and-offline-are-shown-not-blank

// harn:assume the-inbox-opens-what-needs-you ref=inbox-panel-regression
test('the inbox lists what needs you and takes you to it', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await control('/enqueue', {
    turns: [{
      kind: 'ask',
      cardKind: 'approval',
      tool: 'Bash',
      prompt: 'Deploy to production?',
      detail: 'pnpm deploy --prod',
      options: ['Allow', 'Deny'],
      replyPrefix: 'chose ',
    }],
  });
  await page.getByTestId('composer-input').fill('@alpha deploy');
  await page.getByTestId('composer-send').click();

  const allow = page.locator('[data-testid$="-option-Allow"]').first();
  await expect(allow).toBeVisible();
  const card = allow.locator('xpath=ancestor::*[contains(@class, "wr-ask-card")]').first();
  const id = (await card.getAttribute('id'))!;

  // The badge is a button now, not a number that tells you there is work but not where.
  await page.getByTestId('inbox-badge').click();
  const item = page.getByTestId(`inbox-item-${id}`);
  await expect(item).toBeVisible();
  await expect(item).toContainText('@alpha');
  await expect(item).toContainText('Deploy to production?');

  await item.click();
  await expect(page.getByTestId('inbox-panel')).toHaveCount(0);
  await expect(card).toBeVisible();

  // Answering removes it — the panel follows the same messages the timeline does.
  await allow.click();
  await expect(page.getByText('chose Allow')).toBeVisible();
  await page.getByTestId('inbox-badge').click();
  await expect(page.getByTestId('inbox-empty')).toHaveText('Nothing needs you.');
});
// harn:end the-inbox-opens-what-needs-you

// harn:assume a-permission-change-is-never-silent ref=configure-audit-regression
test('changing an agent from the sidebar is visible to everyone in the channel', async ({ page, request }) => {
  const room = `configure-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Configure',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor', policy: 'read-only' },
    },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('member-codor').click();
  await page.getByTestId('configure-codor').click();

  // The same shared control — with the two things that genuinely cannot change stated.
  await expect(page.getByTestId('settings-codor-harness-fixed')).toContainText('fake');
  await expect(page.getByTestId('settings-codor-fixed'))
    .toContainText('Spawn a new one to change them');
  await expect(page.getByTestId('settings-codor-effect')).toContainText('conversation is kept');

  await page.getByTestId('settings-codor-policy-full-access').click();
  await page.getByTestId('settings-codor-save').click();

  // A capability change nobody saw is a capability change nobody agreed to.
  await expect(page.getByText('@richard changed @codor — policy: read-only → full-access'))
    .toBeVisible();

  // And it is the truth, not just a message: the member carries it.
  const members = await request.get(`/api/rooms/${room}/members`, { headers: authorization });
  const { members: details } = await members.json() as { members: { member: { kind: string; policy?: string } }[] };
  expect(details.find((item) => item.member.kind === 'agent')!.member.policy).toBe('full-access');
});
// harn:end a-permission-change-is-never-silent

// harn:assume removing-an-agent-is-one-deliberate-step ref=remove-member-regression
test('an agent is removed in one step, after being asked to confirm', async ({ page, request }) => {
  const room = `remove-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Remove',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('member-codor').click();
  // The agent is alive and idle — and Remove is right there, without killing it first.
  await page.getByTestId('remove-codor').click();

  // It is destructive, so it names what it is about to destroy.
  await expect(page.getByTestId('remove-codor-confirm')).toContainText('@codor');
  await expect(page.getByTestId('remove-codor-confirm')).toContainText('past messages keep its name');

  await page.getByTestId('remove-codor-confirmed').click();

  await expect(page.getByText('@codor was removed; its history remains attributed')).toBeVisible();
  await expect(page.getByTestId('member-codor')).toHaveCount(0);
});
// harn:end removing-an-agent-is-one-deliberate-step

// harn:assume controls-fit-the-surface-they-sit-on ref=control-fit-regression
test('every option of the agent control fits inside the sidebar that holds it', async ({ page, request }) => {
  // The control is shared by the dialogs and the member card, and it was laid out for the
  // dialogs: three columns, 310px, inside a 285px panel — which put FULL ACCESS, of all
  // options, past the edge of the screen. A test that only ever rendered it in a dialog
  // could not have caught that, so this one asserts the fit where it is TIGHTEST.
  const room = `fit-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Fit',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('member-codor').click();
  await page.getByTestId('configure-codor').click();
  await expect(page.getByTestId('settings-codor')).toBeVisible();

  const report = await page.locator('.wr-member-settings').evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    const options = [...panel.querySelectorAll<HTMLElement>('.wr-policy-option, .wr-button-row button')];
    return {
      panelRight: Math.round(bounds.right),
      viewportRight: window.innerWidth,
      overflowing: options
        .map((option) => ({
          label: (option.textContent ?? '').trim().slice(0, 24),
          right: Math.round(option.getBoundingClientRect().right),
        }))
        .filter((option) => option.right > Math.round(bounds.right) + 1),
    };
  });

  expect(report.panelRight).toBeLessThanOrEqual(report.viewportRight);
  expect(report.overflowing, 'these options render outside the panel that holds them').toEqual([]);

  // And the one that matters most is actually on the screen.
  const fullAccess = (await page.getByTestId('settings-codor-policy-full-access').boundingBox())!;
  expect(fullAccess.x + fullAccess.width).toBeLessThanOrEqual(1440);
});
// harn:end controls-fit-the-surface-they-sit-on

// harn:assume history-cursor-tracks-only-the-contiguous-tail ref=contiguous-history-browser-regression
interface HistorySeed { first: number; last: number; approval: number; middle: number }

async function loadCompleteHistory(page: Page, seeded: HistorySeed): Promise<void> {
  await page.getByTestId('load-history').dispatchEvent('click');
  await expect(page.getByTestId(`msg-${seeded.middle}`)).toBeVisible();
  while (await page.getByTestId('load-history').count() > 0) {
    await page.getByTestId('load-history').dispatchEvent('click');
  }
  await expect(page.getByTestId(`msg-${seeded.first}`)).toBeVisible();
  const renderedIds = await page.getByTestId('timeline').locator('[id]').evaluateAll((elements) =>
    elements
      .map((element) => Number(element.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((left, right) => left - right));
  expect(renderedIds).toEqual(Array.from({ length: 161 }, (_, index) => index + 1));
}
// harn:end history-cursor-tracks-only-the-contiguous-tail

// harn:assume approval-cards-follow-durable-resolution ref=approval-two-browser-regression
interface InteractionEvidence {
  interaction: { state: string; answer?: unknown };
  deliveries: Array<{ id: string; read_ts?: string; interaction_resolved_ts?: string }>;
  audit_replies: Array<{ id: number }>;
  respond_calls: Array<{ interaction_id: string; answer: unknown }>;
}

test('notification attention keeps an approval until its answer resolves every browser', async ({ page, request }) => {
  const room = `approval-sync-${String(Date.now())}`;
  const created = await request.post('/api/rooms', {
    headers: { authorization: 'Bearer e2e-token' },
    data: {
      id: room,
      name: 'Approval sync',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'reviewer' },
    },
  });
  expect(created.ok()).toBe(true);
  const peer = await page.context().newPage();
  try {
    await Promise.all([
      page.goto(`/?room=${room}&token=e2e-token`),
      peer.goto(`/?room=${room}&token=e2e-token`),
    ]);
    await Promise.all([
      expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected'),
      expect(peer.getByTestId('connection')).toHaveAttribute('title', 'connected'),
    ]);
    await control('/enqueue', {
      turns: [{
        kind: 'ask',
        cardKind: 'approval',
        prompt: 'Deploy this release?',
        options: ['Allow once', 'Deny'],
        replyPrefix: 'adapter received ',
      }],
    });
    await page.getByTestId('composer-input').fill('@reviewer deploy');
    await page.getByTestId('composer-send').click();

    const allow = page.locator('[data-testid$="-option-Allow once"]').first();
    await expect(allow).toBeVisible();
    const card = allow.locator('xpath=ancestor::*[contains(@class, "wr-ask-card")]').first();
    const id = Number(await card.getAttribute('id'));
    await expect(peer.getByTestId(`card-${String(id)}`)).toBeVisible();
    await expect(page.getByTestId('inbox-badge')).toContainText('1');
    await expect(peer.getByTestId('inbox-badge')).toContainText('1');

    const pendingEvidence = await control<InteractionEvidence>('/interaction-state', {
      room,
      message_id: id,
    });
    const delivery = pendingEvidence.deliveries[0]!;
    await peer.goto(
      `/?room=${room}&token=e2e-token&notification_action=mark_read&msg_id=${String(id)}` +
      `&delivery_id=${encodeURIComponent(delivery.id)}#${String(id)}`,
    );
    await expect(peer.getByTestId('connection')).toHaveAttribute('title', 'connected');
    await expect(peer.getByTestId(`card-${String(id)}`)).toBeVisible();
    await expect(peer.getByTestId('inbox-badge')).toContainText('1');
    await expect.poll(async () => {
      const evidence = await control<InteractionEvidence>('/interaction-state', {
        room,
        message_id: id,
      });
      const current = evidence.deliveries[0];
      return [current?.read_ts !== undefined, current?.interaction_resolved_ts !== undefined];
    }).toEqual([true, false]);

    await allow.click();
    await expect(page.getByTestId(`card-${String(id)}`)).toHaveCount(0);
    await expect(peer.getByTestId(`card-${String(id)}`)).toHaveCount(0);
    await expect(page.getByTestId('inbox-badge')).toContainText('0');
    await expect(peer.getByTestId('inbox-badge')).toContainText('0');
    await expect(page.getByText('adapter received Allow once')).toBeVisible();

    const evidence = await control<InteractionEvidence>('/interaction-state', {
      room,
      message_id: id,
    });
    expect(evidence.interaction).toMatchObject({ state: 'acked', answer: 'Allow once' });
    expect(evidence.deliveries.length).toBeGreaterThan(0);
    expect(evidence.deliveries.every((delivery) => delivery.read_ts !== undefined)).toBe(true);
    expect(evidence.deliveries.every(
      (item) => item.interaction_resolved_ts !== undefined,
    )).toBe(true);
    expect(evidence.audit_replies).toEqual([]);
    expect(evidence.respond_calls).toHaveLength(1);
  } finally {
    await peer.close();
  }
});
// harn:end approval-cards-follow-durable-resolution

// harn:assume room-action-errors-are-visible ref=approval-error-browser-regression
test('an approval acknowledgement failure is visible after durable resolution', async ({ page, request }) => {
  const room = `approval-error-${String(Date.now())}`;
  const created = await request.post('/api/rooms', {
    headers: { authorization: 'Bearer e2e-token' },
    data: {
      id: room,
      name: 'Approval error',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'error-reviewer' },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await control('/enqueue', {
    turns: [{
      kind: 'ask',
      cardKind: 'approval',
      prompt: 'Run the failing command?',
      options: ['Allow once', 'Deny'],
      failResponse: 'stream closed before approval acknowledgement',
    }],
  });
  await page.getByTestId('composer-input').fill('@error-reviewer run it');
  await page.getByTestId('composer-send').click();

  const allow = page.locator('[data-testid$="-option-Allow once"]').first();
  await expect(allow).toBeVisible();
  const card = allow.locator('xpath=ancestor::*[contains(@class, "wr-ask-card")]').first();
  const id = Number(await card.getAttribute('id'));
  await allow.click();

  await expect(page.getByTestId(`card-${String(id)}`)).toHaveCount(0);
  await expect(page.getByTestId('room-action-error'))
    .toContainText('stream closed before approval acknowledgement');
  const evidence = await control<InteractionEvidence>('/interaction-state', {
    room,
    message_id: id,
  });
  expect(evidence.interaction).toMatchObject({ state: 'answered', answer: 'Allow once' });
  expect(evidence.deliveries.every((item) => item.read_ts !== undefined
    && item.interaction_resolved_ts !== undefined)).toBe(true);
  expect(evidence.audit_replies).toEqual([]);
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.getByTestId('room-action-error')).toHaveCount(0);
});
// harn:end room-action-errors-are-visible
