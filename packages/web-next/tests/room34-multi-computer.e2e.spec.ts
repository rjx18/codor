import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
// The switchboard SERVES its own SPA here (direct/self-hosted topology, same-origin API).
const DIRECT_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;

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

async function post(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
  await input.press('Enter');
  await expect(page.getByTestId('timeline')).toContainText(text, { timeout: 20_000 });
}

const menuItem = (page: Page, label: string) => page.locator('.nx-computer-menu li', { hasText: label });

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

test.describe('multi-computer pairing', () => {
  test('pair two computers, last-paired default, switch, post on each, forget one', async ({ page }) => {
    test.setTimeout(240_000);

    // Pair computer A (host A) — the only computer, so it's active straight in.
    await control('/relay-up');
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText('Computer 1');

    // Add computer B (host B) through the switcher's "Add a computer".
    await control('/relay-up-b');
    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-current').click();
    await page.getByTestId('computer-add').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();

    // B is the LAST PAIRED → the default active computer after the reload.
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText('Computer 2');

    // No cross-leak: B's room (which A does NOT have) lives ONLY in B's archive,
    // and B's archive holds only B's room — it did not inherit A's rooms.
    const rooms = await archiveRoomKeys(page);
    const byComputer = new Map<string, Set<string>>();
    for (const k of rooms) {
      const m = /^(computer:[^:]+:\d+):room:(.+)$/.exec(k);
      if (m) (byComputer.get(m[1]) ?? byComputer.set(m[1], new Set()).get(m[1]))!.add(m[2]);
    }
    expect(byComputer.size).toBe(2); // two computers archived
    const withBRoom = [...byComputer.entries()].filter(([, set]) => set.has('switcher-b'));
    expect(withBRoom).toHaveLength(1); // only B's archive has B's room
    expect([...withBRoom[0]![1]]).toEqual(['switcher-b']); // B's archive is ONLY its own room

    // Post round-trips over computer B's tunnel (its owner is a human member).
    await post(page, '@richard hi from computer two');

    // Switch back to computer A → its own session, its own tunnel.
    await page.getByTestId('computer-current').click();
    await menuItem(page, 'Computer 1').getByRole('button').first().click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText('Computer 1');
    // Post round-trips over computer A's tunnel.
    await post(page, '@viewer hi from computer one');

    // Forget computer B → it disappears, A stays active.
    await page.getByTestId('computer-current').click();
    await menuItem(page, 'Computer 2').getByRole('button', { name: 'Forget' }).click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText('Computer 1');
    await page.getByTestId('computer-current').click();
    await expect(menuItem(page, 'Computer 2')).toHaveCount(0);
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
