import { ensureBrowserIdentity, openForBrowser, sealForBrowserPeer } from './crypto';

interface WorkerScope {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
}

declare const self: WorkerScope;

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', () => { void self.clients.claim(); });
self.addEventListener('message', (event) => {
  const request = event.data as {
    id: string;
    op: 'identity' | 'open' | 'seal';
    ciphertext?: string;
    message?: number[];
    public_key?: string;
  };
  const reply = event.ports[0];
  void (async () => {
    if (request.op === 'identity') return ensureBrowserIdentity();
    if (request.op === 'open') return Array.from(await openForBrowser(request.ciphertext!));
    return sealForBrowserPeer(Uint8Array.from(request.message!), request.public_key!);
  })().then(
    (result) => reply.postMessage({ id: request.id, result }),
    (error: unknown) => reply.postMessage({ id: request.id, error: String(error) }),
  );
});
