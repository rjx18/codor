import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, devices, expect, test, type CDPSession } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:8138';
const BASE = 'http://127.0.0.1:8137';

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function evaluateOnTarget(cdp: CDPSession, targetId: string, expression: string): Promise<void> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId });
  const result = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker evaluation timed out')), 5_000);
    const listener = (event: { sessionId: string; message: string }): void => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message) as {
        id?: number;
        error?: unknown;
        result?: { exceptionDetails?: unknown };
      };
      if (message.id !== 1) return;
      cdp.off('Target.receivedMessageFromTarget', listener);
      clearTimeout(timeout);
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(`worker evaluation failed: ${event.message}`));
      } else {
        resolve();
      }
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }),
  });
  await result;
}

declare global {
  interface Window {
    __renderedPushes: unknown[];
    __codor: { disconnect(): void; reconnect(): void };
  }
}

test('M3 acceptance: the installed mobile PWA runs the room flow and opens sealed push', async () => {
  test.setTimeout(60_000);
  test.skip(!process.env.DISPLAY, 'the real Chromium app window requires Xvfb; pnpm e2e provides it');
  const profile = mkdtempSync(join(tmpdir(), 'codor-m3-pwa-'));
  const offer = await control<{ url: string }>('/pair-offer');
  const iphone = devices['iPhone 14'];
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: iphone.viewport,
    colorScheme: 'dark',
    args: [`--app=${offer.url}`],
  });

  try {
    const page = context.pages()[0] ?? await context.waitForEvent('page');
    await page.waitForURL('**/pair?**');
    const mobileCdp = await context.newCDPSession(page);
    await mobileCdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
    const deviceId = await page.evaluate(() =>
      window.__codorCrypto.identity().then((identity) => identity.device_id));

    await page.goto(`${BASE}/?room=eng&token=e2e-token`);
    await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
    await page.getByTestId('open-room-drawer').click();
    const drawer = page.getByTestId('room-drawer');
    await expect(drawer.getByTestId('room-link-eng')).toBeVisible();
    await expect(drawer.getByTestId('member-alpha')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Close channels' }).click();
    await page.getByRole('button', { name: 'Open channel context' }).click();
    const roomContext = page.getByRole('dialog', { name: 'Channel context' });
    await expect(roomContext.getByTestId('member-alpha')).toBeVisible();
    await roomContext.getByRole('button', { name: 'Close channel context' }).click();
    await control('/enqueue', {
      turns: [{
        kind: 'ask',
        prompt: 'Choose the pocket codeword',
        options: ['POCKET', 'DESKTOP'],
        replyPrefix: 'accepted ',
      }],
    });
    await page.getByTestId('composer-input').fill('@alpha choose the mobile codeword');
    await expect(page.getByTestId('implied-recipient')).toHaveCount(0);
    await page.getByTestId('composer-send').click();
    const firstRun = page.locator('[data-run-status="running"]').first();
    await expect(firstRun).toBeVisible();
    const firstRunId = (await firstRun.getAttribute('data-testid'))!.replace('run-', '');
    await page.locator('[data-testid$="-option-POCKET"]').click();
    await expect(page.getByTestId(`run-${firstRunId}`)).toHaveAttribute('data-run-status', 'completed');
    await expect(page.getByTestId(`run-${firstRunId}-body`)).toHaveText('accepted POCKET');

    await control('/enqueue', { turns: [{ kind: 'complete', final_text: 'M3 hold released' }] });
    await control('/hold', { body: '@alpha resume the pocket flow' });
    await expect(page.getByTestId('hold-banner')).toBeVisible();
    await page.locator('[data-testid^="release-"]').click();
    await expect(page.getByText('M3 hold released')).toBeVisible();

    await control('/enqueue', {
      turns: [{ kind: 'ask', prompt: 'Reconnect?', options: ['YES', 'NO'], replyPrefix: 'reconnected ' }],
    });
    await page.getByTestId('composer-input').fill('@alpha verify reconnect');
    await page.getByTestId('composer-send').click();
    const reconnectRun = page.locator('[data-run-status="running"]').first();
    await expect(reconnectRun).toBeVisible();
    const reconnectRunId = (await reconnectRun.getAttribute('data-testid'))!.replace('run-', '');
    await page.evaluate(() => window.__codor.disconnect());
    await expect(page.getByTestId('connection')).toHaveAttribute('title', 'disconnected');
    await control('/answer', { label: 'YES' });
    await page.evaluate(() => window.__codor.reconnect());
    await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
    await expect(page.getByTestId(`run-${reconnectRunId}-body`)).toHaveText('reconnected YES');

    await page.goto(`${BASE}/settings?room=eng&token=e2e-token`);
    await expect(page.getByTestId(`device-${deviceId}`)).toBeVisible();
    await page.evaluate(async () => {
      Object.defineProperties(Notification, {
        permission: { configurable: true, get: () => 'granted' },
        requestPermission: { configurable: true, value: async () => 'granted' },
      });
      const registration = await navigator.serviceWorker.ready;
      const prototype = Object.getPrototypeOf(registration.pushManager) as object;
      Object.defineProperties(prototype, {
        getSubscription: { configurable: true, value: async () => null },
        subscribe: {
          configurable: true,
          value: async () => ({
            endpoint: 'https://push.example.test/m3-acceptance',
            expirationTime: null,
            options: { userVisibleOnly: true },
            getKey: () => null,
            unsubscribe: async () => true,
            toJSON: () => ({
              endpoint: 'https://push.example.test/m3-acceptance',
              expirationTime: null,
              keys: { p256dh: 'm3-p256dh', auth: 'm3-auth' },
            }),
          }),
        },
      });
    });
    await page.getByTestId('enable-notifications').click();
    await expect(page.getByText('Notifications enabled.')).toBeVisible();

    await page.goto(`${BASE}/?room=eng&token=e2e-token`);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.evaluate(() => {
      window.__renderedPushes = [];
      navigator.serviceWorker.addEventListener('message', (event) => {
        if ((event.data as { type?: string }).type?.startsWith('notification-')) {
          window.__renderedPushes.push(event.data);
        }
      });
    });

    const cdp = await context.newCDPSession(page);
    let registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] = [];
    let versions: { registrationId: string; targetId: string; runningStatus: string }[] = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
      registrations = event.registrations as typeof registrations;
    });
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      versions = event.versions as typeof versions;
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() =>
      registrations.find((item) => item.scopeURL === `${BASE}/` && !item.isDeleted)?.registrationId)
      .not.toBeUndefined();
    const registrationId = registrations.find((item) =>
      item.scopeURL === `${BASE}/` && !item.isDeleted)!.registrationId;
    await expect.poll(() => versions.find((item) =>
      item.registrationId === registrationId && item.runningStatus === 'running')?.targetId)
      .not.toBeUndefined();
    const targetId = versions.find((item) =>
      item.registrationId === registrationId && item.runningStatus === 'running')!.targetId;
    await evaluateOnTarget(cdp, targetId, `
      Object.defineProperty(ServiceWorkerRegistration.prototype, 'showNotification', {
        configurable: true,
        value: async () => undefined,
      });
    `);

    const hold = await control<{ message_id: number }>('/push-hold');
    const captured = await control<{ sealed: string }>('/next-push');
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: BASE,
      registrationId,
      data: `codor-b64:${captured.sealed}`,
    });
    await expect.poll(() => page.evaluate(() => window.__renderedPushes[0])).toMatchObject({
      type: 'notification-rendered',
      notification: {
        title: 'Channel paused',
        actions: ['open-room', 'release-hold'],
        data: { room: 'eng', msg_id: hold.message_id, kind: 'hold' },
      },
    });
    await page.evaluate(async () => {
      const notification = window.__renderedPushes[0] as { notification: { data: unknown } };
      const registration = await navigator.serviceWorker.ready;
      registration.active!.postMessage({
        type: 'notification-action',
        action: 'release-hold',
        preview: notification.notification.data,
      });
    });
    await expect(page).toHaveURL(new RegExp(`#${String(hold.message_id)}$`));
    await expect(page.getByText('@richard released from notification')).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
