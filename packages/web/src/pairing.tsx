import {
  Check,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

import cryptoWorkerUrl from './crypto-sw?worker&url';
import {
  completeBrowserPairing,
  ensureBrowserIdentity,
  exchangeBrowserPairingCode,
  openForBrowser,
  sealForBrowserPeer,
  tryTrustedBrowserPairing,
  unpairBrowser,
} from './crypto';

const PAIRING_CODE_CHARACTERS = /^[23456789A-HJ-NP-Z]$/;

function PairingCodeInput(props: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}): JSX.Element {
  const cells = useRef<Array<HTMLInputElement | null>>([]);
  const replaceAt = (index: number, character: string): void => {
    const next = props.value.padEnd(8, ' ').split('');
    next[index] = character;
    props.onChange(next.join('').trimEnd());
  };
  const acceptPaste = (value: string): boolean => {
    const compact = value.replaceAll('-', '').toUpperCase();
    if (compact.length !== 8 || !Array.from(compact).every((character) =>
      PAIRING_CODE_CHARACTERS.test(character))) return false;
    props.onChange(compact);
    cells.current[7]?.focus();
    return true;
  };

  return (
    <div
      role="group"
      aria-label="Pairing code"
      data-testid="pairing-code"
      className="wr-pairing-code-cells"
      onPaste={(event) => {
        if (acceptPaste(event.clipboardData.getData('text'))) event.preventDefault();
      }}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <input
          key={index}
          ref={(element) => { cells.current[index] = element; }}
          aria-label={`Pairing code character ${String(index + 1)}`}
          data-testid={`pairing-code-${String(index)}`}
          value={props.value[index] ?? ''}
          disabled={props.disabled}
          maxLength={1}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoFocus={index === 0}
          spellCheck={false}
          onChange={(event) => {
            const character = event.target.value.toUpperCase();
            if (character !== '' && !PAIRING_CODE_CHARACTERS.test(character)) return;
            replaceAt(index, character);
            if (character !== '') cells.current[index + 1]?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && (props.value[index] ?? '') === '' && index > 0) {
              replaceAt(index - 1, '');
              cells.current[index - 1]?.focus();
            } else if (event.key === 'ArrowLeft') {
              cells.current[index - 1]?.focus();
            } else if (event.key === 'ArrowRight') {
              cells.current[index + 1]?.focus();
            }
          }}
          className="wr-pairing-code-cell"
        />
      ))}
    </div>
  );
}

interface CryptoTestApi {
  identity(): ReturnType<typeof ensureBrowserIdentity>;
  open(ciphertext: string): Promise<number[]>;
  seal(message: number[], publicKey: string): Promise<string>;
  unpair(): Promise<void>;
  worker(request: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __codorCrypto: CryptoTestApi;
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

window.__codorCrypto = {
  identity: ensureBrowserIdentity,
  open: async (ciphertext) => Array.from(await openForBrowser(ciphertext)),
  seal: (message, publicKey) => sealForBrowserPeer(Uint8Array.from(message), publicKey),
  unpair: unpairBrowser,
  worker: workerCall,
};

export function PairingPage(props: { autoPair?: boolean; returnTo?: string } = {}): JSX.Element {
  const currentUrl = useMemo(() => new URL(window.location.href), []);
  const hasOffer = currentUrl.searchParams.has('pairing_token');
  const [qr, setQr] = useState<string>();
  const [state, setState] = useState<'checking' | 'ready' | 'pairing' | 'paired' | 'failed'>(
    props.autoPair && !hasOffer ? 'checking' : 'ready',
  );
  const [failure, setFailure] = useState<string>();
  const [pairingLink, setPairingLink] = useState('');
  const [pairingCode, setPairingCode] = useState('');

  useEffect(() => {
    if (!hasOffer) return;
    void QRCode.toDataURL(currentUrl.toString(), { margin: 1, width: 320 }).then(setQr);
  }, [currentUrl, hasOffer]);

  useEffect(() => {
    if (!props.autoPair || hasOffer) return;
    let current = true;
    void tryTrustedBrowserPairing().then(
      (paired) => {
        if (!current) return;
        if (!paired) {
          setState('ready');
          return;
        }
        setState('paired');
        window.location.replace(props.returnTo ?? '/');
      },
      () => {
        if (current) setState('ready');
      },
    );
    return () => {
      current = false;
    };
  }, [hasOffer, props.autoPair, props.returnTo]);

  const endpointLabel = useMemo(() => {
    const endpoint = currentUrl.searchParams.get('endpoint');
    if (!endpoint) return 'No switchboard selected';
    try {
      return new URL(endpoint).host;
    } catch {
      return 'Invalid switchboard address';
    }
  }, [currentUrl]);

  // harn:assume unpaired-browser-always-has-enrollment-path ref=unpaired-pairing-workspace
  // harn:assume pairing-offer-token-remains-qr-only ref=glass-pairing-surface
  // harn:assume pairing-discloses-browser-and-relay-boundaries ref=pairing-boundary-workspace
  return (
    <main data-testid="pairing-page" className="wr-pairing-page">
      <header className="wr-pairing-brand">
        <strong>Codor</strong>
        <span>Local device enrollment</span>
      </header>

      <section className="wr-pairing-shell">
        <div className="wr-pairing-enrollment">
          <div className="wr-pairing-heading">
            <div>
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
                  <li><Check aria-hidden="true" size={15} /> Channel keys stored locally for this device</li>
                  <li><Check aria-hidden="true" size={15} /> Revoke and purge from Settings</li>
                </ul>
                <button
                  type="button"
                  disabled={state === 'pairing' || state === 'paired'}
                  onClick={() => {
                    setState('pairing');
                    setFailure(undefined);
                    void completeBrowserPairing(currentUrl).then(
                      () => setState('paired'),
                      (error: unknown) => {
                        const signingMismatch = error instanceof Error && error.message.includes('signing key does not match');
                        setFailure(signingMismatch
                          ? 'Security check failed. Stop: the switchboard identity does not match this pairing link.'
                          : 'Pairing failed. Check the switchboard connection and request a fresh link.');
                        setState('failed');
                      },
                    );
                  }}
                  className="wr-primary-button wr-pair-button"
                >
                  <KeyRound aria-hidden="true" size={18} />
                  {state === 'pairing' ? 'Pairing' : state === 'paired' ? 'Paired' : 'Pair this browser'}
                </button>
                {state === 'paired' && <p role="status" className="wr-pair-success"><Check aria-hidden="true" size={15} /> Browser paired. You can open your channels.</p>}
                {state === 'failed' && <p role="alert" className="wr-form-error">{failure}</p>}
              </div>
            </div>
          ) : state === 'checking' ? (
            <div data-testid="trusted-pairing-progress" role="status" className="wr-pairing-empty">
              <LoaderCircle className="wr-progress-icon" aria-hidden="true" size={24} />
              <h2>Checking tailnet access</h2>
              <p>This browser is requesting device enrollment from the local switchboard.</p>
            </div>
          ) : (
            // harn:assume pairing-code-enrollment-surfaces ref=browser-pairing-code-workspace
            <div data-testid="manual-pairing" className="wr-pairing-empty wr-manual-pairing">
              <KeyRound aria-hidden="true" size={24} />
              <h2>Pair this browser</h2>
              <p>Enter the code shown by <code>codor pair</code>.</p>
              <form
                data-testid="pairing-code-form"
                className="wr-pairing-code-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFailure(undefined);
                  if (pairingCode.length !== 8) {
                    setFailure('Enter the complete 8-character pairing code.');
                    return;
                  }
                  setState('pairing');
                  void exchangeBrowserPairingCode(pairingCode).then(
                    (url) => window.location.assign(url.toString()),
                    () => {
                      setState('failed');
                      setFailure('Pairing code not found. Request a fresh code and try again.');
                    },
                  );
                }}
              >
                <PairingCodeInput
                  value={pairingCode}
                  onChange={setPairingCode}
                  disabled={state === 'pairing'}
                />
                <button type="submit" disabled={state === 'pairing'} className="wr-primary-button min-h-11 px-4">
                  {state === 'pairing' ? 'Checking code' : 'Continue'}
                </button>
              </form>
              <div className="wr-pairing-fallback"><span>or use a pairing link</span></div>
              <form
                className="wr-pairing-link-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFailure(undefined);
                  try {
                    const link = new URL(pairingLink.trim());
                    if (
                      link.pathname !== '/pair' ||
                      !link.searchParams.has('endpoint') ||
                      !link.searchParams.has('pairing_token') ||
                      !link.searchParams.has('switchboard_sign_pub')
                    ) throw new Error('invalid pairing link');
                    window.location.assign(link.toString());
                  } catch {
                    setFailure('Paste the complete pairing link from the host.');
                  }
                }}
              >
                <label className="wr-field-label">
                  Pairing link
                  <input
                    type="password"
                    data-testid="pairing-link"
                    value={pairingLink}
                    onChange={(event) => setPairingLink(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    className="wr-input min-h-11 px-3"
                  />
                </label>
                <button type="submit" className="wr-secondary-button min-h-11 px-4">
                  Open pairing link
                </button>
              </form>
              {failure && <p role="alert" className="wr-form-error">{failure}</p>}
            </div>
            // harn:end pairing-code-enrollment-surfaces
          )}
        </div>

        <div className="wr-pairing-disclosure">
          <section>
            <Database aria-hidden="true" size={19} />
            <div><h2>This browser stores</h2><p>Private device keys, decrypted channel keys, and same-origin switchboard access in this origin's IndexedDB.</p></div>
          </section>
          <section>
            <Eye aria-hidden="true" size={19} />
            <div><h2>Relay can see</h2><p>Padded ciphertext size, Web Push endpoint and delivery keys, opaque signing identity, timing, TTL, and source IP.</p></div>
          </section>
          <section>
            <EyeOff aria-hidden="true" size={19} />
            <div><h2>Relay never sees</h2><p>Sender, channel or member names, plaintext content or run evidence, decrypted channel keys, or private device keys.</p></div>
          </section>
        </div>
      </section>
    </main>
  );
  // harn:end pairing-discloses-browser-and-relay-boundaries
  // harn:end pairing-offer-token-remains-qr-only
  // harn:end unpaired-browser-always-has-enrollment-path
}
