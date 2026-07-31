import { expect, test } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;

test.describe('unpaired gate', () => {
  test('a bare /pair visit offers the code and link forms with friendly errors', async ({ page }) => {
    await page.goto('/pair');
    const manual = page.getByTestId('manual-pairing');
    await expect(manual).toBeVisible();

    await manual.getByTestId('pairing-code-0').fill('A');
    await manual.getByTestId('pairing-code-1').fill('B');
    await manual.getByTestId('pairing-code-2').fill('C');
    await manual.getByTestId('pairing-code-submit').click();
    await expect(page.getByRole('alert')).toContainText('complete 8-character');

    await manual.getByTestId('pairing-link').fill('not a link');
    await manual.getByTestId('pairing-link-submit').click();
    await expect(page.getByRole('alert')).toContainText('doesn’t look like a pairing link');
  });
});

test.describe('offer enrollment', () => {
  test('an offer link renders its QR and pairs this browser end to end', async ({ page }) => {
    const minted = await fetch(`${API}/api/pairing/offers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer next-e2e-token',
      },
      body: JSON.stringify({ endpoint: API }),
    });
    expect(minted.ok).toBe(true);
    const offer = await minted.json() as {
      endpoint: string; pairing_token: string; switchboard_sign_pub: string;
    };

    const url = new URL('/pair', API);
    url.searchParams.set('endpoint', offer.endpoint);
    url.searchParams.set('pairing_token', offer.pairing_token);
    url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);

    await page.goto(url.toString());
    const state = page.getByTestId('pairing-offer-state');
    await expect(state).toBeVisible();
    await expect(state.getByTestId('pairing-qr')).toBeVisible();
    // The offer token lives only inside the QR raster.
    await expect(state).not.toContainText(offer.pairing_token);

    await state.getByTestId('confirm-pair-browser').click();
    await expect(state.getByRole('status')).toContainText('Paired', { timeout: 15_000 });
  });

  test('a direct pairing survives a reboot — the boot hydrate never wipes its globals', async ({ page }) => {
    // Pair this browser through the direct (switchboard-served) path.
    const minted = await fetch(`${API}/api/pairing/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer next-e2e-token' },
      body: JSON.stringify({ endpoint: API }),
    });
    expect(minted.ok).toBe(true);
    const offer = await minted.json() as { endpoint: string; pairing_token: string; switchboard_sign_pub: string };
    const url = new URL('/pair', API);
    url.searchParams.set('endpoint', offer.endpoint);
    url.searchParams.set('pairing_token', offer.pairing_token);
    url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
    await page.goto(url.toString());
    await page.getByTestId('confirm-pair-browser').click();
    await expect(page.getByTestId('pairing-offer-state').getByRole('status')).toContainText('Paired', { timeout: 15_000 });

    // REBOOT — the missing topology that let the boot-wipe hide: initRelayMode
    // runs hydrateActiveRelay on EVERY boot, direct path included. Reload at the
    // bare origin (no ?token) so the browser must restore from its stored access.
    await page.goto(`${API}/`);

    // Its switchboard identity survives the boot hydrate (the fix under guard) …
    const peer = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('codor-crypto-v1');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction('state').objectStore('state').get('peer:switchboard');
        request.onsuccess = () => { open.result.close(); resolve(request.result ?? null); };
        request.onerror = () => reject(request.error);
      };
    }));
    expect(peer).not.toBeNull();

    // … and the browser stays paired: it authenticates and reaches its room,
    // never dropping back to the unpaired landing gate.
    await expect(page.getByTestId('connection')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('landing-page')).toHaveCount(0);
  });

  test('a direct pairing whose boot auth fails shows the recovery card, not landing', async ({ page }) => {
    // Pair this browser through the direct path (stores a device access record).
    const minted = await fetch(`${API}/api/pairing/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer next-e2e-token' },
      body: JSON.stringify({ endpoint: API }),
    });
    expect(minted.ok).toBe(true);
    const offer = await minted.json() as { endpoint: string; pairing_token: string; switchboard_sign_pub: string };
    const url = new URL('/pair', API);
    url.searchParams.set('endpoint', offer.endpoint);
    url.searchParams.set('pairing_token', offer.pairing_token);
    url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
    await page.goto(url.toString());
    await page.getByTestId('confirm-pair-browser').click();
    await expect(page.getByTestId('pairing-offer-state').getByRole('status')).toContainText('Paired', { timeout: 15_000 });

    // Reboot with the device-auth path down: token resolution fails (token=''), but the
    // stored access record proves this browser IS paired — so it gets the recovery card
    // (Retry-only; no re-pair in direct mode), NEVER the "never paired" landing.
    await page.route('**/api/auth/**', (route) => route.abort());
    await page.goto(`${API}/`);
    await expect(page.getByTestId('recovery')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('landing-page')).toHaveCount(0);
    await expect(page.getByTestId('recovery-retry')).toBeVisible();
    await expect(page.getByTestId('recovery-repair')).toHaveCount(0);
    // With no re-pair button offered (direct mode), the copy must not mention re-pair.
    await expect(page.getByTestId('recovery')).not.toContainText(/re-pair/i);
  });
});

test.describe('accessibility', () => {
  test('the manual pairing surface is axe-clean', async ({ page }) => {
    await page.goto('/pair');
    await expect(page.getByTestId('manual-pairing')).toBeVisible();
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
