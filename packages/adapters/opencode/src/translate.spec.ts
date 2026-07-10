import { readFileSync } from 'node:fs';

import type { WireEvent } from '@wireroom/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

function replay(): { events: WireEvent[]; sessionId: string | undefined } {
  const translator = createTurnTranslator();
  const events = readFileSync(
    new URL('../fixtures/live-pong-1.17.14.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .flatMap((line) => translator.push(line));
  events.push(...translator.end({ status: 'completed' }));
  return { events, sessionId: translator.sessionId() };
}

describe('OpenCode raw run translation', () => {
  it('replays the live PONG with native id and reported usage', () => {
    const replayed = replay();
    expect(replayed.sessionId).toBe('ses_0b418b8aeffelyQqZS0JoBHFvF');
    expect(replayed.events).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: 'PONG' },
      {
        type: 'run.completed',
        status: 'completed',
        final_text: 'PONG',
        usage: { input_tokens: 10119, output_tokens: 3, cost_usd: 0 },
      },
    ]);
  });

  it('maps a completed tool part to call and result items', () => {
    const translator = createTurnTranslator();
    expect(translator.push(JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_test',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call-1',
        state: {
          status: 'completed',
          input: { filePath: 'README.md' },
          output: 'Wireroom',
          title: 'Read README.md',
        },
      },
    }))).toEqual([
      {
        type: 'run.item',
        item_type: 'tool_call',
        payload: {
          tool: 'read',
          call_id: 'call-1',
          input: { filePath: 'README.md' },
          title: 'Read README.md',
        },
      },
      {
        type: 'run.item',
        item_type: 'tool_result',
        payload: {
          tool: 'read',
          call_id: 'call-1',
          status: 'completed',
          output: 'Wireroom',
        },
      },
    ]);
  });

  it('retains nested provider errors and classifies process failure at EOF', () => {
    const translator = createTurnTranslator();
    translator.push(JSON.stringify({
      type: 'error',
      sessionID: 'ses_failed',
      error: { name: 'ProviderAuthError', data: { message: 'Authentication required' } },
    }));
    expect(translator.end({ status: 'failed' })).toEqual([
      {
        type: 'run.completed',
        status: 'failed',
        final_text: 'Authentication required',
      },
    ]);
  });

  it('ignores malformed and future records', () => {
    const translator = createTurnTranslator();
    expect(translator.push('not-json')).toEqual([]);
    expect(translator.push('{"type":"future"}')).toEqual([]);
  });
});
