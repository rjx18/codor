import { useEffect, useRef, type ReactNode } from 'react';

import { useConnectionState } from '../app/use-connection-state.js';
import { RecoveryCard, type RecoveryState } from './RecoveryCard.js';

// Brief drops keep the in-room "Reconnecting…" pill; the full recovery screen only
// takes over after the session has been down long enough to be worth explaining.
// Overridable via window for e2e (same pattern as __CODOR_RELAY_URL).
const graceMs = (): number =>
  (typeof window !== 'undefined' && window.__CODOR_RECOVERY_GRACE_MS) || 6_000;

/**
 * A true OVERLAY: the app (and its connector/tunnel) stay mounted at all times —
 * the recovery card renders ON TOP when the session is unreachable long enough to
 * warrant it, with the app beneath marked aria-hidden. Never unmounting the app is
 * what keeps the reconnect machinery alive (its backoff is the auto-retry) and the
 * down-clock running (so the escalation to the re-pair state is reachable). A live
 * session (or a brief drop within the grace) shows no overlay, so direct/tailnet
 * flows are visually unchanged unless they too go genuinely unreachable.
 */
export function RecoveryOverlay({ children }: { children: ReactNode }): ReactNode {
  const { state, downMs } = useConnectionState();
  const show = state !== 'online' && !(state === 'agent-offline' && downMs < graceMs());
  const beneathRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = beneathRef.current;
    if (!el) return;
    // `inert` (attribute-set for cross-version safety) makes the app truly
    // non-focusable beneath the modal — aria-hidden alone leaves it in tab order.
    if (show) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [show]);
  return (
    <>
      <div ref={beneathRef} aria-hidden={show || undefined}>{children}</div>
      {show ? <RecoveryCard state={state as RecoveryState} presentation="overlay" /> : null}
    </>
  );
}
