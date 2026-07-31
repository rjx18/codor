// The recovery journey's honest-state detection (P2). Long host-absence is
// genuinely ambiguous — a laptop asleep overnight is indistinguishable from a
// dead session — so we NEVER declare a live pairing dead on that signal. Two
// separate, pure, injectable classifiers (unit-tested in isolation) drive the
// copy the user sees; getting the state wrong is the bug this phase exists to kill.

/** Post-pairing session surface states. */
export type SessionConnectionState =
  | 'online'
  | 'device-offline'
  | 'agent-offline'
  | 'agent-offline-extended'
  | 'pairing-dead';

export interface SessionSignals {
  /** The app session is live (host reachable). */
  connected: boolean;
  /** navigator.onLine — false means the DEVICE's own network is down. */
  navigatorOnLine: boolean;
  /**
   * The connector parked on a device-auth refusal (app-WS close 4403) over a
   * WORKING tunnel: the host is up and says no. This is the ONLY positive
   * pairing-dead evidence — §4.3 makes the KK layer silently ignore revoked kids,
   * so a revoked device presents as host-never-present (ambiguous), never a
   * wire-level refusal. Do not infer pairing-dead from absence.
   */
  authRefused: boolean;
  /** ms the session has been down (since the last live connection / first attempt). */
  downMs: number;
  /** Past this, ambiguous host-absence escalates to the dual-path extended state. */
  extendedThresholdMs: number;
}

/** Default: ~45s of host-absence before offering re-pair as a secondary choice. */
export const EXTENDED_THRESHOLD_MS = 45_000;

/**
 * Classify the post-pairing session surface. Priority order:
 *  1. a live session is `online`;
 *  2. `device-offline` — highest among offline states: if the device's own
 *     network is down, never blame the pairing;
 *  3. `pairing-dead` — ONLY on positive auth-refusal evidence;
 *  4. otherwise the host is merely absent — `agent-offline` within the threshold,
 *     escalating to the dual-path `agent-offline-extended` after it (which keeps
 *     retrying AND offers re-pair as a soft secondary, never declaring a live
 *     pairing dead).
 */
export function classifySession(s: SessionSignals): SessionConnectionState {
  if (s.connected) return 'online';
  if (!s.navigatorOnLine) return 'device-offline';
  if (s.authRefused) return 'pairing-dead';
  return s.downMs >= s.extendedThresholdMs ? 'agent-offline-extended' : 'agent-offline';
}

/** Pairing-TIME (code-entry) surface — a separate classifier. */
export type PairingTimeState = 'joining' | 'code-bad';

export interface PairingTimeSignals {
  /** An explicit code failure (exchange rejected / bad code). */
  failed: boolean;
  /** ms since the code was submitted with the host not yet joining the room. */
  waitingMs: number;
  /** Past this, host-never-joins-room means the code is bad or the room died. */
  badCodeThresholdMs: number;
}

/** ~20s of the host never joining the room means the code is bad / the room died. */
export const BAD_CODE_THRESHOLD_MS = 20_000;

/**
 * Classify the pairing-time surface. host-never-joins-room beyond the threshold
 * (or an explicit failure) means the CODE is bad or the relay room died → offer a
 * fresh code (re-mint), NOT re-pair. The ledgered `doors:'both'` dead-room case
 * (reserve-succeeded-dial-failed) lands here correctly.
 */
export function classifyPairingTime(s: PairingTimeSignals): PairingTimeState {
  return s.failed || s.waitingMs >= s.badCodeThresholdMs ? 'code-bad' : 'joining';
}

/** Exact user-facing copy per state (single source; fable #299/#304). */
export const SESSION_COPY: Record<Exclude<SessionConnectionState, 'online'>, { title: string; body: string }> = {
  'device-offline': {
    title: 'You appear to be offline',
    body: 'Check your internet connection — we’ll reconnect automatically once you’re back.',
  },
  'agent-offline': {
    title: 'Your agent looks offline',
    body: 'We can’t reach your agent right now. Retrying…',
  },
  'agent-offline-extended': {
    title: 'Still can’t reach your agent',
    body: 'If it’s just off, we’ll keep trying.',
  },
  'pairing-dead': {
    title: 'This pairing no longer works',
    body: 'Your agent turned this browser away. Re-pair this browser to reconnect.',
  },
};

/**
 * Fullscreen (boot terminal) copy. Same states, but framed for a card with NO live
 * connector retrying beneath it: the body points at the manual "Retry now" instead of
 * claiming automatic retries. The one exception is `device-offline`, whose fullscreen
 * card DOES auto-recover — it reloads when the `online` event fires — so its copy keeps
 * the "on its own" promise honestly. Single-sourced alongside SESSION_COPY.
 */
export const SESSION_TERMINAL_COPY: Record<Exclude<SessionConnectionState, 'online'>, { title: string; body: string }> = {
  'device-offline': {
    title: 'You appear to be offline',
    body: 'Check your internet connection — this page will reconnect on its own once you’re back.',
  },
  'agent-offline': {
    title: 'Your agent looks offline',
    body: 'We couldn’t reach your agent. Select “Retry now” to try again.',
  },
  'agent-offline-extended': {
    title: 'Still can’t reach your agent',
    body: 'We couldn’t reach your agent. Select “Retry now” to try again.',
  },
  'pairing-dead': {
    title: 'This pairing no longer works',
    body: 'Your agent turned this browser away. Re-pair this browser to reconnect.',
  },
};

/**
 * Trailing re-pair hint, appended by RecoveryCard ONLY when the re-pair action is
 * actually offered (agent-offline-extended in relay mode). Kept out of the bodies so
 * the copy can never promise re-pair while the button is withheld — text and button are
 * driven by the same `offerRepair`. (pairing-dead keeps its own body: it always offers
 * the button, so its sentence is honest as-is.)
 */
export const SESSION_REPAIR_HINT = 'If you’ve re-installed it or paired it elsewhere, re-pair this browser.';

export const PAIRING_TIME_COPY: Record<PairingTimeState, { title: string; body: string }> = {
  joining: {
    title: 'Reaching your agent…',
    body: 'Waiting for your agent to answer the pairing.',
  },
  'code-bad': {
    title: 'This code isn’t working',
    body: 'The code may have expired or your agent didn’t answer. Get a fresh code and try again.',
  },
};
