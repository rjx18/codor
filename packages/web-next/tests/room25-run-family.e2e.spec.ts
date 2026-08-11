import { expect, test, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

// Terminal presentation for a run FAMILY — a lifecycle root plus the rows it
// continued into. Both shapes here are ones live traffic produced: #833 -> #835
// kept its evidence on the root with an empty result, and #856 -> #858 was the
// exact inverse. A marker attached to "the root" gets one of them wrong, so
// each is pinned separately.
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface Family { room: string; root: number; result: number; status: string }

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function openRoom(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${room}&token=next-e2e-token`);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

test.describe('terminal run family', () => {
  test('root-owned evidence survives and the sole marker sits on the result (#833 → #835)', async ({ page }) => {
    const family = await control<Family>('/seed-terminal-family', {
      shape: 'root-evidence', status: 'interrupted',
    });
    await openRoom(page, family.room);

    const root = page.locator(`article[id="${String(family.root)}"]`);
    const result = page.locator(`[data-testid="run-${String(family.result)}"]`);
    await expect(root).toBeVisible();
    await expect(result).toBeVisible();

    // The evidence that existed before the stop is still exactly where it was.
    await expect(root).toContainText('Root stretch before the stop.');
    const batch = root.getByTestId('tool-batch');
    await expect(batch).toHaveCount(1);
    await batch.locator('.nx-batch-line').click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);

    // Exactly one marker in the whole family, and it is on the result row.
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(result.getByTestId(`run-${String(family.result)}-status`))
      .toHaveText('run interrupted');
    await expect(root.locator('.nx-run-status')).toHaveCount(0);

    // The result stays permalinkable.
    await expect(result.locator('.nx-permalink')).toHaveText(`#${String(family.result)}`);

    // Reload preserves both the evidence and the single marker's ownership.
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(root).toContainText('Root stretch before the stop.');
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(result.getByTestId(`run-${String(family.result)}-status`)).toBeVisible();
  });

  // harn:assume historical-transcript-pages-match-output-scoped-rendering ref=room25-result-prose-descendant-order
  // harn:assume live-runs-settle-beside-paged-history-once ref=room25-terminal-family-evidence-order
  test('result-owned prose precedes the sole marker, with nothing on the root (#856 → #858)', async ({ page }) => {
    const family = await control<Family>('/seed-terminal-family', {
      shape: 'result-evidence', status: 'failed',
    });
    await openRoom(page, family.room);

    const root = page.locator(`article[id="${String(family.root)}"]`);
    const result = page.locator(`[data-testid="run-${String(family.result)}"]`);
    await expect(result).toContainText('Result stretch carrying the only prose.');

    // No status on the root, even though the root holds the lifecycle summary.
    await expect(root.locator('.nx-run-status')).toHaveCount(0);
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    const marker = result.getByTestId(`run-${String(family.result)}-status`);
    await expect(marker).toHaveText('run failed');

    // The marker FOLLOWS the result's own output rather than preceding it.
    const order = await result.evaluate((node) => {
      const descendants = [...node.querySelectorAll('.nx-run-block, .nx-run-status')];
      return {
        prose: descendants.findIndex((child) => child.classList.contains('nx-run-block')),
        status: descendants.findIndex((child) => child.classList.contains('nx-run-status')),
      };
    });
    expect(order.prose).toBeGreaterThanOrEqual(0);
    expect(order.status).toBeGreaterThan(order.prose);
  });
  // harn:end live-runs-settle-beside-paged-history-once
  // harn:end historical-transcript-pages-match-output-scoped-rendering

  test('a family with no lifecycle evidence never claims completed', async ({ page }) => {
    // The root is pushed outside the bounded hydration tail while its result
    // stays in it. Until the terminal journal settles the UI must say nothing —
    // silence is the honest state, and a green "completed" would be a guess.
    // Filler sits BETWEEN root and result, so the root falls out of the tail
    // while the result stays in it — seeding after both would drop the pair.
    const family = await control<Family>('/seed-terminal-family', {
      shape: 'result-evidence', status: 'failed', gap: 25,
    });
    await openRoom(page, family.room);

    const result = page.locator(`[data-testid="run-${String(family.result)}"]`);
    await expect(result).toBeVisible();
    await expect(page.locator(`article[id="${String(family.root)}"]`)).toHaveCount(0);

    // Whatever it settles on, it is never a fabricated success.
    await expect(page.locator('.nx-run-status.is-completed')).toHaveCount(0);
    await expect(result.getByTestId(`run-${String(family.result)}-status`))
      .toHaveText('run failed');
    // And the out-of-window root is not injected into the transcript to get it.
    await expect(page.locator(`article[id="${String(family.root)}"]`)).toHaveCount(0);
  });
});

test.describe('live run family ownership', () => {
  interface Live { room: string; root: number; started_ts: string }
  interface Row { id: number }

  const step = async (room: string, handle: string, name: string, body?: string) =>
    await control<Row>('/live-family-step', { room, handle, step: name, body });

  test('the pill clock advances with real time and never restarts on continuation', async ({ page }) => {
    const live = await control<Live>('/live-family', { handle: 'continuator' });
    // A real fake clock, installed before load: monotonic >= proves nothing,
    // because a reset clock also grows. Advancing it deliberately and checking
    // the delta is what proves the timer kept counting from the root's start.
    await page.clock.install();
    await openRoom(page, live.room);

    const pill = page.getByTestId('typing-continuator');
    const timer = pill.getByTestId('typing-elapsed');
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(1);
    await expect(page.locator('.nx-turn .nx-typing-elapsed')).toHaveCount(0);
    const read = async () => Number((await timer.getAttribute('data-elapsed-ms')) ?? '0');

    const start = await read();
    expect(start).toBeGreaterThan(60_000); // counting from started_ts, not page load

    await page.clock.fastForward(30_000);
    const advanced = await read();
    expect(advanced - start).toBeGreaterThanOrEqual(29_000);

    // Interject and continue: the clock keeps its accumulated time.
    await step(live.room, 'continuator', 'interject');
    const one = await step(live.room, 'continuator', 'continue', 'First continuation.');
    await expect(page.locator(`[data-testid="run-${String(one.id)}"]`)).toBeVisible();
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(1);
    await expect(page.locator('.nx-turn .nx-typing-elapsed')).toHaveCount(0);
    const afterContinuation = await read();
    expect(afterContinuation).toBeGreaterThanOrEqual(advanced - 1_000);

    await page.clock.fastForward(30_000);
    await step(live.room, 'continuator', 'interject', 'Second operator interjection.');
    const two = await step(live.room, 'continuator', 'continue', 'Second continuation.');
    await expect(page.locator(`[data-testid="run-${String(two.id)}"]`)).toBeVisible();
    const afterSecond = await read();
    // Two 30s advances after a ~90s head start: a restart could not reach this.
    expect(afterSecond).toBeGreaterThanOrEqual(start + 59_000);
  });

  test('two agents running in the same room each get one pill and one timer', async ({ page }) => {
    const first = await control<Live>('/live-family', { handle: 'continuator' });
    // The SAME room — a second call without this would have created another
    // room, and the test would have proved nothing about two agents at once.
    await control<Live>('/live-family', { handle: 'seconder', room: first.room });
    await openRoom(page, first.room);

    await expect(page.getByTestId('typing-continuator')).toBeVisible();
    await expect(page.getByTestId('typing-seconder')).toBeVisible();
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(2);
    await expect(page.getByTestId('typing-continuator').getByTestId('typing-elapsed')).toHaveCount(1);
    await expect(page.getByTestId('typing-seconder').getByTestId('typing-elapsed')).toHaveCount(1);

    // Continuing one family leaves the other's pill and clock untouched.
    await step(first.room, 'continuator', 'continue', 'Only the first agent continues.');
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(2);
    await expect(page.locator('.nx-turn .nx-typing-elapsed')).toHaveCount(0);
  });

  test('an evidence-free run paints nothing, then the same row shows its evidence', async ({ page }) => {
    const live = await control<Live>('/live-family', { handle: 'continuator' });
    await openRoom(page, live.room);
    const root = page.locator(`[data-testid="run-${String(live.root)}"]`);

    // Running, but nothing produced yet: the pill says so and the transcript
    // shows no empty numbered bubble.
    await expect(page.getByTestId('typing-continuator')).toBeVisible();
    await expect(root).toBeHidden();
    await expect(page.locator('.nx-turn:visible')).toHaveCount(0);

    // Evidence arrives on the SAME permanent row, which reveals itself.
    await step(live.room, 'continuator', 'evidence');
    await expect(root).toBeVisible();
    await expect(root).toContainText('Live root stretch.');
    await expect(root.getByTestId('tool-batch')).toHaveCount(1);
  });

  // harn:assume visible-transcript-grouping-ignores-hidden-boundaries ref=transcript-grouping-browser-regression
  test('an evidence-free row does not orphan the next visible same-author continuation', async ({ page }) => {
    const live = await control<Live>('/live-family', { handle: 'continuator' });
    await openRoom(page, live.room);
    const root = page.locator(`[data-testid="run-${String(live.root)}"]`);

    await expect(page.getByTestId('typing-continuator')).toBeVisible();
    await expect(root).toBeHidden();

    // The hidden root has no visible turn state to contribute. This same-author
    // continuation must keep its own header instead of appearing indented under
    // the CSS-hidden root.
    const continuation = await step(
      live.room,
      'continuator',
      'continue',
      'Visible continuation after an evidence-free root.',
    );
    const continuationRow = page.locator(`[data-testid="run-${String(continuation.id)}"]`);
    await expect(continuationRow).toBeVisible();
    await expect(continuationRow).not.toHaveClass(/is-grouped/);
    await expect(continuationRow.locator('.nx-turn-meta')).toHaveCount(1);
  });
  // harn:end visible-transcript-grouping-ignores-hidden-boundaries

  test('interruption preserves evidence and leaves one marker after it', async ({ page }) => {
    const live = await control<Live>('/live-family', { handle: 'continuator' });
    await openRoom(page, live.room);
    const root = page.locator(`[data-testid="run-${String(live.root)}"]`);
    await step(live.room, 'continuator', 'evidence');

    // Before: real prose and real tool evidence are on screen.
    await expect(root).toContainText('Live root stretch.');
    const batchBefore = root.getByTestId('tool-batch');
    await expect(batchBefore).toHaveCount(1);
    await batchBefore.locator('.nx-batch-line').click();
    await expect(batchBefore.locator('.nx-tool')).toHaveCount(2);
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(1);
    await expect(page.locator('.nx-run-status')).toHaveCount(0);

    await step(live.room, 'continuator', 'interject');
    const cont = await step(live.room, 'continuator', 'continue', 'Work before the stop.');
    await step(live.room, 'continuator', 'interrupt');

    const owner = page.locator(`[data-testid="run-${String(cont.id)}"]`);
    // Those exact nodes remain; the pill and its clock are gone; one marker.
    await expect(root).toContainText('Live root stretch.');
    await expect(root.getByTestId('tool-batch')).toHaveCount(1);
    await expect(owner).toContainText('Work before the stop.');
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(0);
    await expect(page.getByTestId('typing-continuator')).toHaveCount(0);
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(owner.getByTestId(`run-${String(cont.id)}-status`)).toHaveText('run interrupted');

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(root).toContainText('Live root stretch.');
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(owner.getByTestId(`run-${String(cont.id)}-status`)).toBeVisible();
  });
});

test.describe('out-of-window root with a withheld journal', () => {
  // harn:assume finalized-browser-history-is-combined-page-owned ref=room25-finalized-history-request-boundary
  // harn:assume transcript-history-prepends-one-deliberate-page ref=room25-cursor-paging-request
  test('the barrier holds, then the result owns the sole marker', async ({ page }) => {
    const family = await control<Family>('/seed-terminal-family', {
      shape: 'result-evidence', status: 'failed', gap: 25,
    });

    const historyRequests: string[] = [];
    const finalizedJournalRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/rooms/${family.room}/transcript-history`) {
        historyRequests.push(url.search);
      }
      if (new RegExp(`^/api/rooms/${family.room}/runs/\\d+$`).test(url.pathname)) {
        finalizedJournalRequests.push(url.pathname);
      }
    });

    let holding = true;
    let initialHistoryHeld = false;
    await page.route(`**/api/rooms/${family.room}/transcript-history*`, async (route) => {
      if (!initialHistoryHeld) {
        initialHistoryHeld = true;
        while (holding) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await route.continue();
    });

    await page.goto(`/?room=${family.room}&token=next-e2e-token`);
    const result = page.locator(`[data-testid="run-${String(family.result)}"]`);
    const timeline = page.getByTestId('timeline');

    // The first combined page is held: atomic hydration must not paint a
    // partially materialized finalized family or invent its status.
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect.poll(() => initialHistoryHeld).toBe(true);
    await expect(result).toHaveCount(0);
    await expect(page.locator('.nx-run-status')).toHaveCount(0);
    await expect(page.locator('.nx-run[data-run-status="completed"]')).toHaveCount(0);

    holding = false;

    // Releasing the combined page renders the result-owned evidence and its
    // sole marker; the out-of-window root is still absent.
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(result).toContainText('Result stretch carrying the only prose.');
    await expect(result.getByTestId(`run-${String(family.result)}-status`))
      .toHaveText('run failed');
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(page.locator(`article[id="${String(family.root)}"]`)).toHaveCount(0);
    await expect.poll(() => historyRequests.length).toBe(1);
    expect(historyRequests[0]).toBe('');
    expect(finalizedJournalRequests).toEqual([]);

    // Paging the root in uses a cursor page, moves nothing, and duplicates
    // neither the root nor the already-rendered result marker.
    await revealOlder(page, page.locator(`article[id="${String(family.root)}"]`));
    await expect.poll(() => historyRequests.filter((search) => new URLSearchParams(search).has('cursor')).length)
      .toBeGreaterThan(0);
    await expect(timeline).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
    // Combined history represents this empty lifecycle root through one
    // settled family unit; paging must not create a second root representation.
    await expect(page.locator(
      `[data-transcript-unit^="settled_tail:${String(family.root)}:${String(family.result)}:"]`,
    )).toHaveCount(1);
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(result).toHaveCount(1);
    await expect(result.getByTestId(`run-${String(family.result)}-status`)).toHaveCount(1);
    await expect(page.locator(`article[id="${String(family.root)}"] .nx-run-status`)).toHaveCount(0);
    expect(finalizedJournalRequests).toEqual([]);
  });
  // harn:end transcript-history-prepends-one-deliberate-page
  // harn:end finalized-browser-history-is-combined-page-owned
});

test.describe('historical one-row families', () => {
  interface Legacy { room: string; run: number; status: string }

  test('a partial legacy family keeps its stretches and ends with one marker', async ({ page }) => {
    const legacy = await control<Legacy>('/seed-historical-family', {
      shape: 'partial', status: 'interrupted',
    });
    await openRoom(page, legacy.room);

    const row = page.locator(`[data-testid="run-${String(legacy.run)}"]`);
    await expect(row.first()).toBeVisible();
    await expect(page.locator('.nx-column')).toContainText('Legacy stretch one.');
    await expect(page.locator('.nx-column')).toContainText('Legacy stretch two.');

    // Exactly one marker for the family, on its final stretch, after the text.
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(page.locator('.nx-run-status')).toHaveText('run interrupted');
    const order = await page.locator('.nx-column').evaluate((column) => {
      const nodes = [...column.querySelectorAll('.nx-run-block, .nx-run-status')];
      return {
        lastProse: nodes.map((n) => n.className).lastIndexOf('nx-run-block'),
        status: nodes.findIndex((n) => n.classList.contains('nx-run-status')),
      };
    });
    expect(order.status).toBeGreaterThan(order.lastProse);

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
  });

  test('an empty legacy family still states what happened', async ({ page }) => {
    const legacy = await control<Legacy>('/seed-historical-family', {
      shape: 'empty', status: 'failed',
    });
    await openRoom(page, legacy.room);

    // Nothing to preserve, so the marker and its reason are the whole row —
    // and an empty legacy row is NOT hidden: it is terminal, not pending.
    await expect(page.locator('.nx-run-status')).toHaveCount(1);
    await expect(page.locator('.nx-run-status')).toHaveText('run failed');
    await expect(page.getByTestId('run-error')).toContainText('legacy run failed with no output');
  });
});
