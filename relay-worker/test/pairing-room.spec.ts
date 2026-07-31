/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { PakeClaimant, PakeHost } from '@codor/tunnel';
import type { Env } from '../src/index.js';

const BASE = 'https://relay.example';
const relayEnv = env as unknown as Env;

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

type WsEvent = { type: 'msg'; data: ArrayBuffer | string } | { type: 'close'; code: number; reason: string };

interface Harness {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(): void;
  next(): Promise<WsEvent>;
  nextBinary(): Promise<Uint8Array>;
  nextJson(): Promise<Record<string, unknown>>;
  nextClose(): Promise<{ code: number; reason: string }>;
}

/** Open a WebSocket to the worker and expose an async event reader. */
async function connect(path: string): Promise<Harness> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no webSocket in response (status ${res.status})`);
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

const roomStub = (nameplate: string) => relayEnv.PAIRING_ROOM.get(relayEnv.PAIRING_ROOM.idFromName(nameplate));
const reserve = (nameplate: string) => roomStub(nameplate).fetch('https://do/reserve', { method: 'POST' });

describe('nameplate reservation route', () => {
  it('reserves a fresh nameplate and returns it', async () => {
    const res = await SELF.fetch(`${BASE}/v1/pair/rooms`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nameplate: string };
    expect(body.nameplate).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$/);
  });
});

describe('PairingRoom /reserve', () => {
  it('is busy on a second reserve and reusable after a burn', async () => {
    const stub = roomStub('AA');
    expect((await stub.fetch('https://do/reserve', { method: 'POST' })).status).toBe(200);
    expect((await stub.fetch('https://do/reserve', { method: 'POST' })).status).toBe(409);
    await runDurableObjectAlarm(stub); // alarm → burn(expired) → storage wiped
    expect((await stub.fetch('https://do/reserve', { method: 'POST' })).status).toBe(200);
  });
});

describe('PairingRoom relaying', () => {
  it('forwards binary verbatim in both directions', async () => {
    await reserve('BA');
    const host = await connect('/v1/pair/BA/ws?role=host');
    const claim = await connect('/v1/pair/BA/ws?role=claim');
    await host.nextJson(); // peer-joined claim

    host.send(new Uint8Array([1, 2, 3, 250]));
    expect([...(await claim.nextBinary())]).toEqual([1, 2, 3, 250]);

    claim.send(new Uint8Array([9, 8, 7]));
    expect([...(await host.nextBinary())]).toEqual([9, 8, 7]);
  });

  it('tells a lone sender there is no peer', async () => {
    await reserve('BB');
    const host = await connect('/v1/pair/BB/ws?role=host');
    host.send(new Uint8Array([1]));
    expect(await host.nextJson()).toEqual({ type: 'no-peer' });
  });

  it('notifies the host when a claimant joins', async () => {
    await reserve('BC');
    const host = await connect('/v1/pair/BC/ws?role=host');
    await connect('/v1/pair/BC/ws?role=claim');
    expect(await host.nextJson()).toEqual({ type: 'peer-joined', role: 'claim' });
  });

  it('auto-answers the pairing host codor-ping without invoking the object', async () => {
    await reserve('BK');
    const host = await connect('/v1/pair/BK/ws?role=host');
    host.send('codor-ping');
    expect(await host.next()).toEqual({ type: 'msg', data: 'codor-pong' });
  });

  it('rejects a second concurrent claimant with 4002', async () => {
    await reserve('BD');
    await connect('/v1/pair/BD/ws?role=claim');
    const second = await connect('/v1/pair/BD/ws?role=claim');
    expect(await second.nextClose()).toEqual({ code: 4002, reason: 'busy' });
  });

  it('supersedes an old host with 4001', async () => {
    await reserve('BE');
    const first = await connect('/v1/pair/BE/ws?role=host');
    await connect('/v1/pair/BE/ws?role=host');
    expect(await first.nextClose()).toEqual({ code: 4001, reason: 'superseded' });
  });

  it('ignores text from a claimant', async () => {
    await reserve('BF');
    const host = await connect('/v1/pair/BF/ws?role=host');
    const claim = await connect('/v1/pair/BF/ws?role=claim');
    await host.nextJson(); // peer-joined
    claim.send('{"type":"success"}'); // must be ignored (not from host)
    host.send(new Uint8Array([42])); // still alive → relayed
    expect([...(await claim.nextBinary())]).toEqual([42]);
  });
});

describe('PairingRoom attempt / churn / burn', () => {
  it('a single host fail closes the claimant 4003 without burning the room', async () => {
    await roomStub('CA').fetch('https://do/reserve', { method: 'POST' });
    const host = await connect('/v1/pair/CA/ws?role=host');
    const claim = await connect('/v1/pair/CA/ws?role=claim');
    await host.nextJson(); // peer-joined
    host.send('{"type":"fail"}');
    expect(await claim.nextClose()).toEqual({ code: 4003, reason: 'rejected' });
    // Not burned: the room is still reserved (a burn would deleteAll → reserve 200).
    expect((await roomStub('CA').fetch('https://do/reserve', { method: 'POST' })).status).toBe(409);
    void host;
  });

  it('notifies the host with peer-left when the claimant disconnects', async () => {
    await reserve('CE');
    const host = await connect('/v1/pair/CE/ws?role=host');
    const claim = await connect('/v1/pair/CE/ws?role=claim');
    await host.nextJson(); // peer-joined claim
    claim.close(); // client-initiated disconnect
    expect(await host.nextJson()).toEqual({ type: 'peer-left', role: 'claim' });
  });

  it('burns after the third failed attempt', async () => {
    await roomStub('CB').fetch('https://do/reserve', { method: 'POST' });
    await runInDurableObject(roomStub('CB'), async (_i, state) => state.storage.put('attempts', 2));
    const host = await connect('/v1/pair/CB/ws?role=host');
    const claim = await connect('/v1/pair/CB/ws?role=claim');
    await host.nextJson(); // peer-joined
    host.send('{"type":"fail"}'); // attempts 2 → 3 → burn
    expect(await host.nextJson()).toEqual({ type: 'burned', reason: 'attempts' });
    expect((await host.nextClose()).code).toBe(4000);
    expect((await claim.nextClose()).code).toBe(4003); // claimant closed rejected before burn
  });

  it('burns after the eleventh claimant churn', async () => {
    await reserve('CC'); // reserve first (this resets churn to 0)
    await runInDurableObject(roomStub('CC'), async (_i, state) => state.storage.put('churn', 10));
    const claim = await connect('/v1/pair/CC/ws?role=claim'); // churn 10 → 11 > 10 → burn
    expect(await claim.nextJson()).toEqual({ type: 'burned', reason: 'churn' });
    expect((await claim.nextClose()).code).toBe(4000);
  });

  it('burns on the alarm and notifies the connected socket as expired', async () => {
    await roomStub('CD').fetch('https://do/reserve', { method: 'POST' });
    const host = await connect('/v1/pair/CD/ws?role=host');
    await runDurableObjectAlarm(roomStub('CD'));
    expect(await host.nextJson()).toEqual({ type: 'burned', reason: 'expired' });
    expect((await host.nextClose()).code).toBe(4000);
  });
});

describe('PairingRoom admission guards', () => {
  it('refuses a WS upgrade to an unreserved room', async () => {
    const res = await SELF.fetch(`${BASE}/v1/pair/ZZ/ws?role=host`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(409);
    expect(res.webSocket).toBeFalsy();
  });

  it('refuses a malformed nameplate at the Worker (400)', async () => {
    const res = await SELF.fetch(`${BASE}/v1/pair/01/ws?role=host`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(400); // 0 and 1 are not in the alphabet
  });

  it('frees the claimant slot once a client-initiated close completes', async () => {
    await reserve('CF');
    const host = await connect('/v1/pair/CF/ws?role=host');
    const claim1 = await connect('/v1/pair/CF/ws?role=claim');
    await host.nextJson(); // peer-joined claim1
    claim1.close();
    await claim1.nextClose(); // close handshake completes → slot frees
    const claim2 = await connect('/v1/pair/CF/ws?role=claim'); // must NOT be rejected busy
    host.send(new Uint8Array([7]));
    expect([...(await claim2.nextBinary())]).toEqual([7]); // claim2 is now the active claimant
  });
});

describe('full PAKE through the room (real @codor/tunnel)', () => {
  it('completes the PAKE and agrees on an interoperable channel end-to-end', async () => {
    await reserve('DA');
    const host = await connect('/v1/pair/DA/ws?role=host');
    const claim = await connect('/v1/pair/DA/ws?role=claim');
    await host.nextJson(); // peer-joined claim

    const pakeHost = new PakeHost({ nameplate: 'DA', secret: 'K7MNPQ' });
    const pakeClaimant = new PakeClaimant({ nameplate: 'DA', secret: 'K7MNPQ' });

    host.send(pakeHost.start()); // MSG_A
    const { msgB, tagC } = pakeClaimant.receiveMsgA(await claim.nextBinary());
    claim.send(msgB);
    claim.send(tagC);
    pakeHost.receiveMsgB(await host.nextBinary());
    const tagH = pakeHost.receiveClaimantConfirmation(await host.nextBinary());
    host.send(tagH);
    pakeClaimant.receiveHostConfirmation(await claim.nextBinary());

    // The agreed channel interoperates through the blind relay.
    host.send(pakeHost.channel().seal(new TextEncoder().encode('paired!')));
    expect(new TextDecoder().decode(pakeClaimant.channel().open(await claim.nextBinary()))).toBe('paired!');

    // Host signals success → the room burns for both.
    host.send('{"type":"success"}');
    expect(await claim.nextJson()).toEqual({ type: 'burned', reason: 'paired' });
    expect((await claim.nextClose()).code).toBe(1000);
  });
});
