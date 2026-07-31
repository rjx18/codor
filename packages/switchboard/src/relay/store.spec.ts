import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deviceKeyId } from '@codor/tunnel';

import { DEFAULT_RELAY_ALIAS, DEFAULT_RELAY_URL, RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const seq = (chunks: Uint8Array[]) => {
  let i = 0;
  return (n: number) => {
    const c = chunks[i++];
    if (!c || c.length !== n) throw new Error(`unexpected randomBytes(${n})`);
    return c;
  };
};
const fill = (v: number, n: number) => new Uint8Array(n).fill(v);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

describe('RelayStore', () => {
  it('generates session id + host static on enable and persists them 0600', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]) });
    expect(store.enabled).toBe(false);
    store.enable('wss://relay.example');
    expect(store.enabled).toBe(true);
    expect(store.relayUrl).toBe('wss://relay.example');
    expect(store.sessionId).toBe(hex(fill(0x11, 32)));
    expect(store.sessionIdBytes).toEqual(fill(0x11, 32));

    const mode = statSync(join(dir, 'crypto', 'relay.json')).mode & 0o777;
    expect(mode).toBe(0o600);

    // Reload from disk → identical material (stable across restarts).
    const reloaded = new RelayStore(dir);
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.sessionId).toBe(store.sessionId);
    expect(reloaded.hostStaticPubB64).toBe(store.hostStaticPubB64);
  });

  it('defaults to relay.codor.app and tolerates an absent file', () => {
    const store = new RelayStore(dir);
    expect(store.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(store.sessionId).toBe('');
    expect(store.listDevices()).toEqual([]);
  });

  it('rotate replaces the session id but keeps host static', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32), fill(0x33, 32)]) });
    store.enable();
    const beforePub = store.hostStaticPubB64;
    const before = store.sessionId;
    const after = store.rotate();
    expect(after).toBe(hex(fill(0x33, 32)));
    expect(after).not.toBe(before);
    expect(store.hostStaticPubB64).toBe(beforePub); // host static unchanged
  });

  it('records devices with a derived kid and looks them up', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]), now: () => 0 });
    store.enable();
    const clientPub = fill(0x41, 32);
    const rec = store.addDevice({ device_id: 'dev-1', client_static_pub: b64(clientPub), label: 'phone' });
    expect(rec.kid).toBe(hex(deviceKeyId(clientPub)));
    expect(store.clientStaticPubByKid(rec.kid)).toBe(b64(clientPub));
    expect(store.clientStaticPubByKid('deadbeefdeadbeef')).toBeUndefined();

    // Re-enrolling the same device replaces (no duplicate).
    store.addDevice({ device_id: 'dev-1', client_static_pub: b64(clientPub) });
    expect(store.listDevices().filter((d) => d.device_id === 'dev-1')).toHaveLength(1);

    store.removeDevice('dev-1');
    expect(store.clientStaticPubByKid(rec.kid)).toBeUndefined();
  });

  it('disable clears the flag without dropping material', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]) });
    store.enable();
    store.disable();
    expect(store.enabled).toBe(false);
    expect(new RelayStore(dir).sessionId).toBe(store.sessionId); // material retained
  });
});

describe('RelayStore dial winner (P6b, scoped to the default canonical)', () => {
  const enableDefault = (): RelayStore => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]) });
    store.enable(); // no URL → keeps DEFAULT_RELAY_URL
    return store;
  };

  it('defaults to the canonical URL with the alias as the fallback partner', () => {
    const store = enableDefault();
    expect(store.dialUrl).toBe(DEFAULT_RELAY_URL);
    expect(store.dialFallback).toBe(DEFAULT_RELAY_ALIAS);
  });

  it('caches an alias winner and flips the fallback, persisting across reloads', () => {
    const store = enableDefault();
    store.setDialWinner(DEFAULT_RELAY_ALIAS);
    expect(store.dialUrl).toBe(DEFAULT_RELAY_ALIAS);
    expect(store.dialFallback).toBe(DEFAULT_RELAY_URL); // symmetric: can find its way back
    const reloaded = new RelayStore(dir);
    expect(reloaded.dialUrl).toBe(DEFAULT_RELAY_ALIAS);
  });

  it('ignores a winner that is not a member of the canonical/alias pair', () => {
    const store = enableDefault();
    store.setDialWinner('https://evil.example');
    expect(store.dialUrl).toBe(DEFAULT_RELAY_URL);
  });

  it('never serves a cached winner for a custom relay_url, and never offers a fallback', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]) });
    store.enable(); // default canonical first
    store.setDialWinner(DEFAULT_RELAY_ALIAS); // stale winner cached
    store.setRelayUrl('wss://relay.mine.example'); // operator switches to a custom relay
    expect(store.dialUrl).toBe('wss://relay.mine.example'); // NOT the alias winner
    expect(store.dialFallback).toBeUndefined(); // a custom URL never falls back to our alias
    store.setDialWinner(DEFAULT_RELAY_ALIAS); // and can't be re-poisoned
    expect(store.dialUrl).toBe('wss://relay.mine.example');
    expect(new RelayStore(dir).dialUrl).toBe('wss://relay.mine.example'); // stale winner dropped on disk
  });

  it('back-compat: a record without a winner dials the configured URL', () => {
    const store = new RelayStore(dir, { randomBytes: seq([fill(0x11, 32), fill(0x22, 32)]) });
    store.enable();
    expect(store.dialUrl).toBe(DEFAULT_RELAY_URL); // absent dial_url ⇒ configured URL
  });
});
