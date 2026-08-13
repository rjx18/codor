import { expect, test } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
// The SPA is served from its OWN origin, distinct from the switchboard — the
// production topology (codor.app on Pages vs the self-hosted switchboard). This
// is what forces every REST call through the tunnel: a direct fetch to this
// origin's /api/* hits the Pages-style index.html fallback (HTML 200), which is
// the exact failure that same-origin test harnesses masked.
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: import('@playwright/test').Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

async function installFakeMedia(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const stream = { getTracks: () => [{ stop() {} }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    class FakeAudioContext {
      state = 'suspended';
      sampleRate = 24_000;
      destination = {};
      resume() { this.state = 'running'; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const context = this;
        const node: { onaudioprocess: ((event: unknown) => void) | null; timer: number; connect(): void; disconnect(): void } = {
          onaudioprocess: null,
          timer: 0,
          connect() {
            node.timer = window.setInterval(() => {
              if (context.state === 'running') node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(2_048).fill(0.4) },
              });
            }, 40);
          },
          disconnect() { window.clearInterval(node.timer); },
        };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    Object.assign(window, { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext });
  });
}

test.describe('relay tunnel journey', () => {
  test('pairs through the relay in real Chromium, tunnels traffic, and recovers after the host drops', async ({ page }) => {
    test.setTimeout(180_000);
    // The switchboard mints a code through the (mock) blind relay.
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    // Relay-mode selection: the hosted SPA would bake this; e2e sets it at runtime.
    await page.addInitScript((url) => {
      const runtime = window as unknown as {
        __CODOR_RELAY_URL?: string;
        __codorRelayAppOpens?: Array<{ session: string; generation: number }>;
      };
      runtime.__CODOR_RELAY_URL = url;
      runtime.__codorRelayAppOpens = [];
    }, relayUrl);
    await installFakeMedia(page);
    await page.context().grantPermissions(['microphone']);

    // Any direct /api/* request to the SPA origin means a REST call escaped the
    // tunnel — the production bug. Fail the run if even one is attempted.
    const directApiHits: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(`${SPA_ORIGIN}/api/`)) directApiHits.push(url);
    });

    // Load the SPA from its OWN origin (not the switchboard) — production topology.
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();

    // Pair through the relay — real browser CPace PAKE runs here (webcrypto).
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();

    // Landed in the app over the tunnel — this required the KK session handshake
    // (webcrypto) plus tunnelled device auth to succeed first.
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    const initialAppOpens = await page.evaluate(() =>
      (window as unknown as { __codorRelayAppOpens: unknown[] }).__codorRelayAppOpens.length);
    expect(initialAppOpens).toBe(1);

    // Post over the tunnel and see it echoed back over the tunnel.
    // Address a HUMAN member so the post satisfies the composer's "say who this
    // is for" guard without kicking off an agent run — the point here is the
    // client→server→client round trip over the tunnel, not agent behaviour.
    const input = page.getByTestId('composer-input');
    // harn:assume composer-acknowledgement-separates-raw-draft-from-canonical-echo ref=raw-draft-acknowledgement-regression
    const rawRelayBody = '@viewer hello over the relay ';
    await input.fill(rawRelayBody);
    // The composer only sends once the room has hydrated over the tunnel; the
    // send button enabling is that gate (connected AND hydrated AND non-empty).
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
    await input.press('Enter');
    await expect(page.getByTestId('timeline')).toContainText('hello over the relay', { timeout: 20_000 });
    await expect(input).not.toHaveValue(rawRelayBody);
    // harn:end composer-acknowledgement-separates-raw-draft-from-canonical-echo

    // Attachment upload and retrieval both cross the tunnel. The presented URL
    // is a blob and preserves the exact uploaded bytes.
    await page.setInputFiles('[data-testid="composer-file"]', {
      name: 'relay.png', mimeType: 'image/png', buffer: PNG,
    });
    await input.fill('@viewer attachment over the relay');
    await expect(page.getByTestId('composer-send')).toBeEnabled();
    await page.getByTestId('composer-send').click();
    const attachment = page.locator('.nx-attach-image img').last();
    await expect(attachment).toHaveAttribute('src', /^blob:/, { timeout: 20_000 });
    const retrieved = await attachment.evaluate(async (image) => [
      ...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer()),
    ]);
    expect(retrieved).toEqual([...PNG]);

    // Voice already uses the routed byte path; exercise it on the same separate
    // SPA origin so a regression to native fetch is caught by directApiHits.
    await input.fill('@viewer');
    await expect(page.getByTestId('composer-mic')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('composer-mic').click();
    await page.waitForTimeout(180);
    await page.getByTestId('dictation-add').click();
    await page.getByTestId('dictation-send').click();
    await expect(page.locator('[data-testid^="voice-card-"]').last()).toContainText('dictation', { timeout: 30_000 });

    // Scheduled mutations use the same routed browser connection. The retained
    // card remains readable while the host generation is down, but its Cancel
    // target is disabled until the replacement stream proves this room live.
    const scheduledMarker = `relay-scheduled-${Date.now()}`;
    await input.fill(`[send_in=1h] @fable ${scheduledMarker}`);
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('composer-send').click();
    const scheduledCard = page.locator('[data-testid^="schedule-card-"]').filter({ hasText: scheduledMarker });
    await expect(scheduledCard).toBeVisible({ timeout: 20_000 });

    // Kill the tunnel host (agent offline) → the connection visibly drops.
    await control('/relay-down');
    await expect(page.getByTestId('connection')).toHaveClass(/is-error/, { timeout: 30_000 });
    await expect(scheduledCard).toBeVisible();
    await expect(scheduledCard.getByRole('button', { name: /cancel scheduled message/i })).toBeDisabled();

    // harn:assume hosted-app-streams-follow-tunnel-generations ref=coordinated-recovery-browser-regression
    // harn:assume relay-app-socket-readiness-requires-server-evidence ref=relay-app-socket-readiness-browser-regression
    // Restart the host → the reconnect layering re-opens on the new session.
    await control('/relay-up');
    // Connected is published only after the replacement app socket receives a
    // server frame, so it is also the deterministic send-admission gate. No
    // fixed sleep may stand in for that bidirectional evidence.
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 40_000 });
    await expect(scheduledCard.getByRole('button', { name: /cancel scheduled message/i })).toBeEnabled({ timeout: 20_000 });
    await scheduledCard.getByRole('button', { name: /cancel scheduled message/i }).click();
    await expect(scheduledCard).toContainText('Cancelled', { timeout: 20_000 });

    // Still functional after recovery — a fresh app-WS stream on the NEW session.
    await input.fill('@viewer back after recovery');
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
    await input.press('Enter');
    await expect(page.getByTestId('timeline')).toContainText('back after recovery', { timeout: 20_000 });
    // harn:end relay-app-socket-readiness-requires-server-evidence
    expect(await page.evaluate(() =>
      (window as unknown as { __codorRelayAppOpens: unknown[] }).__codorRelayAppOpens.length))
      .toBe(initialAppOpens + 1);
    // harn:end hosted-app-streams-follow-tunnel-generations

    // The relay-mode data path — channel list, summary, compatibility, message
    // history, posts — all went over the tunnel; nothing leaked to a direct /api
    // fetch on the hosted origin. (The pre-pairing landing's local trusted-pairing
    // probe runs before relay mode exists and is a separate, harmless concern.)
    const dataLeaks = directApiHits.filter((u) => !u.includes('/api/pairing/'));
    expect(dataLeaks, `REST escaped the tunnel to the page origin: ${dataLeaks.join(', ')}`).toEqual([]);
  });
});
