import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  NAMEPLATE_LENGTH,
  PAIRING_CODE_ALPHABET,
  SECRET_LENGTH,
  composeCode,
  formatCode,
  generateNameplate,
  generateSecret,
  normalizeCode,
  splitCode,
} from './codes.js';

// Reference oracle replicated from packages/switchboard/src/crypto/pairing.ts.
// These are the exact rules tunnel codes must stay parity-locked with.
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const REF_CLASS = `[${REF_ALPHABET}]`;
const REF_RE = new RegExp(`^(?:${REF_CLASS}{8}|${REF_CLASS}{4}-${REF_CLASS}{4})$`);
function refNormalize(value: string): string | undefined {
  const candidate = value.toUpperCase();
  if (!REF_RE.test(candidate)) return undefined;
  return candidate.replace('-', '');
}
function refFormat(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

describe('pairing code alphabet parity', () => {
  it('matches the switchboard alphabet exactly', () => {
    expect(PAIRING_CODE_ALPHABET).toBe(REF_ALPHABET);
  });

  it('splits into a 2-char nameplate and 6-char secret', () => {
    expect(NAMEPLATE_LENGTH).toBe(2);
    expect(SECRET_LENGTH).toBe(6);
    expect(CODE_LENGTH).toBe(8);
  });
});

describe('normalizeCode', () => {
  it('uppercases, validates, and strips the dash', () => {
    expect(normalizeCode('7q9k-mnpq')).toBe('7Q9KMNPQ');
    expect(normalizeCode('7Q9KMNPQ')).toBe('7Q9KMNPQ');
  });

  it('rejects wrong length, bad chars, and ambiguous symbols', () => {
    expect(normalizeCode('7Q9KMNP')).toBeUndefined(); // 7 chars
    expect(normalizeCode('7Q9KMNPQR')).toBeUndefined(); // 9 chars
    expect(normalizeCode('0Q9KMNPQ')).toBeUndefined(); // 0 not in alphabet
    expect(normalizeCode('1Q9KMNPQ')).toBeUndefined(); // 1 not in alphabet
    expect(normalizeCode('IQ9KMNPQ')).toBeUndefined(); // I not in alphabet
    expect(normalizeCode('7Q-9KMNPQ')).toBeUndefined(); // dash misplaced
    expect(normalizeCode('')).toBeUndefined();
  });

  it('matches the reference oracle over random alphabet strings', () => {
    for (let i = 0; i < 500; i++) {
      const chars = Array.from({ length: 8 }, () => {
        const bytes = new Uint8Array(1);
        crypto.getRandomValues(bytes);
        return REF_ALPHABET[bytes[0] & 31];
      }).join('');
      // Test both bare and dashed presentations, plus a lowercased variant.
      for (const candidate of [chars, refFormat(chars), chars.toLowerCase()]) {
        expect(normalizeCode(candidate)).toBe(refNormalize(candidate));
      }
    }
  });
});

describe('formatCode', () => {
  it('renders XXXX-XXXX and round-trips through normalize', () => {
    const formatted = formatCode('7Q9KMNPQ');
    expect(formatted).toBe('7Q9K-MNPQ');
    expect(normalizeCode(formatted)).toBe('7Q9KMNPQ');
  });

  it('throws on invalid input', () => {
    expect(() => formatCode('nope')).toThrow();
  });
});

describe('splitCode / composeCode', () => {
  it('splits and recomposes losslessly', () => {
    const { nameplate, secret } = splitCode('7Q9KMNPQ');
    expect(nameplate).toBe('7Q');
    expect(secret).toBe('9KMNPQ');
    expect(composeCode(nameplate, secret)).toBe('7Q9KMNPQ');
  });

  it('normalizes case when composing', () => {
    expect(composeCode('7q', '9kmnpq')).toBe('7Q9KMNPQ');
  });

  it('throws on invalid pieces', () => {
    expect(() => composeCode('7', '9KMNPQ')).toThrow(); // nameplate too short
    expect(() => composeCode('7Q', '9KMNP')).toThrow(); // secret too short
  });
});

describe('generateSecret / generateNameplate', () => {
  it('produces alphabet-only strings of the right length', () => {
    for (let i = 0; i < 200; i++) {
      const secret = generateSecret();
      expect(secret).toHaveLength(SECRET_LENGTH);
      expect([...secret].every((c) => PAIRING_CODE_ALPHABET.includes(c))).toBe(true);

      const nameplate = generateNameplate();
      expect(nameplate).toHaveLength(NAMEPLATE_LENGTH);
      // A generated nameplate + secret must be a valid, splittable code.
      expect(splitCode(composeCode(nameplate, secret))).toEqual({ nameplate, secret });
    }
  });
});
