import WebSocketImpl from 'ws';

import {
  AeadChannel,
  Keepalive,
  RELAY_KEEPALIVE_INTERVAL_MS,
  MessageReassembler,
  MuxStream,
  SessionResponder,
  StreamKind,
  StreamMux,
  UnknownDeviceError,
  frameMessage,
  openToken,
} from '@codor/tunnel';

import type { RelayStore } from './store.js';

// harn:assume relay-link-lifecycle ref=relay-link
// RelayLink is the switchboard half of the tunnel (PLAN §4.1/§4.3/§4.4). When
// the relay is enabled it holds one outbound session WebSocket to the relay
// (role=host) with exponential backoff, runs one SessionResponder per client
// connId (refusing unknown/revoked devices), drives the host side of the shared
// stream mux, and bridges app-WS streams to a loopback /ws client and HTTP
// streams to a loopback fetch — so the hosted browser reaches the existing /ws
// and /api stack unchanged while the relay only ever sees ciphertext.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
// After this many consecutive sessions that open but die before proving healthy, treat
// the next reconnect as connect-class and alternate to the sibling endpoint — so a
// winner that upgrades then blackholes escapes to its working sibling.
const EARLY_DEATH_LIMIT = 2;
const HTTP_CHUNK = 64 * 1024;
const MAX_HTTP_RESPONSE = 32 * 1024 * 1024;
const HEADER_ALLOW = new Set(['content-type', 'accept', 'authorization', 'content-length']);
const isAllowedHeader = (name: string) => HEADER_ALLOW.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-codor-');

const b64ToBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const bytesToHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const utf8Decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function prefixConn(connId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, connId, false);
  out.set(payload, 4);
  return out;
}
function pickHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (isAllowedHeader(k)) out[k] = v;
  return out;
}

/** Minimal duplex socket both the `ws` client and test doubles implement. */
export interface RelaySocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  /** Force-destroy without the closing handshake — a half-open socket's graceful
   *  close() never completes, so keepalive death must not wait on it. */
  terminate?(): void;
  onMessage(cb: (data: Uint8Array, isBinary: boolean) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
  onError(cb: (error: unknown) => void): void;
}

export function dialWs(url: string): RelaySocket {
  const ws = new WebSocketImpl(url);
  ws.binaryType = 'nodebuffer';
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    onMessage: (cb) => ws.on('message', (data: Buffer, isBinary: boolean) => cb(new Uint8Array(data), isBinary)),
    onOpen: (cb) => ws.on('open', cb),
    onClose: (cb) => ws.on('close', (code: number, reason: Buffer) => cb(code, reason?.toString())),
    onError: (cb) => ws.on('error', cb),
  };
}

export interface RelayLinkDeps {
  store: RelayStore;
  /** loopback daemon HTTP/WS port (127.0.0.1:<port>). */
  loopbackPort: number;
  /** true while the device id is still an active (non-revoked) peer. */
  isDeviceActive: (deviceId: string) => boolean;
  dialSession?: (url: string) => RelaySocket;
  dialLoopback?: (url: string) => RelaySocket;
  fetchLoopback?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  /** §4.1 keepalive probe cadence on the session socket; injectable for tests. */
  keepaliveMs?: number;
  setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  /** jitter in [0,1); defaults to Math.random. */
  jitter?: () => number;
  onError?: (error: unknown) => void;
}

interface ConnState {
  connId: number;
  responder: SessionResponder;
  phase: 'msg1' | 'msg3' | 'data';
  channel?: AeadChannel;
  mux?: StreamMux;
  deviceId?: string;
  bridges: Set<{ close: () => void }>;
}

export class RelayLink {
  private readonly deps: Required<Omit<RelayLinkDeps, 'onError'>> & Pick<RelayLinkDeps, 'onError'>;
  private socket?: RelaySocket;
  private keepalive?: Keepalive;
  private conns = new Map<number, ConnState>();
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failoverNext = false;  // the next connect should try the other {canonical,alias} member
  private opened = false;        // did the current session socket reach onOpen?
  private sessionHealthy = false; // has the current session proved healthy (received activity)?
  private earlyDeaths = 0;       // consecutive sessions that opened but died before proving healthy

  constructor(deps: RelayLinkDeps) {
    this.deps = {
      dialSession: dialWs,
      dialLoopback: dialWs,
      fetchLoopback: (input, init) => fetch(input, init),
      now: Date.now,
      setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
      clearTimeoutFn: (h) => clearTimeout(h),
      keepaliveMs: RELAY_KEEPALIVE_INTERVAL_MS,
      setIntervalFn: (cb, ms) => setInterval(cb, ms),
      clearIntervalFn: (h) => clearInterval(h),
      jitter: Math.random,
      ...deps,
    };
  }

  /** Connect if the relay is enabled and has a session id. Idempotent. */
  start(): void {
    if (this.running) return;
    const { store } = this.deps;
    if (!store.enabled || !store.sessionId) return;
    this.running = true;
    this.connect();
  }

  /** Tear down the session and all connections. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer) this.deps.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.keepalive?.stop();
    this.keepalive = undefined;
    for (const conn of [...this.conns.values()]) this.teardownConn(conn);
    this.conns.clear();
    this.socket?.close(1000, 'shutdown');
    this.socket = undefined;
  }

  /** Re-read the store and reconnect (after enable/disable/rotate). */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Drop every live connection belonging to a revoked device. */
  dropDevice(deviceId: string): void {
    for (const conn of [...this.conns.values()]) {
      if (conn.deviceId === deviceId) {
        this.teardownConn(conn);
        this.conns.delete(conn.connId);
      }
    }
  }

  /** Delay schedule for the next reconnect attempt (exposed for tests). */
  backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return base + Math.floor(this.deps.jitter() * BACKOFF_BASE_MS);
  }

  private sessionUrl(base: string): string {
    const trimmed = base.replace(/\/$/, '');
    return `${trimmed}/v1/session/${this.deps.store.sessionId}/ws?role=host`;
  }

  private connect(): void {
    if (!this.running) return;
    const { store } = this.deps;
    // Dial the store's cached winner; after a connect failure alternate to the OTHER
    // member of the {canonical, alias} pair (default-URL only — a custom relay_url has
    // no fallback). Symmetric: whichever member opens becomes the cached winner, so a
    // host can find its way back to canonical after its network stops filtering.
    const base = this.failoverNext && store.dialFallback ? store.dialFallback : store.dialUrl;
    this.opened = false;
    this.sessionHealthy = false;
    let socket: RelaySocket;
    try {
      socket = this.deps.dialSession(this.sessionUrl(base));
    } catch (error) {
      this.failoverNext = store.dialFallback !== undefined ? !this.failoverNext : false;
      this.scheduleReconnect();
      this.deps.onError?.(error);
      return;
    }
    this.socket = socket;
    socket.onOpen(() => {
      this.opened = true;
      this.failoverNext = false;
      store.setDialWinner(base); // cache whichever member established the session
      this.attempt = 0;
      // Probe the idle session link so a silently half-open socket (relay or NAT
      // dropping state without a close frame) is surfaced and reconnected rather
      // than stranding every client that later tries to reach this host.
      this.keepalive?.stop();
      this.keepalive = new Keepalive({
        send: (ping) => socket.send(ping),
        // A half-open socket's graceful close() never completes, so tear down
        // immediately and idempotently rather than waiting on a close event that
        // will never arrive; terminate() (best-effort) forces the wire shut.
        onDead: () => {
          try {
            (socket.terminate ?? socket.close).call(socket);
          } catch {
            // socket already gone
          }
          this.handleSocketDown(socket);
        },
        intervalMs: this.deps.keepaliveMs,
        setIntervalFn: this.deps.setIntervalFn,
        clearIntervalFn: this.deps.clearIntervalFn,
      });
    });
    socket.onMessage((data, isBinary) => {
      // Any inbound frame proves the session is actually usable (not an open-then-
      // blackhole), so it clears the early-death escalation and re-affirms the winner.
      this.sessionHealthy = true;
      this.earlyDeaths = 0;
      this.keepalive?.noteActivity();
      this.onRelayMessage(data, isBinary);
    });
    socket.onError((error) => this.deps.onError?.(error));
    socket.onClose(() => this.handleSocketDown(socket));
  }

  /** Tear down a dead session socket and schedule a reconnect, exactly once.
   *  Called by the close event AND by keepalive death (which cannot wait on the
   *  close event of a half-open socket); the current-socket guard makes the
   *  second caller a no-op. */
  private handleSocketDown(socket: RelaySocket): void {
    if (this.socket !== socket) return;
    this.keepalive?.stop();
    this.keepalive = undefined;
    this.socket = undefined;
    for (const conn of [...this.conns.values()]) this.teardownConn(conn);
    this.conns.clear();
    // Decide whether to alternate to the other {canonical, alias} member (default-URL
    // only): a pre-open connect failure alternates at once (connect-class); a socket
    // that opened but died before proving healthy is an early death — count them, and
    // after EARLY_DEATH_LIMIT in a row escalate to the sibling (a winner that upgrades
    // then blackholes); a healthy session that drops is transient, so reset the counter
    // and reconnect to the same winner.
    if (this.deps.store.dialFallback !== undefined) {
      if (!this.opened) {
        this.failoverNext = !this.failoverNext;
      } else if (!this.sessionHealthy) {
        this.earlyDeaths += 1;
        if (this.earlyDeaths >= EARLY_DEATH_LIMIT) {
          this.failoverNext = !this.failoverNext;
          this.earlyDeaths = 0;
        }
      } else {
        this.earlyDeaths = 0;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.deps.setTimeoutFn(() => this.connect(), delay);
  }

  private onRelayMessage(data: Uint8Array, isBinary: boolean): void {
    if (!isBinary) {
      // Relay control: client-connected / client-disconnected / unknown-conn.
      try {
        const msg = JSON.parse(utf8Decode(data)) as { type?: string; conn?: number };
        if (msg.type === 'client-disconnected' && typeof msg.conn === 'number') {
          const conn = this.conns.get(msg.conn);
          if (conn) {
            this.teardownConn(conn);
            this.conns.delete(msg.conn);
          }
        }
      } catch {
        // ignore malformed control
      }
      return;
    }
    if (data.length < 4) return;
    const connId = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
    this.handleConn(connId, data.subarray(4));
  }

  private handleConn(connId: number, payload: Uint8Array): void {
    let conn = this.conns.get(connId);
    if (!conn) {
      conn = this.newConn(connId);
      this.conns.set(connId, conn);
    }
    try {
      if (conn.phase === 'msg1') {
        const msg2 = conn.responder.receiveMsg1(payload);
        this.sendToConn(connId, msg2);
        conn.phase = 'msg3';
      } else if (conn.phase === 'msg3') {
        conn.responder.receiveMsg3(payload);
        conn.channel = conn.responder.channel();
        conn.mux = new StreamMux({
          role: 'host',
          onPacket: (packet) => this.sendToConn(connId, conn!.channel!.seal(packet)),
          onStream: (stream) => this.bridgeStream(conn!, stream),
        });
        conn.phase = 'data';
      } else {
        conn.mux!.receivePacket(conn.channel!.open(payload));
      }
    } catch (error) {
      if (error instanceof UnknownDeviceError) {
        // Unknown/revoked device: ignore this connection (DoS-only capability).
        this.conns.delete(connId);
        return;
      }
      this.teardownConn(conn);
      this.conns.delete(connId);
      this.deps.onError?.(error);
    }
  }

  private newConn(connId: number): ConnState {
    const { store, isDeviceActive } = this.deps;
    const conn: ConnState = {
      connId,
      phase: 'msg1',
      bridges: new Set(),
      responder: undefined as unknown as SessionResponder,
    };
    conn.responder = new SessionResponder({
      hostStatic: store.hostStatic,
      sessionId: store.sessionIdBytes,
      lookupClientStatic: (kid) => {
        const kidHex = bytesToHex(kid);
        const device = store.listDevices().find((d) => d.kid === kidHex);
        if (!device || !isDeviceActive(device.device_id)) return undefined;
        conn.deviceId = device.device_id;
        return b64ToBytes(device.client_static_pub);
      },
    });
    return conn;
  }

  private sendToConn(connId: number, payload: Uint8Array): void {
    this.socket?.send(prefixConn(connId, payload));
  }

  private teardownConn(conn: ConnState): void {
    for (const bridge of conn.bridges) bridge.close();
    conn.bridges.clear();
    conn.mux?.close('teardown');
  }

  private bridgeStream(conn: ConnState, stream: MuxStream): void {
    if (stream.kind === StreamKind.APP_WS) this.bridgeAppWs(conn, stream);
    else this.bridgeHttp(conn, stream);
  }

  private bridgeAppWs(conn: ConnState, stream: MuxStream): void {
    const token = openToken(stream);
    const url = `ws://127.0.0.1:${this.deps.loopbackPort}/ws?token=${encodeURIComponent(utf8Decode(token ?? new Uint8Array()))}`;
    const loopback = this.deps.dialLoopback(url);
    const reassembler = new MessageReassembler();
    let open = false;
    let loopbackClosed = false;
    const pending: Uint8Array[] = [];
    const bridge = {
      close: () => {
        if (loopbackClosed) return;
        loopbackClosed = true;
        loopback.close();
      },
    };
    conn.bridges.add(bridge);

    loopback.onOpen(() => {
      open = true;
      for (const message of pending.splice(0)) loopback.send(utf8Decode(message));
    });
    // Each loopback WS message is one logical message; length-delimit it so it
    // survives the mux's window/64 KiB DATA fragmentation.
    loopback.onMessage((data) => stream.write(frameMessage(data)));
    loopback.onClose((code) => {
      loopbackClosed = true;
      conn.bridges.delete(bridge);
      // Clean close → half-close the browser's stream; abnormal (e.g. 4401 auth
      // failure) → RESET so the browser distinguishes it from a graceful end.
      if (code === undefined || code === 1000 || code === 1005) stream.end();
      else stream.reset(`loopback-close-${code}`);
    });
    loopback.onError(() => {});

    stream.onData = (chunk) => {
      for (const message of reassembler.push(chunk)) {
        if (open) loopback.send(utf8Decode(message));
        else pending.push(message);
      }
      stream.consume(chunk.length);
    };
    stream.onEnd = () => bridge.close();
    stream.onReset = () => bridge.close();
  }

  private bridgeHttp(conn: ConnState, stream: MuxStream): void {
    let head: { method: string; target: string; headers?: Record<string, string> } | undefined;
    const body: Uint8Array[] = [];
    let done = false;
    const controller = new AbortController();
    const bridge = {
      close: () => {
        controller.abort(); // abort an in-flight/never-ending loopback fetch
        conn.bridges.delete(bridge);
      },
    };
    conn.bridges.add(bridge);

    let bodyTotal = 0;
    stream.onHead = (value) => {
      head = value as typeof head;
    };
    stream.onData = (chunk) => {
      bodyTotal += chunk.length;
      // Cap the buffered request body (mirror of the response cap): an
      // authenticated browser must not be able to exhaust switchboard heap by
      // streaming an unbounded body before END (or never sending END).
      if (bodyTotal > MAX_HTTP_RESPONSE) {
        done = true;
        stream.reset('request-too-large');
        bridge.close();
        return;
      }
      body.push(chunk);
      stream.consume(chunk.length);
    };
    stream.onReset = () => {
      done = true;
      bridge.close();
    };
    stream.onEnd = () => {
      if (done || !head) return;
      done = true;
      void this.performHttp(stream, head, body, controller.signal).finally(() => conn.bridges.delete(bridge));
    };
  }

  private async performHttp(
    stream: MuxStream,
    head: { method: string; target: string; headers?: Record<string, string> },
    body: Uint8Array[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const method = head.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
      const response = await this.deps.fetchLoopback(`http://127.0.0.1:${this.deps.loopbackPort}${head.target}`, {
        method,
        headers: pickHeaders(head.headers ?? {}),
        body: hasBody ? (concat(...body) as unknown as RequestInit['body']) : undefined,
        signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (isAllowedHeader(k)) headers[k] = v;
      });
      stream.sendHead({ status: response.status, headers });
      // Stream the body incrementally, enforcing the 32 MiB cap as we read so a
      // huge response never gets fully buffered before rejection.
      const reader = response.body?.getReader();
      if (!reader) {
        stream.end();
        return;
      }
      let total = 0;
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        total += value.byteLength;
        if (total > MAX_HTTP_RESPONSE) {
          await reader.cancel();
          stream.reset('too-large');
          return;
        }
        for (let offset = 0; offset < value.length; offset += HTTP_CHUNK) {
          stream.write(value.subarray(offset, offset + HTTP_CHUNK));
        }
      }
      stream.end();
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return; // reset/teardown/over-limit
      stream.reset('loopback-error');
      this.deps.onError?.(error);
    }
  }
}
// harn:end relay-link-lifecycle
