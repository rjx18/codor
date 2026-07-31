import { RELAY_KEEPALIVE_PING } from './control.js';

// harn:assume tunnel-keepalive ref=tunnel-keepalive
// Shared half-open detector (PLAN §4.1). The switchboard and the browser run the
// SAME Keepalive on their relay socket: it probes an idle socket with a codor-ping
// every interval, is reset to alive by any inbound traffic, and after two
// consecutive unanswered intervals declares the link dead exactly once so the
// caller can close it and let its own reconnect take over. The relay and both NAT
// paths can drop a socket without ever sending a close frame; only an active probe
// surfaces the half-open link before it strands a session. The answering side is
// the DO's setWebSocketAutoResponse(codor-ping/codor-pong); this is the sender.
export const RELAY_KEEPALIVE_INTERVAL_MS = 30_000;

export interface KeepaliveDeps {
  /** Send one codor-ping on the socket. May throw on a dead socket. */
  send: (ping: string) => void;
  /** Invoked exactly once when two consecutive intervals saw no inbound traffic. */
  onDead: () => void;
  /** Probe cadence; injectable for tests. Defaults to 30s (§4.1). */
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export class Keepalive {
  private pending = 0;
  private stopped = false;
  private readonly onDead: () => void;
  private readonly send: (ping: string) => void;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(deps: KeepaliveDeps) {
    this.send = deps.send;
    this.onDead = deps.onDead;
    const intervalMs = deps.intervalMs ?? RELAY_KEEPALIVE_INTERVAL_MS;
    const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.timer = setIntervalFn(() => this.tick(), intervalMs);
    // Probe immediately on arming so a link that is already half-open is declared
    // dead within two intervals (~60s), not three (~90s).
    this.tick();
  }

  /** Any inbound traffic — data, control, or the pong itself — proves the link is alive. */
  noteActivity(): void {
    this.pending = 0;
  }

  /** Stop probing (socket closed or superseded). Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearIntervalFn(this.timer);
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.pending >= 2) {
      // Two probes crossed two intervals with no inbound traffic: half-open link.
      this.stop();
      this.onDead();
      return;
    }
    this.pending += 1;
    try {
      this.send(RELAY_KEEPALIVE_PING);
    } catch {
      // A throwing send is itself a dead socket; the next tick declares it.
    }
  }
}
// harn:end tunnel-keepalive
