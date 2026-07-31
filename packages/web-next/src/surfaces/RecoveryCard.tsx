import { useEffect, useRef, type ReactNode } from 'react';

import { SESSION_COPY, SESSION_REPAIR_HINT, SESSION_TERMINAL_COPY, type SessionConnectionState } from '../app/connection-state.js';
import { forgetRelayPairing } from '../runtime/crypto.js';
import { relayActive } from '../runtime/relay-mode.js';

export type RecoveryState = Exclude<SessionConnectionState, 'online'>;

function retryNow(): void {
  window.location.reload();
}

async function repair(): Promise<void> {
  // Forget ONLY the relay record (not the nuclear unpair) → reload into code entry.
  await forgetRelayPairing();
  window.location.assign('/');
}

/**
 * The single recovery screen (P2 copy + logic), rendered two ways from ONE component:
 *  - `overlay` (mid-session drop): floats ON TOP of the still-mounted app as a modal,
 *    and the connector/tunnel beneath keep retrying — their backoff IS the auto-retry,
 *    so the "Retrying automatically…" line is honest.
 *  - `fullscreen` (boot terminal failure): fills the page, because no app is mounted
 *    behind it yet — so it is NOT modal, and nothing is auto-retrying beneath it (the
 *    one-shot bootstrap has already failed; the manual "Retry now" is the retry).
 * Same copy, same buttons, same re-pair gating — only the wrapper and those two
 * context-dependent affordances differ.
 */
export function RecoveryCard({
  state,
  presentation = 'overlay',
}: {
  state: RecoveryState;
  presentation?: 'overlay' | 'fullscreen';
}): ReactNode {
  const overlay = presentation === 'overlay';
  // Overlay keeps the auto-retry framing (a live connector retries beneath it); the
  // boot card is terminal, so it points at the manual Retry instead.
  const copy = overlay ? SESSION_COPY[state] : SESSION_TERMINAL_COPY[state];
  // Only the overlay has a live connector retrying beneath it; the boot card is terminal.
  const autoRetrying = overlay && (state === 'agent-offline' || state === 'agent-offline-extended');
  // pairing-dead always warrants re-pair; the ambiguous extended state offers it only in
  // relay mode (a direct/tailnet browser has no relay record to forget — re-pair there
  // would be a bare reload that can't help a down local agent).
  const offerRepair = state === 'pairing-dead' || (state === 'agent-offline-extended' && relayActive());
  // The re-pair hint rides with the extended-state body ONLY when the button is offered,
  // so the text and the action can never disagree. pairing-dead's own body already says
  // it, so it needs no hint.
  const repairHint = state === 'agent-offline-extended' && offerRepair;
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);
  // The fullscreen device-offline card is the ONE event-driven affordance: with no
  // connector mounted to reconnect on its own, it reloads when connectivity returns so
  // its "reconnect on its own once you're back" promise is true. Host-absent stays
  // strictly manual (no timers) — the P2 principle that a manual Retry is the retry.
  useEffect(() => {
    if (overlay || state !== 'device-offline') return undefined;
    const reload = (): void => window.location.reload();
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [overlay, state]);

  const card = (
    <section
      className="nx-upgrade-card"
      role={overlay ? 'alertdialog' : undefined}
      aria-modal={overlay ? 'true' : undefined}
      aria-labelledby="recovery-title"
      tabIndex={-1}
      ref={cardRef}
    >
      <p className="nx-eyebrow">{state === 'device-offline' ? 'Offline' : 'Reconnecting'}</p>
      <h1 id="recovery-title">{copy.title}</h1>
      <p>{copy.body}{repairHint ? ` ${SESSION_REPAIR_HINT}` : ''}</p>
      {autoRetrying ? (
        <p className="nx-recovery-auto" data-testid="recovery-auto" aria-live="polite">
          Retrying automatically…
        </p>
      ) : null}
      <div className="nx-recovery-actions">
        <button
          type="button"
          className={state === 'pairing-dead' ? 'nx-btn' : 'nx-btn is-primary'}
          data-testid="recovery-retry"
          onClick={retryNow}
        >
          Retry now
        </button>
        {offerRepair ? (
          <button
            type="button"
            className={state === 'pairing-dead' ? 'nx-btn is-primary' : 'nx-btn'}
            data-testid="recovery-repair"
            onClick={() => { void repair(); }}
          >
            Re-pair this browser
          </button>
        ) : null}
      </div>
    </section>
  );

  return overlay ? (
    <div className="nx-recovery-overlay" data-testid="recovery" data-recovery-state={state}>{card}</div>
  ) : (
    <main className="nx-upgrade" data-testid="recovery" data-recovery-state={state}>{card}</main>
  );
}
