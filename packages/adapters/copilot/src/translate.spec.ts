import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

const SESSION = '33333333-3333-4333-8333-333333333333';

function replay(name: string, status: 'completed' | 'failed'): WireEvent[] {
  const translator = createTurnTranslator(SESSION);
  const events = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => translator.push(line));
  events.push(...translator.end({ status }));
  for (const event of events) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return events;
}

describe('Copilot JSONL event translation', () => {
  it('deduplicates the complete assistant message after streamed deltas', () => {
    const events = replay('synthetic-success.jsonl', 'completed');
    expect(events.filter((event) => event.type === 'run.item' && event.item_type === 'text_delta'))
      .toEqual([
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'PO' } },
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'NG' } },
      ]);
    expect(events.at(-1)).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'PONG',
      usage: { input_tokens: 12, output_tokens: 2 },
    });
  });

  it('maps documented tool and authoritative subagent lifecycle', () => {
    const events = replay('synthetic-success.jsonl', 'completed');
    expect(events).toContainEqual({
      type: 'extension.started',
      parent: SESSION,
      ext_member: 'subagent-call-1',
      description: 'Code review',
      agent_type: 'code-review',
    });
    expect(events).toContainEqual({
      type: 'extension.ended',
      ext_member: 'subagent-call-1',
    });
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'tool-call-1',
        tool: 'grep',
        title: 'grep',
        input: { query: 'Wireroom' },
      },
    });
  });

  it('uses session error detail for failed completion', () => {
    expect(replay('synthetic-failure.jsonl', 'failed').at(-1)).toEqual({
      type: 'run.completed',
      status: 'failed',
      final_text: 'Authentication required',
    });
  });

  it('does not call a clean process exit successful after a session error', () => {
    const translator = createTurnTranslator(SESSION);
    translator.push('{"type":"session.error","data":{"errorType":"quota","message":"Quota exhausted"}}');
    expect(translator.end({ status: 'completed' })).toEqual([
      { type: 'run.completed', status: 'failed', final_text: 'Quota exhausted' },
    ]);
  });

  it('ignores malformed, future, and child assistant messages', () => {
    const translator = createTurnTranslator(SESSION);
    expect(translator.push('not-json')).toEqual([]);
    expect(translator.push('{"type":"future","data":{}}')).toEqual([]);
    expect(translator.push(JSON.stringify({
      type: 'assistant.message_delta',
      data: { messageId: 'child', deltaContent: 'hidden', parentToolCallId: 'task-1' },
    }))).toEqual([]);
  });
});
