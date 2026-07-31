import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, MessageReassembler, MuxStream, StreamKind, StreamMux, frameMessage, openToken } from './mux.js';

/**
 * Wire two muxes back-to-back. Packets are delivered through a queue drained
 * iteratively by settle() — this models the real async WS transport (no
 * synchronous re-entrancy) while keeping assertions deterministic. flushBytes:1
 * makes every frame its own packet so ordering is easy to reason about.
 */
function pair() {
  const queue: (() => void)[] = [];
  const noTimer = { setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeoutFn: () => {}, flushBytes: 1 };
  const inbound: { host: MuxStream[]; client: MuxStream[] } = { host: [], client: [] };
  let host!: StreamMux;
  let client!: StreamMux;
  host = new StreamMux({ role: 'host', onStream: (s) => inbound.host.push(s), onPacket: (p) => queue.push(() => client.receivePacket(p)), ...noTimer });
  client = new StreamMux({ role: 'client', onStream: (s) => inbound.client.push(s), onPacket: (p) => queue.push(() => host.receivePacket(p)), ...noTimer });
  const settle = () => {
    let guard = 0;
    while (queue.length) {
      if (guard++ > 100_000) throw new Error('settle did not converge');
      queue.shift()!();
    }
  };
  return { host, client, inbound, settle };
}

/** Collect DATA on a stream, auto-returning credit as it drains. */
function drain(stream: MuxStream) {
  const state = { chunks: [] as Uint8Array[], ended: false, resets: [] as string[] };
  stream.onData = (chunk) => {
    state.chunks.push(chunk);
    stream.consume(chunk.length);
  };
  stream.onEnd = () => {
    state.ended = true;
  };
  stream.onReset = (reason) => {
    state.resets.push(reason);
  };
  return state;
}
const totalLen = (chunks: Uint8Array[]) => chunks.reduce((n, c) => n + c.length, 0);
const text = (chunks: Uint8Array[]) => new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));

describe('StreamMux basics', () => {
  it('opens a stream, carries the app-WS token, and assigns ids by role', () => {
    const { host, client, inbound, settle } = pair();
    const token = new TextEncoder().encode('sess-token');
    const s = client.openStream(StreamKind.APP_WS, { token });
    settle();
    expect(s.id).toBe(1); // client opens odd
    const hostSide = inbound.host[0];
    expect(hostSide.id).toBe(1);
    expect(hostSide.kind).toBe(StreamKind.APP_WS);
    expect(new TextDecoder().decode(openToken(hostSide)!)).toBe('sess-token');
    expect(host.openStream(StreamKind.HTTP).id).toBe(2); // host opens even
  });

  it('round-trips DATA and HTTP_HEAD', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP);
    settle();
    const hostSide = inbound.host[0];
    const got = drain(hostSide);
    const heads: unknown[] = [];
    hostSide.onHead = (h) => heads.push(h);
    s.sendHead({ method: 'GET', target: '/api/rooms' });
    s.write(new TextEncoder().encode('body'));
    settle();
    expect(heads).toEqual([{ method: 'GET', target: '/api/rooms' }]);
    expect(text(got.chunks)).toBe('body');
  });
});

describe('StreamMux flow control', () => {
  it('stalls the sender at the window and drains after WINDOW refills — both directions at once', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP); // 512 KiB window each direction
    settle();
    const hostSide = inbound.host[0];

    // Consumers that DON'T auto-return credit, so we can observe the stall.
    const clientToHost: Uint8Array[] = [];
    const hostToClient: Uint8Array[] = [];
    hostSide.onData = (c) => clientToHost.push(c);
    s.onData = (c) => hostToClient.push(c);

    const big = new Uint8Array(DEFAULT_WINDOW + 100_000).fill(7); // exceeds one window
    s.write(big); // client → host
    hostSide.write(big); // host → client, simultaneously
    settle();

    // Each sender delivered exactly one window and stalled with the remainder buffered.
    expect(totalLen(clientToHost)).toBe(DEFAULT_WINDOW);
    expect(totalLen(hostToClient)).toBe(DEFAULT_WINDOW);
    expect(s.bufferedAmount).toBe(100_000);
    expect(hostSide.bufferedAmount).toBe(100_000);

    // Drain both receivers → each returns credit → the stalled remainder flushes.
    for (const c of clientToHost.splice(0)) hostSide.consume(c.length);
    for (const c of hostToClient.splice(0)) s.consume(c.length);
    settle();

    expect(totalLen(clientToHost)).toBe(100_000);
    expect(totalLen(hostToClient)).toBe(100_000);
    expect(s.bufferedAmount).toBe(0);
    expect(hostSide.bufferedAmount).toBe(0);
  });

  it('fires onWritable when a stalled sender refills', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP);
    settle();
    const hostSide = inbound.host[0];
    hostSide.onData = () => {}; // withhold credit → stall
    let writable = 0;
    s.onWritable = () => {
      writable += 1;
    };
    s.write(new Uint8Array(DEFAULT_WINDOW + 10).fill(1));
    settle();
    expect(writable).toBe(0);
    hostSide.consume(DEFAULT_WINDOW); // refill
    settle();
    expect(writable).toBe(1);
    expect(s.bufferedAmount).toBe(0);
  });
});

describe('StreamMux lifecycle', () => {
  it('half-close (END) crosses in flight independently per direction', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP);
    settle();
    const hostSide = inbound.host[0];
    const hostGot = drain(hostSide);
    const clientGot = drain(s);

    s.write(new TextEncoder().encode('req'));
    s.end(); // client half-closes
    settle();
    expect(hostGot.ended).toBe(true);
    // Host can still reply after the client half-closed.
    hostSide.write(new TextEncoder().encode('resp'));
    hostSide.end();
    settle();
    expect(clientGot.ended).toBe(true);
    expect(text(clientGot.chunks)).toBe('resp');
  });

  it('RESET racing DATA does not misdeliver or throw', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP);
    settle();
    const hostSide = inbound.host[0];
    const hostGot = drain(hostSide);

    s.write(new TextEncoder().encode('partial'));
    s.reset('aborted'); // abort immediately after
    settle();
    expect(hostGot.resets).toEqual(['aborted']);
    // The stream is forgotten locally; writing to it now throws (not misrouted).
    expect(() => s.write(new TextEncoder().encode('late'))).toThrow();
  });

  it('interleaves multiple concurrent streams without cross-talk', () => {
    const { client, inbound, settle } = pair();
    const a = client.openStream(StreamKind.HTTP);
    const b = client.openStream(StreamKind.HTTP);
    settle();
    const aHost = drain(inbound.host[0]);
    const bHost = drain(inbound.host[1]);
    expect(inbound.host[0].id).toBe(1);
    expect(inbound.host[1].id).toBe(3);
    a.write(new TextEncoder().encode('AAA'));
    b.write(new TextEncoder().encode('BB'));
    a.write(new TextEncoder().encode('A2'));
    settle();
    expect(text(aHost.chunks)).toBe('AAAA2');
    expect(text(bHost.chunks)).toBe('BB');
  });

  it('defers END until window-stalled DATA has drained (no overtake or truncation)', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.HTTP); // 512 KiB window
    settle();
    const host = inbound.host[0];
    let received = 0;
    let ended = false;
    host.onData = (c) => {
      received += c.length;
    }; // withhold credit → stall
    host.onEnd = () => {
      ended = true;
    };

    const big = new Uint8Array(DEFAULT_WINDOW + 50_000).fill(3);
    s.write(big);
    s.end(); // requested while 50_000 bytes are still queued
    settle();
    expect(received).toBe(DEFAULT_WINDOW); // one window delivered
    expect(ended).toBe(false); // END NOT sent ahead of the queued tail

    host.consume(DEFAULT_WINDOW); // refill → tail flushes, THEN END
    settle();
    expect(received).toBe(DEFAULT_WINDOW + 50_000); // nothing truncated
    expect(ended).toBe(true); // END arrives only after all DATA
  });

  it('preserves app-WS message boundaries across DATA fragmentation (frame/reassemble)', () => {
    const reassembler = new MessageReassembler();
    const m1 = new TextEncoder().encode('{"type":"subscribe","room":"eng"}');
    const m2 = new TextEncoder().encode('x'.repeat(100_000)); // spans many DATA frames
    const wire = new Uint8Array([...frameMessage(m1), ...frameMessage(m2)]);
    const out: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i += 7) out.push(...reassembler.push(wire.subarray(i, i + 7)));
    expect(out).toHaveLength(2);
    expect(new TextDecoder().decode(out[0])).toBe('{"type":"subscribe","room":"eng"}');
    expect(out[1].length).toBe(100_000);
  });

  it('chunks a large write into frames within the max payload', () => {
    const { client, inbound, settle } = pair();
    const s = client.openStream(StreamKind.APP_WS); // 4 MiB window
    settle();
    const got = drain(inbound.host[0]);
    const payload = new Uint8Array(200_000).fill(9); // > 64 KiB frame cap
    s.write(payload);
    settle();
    expect(got.chunks.length).toBeGreaterThan(1); // split into ≤64 KiB frames
    expect(got.chunks.every((c) => c.length <= 64 * 1024)).toBe(true);
    expect(totalLen(got.chunks)).toBe(200_000);
  });
});
