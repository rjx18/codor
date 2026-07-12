import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { formatPairingCode, PAIRING_CODE_ALPHABET } from './crypto/pairing.js';
import { redactText, redactValue } from './redact.js';

/** Derives a live code from the real alphabet; no issued secret is recorded here. */
function derivePairingCode(): string {
  const raw = Array.from(
    randomBytes(8),
    (byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length],
  ).join('');
  return formatPairingCode(raw);
}

describe('redaction goldens', () => {
  // harn:assume pairing-codes-redacted-from-content ref=pairing-code-redaction-regression
  const cases: [string, string, string][] = [
    // Synthetic pairing credentials; no issued code is recorded in this fixture.
    ['formatted pairing code', 'pair with ABCD-EFGH now', 'pair with [redacted] now'],
    ['compact labeled pairing code', 'pairing_code=ABCDEFGH', '[redacted]'],
    [
      'AWS access key',
      'creds: AKIAIOSFODNN7EXAMPLE region us-east-1',
      'creds: [redacted] region us-east-1',
    ],
    [
      'bearer token',
      'header Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload',
      'header Authorization: [redacted]',
    ],
    [
      'github token',
      'push failed for ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      'push failed for [redacted]',
    ],
    [
      'sk- secret key',
      'set OPENAI key sk-proj-abcdef1234567890abcdef done',
      'set OPENAI key [redacted] done',
    ],
    [
      'KEY=value high entropy',
      'env has DATABASE_PASSWORD=hunter2hunter2hunter2 set',
      'env has DATABASE_PASSWORD=[redacted] set',
    ],
    ['lowercase labeled pairing code', 'code: abcd-2345', '[redacted]'],
    ['harmless text untouched', 'nothing secret here, just #12 and @codex', 'nothing secret here, just #12 and @codex'],
    ['short values survive', 'PORT=8080 and DEBUG=true', 'PORT=8080 and DEBUG=true'],
    [
      'hyphenated prose is not a pairing code',
      'the self-help guide is well-kept and hand-made',
      'the self-help guide is well-kept and hand-made',
    ],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  // A projection that rewrites the ids clients correlate runs and deliveries by is
  // corrupting served content, not redacting secrets.
  it('leaves every uuid identifier byte-identical', () => {
    const ids = Array.from({ length: 10_000 }, () => randomUUID());
    expect(ids.filter((id) => redactText(id) !== id)).toEqual([]);
  });

  it('leaves uuid identifiers embedded in served content byte-identical', () => {
    const id = randomUUID();
    const body = `run ${id} released delivery ${randomUUID()}`;
    expect(redactText(body)).toBe(body);
  });

  it('leaves every ulid-format identifier byte-identical', () => {
    const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ids = Array.from({ length: 10_000 }, () => Array.from(
      randomBytes(26),
      (byte) => crockford[byte % crockford.length],
    ).join(''));
    expect(ids.filter((id) => redactText(id) !== id)).toEqual([]);
  });

  it('still redacts a derived code in display, labeled, and compact form', () => {
    const code = derivePairingCode();
    expect(redactText(`pair with ${code} today`)).toBe('pair with [redacted] today');
    expect(redactText(`code: ${code.toLowerCase()}`)).toBe('[redacted]');
    expect(redactText(`pairing_code=${code.replace('-', '')}`)).toBe('[redacted]');
  });

  it('PEM private key blocks are removed wholesale', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nxyz\n-----END RSA PRIVATE KEY-----';
    expect(redactText(`before\n${pem}\nafter`)).toBe('before\n[redacted]\nafter');
  });

  it('an unterminated PEM block (truncated stream) is still redacted to the end', () => {
    expect(redactText('x -----BEGIN PRIVATE KEY-----\nMIIEow...')).toBe('x [redacted]');
  });

  it('redactValue walks nested payloads', () => {
    expect(
      redactValue({
        body: 'key AKIAIOSFODNN7EXAMPLE',
        nested: { list: ['token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 42, null] },
      }),
    ).toEqual({
      body: 'key [redacted]',
      nested: { list: ['token [redacted]', 42, null] },
    });
  });
  // harn:end pairing-codes-redacted-from-content
});
