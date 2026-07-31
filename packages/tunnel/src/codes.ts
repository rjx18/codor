// harn:assume tunnel-pairing-code-parity ref=pairing-code-utils
// The alphabet and helpers below are DELIBERATELY duplicated from
// packages/switchboard/src/crypto/pairing.ts (PAIRING_CODE_ALPHABET,
// normalizePairingCode, formatPairingCode, randomPairingCode). The browser
// tunnel cannot import the sodium-bound switchboard module, so parity is held
// by this copy plus the parity fixtures in codes.spec.ts. Keep both in sync.

/** 32-symbol pairing alphabet (5 bits/char); omits 0/1/I/O to avoid ambiguity. */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** chars 1-2 of the code = relay-assigned routing nameplate. */
export const NAMEPLATE_LENGTH = 2;
/** chars 3-8 of the code = host-generated secret (never transmitted). */
export const SECRET_LENGTH = 6;
/** full pairing code length in characters. */
export const CODE_LENGTH = NAMEPLATE_LENGTH + SECRET_LENGTH;

const CHAR_CLASS = `[${PAIRING_CODE_ALPHABET}]`;
// Mirrors normalizePairingCode: accept 8 bare chars or the XXXX-XXXX form.
const CODE_RE = new RegExp(`^(?:${CHAR_CLASS}{8}|${CHAR_CLASS}{4}-${CHAR_CLASS}{4})$`);

/** Uppercase, validate an 8-char (optionally XXXX-XXXX) code, and strip the dash. */
export function normalizeCode(value: string): string | undefined {
  const candidate = value.toUpperCase();
  if (!CODE_RE.test(candidate)) return undefined;
  return candidate.replace('-', '');
}

/** Format a code for display as XXXX-XXXX. Throws on invalid input. */
export function formatCode(value: string): string {
  const normalized = normalizeCode(value);
  if (!normalized) throw new Error('invalid pairing code');
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export interface SplitCode {
  /** 2-char relay routing nameplate. */
  nameplate: string;
  /** 6-char shared secret used by the pairing PAKE. */
  secret: string;
}

/** Split a code into its 2-char nameplate and 6-char secret. Throws on invalid input. */
export function splitCode(value: string): SplitCode {
  const normalized = normalizeCode(value);
  if (!normalized) throw new Error('invalid pairing code');
  return {
    nameplate: normalized.slice(0, NAMEPLATE_LENGTH),
    secret: normalized.slice(NAMEPLATE_LENGTH),
  };
}

/** Compose a nameplate + secret into a normalized 8-char code. Throws on invalid input. */
export function composeCode(nameplate: string, secret: string): string {
  const normalized = normalizeCode(`${nameplate}${secret}`);
  if (!normalized) throw new Error('invalid nameplate/secret');
  return normalized;
}

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  // Mirror pairing.ts randomPairingCode: map each byte via (byte & 31).
  return Array.from(bytes, (byte) => PAIRING_CODE_ALPHABET[byte & 31]).join('');
}

/** Generate a random 6-char secret (host side), matching pairing.ts derivation. */
export function generateSecret(): string {
  return randomChars(SECRET_LENGTH);
}

/** Generate a random 2-char nameplate. The relay assigns real nameplates; this is a helper/fallback. */
export function generateNameplate(): string {
  return randomChars(NAMEPLATE_LENGTH);
}
// harn:end tunnel-pairing-code-parity
