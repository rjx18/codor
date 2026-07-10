/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';

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
