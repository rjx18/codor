import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

import cryptoWorkerUrl from './crypto-sw?worker&url';
import {
  completeBrowserPairing,
  ensureBrowserIdentity,
  openForBrowser,
  sealForBrowserPeer,
  unpairBrowser,
} from './crypto';

interface CryptoTestApi {
  identity(): ReturnType<typeof ensureBrowserIdentity>;
  open(ciphertext: string): Promise<number[]>;
  seal(message: number[], publicKey: string): Promise<string>;
  unpair(): Promise<void>;
  worker(request: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __wireroomCrypto: CryptoTestApi;
  }
}

async function workerCall(request: Record<string, unknown>): Promise<unknown> {
  const registration = await navigator.serviceWorker.register(cryptoWorkerUrl, {
    type: 'module',
  });
  if (!registration.active) {
    await new Promise<void>((resolve, reject) => {
      const candidate = registration.installing ?? registration.waiting;
      if (!candidate) return reject(new Error('crypto service worker did not install'));
      const timeout = window.setTimeout(() => reject(new Error('crypto service worker activation timed out')), 5_000);
      candidate.addEventListener('statechange', () => {
        if (candidate.state !== 'activated') return;
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error('crypto service worker is unavailable');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const id = crypto.randomUUID();
    channel.port1.onmessage = (event) => {
      const response = event.data as { id: string; result?: unknown; error?: string };
      if (response.id !== id) return;
      if (response.error) reject(new Error(response.error));
      else resolve(response.result);
    };
    worker.postMessage({ ...request, id }, [channel.port2]);
  });
}

window.__wireroomCrypto = {
  identity: ensureBrowserIdentity,
  open: async (ciphertext) => Array.from(await openForBrowser(ciphertext)),
  seal: (message, publicKey) => sealForBrowserPeer(Uint8Array.from(message), publicKey),
  unpair: unpairBrowser,
  worker: workerCall,
};

export function PairingPage(): JSX.Element {
  const currentUrl = useMemo(() => new URL(window.location.href), []);
  const hasOffer = currentUrl.searchParams.has('pairing_token');
  const [qr, setQr] = useState<string>();
  const [state, setState] = useState<'ready' | 'pairing' | 'paired' | 'failed'>('ready');

  useEffect(() => {
    if (!hasOffer) return;
    void QRCode.toDataURL(currentUrl.toString(), { margin: 1, width: 320 }).then(setQr);
  }, [currentUrl, hasOffer]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold">Pair Wireroom</h1>
        {qr && <img src={qr} alt="Pairing QR code" className="size-72 bg-white p-3" />}
        {hasOffer ? (
          <button
            type="button"
            disabled={state === 'pairing' || state === 'paired'}
            onClick={() => {
              setState('pairing');
              void completeBrowserPairing(currentUrl).then(
                () => setState('paired'),
                () => setState('failed'),
              );
            }}
            className="bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {state === 'pairing' ? 'Pairing' : state === 'paired' ? 'Paired' : 'Pair this browser'}
          </button>
        ) : (
          <p className="text-sm text-zinc-400">No active pairing offer</p>
        )}
        {state === 'failed' && <p role="alert" className="text-sm text-red-400">Pairing failed</p>}
      </section>
    </main>
  );
}
