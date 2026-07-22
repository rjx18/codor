import type { Delivery, Message } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./markdown.js', () => ({ renderMarkdown: (body: string) => body }));

import {
  continuationTrailingText,
  continuationVisibleMessages,
  deliveryIndicator,
  messageReadSeq,
  resolveRunningSince,
} from './Transcript.js';
import { transcriptMessages } from './transcript-order.js';

const TS = '2026-07-18T00:00:00.000Z';

// harn:assume agent-delivery-lifecycle-streams-v2 ref=steering-delivery-indicator-regression
describe('delivery indicator truth', () => {
  const delivery = (state: Delivery['state'], steered = false): Delivery => ({
    id: `delivery-${state}-${String(steered)}`,
    room: 'eng',
    message_id: 1,
    recipient: 'agent',
    state,
    attempt_count: 0,
    ...(steered && { steered_ts: TS }),
    ts: TS,
  });

  it('distinguishes queued, ordinary delivered, and active-turn steered messages', () => {
    expect(deliveryIndicator([delivery('queued')])).toEqual({
      seen: false, disposition: 'queued', title: 'Queued for the next turn',
    });
    expect(deliveryIndicator([delivery('delivering')])).toEqual({
      seen: true, disposition: 'delivered', title: 'Delivered to its agents',
    });
    expect(deliveryIndicator([delivery('consumed', true)])).toEqual({
      seen: true, disposition: 'steered', title: 'Steered into the active turn',
    });
  });
});
// harn:end agent-delivery-lifecycle-streams-v2

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

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-web-regression
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

describe('continuation transcript semantics', () => {
  it('renders one terminal acknowledgement for a multi-row ACK family', () => {
    const lifecycleRoot = { ...root(1, 'messages'), ack: true };
    const middle: Message = {
      ...chat(2, ''), author: 'agent', kind: 'run', run_parent_id: 1,
    };
    const result: Message = {
      ...chat(3, '<ACK_OK>'), author: 'agent', kind: 'run', run_parent_id: 1, ack: true,
    };
    const messages = { 1: lifecycleRoot, 2: middle, 3: result };
    expect(continuationVisibleMessages([lifecycleRoot, middle, result], messages))
      .toEqual([result]);
  });

  it('counts a substantive continuation as readable but never its ACK result', () => {
    const continuation: Message = {
      ...chat(3, 'continued'), author: 'agent', kind: 'run', run_parent_id: 1,
    };
    expect(messageReadSeq(continuation, false)).toBe(3);
    expect(messageReadSeq({ ...continuation, ack: true }, false)).toBeUndefined();
    expect(messageReadSeq(continuation, true)).toBeUndefined();
  });

  it('renders a settled residual as its own block after streamed prose', () => {
    expect(continuationTrailingText('workingfinal answer', 'working', true, true))
      .toBe('final answer');
    expect(continuationTrailingText('final answer', 'working', true, true)).toBe('');
    expect(continuationTrailingText('workingfinal answer', 'working', false, true)).toBe('');
  });
});
// harn:end continuation-writer-follows-journaled-output-ownership

describe('resolveRunningSince', () => {
  const runningRun = (id: number, author: string, startedTs: string): Message => ({
    id,
    room: 'eng',
    author,
    kind: 'run',
    body: '',
    mentions: [],
    refs: [],
    ledger_refs: [],
    ts: startedTs,
    seq: id,
    run: {
      status: 'running',
      started_ts: startedTs,
      tool_calls: 0,
      events_ref: `runs/${String(id)}.jsonl`,
    },
  } as unknown as Message);

  it('takes the newest loaded root when support says nothing', () => {
    // Numeric message keys enumerate ascending, so a first-wins rule silently
    // preserved the OLDEST running root — a stale lifecycle that never settled
    // would have frozen the pill's clock at its start time.
    const stale = runningRun(1, 'agent-a', '2026-07-18T00:00:00.000Z');
    const current = runningRun(9, 'agent-a', '2026-07-18T03:00:00.000Z');

    expect(resolveRunningSince([], [stale, current])['agent-a'])
      .toBe('2026-07-18T03:00:00.000Z');
    // Enumeration order must not decide the answer.
    expect(resolveRunningSince([], [current, stale])['agent-a'])
      .toBe('2026-07-18T03:00:00.000Z');
  });

  it('keeps the support projection authoritative over any loaded alternative', () => {
    // Support names the CURRENT lifecycle root, including one outside the
    // hydrated window — a loaded row must never override it, newer or not.
    const supported = runningRun(2, 'agent-a', '2026-07-18T01:00:00.000Z');
    const loadedNewer = runningRun(7, 'agent-a', '2026-07-18T05:00:00.000Z');

    expect(resolveRunningSince([supported], [loadedNewer])['agent-a'])
      .toBe('2026-07-18T01:00:00.000Z');
  });

  it('answers per author, and says nothing about agents that are not running', () => {
    const running = runningRun(3, 'agent-a', '2026-07-18T02:00:00.000Z');
    const other = runningRun(4, 'agent-b', '2026-07-18T02:30:00.000Z');
    const settled = runningRun(5, 'agent-c', '2026-07-18T01:00:00.000Z');
    (settled as unknown as { run: { status: string } }).run.status = 'completed';

    const roots = resolveRunningSince([], [running, other, settled]);
    expect(roots['agent-a']).toBe('2026-07-18T02:00:00.000Z');
    expect(roots['agent-b']).toBe('2026-07-18T02:30:00.000Z');
    expect(roots['agent-c']).toBeUndefined();
  });
});
