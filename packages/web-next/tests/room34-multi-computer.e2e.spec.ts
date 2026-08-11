import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
// The switchboard SERVES its own SPA here (direct/self-hosted topology, same-origin API).
const DIRECT_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;

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

async function post(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
  await input.press('Enter');
  await expect(page.getByTestId('timeline')).toContainText(text, { timeout: 20_000 });
}

async function postWhileMentionRefreshIsPending(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.fill('@vi');
  await expect(page.getByTestId('mention-popover')).toBeVisible();
  await input.evaluate((node, body) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, body);
    node.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: body,
    }));
    node.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
    }));
  }, text);
  await expect(page.getByTestId('timeline')).toContainText(text, { timeout: 20_000 });
}

const computerButton = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(label) }).first();

async function customizeComputer(page: Page, label: string): Promise<void> {
  await computerButton(page, label).click({ button: 'right' });
  await expect(page.getByRole('dialog', { name: new RegExp(`Customize ${label}`) })).toBeVisible();
}

/** All per-computer archive room keys in IndexedDB (computer:<id>:<gen>:room:*). */
async function archiveRoomKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('codor-crypto-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const keys: string[] = [];
      const cursor = db.transaction('state').objectStore('state').openKeyCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { keys.push(String(c.key)); c.continue(); }
        else { db.close(); resolve(keys.filter((k) => /^computer:.+:\d+:room:/.test(k))); }
      };
      cursor.onerror = () => reject(cursor.error);
    };
  }));
}

async function computerSessionId(page: Page, label: string): Promise<string> {
  return page.evaluate((wanted) => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('codor-crypto-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction('state').objectStore('state');
      const indexRequest = store.get('relay-index');
      indexRequest.onerror = () => reject(indexRequest.error);
      indexRequest.onsuccess = () => {
        const index = indexRequest.result as { computers: Array<{ id: string; gen: number; label: string }> };
        const computer = index.computers.find((entry) => entry.label === wanted);
        if (!computer) return reject(new Error(`missing ${wanted}`));
        const relayRequest = store.get(`computer:${computer.id}:${computer.gen}:relay`);
        relayRequest.onerror = () => reject(relayRequest.error);
        relayRequest.onsuccess = () => {
          db.close();
          resolve((relayRequest.result as { session_id: string }).session_id);
        };
      };
    };
  }), label);
}

test.describe('multi-computer pairing', () => {
  test('pair two computers, last-paired default, switch, post on each, forget one', async ({ page }) => {
    test.setTimeout(240_000);

    // Pair computer A (host A) — the only computer, so it's active straight in.
    await control('/relay-up');
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
      const NativeWebSocket = window.WebSocket;
      const runtime = window as unknown as {
        __relaySessionDials?: Record<string, number>;
        __codorRelayAppOpens?: Array<{ session: string; generation: number }>;
        __codorRelayHttp?: Array<{ target: string; generation: number }>;
      };
      runtime.__relaySessionDials = {};
      runtime.__codorRelayAppOpens = [];
      runtime.__codorRelayHttp = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(target: string | URL, protocols?: string | string[]) {
          super(target, protocols);
          const value = String(target);
          if (value.includes('/v1/session/')) {
            const counts = (window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials;
            counts[value] = (counts[value] ?? 0) + 1;
          }
        }
      };
    }, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await page.evaluate(() => { (window as unknown as { __computerDocument?: string }).__computerDocument = 'same-document'; });

    // Add computer B (host B) through the switcher's "Add a computer".
    await control('/relay-up-b');
    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-add').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();

    // B is the LAST PAIRED → active in the SAME document, with A still warm.
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');

    // A short desktop viewport keeps the narrow rail inside the canvas rather
    // than clipping a footer dropdown over the room.
    await page.setViewportSize({ width: 1440, height: 240 });
    const shortRail = page.getByTestId('computer-switcher');
    const shortRailBox = await shortRail.boundingBox();
    expect(shortRailBox).not.toBeNull();
    expect(shortRailBox!.x).toBeGreaterThanOrEqual(0);
    expect(shortRailBox!.y).toBeGreaterThanOrEqual(0);
    expect(shortRailBox!.x + shortRailBox!.width).toBeLessThanOrEqual(1440);
    expect(shortRailBox!.y + shortRailBox!.height).toBeLessThanOrEqual(240);
    expect(await shortRail.locator('[data-computer-avatar="true"]').count()).toBe(2);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(computerButton(page, 'codor-host-a')).toHaveAttribute('aria-label', /Connected/);
    await expect(computerButton(page, 'codor-host-b')).toHaveAttribute('aria-label', /Connected/);
    const railA11y = await new AxeBuilder({ page }).include('[data-testid="computer-switcher"]').analyze();
    expect(railA11y.violations).toEqual([]);

    const initialDials = await page.evaluate(() => ({
      ...(window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    }));
    expect(Object.values(initialDials)).toEqual([1, 1]); // two concurrent tunnel handshakes
    const aSession = await computerSessionId(page, 'codor-host-a');
    const bSession = await computerSessionId(page, 'codor-host-b');
    const initialAppOpens = await page.evaluate(() => [...(
      window as unknown as {
        __codorRelayAppOpens: Array<{ session: string; generation: number }>;
      }
    ).__codorRelayAppOpens]);
    expect(initialAppOpens.filter((entry) => entry.session === aSession)).toHaveLength(1);
    expect(initialAppOpens.filter((entry) => entry.session === bSession)).toHaveLength(1);

    // harn:assume managed-computer-activation-revalidates-destination-history ref=destination-history-activation-browser-regression
    // A finalizes while same-room B is selected. The inactive A connector may
    // retain live context, but immutable result evidence remains page-owned and
    // must be reconciled by A's deliberate activation.
    const activationFinal = 'activation history final from computer A';
    const historyRequestsBeforeActivation = await page.evaluate(() => (
      (window as unknown as { __codorRelayHttp: Array<{ target: string }> }).__codorRelayHttp
        .filter((entry) => entry.target.includes('/transcript-history')).length
    ));
    await control('/complete-agent', {
      handle: 'fable',
      prompt: 'finish while computer B is selected',
      final_text: activationFinal,
    });
    await expect(page.getByTestId('timeline')).not.toContainText(activationFinal);

    // Both hosts deliberately use `eng`; each generation still owns exactly its
    // own same-named key, never a shared global credential.
    const rooms = await archiveRoomKeys(page);
    const byComputer = new Map<string, Set<string>>();
    for (const k of rooms) {
      const m = /^(computer:[^:]+:\d+):room:(.+)$/.exec(k);
      if (m) (byComputer.get(m[1]) ?? byComputer.set(m[1], new Set()).get(m[1]))!.add(m[2]);
    }
    expect(byComputer.size).toBe(2); // two computers archived
    expect([...byComputer.values()].every((set) => [...set].includes('eng'))).toBe(true);

    // Post round-trips over computer B's tunnel (its owner is a human member).
    await post(page, '@richard hi from computer two');

    // Switch back to computer A → its own session, its own tunnel.
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');
    expect(await page.evaluate(() => ({
      ...(window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    }))).toEqual(initialDials); // switching reused both warm relay sessions
    await expect(page.getByTestId('timeline').getByText(activationFinal, { exact: true }))
      .toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __codorRelayHttp: Array<{ target: string }> }).__codorRelayHttp
        .filter((entry) => entry.target.includes('/transcript-history')).length
    ))).toBe(historyRequestsBeforeActivation + 1);
    expect(await page.evaluate(() => [...(
      window as unknown as {
        __codorRelayAppOpens: Array<{ session: string; generation: number }>;
      }
    ).__codorRelayAppOpens])).toEqual(initialAppOpens);

    // A no-change round trip stays stable: B never receives A's result, A
    // renders it once, and neither warm transport opens again.
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/);
    await expect(page.getByTestId('timeline')).not.toContainText(activationFinal);
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await expect(page.getByTestId('timeline').getByText(activationFinal, { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => ({
      ...(window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    }))).toEqual(initialDials);
    expect(await page.evaluate(() => [...(
      window as unknown as {
        __codorRelayAppOpens: Array<{ session: string; generation: number }>;
      }
    ).__codorRelayAppOpens])).toEqual(initialAppOpens);
    // harn:end managed-computer-activation-revalidates-destination-history
    await expect(page.getByTestId('timeline')).not.toContainText('hi from computer two');
    // Post round-trips over computer A's tunnel.
    // harn:assume composer-enter-uses-live-draft-state ref=composer-live-mention-switch-regression
    // Enter arriving in the same frame as the completed input must not trust a
    // stale picker left over from activation and erase the operator's words.
    await postWhileMentionRefreshIsPending(page, '@viewer hi from computer one');
    // harn:end composer-enter-uses-live-draft-state

    // Inactive B continues consuming its socket into its own store and exposes
    // only aggregate badges in the switcher.
    await control('/computer-b-activity');
    await expect(computerButton(page, 'codor-host-b').locator('[data-testid^="computer-avatar-working-"]')).toHaveAttribute('aria-label', /working/, { timeout: 20_000 });
    await expect(computerButton(page, 'codor-host-b').locator('[data-testid^="computer-avatar-unread-"]')).not.toHaveText('0');

    // Active A fails; its retained room stays readable and the rail switcher
    // still offers already-warm B. Choosing it neither reloads nor starts
    // another B relay handshake, and A's retry loop continues.
    const bDialsBeforeRecovery = Object.entries(initialDials).find(([url]) => url.includes(bSession))?.[1];
    // harn:assume hosted-app-streams-follow-tunnel-generations ref=independent-computer-recovery-regression
    await control('/relay-down-a-only');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 20_000 });
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');
    const bDialsAfterRecovery = await page.evaluate((session) => Object.entries(
      (window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    ).find(([url]) => url.includes(session))?.[1], bSession);
    expect(bDialsAfterRecovery).toBe(bDialsBeforeRecovery);

    await control('/relay-up');
    await expect(computerButton(page, 'codor-host-a')).toHaveAttribute('aria-label', /Connected/, { timeout: 30_000 });
    const recoveredAppOpens = await page.evaluate(() => [...(
      window as unknown as {
        __codorRelayAppOpens: Array<{ session: string; generation: number }>;
      }
    ).__codorRelayAppOpens]);
    expect(recoveredAppOpens.filter((entry) => entry.session === aSession)).toHaveLength(2);
    expect(recoveredAppOpens.filter((entry) => entry.session === bSession)).toHaveLength(1);
    // harn:end hosted-app-streams-follow-tunnel-generations

    // Forget computer B → it disappears, A stays active.
    await customizeComputer(page, 'codor-host-b');
    await page.getByRole('button', { name: /Use 🐈 icon/ }).click();
    await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(
      window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}',
    )))).toContainEqual({ glyph: '🐈', color: expect.any(String) });
    await page.getByRole('button', { name: 'Forget computer' }).click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await expect(computerButton(page, 'codor-host-b')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}'))).toEqual({});
  });

  test('a switchboard-served SPA renders no computer switcher (direct-path unchanged)', async ({ page }) => {
    test.setTimeout(120_000);
    // No __CODOR_RELAY_URL: the switchboard serves its own SPA (direct path).
    await page.goto(`${DIRECT_ORIGIN}/`);
    await page.waitForLoadState('domcontentloaded');
    // The switcher is hosted-only (relayUrlConfigured-gated) — it must never render
    // on a self-hosted, switchboard-served SPA.
    await expect(page.getByTestId('computer-switcher')).toHaveCount(0);
  });
});
