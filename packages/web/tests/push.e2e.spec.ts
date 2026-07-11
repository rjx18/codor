import { expect, test, type CDPSession } from '@playwright/test';

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

declare global {
  interface Window {
    __renderedPushes: unknown[];
  }
}

async function evaluateOnTarget(cdp: CDPSession, targetId: string, expression: string): Promise<void> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId });
  const result = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker evaluation timed out')), 5_000);
    const listener = (event: { sessionId: string; message: string }): void => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message) as { id?: number; error?: unknown; result?: { exceptionDetails?: unknown } };
      if (message.id !== 1) return;
      cdp.off('Target.receivedMessageFromTarget', listener);
      clearTimeout(timeout);
      if (message.error || message.result?.exceptionDetails) reject(new Error(`worker evaluation failed: ${event.message}`));
      else resolve();
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }),
  });
  await result;
}

test('producer → fake relay → CDP push decrypts in the worker, renders, and releases the room hold', async ({
  browser,
  context,
  page,
}) => {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('button', { name: 'Paired' })).toBeVisible();
  const deviceId = await page.evaluate(() => window.__codorCrypto.identity().then((identity) => identity.device_id));
  await page.goto('/settings?room=eng&token=e2e-token#devices');
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
          endpoint: 'https://push.example.test/cdp-device',
          expirationTime: null,
          options: { userVisibleOnly: true },
          getKey: () => null,
          unsubscribe: async () => true,
          toJSON: () => ({
            endpoint: 'https://push.example.test/cdp-device',
            expirationTime: null,
            keys: { p256dh: 'cdp-p256dh', auth: 'cdp-auth' },
          }),
        }),
      },
    });
  });
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await page.getByTestId('enable-notifications').click();
  await expect(page.getByText('Notifications enabled.')).toBeVisible();

  await page.goto('/?room=eng&token=e2e-token');
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
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
  const resolvedRegistrationId = registrations.find((item) => item.scopeURL === `${BASE}/` && !item.isDeleted)!.registrationId;
  await expect.poll(() => versions.find((item) =>
    item.registrationId === resolvedRegistrationId && item.runningStatus === 'running')?.targetId)
    .not.toBeUndefined();
  const workerTargetId = versions.find((item) =>
    item.registrationId === resolvedRegistrationId && item.runningStatus === 'running')!.targetId;
  const browserCdp = await browser.newBrowserCDPSession();
  await evaluateOnTarget(browserCdp, workerTargetId, `
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'showNotification', {
      configurable: true,
      value: async () => undefined,
    });
  `);

  const generation = await control<{ generation: number }>('/rotate-room-key');
  expect(generation.generation).toBeGreaterThan(1);
  const hold = await control<{ message_id: number; delivery_id: string }>('/push-hold');
  const captured = await control<{ sealed: string; ttl: number }>('/next-push');
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: BASE,
    registrationId: resolvedRegistrationId,
    data: `codor-b64:${captured.sealed}`,
  });

  await expect.poll(() => page.evaluate(() => window.__renderedPushes[0])).not.toBeUndefined();
  const renderedPush = await page.evaluate(() => window.__renderedPushes[0]) as {
    type: string;
    error?: string;
    notification?: unknown;
  };
  if (renderedPush.type === 'notification-error') {
    throw new Error(`worker push failed: ${renderedPush.error ?? 'unknown error'}`);
  }
  expect(renderedPush).toMatchObject({
    type: 'notification-rendered',
    notification: {
      title: 'Room paused',
      actions: ['open-room', 'release-hold'],
      data: {
        room: 'eng',
        msg_id: hold.message_id,
        kind: 'hold',
        delivery_id: hold.delivery_id,
      },
    },
  });
  expect(JSON.stringify(renderedPush)).not.toContain('codor-b64:');
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('codor-crypto-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database.transaction('state').objectStore('state').get('room:eng');
        request.onsuccess = () => resolve((request.result as { generation: number }).generation);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  })).toBe(generation.generation);

  await page.evaluate(async () => {
    const rendered = window.__renderedPushes[0] as {
      notification: { data: unknown };
    };
    const registration = await navigator.serviceWorker.ready;
    registration.active!.postMessage({
      type: 'notification-action',
      action: 'release-hold',
      preview: rendered.notification.data,
    });
  });
  await expect(page).toHaveURL(new RegExp(`#${String(hold.message_id)}$`));
  await expect(page.getByTestId('hold-banner')).toHaveCount(0);
  await expect(page.getByText('@richard released from notification')).toBeVisible();
});
