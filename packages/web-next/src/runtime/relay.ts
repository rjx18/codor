// Browser half of the Codor relay tunnel (PLAN §4.3/§4.4). Mirrors the
// switchboard RelayLink using the SAME shared @codor/tunnel primitives — the
// KK session handshake, the client-side StreamMux, and the app-WS message
// framing — so both ends stay byte-identical by construction. Real browser
// WebCrypto runs here (noble + globalThis.crypto).
import {
  Keepalive,
  MessageReassembler,
  MuxStream,
  SessionInitiator,
  StreamKind,
  StreamMux,
  frameMessage,
  type TunnelKeypair,
} from '@codor/tunnel';
import { relayDialCandidates } from './relay-dial.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? []);
const fromB64 = (value: string) => {
  // Accepts base64url (how the browser stores keys) and standard base64.
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export type TunnelState = 'connecting' | 'connected' | 'disconnected';
export type TunnelStateListener = (state: TunnelState, generation: number) => void;

export interface TunnelRecord {
  relay_url: string;
  session_id: string; // 64-hex
  client_static: { pub: string; priv: string }; // base64
  host_static_pub: string; // base64
  /** The {primary, alias} member that reached the relay at pairing time (P7);
   *  sessions dial it first, falling back to the other pair member. */
  dial_url?: string;
}

/** Minimal WebSocket-shaped view the connector consumes from socketFactory. */
interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;
const CLOSED = 3;

/** An app-WS mux stream presented as a browser-WebSocket-compatible object. */
class TunnelSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Called when this socket reaches CLOSED so the owner can drop its reference. */
  onDetach?: () => void;
  private readonly reassembler = new MessageReassembler();

  constructor(private readonly stream: MuxStream, optimisticOpen = true) {
    stream.onData = (chunk) => {
      for (const message of this.reassembler.push(chunk)) this.onmessage?.({ data: fromUtf8(message) });
      stream.consume(chunk.length);
    };
    stream.onEnd = () => this.fireClose(1000, '');
    stream.onReset = (reason) => this.fireClose(4000, reason);
    // The host buffers app-WS writes until the loopback /ws opens, so a stream
    // on a LIVE tunnel may open optimistically; an auth failure arrives later
    // as a RESET → close. The no-tunnel fallback must instead close without an
    // open edge: publishing OPEN for its no-op stream briefly enables the
    // composer and silently drops the first post during relay recovery.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      if (!optimisticOpen) {
        this.fireClose(4000, 'tunnel-not-connected');
        return;
      }
      this.readyState = OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return;
    this.stream.write(frameMessage(utf8(data)));
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    try {
      this.stream.end();
    } catch {
      // already closed
    }
    this.fireClose(1000, '');
  }

  /** Force-close because the underlying session dropped (owner-driven). */
  terminate(): void {
    this.fireClose(4000, 'session-lost');
  }

  private fireClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onDetach?.();
    this.onclose?.({ code, reason });
  }
}

/**
 * Maintains the client session to the relay and exposes the two transports the
 * app already speaks: a WebSocket `socketFactory` (for /ws) and a `fetch`
 * (for /api). Reconnects with backoff; surfaces presence as TunnelState.
 */
export class TunnelClient {
  private ws?: WebSocket;
  private mux?: StreamMux;
  private channel?: ReturnType<SessionInitiator['channel']>;
  private keepalive?: Keepalive;
  private stateValue: TunnelState = 'disconnected';
  private retryMs = 500;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private generationValue = 0;
  private readonly readiness = new Set<{
    generation: number;
    resolve: (generation: number) => void;
    reject: (error: Error) => void;
  }>();
  private readonly stateListeners = new Set<TunnelStateListener>();
  /** P7 dial alternation: flipped after an attempt that died before the KK
   *  handshake completed, so a blocked pair member yields to the other on the
   *  next retry; a live session keeps its winner across reconnects. */
  private dialFlip = false;
  private disposed = false;
  private readonly liveSockets = new Set<TunnelSocket>();
  /** Rejecters for in-flight tunneled fetches, so a session drop fails their
   *  promises instead of leaving them (and the bootstrap) pending forever. */
  private readonly pendingHttp = new Set<(error: Error) => void>();
  private readonly keepaliveMs?: number;
  private readonly handshakeMs: number;
  private readonly makeSocket: (url: string) => WebSocket;
  private readonly clientStatic: TunnelKeypair;
  private readonly hostStaticPub: Uint8Array;
  private readonly sessionIdBytes: Uint8Array;
  constructor(
    private readonly record: TunnelRecord,
    opts: { keepaliveMs?: number; handshakeMs?: number; socketFactory?: (url: string) => WebSocket } = {},
  ) {
    this.clientStatic = { publicKey: fromB64(record.client_static.pub), secretKey: fromB64(record.client_static.priv) };
    this.hostStaticPub = fromB64(record.host_static_pub);
    this.sessionIdBytes = fromHex(record.session_id);
    this.keepaliveMs = opts.keepaliveMs;
    this.handshakeMs = opts.handshakeMs ?? 10_000;
    this.makeSocket = opts.socketFactory ?? ((url) => new WebSocket(url));
  }

  get state(): TunnelState {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  // harn:assume browser-tunnel-readiness-follows-current-generation ref=current-tunnel-generation
  /** Resolve only for the generation current when readiness is requested. */
  whenReady(): Promise<number> {
    if (this.generationValue === 0) this.connect();
    const generation = this.generationValue;
    if (this.stateValue === 'connected' && this.mux) return Promise.resolve(generation);
    return new Promise<number>((resolve, reject) => {
      this.readiness.add({ generation, resolve, reject });
    });
  }

  // harn:assume browser-tunnel-readiness-follows-current-generation ref=tunnel-state-subscribers
  subscribe(listener: TunnelStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  // harn:end browser-tunnel-readiness-follows-current-generation

  // harn:assume browser-tunnel-readiness-follows-current-generation ref=idempotent-tunnel-recovery
  connect(): void {
    if (this.disposed || this.mux || this.ws || this.retryTimer !== undefined) return;
    if (this.generationValue === 0) this.advanceGeneration();
    this.startAttempt(this.generationValue);
  }

  /** Accelerate a pending recovery, or deliberately replace a connected tunnel. */
  recover(): void {
    if (this.disposed) return;
    if (this.mux) {
      this.advanceGeneration();
      this.retireCurrentTransport(new Error('tunnel generation replaced'));
      this.setState('disconnected');
      this.startAttempt(this.generationValue);
      return;
    }
    if (this.ws) return; // one handshake is already in flight
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.generationValue === 0) this.advanceGeneration();
    this.startAttempt(this.generationValue);
  }

  private startAttempt(generation: number): void {
    if (this.disposed || generation !== this.generationValue || this.ws || this.mux) return;
    this.setState('connecting');
    const candidates = relayDialCandidates(this.record.dial_url ?? this.record.relay_url);
    const target = candidates[this.dialFlip && candidates.length > 1 ? 1 : 0]!;
    const base = target.replace(/\/$/, '').replace(/^http/, 'ws');
    const ws = this.makeSocket(`${base}/v1/session/${this.record.session_id}/ws?role=client`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const initiator = new SessionInitiator({
      clientStatic: this.clientStatic,
      hostStaticPub: this.hostStaticPub,
      sessionId: this.sessionIdBytes,
    });
    let handshakeDone = false;
    // A stale-but-buffered host can swallow msg1 without any error or close ever
    // reaching us, stranding the connect in the pre-handshake window (before the
    // keepalive even arms). Bound that window: if the KK handshake hasn't
    // completed in time, abandon and reconnect on the normal backoff path.
    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) fail();
    }, this.handshakeMs);
    ws.onopen = () => ws.send(initiator.start());
    ws.onmessage = (event) => {
      if (generation !== this.generationValue || this.ws !== ws) return;
      // Any inbound frame — mux data, presence, or the codor-pong — proves the
      // session link is still alive, so the keepalive should not declare it dead.
      this.keepalive?.noteActivity();
      // The relay multiplexes JSON presence/control frames (§4.1) alongside the
      // binary handshake + mux ciphertext. With binaryType 'arraybuffer' a text
      // frame arrives as a string; treat only ArrayBuffer payloads as wire bytes.
      if (typeof event.data === 'string') {
        // The real relay keeps this socket OPEN when the host drops, so the only
        // signal is this notice — tear the session down so reconnect re-handshakes.
        let notice: { type?: string };
        try {
          notice = JSON.parse(event.data) as { type?: string };
        } catch {
          return;
        }
        if (notice.type === 'host-disconnected' || notice.type === 'unknown-conn') ws.close();
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (!handshakeDone) {
        ws.send(initiator.receiveMsg2(bytes));
        this.channel = initiator.channel();
        this.mux = new StreamMux({
          role: 'client',
          onPacket: (packet) => ws.send(this.channel!.seal(packet)),
          onStream: () => {},
        });
        handshakeDone = true;
        clearTimeout(handshakeTimer);
        this.retryMs = 500;
        this.setState('connected');
        this.resolveReady(generation);
        // Probe the idle session so a silently half-open link (the relay/NAT
        // dropping state over idle hours) is surfaced and reconnected rather than
        // stranding the app on a dead socket. SessionRelay auto-answers the ping.
        // A half-open socket's close() never completes, so death drives the
        // once-guarded fail() teardown directly, with close() as best-effort.
        this.keepalive = new Keepalive({
          send: (ping) => ws.send(ping),
          // fail() detaches handlers, closes the socket, and reconnects — all
          // without waiting on a close event the half-open socket never sends.
          onDead: () => fail(),
          intervalMs: this.keepaliveMs,
        });
        return;
      }
      this.mux!.receivePacket(this.channel!.open(bytes));
    };
    // A failed connection fires BOTH onerror and onclose; settle once so a single
    // drop schedules exactly one reconnect (two would race two live sessions,
    // overwriting mux/channel and opening packets with the wrong key). Detaching
    // the handlers also stops a superseded socket's late events from firing.
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      // Close the abandoned socket centrally: the deadline and keepalive paths
      // call fail() on a LIVE socket, and leaving it open leaks a client slot
      // toward the relay's per-session cap on every retry. Best-effort — a
      // double-close from the onclose path is a harmless no-op.
      try {
        ws.close();
      } catch {
        // already gone
      }
      this.onDisconnect(ws, handshakeDone, generation);
    };
    ws.onclose = fail;
    ws.onerror = fail;
  }

  private onDisconnect(ws: WebSocket, handshakeCompleted: boolean, generation: number): void {
    // Ignore a drop from a socket we have already replaced — only the current
    // session's failure drives the reconnect.
    if (this.disposed || this.ws !== ws || generation !== this.generationValue) return;
    this.ws = undefined;
    // An attempt that never completed the handshake may have hit a blocked pair
    // member — alternate for the next retry (P7). A live session that dropped
    // keeps its winner.
    if (!handshakeCompleted && relayDialCandidates(this.record.dial_url ?? this.record.relay_url).length > 1) {
      this.dialFlip = !this.dialFlip;
    }
    this.keepalive?.stop();
    this.keepalive = undefined;
    this.mux = undefined;
    this.channel = undefined;
    // Reject every in-flight tunneled fetch: the mux is gone, so their streams
    // will never see onEnd/onReset. Leaving them pending would hang the caller
    // (e.g. the bootstrap channel-list load) forever — the dead-end the retry is
    // meant to escape. Rejecting lets the caller's retry/backoff advance.
    for (const reject of [...this.pendingHttp]) reject(new Error('tunnel session lost'));
    this.pendingHttp.clear();
    if (handshakeCompleted) this.advanceGeneration();
    this.setState('disconnected');
    // Surface a close on every live app-WS socket so the connector's OWN
    // reconnect re-opens a stream on the NEXT session — never silently
    // re-attach to a session the connector believes is still live.
    for (const socket of [...this.liveSockets]) socket.terminate();
    this.liveSockets.clear();
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private setState(state: TunnelState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of this.stateListeners) listener(state, this.generationValue);
  }

  private advanceGeneration(): void {
    this.generationValue += 1;
    for (const waiter of [...this.readiness]) {
      if (waiter.generation >= this.generationValue) continue;
      this.readiness.delete(waiter);
      waiter.reject(new Error('stale tunnel generation'));
    }
  }

  private resolveReady(generation: number): void {
    if (generation !== this.generationValue) return;
    for (const waiter of [...this.readiness]) {
      if (waiter.generation !== generation) continue;
      this.readiness.delete(waiter);
      waiter.resolve(generation);
    }
  }

  private retireCurrentTransport(error: Error): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    }
    this.keepalive?.stop();
    this.keepalive = undefined;
    for (const reject of [...this.pendingHttp]) reject(error);
    this.pendingHttp.clear();
    for (const socket of [...this.liveSockets]) socket.terminate();
    this.liveSockets.clear();
    this.mux?.close(error.message);
    this.mux = undefined;
    this.channel = undefined;
    try {
      ws?.close();
    } catch {
      // already gone
    }
  }
  // harn:end browser-tunnel-readiness-follows-current-generation
  // harn:end browser-tunnel-readiness-follows-current-generation

  /** WebSocket factory for the connector: the ?token= query rides the app-WS OPEN. */
  socketFactory = (url: string): WebSocket => {
    const token = new URL(url).searchParams.get('token') ?? '';
    if (!this.mux) {
      // Not yet connected: hand back a socket that closes asynchronously so
      // the connector has installed its handlers and retries. It MUST NOT emit
      // an optimistic open edge for this no-op stream.
      return new TunnelSocket(new NullStream() as unknown as MuxStream, false) as unknown as WebSocket;
    }
    const diagnostics = typeof window === 'undefined'
      ? undefined
      : (window as unknown as {
        __codorRelayAppOpens?: Array<{ session: string; generation: number }>;
      }).__codorRelayAppOpens;
    diagnostics?.push({ session: this.record.session_id, generation: this.generationValue });
    const socket = new TunnelSocket(this.mux.openStream(StreamKind.APP_WS, { token: utf8(token) }));
    socket.onDetach = () => this.liveSockets.delete(socket);
    this.liveSockets.add(socket);
    return socket as unknown as WebSocket;
  };

  /** fetch() over an HTTP tunnel stream (path+query target per §4.4). */
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (!this.mux) throw new Error('tunnel not connected');
    const url = new URL(input, 'http://relay.local');
    const target = `${url.pathname}${url.search}`;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init.headers);
    const stream = this.mux.openStream(StreamKind.HTTP);
    return new Promise<Response>((resolve, reject) => {
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      const chunks: Uint8Array[] = [];
      // Register a rejecter so a session drop (onDisconnect) fails this fetch
      // instead of leaving it pending on a mux that no longer exists.
      const abort = (error: Error): void => {
        this.pendingHttp.delete(abort);
        reject(error);
      };
      const settle = <T>(value: T, done: (value: T) => void): void => {
        this.pendingHttp.delete(abort);
        done(value);
      };
      this.pendingHttp.add(abort);
      stream.onHead = (head) => {
        const h = head as { status: number; headers: Record<string, string> };
        status = h.status;
        responseHeaders = h.headers ?? {};
      };
      stream.onData = (chunk) => {
        chunks.push(chunk);
        stream.consume(chunk.length);
      };
      stream.onEnd = () => settle(new Response(concatBytes(chunks) as unknown as BodyInit, { status, headers: responseHeaders }), resolve);
      stream.onReset = (reason) => abort(new Error(`tunnel http reset: ${reason}`));
      stream.sendHead({ method, target, headers });
      if (init.body !== undefined && init.body !== null) stream.write(bodyToBytes(init.body));
      stream.end();
    });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // onDisconnect is guarded out once disposed, so run the same teardown here:
    // reject in-flight fetches and terminate live app sockets rather than
    // stranding them, then stop the keepalive and drop the mux + ws.
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retireCurrentTransport(new Error('tunnel disposed'));
    for (const waiter of [...this.readiness]) waiter.reject(new Error('tunnel disposed'));
    this.readiness.clear();
    this.stateListeners.clear();
  }
}

/** A no-op stream for the not-yet-connected socketFactory fallback. */
class NullStream {
  onData?: (chunk: Uint8Array) => void;
  onEnd?: () => void;
  onReset?: (reason: string) => void;
  write(): void {}
  end(): void {}
  consume(): void {}
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(headers)) for (const [k, v] of headers) out[k] = v;
  else Object.assign(out, headers);
  return out;
}

function bodyToBytes(body: BodyInit): Uint8Array {
  if (typeof body === 'string') return utf8(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return utf8(String(body));
}
