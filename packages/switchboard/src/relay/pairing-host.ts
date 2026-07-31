import {
  Keepalive,
  PairingChannel,
  PakeError,
  PakeHost,
  RELAY_KEEPALIVE_INTERVAL_MS,
  RELAY_KEEPALIVE_PONG,
  composeCode,
  generateSecret,
  type PairingMessage,
} from '@codor/tunnel';

import type { PublicIdentity } from '../crypto/keys.js';
import type { PairingOffer, PairingRequest, PairingResult, PairingService } from '../crypto/pairing.js';
import { dialWs, type RelaySocket } from './link.js';
import type { RelayStore } from './store.js';

// harn:assume relay-pairing-host-universal-mint ref=relay-pairing-host-universal
// Host side of relay pairing (PLAN §4.2). It reserves a room, connects as host,
// runs a fresh PakeHost per claimant, and over the pairing AEAD channel bridges
// to the EXISTING PairingService. The universal mint reserves the room, derives
// the code from nameplate+secret, and dual-registers it as a LOCAL pairing grant
// via PairingService.issueForCode; the resulting token is what hello carries and
// what complete() burns, so the one code opens both the relay and local doors on
// a single shared grant. Attempt/reset accounting preserves the online-guess
// bound; success burns the room.
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export interface RelayPairingHostDeps {
  store: RelayStore;
  pairing: PairingService;
  identity: PublicIdentity;
  reserveRoom?: (relayUrl: string) => Promise<{ nameplate: string }>;
  dialRoom?: (url: string) => RelaySocket;
  now?: () => number;
  randomSecret?: () => string;
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  /** §4.1 keepalive probe cadence on the room socket; injectable for tests. */
  keepaliveMs?: number;
  setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  onError?: (error: unknown) => void;
}

async function defaultReserve(relayUrl: string): Promise<{ nameplate: string }> {
  const base = relayUrl.replace(/\/$/, '');
  const httpBase = base.replace(/^ws/, 'http');
  const response = await fetch(`${httpBase}/v1/pair/rooms`, { method: 'POST' });
  if (!response.ok) throw new Error(`relay pairing room reservation failed (${response.status})`);
  return (await response.json()) as { nameplate: string };
}

/** Drives one relay pairing session against the pairing room. */
export class RelayPairingHost {
  private readonly deps: Required<Omit<RelayPairingHostDeps, 'onError'>> & Pick<RelayPairingHostDeps, 'onError'>;

  constructor(deps: RelayPairingHostDeps) {
    this.deps = {
      reserveRoom: defaultReserve,
      dialRoom: dialWs,
      now: Date.now,
      randomSecret: generateSecret,
      setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
      clearTimeoutFn: (handle) => clearTimeout(handle),
      keepaliveMs: RELAY_KEEPALIVE_INTERVAL_MS,
      setIntervalFn: (cb, ms) => setInterval(cb, ms),
      clearIntervalFn: (handle) => clearInterval(handle),
      ...deps,
    };
  }

  /**
   * Reserve a room, dual-register its code as a local grant, and pair the first
   * claimant that completes. Returns the full PairingOffer (doors:'both') so the
   * same code and link token work at the local door too. If the relay room can't
   * be reserved the mint degrades to a local-only code (doors:'local') rather
   * than failing — local pairing must never hard-depend on relay reachability.
   */
  async pair(endpoint?: string): Promise<PairingOffer> {
    const { store } = this.deps;
    const secret = this.deps.randomSecret();
    // Reserve AND dial the room through the store's REACHABLE dial URL, failing over
    // to the other {canonical, alias} member on failure (default URL only) and caching
    // whichever reaches the relay — so the first-code mint works on SNI-filtered
    // networks, exactly like the host session. store.relayUrl alone would hit the
    // blocked canonical and degrade even when the alias is reachable.
    const candidates = store.dialFallback !== undefined ? [store.dialUrl, store.dialFallback] : [store.dialUrl];
    let reserved: { nameplate: string; base: string } | undefined;
    for (const base of candidates) {
      try {
        const { nameplate } = await this.deps.reserveRoom(base);
        reserved = { nameplate, base };
        store.setDialWinner(base); // cache the endpoint that reached the relay
        break;
      } catch (error) {
        this.deps.onError?.(error);
      }
    }
    if (reserved === undefined) {
      // No relay endpoint reachable: degrade to a local-only code (doors:'local').
      // Local pairing must never hard-depend on relay reachability.
      return this.deps.pairing.issue(endpoint ?? store.relayUrl);
    }
    // The room's nameplate+secret IS the pairing code; register it as a local
    // pairing grant and reuse the minted token for the relay hello so consuming
    // either door burns the single shared grant. Preserve the CALLER's endpoint so
    // Settings' link/QR and the enrolling browser's ?endpoint= stay on the switchboard
    // origin, not the relay Worker.
    const offer = this.deps.pairing.issueForCode(composeCode(reserved.nameplate, secret), endpoint ?? store.relayUrl);
    const wsBase = reserved.base.replace(/\/$/, '').replace(/^http/, 'ws');
    const socket = this.deps.dialRoom(`${wsBase}/v1/pair/${reserved.nameplate}/ws?role=host`);
    new RelayPairingSession(socket, reserved.nameplate, secret, offer.pairing_token, this.deps);
    return { ...offer, doors: 'both' };
  }
}

type Phase = 'idle' | 'msgB' | 'tagC' | 'enroll' | 'done';

/** State machine for a single room session (one nameplate). */
class RelayPairingSession {
  private phase: Phase = 'idle';
  private pake?: PakeHost;
  private channel?: PairingChannel;
  /**
   * The successful enrollment, cached in-memory for the room's live window so a
   * lost `enrolled` ack is recoverable: a retry that re-confirms the PAKE and
   * enrolls with the SAME device_id gets this result replayed (idempotent — the
   * device is already enrolled). The grant stays burned; only the result is
   * replayed, never re-minted, so single-use is untouched. Dies with the session.
   */
  private enrolled?: { deviceId: string; result: PairingResult };
  private attempts = 0;
  private closed = false;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private keepalive?: Keepalive;

  constructor(
    private readonly socket: RelaySocket,
    private readonly nameplate: string,
    private readonly secret: string,
    /** Pre-minted at reservation via issueForCode; hello carries it, complete() burns it. */
    private readonly token: string,
    private readonly deps: RelayPairingHost['deps'],
  ) {
    socket.onMessage((data, isBinary) => {
      this.keepalive?.noteActivity();
      this.onMessage(data, isBinary);
    });
    socket.onError((error) => this.deps.onError?.(error));
    socket.onClose(() => this.shutdown());
    // Probe the room socket across the idle mint-to-claim window so a silently
    // dropped host socket is surfaced rather than leaving a code that can never
    // be claimed. Armed on open (not in the constructor) so the immediate probe
    // never sends on a not-yet-open socket and false-counts a healthy room dead.
    // PairingRoom auto-answers the ping.
    socket.onOpen(() => {
      this.keepalive?.stop();
      this.keepalive = new Keepalive({
        send: (ping) => this.socket.send(ping),
        onDead: () => this.shutdown(),
        intervalMs: this.deps.keepaliveMs,
        setIntervalFn: this.deps.setIntervalFn,
        clearIntervalFn: this.deps.clearIntervalFn,
      });
    });
    // The host enforces the 10-minute pairing window itself: a malicious relay
    // cannot extend the guessing window by never burning the room.
    this.deadline = this.deps.setTimeoutFn(() => this.shutdown(), PAIRING_WINDOW_MS);
  }

  private sendText(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.keepalive?.stop();
    this.deps.clearTimeoutFn(this.deadline);
    this.socket.close();
  }

  /** Count a failed guess; the host burns the pairing after three, independent of the relay. */
  private failAttempt(): void {
    this.attempts += 1;
    this.sendText({ type: 'fail' });
    this.phase = 'idle';
    this.pake = undefined;
    if (this.attempts >= MAX_ATTEMPTS) this.shutdown();
  }

  private onMessage(data: Uint8Array, isBinary: boolean): void {
    if (this.closed) return;
    try {
      if (isBinary) {
        this.onBinary(data);
        return;
      }
      const text = new TextDecoder().decode(data);
      if (text === RELAY_KEEPALIVE_PONG) return; // keepalive answer; liveness already noted
      this.onControl(JSON.parse(text) as { type?: string });
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  private onControl(msg: { type?: string }): void {
    // A fresh claimant joined: (re)start the PAKE and send MSG_A.
    if (msg.type === 'peer-joined' && this.attempts < MAX_ATTEMPTS) this.startAttempt();
  }

  private startAttempt(): void {
    this.pake = new PakeHost({ nameplate: this.nameplate, secret: this.secret });
    this.channel = undefined;
    this.phase = 'msgB';
    this.socket.send(this.pake.start());
  }

  private onBinary(data: Uint8Array): void {
    switch (this.phase) {
      case 'msgB':
        try {
          this.pake!.receiveMsgB(data);
        } catch (error) {
          // An invalid/identity point is a spec-required failed attempt (§4.2).
          if (error instanceof PakeError) return this.failAttempt();
          throw error;
        }
        this.phase = 'tagC';
        break;
      case 'tagC':
        this.handleClaimantConfirmation(data);
        break;
      case 'enroll':
        this.handleEnroll(this.channel!.open(data));
        break;
      case 'done':
        this.handleDone(this.channel!.open(data));
        break;
      default:
        break; // idle / stray binary
    }
  }

  private handleClaimantConfirmation(tagC: Uint8Array): void {
    let tagH: Uint8Array;
    try {
      tagH = this.pake!.receiveClaimantConfirmation(tagC);
    } catch (error) {
      // Wrong secret: count the attempt; burn after three.
      if (error instanceof PakeError) return this.failAttempt();
      throw error;
    }
    this.socket.send(tagH);
    this.channel = new PairingChannel(this.pake!.channel());
    const hello: PairingMessage = {
      type: 'hello',
      switchboard: this.deps.identity,
      session_id: this.deps.store.sessionId,
      host_static_pub: this.deps.store.hostStaticPubB64,
      pairing_token: this.token,
      relay_url: this.deps.store.relayUrl,
      protocol: 1,
    };
    this.socket.send(this.channel.seal(hello));
    this.phase = 'enroll';
  }

  /**
   * Re-seal and replay the cached `enrolled` over the CURRENT channel when a
   * retry enrolls the already-enrolled device (a lost ack). Returns false if
   * there is nothing to replay or the device_id differs (a different claimant).
   */
  private replayEnrolledFor(request: PairingRequest, clientStaticPub: string): boolean {
    if (!this.enrolled || request.device_id !== this.enrolled.deviceId) return false;
    // A real retry arrives with a FRESH tunnel static key. The replay is a
    // re-enrollment for KEY CUSTODY, not a cache hit: update the stored device
    // record to the retry's key (replace by device_id) BEFORE replaying, or the
    // device looks paired but every future KK session handshake fails against the
    // stale key — worse than the ack-loss this recovers.
    this.deps.store.addDevice({ device_id: request.device_id, client_static_pub: clientStaticPub, label: request.label });
    this.socket.send(this.channel!.seal({ type: 'enrolled', result: this.enrolled.result }));
    this.phase = 'done';
    return true;
  }

  private handleEnroll(message: PairingMessage): void {
    if (message.type !== 'enroll') throw new Error(`expected enroll, got ${message.type}`);
    // A wrong echoed token is a tamper/protocol failure: fail the claimant (count
    // the attempt, room closes it 4003) rather than throwing into a silent onError.
    if (message.pairing_token !== this.token) return this.failAttempt();
    const request = message.request as PairingRequest;
    let result: PairingResult;
    try {
      result = this.deps.pairing.complete(this.token, request);
    } catch (error) {
      // The grant is gone. If this is the already-enrolled device re-confirming
      // after a lost `enrolled` ack, replay the cached result (idempotent). A
      // DIFFERENT device_id means the code was consumed by someone else: fail the
      // claimant (attempt counted, closed 4003) instead of a silent onError.
      if (this.replayEnrolledFor(request, message.client_static_pub)) return;
      this.deps.onError?.(error);
      return this.failAttempt();
    }
    this.enrolled = { deviceId: request.device_id, result };
    this.deps.store.addDevice({ device_id: request.device_id, client_static_pub: message.client_static_pub, label: request.label });
    const enrolled: PairingMessage = { type: 'enrolled', result };
    this.socket.send(this.channel!.seal(enrolled));
    this.phase = 'done';
  }

  private handleDone(message: PairingMessage): void {
    // A lost `enrolled` ack resent on the SAME channel arrives here in phase
    // 'done' as an enroll: replay for the enrolled device, else fail — never the
    // old "expected done" throw that hung the claimant.
    if (message.type === 'enroll') {
      if (this.replayEnrolledFor(message.request as PairingRequest, message.client_static_pub)) return;
      return this.failAttempt();
    }
    if (message.type !== 'done') throw new Error(`expected done, got ${message.type}`);
    this.sendText({ type: 'success' });
    this.phase = 'idle';
    // Success: stop the deadline and keepalive and go inert; the relay burns the room.
    this.keepalive?.stop();
    this.deps.clearTimeoutFn(this.deadline);
    this.closed = true;
  }
}
// harn:end relay-pairing-host-universal-mint
