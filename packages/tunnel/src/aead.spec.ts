import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { AeadChannel, AeadReceiver, AeadSender } from './aead.js';

const KEY = new Uint8Array(32).fill(0xab);

describe('AeadSender / AeadReceiver', () => {
  it('round-trips successive messages under advancing counters', () => {
    const sender = new AeadSender(KEY);
    const receiver = new AeadReceiver(KEY);
    const messages = ['one', 'two', 'three'].map((m) => utf8ToBytes(m));
    const cts = messages.map((m) => sender.seal(m));
    // Same plaintext would differ per counter; distinct messages certainly do.
    expect(new Set(cts.map(bytesToHex)).size).toBe(3);
    messages.forEach((m, i) => expect(new TextDecoder().decode(receiver.open(cts[i]))).toBe(['one', 'two', 'three'][i]));
  });

  it('produces a distinct ciphertext for the same plaintext at each counter (no nonce reuse)', () => {
    const sender = new AeadSender(KEY);
    const a = sender.seal(utf8ToBytes('codor'));
    const b = sender.seal(utf8ToBytes('codor'));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('pins the counter-nonce ciphertext bytes (golden regression)', () => {
    const sender = new AeadSender(KEY);
    expect(bytesToHex(sender.seal(utf8ToBytes('codor')))).toBe('464f18e6683689e3c8f6c6b4bdff45fe3bd4b90d61');
    expect(bytesToHex(sender.seal(utf8ToBytes('codor')))).toBe('1619a0de76922a542490c9115b6094a6852b9598ac');
  });

  it('rejects a tampered ciphertext', () => {
    const sender = new AeadSender(KEY);
    const receiver = new AeadReceiver(KEY);
    const ct = sender.seal(utf8ToBytes('secret'));
    ct[0] ^= 0x01;
    expect(() => receiver.open(ct)).toThrow();
  });

  it('rejects a replayed message (counter already consumed)', () => {
    const sender = new AeadSender(KEY);
    const receiver = new AeadReceiver(KEY);
    const ct = sender.seal(utf8ToBytes('once'));
    expect(new TextDecoder().decode(receiver.open(ct))).toBe('once');
    expect(() => receiver.open(ct)).toThrow(); // counter has advanced; nonce mismatch
  });

  it('rejects a reordered message (counter skip)', () => {
    const sender = new AeadSender(KEY);
    const receiver = new AeadReceiver(KEY);
    const c0 = sender.seal(utf8ToBytes('a'));
    const c1 = sender.seal(utf8ToBytes('b'));
    expect(() => receiver.open(c1)).toThrow(); // receiver still at counter 0
    void c0;
  });

  it('rejects a wrong-length key', () => {
    expect(() => new AeadSender(new Uint8Array(16))).toThrow();
    expect(() => new AeadReceiver(new Uint8Array(31))).toThrow();
  });
});

describe('AeadChannel', () => {
  it('is full-duplex with independent per-direction counters', () => {
    const kHost = new Uint8Array(32).fill(1);
    const kClient = new Uint8Array(32).fill(2);
    // host seals with kHost, opens with kClient; client mirrors.
    const host = new AeadChannel(kHost, kClient);
    const client = new AeadChannel(kClient, kHost);
    expect(new TextDecoder().decode(client.open(host.seal(utf8ToBytes('h2c'))))).toBe('h2c');
    expect(new TextDecoder().decode(host.open(client.seal(utf8ToBytes('c2h'))))).toBe('c2h');
  });
});
