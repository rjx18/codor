import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionInitiator, generateTunnelKeypair } from '@codor/tunnel';

import { RelayLink, type RelaySocket } from './link.js';
import { DEFAULT_RELAY_ALIAS, RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-link-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const prefixConn = (connId: number, payload: Uint8Array) => {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, connId, false);
  out.set(payload, 4);
  return out;
};
const readConn = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);

function fakeSocket() {
  const sent: Uint8Array[] = [];
  const handlers: { message?: (d: Uint8Array, b: boolean) => void; open?: () => void; close?: () => void } = {};
  const socket: RelaySocket = {
    // Keepalive probes aren't handshake/mux traffic — don't record them, so the
    // existing wire assertions stay about the frames they mean to test.
    send: (data) => {
      if (data === 'codor-ping') return;
      sent.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    close: () => handlers.close?.(),
    onMessage: (cb) => (handlers.message = cb),
    onOpen: (cb) => (handlers.open = cb),
    onClose: (cb) => (handlers.close = cb),
    onError: () => {},
  };
  return { socket, sent, deliver: (d: Uint8Array) => handlers.message?.(d, true), open: () => handlers.open?.() };
}

function enabledStore() {
  const store = new RelayStore(dir);
  store.enable('ws://relay.test');
  return store;
}

describe('RelayLink backoff', () => {
  it('grows exponentially 1s→60s and caps, plus jitter', () => {
    const store = enabledStore();
    const link = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, jitter: () => 0, dialSession: () => fakeSocket().socket });
    expect(link.backoffDelay(0)).toBe(1000);
    expect(link.backoffDelay(1)).toBe(2000);
    expect(link.backoffDelay(2)).toBe(4000);
    expect(link.backoffDelay(5)).toBe(32000);
    expect(link.backoffDelay(6)).toBe(60000); // 64s capped to 60s
    expect(link.backoffDelay(20)).toBe(60000);
    const jittered = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, jitter: () => 0.5, dialSession: () => fakeSocket().socket });
    expect(jittered.backoffDelay(0)).toBe(1500); // base + 0.5*1000
  });
});

describe('RelayLink handshake admission', () => {
  it('completes the KK handshake for an active device and refuses a revoked one', () => {
    const store = enabledStore();
    const clientStatic = generateTunnelKeypair();
    store.addDevice({ device_id: 'dev-1', client_static_pub: b64(clientStatic.publicKey) });

    // --- active device: msg1 → msg2 is returned ---
    let active = true;
    const relay = fakeSocket();
    const link = new RelayLink({
      store,
      loopbackPort: 1,
      isDeviceActive: () => active,
      dialSession: () => relay.socket,
    });
    link.start();
    relay.open();

    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(5, initiator.start())); // msg1
    expect(relay.sent).toHaveLength(1);
    expect(readConn(relay.sent[0])).toBe(5);
    const msg2 = relay.sent[0].subarray(4);
    // The initiator accepts msg2 and produces msg3 → handshake is real, not a stub.
    expect(() => initiator.receiveMsg2(msg2)).not.toThrow();

    // --- revoked device: a fresh connection's msg1 yields no msg2 ---
    active = false;
    const other = new SessionInitiator({ clientStatic, hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(9, other.start()));
    expect(relay.sent.some((m) => readConn(m) === 9)).toBe(false); // refused, silent
  });

  it('refuses an unknown kid (device not in the store)', () => {
    const store = enabledStore();
    const relay = fakeSocket();
    const link = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, dialSession: () => relay.socket });
    link.start();
    relay.open();
    const stranger = new SessionInitiator({ clientStatic: generateTunnelKeypair(), hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(3, stranger.start()));
    expect(relay.sent).toHaveLength(0);
  });
});

describe('RelayLink keepalive (§4.1 half-open detection)', () => {
  // A socket whose graceful close() never fires a close event — exactly the
  // half-open case where waiting on onClose would stall forever.
  function silentSocket() {
    const sent: (Uint8Array | string)[] = [];
    const handlers: { open?: () => void; close?: () => void } = {};
    let terminated = false;
    const socket: RelaySocket = {
      send: (data) => sent.push(data),
      close: () => {}, // deliberately never fires the close event
      terminate: () => {
        terminated = true;
      },
      onMessage: () => {},
      onOpen: (cb) => (handlers.open = cb),
      onClose: (cb) => (handlers.close = cb),
      onError: () => {},
    };
    return { socket, sent, open: () => handlers.open?.(), isTerminated: () => terminated };
  }

  it('terminates and reconnects a half-open session even when close() never fires a close event', () => {
    const store = enabledStore();
    const first = silentSocket();
    const second = fakeSocket();
    const dialed = [first.socket, second.socket];
    let index = 0;
    let tick: (() => void) | undefined;
    const reconnects: (() => void)[] = [];
    const link = new RelayLink({
      store,
      loopbackPort: 1,
      isDeviceActive: () => true,
      jitter: () => 0,
      dialSession: () => dialed[index++]!,
      setIntervalFn: (cb) => {
        tick = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      setTimeoutFn: (cb) => {
        reconnects.push(cb);
        return 2 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });
    link.start();
    first.open(); // keepalive arms + immediate probe
    expect(first.sent).toEqual(['codor-ping']);
    tick!(); // second probe, still no answer
    expect(first.sent).toEqual(['codor-ping', 'codor-ping']);
    expect(reconnects).toHaveLength(0);
    tick!(); // two unanswered → dead: terminate + reconnect WITHOUT a close event
    expect(first.isTerminated()).toBe(true);
    expect(reconnects).toHaveLength(1);
    reconnects[0]!();
    expect(index).toBe(2); // dialed a fresh session socket
  });

  it('keeps the session alive while traffic arrives', () => {
    const store = enabledStore();
    const relay = fakeSocket();
    let tick: (() => void) | undefined;
    const reconnects: (() => void)[] = [];
    const link = new RelayLink({
      store,
      loopbackPort: 1,
      isDeviceActive: () => true,
      dialSession: () => relay.socket,
      setIntervalFn: (cb) => {
        tick = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      setTimeoutFn: (cb) => {
        reconnects.push(cb);
        return 2 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });
    link.start();
    relay.open();
    for (let i = 0; i < 6; i += 1) {
      tick!();
      relay.deliver(new TextEncoder().encode('codor-pong')); // a pong resets the probe
    }
    expect(reconnects).toHaveLength(0); // never declared dead
    link.stop();
  });
});

describe('RelayLink dial failover (P6b, default canonical only)', () => {
  const failoverLink = (store: RelayStore) => {
    const dialed: string[] = [];
    const socks: ReturnType<typeof fakeSocket>[] = [];
    let pending: (() => void) | undefined;
    const link = new RelayLink({
      store,
      loopbackPort: 1,
      isDeviceActive: () => true,
      jitter: () => 0,
      dialSession: (url) => {
        dialed.push(url);
        const f = fakeSocket();
        socks.push(f);
        return f.socket;
      },
      setTimeoutFn: (cb) => {
        pending = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });
    return { link, dialed, socks, fire: () => pending?.() };
  };

  it('fails over canonical→alias on a connect failure and caches the alias winner', () => {
    const store = new RelayStore(dir);
    store.enable(); // default canonical
    const { link, dialed, socks, fire } = failoverLink(store);
    link.start();
    expect(dialed[0]).toContain('relay.codor.app'); // dials the canonical winner first
    socks[0].socket.close(); // connect failure — never opened
    fire(); // the scheduled reconnect runs
    expect(dialed[1]).toContain('workers.dev'); // alternated to the alias
    socks[1].open(); // the alias establishes the session
    expect(store.dialUrl).toBe(DEFAULT_RELAY_ALIAS); // winner cached for next time
    link.stop();
  });

  it('a custom relay_url never falls back to the alias', () => {
    const store = new RelayStore(dir);
    store.enable('wss://relay.mine.example');
    const { link, dialed, socks, fire } = failoverLink(store);
    link.start();
    socks[0].socket.close();
    fire();
    expect(dialed.every((url) => url.includes('relay.mine.example'))).toBe(true);
    expect(dialed.some((url) => url.includes('workers.dev'))).toBe(false);
    link.stop();
  });

  it('escalates to the sibling after repeated early deaths (open-then-blackhole)', () => {
    const store = new RelayStore(dir);
    store.enable(); // default canonical
    const { link, dialed, socks, fire } = failoverLink(store);
    link.start();
    expect(dialed[0]).toContain('relay.codor.app'); // canonical winner first
    // First early death: opened (proxy upgrade) but no activity → does NOT alternate yet.
    socks[0].open();
    socks[0].socket.close();
    fire();
    expect(dialed[1]).toContain('relay.codor.app'); // still the winner (transient-tolerant)
    // Second consecutive early death → escalate to the sibling.
    socks[1].open();
    socks[1].socket.close();
    fire();
    expect(dialed[2]).toContain('workers.dev'); // failed over after EARLY_DEATH_LIMIT
    link.stop();
  });

  it('a healthy winner that drops reconnects to the same winner, never ping-ponging', () => {
    const store = new RelayStore(dir);
    store.enable(); // default canonical
    const { link, dialed, socks, fire } = failoverLink(store);
    link.start();
    socks[0].open();
    socks[0].deliver(new TextEncoder().encode('codor-pong')); // inbound activity → proves healthy
    socks[0].socket.close(); // a transient mid-session drop
    fire();
    expect(dialed[1]).toContain('relay.codor.app'); // stays on the winner (no alternate)
    link.stop();
  });
});
