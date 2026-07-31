// harn:assume tunnel-aead-counter-channel ref=aead-counter-channel
// XChaCha20-Poly1305 channel with deterministic per-direction counter nonces
// (PLAN §4.2 step 6, §4.3 framing). The 24-byte nonce is an unsigned
// little-endian 64-bit counter starting at 0 followed by 16 zero bytes; AAD is
// empty; exactly one message is sealed/opened per counter value. Counters only
// advance by one and never wrap — nonce reuse under a fixed key is a total AEAD
// break, so overflow throws.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export const AEAD_KEY_LENGTH = 32;
export const AEAD_NONCE_LENGTH = 24;
export const AEAD_TAG_LENGTH = 16;

const MAX_COUNTER = (1n << 64n) - 1n;

function counterNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(AEAD_NONCE_LENGTH);
  // u64 little-endian counter in the first 8 bytes; remaining 16 bytes stay 0.
  new DataView(nonce.buffer).setBigUint64(0, counter, true);
  return nonce;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== AEAD_KEY_LENGTH) {
    throw new Error(`aead key must be ${AEAD_KEY_LENGTH} bytes, got ${key.length}`);
  }
}

/** One outbound direction: seals successive plaintexts under counters 0,1,2,… */
export class AeadSender {
  private counter = 0n;

  constructor(private readonly key: Uint8Array) {
    assertKey(key);
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (this.counter > MAX_COUNTER) throw new Error('aead sender counter overflow');
    const ciphertext = xchacha20poly1305(this.key, counterNonce(this.counter)).encrypt(plaintext);
    this.counter += 1n;
    return ciphertext;
  }
}

/** One inbound direction: opens successive ciphertexts under counters 0,1,2,… */
export class AeadReceiver {
  private counter = 0n;

  constructor(private readonly key: Uint8Array) {
    assertKey(key);
  }

  open(ciphertext: Uint8Array): Uint8Array {
    if (this.counter > MAX_COUNTER) throw new Error('aead receiver counter overflow');
    // Throws on authentication failure (tampering / wrong key / reorder).
    const plaintext = xchacha20poly1305(this.key, counterNonce(this.counter)).decrypt(ciphertext);
    this.counter += 1n;
    return plaintext;
  }
}

/** A full-duplex channel: distinct send/receive keys, each an independent counter. */
export class AeadChannel {
  private readonly tx: AeadSender;
  private readonly rx: AeadReceiver;

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.tx = new AeadSender(sendKey);
    this.rx = new AeadReceiver(receiveKey);
  }

  seal(plaintext: Uint8Array): Uint8Array {
    return this.tx.seal(plaintext);
  }

  open(ciphertext: Uint8Array): Uint8Array {
    return this.rx.open(ciphertext);
  }
}
// harn:end tunnel-aead-counter-channel
