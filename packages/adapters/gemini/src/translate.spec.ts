import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

function replay(name: string): { events: WireEvent[]; sessionId: string | undefined } {
  const translator = createTurnTranslator();
  const events = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => translator.push(line));
  events.push(...translator.end());
  for (const event of events) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return { events, sessionId: translator.sessionId() };
}

describe('Gemini stream-json translation', () => {
  it('translates the complete documented success vocabulary and token-only usage', () => {
    const replayed = replay('synthetic-success.jsonl');
    expect(replayed.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(replayed.events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'read-1',
        tool: 'read_file',
        title: 'read_file',
        input: { file_path: 'README.md' },
      },
    });
    expect(replayed.events.at(-1)).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'PONG',
      usage: { input_tokens: 12, output_tokens: 2 },
    });
  });

  it('maps a documented error result to a failed run', () => {
    expect(replay('synthetic-failure.jsonl').events.at(-1)).toEqual({
      type: 'run.completed',
      status: 'failed',
      final_text: 'Authentication required',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it('ignores malformed and unknown lines and treats unterminated EOF as interrupted', () => {
    const translator = createTurnTranslator();
    expect(translator.push('not-json')).toEqual([]);
    expect(translator.push('{"type":"future"}')).toEqual([]);
    expect(translator.end()).toEqual([{ type: 'run.completed', status: 'interrupted' }]);
  });
});
