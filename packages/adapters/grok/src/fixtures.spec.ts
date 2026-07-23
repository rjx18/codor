import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

describe('native Grok streaming-json fixture', () => {
  it('translates text, thought, session id, and end events', () => {
    const translator = createTurnTranslator();
    const lines = readFileSync(new URL('../fixtures/streaming-native.jsonl', import.meta.url), 'utf8')
      .trim().split('\n');
    const events = lines.flatMap((line) => translator.push(line));

    expect(events).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'hello ' } },
      { type: 'run.item', item_type: 'reasoning_summary', payload: { text: 'checking the answer' } },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'world' } },
      { type: 'run.completed', status: 'completed', final_text: 'hello world' },
    ]);
    expect(translator.sessionId()).toBe('22222222-2222-4222-8222-222222222222');
    expect(translator.end()).toEqual([]);
  });
});
