import {
  Cable,
  Check,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
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

  const endpointLabel = useMemo(() => {
    const endpoint = currentUrl.searchParams.get('endpoint');
    if (!endpoint) return 'No switchboard selected';
    try {
      return new URL(endpoint).host;
    } catch {
      return 'Invalid switchboard address';
    }
  }, [currentUrl]);

  // harn:assume pairing-offer-token-remains-qr-only ref=glass-pairing-surface
  return (
    <main data-testid="pairing-page" className="wr-pairing-page">
      <div className="wr-wiring" aria-hidden="true" />
      <header className="wr-pairing-brand">
        <span className="wr-brand-mark" aria-hidden="true"><Cable size={22} /></span>
        <strong>Wireroom</strong>
        <span>Local device enrollment</span>
      </header>

      <section className="wr-pairing-shell">
        <div className="wr-pairing-heading">
          <span className="wr-pairing-icon" aria-hidden="true"><LockKeyhole size={24} /></span>
          <div>
            <p>Private by construction</p>
            <h1>Pair this browser</h1>
            <span>Authorize this browser with your local switchboard. This is not an account login.</span>
          </div>
        </div>

        {hasOffer ? (
          <div className="wr-pairing-grid">
            <div className="wr-qr-pane">
              {qr ? (
                <img src={qr} alt="Pairing QR code" />
              ) : (
                <div role="status" className="wr-qr-placeholder">Preparing QR</div>
              )}
              <div className="wr-switchboard-identity">
                <ShieldCheck aria-hidden="true" size={18} />
                <span><strong>Local switchboard</strong><small>{endpointLabel}</small></span>
              </div>
            </div>

            <div className="wr-pairing-action">
              <h2>Browser authority</h2>
              <p>A fresh signing and encryption identity stays in this origin's IndexedDB. Private keys never enter the QR or switchboard.</p>
              <ul>
                <li><Check aria-hidden="true" size={15} /> Dual signing and encryption keys</li>
                <li><Check aria-hidden="true" size={15} /> Sealed room keys for this device</li>
                <li><Check aria-hidden="true" size={15} /> Revoke and purge from Settings</li>
              </ul>
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
                className="wr-primary-button wr-pair-button"
              >
                <KeyRound aria-hidden="true" size={18} />
                {state === 'pairing' ? 'Pairing' : state === 'paired' ? 'Paired' : 'Pair this browser'}
              </button>
              {state === 'paired' && <p role="status" className="wr-pair-success"><Check aria-hidden="true" size={15} /> Browser paired. You can open your rooms.</p>}
              {state === 'failed' && <p role="alert" className="wr-form-error">Pairing failed</p>}
            </div>
          </div>
        ) : (
          <div className="wr-pairing-empty">
            <KeyRound aria-hidden="true" size={24} />
            <h2>No active pairing offer</h2>
            <p>Open pairing on your switchboard and follow its single-use link on this browser.</p>
          </div>
        )}

        <div className="wr-pairing-disclosure">
          <section><h2>This browser stores</h2><p>Its private device keys, sealed room keys, and same-origin switchboard access.</p></section>
          <section><h2>The push relay never learns</h2><p>Sender, room or member names, plaintext message or run evidence, decrypted room keys, or private device keys.</p></section>
        </div>
      </section>
    </main>
  );
  // harn:end pairing-offer-token-remains-qr-only
}
