import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

/** Pair through the relay and land live. Returns the SPA page marked with a
 *  reload sentinel so a later assertion can prove no navigation happened. */
async function pairLive(page: Page): Promise<string> {
  await control('/relay-up'); // self-heal: a prior test may have left the relay down
  const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
  await page.addInitScript((url) => {
    const runtime = window as unknown as {
      __CODOR_RELAY_URL?: string;
      __codorRelayAppOpens?: Array<{ session: string; generation: number }>;
      __relaySessionDials?: number;
    };
    runtime.__CODOR_RELAY_URL = url;
    runtime.__codorRelayAppOpens = [];
    runtime.__relaySessionDials = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(target: string | URL, protocols?: string | string[]) {
        super(target, protocols);
        if (String(target).includes('/v1/session/')) {
          const w = window as unknown as { __relaySessionDials: number };
          w.__relaySessionDials += 1;
        }
      }
    };
  }, relayUrl);
  await page.goto(`${SPA_ORIGIN}/`);
  await expect(page.getByTestId('landing-page')).toBeVisible();
  await pasteCode(page, code);
  await page.getByTestId('pairing-code-submit').click();
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
  // A reload would clear this — later assertions prove the overlay recovered
  // WITHOUT a navigation (the connector stayed mounted and reconnected).
  await page.evaluate(() => { (window as unknown as { __noReload?: boolean }).__noReload = true; });
  return code;
}

const noReload = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);

const appOpens = (page: Page): Promise<number> => page.evaluate(() =>
  (window as unknown as { __codorRelayAppOpens: unknown[] }).__codorRelayAppOpens.length);

const relayDials = (page: Page): Promise<number> => page.evaluate(() =>
  (window as unknown as { __relaySessionDials: number }).__relaySessionDials);

const cachedBodies = (page: Page): Promise<string[]> => page.evaluate(async () => await new Promise((resolve, reject) => {
  const request = indexedDB.open('codor-last-good-room-v1');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('rooms')) {
      database.close();
      resolve([]);
      return;
    }
    const all = database.transaction('rooms', 'readonly').objectStore('rooms').getAll();
    all.onerror = () => reject(all.error);
    all.onsuccess = () => {
      const bodies = (all.result as Array<{ history?: { messages?: Record<string, { body?: string }> } }>)
        .flatMap((snapshot) => Object.values(snapshot.history?.messages ?? {}))
        .flatMap((message) => message.body === undefined ? [] : [message.body]);
      database.close();
      resolve(bodies);
    };
  };
}));

/** Shorten the recovery timings AFTER the session is live (grace < extended, never
 *  inverted), so the short grace never pre-empts the initial connect. */
async function fastRecovery(page: Page, extendedMs: number): Promise<void> {
  await page.evaluate((ext) => {
    const w = window as unknown as Record<string, unknown>;
    w.__CODOR_RECOVERY_GRACE_MS = 300;
    w.__CODOR_RECOVERY_EXTENDED_MS = ext;
  }, extendedMs);
}

test.describe('recovery journey', () => {
  // harn:assume cached-transcript-head-stays-stale-until-revalidated ref=cached-history-revalidation-regression
  test('a hard refresh reads the cached head then reconciles newer host truth without duplicates', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await control('/live-chat', { room: 'eng', body: 'cached head before outage', route: false });
    await expect(page.getByTestId('timeline')).toContainText('cached head before outage');
    // A live fanout row is intentionally outside the immutable combined page
    // until the next head read. Reload once while healthy so this exact row is
    // part of the bounded last-good projection we are about to exercise.
    await page.reload();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('timeline')).toContainText('cached head before outage');
    await expect.poll(() => cachedBodies(page)).toContain('cached head before outage');

    await control('/relay-down');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 15_000 });
    await control('/live-chat', { room: 'eng', body: 'new host row while browser was away', route: false });
    await page.reload();
    await expect(page.getByTestId('timeline')).toContainText('cached head before outage', { timeout: 20_000 });
    await expect(page.getByTestId('timeline')).not.toContainText('new host row while browser was away');

    await control('/relay-up');
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('timeline')).toContainText('new host row while browser was away');
    await expect(page.locator('.nx-prose', { hasText: 'cached head before outage' })).toHaveCount(1);
    await expect(page.locator('.nx-prose', { hasText: 'new host row while browser was away' })).toHaveCount(1);
  });
  // harn:end cached-transcript-head-stays-stale-until-revalidated

  test('when the host returns, the app recovers with NO reload (connector stayed mounted)', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await fastRecovery(page, 60_000); // stay agent-offline, don't escalate

    await control('/relay-down');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('recovery')).toHaveCount(0);
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    await expect(page.getByTestId('toggle-message-search')).toBeEnabled();

    // Host comes back: the still-mounted connector's own backoff reconnects — the
    // overlay clears and the app is live again WITHOUT any navigation.
    await control('/relay-up');
    await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    expect(await noReload(page)).toBe(true);
  });

  // harn:assume hosted-foregrounding-reuses-healthy-sessions ref=foreground-health-browser-regression
  // harn:assume hosted-app-streams-follow-tunnel-generations ref=coordinated-recovery-browser-regression
  test('healthy foregrounding keeps the tunnel and app stream without reload', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    const before = await appOpens(page);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    expect(await appOpens(page)).toBe(before);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    expect(await noReload(page)).toBe(true);
  });

  test('a dead foregrounded connection recovers one app stream without reload', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    const before = await appOpens(page);

    await control('/relay-down');
    await expect(page.getByTestId('connection')).toHaveClass(/is-error/, { timeout: 30_000 });
    await control('/relay-up');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    await expect.poll(() => appOpens(page), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await appOpens(page)).toBe(before + 1);
    expect(await noReload(page)).toBe(true);
  });

  // harn:assume relay-host-generations-retire-stale-clients ref=relay-host-replacement-browser-regression
  test('host replacement performs one fresh handshake and restores root plus worktree rooms', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await fastRecovery(page, 60_000);
    const beforeDials = await relayDials(page);
    const beforeApps = await appOpens(page);
    const { registered } = await control<{
      registered: Array<{ id: string; branch: string; conversation_id: string }>;
    }>('/wt-registered', { room: 'workspace' });
    const child = registered.find((entry) => entry.branch === 'feature/review');
    expect(child).toBeDefined();

    await page.getByTestId('room-link-workspace').click();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${child!.id}`)).toHaveAttribute('aria-label', /Connected/);
    await control('/relay-replace-host');

    await expect.poll(() => relayDials(page), { timeout: 30_000 }).toBe(beforeDials + 1);
    await expect.poll(() => appOpens(page), { timeout: 30_000 }).toBe(beforeApps + 1);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId(`worktree-link-${child!.id}`)).toHaveAttribute(
      'aria-label', /Connected/, { timeout: 30_000 },
    );
    expect(await noReload(page)).toBe(true);

    await control('/live-chat', { room: 'workspace', body: 'root recovered after host replacement', route: false });
    await control('/live-chat', {
      room: child!.conversation_id,
      body: 'worktree recovered after host replacement',
      route: false,
    });
    await expect(page.getByTestId('timeline')).toContainText('root recovered after host replacement');
    await expect(page.getByTestId('timeline')).not.toContainText('worktree recovered after host replacement');
    await page.getByTestId(`worktree-link-${child!.id}`).click();
    await expect(page.getByTestId('timeline')).toContainText('worktree recovered after host replacement');
    await expect(page.getByTestId('timeline')).not.toContainText('root recovered after host replacement');

    const diagnostics = await control<{ errors: string[] }>('/relay-errors');
    expect(diagnostics.errors.join('\n')).not.toContain('msg1 must be 40 bytes');
  });
  // harn:end relay-host-generations-retire-stale-clients
  // harn:end hosted-app-streams-follow-tunnel-generations
  // harn:end hosted-foregrounding-reuses-healthy-sessions

  test('a sustained ordinary outage keeps retained chat readable and recovers in place', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await fastRecovery(page, 1_500);

    await control('/relay-down');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('recovery')).toHaveCount(0);
    await expect(page.getByTestId('timeline')).toBeVisible();
    expect(await noReload(page)).toBe(true);
    await control('/relay-up');
    await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
  });

  test('a device going offline shows the device-offline message, not a pairing failure', async ({ page, context }) => {
    test.setTimeout(120_000);
    await pairLive(page);

    // device-offline must WIN over agent-offline (never blame the pairing for the
    // device's own network). Drop the host too so `connected` flips promptly.
    await context.setOffline(true);
    await control('/relay-down');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('recovery')).toHaveCount(0);
    await expect(page.getByTestId('recovery-repair')).toHaveCount(0);
    await context.setOffline(false);
  });

  test('a code whose room never answers says "get a fresh code", not re-pair', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    // Mint just to learn the relay URL; we deliberately claim a DIFFERENT code.
    const { code: minted, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CODOR_RELAY_URL = url;
      w.__CODOR_PAIR_DEADLINE_MS = 2_000; // fail fast when the host never joins
    }, relayUrl);

    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    // A well-formed code whose NAMEPLATE (first two chars) cannot match the
    // reserved room, so it has no host — the realistic wrong/expired-code case and
    // the ledgered dead-room case. The claim never completes → the deadline fires.
    const first = minted[0] === '2' ? '3' : '2';
    await pasteCode(page, `${first}BCDEFGH`);
    await page.getByTestId('pairing-code-submit').click();

    // The pairing-time classifier's fresh-code copy — NOT re-pair — and it stays
    // on the landing (code entry), never the recovery surface.
    await expect(page.getByText(/get a fresh code and try again/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pairing-code-0')).toBeVisible();
    await expect(page.getByTestId('recovery')).toHaveCount(0);
  });
});
