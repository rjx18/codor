import { SessionResponder, generateTunnelKeypair, type MuxStream } from '@codor/tunnel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TunnelClient, TunnelSocket, type TunnelRecord } from './relay.js';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const clientStatic = generateTunnelKeypair();
const hostStatic = generateTunnelKeypair();
const SESSION_ID = '00'.repeat(32);
const record: TunnelRecord = {
  relay_url: 'wss://relay.test',
  session_id: SESSION_ID,
  client_static: { pub: b64(clientStatic.publicKey), priv: b64(clientStatic.secretKey) },
  host_static_pub: b64(hostStatic.publicKey),
};

/** A scriptable stand-in for the browser WebSocket the TunnelClient opens. */
class FakeWs {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: toArrayBuffer(bytes) });
  }
}

function tracker() {
  const dialed: FakeWs[] = [];
  return {
    dialed,
    socketFactory: () => {
      const ws = new FakeWs();
      dialed.push(ws);
      return ws as unknown as WebSocket;
    },
  };
}

/** Drive the KK handshake to completion so the mux is live. */
function completeHandshake(ws: FakeWs): void {
  ws.onopen?.(); // sends msg1
  const msg1 = ws.sent.shift() as Uint8Array;
  const responder = new SessionResponder({
    hostStatic,
    sessionId: new Uint8Array(32),
    lookupClientStatic: () => clientStatic.publicKey,
  });
  ws.deliver(responder.receiveMsg1(msg1)); // msg2 → handshakeDone, mux + keepalive armed
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TunnelClient resilience', () => {
  it.each(['loss', 'replacement', 'disposal'] as const)('discards queued packets on %s', async (kind) => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect(); completeHandshake(dialed[0]!);
    const old = dialed[0]!;
    const app = client.socketFactory('wss://relay.test/ws?token=t');
    const http = client.fetch('/api/rooms').catch((error: Error) => error);
    const retired = (client as unknown as { mux: { streams: Map<number, unknown>; options: { onPacket: (p: Uint8Array) => void } } }).mux;
    const before = old.sent.length;
    if (kind === 'loss') old.close();
    else if (kind === 'replacement') client.recover();
    else client.dispose();
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(old.sent).toHaveLength(before);
    expect(app.readyState).toBe(3);
    expect(await http).toBeInstanceOf(Error);
    expect(retired.streams.size).toBe(0);
    if (kind !== 'disposal') {
      vi.advanceTimersByTime(500);
      expect(dialed).toHaveLength(2);
      completeHandshake(dialed[1]!);
      expect(client.state).toBe('connected');
      const freshPackets = dialed[1]!.sent.length;
      retired.options.onPacket(new Uint8Array([1]));
      expect(dialed[1]!.sent).toHaveLength(freshPackets);
      expect(old.sent).toHaveLength(before);
    }
    client.dispose(); client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds HTTP diagnostics and excludes query text and credentials', async () => {
    const diagnostics: Array<{ target: string }> = [];
    vi.stubGlobal('window', { __codorRelayHttp: diagnostics });
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory, computerId: 'computer-A' });
    try {
      client.connect(); completeHandshake(dialed[0]!);
      for (let index = 0; index < 70; index++) {
        const controller = new AbortController();
        const pending = client.fetch('/api/search?q=private-message-text', {
          signal: controller.signal, headers: { authorization: 'Bearer private-credential' },
        });
        controller.abort();
        await pending.catch(() => undefined);
      }
      expect(diagnostics).toHaveLength(64);
      expect(diagnostics.every((entry) => entry.target === '/api/search')).toBe(true);
      expect(diagnostics[0]).toMatchObject({ computerId: 'computer-A', tunnelGeneration: 1 });
      expect(JSON.stringify(diagnostics)).not.toContain('private-');
      expect(client.hasUnsettledHttp).toBe(false);
    } finally { client.dispose(); vi.unstubAllGlobals(); }
  });
  it.each([4401, 4403])('preserves loopback close %i for the connector', async (code) => {
    const stream = { consume() {}, end() {}, onReset: undefined } as unknown as MuxStream;
    const socket = new TunnelSocket(stream);
    const lateData = stream.onData!;
    const message = vi.fn(); socket.onmessage = message;
    const close = vi.fn(); socket.onclose = close;
    await Promise.resolve();
    stream.onReset?.(`loopback-close-${code}`);
    expect(close).toHaveBeenCalledWith({ code, reason: `loopback-close-${code}` });
    lateData(new Uint8Array(4));
    expect(message).not.toHaveBeenCalled();
  });
  it('times out a stalled HTTP request and releases pending activity without replacing the tunnel', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory }); client.connect(); completeHandshake(dialed[0]!);
    const pending = client.fetch('/api/rooms');
    const failed = expect(pending).rejects.toThrow('Relay HTTP request timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(client.hasUnsettledHttp).toBe(false);
    expect(client.state).toBe('connected');
    client.dispose();
  });
  // harn:assume browser-tunnel-readiness-follows-current-generation ref=tunnel-generation-regression
  it('publishes current-generation readiness and coalesces recovery attempts', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    client.subscribe(firstListener);
    client.subscribe(secondListener);

    client.connect();
    client.connect();
    expect(dialed).toHaveLength(1);
    const firstReady = client.whenReady();
    completeHandshake(dialed[0]!);
    await expect(firstReady).resolves.toBe(1);
    expect(firstListener).toHaveBeenCalledWith('connected', 1);
    expect(secondListener).toHaveBeenCalledWith('connected', 1);

    dialed[0]!.close();
    expect(client.generation).toBe(2);
    const secondReady = client.whenReady();
    client.recover(); // accelerates the pending backoff
    client.recover();
    client.connect();
    expect(dialed).toHaveLength(2);
    completeHandshake(dialed[1]!);
    await expect(secondReady).resolves.toBe(2);
    expect(firstListener).toHaveBeenCalledWith('connected', 2);
    expect(secondListener).toHaveBeenCalledWith('connected', 2);
    client.dispose();
  });

  it('deliberate recovery replaces one connected generation and ignores its stale socket', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    expect(client.generation).toBe(1);

    client.recover();
    client.recover();
    expect(client.generation).toBe(2);
    expect(dialed).toHaveLength(2);
    dialed[0]!.deliver(new Uint8Array([1, 2, 3]));
    expect(client.state).toBe('connecting');
    completeHandshake(dialed[1]!);
    expect(client.state).toBe('connected');
    client.dispose();
  });

  it('a relay-forced stale-client close starts one fresh handshake and one replacement app socket', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    const appSockets: WebSocket[] = [];
    client.subscribe((state) => {
      if (state === 'connected') appSockets.push(client.socketFactory('wss://relay.test/ws?token=t'));
    });

    client.connect();
    completeHandshake(dialed[0]!);
    await Promise.resolve();
    expect(appSockets).toHaveLength(1);

    dialed[0]!.onclose?.({ code: 4001, reason: 'host-replaced' });
    client.recover();
    client.recover();
    expect(dialed).toHaveLength(2);
    completeHandshake(dialed[1]!);
    await Promise.resolve();

    expect(appSockets).toHaveLength(2);
    expect(appSockets[0]!.readyState).toBe(3);
    expect(appSockets[1]!.readyState).toBe(1);
    expect(client.generation).toBe(2);
    client.dispose();
  });
  // harn:end browser-tunnel-readiness-follows-current-generation

  it('never reports an app socket open before the tunnel session exists', async () => {
    const client = new TunnelClient(record);
    const socket = client.socketFactory('wss://relay.test/ws?token=t');
    let opened = false;
    let closed = false;
    socket.onopen = () => {
      opened = true;
    };
    socket.onclose = () => {
      closed = true;
    };

    await Promise.resolve();

    expect(opened).toBe(false);
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
    client.dispose();
  });

  it('abandons and reconnects when the handshake never completes (#1)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 10_000, socketFactory });
    client.connect();
    expect(dialed).toHaveLength(1);
    dialed[0]!.onopen?.(); // opens and sends msg1; the host swallows it — no msg2
    vi.advanceTimersByTime(10_000); // handshake deadline → fail → schedule reconnect
    vi.advanceTimersByTime(1_000); // reconnect backoff (starts at 500ms)
    expect(dialed.length).toBeGreaterThanOrEqual(2); // reconnected instead of stranding
    client.dispose();
  });

  it('detects a silently half-open session after handshake and reconnects (#2)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { keepaliveMs: 1_000, handshakeMs: 10_000, socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    expect(client.state).toBe('connected');
    // No pong ever answers the probes: immediate probe, one interval, then death.
    vi.advanceTimersByTime(2_000); // two intervals → onDead → fail
    vi.advanceTimersByTime(1_000); // reconnect backoff
    expect(dialed.length).toBeGreaterThanOrEqual(2);
    client.dispose();
  });

  it('closes abandoned sockets when the handshake keeps failing — no leak (#1)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 1_000, socketFactory });
    client.connect();
    // Never complete a handshake; let deadline + backoff cycle repeatedly.
    vi.advanceTimersByTime(60_000);
    expect(dialed.length).toBeGreaterThan(2); // it kept reconnecting
    // The invariant that matters: abandoned sockets don't accumulate open — at
    // most the current one is still open, every earlier one was closed by fail().
    expect(dialed.filter((ws) => !ws.closed).length).toBeLessThanOrEqual(1);
    client.dispose();
  });

  it('dispose rejects in-flight fetches and closes live app sockets (#2)', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const pending = client.fetch('/api/rooms'); // in-flight
    const appSocket = client.socketFactory('wss://relay.test/ws?token=t');
    let appClosed = false;
    appSocket.onclose = () => {
      appClosed = true;
    };
    await Promise.resolve(); // let the app socket's optimistic open settle
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(appClosed).toBe(true);
  });

  it('rejects an in-flight tunneled fetch when the session drops (#3)', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 10_000, socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const pending = client.fetch('/api/rooms'); // no response will ever arrive
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // genuinely pending on the live session
    dialed[0]!.close(); // session drops
    await expect(pending).rejects.toThrow(/session lost/);
    client.dispose();
  });

  // harn:assume app-liveness-recovery-is-stream-first ref=tunnel-http-activity-regression
  it('reports unsettled HTTP work until the request settles', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const controller = new AbortController();
    const pending = client.fetch('/api/rooms/transcript-history', { signal: controller.signal });
    expect(client.hasUnsettledHttp).toBe(true);

    controller.abort(new DOMException('cancel busy request', 'AbortError'));
    await expect(pending).rejects.toThrow(/cancel busy request/);
    expect(client.hasUnsettledHttp).toBe(false);
    client.dispose();
  });
  // harn:end app-liveness-recovery-is-stream-first

  // harn:assume hosted-bootstrap-requests-are-abortable-and-generation-bounded ref=bounded-managed-bootstrap-regression
  it('aborts one stalled HTTP stream exactly once without dropping the tunnel', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const controller = new AbortController();
    const pending = client.fetch('/api/rooms/summary', { signal: controller.signal });
    let settlements = 0;
    void pending.then(() => { settlements += 1; }, () => { settlements += 1; });

    controller.abort(new DOMException('summary deadline', 'TimeoutError'));
    await expect(pending).rejects.toThrow(/summary deadline/);
    expect(client.state).toBe('connected');
    expect(settlements).toBe(1);

    // Late transport teardown cannot settle the already-rejected request again.
    dialed[0]!.close();
    await Promise.resolve();
    expect(settlements).toBe(1);
    client.dispose();
  });
  // harn:end hosted-bootstrap-requests-are-abortable-and-generation-bounded
});

// P7: some networks kill the canonical relay host while the alias passes. The
// session dial must alternate pair members on pre-handshake failures, keep the
// member that completed a handshake, honor a pairing-time dial_url, and never
// invent a fallback for a custom relay URL.
describe('TunnelClient dial failover (P7)', () => {
  const PRIMARY = 'wss://relay.test';
  const ALIAS = 'wss://alias.test';

  function urlTracker() {
    const urls: string[] = [];
    const dialed: FakeWs[] = [];
    return {
      urls,
      dialed,
      socketFactory: (url: string) => {
        urls.push(url);
        const ws = new FakeWs();
        dialed.push(ws);
        return ws as unknown as WebSocket;
      },
    };
  }

  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {
      __CODOR_RELAY_URL: PRIMARY,
      __CODOR_RELAY_ALIAS: ALIAS,
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it('alternates to the alias after a pre-handshake failure, then keeps the working member', () => {
    const { urls, dialed, socketFactory } = urlTracker();
    const client = new TunnelClient(record, { keepaliveMs: 60_000, handshakeMs: 10_000, socketFactory });
    client.connect();
    expect(urls[0]!.startsWith(`${PRIMARY}/`)).toBe(true);
    dialed[0]!.onerror?.({}); // blocked member: dies before the handshake
    vi.advanceTimersByTime(1_000); // reconnect backoff
    expect(urls[1]!.startsWith(`${ALIAS}/`)).toBe(true);
    completeHandshake(dialed[1]!);
    expect(client.state).toBe('connected');
    // A LIVE session dropping is not a reachability verdict: the winner stays.
    dialed[1]!.close();
    vi.advanceTimersByTime(1_000);
    expect(urls[2]!.startsWith(`${ALIAS}/`)).toBe(true);
    client.dispose();
  });

  it('dials a pairing-time dial_url winner first', () => {
    const { urls, socketFactory } = urlTracker();
    const client = new TunnelClient({ ...record, dial_url: ALIAS }, { socketFactory });
    client.connect();
    expect(urls[0]!.startsWith(`${ALIAS}/`)).toBe(true);
    client.dispose();
  });

  it('never falls back from a custom relay URL', () => {
    const { urls, dialed, socketFactory } = urlTracker();
    const client = new TunnelClient({ ...record, relay_url: 'wss://my-own-relay.example' }, { socketFactory });
    client.connect();
    dialed[0]!.onerror?.({});
    vi.advanceTimersByTime(1_000);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.startsWith('wss://my-own-relay.example/'))).toBe(true);
    client.dispose();
  });
});
