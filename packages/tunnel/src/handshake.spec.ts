import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  HandshakeError,
  SessionInitiator,
  SessionResponder,
  UnknownDeviceError,
  deviceKeyId,
  generateTunnelKeypair,
  type TunnelKeypair,
} from './handshake.js';

function fixedRandom(chunks: Uint8Array[]): (n: number) => Uint8Array {
  let i = 0;
  return (n: number) => {
    const chunk = chunks[i++];
    if (!chunk || chunk.length !== n) throw new Error(`fixedRandom exhausted/size mismatch (want ${n})`);
    return chunk;
  };
}
const fill = (value: number, length: number) => new Uint8Array(length).fill(value);
const keypair = (secretByte: number): TunnelKeypair => {
  const secretKey = fill(secretByte, 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

function runHandshake(opts: {
  clientStatic: TunnelKeypair;
  hostStatic: TunnelKeypair;
  sessionId: Uint8Array;
  lookup?: (kid: Uint8Array) => Uint8Array | undefined;
  clientRandom?: (n: number) => Uint8Array;
  hostRandom?: (n: number) => Uint8Array;
}) {
  const kid = deviceKeyId(opts.clientStatic.publicKey);
  const initiator = new SessionInitiator({
    clientStatic: opts.clientStatic,
    hostStaticPub: opts.hostStatic.publicKey,
    sessionId: opts.sessionId,
    randomBytes: opts.clientRandom,
  });
  const responder = new SessionResponder({
    hostStatic: opts.hostStatic,
    sessionId: opts.sessionId,
    lookupClientStatic: opts.lookup ?? ((k) => (bytesToHex(k) === bytesToHex(kid) ? opts.clientStatic.publicKey : undefined)),
    randomBytes: opts.hostRandom,
  });
  const msg1 = initiator.start();
  const msg2 = responder.receiveMsg1(msg1);
  const msg3 = initiator.receiveMsg2(msg2);
  responder.receiveMsg3(msg3);
  return { initiator, responder, msg1, msg2, msg3 };
}

describe('session handshake success', () => {
  it('completes mutual auth and yields an interoperable channel', () => {
    const { initiator, responder } = runHandshake({
      clientStatic: keypair(0x41),
      hostStatic: keypair(0x51),
      sessionId: fill(0x81, 32),
    });
    const clientCh = initiator.channel();
    const hostCh = responder.channel();
    expect(new TextDecoder().decode(hostCh.open(clientCh.seal(utf8ToBytes('c2h'))))).toBe('c2h');
    expect(new TextDecoder().decode(clientCh.open(hostCh.seal(utf8ToBytes('h2c'))))).toBe('h2c');
  });

  it('pins the KK wire bytes (golden regression)', () => {
    const clientStatic = keypair(0x41);
    const { msg1, msg2, msg3 } = runHandshake({
      clientStatic,
      hostStatic: keypair(0x51),
      sessionId: fill(0x81, 32),
      clientRandom: fixedRandom([fill(0x61, 32)]),
      hostRandom: fixedRandom([fill(0x71, 32)]),
    });
    expect(bytesToHex(deviceKeyId(clientStatic.publicKey))).toBe('2397429a87d7d9ba');
    expect(bytesToHex(msg1)).toBe('2397429a87d7d9ba4049502db92ca2342c3f92dac5d6de7c85db5df5407a5b4996ce39f2efb7e827');
    expect(bytesToHex(msg2)).toBe('ab4f197998fcc56cc6ed68c1d931af9bb522ec00743e181f7330915df4aa317646702cda0a44cdcfc7c6179f8d7ca6130647e9cc169c256d352e60c8e33ecd23');
    expect(bytesToHex(msg3)).toBe('c37d419c2ea48e573188a735ee8a1144b126064d0778bc87f6bbe3a024b6fe38');
  });
});

describe('session handshake authentication failures', () => {
  it('rejects an unknown / revoked device key id', () => {
    const initiator = new SessionInitiator({
      clientStatic: keypair(0x41),
      hostStaticPub: keypair(0x51).publicKey,
      sessionId: fill(0x81, 32),
    });
    const responder = new SessionResponder({
      hostStatic: keypair(0x51),
      sessionId: fill(0x81, 32),
      lookupClientStatic: () => undefined, // device store has no such kid
    });
    expect(() => responder.receiveMsg1(initiator.start())).toThrow(UnknownDeviceError);
  });

  it('fails when the client trusts the wrong host static key (impostor host)', () => {
    const clientStatic = keypair(0x41);
    const realHost = keypair(0x51);
    const kid = deviceKeyId(clientStatic.publicKey);
    const initiator = new SessionInitiator({
      clientStatic,
      hostStaticPub: keypair(0x99).publicKey, // wrong host key
      sessionId: fill(0x81, 32),
    });
    const responder = new SessionResponder({
      hostStatic: realHost,
      sessionId: fill(0x81, 32),
      lookupClientStatic: (k) => (bytesToHex(k) === bytesToHex(kid) ? clientStatic.publicKey : undefined),
    });
    const msg2 = responder.receiveMsg1(initiator.start());
    expect(() => initiator.receiveMsg2(msg2)).toThrow(HandshakeError);
  });

  it('fails when the host resolves a mismatched client static key (transcript/DH binding)', () => {
    const clientStatic = keypair(0x41);
    const hostStatic = keypair(0x51);
    const kid = deviceKeyId(clientStatic.publicKey);
    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: hostStatic.publicKey, sessionId: fill(0x81, 32) });
    const responder = new SessionResponder({
      hostStatic,
      sessionId: fill(0x81, 32),
      lookupClientStatic: (k) => (bytesToHex(k) === bytesToHex(kid) ? keypair(0x42).publicKey : undefined), // wrong pub
    });
    const msg2 = responder.receiveMsg1(initiator.start());
    expect(() => initiator.receiveMsg2(msg2)).toThrow(HandshakeError);
  });

  it('rejects a tampered msg3 (impostor client cannot forge the confirmation)', () => {
    const clientStatic = keypair(0x41);
    const hostStatic = keypair(0x51);
    const kid = deviceKeyId(clientStatic.publicKey);
    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: hostStatic.publicKey, sessionId: fill(0x81, 32) });
    const responder = new SessionResponder({
      hostStatic,
      sessionId: fill(0x81, 32),
      lookupClientStatic: (k) => (bytesToHex(k) === bytesToHex(kid) ? clientStatic.publicKey : undefined),
    });
    const msg2 = responder.receiveMsg1(initiator.start());
    const msg3 = initiator.receiveMsg2(msg2);
    msg3[0] ^= 0x01;
    expect(() => responder.receiveMsg3(msg3)).toThrow(HandshakeError);
  });

  it('fails when the two sides bind different session ids', () => {
    const clientStatic = keypair(0x41);
    const hostStatic = keypair(0x51);
    const kid = deviceKeyId(clientStatic.publicKey);
    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: hostStatic.publicKey, sessionId: fill(0x81, 32) });
    const responder = new SessionResponder({
      hostStatic,
      sessionId: fill(0x82, 32), // different session id
      lookupClientStatic: (k) => (bytesToHex(k) === bytesToHex(kid) ? clientStatic.publicKey : undefined),
    });
    const msg2 = responder.receiveMsg1(initiator.start());
    expect(() => initiator.receiveMsg2(msg2)).toThrow(HandshakeError);
  });
});

describe('session channel lifecycle (nonce-reuse / pre-confirmation guards)', () => {
  const setup = () => {
    const clientStatic = keypair(0x41);
    const hostStatic = keypair(0x51);
    const kid = deviceKeyId(clientStatic.publicKey);
    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: hostStatic.publicKey, sessionId: fill(0x81, 32) });
    const responder = new SessionResponder({
      hostStatic,
      sessionId: fill(0x81, 32),
      lookupClientStatic: (k) => (bytesToHex(k) === bytesToHex(kid) ? clientStatic.publicKey : undefined),
    });
    return { initiator, responder };
  };

  it('host channel is unavailable until the client confirmation (msg3) verifies', () => {
    const { initiator, responder } = setup();
    const msg2 = responder.receiveMsg1(initiator.start());
    expect(() => responder.channel()).toThrow(HandshakeError); // keys derived, client not yet proven
    initiator.receiveMsg2(msg2); // msg3 produced but not delivered to the responder
    expect(() => responder.channel()).toThrow(HandshakeError);
  });

  it('returns one memoized channel per side so counters never restart', () => {
    const { initiator, responder } = runHandshake({ clientStatic: keypair(0x41), hostStatic: keypair(0x51), sessionId: fill(0x81, 32) });
    expect(responder.channel()).toBe(responder.channel());
    expect(initiator.channel()).toBe(initiator.channel());
    const a = responder.channel().seal(utf8ToBytes('x'));
    const b = responder.channel().seal(utf8ToBytes('x'));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('a failed msg3 is terminal — the host channel never opens', () => {
    const { initiator, responder } = setup();
    const msg2 = responder.receiveMsg1(initiator.start());
    const msg3 = initiator.receiveMsg2(msg2);
    msg3[0] ^= 0x01;
    expect(() => responder.receiveMsg3(msg3)).toThrow(HandshakeError);
    expect(() => responder.channel()).toThrow(HandshakeError);
  });
});

describe('generateTunnelKeypair', () => {
  it('derives the public key from the secret via X25519', () => {
    const kp = generateTunnelKeypair(fixedRandom([fill(0x41, 32)]));
    expect(bytesToHex(kp.publicKey)).toBe(bytesToHex(x25519.getPublicKey(fill(0x41, 32))));
  });

  it('produces per-connection-distinct ephemerals under real randomness', () => {
    expect(bytesToHex(generateTunnelKeypair().publicKey)).not.toBe(bytesToHex(generateTunnelKeypair().publicKey));
  });
});
