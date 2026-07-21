import { describe, expect, it } from 'vitest';

import { TerminalKeyDecoder, type SetupKey } from './terminal-keys.js';

const ESC = '\u001B';
const types = (keys: SetupKey[]): string[] => keys.map((key) => key.type);

// harn:assume setup-terminal-input-survives-chunk-boundaries ref=setup-key-decoder-regression
describe('setup terminal key decoder', () => {
  it('decodes Enter, Space, cancel, and arrows', () => {
    expect(types(new TerminalKeyDecoder().decode(`\r ${ESC}[A${ESC}[Bq`)))
      .toEqual(['enter', 'space', 'up', 'down', 'cancel']);
    expect(types(new TerminalKeyDecoder().decode('\u0003'))).toEqual(['cancel']);
  });

  it('applies every key from a coalesced chunk in order', () => {
    expect(types(new TerminalKeyDecoder().decode(`${ESC}[B${ESC}[A \r`)))
      .toEqual(['down', 'up', 'space', 'enter']);
  });

  it('decodes one arrow split across arbitrary reads without a literal tail', () => {
    const decoder = new TerminalKeyDecoder();
    expect(decoder.decode(ESC)).toEqual([]);
    expect(decoder.decode('[')).toEqual([]);
    const keys = decoder.decode('A');
    expect(types(keys)).toEqual(['up']);
    expect(keys.some((key) => key.type === 'char')).toBe(false);
  });

  it('consumes an unknown CSI sequence instead of emitting its final byte', () => {
    expect(new TerminalKeyDecoder().decode(`${ESC}[200~`)).toEqual([]);
    expect(types(new TerminalKeyDecoder().decode(`${ESC}[1;5A`))).toEqual(['up']);
  });

  it('flushes retained Escape input exactly once as cancel', () => {
    const decoder = new TerminalKeyDecoder();
    decoder.decode(`${ESC}[`);
    expect(decoder.hasPending).toBe(true);
    expect(types(decoder.flush())).toEqual(['cancel']);
    expect(decoder.hasPending).toBe(false);
    expect(decoder.flush()).toEqual([]);
  });
});
// harn:end setup-terminal-input-survives-chunk-boundaries
