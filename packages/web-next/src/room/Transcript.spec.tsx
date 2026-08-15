import type { Delivery, Message, Schedule } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./markdown.js', () => ({ renderMarkdown: (body: string) => body }));

import {
  coldMessageSuppressed,
  continuationTrailingText,
  continuationVisibleMessages,
  deliveryIndicator,
  groupVisibleTranscriptRows,
  groupHistoricalPresentationUnits,
  groupAdjacentToolOnlyLiveMessages,
  messageReadSeq,
  qualifiedAuthorLabel,
  resolveRunningSince,
  orderedVisibleSchedules,
  reserveScheduleCancel,
  scheduleCancelReady,
  type ScheduleCancelAttempt,
  settleScheduleCancelAttempt,
  transcriptMessagesWithActiveRuns,
} from './Transcript.js';

describe('scheduled transcript projection', () => {
  const schedule = (id: string, due: string, created: string, state: Schedule['state']): Schedule => ({
    id, room: 'eng', author_id: 'human', author_handle: 'richard',
    target: { member_id: 'agent', conversation_id: 'eng', handle: 'agent' },
    body: '@agent scheduled', mentions: [{ member_id: 'agent', start: 0, end: 6 }],
    due_ts: due, host_offset_minutes: 480, state,
    created_ts: created, updated_ts: created,
  });

  it('orders by due, creation, and id while suppressing sent rows and other rooms', () => {
    expect(orderedVisibleSchedules({
      b: schedule('b', '2026-08-12T12:00:00.000Z', '2026-08-12T12:01:00.000Z', 'pending'),
      a: schedule('a', '2026-08-12T12:00:00.000Z', '2026-08-12T12:01:00.000Z', 'cancelled'),
      sent: schedule('sent', '2026-08-12T11:00:00.000Z', '2026-08-12T11:00:00.000Z', 'sent'),
      other: { ...schedule('other', '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', 'pending'), room: 'other' },
    }, 'eng').map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('admits cancellation only with current room evidence and reserves one same-tick act', () => {
    expect(scheduleCancelReady(false, false)).toBe(false);
    expect(scheduleCancelReady(true, false)).toBe(false);
    expect(scheduleCancelReady(true, true)).toBe(true);
    const reservations = new Set<string>();
    expect(reserveScheduleCancel(reservations, 'one')).toBe(true);
    expect(reserveScheduleCancel(reservations, 'one')).toBe(false);
    expect([...reservations]).toEqual(['one']);
  });

  it('settles one attempt from newer exact errors and clears stale or terminal evidence', () => {
    const pending: ScheduleCancelAttempt = { errorCount: 2, settled: false };
    const row = schedule('one', '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z', 'pending');
    expect(settleScheduleCancelAttempt(pending, row, 2, 'old refusal', true)).toBe(pending);
    expect(settleScheduleCancelAttempt(pending, row, 3, 'new refusal', true)).toEqual({
      errorCount: 3, settled: true, error: 'new refusal',
    });
    expect(settleScheduleCancelAttempt(pending, { ...row, state: 'cancelled' }, 3, 'old refusal', true)).toBeUndefined();
    expect(settleScheduleCancelAttempt(pending, undefined, 3, 'old refusal', true)).toBeUndefined();
    expect(settleScheduleCancelAttempt(pending, row, 2, 'old refusal', false)).toBeUndefined();
  });
});

// harn:assume tool-only-evidence-batches-across-invisible-output-boundaries ref=cross-output-tool-batch-regression
describe('cross-output historical tool presentation', () => {
  const tool = (rootId: number, outputId: number, index: number) => ({
    kind: 'tool' as const,
    root_message_id: rootId,
    output_message_id: outputId,
    event_indices: [index],
  });
  const prose = (rootId: number, outputId: number, index: number) => ({
    kind: 'prose' as const,
    root_message_id: rootId,
    output_message_id: outputId,
    event_indices: [index],
  });

  it('merges adjacent same-root tools across output and page identities', () => {
    expect(groupHistoricalPresentationUnits([
      tool(1, 1, 1), tool(1, 2, 2), tool(1, 2, 3), tool(1, 3, 4),
    ])).toEqual([[
      tool(1, 1, 1), tool(1, 2, 2), tool(1, 2, 3), tool(1, 3, 4),
    ]]);
  });

  it('stops at prose, messages, settled evidence, and another root', () => {
    const messageUnit = { kind: 'message' as const, message_id: 9 };
    const settled = {
      kind: 'settled_tail' as const,
      root_message_id: 1,
      output_message_id: 3,
      event_indices: [],
    };
    expect(groupHistoricalPresentationUnits([
      tool(1, 1, 1), prose(1, 1, 2), tool(1, 2, 3), messageUnit,
      tool(1, 3, 4), settled, tool(2, 4, 5), tool(1, 5, 6),
    ]).map((group) => group.map((unit) => unit.kind))).toEqual([
      ['tool', 'prose'], ['tool'], ['message'], ['tool', 'settled_tail'], ['tool'], ['tool'],
    ]);
  });
});

describe('cross-output live tool presentation', () => {
  it('merges only adjacent tool-only outputs from one root', () => {
    const first = root(1, 'messages', 'running');
    const second = { ...root(2, undefined, 'running'), run_parent_id: 1 };
    const separator = chat(3);
    const third = { ...root(4, undefined, 'running'), run_parent_id: 1 };
    expect(groupAdjacentToolOnlyLiveMessages(
      [first, second, separator, third],
      new Set([1, 2, 4]),
    ).map((group) => group.map((message) => message.id))).toEqual([[1, 2], [3], [4]]);
  });
});
// harn:end tool-only-evidence-batches-across-invisible-output-boundaries

// harn:assume visible-transcript-grouping-ignores-hidden-boundaries ref=transcript-grouping-unit-regression
describe('visible transcript grouping', () => {
  const row = (author: string, ts: number, visible = true, boundary = false) => ({
    author, ts, visible, boundary,
  });

  it('resets at compaction and ignores the hidden continuation that follows it', () => {
    expect(groupVisibleTranscriptRows([
      row('agent', 1),
      row('agent', 2, true, true), // visible compaction boundary
      row('agent', 3, false), // evidence-free continuation
      row('agent', 4),
    ])).toEqual([false, false, false, false]);
  });

  it('does not let an evidence-free row break the previous visible turn', () => {
    expect(groupVisibleTranscriptRows([
      row('agent', 1),
      row('agent', 2, false),
      row('agent', 3),
    ])).toEqual([false, false, true]);
  });

  it('keeps ordinary visible same-author turns grouped but resets at status', () => {
    expect(groupVisibleTranscriptRows([
      row('agent', 1),
      row('agent', 2),
      row('agent', 3, true, true), // terminal status boundary
      row('agent', 4),
    ])).toEqual([false, true, false, false]);
  });
});
// harn:end visible-transcript-grouping-ignores-hidden-boundaries

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

// harn:assume active-runs-follow-established-transcript-time ref=active-run-chronology-unit-regression
describe('transcript durable ordering', () => {
  it('orders an active root by its message time while retaining finalized ended-time order', () => {
    expect(transcriptMessages({ 1: root(1), 2: chat(2) }).map((message) => message.id))
      .toEqual([2, 1]);
    expect(transcriptMessages({ 1: root(1, undefined, 'running'), 2: chat(2) }).map((message) => message.id))
      .toEqual([1, 2]);
  });
  // harn:end active-runs-follow-established-transcript-time

  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-web-regression
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

// harn:assume hosted-support-active-run-transcript-projection ref=support-active-run-transcript-unit-regression
describe('hosted support active-run transcript projection', () => {
  it('projects missing running roots, keeps ordinary records authoritative, and excludes settled support rows', () => {
    const storedRoot = root(7, 'messages', 'completed');
    const supportOnlyRoot = root(99, 'messages', 'running');
    const settledSupportRoot = root(101, 'messages', 'completed');

    expect(transcriptMessagesWithActiveRuns(
      { [storedRoot.id]: storedRoot },
      [supportOnlyRoot, settledSupportRoot],
    ).map((message) => message.id)).toEqual([7, 99]);

    const newerStoredRoot = { ...supportOnlyRoot, body: 'authoritative stored root' };
    expect(transcriptMessagesWithActiveRuns(
      { [supportOnlyRoot.id]: newerStoredRoot },
      [{ ...supportOnlyRoot, body: 'stale support projection' }],
    ).find((message) => message.id === supportOnlyRoot.id)).toEqual(newerStoredRoot);
  });
});
// harn:end hosted-support-active-run-transcript-projection

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

  // harn:assume explicit-prose-boundaries-survive-transcript-lifecycle ref=transcript-prose-boundary-rendering-regression
  it('deduplicates terminal text against the browser-visible block join', () => {
    expect(continuationTrailingText(
      'first\n\ncomplete\n\nresidual',
      'firstcomplete',
      true,
      true,
      'first\n\ncomplete',
    )).toBe('\n\nresidual');
    expect(continuationTrailingText(
      'first\n\ncomplete',
      'firstcomplete',
      true,
      true,
      'first\n\ncomplete',
    )).toBe('');
  });
  // harn:end explicit-prose-boundaries-survive-transcript-lifecycle
});
// harn:end continuation-writer-follows-journaled-output-ownership

// harn:assume actionable-interactions-remain-support-owned-outside-history ref=interaction-cold-suppression-regression
describe('support-owned interaction suppression', () => {
  it('keeps only currently actionable cold-tail cards outside history suppression', () => {
    const ask = { ...chat(40), kind: 'ask' as const };
    const approval = { ...chat(41), kind: 'approval' as const };
    const cold = { 40: true as const, 41: true as const, 42: true as const };
    const actionable = new Set([40, 41]);

    expect(coldMessageSuppressed(ask, cold, actionable)).toBe(false);
    expect(coldMessageSuppressed(approval, cold, actionable)).toBe(false);
    expect(coldMessageSuppressed(ask, cold, new Set())).toBe(true);
    expect(coldMessageSuppressed(chat(42), cold, actionable)).toBe(true);
    expect(coldMessageSuppressed(chat(43), cold, actionable)).toBe(false);
  });
});
// harn:end actionable-interactions-remain-support-owned-outside-history

// harn:assume cross-worktree-output-stays-in-origin ref=qualified-author-rendering-regression
describe('qualified transcript attribution', () => {
  it('renders a foreign author with its persisted alias and handle while preserving local labels', () => {
    const target = {
      worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      conversation_id: 'wt-review',
      member_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      alias: 'review',
      handle: 'coder',
    };
    const foreign: Message = {
      ...chat(7, 'foreign answer'),
      author: target.member_id,
      author_target: target,
    };
    expect(qualifiedAuthorLabel(foreign)).toBe('~review:@coder');
    expect(qualifiedAuthorLabel(foreign, {
      id: target.member_id, handle: 'renamed', kind: 'agent', display_name: 'Renamed',
      conventions_sent: false, misaddressed: false, roster_stale: false,
    })).toBe('~review:@renamed');
    expect(qualifiedAuthorLabel(chat(8), {
      id: 'local', handle: 'coder', kind: 'agent', display_name: 'Local',
      conventions_sent: false, misaddressed: false, roster_stale: false,
    })).toBe('@coder');
  });

  it('keeps stable scoped labels for every foreign message kind, including removed authors', () => {
    const target = {
      worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      conversation_id: 'wt-review',
      member_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      alias: 'review',
      handle: 'coder',
    };
    for (const kind of ['chat', 'run', 'ask', 'approval'] as const) {
      expect(qualifiedAuthorLabel({ ...chat(20 + kind.length), kind, author: target.member_id, author_target: target }))
        .toBe('~review:@coder');
    }
    expect(qualifiedAuthorLabel({ ...chat(31), author: target.member_id, author_target: target }))
      .toBe('~review:@coder');
  });
});
// harn:end cross-worktree-output-stays-in-origin

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
