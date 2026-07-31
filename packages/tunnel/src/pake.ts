// harn:assume tunnel-pake-cpace ref=pake-cpace
// CPace-style balanced PAKE over ristretto255 (PLAN §4.2, revised 2026-07-27).
// The 8-char pairing code (2-char nameplate + 6-char secret) proves joint
// knowledge without ever transmitting the secret. Every label and byte order
// here is normative; the browser (claimant) and switchboard (host) both run
// this exact code so they agree on a shared key over the blind relay.
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { AeadChannel } from './aead.js';

const Point = ristretto255.Point;

/** Injectable randomness source; defaults to WebCrypto (browser + Node + Workers). */
export type RandomBytes = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** u16-BE length prefix ‖ bytes (PLAN §4.2 `lv`). Shared by the PAKE and handshake transcripts. */
export function lv(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) throw new Error('lv: value exceeds 65535 bytes');
  const out = new Uint8Array(2 + bytes.length);
  new DataView(out.buffer).setUint16(0, bytes.length, false); // big-endian
  out.set(bytes, 2);
  return out;
}

const CPACE_DST = 'codor-relay/v1/cpace';
const ISK_LABEL = 'codor-relay/v1/isk';
const CONFIRM_CLAIMANT = 'confirm-claimant';
const CONFIRM_HOST = 'confirm-host';
const PAIR_H2C_INFO = 'codor-relay/v1/pair/h2c';
const PAIR_C2H_INFO = 'codor-relay/v1/pair/c2h';

const SID_LENGTH = 16;
const POINT_LENGTH = 32;
const TAG_LENGTH = 32; // HMAC-SHA256
const MSG_A_LENGTH = SID_LENGTH + POINT_LENGTH;

/** A failed PAKE attempt: malformed peer message, bad point, degenerate K, or bad confirmation. */
export class PakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PakeError';
  }
}

interface ChannelKeys {
  /** host→claimant key */
  h2c: Uint8Array;
  /** claimant→host key */
  c2h: Uint8Array;
}

/** g = hashToCurve(lv(secret) ‖ lv("nameplate:"+nameplate) ‖ lv(sid)) with the CPace DST. */
function deriveGenerator(secret: string, nameplate: string, sid: Uint8Array) {
  const message = concatBytes(
    lv(utf8ToBytes(secret)),
    lv(utf8ToBytes(`nameplate:${nameplate}`)),
    lv(sid),
  );
  return ristretto255_hasher.hashToCurve(message, { DST: CPACE_DST });
}

/** 64 uniform bytes reduced mod L into a nonzero scalar (multiply rejects 0). */
function randomScalar(randomBytes: RandomBytes): bigint {
  for (;;) {
    const scalar = Point.Fn.create(bytesToNumberLE(randomBytes(64)));
    if (scalar !== 0n) return scalar;
  }
}

/** K = peerPoint · myScalar, rejecting bad encodings and the identity element. */
function computeSharedPoint(peerPoint: Uint8Array, myScalar: bigint): Uint8Array {
  let point;
  try {
    point = Point.fromBytes(peerPoint);
  } catch {
    throw new PakeError('peer sent an invalid ristretto point');
  }
  const shared = point.multiply(myScalar);
  if (shared.is0()) throw new PakeError('shared point is the identity element');
  return shared.toBytes();
}

/** ISK = SHA-512(lv(label) ‖ lv(sid) ‖ lv(K) ‖ lv(Ya) ‖ lv(Yb))[0..32]. */
function deriveIsk(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, yb: Uint8Array): Uint8Array {
  const digest = sha512(concatBytes(lv(utf8ToBytes(ISK_LABEL)), lv(sid), lv(k), lv(ya), lv(yb)));
  return digest.slice(0, 32);
}

function deriveChannelKeys(isk: Uint8Array, sid: Uint8Array): ChannelKeys {
  return {
    h2c: hkdf(sha256, isk, sid, utf8ToBytes(PAIR_H2C_INFO), 32),
    c2h: hkdf(sha256, isk, sid, utf8ToBytes(PAIR_C2H_INFO), 32),
  };
}

function confirmTag(isk: Uint8Array, label: string): Uint8Array {
  return hmac(sha256, isk, utf8ToBytes(label));
}

/**
 * Host (switchboard) side of the PAKE. One instance handles one claimant
 * attempt; a fresh claimant gets a fresh PakeHost (new sid), which is how the
 * plan's "reset its PAKE state for a fresh claimant" is realized.
 */
export class PakeHost {
  private readonly nameplate: string;
  private readonly secret: string;
  private readonly randomBytes: RandomBytes;
  private sid?: Uint8Array;
  private ya?: bigint;
  private yaPublic?: Uint8Array;
  private isk?: Uint8Array;
  private keys?: ChannelKeys;
  private established = false;
  private cachedChannel?: AeadChannel;
  private started = false;
  private msgBReceived = false;

  constructor(params: { nameplate: string; secret: string; randomBytes?: RandomBytes }) {
    this.nameplate = params.nameplate;
    this.secret = params.secret;
    this.randomBytes = params.randomBytes ?? defaultRandomBytes;
  }

  /** Produce MSG_A = sid(16) ‖ Ya(32). Callable once — a fresh claimant needs a fresh PakeHost. */
  start(): Uint8Array {
    if (this.started) throw new PakeError('start already called');
    this.started = true;
    const sid = this.randomBytes(SID_LENGTH);
    const generator = deriveGenerator(this.secret, this.nameplate, sid);
    const ya = randomScalar(this.randomBytes);
    const yaPublic = generator.multiply(ya).toBytes();
    this.sid = sid;
    this.ya = ya;
    this.yaPublic = yaPublic;
    return concatBytes(sid, yaPublic);
  }

  /** Consume MSG_B = Yb(32); derive K, ISK, and the channel keys. */
  receiveMsgB(msgB: Uint8Array): void {
    if (this.ya === undefined || this.sid === undefined || this.yaPublic === undefined) {
      throw new PakeError('receiveMsgB called before start');
    }
    if (this.msgBReceived) throw new PakeError('receiveMsgB already called');
    this.msgBReceived = true;
    if (msgB.length !== POINT_LENGTH) throw new PakeError('MSG_B must be 32 bytes');
    const k = computeSharedPoint(msgB, this.ya);
    this.isk = deriveIsk(this.sid, k, this.yaPublic, msgB);
    this.keys = deriveChannelKeys(this.isk, this.sid);
  }

  /**
   * Verify the claimant's confirmation tag; on success return the host tag to
   * send. A thrown PakeError means a failed attempt (wrong secret / tampering).
   */
  receiveClaimantConfirmation(tagC: Uint8Array): Uint8Array {
    if (this.isk === undefined || this.keys === undefined) {
      throw new PakeError('receiveClaimantConfirmation called before receiveMsgB');
    }
    const expected = confirmTag(this.isk, CONFIRM_CLAIMANT);
    if (tagC.length !== TAG_LENGTH || !equalBytes(tagC, expected)) {
      // Failed attempt is terminal: destroy key material so the channel can never open.
      this.keys = undefined;
      this.isk = undefined;
      throw new PakeError('claimant confirmation tag mismatch');
    }
    const tagH = confirmTag(this.isk, CONFIRM_HOST);
    this.established = true;
    return tagH;
  }

  /**
   * Host channel: seals host→claimant (k_h2c), opens claimant→host (k_c2h).
   * Available only after the claimant's confirmation succeeds, and memoized so
   * the per-direction counters never restart (a second channel would reuse nonce 0).
   */
  channel(): AeadChannel {
    if (!this.established || this.keys === undefined) {
      throw new PakeError('channel requested before confirmation succeeded');
    }
    return (this.cachedChannel ??= new AeadChannel(this.keys.h2c, this.keys.c2h));
  }
}

/**
 * Claimant (browser) side of the PAKE.
 */
export class PakeClaimant {
  private readonly nameplate: string;
  private readonly secret: string;
  private readonly randomBytes: RandomBytes;
  private isk?: Uint8Array;
  private keys?: ChannelKeys;
  private established = false;
  private cachedChannel?: AeadChannel;
  private msgAReceived = false;

  constructor(params: { nameplate: string; secret: string; randomBytes?: RandomBytes }) {
    this.nameplate = params.nameplate;
    this.secret = params.secret;
    this.randomBytes = params.randomBytes ?? defaultRandomBytes;
  }

  /** Consume MSG_A; return { msgB, tagC } to send (MSG_B = Yb, then confirmation tag). Callable once. */
  receiveMsgA(msgA: Uint8Array): { msgB: Uint8Array; tagC: Uint8Array } {
    if (this.msgAReceived) throw new PakeError('receiveMsgA already called');
    this.msgAReceived = true;
    if (msgA.length !== MSG_A_LENGTH) throw new PakeError('MSG_A must be 48 bytes');
    const sid = msgA.slice(0, SID_LENGTH);
    const yaPublic = msgA.slice(SID_LENGTH);
    const generator = deriveGenerator(this.secret, this.nameplate, sid);
    const yb = randomScalar(this.randomBytes);
    const ybPublic = generator.multiply(yb).toBytes();
    const k = computeSharedPoint(yaPublic, yb);
    this.isk = deriveIsk(sid, k, yaPublic, ybPublic);
    this.keys = deriveChannelKeys(this.isk, sid);
    return { msgB: ybPublic, tagC: confirmTag(this.isk, CONFIRM_CLAIMANT) };
  }

  /** Verify the host's confirmation tag; throws on mismatch (wrong / impostor host). */
  receiveHostConfirmation(tagH: Uint8Array): void {
    if (this.isk === undefined || this.keys === undefined) {
      throw new PakeError('receiveHostConfirmation called before receiveMsgA');
    }
    const expected = confirmTag(this.isk, CONFIRM_HOST);
    if (tagH.length !== TAG_LENGTH || !equalBytes(tagH, expected)) {
      // Impostor/wrong host: destroy key material so the channel can never open.
      this.keys = undefined;
      this.isk = undefined;
      throw new PakeError('host confirmation tag mismatch');
    }
    this.established = true;
  }

  /**
   * Claimant channel: seals claimant→host (k_c2h), opens host→claimant (k_h2c).
   * Available only after the host's confirmation verifies, and memoized so the
   * per-direction counters never restart.
   */
  channel(): AeadChannel {
    if (!this.established || this.keys === undefined) {
      throw new PakeError('channel requested before confirmation succeeded');
    }
    return (this.cachedChannel ??= new AeadChannel(this.keys.c2h, this.keys.h2c));
  }
}
// harn:end tunnel-pake-cpace
