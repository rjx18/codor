import { describe, expect, it } from 'vitest';

import { redactText, redactValue } from './redact.js';

describe('redaction goldens', () => {
  const cases: [string, string, string][] = [
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
    ['harmless text untouched', 'nothing secret here, just #12 and @codex', 'nothing secret here, just #12 and @codex'],
    ['short values survive', 'PORT=8080 and DEBUG=true', 'PORT=8080 and DEBUG=true'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
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
});
