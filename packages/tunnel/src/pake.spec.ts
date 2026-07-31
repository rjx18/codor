import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { PakeClaimant, PakeError, PakeHost } from './pake.js';

/** Returns the provided buffers in order, asserting the requested size each call. */
function fixedRandom(chunks: Uint8Array[]): (n: number) => Uint8Array {
  let i = 0;
  return (n: number) => {
    const chunk = chunks[i++];
    if (!chunk || chunk.length !== n) throw new Error(`fixedRandom exhausted/size mismatch (want ${n})`);
    return chunk;
  };
}
const fill = (value: number, length: number) => new Uint8Array(length).fill(value);

/** Drive a full host⇄claimant PAKE to completion; returns both channels. */
function runPake(opts: {
  hostSecret: string;
  claimantSecret: string;
  nameplate: string;
  hostRandom?: (n: number) => Uint8Array;
  claimantRandom?: (n: number) => Uint8Array;
}) {
  const host = new PakeHost({ nameplate: opts.nameplate, secret: opts.hostSecret, randomBytes: opts.hostRandom });
  const claimant = new PakeClaimant({ nameplate: opts.nameplate, secret: opts.claimantSecret, randomBytes: opts.claimantRandom });
  const msgA = host.start();
  const { msgB, tagC } = claimant.receiveMsgA(msgA);
  host.receiveMsgB(msgB);
  const tagH = host.receiveClaimantConfirmation(tagC);
  claimant.receiveHostConfirmation(tagH);
  return { host, claimant, msgA, msgB, tagC, tagH };
}

describe('PAKE success', () => {
  it('agrees on an interoperable channel when the secret matches', () => {
    const { host, claimant } = runPake({ hostSecret: '9KMNPQ', claimantSecret: '9KMNPQ', nameplate: '7Q' });
    const hostCh = host.channel();
    const claimantCh = claimant.channel();
    expect(new TextDecoder().decode(claimantCh.open(hostCh.seal(utf8ToBytes('h2c'))))).toBe('h2c');
    expect(new TextDecoder().decode(hostCh.open(claimantCh.seal(utf8ToBytes('c2h'))))).toBe('c2h');
  });

  it('pins the wire bytes against the revised §4.2 construction (golden regression)', () => {
    const { msgA, msgB, tagC, tagH, host } = runPake({
      hostSecret: '9KMNPQ',
      claimantSecret: '9KMNPQ',
      nameplate: '7Q',
      hostRandom: fixedRandom([fill(0x11, 16), fill(0x22, 64)]),
      claimantRandom: fixedRandom([fill(0x33, 64)]),
    });
    expect(bytesToHex(msgA)).toBe('111111111111111111111111111111113a3fbe73c023e06a81ea89f0368447644da397ba6868ddf8d4323e46ea15b351');
    expect(bytesToHex(msgB)).toBe('98c360e7ca59310c877b38d47f29ce0ca2759b2cb4b049ff81cad4b0b09b2845');
    expect(bytesToHex(tagC)).toBe('d6e7cd7e1c1241c3b2ccab71a2f624adbefdb523ec70470d8749e90df086906d');
    expect(bytesToHex(tagH)).toBe('625e11a67cd7fdc2135df4423feb6794894372beff2b218ad3523127791b1317');
    expect(bytesToHex(host.channel().seal(utf8ToBytes('ping')))).toBe('04c21b9a50af2ceed6c05e4ca51f64c1675db1b1');
  });
});

describe('PAKE generator binding (DST / message split)', () => {
  it('produces a different g (hence Ya) when only the nameplate differs — nameplate rides in the message', () => {
    // Same secret, same sid/scalar; only the nameplate changes.
    const mk = (nameplate: string) =>
      new PakeHost({ nameplate, secret: '9KMNPQ', randomBytes: fixedRandom([fill(0x11, 16), fill(0x22, 64)]) }).start();
    const a = mk('7Q');
    const b = mk('8R');
    expect(bytesToHex(a.slice(0, 16))).toBe(bytesToHex(b.slice(0, 16))); // same sid
    expect(bytesToHex(a.slice(16))).not.toBe(bytesToHex(b.slice(16))); // different Ya
  });

  it('produces a different g when only the secret differs', () => {
    const mk = (secret: string) =>
      new PakeHost({ nameplate: '7Q', secret, randomBytes: fixedRandom([fill(0x11, 16), fill(0x22, 64)]) }).start();
    expect(bytesToHex(mk('9KMNPQ').slice(16))).not.toBe(bytesToHex(mk('9KMNPR').slice(16)));
  });
});

describe('PAKE wrong secret', () => {
  it('fails host confirmation and leaks no matching key material', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: 'ZZZZZZ' });
    const msgA = host.start();
    const { msgB, tagC } = claimant.receiveMsgA(msgA);
    host.receiveMsgB(msgB);
    // Host's derived ISK differs from the claimant's, so the tag cannot match.
    expect(() => host.receiveClaimantConfirmation(tagC)).toThrow(PakeError);
  });
});

describe('PAKE point / message validation', () => {
  it('rejects an identity-element MSG_B as a failed attempt', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    host.start();
    expect(() => host.receiveMsgB(new Uint8Array(32))).toThrow(PakeError); // 32 zero bytes = ristretto identity
  });

  it('rejects an undecodable MSG_B point', () => {
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: '9KMNPQ' });
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const msgA = host.start();
    // Corrupt Ya inside MSG_A so the claimant's decode fails.
    const bad = msgA.slice();
    bad.fill(0xff, 16);
    expect(() => claimant.receiveMsgA(bad)).toThrow(PakeError);
  });

  it('rejects wrong-length messages', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    host.start();
    expect(() => host.receiveMsgB(new Uint8Array(31))).toThrow(PakeError);
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: '9KMNPQ' });
    expect(() => claimant.receiveMsgA(new Uint8Array(47))).toThrow(PakeError);
  });

  it('enforces state ordering', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    expect(() => host.receiveMsgB(new Uint8Array(32))).toThrow(PakeError); // before start
  });
});

describe('PAKE channel lifecycle (nonce-reuse / pre-confirmation guards)', () => {
  it('host channel is unavailable until the claimant confirmation succeeds', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: '9KMNPQ' });
    const { msgB } = claimant.receiveMsgA(host.start());
    host.receiveMsgB(msgB); // keys derived, but not yet confirmed
    expect(() => host.channel()).toThrow(PakeError);
  });

  it('claimant channel is unavailable until the host confirmation verifies', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: '9KMNPQ' });
    claimant.receiveMsgA(host.start());
    expect(() => claimant.channel()).toThrow(PakeError);
  });

  it('returns one memoized channel so counters never restart (no nonce reuse)', () => {
    const { host } = runPake({ hostSecret: '9KMNPQ', claimantSecret: '9KMNPQ', nameplate: '7Q' });
    expect(host.channel()).toBe(host.channel());
    const first = host.channel().seal(utf8ToBytes('x'));
    const second = host.channel().seal(utf8ToBytes('x'));
    expect(bytesToHex(first)).not.toBe(bytesToHex(second)); // counter advanced across calls
  });

  it('rejects re-driving a transition after it has run (one-shot guards)', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: '9KMNPQ' });
    const msgA = host.start();
    expect(() => host.start()).toThrow(PakeError); // no second start
    const { msgB } = claimant.receiveMsgA(msgA);
    expect(() => claimant.receiveMsgA(msgA)).toThrow(PakeError); // no second MSG_A
    host.receiveMsgB(msgB);
    expect(() => host.receiveMsgB(msgB)).toThrow(PakeError); // no second MSG_B
  });

  it('a failed claimant confirmation is terminal — the channel never opens', () => {
    const host = new PakeHost({ nameplate: '7Q', secret: '9KMNPQ' });
    const claimant = new PakeClaimant({ nameplate: '7Q', secret: 'ZZZZZZ' });
    const { msgB, tagC } = claimant.receiveMsgA(host.start());
    host.receiveMsgB(msgB);
    expect(() => host.receiveClaimantConfirmation(tagC)).toThrow(PakeError);
    expect(() => host.channel()).toThrow(PakeError);
  });
});
