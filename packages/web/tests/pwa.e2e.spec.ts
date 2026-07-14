import { devices, expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

test.use({ ...devices['iPhone 14'], defaultBrowserType: 'chromium' });

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return (await response.json()) as T;
}

test('mobile room keeps the stream primary with a thumb-safe drawer and composer', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page).not.toHaveURL(/(?:\?|&)token=/);
  await expect(page.getByTestId('room-settings')).not.toHaveAttribute('href', /token=/);

  await page.goto('/?room=eng');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const viewport = page.viewportSize()!;
  expect(viewport.width).toBeLessThanOrEqual(430);
  await expect(page.getByTestId('room-view')).toBeVisible();
  await expect(page.getByTestId('open-room-drawer')).toBeVisible();
  await expect(page.getByTestId('room-rail')).toBeHidden();
  await expect(page.getByTestId('context-rail')).toBeHidden();
  await expect(page.getByTestId('meter')).toBeVisible();

  const send = (await page.getByTestId('composer-send').boundingBox())!;
  expect(send.width).toBeGreaterThanOrEqual(44);
  expect(send.height).toBeGreaterThanOrEqual(44);
  expect(send.y + send.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

  await page.getByTestId('open-room-drawer').click();
  const drawer = page.getByTestId('room-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('room-link-eng')).toHaveAttribute('aria-current', 'page');
  await expect(drawer.getByTestId('member-alpha')).toHaveCount(0);
  await expect(drawer.getByText('Connected', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close channels' })).toBeFocused();
  const drawerBox = (await drawer.boundingBox())!;
  expect(drawerBox.width).toBeLessThan(viewport.width);
  await drawer.getByRole('button', { name: 'Close channels' }).click();
  await expect(drawer).toHaveCount(0);

  await page.getByRole('button', { name: 'Open channel context' }).click();
  const context = page.getByRole('dialog', { name: 'Channel context' });
  await expect(context.getByTestId('member-alpha')).toBeVisible();
  await context.getByRole('button', { name: 'Close channel context' }).click();
  await expect(context).toHaveCount(0);
});

test('manifest is installable and the owned worker caches only the offline shell', async ({
  context,
  page,
}) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await expect(page.getByRole('heading', { name: 'Engineering' })).toBeVisible();
  await control('/enqueue', {
    turns: [{ kind: 'complete', final_text: 'pwa-dynamic-payload' }],
  });
  await page.getByTestId('composer-input').fill('@alpha create a dynamic cache sentinel');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('pwa-dynamic-payload')).toBeVisible();

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return (await response.json()) as {
      name: string;
      display: string;
      start_url: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
  });
  expect(manifest).toMatchObject({ name: 'Codor', display: 'standalone', start_url: '/' });
  expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
  expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByText('pwa-dynamic-payload')).toBeVisible();

  const cached = await page.evaluate(async () => {
    const entries: { url: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({ url: request.url, body: response ? await response.clone().text() : '' });
      }
    }
    return entries;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some((entry) => /\/api\/|\/ws(?:\?|$)/.test(entry.url))).toBe(false);
  expect(JSON.stringify(cached)).not.toContain('pwa-dynamic-payload');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('room-view')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByText('pwa-dynamic-payload')).toHaveCount(0);
});

// harn:assume sw-injectmanifest-owned-worker ref=offline-font-regression
test('the installed app renders its own typeface with no network', async ({ page }) => {
  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();

  // Cache presence alone would not prove the @font-face rules point at these assets...
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      urls.push(...keys.map((r) => new URL(r.url).pathname));
    }
    return urls;
  });
  expect(cached.some((u) => u.includes('Geist-Variable.woff2'))).toBe(true);
  expect(cached.some((u) => u.includes('GeistMono-Variable.woff2'))).toBe(true);

  // ...so load them with the network cut, and assert the FontFaceSet actually holds them.
  await page.context().setOffline(true);
  await page.reload();
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('16px Geist');
    await document.fonts.load('16px "Geist Mono"');
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/"/g, ''));
  });
  expect(loaded).toContain('Geist');
  expect(loaded).toContain('Geist Mono');
  await page.context().setOffline(false);
});
// harn:end sw-injectmanifest-owned-worker
