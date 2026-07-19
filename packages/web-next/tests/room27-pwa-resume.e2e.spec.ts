import { expect, test, type Page } from '@playwright/test';

// Lossless resume. A phone freezes the tab mid-turn; the socket it wakes
// holding is often one the server abandoned. Evidence produced during that gap
// exists durably but was never streamed, so recovery has to come from the
// per-room sequence plus a re-read of still-mutable journals — not a reload.
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface Turn { room: string; root: number }
interface Row { id: number }

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

const step = async (room: string, name: string, opts: Record<string, unknown> = {}) =>
  await control<Row>('/stretch-step', { room, step: name, ...opts });

async function openRoom(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${room}&token=next-e2e-token`);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

/** Background the tab, then bring it back — the resume signal a phone sends. */
async function sleepAndResume(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('pwa resume', () => {
  test('evidence produced while asleep appears once, in order, without a reload', async ({ page }) => {
    const turn = await control<Turn>('/stretch-turn');
    await openRoom(page, turn.room);

    // Stretch one arrives live.
    await step(turn.room, 'stretch', { text: 'stretch one live', own: false });
    await expect(page.locator('.nx-column')).toContainText('stretch one live');

    // Asleep: stretch two and tool evidence are written durably but never
    // streamed, exactly like a frozen tab missing frames.
    await step(turn.room, 'stretch', { text: 'stretch two while away', live: false });
    await step(turn.room, 'tools', { live: false });

    await sleepAndResume(page);

    // Recovered from the sequence and the journal re-read — no reload.
    await expect(page.locator('.nx-column')).toContainText('stretch two while away');
    await expect(page.getByTestId('tool-batch')).toHaveCount(1);

    // Stretch three, live again, then settle.
    const third = await step(turn.room, 'stretch', { text: 'stretch three live' });
    await expect(page.locator(`[data-testid="run-${String(third.id)}"]`)).toBeVisible();
    await step(turn.room, 'complete');

    // Everything appears exactly ONCE, in order.
    const column = page.locator('.nx-column');
    for (const text of ['stretch one live', 'stretch two while away', 'stretch three live']) {
      await expect(column.getByText(text, { exact: false })).toHaveCount(1);
    }
    const order = await column.evaluate((node) => {
      const text = node.textContent ?? '';
      return {
        one: text.indexOf('stretch one live'),
        two: text.indexOf('stretch two while away'),
        three: text.indexOf('stretch three live'),
      };
    });
    expect(order.one).toBeLessThan(order.two);
    expect(order.two).toBeLessThan(order.three);

    // A normal reload agrees with what resume recovered.
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    for (const text of ['stretch one live', 'stretch two while away', 'stretch three live']) {
      await expect(column.getByText(text, { exact: false })).toHaveCount(1);
    }
  });

  test('a turn that completes while asleep recovers on resume', async ({ page }) => {
    const turn = await control<Turn>('/stretch-turn');
    await openRoom(page, turn.room);
    await step(turn.room, 'stretch', { text: 'before the sleep', own: false });
    await expect(page.locator('.nx-column')).toContainText('before the sleep');

    // Stays backgrounded through the terminal completion.
    await step(turn.room, 'stretch', { text: 'produced while away', live: false });
    await step(turn.room, 'tools', { live: false });
    await step(turn.room, 'complete', { live: false });

    await sleepAndResume(page);

    // Sequence sync plus the terminal journal supply the whole tail.
    await expect(page.locator('.nx-column')).toContainText('produced while away');
    await expect(page.getByTestId('tool-batch')).toHaveCount(1);
    await expect(page.locator('.nx-column').getByText('produced while away', { exact: false }))
      .toHaveCount(1);
    // A settled family shows no running indicator.
    await expect(page.getByTestId('typing-elapsed')).toHaveCount(0);
  });

  test('an inactive room catches up on resume, on one socket, without reading its journals', async ({ page }) => {
    // The room must exist and be SUBSCRIBED before any work starts in it —
    // creating a running turn first would make the working state true at
    // hydration, and the catch-up this test is named for would never happen.
    const { room } = await control<{ room: string }>('/stretch-room');

    const open: { closed: boolean }[] = [];
    page.on('websocket', (socket) => {
      const entry = { closed: false };
      open.push(entry);
      socket.on('close', () => { entry.closed = true; });
    });
    const journalReads: string[] = [];
    page.on('request', (request) => {
      const match = /\/api\/rooms\/([^/]+)\/runs\//.exec(new URL(request.url()).pathname);
      if (match) journalReads.push(match[1]!);
    });

    await page.goto('/?room=eng&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    const rail = page.getByTestId(`room-link-${room}`);
    await expect(rail).toBeVisible();

    // Nothing is happening there yet — that is the baseline these assertions
    // are "newly appears" against.
    await expect(page.getByTestId(`room-working-${room}`)).toHaveCount(0);
    await expect(page.getByTestId(`rail-unread-${room}`)).toHaveCount(0);

    // Now it starts working and produces output, with every frame withheld.
    await control('/stretch-turn', { room, live: false });
    await step(room, 'stretch', { text: 'inactive room progress', live: false });
    // A durable chat that was never broadcast: this is what an unread count is
    // actually made of, and it must catch up like the working state does.
    await control('/post-chat', {
      room, author: 'continuator', body: 'unread while the app was away',
    });

    await sleepAndResume(page);

    // Background state catches up: the room reads as working, and its unread
    // count appears — neither was true before the resume.
    await expect(page.getByTestId(`room-working-${room}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`rail-unread-${room}`)).toBeVisible({ timeout: 20_000 });

    // Exactly one socket is still OPEN: resume replaces, it does not accumulate.
    expect(open.filter((entry) => !entry.closed)).toHaveLength(1);
    const live = await page.evaluate(() => {
      const codor = (window as unknown as { __codor?: { state: () => string } }).__codor;
      return codor?.state() ?? 'missing';
    });
    expect(live).toBe('connected');

    // Evidence is read only for the room the operator is looking at.
    expect(journalReads).not.toContain(room);

    // Settle the fixture so it leaves nothing running behind it.
    await step(room, 'complete');
    await expect(page.getByTestId(`room-working-${room}`)).toHaveCount(0, { timeout: 20_000 });
  });

  test('an always-visible stall is replaced by the watchdog without any lifecycle event', async ({ page }) => {
    // The watchdog deliberately waits a probe interval plus its deadline before
    // declaring a silent socket dead, which is longer than the default timeout.
    test.setTimeout(120_000);
    const turn = await control<Turn>('/stretch-turn');

    // Stall ONLY the first connection, and only after hydration. Overriding
    // WebSocket.prototype.send would silence the replacement too, so the
    // watchdog could never recover — the proxy keeps every later connection
    // healthy, which is the whole point of replacing a dead one.
    let connections = 0;
    let stallFirst = false;
    await page.routeWebSocket(/\/ws\?/, (ws) => {
      const index = ++connections;
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (index === 1 && stallFirst) return; // the wire is dead, silently
        server.send(message as string);
      });
      server.onMessage((message) => {
        if (index === 1 && stallFirst) return;
        ws.send(message as string);
      });
    });

    await openRoom(page, turn.room);
    await step(turn.room, 'stretch', { text: 'before the stall', own: false });
    await expect(page.locator('.nx-column')).toContainText('before the stall');

    // No close, no visibility change, no offline event: the socket simply stops
    // carrying traffic while still reporting OPEN.
    stallFirst = true;
    await step(turn.room, 'stretch', { text: 'produced during the stall', live: false });

    // Prove the connector seam first: the watchdog must replace the socket with
    // no lifecycle event at all. Asserting the recovered text before this would
    // conflate "never replaced" with "replaced but did not recover".
    await expect.poll(() => connections, { timeout: 60_000 }).toBeGreaterThan(1);

    // Then prove recovery across that replacement.
    await expect(page.locator('.nx-column'))
      .toContainText('produced during the stall', { timeout: 60_000 });
  });
});
