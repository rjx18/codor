import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, chromium, test } from '@playwright/test';
import {
  generateIdentity,
  openSealedBox,
  sealBox,
  type DeviceIdentity,
} from '@codor/switchboard';

import { BASE, CONTROL } from './ports.js';

async function control<T>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, { method: 'POST' });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

// harn:assume pairing-offer-token-remains-qr-only ref=pairing-token-visibility-regression
// harn:assume pairing-discloses-browser-and-relay-boundaries ref=pairing-boundary-regression
test('pairing page renders a QR without visible authority and enrolls the browser dual identity', async ({ page }) => {
  const offer = await control<{ url: string }>('/pair-offer');
  const offerUrl = new URL(offer.url);
  const pairingToken = offerUrl.searchParams.get('pairing_token')!;
  const accessToken = 'e2e-token';
  await page.goto(offer.url);
  await expect(page.getByTestId('pairing-page')).toBeVisible();
  await expect(page.getByAltText('Pairing QR code')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(pairingToken);
  await expect(page.locator('body')).not.toContainText(accessToken);
  await expect(page.getByText('This is not an account login.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Relay can see' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Relay never sees' })).toBeVisible();
  await expect(page.getByText(/Padded ciphertext size/)).toBeVisible();
  await expect(page.getByText(/Sender, channel or member names/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  const pairingStyle = await page.evaluate(() => {
    const shell = getComputedStyle(document.querySelector<HTMLElement>('.wr-pairing-shell')!);
    const button = getComputedStyle(document.querySelector<HTMLElement>('.wr-pair-button')!);
    return {
      display: shell.display,
      radius: parseFloat(shell.borderTopLeftRadius),
      material: shell.backdropFilter || shell.getPropertyValue('-webkit-backdrop-filter'),
      buttonMaterial: button.backdropFilter || button.getPropertyValue('-webkit-backdrop-filter'),
    };
  });
  expect(pairingStyle.display).toBe('grid');
  expect(pairingStyle.radius).toBe(0);
  expect(pairingStyle.material).toBe('none');
  expect(pairingStyle.buttonMaterial).toContain('blur');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const leakedAuthority = await page.evaluate(({ pairing, access }) => {
    const attributes = [...document.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    return {
      visiblePairing: document.body.innerText.includes(pairing),
      visibleAccess: document.body.innerText.includes(access),
      attributePairing: attributes.some((value) => value.includes(pairing)),
      attributeAccess: attributes.some((value) => value.includes(access)),
      serializedAccess: document.documentElement.outerHTML.includes(access),
    };
  }, { pairing: pairingToken, access: accessToken });
  expect(leakedAuthority).toEqual({
    visiblePairing: false,
    visibleAccess: false,
    attributePairing: false,
    attributeAccess: false,
    serializedAccess: false,
  });
  const peers = await control<{
    peers: { device_id: string; sign_public_key: string; encryption_public_key: string }[];
  }>('/peers');
  expect(peers.peers).toHaveLength(1);
  expect(peers.peers[0]!.device_id).toBe(peers.peers[0]!.sign_public_key);
  expect(peers.peers[0]!.encryption_public_key).not.toBe(peers.peers[0]!.sign_public_key);

  const tamperedOffer = new URL((await control<{ url: string }>('/pair-offer')).url);
  tamperedOffer.searchParams.set('switchboard_sign_pub', generateIdentity().sign_public_key);
  await page.goto(tamperedOffer.toString());
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Security check failed. Stop: the Codor identity does not match this pairing link.',
  );

  await page.goto('/?room=eng');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page).not.toHaveURL(/(?:\?|&)token=/);
});
// harn:end pairing-discloses-browser-and-relay-boundaries
// harn:end pairing-offer-token-remains-qr-only

// harn:assume pairing-code-enrollment-surfaces ref=pairing-code-browser-regression
test('root code entry pairs a browser and Settings mints a second-device round trip', async ({ page, browser }) => {
  const initial = await control<{ url: string; code: string }>('/pair-offer');
  await page.goto('/?room=eng');
  await expect(page.getByTestId('pairing-code-0')).toBeFocused();
  const compact = initial.code.replace('-', '').toLowerCase();
  for (const [index, character] of Array.from(compact).entries()) {
    await page.getByTestId(`pairing-code-${String(index)}`).fill(character);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/pair?**');
  await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();

  await page.goto('/?room=eng');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.goto('/settings?room=eng#devices');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const mintResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/pairing/offers'));
  await page.getByTestId('pair-another-device').click();
  const minted = await (await mintResponse).json() as { pairing_code: string; pairing_token: string };
  await expect(page.getByTestId('settings-pairing-code')).toHaveText(minted.pairing_code);
  await expect(page.getByAltText('Pair another device QR code')).toBeVisible();
  expect(minted.pairing_code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
  expect(await page.locator('body').innerText()).not.toContain(minted.pairing_token);
  expect(await page.locator('html').evaluate((element) => element.outerHTML))
    .not.toContain(minted.pairing_token);

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await second.goto(`${BASE}/?room=eng`);
    const nextCompact = minted.pairing_code.replace('-', '');
    for (const [index, character] of Array.from(nextCompact).entries()) {
      await second.getByTestId(`pairing-code-${String(index)}`).fill(character);
    }
    await second.getByRole('button', { name: 'Continue' }).click();
    await second.waitForURL('**/pair?**');
    await second.getByRole('button', { name: 'Pair this browser' }).click();
    await expect(second.getByRole('button', { name: 'Paired' })).toBeVisible();
  } finally {
    await secondContext.close();
  }
});
// harn:end pairing-code-enrollment-surfaces

test('sodium-native and real Chromium page/SW sealed boxes interoperate across restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'codor-chromium-crypto-'));
  const nodeIdentity: DeviceIdentity = generateIdentity();
  const marker = Array.from(new TextEncoder().encode('cross-runtime-secret-marker'));
  let context = await chromium.launchPersistentContext(profile, { headless: true });
  try {
    let page = await context.newPage();
    await page.goto(`${BASE}/pair`);
    const browserIdentity = await page.evaluate(() => window.__codorCrypto.identity());

    const nodeToBrowser = sealBox(Uint8Array.from(marker), browserIdentity.encryption_public_key);
    expect(await page.evaluate(
      (ciphertext) => window.__codorCrypto.open(ciphertext),
      nodeToBrowser,
    )).toEqual(marker);
    expect(await page.evaluate(
      (ciphertext) => window.__codorCrypto.worker({ op: 'open', ciphertext }),
      nodeToBrowser,
    )).toEqual(marker);

    const pageToNode = await page.evaluate(
      ({ message, publicKey }) => window.__codorCrypto.seal(message, publicKey),
      { message: marker, publicKey: nodeIdentity.encryption_public_key },
    );
    expect(Array.from(openSealedBox(pageToNode, nodeIdentity))).toEqual(marker);
    const workerToNode = await page.evaluate(
      ({ message, publicKey }) => window.__codorCrypto.worker({
        op: 'seal',
        message,
        public_key: publicKey,
      }),
      { message: marker, publicKey: nodeIdentity.encryption_public_key },
    );
    expect(Array.from(openSealedBox(workerToNode as string, nodeIdentity))).toEqual(marker);

    await context.close();
    context = await chromium.launchPersistentContext(profile, { headless: true });
    page = await context.newPage();
    await page.goto(`${BASE}/pair`);
    expect(await page.evaluate(() => window.__codorCrypto.identity())).toEqual(browserIdentity);
    expect(await page.evaluate(
      (ciphertext) => window.__codorCrypto.open(ciphertext),
      nodeToBrowser,
    )).toEqual(marker);
    expect(await page.evaluate(
      (ciphertext) => window.__codorCrypto.worker({ op: 'open', ciphertext }),
      nodeToBrowser,
    )).toEqual(marker);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('settings unpair revokes the device and purges IndexedDB, caches, local storage, and push', async ({ page }) => {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const before = await page.evaluate(() => window.__codorCrypto.identity());
  const registered = await page.evaluate(async (deviceId) => {
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/push-subscription`, {
      method: 'POST',
      headers: { authorization: 'Bearer e2e-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/unpair-device',
          expirationTime: null,
          keys: { p256dh: 'unpair-p256dh', auth: 'unpair-auth' },
        },
      }),
    });
    return response.status;
  }, before.device_id);
  expect(registered).toBe(201);

  await page.goto(`${BASE}/settings?room=eng&token=e2e-token#devices`);
  await expect(page.getByTestId(`device-${before.device_id}`)).toBeVisible();
  await page.evaluate(async () => {
    localStorage.setItem('codor-cache', 'sensitive');
    const cache = await caches.open('codor-test-cache');
    await cache.put('/cached-secret', new Response('sensitive'));
    const registration = await navigator.serviceWorker.ready;
    const prototype = Object.getPrototypeOf(registration.pushManager) as object;
    (window as unknown as { __unsubscribeCount: number }).__unsubscribeCount = 0;
    Object.defineProperty(prototype, 'getSubscription', {
      configurable: true,
      value: async () => ({
        unsubscribe: async () => {
          (window as unknown as { __unsubscribeCount: number }).__unsubscribeCount += 1;
          return true;
        },
      }),
    });
  });
  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  const revokeResponse = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && response.url().includes(`/api/devices/${before.device_id}`));
  await page.getByTestId('confirm-unpair-browser').click();
  expect((await revokeResponse).status()).toBe(200);
  await expect(page.getByTestId('browser-unpaired')).toBeVisible();
  const purged = await page.evaluate(async () => ({
    local: localStorage.length,
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    databases: (await indexedDB.databases()).map((database) => database.name),
    unsubscribed: (window as unknown as { __unsubscribeCount: number }).__unsubscribeCount,
  }));
  expect(purged.local).toBe(0);
  expect(purged.caches).toEqual([]);
  expect(purged.registrations).toBe(0);
  expect(purged.databases.filter((name) => name?.startsWith('codor-'))).toEqual([]);
  expect(purged.unsubscribed).toBeGreaterThan(0);
  expect((await control<{ peers: { device_id: string }[] }>('/peers')).peers)
    .not.toContainEqual(expect.objectContaining({ device_id: before.device_id }));
});

test('unpair still purges local browser state when remote revocation is unavailable', async ({ page }) => {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const identity = await page.evaluate(() => window.__codorCrypto.identity());
  await page.goto(`${BASE}/settings?room=eng&token=e2e-token#devices`);
  await expect(page.getByTestId(`device-${identity.device_id}`)).toBeVisible();
  await page.evaluate(async () => {
    localStorage.setItem('codor-cache', 'sensitive');
    const cache = await caches.open('codor-test-cache');
    await cache.put('/cached-secret', new Response('sensitive'));
    const registration = await navigator.serviceWorker.ready;
    const prototype = Object.getPrototypeOf(registration.pushManager) as object;
    Object.defineProperty(prototype, 'getSubscription', {
      configurable: true,
      value: async () => ({ unsubscribe: async () => true }),
    });
  });
  await page.route(`**/api/devices/${identity.device_id}`, (route) => route.abort('connectionfailed'));
  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await page.getByTestId('confirm-unpair-browser').click();
  await expect(page.getByTestId('browser-unpaired')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Codor could not be reached');
  expect(await page.evaluate(async () => ({
    local: localStorage.length,
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    databases: (await indexedDB.databases()).map((database) => database.name),
  }))).toEqual({ local: 0, caches: [], registrations: 0, databases: [] });
});

test('unpair reports a blocked local purge instead of rejecting silently', async ({ page }) => {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const identity = await page.evaluate(() => window.__codorCrypto.identity());
  await page.goto(`${BASE}/settings?room=eng&token=e2e-token#devices`);
  await expect(page.getByTestId(`device-${identity.device_id}`)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(IDBFactory.prototype, 'deleteDatabase', {
      configurable: true,
      value: () => { throw new Error('blocked by another tab'); },
    });
  });

  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await page.getByTestId('confirm-unpair-browser').click();

  await expect(page.getByTestId('browser-unpaired')).toBeVisible();
  await expect(page.getByText('Local cleanup could not be confirmed. Close other Codor tabs before pairing again.')).toBeVisible();
  expect((await control<{ peers: { device_id: string }[] }>('/peers')).peers)
    .not.toContainEqual(expect.objectContaining({ device_id: identity.device_id }));
});
