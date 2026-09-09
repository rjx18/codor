import { useEffect, useState } from 'react';

import {
  EXTENDED_THRESHOLD_MS,
  classifySession,
  reconnectGraceUntil,
  type SessionConnectionState,
} from './connection-state.js';
import { useClientStore } from './store.js';
import { useNavigatorOnLine } from './use-navigator-online.js';

declare global {
  interface Window {
    /** e2e-only: shorten the recovery grace / escalation timings for tests. */
    __CODOR_RECOVERY_GRACE_MS?: number;
    __CODOR_RECOVERY_EXTENDED_MS?: number;
    __CODOR_RECOVERY_RETRY_S?: number;
    /** e2e-only: shorten pairThroughRelay's dead-room deadline. */
    __CODOR_PAIR_DEADLINE_MS?: number;
  }
}

/**
 * The live recovery-surface state, combining the store's `connected`/`authRefused`
 * (written by the connector) with `navigator.onLine` and how long the session has
 * been down. Ticks once a second while down so the threshold escalation and the
 * retry countdown stay current. `downMs` is exposed for the countdown UI.
 */
/** A deadline observer, not a connection/retry owner. Remounts never extend it. */
export function useGraceDeadline(deadline: number | undefined): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    if (deadline === undefined || deadline <= Date.now()) return;
    const timer = setTimeout(() => tick(value => value + 1), deadline - Date.now());
    return () => clearTimeout(timer);
  }, [deadline]);
  return deadline !== undefined && Date.now() < deadline;
}

export function useReconnectGrace(): boolean {
  return useGraceDeadline(useClientStore(reconnectGraceUntil));
}

export function useConnectionState(): { state: SessionConnectionState; downMs: number; inGrace: boolean } {
  const connected = useClientStore((s) => s.connected);
  const authRefused = useClientStore((s) => s.authRefused);
  const online = useNavigatorOnLine();
  const downSince = useClientStore(state => state.disconnectedSince);
  const inGrace = useReconnectGrace();
  const [nowMs, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (connected) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [connected, downSince]);

  const downMs = connected || downSince === undefined ? 0 : Math.max(0, Math.max(nowMs, Date.now()) - downSince);
  const extendedThresholdMs =
    (typeof window !== 'undefined' && window.__CODOR_RECOVERY_EXTENDED_MS) || EXTENDED_THRESHOLD_MS;
  const state = classifySession({
    connected,
    navigatorOnLine: online,
    authRefused,
    downMs,
    extendedThresholdMs,
  });
  return { state, downMs, inGrace };
}
