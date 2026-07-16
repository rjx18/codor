import { Check, KeyRound, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';

import {
  completeBrowserPairing,
  exchangeBrowserPairingCode,
  tryTrustedBrowserPairing,
} from '@legacy/crypto.js';

import { Button, Code } from '../primitives/primitives.js';

type PairingState = 'checking' | 'ready' | 'pairing' | 'paired' | 'failed';

/** Browser enrollment: an offer link shows its QR + confirm; a bare visit probes
 *  trusted pairing first, then falls back to the 8-char code or a pasted link.
 *  Offer authority stays inside the QR raster — never rendered as plaintext. */
export function PairingPage(props: { autoPair?: boolean; returnTo?: string }) {
  const currentUrl = useMemo(() => new URL(window.location.href), []);
  const hasOffer = currentUrl.searchParams.has('pairing_token');
  const [qr, setQr] = useState<string>();
  const [state, setState] = useState<PairingState>(
    props.autoPair === true && !hasOffer ? 'checking' : 'ready',
  );
  const [failure, setFailure] = useState<string>();
  const [pairingLink, setPairingLink] = useState('');
  const [pairingCode, setPairingCode] = useState('');

  useEffect(() => {
    if (!hasOffer) return;
    void QRCode.toDataURL(currentUrl.toString(), { margin: 4, scale: 4 }).then(setQr);
  }, [currentUrl, hasOffer]);

  useEffect(() => {
    if (props.autoPair !== true || hasOffer) return;
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
      () => { if (current) setState('ready'); },
    );
    return () => { current = false; };
  }, [hasOffer, props.autoPair, props.returnTo]);

  const endpointHost = useMemo(() => {
    const endpoint = currentUrl.searchParams.get('endpoint');
    if (endpoint === null) return undefined;
    try {
      return new URL(endpoint).host;
    } catch {
      return undefined;
    }
  }, [currentUrl]);

  return (
    <main className="nx-surface is-settings" aria-label="Pairing" data-testid="pairing-page">
      <div className="nx-settings">
        <header className="nx-settings-head">
          <Eyebrowish />
          <h1>Pair this browser</h1>
          <p className="nx-settings-sub">
            Authorize this browser with Codor on this device — not an account login.
            Keys are minted here and never leave this origin.
          </p>
        </header>

        {hasOffer ? (
          <section className="nx-settings-card nx-pair-offer" data-testid="pairing-offer-state">
            <div className="nx-pair-grid">
              <div className="nx-pair-qr-pane">
                {qr !== undefined
                  ? <img className="nx-pair-qr" src={qr} alt="Pairing QR code" data-testid="pairing-qr" />
                  : <p role="status" className="nx-field-note">Preparing QR…</p>}
                <p className="nx-pair-host">
                  <ShieldCheck size={15} aria-hidden="true" /> {endpointHost ?? 'unknown switchboard'}
                </p>
              </div>
              <div className="nx-pair-explain">
                <h2>Browser authority</h2>
                <ul className="nx-pair-points">
                  <li><Check size={14} aria-hidden="true" /> dual signing + encryption keys</li>
                  <li><Check size={14} aria-hidden="true" /> channel keys stored locally</li>
                  <li><Check size={14} aria-hidden="true" /> revoke any time from Settings</li>
                </ul>
                <Button
                  variant="primary"
                  data-testid="confirm-pair-browser"
                  disabled={state === 'pairing' || state === 'paired'}
                  onClick={() => {
                    setState('pairing');
                    setFailure(undefined);
                    void completeBrowserPairing(currentUrl).then(
                      () => setState('paired'),
                      (error: unknown) => {
                        const mismatch = error instanceof Error && error.message.includes('signing key does not match');
                        setFailure(mismatch
                          ? 'Security check failed — this Codor identity does not match the pairing link. Stop here.'
                          : 'Pairing failed. Check the connection and request a fresh link.');
                        setState('failed');
                      },
                    );
                  }}
                >
                  <KeyRound size={16} aria-hidden="true" />
                  {state === 'pairing' ? 'Pairing…' : state === 'paired' ? 'Paired' : 'Pair this browser'}
                </Button>
                {state === 'paired' && (
                  <p role="status" className="nx-pair-done">
                    <Check size={14} aria-hidden="true" /> Paired — <a href={props.returnTo ?? '/'}>open your channels</a>
                  </p>
                )}
                {state === 'failed' && <p role="alert" className="nx-field-note is-error">{failure}</p>}
              </div>
            </div>
          </section>
        ) : state === 'checking' ? (
          <section className="nx-settings-card" role="status" data-testid="trusted-pairing-progress">
            <h2>Checking trusted enrollment…</h2>
            <p className="nx-settings-sub">Looking for a trusted network identity for this device.</p>
          </section>
        ) : (
          <section className="nx-settings-card" data-testid="manual-pairing">
            <h2>Enter a pairing code</h2>
            <p className="nx-settings-sub">Mint one from Settings → Devices on a paired device.</p>
            <form
              data-testid="pairing-code-form"
              className="nx-pair-form"
              onSubmit={(event) => {
                event.preventDefault();
                setFailure(undefined);
                if (pairingCode.trim().length !== 8) {
                  setFailure('Enter the complete 8-character pairing code.');
                  return;
                }
                setState('pairing');
                void exchangeBrowserPairingCode(pairingCode.trim()).then(
                  (url) => window.location.assign(url.toString()),
                  () => {
                    setState('failed');
                    setFailure('Pairing code not found. Request a fresh code and try again.');
                  },
                );
              }}
            >
              <input
                className="nx-pair-code-input"
                value={pairingCode}
                maxLength={8}
                autoComplete="off"
                autoCapitalize="characters"
                aria-label="Pairing code"
                placeholder="8-char code"
                data-testid="pairing-code-input"
                disabled={state === 'pairing'}
                onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
              />
              <Button type="submit" variant="primary" data-testid="pairing-code-submit" disabled={state === 'pairing'}>
                {state === 'pairing' ? 'Checking…' : 'Continue'}
              </Button>
            </form>
            <p className="nx-field-note">or paste a pairing link</p>
            <form
              className="nx-pair-form"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  const url = new URL(pairingLink);
                  if (!url.searchParams.has('pairing_token')) throw new Error('not an offer');
                  window.location.assign(url.toString());
                } catch {
                  setFailure('That doesn’t look like a pairing link.');
                }
              }}
            >
              <input
                value={pairingLink}
                aria-label="Pairing link"
                placeholder="https://…/pair?pairing_token=…"
                data-testid="pairing-link"
                onChange={(e) => setPairingLink(e.target.value)}
              />
              <Button type="submit" variant="secondary" data-testid="pairing-link-submit">Open link</Button>
            </form>
            {failure !== undefined && <p role="alert" className="nx-field-note is-error">{failure}</p>}
          </section>
        )}
        <p className="nx-settings-note">
          Already paired elsewhere? Open this page there: <Code>Settings → Devices → Pair a new device</Code>.
        </p>
      </div>
    </main>
  );
}

function Eyebrowish() {
  return <span className="nx-eyebrow">Device authority</span>;
}
