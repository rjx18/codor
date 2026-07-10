import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, chromium, test } from '@playwright/test';
import {
  generateIdentity,
  openSealedBox,
  sealBox,
  type DeviceIdentity,
} from '@wireroom/switchboard';

const CONTROL = 'http://127.0.0.1:8138';
const BASE = 'http://127.0.0.1:8137';

async function control<T>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, { method: 'POST' });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('pairing page renders a QR and enrolls the browser dual identity', async ({ page }) => {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await expect(page.getByAltText('Pairing QR code')).toBeVisible();
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const peers = await control<{
    peers: { device_id: string; sign_public_key: string; encryption_public_key: string }[];
  }>('/peers');
  expect(peers.peers).toHaveLength(1);
  expect(peers.peers[0]!.device_id).toBe(peers.peers[0]!.sign_public_key);
  expect(peers.peers[0]!.encryption_public_key).not.toBe(peers.peers[0]!.sign_public_key);
});

test('sodium-native and real Chromium page/SW sealed boxes interoperate across restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'wireroom-chromium-crypto-'));
  const nodeIdentity: DeviceIdentity = generateIdentity();
  const marker = Array.from(new TextEncoder().encode('cross-runtime-secret-marker'));
  let context = await chromium.launchPersistentContext(profile, { headless: true });
  try {
    let page = await context.newPage();
    await page.goto(`${BASE}/pair`);
    const browserIdentity = await page.evaluate(() => window.__wireroomCrypto.identity());

    const nodeToBrowser = sealBox(Uint8Array.from(marker), browserIdentity.encryption_public_key);
    expect(await page.evaluate(
      (ciphertext) => window.__wireroomCrypto.open(ciphertext),
      nodeToBrowser,
    )).toEqual(marker);
    expect(await page.evaluate(
      (ciphertext) => window.__wireroomCrypto.worker({ op: 'open', ciphertext }),
      nodeToBrowser,
    )).toEqual(marker);

    const pageToNode = await page.evaluate(
      ({ message, publicKey }) => window.__wireroomCrypto.seal(message, publicKey),
      { message: marker, publicKey: nodeIdentity.encryption_public_key },
    );
    expect(Array.from(openSealedBox(pageToNode, nodeIdentity))).toEqual(marker);
    const workerToNode = await page.evaluate(
      ({ message, publicKey }) => window.__wireroomCrypto.worker({
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
    expect(await page.evaluate(() => window.__wireroomCrypto.identity())).toEqual(browserIdentity);
    expect(await page.evaluate(
      (ciphertext) => window.__wireroomCrypto.open(ciphertext),
      nodeToBrowser,
    )).toEqual(marker);
    expect(await page.evaluate(
      (ciphertext) => window.__wireroomCrypto.worker({ op: 'open', ciphertext }),
      nodeToBrowser,
    )).toEqual(marker);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('browser unpair purges IndexedDB, caches, local storage, and service workers', async ({ page }) => {
  await page.goto(`${BASE}/pair`);
  const before = await page.evaluate(async () => {
    const identity = await window.__wireroomCrypto.identity();
    localStorage.setItem('wireroom-cache', 'sensitive');
    const cache = await caches.open('wireroom-test-cache');
    await cache.put('/cached-secret', new Response('sensitive'));
    await window.__wireroomCrypto.worker({ op: 'identity' });
    return identity;
  });
  await page.evaluate(() => window.__wireroomCrypto.unpair());
  const purged = await page.evaluate(async () => ({
    local: localStorage.length,
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    identity: await window.__wireroomCrypto.identity(),
  }));
  expect(purged.local).toBe(0);
  expect(purged.caches).toEqual([]);
  expect(purged.registrations).toBe(0);
  expect(purged.identity.device_id).not.toBe(before.device_id);
});
