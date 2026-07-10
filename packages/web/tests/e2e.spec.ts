import { expect, test } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:8138';

async function control(path: string, body: unknown = {}): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
}

declare global {
  interface Window {
    __wireroom: { disconnect(): void; reconnect(): void };
  }
}

test('room v1: post → live run → expand → ask → hold release → reconnect shows the finalized message', async ({
  page,
}) => {
  await page.goto('/?room=eng&token=e2e-token');

  // hydrated over WS: room header, members, empty timeline
  await expect(page.getByTestId('member-alpha')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // invariant 3: the composer shows where the draft goes BEFORE send
  await expect(page.getByTestId('implied-recipient')).toHaveAttribute('data-kind', 'commentary');
  await page.getByTestId('composer-input').fill('@alpha pick the codeword');
  await expect(page.getByTestId('implied-recipient')).toHaveText('→ @alpha');

  // 1. post → the run message appears LIVE (status running)
  await control('/enqueue', {
    turns: [{ kind: 'ask', prompt: 'Which codeword?', options: ['ALPHA', 'BETA'], replyPrefix: 'chose ' }],
  });
  await page.getByTestId('composer-send').click();
  const run = page.locator('[data-testid^="run-"][data-run-status]').first();
  await expect(run).toHaveAttribute('data-run-status', 'running');
  const runId = (await run.getAttribute('data-testid'))!.replace('run-', '');

  // 2. expand the live run → journaled events from the redacted blob endpoint
  await page.getByTestId(`run-${runId}-toggle`).click();
  await expect(page.getByTestId(`run-${runId}-events`)).toBeVisible();

  // 3. the ask card raised by the blocked run → answer ALPHA from the room
  const alphaOption = page.locator('[data-testid$="-option-ALPHA"]');
  await expect(alphaOption).toBeVisible();
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

  await page.evaluate(() => window.__wireroom.disconnect());
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'disconnected');

  await control('/answer', { label: 'YES' }); // finalizes server-side, invisibly

  await page.evaluate(() => window.__wireroom.reconnect());
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
  await page.getByTestId('spawn-cwd').fill('/work/review');
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId('member-beta')).toBeVisible();

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
