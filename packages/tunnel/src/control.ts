// harn:assume relay-control-vocabulary-is-canonical ref=tunnel-control-mirror
// Client-side mirror of the relay cleartext control vocabulary (PLAN §4.1).
// DELIBERATELY duplicated from relay-worker/src/control.ts — the tunnel cannot
// import the dependency-free Worker package. Every value here MUST match that
// file exactly; the two are a pair, not two independent definitions.

/** WebSocket close codes used by the relay Durable Objects. */
export const RELAY_CLOSE = {
  /** Pairing succeeded; room burned cleanly. */
  PAIRED: 1000,
  /** Room/session burned or terminated (expired / attempts / churn / generic). */
  BURN: 4000,
  /** A newer host socket replaced this one. */
  SUPERSEDED: 4001,
  /** A claimant tried to join an already-occupied pairing room. */
  BUSY: 4002,
  /** The host rejected this claimant's PAKE confirmation. */
  REJECTED: 4003,
  /** The session already has the maximum number of client connections. */
  FULL: 4004,
} as const;

/** Idle keepalive request/response pair answered by the DO auto-responder (PLAN §4.1). */
export const RELAY_KEEPALIVE_PING = 'codor-ping';
export const RELAY_KEEPALIVE_PONG = 'codor-pong';

export type PairingRole = 'host' | 'claim';
export type SessionRole = 'host' | 'client';
export type BurnReason = 'expired' | 'attempts' | 'paired' | 'churn';

/** Relay-generated text messages sent to peers in a pairing room. */
export type PairingServerControl =
  | { type: 'peer-joined'; role: PairingRole }
  | { type: 'peer-left'; role: PairingRole }
  | { type: 'no-peer' }
  | { type: 'burned'; reason: BurnReason };

/** Text control messages accepted only from the pairing host. */
export type PairingHostControl = { type: 'fail' } | { type: 'success' };

/** Relay-generated text messages sent in a session relay. */
export type SessionServerControl =
  | { type: 'host-connected' }
  | { type: 'host-disconnected' }
  | { type: 'client-connected'; conn: number }
  | { type: 'client-disconnected'; conn: number }
  | { type: 'unknown-conn'; conn: number };
// harn:end relay-control-vocabulary-is-canonical
