import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${room}&token=${TOKEN}`);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('cross-channel seq reconciliation', () => {
  // harn:assume selected-room-activation-reconciles-destination-history ref=selected-room-terminal-evidence-browser-regression
  test('returning to an initialized room reconciles a run finalized while inactive', async ({ page }) => {
    test.setTimeout(60_000);
    let sockets = 0;
    const finalText = 'terminal evidence finalized while engineering was inactive';
    const retryText = 'terminal evidence appears after a failed activation refresh';
    const droppedFinalTexts = new Set<string>();
    let failNextHead = false;
    const subscriptions: string[] = [];
    await page.routeWebSocket(/\/ws\?/, (ws) => {
      sockets += 1;
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          try {
            const frame = JSON.parse(message) as { type?: string; room?: string };
            if (frame.type === 'subscribe' && frame.room !== undefined) subscriptions.push(frame.room);
          } catch {
            // Binary/non-protocol traffic is forwarded unchanged.
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (typeof message === 'string') {
          for (const text of [finalText, retryText]) {
            if (!droppedFinalTexts.has(text) && message.includes(text)) {
              droppedFinalTexts.add(text);
              return;
            }
          }
        }
        ws.send(message);
      });
    });
    await page.route('**/api/rooms/eng/transcript-history*', async (route) => {
      if (!failNextHead) {
        await route.continue();
        return;
      }
      failNextHead = false;
      await route.abort();
    });
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    const engHistoryRequests = (): number => requests.filter((url) => (
      url.includes('/api/rooms/eng/transcript-history')
    )).length;
    await page.addInitScript(() => {
      const runtime = window as unknown as { __selectedRoomLoadCount?: number };
      runtime.__selectedRoomLoadCount = (runtime.__selectedRoomLoadCount ?? 0) + 1;
    });

    await open(page, 'eng');
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page.locator('.nx-skeleton')).toHaveCount(0);
    await control('/enqueue', {
      turns: [{
        kind: 'complete',
        delay_ms: 1_000,
        final_text: finalText,
      }],
    });
    await control('/start-run', { room: 'eng', handle: 'fable', prompt: 'finish after room switch' });
    await expect(page.getByTestId('timeline')).toContainText('finish after room switch');

    await page.getByTestId('room-link-research').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await expect(page.locator('.nx-skeleton')).toHaveCount(0);
    await expect.poll(() => droppedFinalTexts.has(finalText)).toBe(true);
    await expect(page.getByTestId('timeline')).not.toContainText(finalText);

    const historyBeforeReturn = engHistoryRequests();
    const journalBeforeReturn = requests.filter((url) => /\/runs\/[^/?]+/.test(url)).length;
    const socketsBeforeReturn = sockets;
    const subscriptionsBeforeReturn = subscriptions.length;
    const loadCount = await page.evaluate(() => (
      (window as unknown as { __selectedRoomLoadCount?: number }).__selectedRoomLoadCount
    ));

    await page.getByTestId('room-link-eng').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page.getByTestId('timeline').getByText(finalText, { exact: true }))
      .toHaveCount(1, { timeout: 10_000 });
    // The initialized room's bounded reconciliation may consume the immediate
    // predecessor as its second and final request. It must not walk any older
    // cursor or fall back to a finalized journal.
    await expect.poll(engHistoryRequests)
      .toBe(historyBeforeReturn + 2);

    expect(requests.filter((url) => /\/runs\/[^/?]+/.test(url))).toHaveLength(journalBeforeReturn);
    expect(sockets).toBe(socketsBeforeReturn);
    expect(subscriptions).toHaveLength(subscriptionsBeforeReturn);
    expect(await page.evaluate(() => (
      (window as unknown as { __selectedRoomLoadCount?: number }).__selectedRoomLoadCount
    ))).toBe(loadCount);

    // A failed head must preserve the mounted truth and remain retryable on a
    // later activation; this request is intentionally aborted once.
    failNextHead = true;
    await control('/enqueue', {
      turns: [{ kind: 'complete', delay_ms: 1_000, final_text: retryText }],
    });
    await control('/start-run', { room: 'eng', handle: 'fable', prompt: 'retry after a failed head' });
    await expect(page.getByTestId('timeline')).toContainText('retry after a failed head');
    await page.getByTestId('room-link-research').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await expect.poll(() => droppedFinalTexts.has(retryText)).toBe(true);
    await expect(page.getByTestId('timeline')).not.toContainText(retryText);

    const historyBeforeFailedActivation = engHistoryRequests();
    const journalBeforeFailedActivation = requests.filter((url) => /\/runs\/[^/?]+/.test(url)).length;
    await page.getByTestId('room-link-eng').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect.poll(engHistoryRequests)
      .toBe(historyBeforeFailedActivation + 1);
    await expect(page.getByTestId('timeline')).not.toContainText(retryText);

    // Switching away and back supplies a fresh activation key after the
    // failed request has cleared, so the same destination retries successfully.
    await page.getByTestId('room-link-research').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await page.getByTestId('room-link-eng').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page.getByTestId('timeline').getByText(retryText, { exact: true }))
      .toHaveCount(1, { timeout: 10_000 });
    // One aborted head plus the successful bounded head/predecessor pair.
    await expect.poll(engHistoryRequests)
      .toBe(historyBeforeFailedActivation + 3);
    expect(requests.filter((url) => /\/runs\/[^/?]+/.test(url))).toHaveLength(journalBeforeFailedActivation);
    expect(sockets).toBe(socketsBeforeReturn);
    expect(subscriptions).toHaveLength(subscriptionsBeforeReturn);
  });
  // harn:end selected-room-activation-reconciles-destination-history

  // harn:assume combined-history-sync-classifies-bounded-cold-only ref=room23-warm-replay-regression
  test('a dropped background-room message self-heals on the next probe, no reload', async ({ page }) => {
    // Short probe cadence so reconciliation runs deterministically (test seam).
    await page.addInitScript(() => {
      (window as unknown as { __codorProbeMs?: number }).__codorProbeMs = 700;
    });

    // Deterministic miss injection: drop EXACTLY ONE live server→client `message`
    // frame for a background room, forwarding everything else (incl. its
    // room_support) faithfully — the realistic transient single-frame loss.
    let dropped = false;
    await page.routeWebSocket(/\/ws\?/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (!dropped && typeof m === 'string') {
          try {
            const frame = JSON.parse(m) as { type?: string; message?: { room?: string; body?: string } };
            if (
              frame.type === 'message'
              && frame.message?.room === 'research'
              && String(frame.message?.body ?? '').includes('DROPME')
            ) {
              dropped = true;
              return; // swallow exactly one live message frame
            }
          } catch {
            // non-JSON control frame — fall through and forward
          }
        }
        ws.send(m);
      });
    });

    await open(page, 'eng');
    // Ensure research is fully hydrated (its committed cursor settled) BEFORE the
    // miss, so the dropped frame is a genuine live delta — not folded into cold
    // hydration. Visiting it and returning commits its slice.
    await page.getByTestId('room-link-research').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await page.getByTestId('room-link-eng').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');

    // A live message into the now-background room whose `message` frame we drop
    // on the wire — the client genuinely never receives it.
    await control('/live-chat', { room: 'research', author: 'analyst', route: false, body: 'DROPME reconcile probe' });
    await expect.poll(() => dropped).toBe(true);

    // Its only path back is seq reconciliation warm-resyncing research on the
    // next probe. Switching to the room (no reload) shows the recovered message.
    await page.getByTestId('room-link-research').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await expect(page.locator('.nx-prose', { hasText: 'DROPME reconcile probe' }).first())
      .toBeVisible({ timeout: 15000 });
  });
  // harn:end combined-history-sync-classifies-bounded-cold-only
});
