/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionInitiator, SessionResponder, deviceKeyId, generateTunnelKeypair } from '@codor/tunnel';
import type { Env } from '../src/index.js';

const BASE = 'https://relay.example';
const relayEnv = env as unknown as Env;

// A distinct valid 64-lowercase-hex session id per test.
const sid = (hexChar: string) => hexChar.repeat(64);
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const beU32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
};
const readU32 = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
const framePrefixed = (conn: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + payload.length);
  out.set(beU32(conn));
  out.set(payload, 4);
  return out;
};

type WsEvent = { type: 'msg'; data: ArrayBuffer | string } | { type: 'close'; code: number; reason: string };
interface Harness {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(): void;
  next(): Promise<WsEvent>;
  nextBinary(): Promise<Uint8Array>;
  nextJson(): Promise<Record<string, unknown>>;
  nextClose(): Promise<{ code: number; reason: string }>;
}

const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
});

async function connect(sessionId: string, role: string): Promise<Harness> {
  const res = await SELF.fetch(`${BASE}/v1/session/${sessionId}/ws?role=${role}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no webSocket (status ${res.status})`);
  ws.accept();
  openSockets.push(ws);
  const queue: WsEvent[] = [];
  const waiters: ((ev: WsEvent) => void)[] = [];
  const deliver = (ev: WsEvent) => {
    const w = waiters.shift();
    if (w) w(ev);
    else queue.push(ev);
  };
  ws.addEventListener('message', (e: MessageEvent) => deliver({ type: 'msg', data: e.data as ArrayBuffer | string }));
  ws.addEventListener('close', (e: CloseEvent) => deliver({ type: 'close', code: e.code, reason: e.reason }));
  const next = () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<WsEvent>((r) => waiters.push(r)));
  return {
    send: (data) => ws.send(data as ArrayBuffer),
    close: () => ws.close(),
    next,
    nextBinary: async () => {
      const ev = await next();
      if (ev.type !== 'msg' || typeof ev.data === 'string') throw new Error(`expected binary, got ${JSON.stringify(ev)}`);
      return new Uint8Array(ev.data);
    },
    nextJson: async () => {
      const ev = await next();
      if (ev.type !== 'msg' || typeof ev.data !== 'string') throw new Error(`expected text, got ${ev.type}`);
      return JSON.parse(ev.data);
    },
    nextClose: async () => {
      const ev = await next();
      if (ev.type !== 'close') throw new Error(`expected close, got ${JSON.stringify(ev)}`);
      return { code: ev.code, reason: ev.reason };
    },
  };
}

describe('SessionRelay routing', () => {
  it('prefixes a client payload with its connId to the host and strips it back', async () => {
    const s = sid('a');
    const host = await connect(s, 'host');
    const client = await connect(s, 'client');
    const conn = (await host.nextJson()).conn as number; // client-connected
    expect(await client.nextJson()).toEqual({ type: 'host-connected' });

    client.send(new Uint8Array([1, 2, 3]));
    const framed = await host.nextBinary();
    expect(readU32(framed)).toBe(conn);
    expect([...framed.slice(4)]).toEqual([1, 2, 3]);

    host.send(framePrefixed(conn, new Uint8Array([9, 8])));
    expect([...(await client.nextBinary())]).toEqual([9, 8]);
  });

  it('multiplexes two clients to the right connections', async () => {
    const s = sid('b');
    const host = await connect(s, 'host');
    const c1 = await connect(s, 'client');
    const conn1 = (await host.nextJson()).conn as number;
    await c1.nextJson(); // host-connected
    const c2 = await connect(s, 'client');
    const conn2 = (await host.nextJson()).conn as number;
    await c2.nextJson(); // host-connected
    expect(conn1).not.toBe(conn2);

    host.send(framePrefixed(conn1, new Uint8Array([11])));
    host.send(framePrefixed(conn2, new Uint8Array([22])));
    expect([...(await c1.nextBinary())]).toEqual([11]);
    expect([...(await c2.nextBinary())]).toEqual([22]);
  });

  it('tells the host about an unknown connId', async () => {
    const s = sid('c');
    const host = await connect(s, 'host');
    host.send(framePrefixed(999, new Uint8Array([1])));
    expect(await host.nextJson()).toEqual({ type: 'unknown-conn', conn: 999 });
  });
});

describe('SessionRelay presence', () => {
  // harn:assume relay-host-generations-retire-stale-clients ref=session-relay-generation-regression
  it('retires a client that predates the host and reports presence to a fresh client', async () => {
    const s = sid('d');
    const stale = await connect(s, 'client');
    expect(await stale.nextJson()).toEqual({ type: 'host-disconnected' }); // no host yet

    const host = await connect(s, 'host');
    expect(await stale.nextClose()).toEqual({ code: 4001, reason: 'host-replaced' });

    const client = await connect(s, 'client');
    expect(await host.nextJson()).toEqual({ type: 'client-connected', conn: 2 });
    expect(await client.nextJson()).toEqual({ type: 'host-connected' });

    host.close();
    expect(await client.nextJson()).toEqual({ type: 'host-disconnected' });
  });

  it('notifies the host when a client disconnects', async () => {
    const s = sid('e');
    const host = await connect(s, 'host');
    const client = await connect(s, 'client');
    const conn = (await host.nextJson()).conn as number;
    await client.nextJson(); // host-connected
    client.close();
    expect(await host.nextJson()).toEqual({ type: 'client-disconnected', conn });
  });

  it('supersedes an old host with 4001', async () => {
    const s = sid('f');
    const first = await connect(s, 'host');
    await connect(s, 'host');
    expect(await first.nextClose()).toEqual({ code: 4001, reason: 'superseded' });
  });

  it('retires stale clients on supersede and routes only a fresh client to the new host', async () => {
    const s = sid('4');
    const hostA = await connect(s, 'host');
    const staleClient = await connect(s, 'client');
    expect((await hostA.nextJson()).conn).toBe(1); // client-connected on A
    await staleClient.nextJson(); // host-connected

    const hostB = await connect(s, 'host'); // supersedes A
    expect(await hostA.nextClose()).toEqual({ code: 4001, reason: 'superseded' });
    expect(await staleClient.nextClose()).toEqual({ code: 4001, reason: 'host-replaced' });

    const client = await connect(s, 'client');
    expect(await hostB.nextJson()).toEqual({ type: 'client-connected', conn: 2 });
    expect(await client.nextJson()).toEqual({ type: 'host-connected' });
    client.send(new Uint8Array([7]));
    const framed = await hostB.nextBinary();
    expect(readU32(framed)).toBe(2);
    expect([...framed.slice(4)]).toEqual([7]);

    client.close();
    expect(await hostB.nextJson()).toEqual({ type: 'client-disconnected', conn: 2 });
  });
  // harn:end relay-host-generations-retire-stale-clients
});

describe('SessionRelay limits & keepalive', () => {
  it('refuses the 17th client with 4004', async () => {
    const s = sid('0');
    for (let i = 0; i < 16; i++) await connect(s, 'client');
    const overflow = await connect(s, 'client');
    expect(await overflow.nextClose()).toEqual({ code: 4004, reason: 'full' });
  });

  it('assigns unique connIds backed by persisted storage', async () => {
    const s = sid('1');
    const host = await connect(s, 'host');
    await connect(s, 'client');
    expect((await host.nextJson()).conn).toBe(1);
    const stored = await runInDurableObject(relayEnv.SESSION_RELAY.get(relayEnv.SESSION_RELAY.idFromName(s)), (_i, state) =>
      state.storage.get<number>('next_conn_id'),
    );
    expect(stored).toBe(2); // persisted, survives hibernation
    await connect(s, 'client');
    expect((await host.nextJson()).conn).toBe(2);
  });

  it('auto-answers codor-ping without invoking the object', async () => {
    const s = sid('2');
    const client = await connect(s, 'client');
    await client.nextJson(); // host-disconnected
    client.send('codor-ping');
    const ev = await client.next();
    expect(ev).toEqual({ type: 'msg', data: 'codor-pong' });
  });
});

describe('real session handshake through the relay (@codor/tunnel)', () => {
  it('completes a KK handshake and interoperable channel via the mux', async () => {
    const s = sid('3');
    const sessionBytes = new Uint8Array(32).fill(0xab);
    expect(hex(sessionBytes)).not.toBe(s); // (sanity: relay path id is independent of the bound bytes)
    const clientStatic = generateTunnelKeypair();
    const hostStatic = generateTunnelKeypair();
    const kid = deviceKeyId(clientStatic.publicKey);

    const host = await connect(s, 'host');
    const client = await connect(s, 'client');
    const conn = (await host.nextJson()).conn as number;
    await client.nextJson(); // host-connected

    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: hostStatic.publicKey, sessionId: sessionBytes });
    const responder = new SessionResponder({
      hostStatic,
      sessionId: sessionBytes,
      lookupClientStatic: (k) => (hex(k) === hex(kid) ? clientStatic.publicKey : undefined),
    });

    client.send(initiator.start()); // msg1
    const m1 = await host.nextBinary();
    expect(readU32(m1)).toBe(conn);
    host.send(framePrefixed(conn, responder.receiveMsg1(m1.slice(4)))); // msg2
    const msg3 = initiator.receiveMsg2(await client.nextBinary());
    client.send(msg3);
    responder.receiveMsg3((await host.nextBinary()).slice(4));

    // Channels interoperate through the blind mux.
    client.send(initiator.channel().seal(new TextEncoder().encode('online')));
    const framed = await host.nextBinary();
    expect(new TextDecoder().decode(responder.channel().open(framed.slice(4)))).toBe('online');
    host.send(framePrefixed(conn, responder.channel().seal(new TextEncoder().encode('ack'))));
    expect(new TextDecoder().decode(initiator.channel().open(await client.nextBinary()))).toBe('ack');
  });
});
