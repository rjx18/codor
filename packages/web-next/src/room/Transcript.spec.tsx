import type { Message } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { transcriptMessages } from './transcript-order.js';

const TS = '2026-07-18T00:00:00.000Z';

function chat(id: number, body = `chat ${String(id)}`): Message {
  return {
    id,
    room: 'eng',
    author: 'human',
    kind: 'chat',
    body,
    mentions: [],
    refs: [],
    ledger_refs: [],
    ts: TS,
    seq: id,
  };
}

function root(id: number, mode?: 'messages', status: 'running' | 'completed' = 'completed'): Message {
  return {
    ...chat(id, 'first stretch'),
    author: 'agent',
    kind: 'run',
    run: {
      status,
      started_ts: '2026-07-18T00:00:01.000Z',
      ...(status !== 'running' && { ended_ts: '2026-07-18T00:10:00.000Z' }),
      tool_calls: 0,
      events_ref: `runs/${String(id)}.jsonl`,
      ...(mode !== undefined && { output_mode: mode, result_message_id: id + 2 }),
    },
  };
}

describe('transcript durable ordering', () => {
  it('retains ended-time and running-tail behavior for already stored roots', () => {
    expect(transcriptMessages({ 1: root(1), 2: chat(2) }).map((message) => message.id))
      .toEqual([2, 1]);
    expect(transcriptMessages({ 1: root(1, undefined, 'running'), 2: chat(2) }).map((message) => message.id))
      .toEqual([2, 1]);
  });

  it('keeps root, human interjection, and continuation in permanent id order', () => {
    const first = root(1, 'messages');
    const interjection = chat(2, 'do not move the first answer');
    const continuation: Message = {
      ...chat(3, 'continuation stretch'),
      author: 'agent',
      kind: 'run',
      run_parent_id: 1,
    };
    expect(transcriptMessages({ 3: continuation, 1: first, 2: interjection })
      .map((message) => message.id)).toEqual([1, 2, 3]);
  });

  it('carries strict ordering into a page whose lifecycle root is outside the window', () => {
    const continuation: Message = {
      ...chat(23, 'continuation'),
      author: 'agent',
      kind: 'run',
      run_parent_id: 4,
    };
    expect(transcriptMessages({ 22: chat(22), 23: continuation, 24: chat(24) })
      .map((message) => message.id)).toEqual([22, 23, 24]);
  });
});
