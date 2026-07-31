import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { AeadChannel } from './aead.js';
import {
  PairingChannel,
  PairingProtocolError,
  decodePairingMessage,
  encodePairingMessage,
  type PairingMessage,
} from './pairing-channel.js';

// Valid base64 of 32 bytes (a real X25519 public-key length).
const KEY32_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY32_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

const HELLO: PairingMessage = {
  type: 'hello',
  switchboard: { device_id: 'abc', sign_public_key: 'abc', encryption_public_key: 'xyz' },
  session_id: 'a'.repeat(64),
  host_static_pub: KEY32_A,
  pairing_token: 'tok-123',
  relay_url: 'wss://relay.codor.app',
  protocol: 1,
};
const ENROLL: PairingMessage = {
  type: 'enroll',
  request: { device_id: 'dev', sign_public_key: 'dev', kind: 'device', label: 'phone' },
  client_static_pub: KEY32_B,
  pairing_token: 'tok-123',
};
const ENROLLED: PairingMessage = { type: 'enrolled', result: { switchboard: {}, room_keys: [] } };
const DONE: PairingMessage = { type: 'done' };

describe('pairing message codec', () => {
  it('round-trips every message type through JSON', () => {
    for (const msg of [HELLO, ENROLL, ENROLLED, DONE]) {
      expect(decodePairingMessage(encodePairingMessage(msg))).toEqual(msg);
    }
  });

  it('rejects an unknown message type', () => {
    expect(() => decodePairingMessage(utf8ToBytes(JSON.stringify({ type: 'evil' })))).toThrow(PairingProtocolError);
  });

  it('rejects a missing carrier field', () => {
    const { pairing_token, ...withoutToken } = HELLO as Record<string, unknown> & { pairing_token: string };
    void pairing_token;
    expect(() => decodePairingMessage(utf8ToBytes(JSON.stringify(withoutToken)))).toThrow(PairingProtocolError);
  });

  it('rejects a mistyped field', () => {
    expect(() => decodePairingMessage(utf8ToBytes(JSON.stringify({ ...ENROLLED, type: 'hello', protocol: '1' })))).toThrow(
      PairingProtocolError,
    );
  });

  it('rejects protocol-critical values that would break a completed pairing', () => {
    const bad = (overrides: Record<string, unknown>) =>
      () => decodePairingMessage(utf8ToBytes(JSON.stringify({ ...HELLO, ...overrides })));
    expect(bad({ protocol: 2 })).toThrow(PairingProtocolError); // unsupported version
    expect(bad({ session_id: '' })).toThrow(PairingProtocolError); // empty
    expect(bad({ session_id: 'A'.repeat(64) })).toThrow(PairingProtocolError); // uppercase hex
    expect(bad({ session_id: 'a'.repeat(63) })).toThrow(PairingProtocolError); // wrong length
    expect(bad({ host_static_pub: btoa('short') })).toThrow(PairingProtocolError); // not 32 bytes
    expect(bad({ host_static_pub: '' })).toThrow(PairingProtocolError);
    // enroll static key is validated too
    expect(() =>
      decodePairingMessage(utf8ToBytes(JSON.stringify({ ...ENROLL, client_static_pub: btoa('nope') }))),
    ).toThrow(PairingProtocolError);
  });

  it('accepts base64url-encoded 32-byte static keys', () => {
    const urlSafe = KEY32_A.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodePairingMessage(encodePairingMessage({ ...HELLO, host_static_pub: urlSafe }))).toMatchObject({
      type: 'hello',
    });
  });

  it('rejects non-JSON and non-object payloads', () => {
    expect(() => decodePairingMessage(utf8ToBytes('not json'))).toThrow(PairingProtocolError);
    expect(() => decodePairingMessage(utf8ToBytes(JSON.stringify(['array'])))).toThrow(PairingProtocolError);
    expect(() => decodePairingMessage(utf8ToBytes(JSON.stringify('string')))).toThrow(PairingProtocolError);
  });
});

describe('PairingChannel over AEAD', () => {
  it('seals and opens the full hello→enroll→enrolled→done exchange across two endpoints', () => {
    const kHost = new Uint8Array(32).fill(7); // k_h2c
    const kClient = new Uint8Array(32).fill(9); // k_c2h
    const host = new PairingChannel(new AeadChannel(kHost, kClient));
    const claimant = new PairingChannel(new AeadChannel(kClient, kHost));

    expect(claimant.open(host.seal(HELLO))).toEqual(HELLO);
    expect(host.open(claimant.seal(ENROLL))).toEqual(ENROLL);
    expect(claimant.open(host.seal(ENROLLED))).toEqual(ENROLLED);
    expect(host.open(claimant.seal(DONE))).toEqual(DONE);
  });

  it('surfaces AEAD tampering as a decode failure', () => {
    const kHost = new Uint8Array(32).fill(7);
    const kClient = new Uint8Array(32).fill(9);
    const host = new PairingChannel(new AeadChannel(kHost, kClient));
    const claimant = new PairingChannel(new AeadChannel(kClient, kHost));
    const sealed = host.seal(HELLO);
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => claimant.open(sealed)).toThrow();
  });
});
