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

function textDeltas(events: WireEvent[]): string[] {
  return events
    .filter((event): event is Extract<WireEvent, { type: 'run.item' }> =>
      event.type === 'run.item' && event.item_type === 'text_delta')
    .map((event) => (event.payload as { text: string }).text);
}

describe('cursor stream-json translation', () => {
  it('translates the documented success vocabulary and token-only usage', () => {
    const replayed = replay('synthetic-success.jsonl');
    expect(replayed.sessionId).toBe('11111111-1111-4111-8111-111111111111');

    // Streaming deltas only — the trailing cumulative assistant echo is skipped.
    expect(textDeltas(replayed.events)).toEqual(['PO', 'NG']);

    expect(replayed.events).toContainEqual({
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: { text: 'Reading the file.' },
    });

    expect(replayed.events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'read-1',
        tool: 'read',
        title: 'README.md',
        detail: 'README.md',
        input: { path: 'README.md' },
      },
    });

    const done = replayed.events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(done).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'PONG',
      usage: { input_tokens: 12, output_tokens: 2 },
    });
  });

  it('uses streamed text for final_text so a normalized result echo cannot double the reply', () => {
    const translator = createTurnTranslator();
    translator.push('{"type":"assistant","timestamp_ms":1,"message":{"content":[{"type":"text","text":"Fix applied."}]}}');
    // cursor's terminal `result` echo is whitespace-normalized (here, a leading
    // newline). Forwarding it as final_text would defeat codor's residual de-dupe
    // (neither prefix nor suffix of the streamed prose) and re-append the whole
    // reply, producing the "Fix applied.\nFix applied." doubling seen in rooms.
    const done = translator.push(
      '{"type":"result","subtype":"success","is_error":false,"result":"\\nFix applied."}',
    );
    expect(done).toEqual([{ type: 'run.completed', status: 'completed', final_text: 'Fix applied.' }]);
  });

  it('falls back to the result string when nothing streamed', () => {
    const translator = createTurnTranslator();
    const done = translator.push(
      '{"type":"result","subtype":"success","is_error":false,"result":"Done."}',
    );
    expect(done).toEqual([{ type: 'run.completed', status: 'completed', final_text: 'Done.' }]);
  });

  it('maps an errored result to a failed run', () => {
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
