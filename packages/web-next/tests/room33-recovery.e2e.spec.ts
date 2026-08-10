import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
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
    };
    runtime.__CODOR_RELAY_URL = url;
    runtime.__codorRelayAppOpens = [];
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
  test('when the host returns, the app recovers with NO reload (connector stayed mounted)', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await fastRecovery(page, 60_000); // stay agent-offline, don't escalate

    await control('/relay-down');
    await expect(page.getByTestId('recovery')).toHaveAttribute('data-recovery-state', 'agent-offline', { timeout: 15_000 });

    // Host comes back: the still-mounted connector's own backoff reconnects — the
    // overlay clears and the app is live again WITHOUT any navigation.
    await control('/relay-up');
    await expect(page.getByTestId('recovery')).toHaveCount(0, { timeout: 30_000 });
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
  // harn:end hosted-app-streams-follow-tunnel-generations
  // harn:end hosted-foregrounding-reuses-healthy-sessions

  test('a sustained outage escalates to the re-pair state (down-clock persists), and re-pair returns to code entry', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await fastRecovery(page, 1_500);

    await control('/relay-down');
    // The escalation is only reachable because the app never unmounts/reloads —
    // the down-clock runs continuously past the extended threshold.
    await expect(page.getByTestId('recovery-repair')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('recovery')).toHaveAttribute('data-recovery-state', 'agent-offline-extended');
    await expect(page.getByText('Still can’t reach your agent')).toBeVisible();
    expect(await noReload(page)).toBe(true); // never auto-reloaded during escalation

    // Truly modal: with the overlay up, focus can never reach the inert app beneath.
    await page.getByTestId('recovery-retry').focus();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const leaked = await page.evaluate(() => Boolean(document.activeElement?.closest('[aria-hidden="true"]')));
      expect(leaked).toBe(false);
    }

    await page.getByTestId('recovery-repair').click();
    await expect(page.getByTestId('pairing-code-0')).toBeVisible({ timeout: 15_000 });
  });

  test('a device going offline shows the device-offline message, not a pairing failure', async ({ page, context }) => {
    test.setTimeout(120_000);
    await pairLive(page);

    // device-offline must WIN over agent-offline (never blame the pairing for the
    // device's own network). Drop the host too so `connected` flips promptly.
    await context.setOffline(true);
    await control('/relay-down');
    await expect(page.getByTestId('recovery')).toHaveAttribute('data-recovery-state', 'device-offline', { timeout: 15_000 });
    await expect(page.getByText('You appear to be offline')).toBeVisible();
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
