// harn:assume tunnel-session-handshake-kk ref=session-handshake-kk
// Per-connection KK-style handshake over X25519 (PLAN §4.3). Both static keys
// authenticate; fresh ephemerals give per-connection forward secrecy. The
// client is the initiator. Every label, DH ordering, and the constant-time tag
// checks are normative — an impostor lacking a static key cannot complete it.
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { AeadChannel } from './aead.js';
import { lv, defaultRandomBytes, type RandomBytes } from './pake.js';

const KK_LABEL = 'codor-relay/v1/kk';
const CONFIRM_INFO = 'confirm';
const C2H_INFO = 'c2h';
const H2C_INFO = 'h2c';

const KID_LENGTH = 8;
const KEY_LENGTH = 32;
const TAG_LENGTH = 32; // HMAC-SHA256
const MSG1_LENGTH = KID_LENGTH + KEY_LENGTH;
const MSG2_LENGTH = KEY_LENGTH + TAG_LENGTH;

export interface TunnelKeypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** A failed handshake: malformed message or a confirmation-tag mismatch. */
export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/** Connecting device is not a known/enrolled peer (host closes the connection). */
export class UnknownDeviceError extends HandshakeError {
  constructor(message = 'unknown device key id') {
    super(message);
    this.name = 'UnknownDeviceError';
  }
}

/** Generate a dedicated static X25519 tunnel keypair (host at enable, client at pairing). */
export function generateTunnelKeypair(randomBytes: RandomBytes = defaultRandomBytes): TunnelKeypair {
  const secretKey = randomBytes(KEY_LENGTH);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** kid = SHA-256(client_static_pub)[0..8] — identifies which paired device is connecting. */
export function deviceKeyId(clientStaticPub: Uint8Array): Uint8Array {
  return sha256(clientStaticPub).slice(0, KID_LENGTH);
}

interface SessionKeys {
  confirm: Uint8Array;
  c2h: Uint8Array;
  h2c: Uint8Array;
}

/**
 * transcript = SHA-256(lv(label) ‖ lv(sessionId) ‖ lv(kid) ‖ lv(Ec) ‖ lv(Eh) ‖ lv(Sc) ‖ lv(Sh));
 * master = HKDF-Extract(salt=transcript, ikm = dh_ee ‖ dh_es ‖ dh_se ‖ dh_ss);
 * confirm/c2h/h2c = HKDF-Expand(master, info, 32).
 */
function deriveSessionKeys(params: {
  sessionId: Uint8Array;
  kid: Uint8Array;
  clientEphemeralPub: Uint8Array;
  hostEphemeralPub: Uint8Array;
  clientStaticPub: Uint8Array;
  hostStaticPub: Uint8Array;
  dhEE: Uint8Array;
  dhES: Uint8Array;
  dhSE: Uint8Array;
  dhSS: Uint8Array;
}): SessionKeys {
  const transcript = sha256(
    concatBytes(
      lv(utf8ToBytes(KK_LABEL)),
      lv(params.sessionId),
      lv(params.kid),
      lv(params.clientEphemeralPub),
      lv(params.hostEphemeralPub),
      lv(params.clientStaticPub),
      lv(params.hostStaticPub),
    ),
  );
  const master = extract(sha256, concatBytes(params.dhEE, params.dhES, params.dhSE, params.dhSS), transcript);
  return {
    confirm: expand(sha256, master, utf8ToBytes(CONFIRM_INFO), 32),
    c2h: expand(sha256, master, utf8ToBytes(C2H_INFO), 32),
    h2c: expand(sha256, master, utf8ToBytes(H2C_INFO), 32),
  };
}

/**
 * Client (initiator). Knows its own static keypair, the host's static public
 * key, and the 32-byte session id (all from pairing).
 */
export class SessionInitiator {
  private readonly clientStatic: TunnelKeypair;
  private readonly hostStaticPub: Uint8Array;
  private readonly sessionId: Uint8Array;
  private readonly randomBytes: RandomBytes;
  private ephemeralSecret?: Uint8Array;
  private ephemeralPublic?: Uint8Array;
  private keys?: SessionKeys;
  private cachedChannel?: AeadChannel;

  constructor(params: {
    clientStatic: TunnelKeypair;
    hostStaticPub: Uint8Array;
    sessionId: Uint8Array;
    randomBytes?: RandomBytes;
  }) {
    this.clientStatic = params.clientStatic;
    this.hostStaticPub = params.hostStaticPub;
    this.sessionId = params.sessionId;
    this.randomBytes = params.randomBytes ?? defaultRandomBytes;
  }

  /** msg1 = kid(8) ‖ Ec_pub(32). */
  start(): Uint8Array {
    const ephemeralSecret = this.randomBytes(KEY_LENGTH);
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    this.ephemeralSecret = ephemeralSecret;
    this.ephemeralPublic = ephemeralPublic;
    return concatBytes(deviceKeyId(this.clientStatic.publicKey), ephemeralPublic);
  }

  /** Consume msg2 = Eh_pub(32) ‖ HMAC(K_conf,"host"); return msg3 = HMAC(K_conf,"client"). */
  receiveMsg2(msg2: Uint8Array): Uint8Array {
    if (this.ephemeralSecret === undefined || this.ephemeralPublic === undefined) {
      throw new HandshakeError('receiveMsg2 called before start');
    }
    if (msg2.length !== MSG2_LENGTH) throw new HandshakeError('msg2 must be 64 bytes');
    const hostEphemeralPub = msg2.slice(0, KEY_LENGTH);
    const hostTag = msg2.slice(KEY_LENGTH);
    const keys = deriveSessionKeys({
      sessionId: this.sessionId,
      kid: deviceKeyId(this.clientStatic.publicKey),
      clientEphemeralPub: this.ephemeralPublic,
      hostEphemeralPub,
      clientStaticPub: this.clientStatic.publicKey,
      hostStaticPub: this.hostStaticPub,
      dhEE: x25519.getSharedSecret(this.ephemeralSecret, hostEphemeralPub),
      dhES: x25519.getSharedSecret(this.ephemeralSecret, this.hostStaticPub),
      dhSE: x25519.getSharedSecret(this.clientStatic.secretKey, hostEphemeralPub),
      dhSS: x25519.getSharedSecret(this.clientStatic.secretKey, this.hostStaticPub),
    });
    const expectedHostTag = hmac(sha256, keys.confirm, utf8ToBytes('host'));
    if (!equalBytes(hostTag, expectedHostTag)) {
      // Impostor host (lacks S_h): keys are never retained, so the channel stays closed.
      throw new HandshakeError('host confirmation tag mismatch');
    }
    this.keys = keys;
    return hmac(sha256, keys.confirm, utf8ToBytes('client'));
  }

  /**
   * Client channel: seals client→host (k_c2h), opens host→client (k_h2c).
   * Available only after the host is authenticated in receiveMsg2, and memoized
   * so the per-direction counters never restart.
   */
  channel(): AeadChannel {
    if (this.keys === undefined) throw new HandshakeError('channel requested before handshake completed');
    return (this.cachedChannel ??= new AeadChannel(this.keys.c2h, this.keys.h2c));
  }
}

/**
 * Host (responder). Knows its own static keypair and the 32-byte session id,
 * and resolves the connecting device's static public key from its kid.
 */
export class SessionResponder {
  private readonly hostStatic: TunnelKeypair;
  private readonly sessionId: Uint8Array;
  private readonly lookupClientStatic: (kid: Uint8Array) => Uint8Array | undefined;
  private readonly randomBytes: RandomBytes;
  private keys?: SessionKeys;
  private established = false;
  private cachedChannel?: AeadChannel;

  constructor(params: {
    hostStatic: TunnelKeypair;
    sessionId: Uint8Array;
    /** Resolve a paired device's static public key by kid; undefined = unknown/revoked. */
    lookupClientStatic: (kid: Uint8Array) => Uint8Array | undefined;
    randomBytes?: RandomBytes;
  }) {
    this.hostStatic = params.hostStatic;
    this.sessionId = params.sessionId;
    this.lookupClientStatic = params.lookupClientStatic;
    this.randomBytes = params.randomBytes ?? defaultRandomBytes;
  }

  /** Consume msg1 = kid(8) ‖ Ec_pub(32); return msg2 = Eh_pub(32) ‖ HMAC(K_conf,"host"). */
  receiveMsg1(msg1: Uint8Array): Uint8Array {
    if (msg1.length !== MSG1_LENGTH) throw new HandshakeError('msg1 must be 40 bytes');
    const kid = msg1.slice(0, KID_LENGTH);
    const clientEphemeralPub = msg1.slice(KID_LENGTH);
    const clientStaticPub = this.lookupClientStatic(kid);
    if (clientStaticPub === undefined) throw new UnknownDeviceError();

    const ephemeralSecret = this.randomBytes(KEY_LENGTH);
    const hostEphemeralPub = x25519.getPublicKey(ephemeralSecret);
    const keys = deriveSessionKeys({
      sessionId: this.sessionId,
      kid,
      clientEphemeralPub,
      hostEphemeralPub,
      clientStaticPub,
      hostStaticPub: this.hostStatic.publicKey,
      dhEE: x25519.getSharedSecret(ephemeralSecret, clientEphemeralPub),
      dhES: x25519.getSharedSecret(this.hostStatic.secretKey, clientEphemeralPub),
      dhSE: x25519.getSharedSecret(ephemeralSecret, clientStaticPub),
      dhSS: x25519.getSharedSecret(this.hostStatic.secretKey, clientStaticPub),
    });
    this.keys = keys;
    const hostTag = hmac(sha256, keys.confirm, utf8ToBytes('host'));
    return concatBytes(hostEphemeralPub, hostTag);
  }

  /** Verify msg3 = HMAC(K_conf,"client"); throws on mismatch (impostor client). */
  receiveMsg3(msg3: Uint8Array): void {
    if (this.keys === undefined) throw new HandshakeError('receiveMsg3 called before receiveMsg1');
    const expected = hmac(sha256, this.keys.confirm, utf8ToBytes('client'));
    if (msg3.length !== TAG_LENGTH || !equalBytes(msg3, expected)) {
      // Impostor client (lacks S_c): destroy keys so the channel can never open.
      this.keys = undefined;
      throw new HandshakeError('client confirmation tag mismatch');
    }
    this.established = true;
  }

  /**
   * Host channel: seals host→client (k_h2c), opens client→host (k_c2h).
   * Available only after the client's confirmation (msg3) verifies, and memoized
   * so the per-direction counters never restart.
   */
  channel(): AeadChannel {
    if (!this.established || this.keys === undefined) {
      throw new HandshakeError('channel requested before the client confirmation succeeded');
    }
    return (this.cachedChannel ??= new AeadChannel(this.keys.h2c, this.keys.c2h));
  }
}
// harn:end tunnel-session-handshake-kk
