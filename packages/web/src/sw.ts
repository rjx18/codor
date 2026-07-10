/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';

import {
  notificationTarget,
  notificationTitle,
  openPushFromStoredRooms,
  type BrowserPushPreview,
  type NotificationAction,
} from './push.js';
import { storedBrowserAccess } from './crypto.js';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// harn:assume sw-injectmanifest-owned-worker ref=owned-worker-lifecycle
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// harn:assume sw-caches-shell-only-no-message-data ref=app-shell-precache-only
// This build-time list is the worker's only cache route. REST, WebSocket, and
// message traffic therefore stay network-only.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^room$/, /^token$/],
});
// harn:end sw-caches-shell-only-no-message-data
// harn:end sw-injectmanifest-owned-worker

async function showPushNotification(data: Uint8Array): Promise<void> {
  const preview = await openPushFromStoredRooms(data);
  const actions: NotificationAction[] = preview.kind === 'hold'
    ? ['open-room', 'release-hold']
    : ['open-room'];
  const options = {
    body: preview.preview,
    icon: '/wireroom-192.png',
    badge: '/wireroom-192.png',
    tag: `wireroom:${preview.room}:${String(preview.msg_id)}`,
    data: preview,
    actions: actions.map((action) => ({
      action,
      title: action === 'release-hold' ? 'Release hold' : 'Open room',
    })),
  } as NotificationOptions & { actions: { action: string; title: string }[] };
  await self.registration.showNotification(notificationTitle(preview.kind), options);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'notification-rendered', notification: {
      title: notificationTitle(preview.kind),
      body: preview.preview,
      actions,
      data: preview,
    } });
  }
}

async function broadcastWorkerMessage(message: unknown): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function showPushFailure(error: unknown): Promise<void> {
  await self.registration.showNotification('Wireroom needs attention', {
    body: 'Open Wireroom to refresh this notification.',
    icon: '/wireroom-192.png',
    badge: '/wireroom-192.png',
    tag: 'wireroom:push-unavailable',
    data: { unavailable: true },
  });
  await broadcastWorkerMessage({
    type: 'notification-error',
    error: error instanceof Error ? error.message : 'push decryption failed',
  });
}

async function openWindowTarget(targetUrl: URL): Promise<void> {
  const access = await storedBrowserAccess();
  if (access?.origin === self.location.origin && access.token !== '') {
    targetUrl.searchParams.set('token', access.token);
  }
  const target = targetUrl.href;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = clients.find((client): client is WindowClient =>
    'navigate' in client && new URL(client.url).origin === self.location.origin);
  if (existing) {
    await existing.navigate(target);
    await existing.focus();
    return;
  }
  await self.clients.openWindow(target);
}

async function openNotification(
  preview: BrowserPushPreview,
  action: NotificationAction,
): Promise<void> {
  const targetUrl = new URL(notificationTarget(preview, action), self.location.origin);
  await openWindowTarget(targetUrl);
}

// harn:assume push-decrypts-on-device-only ref=sw-push-notification-handler
self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;
  event.waitUntil(
    showPushNotification(new Uint8Array(event.data.arrayBuffer())).catch(showPushFailure),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const preview = event.notification.data as Partial<BrowserPushPreview> | undefined;
  const action: NotificationAction = event.action === 'release-hold' ? 'release-hold' : 'open-room';
  event.waitUntil(
    preview && typeof preview.room === 'string' && Number.isSafeInteger(preview.msg_id)
      ? openNotification(preview as BrowserPushPreview, action)
      : openWindowTarget(new URL('/', self.location.origin)),
  );
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const request = event.data as {
    type?: string;
    preview?: BrowserPushPreview;
    action?: NotificationAction;
  };
  if (request.type !== 'notification-action' || !request.preview) return;
  const action = request.action === 'release-hold' ? 'release-hold' : 'open-room';
  event.waitUntil(openNotification(request.preview, action));
});
// harn:end push-decrypts-on-device-only
