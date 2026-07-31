import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CryptoVault, normalizePairingCode } from './../crypto/pairing.js';
import type { RelaySocket } from './link.js';
import { RelayPairingHost } from './pairing-host.js';
import { RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-ph-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mockRoom() {
  const sends: (Uint8Array | string)[] = [];
  let closed = false;
  let opened = false;
  let msgCb: ((d: Uint8Array, b: boolean) => void) | undefined;
  const socket: RelaySocket = {
    // A real socket cannot send before it opens; throwing here keeps the fake
    // honest so an arm-before-open regression can't hide behind an accepted send.
    send: (data) => {
      if (!opened) throw new Error('send before open');
      sends.push(data);
    },
    close: () => (closed = true),
    onMessage: (cb) => (msgCb = cb),
    onOpen: (cb) => {
      opened = true;
      cb();
    },
    onClose: () => {},
    onError: () => {},
  };
  return {
    socket,
    sends,
    isClosed: () => closed,
    joinClaimant: () => msgCb?.(new TextEncoder().encode(JSON.stringify({ type: 'peer-joined', role: 'claim' })), false),
    answerPong: () => msgCb?.(new TextEncoder().encode('codor-pong'), false),
    sendBadMsgB: () => msgCb?.(new Uint8Array(32).fill(0xff), true), // invalid ristretto point
    binaryCount: () => sends.filter((s) => typeof s !== 'string').length,
    failCount: () => sends.filter((s) => {
      if (typeof s !== 'string' || s === 'codor-ping') return false; // skip keepalive probes
      try {
        return (JSON.parse(s) as { type?: string }).type === 'fail';
      } catch {
        return false;
      }
    }).length,
  };
}

function makeHost(room: ReturnType<typeof mockRoom>, timers: { fire: () => void }) {
  const host = new CryptoVault(join(dir, 'host'));
  const store = new RelayStore(join(dir, 'host'));
  store.enable('ws://relay.test');
  const pairingHost = new RelayPairingHost({
    store,
    pairing: host.pairing,
    identity: host.keys.publicIdentity(),
    reserveRoom: async () => ({ nameplate: 'AA' }),
    dialRoom: () => room.socket,
    setTimeoutFn: (cb) => {
      timers.fire = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {},
  });
  return { host, pairingHost };
}

describe('RelayPairingHost attempt + deadline bounds', () => {
  it('burns the pairing after three failed attempts, independent of the relay', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    await pairingHost.pair();

    // Three claimants each send an invalid MSG_B (a spec-required failed attempt).
    for (let i = 0; i < 3; i++) {
      room.joinClaimant(); // → MSG_A
      room.sendBadMsgB(); // → fail
    }
    expect(room.failCount()).toBe(3);
    expect(room.isClosed()).toBe(true); // host burned the pairing itself

    // A malicious relay's fourth synthesized join gets no new MSG_A.
    const before = room.binaryCount();
    room.joinClaimant();
    expect(room.binaryCount()).toBe(before);
    host.close();
  });

  it('closes the pairing when the 10-minute deadline fires', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    await pairingHost.pair();
    expect(room.isClosed()).toBe(false);
    timers.fire(); // deadline elapses
    expect(room.isClosed()).toBe(true);
    host.close();
  });
});

describe('RelayPairingHost keepalive (§4.1 room-socket probe)', () => {
  function keepaliveHost(room: ReturnType<typeof mockRoom>, capture: { tick: () => void }) {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('ws://relay.test');
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.socket,
      setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
      setIntervalFn: (cb) => {
        capture.tick = cb;
        return 2 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    return { host, pairingHost };
  }

  it('pings the idle room socket and closes it after two unanswered pings', async () => {
    const room = mockRoom();
    const capture = { tick: () => {} };
    const { host, pairingHost } = keepaliveHost(room, capture);
    await pairingHost.pair();
    expect(room.sends.filter((s) => s === 'codor-ping')).toHaveLength(1); // immediate probe on arming
    capture.tick();
    expect(room.sends.filter((s) => s === 'codor-ping')).toHaveLength(2);
    expect(room.isClosed()).toBe(false);
    capture.tick(); // two unanswered → shutdown
    expect(room.isClosed()).toBe(true);
    host.close();
  });

  it('keeps the room socket alive while the relay answers pings', async () => {
    const room = mockRoom();
    const capture = { tick: () => {} };
    const { host, pairingHost } = keepaliveHost(room, capture);
    await pairingHost.pair();
    for (let i = 0; i < 5; i += 1) {
      capture.tick();
      room.answerPong();
    }
    expect(room.isClosed()).toBe(false);
    host.close();
  });

  it('does not false-positive death when the room socket opens after a delay', async () => {
    // A socket whose open is deferred and which (like a real one) throws on a
    // pre-open send. Arming the keepalive in the constructor would probe before
    // open, accumulate unanswered "sends", and kill a healthy room; arming on
    // open must avoid that.
    const sends: (Uint8Array | string)[] = [];
    let opened = false;
    let closed = false;
    let openCb: (() => void) | undefined;
    let msgCb: ((d: Uint8Array, b: boolean) => void) | undefined;
    let tick: (() => void) | undefined;
    const socket: RelaySocket = {
      send: (data) => {
        if (!opened) throw new Error('send before open');
        sends.push(data);
      },
      close: () => (closed = true),
      onMessage: (cb) => (msgCb = cb),
      onOpen: (cb) => (openCb = cb),
      onClose: () => {},
      onError: () => {},
    };
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('ws://relay.test');
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => socket,
      setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
      setIntervalFn: (cb) => {
        tick = cb;
        return 2 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    await pairingHost.pair();
    expect(tick).toBeUndefined(); // not armed before open — no probes, no false death
    expect(closed).toBe(false);
    opened = true;
    openCb!(); // socket finally opens → keepalive arms with an immediate probe
    expect(tick).toBeDefined();
    for (let i = 0; i < 5; i += 1) {
      tick!();
      msgCb!(new TextEncoder().encode('codor-pong'), false); // healthy traffic
    }
    expect(closed).toBe(false);
    host.close();
  });
});

describe('RelayPairingHost universal mint (one code, both doors)', () => {
  it('pair() returns the full offer and dual-registers the room code as a local grant', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    const offer = await pairingHost.pair('http://switchboard.local:8137');

    expect(normalizePairingCode(offer.pairing_code)).toBeDefined(); // valid 8-char code
    expect(offer.pairing_code.startsWith('AA')).toBe(true); // nameplate from the reserved room
    expect(offer.pairing_token).toBeTruthy();
    expect(offer.doors).toBe('both'); // relay room reserved → dual-door
    // The CALLER's endpoint is preserved (not the relay URL), so Settings' link/QR
    // and the enrolling browser's ?endpoint= stay on the switchboard origin.
    expect(offer.endpoint).toBe('http://switchboard.local:8137');
    expect(new URL('/pair', offer.endpoint).origin).toBe('http://switchboard.local:8137');
    // The SAME code exchanges at the LOCAL door → proves dual registration.
    expect(host.pairing.exchange(offer.pairing_code).pairing_token).toBeTruthy();
    host.close();
  });

  it('degrades to a local-only code when the relay room cannot be reserved', async () => {
    const room = mockRoom();
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('ws://relay.test');
    let dialed = false;
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => {
        throw new Error('relay unreachable');
      },
      dialRoom: () => {
        dialed = true;
        return room.socket;
      },
      setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
    });

    // No throw: local pairing must never hard-depend on relay reachability.
    const offer = await pairingHost.pair('http://127.0.0.1:8137');
    expect(offer.doors).toBe('local');
    expect(dialed).toBe(false); // no relay session opened on the degrade path
    // The degraded code still opens the local door.
    expect(host.pairing.exchange(offer.pairing_code).pairing_token).toBeTruthy();
    host.close();
  });

  it('consuming the local door kills the pre-minted relay token (one shared grant)', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    const offer = await pairingHost.pair();

    // A local exchange rotates the token and clears the code, so the token the
    // relay hello would carry can no longer complete: consume one door → both die.
    host.pairing.exchange(offer.pairing_code);
    const request = { ...host.keys.publicIdentity(), kind: 'device' as const };
    expect(() => host.pairing.complete(offer.pairing_token, request)).toThrow();
    host.close();
  });
});

describe('RelayPairingHost reachability failover (P6d, Codex #1)', () => {
  const noTimer = { setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>, clearTimeoutFn: () => {} };

  it('reserves and dials through the alias when the canonical is blocked, still minting a dual-door code', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable(); // DEFAULT canonical → alias fallback available
    const room = mockRoom();
    const reserveTargets: string[] = [];
    let dialedBase: string | undefined;
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async (url: string) => {
        reserveTargets.push(url);
        if (url.includes('relay.codor.app')) throw new Error('SNI reset'); // canonical blocked here
        return { nameplate: 'AA' };
      },
      dialRoom: (url: string) => { dialedBase = url; return room.socket; },
      ...noTimer,
    });
    const offer = await pairingHost.pair('http://127.0.0.1:8137');
    expect(offer.doors).toBe('both'); // NOT degraded to local
    expect(reserveTargets[0]).toContain('relay.codor.app'); // tried the canonical first
    expect(reserveTargets[1]).toContain('workers.dev'); // failed over to the alias
    expect(dialedBase).toContain('workers.dev'); // dialed the room on the reachable member
    expect(store.dialUrl).toContain('workers.dev'); // cached the winner for next time
    host.close();
  });

  it('degrades to a local-only code when neither member reserves', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable();
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => { throw new Error('relay unreachable'); },
      dialRoom: () => mockRoom().socket,
      ...noTimer,
    });
    const offer = await pairingHost.pair('http://127.0.0.1:8137');
    expect(offer.doors).toBe('local'); // never a hard failure
    host.close();
  });
});
