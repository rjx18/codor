import { expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

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
  const seeded = await control<{ first: number; last: number }>('/seed-history');
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await expect(page.getByTestId(`msg-${seeded.last}`)).toBeVisible();
  await expect(page.getByTestId(`msg-${seeded.first}`)).toHaveCount(0);
  await page.getByTestId('load-history').dispatchEvent('click');
  await expect(page.getByTestId(`msg-${seeded.first}`)).toBeVisible();

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
  await expect(page.getByTestId('spawn-policy')).toHaveValue('workspace-write');
  await expect(page.getByTestId('spawn-policy').locator('option')).toHaveText([
    'read-only', 'workspace-write', 'full-access',
  ]);
  await expect(page.getByTestId('spawn-thinking-medium')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('spawn-thinking-medium')).toBeDisabled();
  await expect(page.getByTestId('spawn-approval-hint')).toHaveCount(0);

  await page.getByTestId('spawn-policy').evaluate((select) => {
    const element = select as HTMLSelectElement;
    const invalid = document.createElement('option');
    invalid.value = 'not-a-policy';
    invalid.textContent = invalid.value;
    element.append(invalid);
    element.value = invalid.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('spawn-dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("unknown policy 'not-a-policy'");

  await page.getByTestId('spawn-policy').selectOption('workspace-write');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-tester')).toBeVisible();

  await page.getByTestId('spawn-agent').click();
  await page.getByTestId('spawn-preset-tester').click();
  await expect(page.getByTestId('spawn-handle')).toHaveValue('tester-2');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-tester-2')).toBeVisible();

  await page.getByTestId('kill-tester').click();
  await expect(page.getByTestId('remove-tester')).toBeVisible();
  await page.getByTestId('remove-tester').click();
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
  expect(roomBox.width / 1440).toBeGreaterThan(0.2);
  expect(roomBox.width / 1440).toBeLessThan(0.24);
  expect(contextBox.width / 1440).toBeGreaterThan(0.24);
  expect(contextBox.width / 1440).toBeLessThan(0.28);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

  await page.setViewportSize({ width: 1150, height: 820 });
  await page.reload();
  await expect(page.getByTestId('room-rail')).toBeVisible();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1150);

  await page.setViewportSize({ width: 1320, height: 820 });
  await page.reload();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeVisible();

  await page.setViewportSize({ width: 1360, height: 820 });
  await page.reload();
  await expect(page.getByTestId('context-rail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open channel context' })).toBeHidden();
});
// harn:end web-shell-responsive-three-pane
// harn:end human-facing-surfaces-call-rooms-channels

// harn:assume web-room-visual-hierarchy-matches-restrained-reference ref=restrained-room-visual-regression
test('restrained room keeps matte panes, sparse glass, and a pinned latest turn across reflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
    const time = document.querySelector<HTMLElement>('.wr-message time')!.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>('.wr-message p')!.getBoundingClientRect();
    return {
      canvasImage: canvas.backgroundImage,
      headerBackground: header.backgroundColor,
      mainBackground: main.backgroundColor,
      headerMaterial: header.backdropFilter || header.getPropertyValue('-webkit-backdrop-filter'),
      railMaterial: rail.backdropFilter || rail.getPropertyValue('-webkit-backdrop-filter'),
      composerMaterial: composer.backdropFilter || composer.getPropertyValue('-webkit-backdrop-filter'),
      runBorder: parseFloat(run.borderTopWidth),
      runRadius: parseFloat(run.borderTopLeftRadius),
      runShadow: run.boxShadow,
      messageDisplay: message.display,
      messageColumns: message.gridTemplateColumns,
      messageSize: parseFloat(message.fontSize),
      meterSize: parseFloat(meterItem.fontSize),
      timeRight: time.right,
      bodyLeft: body.left,
      wiringCount: document.querySelectorAll('.wr-wiring').length,
    };
  });
  expect(hierarchy.canvasImage).toBe('none');
  expect(hierarchy.headerBackground).toBe(hierarchy.mainBackground);
  expect(hierarchy.headerMaterial).toBe('none');
  expect(hierarchy.railMaterial).toBe('none');
  expect(hierarchy.composerMaterial).toContain('blur');
  expect(hierarchy.runBorder).toBeGreaterThanOrEqual(1);
  expect(hierarchy.runRadius).toBe(0);
  expect(hierarchy.runShadow).toBe('none');
  expect(hierarchy.messageDisplay).toBe('grid');
  expect(hierarchy.messageColumns.split(' ')).toHaveLength(2);
  expect(hierarchy.messageSize).toBeGreaterThanOrEqual(14);
  expect(hierarchy.meterSize).toBeGreaterThanOrEqual(12);
  expect(hierarchy.timeRight).toBeLessThanOrEqual(hierarchy.bodyLeft);
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
  expect(drawerMaterial.background).toBe('rgba(24, 25, 29, 0.88)');
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
// harn:end web-room-visual-hierarchy-matches-restrained-reference

// harn:assume web-first-run-color-mode-is-dark ref=dark-first-theme-regression
test('a new light-host browser opens dark before an explicit system choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings?room=eng&token=e2e-token');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('codor-theme'))).toBeNull();

  await page.getByTestId('theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain('light');
  expect(await page.evaluate(() => localStorage.getItem('codor-theme'))).toBe('system');
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});
// harn:end web-first-run-color-mode-is-dark

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

// harn:assume web-glass-theme-accessible-modes ref=glass-theme-regression
test('restrained shell keeps accessible light tokens and limits glass to functional surfaces', async ({ page }) => {
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
  expect(reducedTransparency.composerBackground).toBe('rgb(19, 20, 24)');
  expect(reducedTransparency.searchBackground).toBe('rgb(19, 20, 24)');
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
// harn:end web-glass-theme-accessible-modes

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
  await expect(relay).toContainText('Opaque switchboard public key');
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

// harn:assume web-theme-choice-stays-local ref=theme-choice-regression
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
// harn:end web-theme-choice-stays-local

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

// harn:assume bridged-room-wears-banner ref=bridged-room-regression
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
// harn:end bridged-room-wears-banner
