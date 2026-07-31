// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { composeVoiceBody, deriveVoiceRecipientHandle } from './Composer.js';

describe('composeVoiceBody', () => {
  it('prefixes the recipient mention before the plain transcript — no marker glyphs', () => {
    expect(composeVoiceBody('opus', ['first thought', 'second thought']))
      .toBe('@opus first thought\nsecond thought');
  });

  it('newline-joins every segment', () => {
    expect(composeVoiceBody('opus', ['a', 'b', 'c'])).toBe('@opus a\nb\nc');
  });

  it('omits the mention entirely when unaddressed — never a dangling @', () => {
    expect(composeVoiceBody(undefined, ['solo'])).toBe('solo');
  });
});

describe('deriveVoiceRecipientHandle', () => {
  const roster = ['fable', 'opus', 'codex'];

  it('uses the first roster member @-mentioned in the draft', () => {
    expect(deriveVoiceRecipientHandle('hey @codex look at this', roster, 'fable')).toBe('codex');
  });

  it('is case-insensitive and skips non-roster mentions', () => {
    expect(deriveVoiceRecipientHandle('@nobody then @Opus', roster, 'fable')).toBe('opus');
  });

  it('falls back to the effective default when no roster member is mentioned', () => {
    expect(deriveVoiceRecipientHandle('just typing', roster, 'fable')).toBe('fable');
  });

  it('is unaddressed when the draft has no mention and there is no fallback', () => {
    expect(deriveVoiceRecipientHandle('nothing here', roster, undefined)).toBeUndefined();
  });
});
