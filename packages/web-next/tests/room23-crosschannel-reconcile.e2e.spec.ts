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
