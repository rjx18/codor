import type { Message, WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildTranscriptHistoryPage,
  type TranscriptHistorySource,
} from './transcript-history.js';

const MEMBER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const at = (second: number) => `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`;

const chat = (id: number, second = id): Message => ({
  id, room: 'eng', author: MEMBER, kind: 'chat', body: `message ${String(id)}`,
  mentions: [], refs: [], ledger_refs: [], ts: at(second), seq: id,
});

const interaction = (id: number, kind: 'ask' | 'approval'): Message => ({
  ...chat(id),
  kind,
  body: `${kind} ${String(id)}`,
  ask: {
    interaction_id: `${kind}-${String(id)}`,
    kind,
    prompt: `${kind} prompt`,
    options: [{ label: 'Allow' }, { label: 'Deny' }],
  },
});

const run = (
  id: number,
  status: 'running' | 'completed' | 'failed' | 'interrupted',
  opts: { outputMode?: boolean; ended?: number; finalText?: string; error?: string; body?: string } = {},
): Message => ({
  id, room: 'eng', author: MEMBER, kind: 'run', body: opts.body ?? '',
  mentions: [], refs: [], ledger_refs: [], ts: at(id), seq: id,
  run: {
    status,
    started_ts: at(id),
    ...(status !== 'running' && { ended_ts: at(opts.ended ?? id + 1) }),
    tool_calls: 0,
    events_ref: `runs/${String(id)}.jsonl`,
    ...(opts.finalText !== undefined && { final_text: opts.finalText }),
    ...(opts.error !== undefined && { error: opts.error }),
    ...(opts.outputMode && { output_mode: 'messages' as const }),
  },
});

class Source implements TranscriptHistorySource {
  messageReads = 0;
  messageRecords = 0;
  journalReads = 0;

  constructor(
    readonly messages: Message[],
    readonly journals: Map<number, WireEvent[]>,
  ) {}

  listMessages(room: string, opts: { before: number; limit: number }): Message[] {
    this.messageReads += 1;
    const page = this.messages
      .filter((message) => message.room === room && message.id < opts.before)
      .sort((left, right) => right.id - left.id)
      .slice(0, opts.limit)
      .reverse();
    this.messageRecords += page.length;
    return page;
  }

  getMessage(room: string, id: number): Message | undefined {
    return this.messages.find((message) => message.room === room && message.id === id);
  }

  readRunJournal(_room: string, rootMessageId: number): WireEvent[] {
    this.journalReads += 1;
    return this.journals.get(rootMessageId) ?? [];
  }
}

const toolPair = (call: number, outputMessageId: number): WireEvent[] => [
  {
    type: 'run.item', item_type: 'tool_call', output_message_id: outputMessageId,
    ts: at((call % 50) + 1),
    payload: { call_id: `call-${String(call)}`, tool: 'Read', title: `read ${String(call)}` },
  },
  {
    type: 'run.item', item_type: 'tool_result', output_message_id: outputMessageId,
    ts: at((call % 50) + 1),
    payload: { call_id: `call-${String(call)}`, status: 'ok', output_text: 'done' },
  },
];

// harn:assume historical-transcript-pages-budget-text-slots ref=transcript-history-text-slot-regression
describe('buildTranscriptHistoryPage', () => {
  it('returns a complete evidence-only output family as one fallback text slot', () => {
    const events = Array.from({ length: 25 }, (_, index) => toolPair(index, 1)).flat();
    events.push({ type: 'run.completed', status: 'completed', output_message_id: 1 });
    const source = new Source([run(1, 'completed', { outputMode: true })], new Map([[1, events]]));

    const fingerprints: string[] = [];
    let cursor: string | undefined;
    let firstMetrics: ReturnType<typeof buildTranscriptHistoryPage>['metrics'] | undefined;
    do {
      const result = buildTranscriptHistoryPage({ room: 'eng', cursor, source });
      firstMetrics ??= result.metrics;
      for (const unit of result.page.units) {
        fingerprints.push(JSON.stringify(unit));
        if (unit.kind === 'tool') expect(unit.event_indices).toHaveLength(2);
      }
      cursor = result.page.before_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(fingerprints).toHaveLength(25);
    expect(new Set(fingerprints)).toHaveLength(25);
    expect(firstMetrics).toMatchObject({
      selected_units: 25,
      selected_text_slots: 1,
      journal_reads: 1,
      journal_events_scanned: 51,
    });
  });

  it('returns twenty text slots with every associated tool pair', () => {
    const messages = Array.from({ length: 19 }, (_, index) => chat(index + 2));
    const events = [
      ...Array.from({ length: 50 }, (_, index) => toolPair(index, 1)).flat(),
      { type: 'run.item' as const, item_type: 'text_block' as const, output_message_id: 1,
        payload: { text: 'done' }, ts: at(51) },
      { type: 'run.completed' as const, status: 'completed' as const, output_message_id: 1 },
    ];
    const source = new Source(
      [run(1, 'completed', { outputMode: true, finalText: 'done' }), ...messages],
      new Map([[1, events]]),
    );

    const { page, metrics } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(metrics.selected_text_slots).toBe(20);
    expect(page.units.filter((unit) => unit.kind === 'tool')).toHaveLength(50);
    expect(page.units.filter((unit) => unit.kind === 'message')).toHaveLength(19);
    expect(page.units.filter((unit) => unit.kind === 'prose')).toHaveLength(1);
    expect(page.units).toHaveLength(70);
    expect(page.before_cursor).toBeNull();
    expect(page.has_more).toBe(false);
  });

  // harn:assume transcript-history-cursors-cover-complete-established-order ref=complete-transcript-cursor-regression
  it('walks a complete mixed transcript order once when the oldest id sorts newest', () => {
    const stamp = (minute: number): string =>
      new Date(Date.UTC(2026, 7, 8) + minute * 60_000).toISOString();
    const timedRun = (
      id: number,
      status: 'running' | 'completed' | 'interrupted',
      minute: number,
    ): Message => {
      const seeded = run(id, status, status === 'interrupted' ? { error: 'stopped' } : {});
      return {
        ...seeded,
        ts: stamp(minute),
        run: {
          ...seeded.run!,
          started_ts: stamp(minute),
          ...(status !== 'running' && { ended_ts: stamp(minute) }),
        },
      };
    };
    const displaced = { ...chat(1), ts: stamp(1_000) };
    const archived = Array.from({ length: 181 }, (_, offset) => timedRun(offset + 2, 'completed', offset + 2));
    const running = timedRun(183, 'running', 183);
    const neighbour = timedRun(184, 'completed', 184);
    const interrupted = timedRun(185, 'interrupted', 185);
    const terminal = [...archived, neighbour];
    const journals = new Map<number, WireEvent[]>(terminal.map((message) => [message.id, [
      {
        type: 'run.item', item_type: 'text_delta',
        payload: { text: `run ${String(message.id)}` }, ts: message.ts,
      },
      { type: 'run.completed', status: 'completed' },
    ]]));
    journals.set(interrupted.id, []);
    const source = new Source(
      [displaced, ...archived, running, neighbour, interrupted],
      journals,
    );

    const pages: ReturnType<typeof buildTranscriptHistoryPage>[] = [];
    let cursor: string | undefined;
    do {
      const result = buildTranscriptHistoryPage({ room: 'eng', cursor, source });
      pages.push(result);
      cursor = result.page.before_cursor ?? undefined;
    } while (cursor !== undefined);

    const firstIds = pages[0]!.page.units.map((unit) =>
      unit.kind === 'message' ? unit.message_id : unit.root_message_id);
    expect(firstIds.at(-1)).toBe(1);
    const walked = [...pages].reverse().flatMap(({ page }) => page.units.map((unit) =>
      unit.kind === 'message' ? `message:${String(unit.message_id)}` : `${unit.kind}:${String(unit.root_message_id)}:${unit.event_indices.join(',')}`));
    const expectedIds = [...Array.from({ length: 181 }, (_, offset) => offset + 2), 184, 185, 1];
    expect(walked.map((fingerprint) => Number(fingerprint.split(':')[1])))
      .toEqual(expectedIds);
    expect(walked).toHaveLength(184);
    expect(new Set(walked)).toHaveLength(184);
    for (const result of pages.slice(0, -1)) {
      expect(result.page.has_more).toBe(true);
      expect(result.page.before_cursor).not.toBeNull();
    }
    expect(pages.at(-1)!.page).toMatchObject({ has_more: false, before_cursor: null });

    console.info('[transcript-history-complete-order-scan]', JSON.stringify({
      pages: pages.length,
      first: pages[0]!.metrics,
      final: pages.at(-1)!.metrics,
    }));
    expect(pages[0]!.metrics).toMatchObject({
      selected_units: 20,
      message_reads: 3,
      message_records_read: 185,
      journal_reads: 183,
      journal_events_scanned: 364,
    });
    expect(pages[0]!.metrics.duration_ms).toBeGreaterThan(0);
    expect(pages[0]!.metrics.response_bytes).toBeGreaterThan(0);
  });
  // harn:end transcript-history-cursors-cover-complete-established-order

  it('orders modern continuation evidence by permanent rows around ordinary messages', () => {
    const root = run(2, 'completed', { outputMode: true, ended: 6 });
    const continuation: Message = {
      ...run(4, 'completed'), run: undefined, run_parent_id: 2, ts: at(4), seq: 4,
    };
    const source = new Source(
      [root, chat(3, 3), continuation],
      new Map([[2, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'root' }, output_message_id: 2, ts: at(2) },
        ...toolPair(1, 4),
        { type: 'run.completed', status: 'completed', output_message_id: 4 },
      ]]]),
    );

    const { page } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(page.units.map((unit) => unit.kind)).toEqual(['prose', 'message', 'tool']);
    expect(page.units.map((unit) => unit.kind === 'message' ? unit.message_id : unit.output_message_id))
      .toEqual([2, 3, 4]);
    expect(page.messages.map((message) => message.id)).toEqual([2, 3, 4]);
  });

  // harn:assume explicit-prose-boundaries-survive-transcript-lifecycle ref=transcript-prose-boundary-unit-regression
  it('unitizes complete blocks independently while deltas survive other-output activity', () => {
    const visible = 'AB\n\nBlock one\n\nC\n\nBlock two\n\nD';
    const root = run(1, 'completed', {
      outputMode: true, body: visible, finalText: visible, ended: 9,
    });
    const other: Message = {
      ...run(2, 'completed'), run: undefined, run_parent_id: 1, body: '', ts: at(8), seq: 2,
    };
    const events: WireEvent[] = [
      { type: 'run.item', item_type: 'text_delta', output_message_id: 1, ts: at(1), payload: { text: 'A' } },
      { type: 'run.item', item_type: 'tool_call', output_message_id: 2, ts: at(2), payload: { call_id: 'other', tool: 'Read', title: 'other' } },
      { type: 'run.item', item_type: 'tool_result', output_message_id: 2, ts: at(3), payload: { call_id: 'other', status: 'ok' } },
      { type: 'run.item', item_type: 'text_delta', output_message_id: 1, ts: at(4), payload: { text: 'B' } },
      { type: 'run.item', item_type: 'text_block', output_message_id: 1, ts: at(5), payload: { text: 'Block one' } },
      { type: 'run.item', item_type: 'text_delta', output_message_id: 1, ts: at(6), payload: { text: 'C' } },
      { type: 'run.item', item_type: 'text_block', output_message_id: 1, ts: at(7), payload: { text: 'Block two' } },
      { type: 'run.item', item_type: 'text_delta', output_message_id: 1, ts: at(8), payload: { text: 'D' } },
      { type: 'run.completed', status: 'completed', output_message_id: 1, final_text: visible },
    ];
    const source = new Source([root, other], new Map([[1, events]]));

    const { page } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(page.units).toEqual([
      { kind: 'prose', root_message_id: 1, output_message_id: 1, event_indices: [0, 3] },
      { kind: 'prose', root_message_id: 1, output_message_id: 1, event_indices: [4] },
      { kind: 'prose', root_message_id: 1, output_message_id: 1, event_indices: [5] },
      { kind: 'prose', root_message_id: 1, output_message_id: 1, event_indices: [6] },
      { kind: 'prose', root_message_id: 1, output_message_id: 1, event_indices: [7] },
      { kind: 'tool', root_message_id: 1, output_message_id: 2, event_indices: [1, 2] },
    ]);
    expect(page.units.some((unit) => unit.kind === 'settled_tail')).toBe(false);
  });
  // harn:end explicit-prose-boundaries-survive-transcript-lifecycle

  it('retains timestamp interleaving for legacy journals without output ids', () => {
    const source = new Source(
      [run(1, 'completed', { ended: 5 }), chat(2, 3)],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'before' }, ts: at(2) },
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'legacy', tool: 'Read', title: 'later' }, ts: at(4) },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'legacy', status: 'ok' }, ts: at(4) },
        { type: 'run.completed', status: 'completed' },
      ]]]),
    );

    const { page } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(page.units.map((unit) => unit.kind)).toEqual(['prose', 'message', 'tool']);
  });

  it('keeps each legacy tool batch on its first segment timestamp', () => {
    const source = new Source(
      [run(1, 'completed', { ended: 6 }), chat(2, 4)],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'before' }, ts: at(1) },
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'one', tool: 'Read', title: 'one' }, ts: at(2) },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'one', status: 'ok' }, ts: at(2) },
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'two', tool: 'Read', title: 'two' }, ts: at(5) },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'two', status: 'ok' }, ts: at(5) },
        { type: 'run.completed', status: 'completed' },
      ]]]),
    );

    expect(buildTranscriptHistoryPage({ room: 'eng', source }).page.units.map((unit) => unit.kind))
      .toEqual(['prose', 'tool', 'tool', 'message']);
  });

  it('keeps tools-only legacy runs at ended time and a failure tail with its final segment', () => {
    const toolsOnly = new Source(
      [run(1, 'completed', { ended: 5 }), chat(2, 3)],
      new Map([[1, toolPair(1, 1).map((event) => {
        if (event.type !== 'run.item') return event;
        const { output_message_id: _target, ...legacy } = event;
        return { ...legacy, ts: at(2) };
      })]]),
    );
    expect(buildTranscriptHistoryPage({ room: 'eng', source: toolsOnly }).page.units.map((unit) => unit.kind))
      .toEqual(['message', 'tool']);

    const failed = new Source(
      [run(1, 'failed', { ended: 5, error: 'boom' }), chat(2, 3)],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'before' }, ts: at(2) },
        { type: 'run.completed', status: 'failed', error: 'boom' },
      ]]]),
    );
    const failedUnits = buildTranscriptHistoryPage({ room: 'eng', source: failed }).page.units;
    expect(failedUnits.map((unit) => unit.kind)).toEqual(['prose', 'settled_tail', 'message']);
  });

  it('keeps malformed browser-rendered events as visible unpaired fallback units', () => {
    const source = new Source(
      [run(1, 'completed', { ended: 5 })],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 42 } },
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'raw-only' } },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'raw-only', status: 'ok' } },
        { type: 'run.item', item_type: 'reasoning_summary', payload: { text: 42 } },
        { type: 'run.completed', status: 'completed' },
      ]]]),
    );

    const { page } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(page.units.map((unit) => unit.kind)).toEqual(['tool', 'tool', 'tool']);
    expect(page.units.map((unit) => unit.kind === 'message' ? [] : unit.event_indices))
      .toEqual([[0], [1], [2]]);
  });

  it('coalesces prose independently for each permanent output message', () => {
    const root = run(1, 'completed', { outputMode: true, body: 'onetwo' });
    const continuation: Message = {
      ...run(2, 'completed'), run: undefined, run_parent_id: 1, body: '',
    };
    const source = new Source([root, continuation], new Map([[1, [
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'one' }, output_message_id: 1 },
      {
        type: 'run.item', item_type: 'tool_call', output_message_id: 2,
        payload: { call_id: 'b', tool: 'Read', title: 'B' },
      },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'two' }, output_message_id: 1 },
      { type: 'run.completed', status: 'completed', output_message_id: 2 },
    ]]]));

    const units = buildTranscriptHistoryPage({ room: 'eng', source }).page.units;
    expect(units.map((unit) => unit.kind)).toEqual(['prose', 'tool']);
    expect(units[0]).toMatchObject({ output_message_id: 1, event_indices: [0, 2] });
    expect(units[1]).toMatchObject({ output_message_id: 2, event_indices: [1] });
  });

  it('never pairs same-id tool evidence across permanent output messages', () => {
    const root = run(1, 'completed', { outputMode: true });
    const continuation: Message = {
      ...run(2, 'completed'), run: undefined, run_parent_id: 1, body: '',
    };
    const source = new Source([root, continuation], new Map([[1, [
      {
        type: 'run.item', item_type: 'tool_call', output_message_id: 1,
        payload: { call_id: 'same', tool: 'Read', title: 'A' },
      },
      {
        type: 'run.item', item_type: 'tool_result', output_message_id: 2,
        payload: { call_id: 'same', status: 'ok' },
      },
      { type: 'run.completed', status: 'completed', output_message_id: 2 },
    ]]]));

    const units = buildTranscriptHistoryPage({ room: 'eng', source }).page.units;
    expect(units.map((unit) => unit.kind)).toEqual(['tool', 'tool']);
    expect(units[0]).toMatchObject({ output_message_id: 1, event_indices: [0] });
    expect(units[1]).toMatchObject({ output_message_id: 2, event_indices: [1] });
  });

  it('never upgrades compaction evidence across permanent output messages', () => {
    const root = run(1, 'completed', { outputMode: true });
    const continuation: Message = {
      ...run(2, 'completed'), run: undefined, run_parent_id: 1, body: '',
    };
    const source = new Source([root, continuation], new Map([[1, [
      {
        type: 'timeline', output_message_id: 1,
        item: { type: 'compaction', status: 'loading' },
      },
      {
        type: 'timeline', output_message_id: 2,
        item: { type: 'compaction', status: 'completed' },
      },
      { type: 'run.completed', status: 'completed', output_message_id: 2 },
    ]]]));

    const units = buildTranscriptHistoryPage({ room: 'eng', source }).page.units;
    expect(units.map((unit) => unit.kind)).toEqual(['timeline', 'timeline']);
    expect(units[0]).toMatchObject({ output_message_id: 1, event_indices: [0] });
    expect(units[1]).toMatchObject({ output_message_id: 2, event_indices: [1] });
  });

  it('suppresses valid and malformed reasoning summaries', () => {
    const source = new Source([run(1, 'completed', { outputMode: true })], new Map([[1, [
      {
        type: 'run.item', item_type: 'reasoning_summary', output_message_id: 1,
        payload: { text: 'hidden' },
      },
      {
        type: 'run.item', item_type: 'reasoning_summary', output_message_id: 1,
        payload: { text: 42 },
      },
      { type: 'run.completed', status: 'completed', output_message_id: 1 },
    ]]]));

    expect(buildTranscriptHistoryPage({ room: 'eng', source }).page.units).toEqual([]);
  });

  it('counts twenty genuinely visible completed streamed runs per page', () => {
    const messages = Array.from({ length: 25 }, (_, index) =>
      run(index + 1, 'completed', {
        outputMode: true,
        body: `stream ${String(index + 1)}`,
        finalText: `stream ${String(index + 1)}`,
      }));
    const journals = new Map(messages.map((message) => [message.id, [
      {
        type: 'run.item' as const,
        item_type: 'text_delta' as const,
        payload: { text: message.body },
        output_message_id: message.id,
      },
      { type: 'run.completed' as const, status: 'completed' as const, output_message_id: message.id },
    ]]));
    const { page } = buildTranscriptHistoryPage({ room: 'eng', source: new Source(messages, journals) });

    expect(page.units).toHaveLength(20);
    expect(page.units.every((unit) => unit.kind === 'prose')).toBe(true);
    expect(page.messages).toHaveLength(20);
    expect(page.has_more).toBe(true);
  });

  // harn:assume actionable-interactions-do-not-spend-history-text-slots ref=interaction-text-slot-regression
  it('excludes interaction rows while cursor pages retain every genuine visible unit once', () => {
    const excluded = new Set([6, 17]);
    const messages = Array.from({ length: 27 }, (_, offset) => {
      const id = offset + 1;
      if (id === 6) return interaction(id, 'ask');
      if (id === 17) return interaction(id, 'approval');
      return chat(id);
    });
    const source = new Source(messages, new Map());

    const pages: ReturnType<typeof buildTranscriptHistoryPage>[] = [];
    let cursor: string | undefined;
    do {
      const result = buildTranscriptHistoryPage({ room: 'eng', cursor, source });
      pages.push(result);
      cursor = result.page.before_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(pages[0]!.page.units).toHaveLength(20);
    expect(pages[0]!.page.units.every((unit) => unit.kind === 'message')).toBe(true);
    expect(pages[0]!.page.messages).toHaveLength(20);
    expect(pages[0]!.page.messages.every((message) => !excluded.has(message.id))).toBe(true);
    const walked = [...pages].reverse().flatMap(({ page }) => page.units.map((unit) => {
      expect(unit.kind).toBe('message');
      return unit.kind === 'message' ? unit.message_id : -1;
    }));
    expect(walked).toEqual(Array.from({ length: 27 }, (_, offset) => offset + 1)
      .filter((id) => !excluded.has(id)));
    expect(new Set(walked)).toHaveLength(25);
    expect(pages.at(-1)!.page).toMatchObject({ has_more: false, before_cursor: null });
  });
  // harn:end actionable-interactions-do-not-spend-history-text-slots

  it('combines fallback, trailing text, and failure status into one visible settled tail', () => {
    const fallback = new Source(
      [run(1, 'completed', { finalText: 'fallback', body: 'fallback' })],
      new Map([[1, [{ type: 'run.completed', status: 'completed' }]]]),
    );
    expect(buildTranscriptHistoryPage({ room: 'eng', source: fallback }).page.units.map((unit) => unit.kind))
      .toEqual(['settled_tail']);

    const trailing = new Source(
      [run(1, 'completed', { outputMode: true, finalText: 'hello tail', body: 'hello tail' })],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'hello' }, output_message_id: 1 },
        { type: 'run.completed', status: 'completed', final_text: 'hello tail', output_message_id: 1 },
      ]]]),
    );
    expect(buildTranscriptHistoryPage({ room: 'eng', source: trailing }).page.units.map((unit) => unit.kind))
      .toEqual(['prose', 'settled_tail']);

    const trailingFailure = new Source(
      [run(1, 'failed', { outputMode: true, finalText: 'hello tail', body: 'hello tail', error: 'boom' })],
      new Map([[1, [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'hello' }, output_message_id: 1 },
        { type: 'run.completed', status: 'failed', final_text: 'hello tail', error: 'boom', output_message_id: 1 },
      ]]]),
    );
    expect(buildTranscriptHistoryPage({ room: 'eng', source: trailingFailure }).page.units.map((unit) => unit.kind))
      .toEqual(['prose', 'settled_tail']);
  });

  it('excludes a mutable family and upgrades compaction plus terminal exactly once', () => {
    const running = run(1, 'running', { outputMode: true });
    const continuation: Message = { ...run(2, 'completed'), run: undefined, run_parent_id: 1 };
    const finalized = run(4, 'failed', { outputMode: true, ended: 6 });
    const source = new Source(
      [running, continuation, chat(3), finalized],
      new Map([
        [1, [{ type: 'run.item', item_type: 'text_delta', payload: { text: 'mutable' }, output_message_id: 1 }]],
        [4, [
          { type: 'timeline', item: { type: 'compaction', status: 'loading' }, output_message_id: 4 },
          { type: 'timeline', item: { type: 'compaction', status: 'completed', trigger: 'auto' }, output_message_id: 4 },
          { type: 'run.completed', status: 'failed', output_message_id: 4, error: 'failed' },
        ]],
      ]),
    );

    const { page, metrics } = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(page.messages.map((message) => message.id)).toEqual([3, 4]);
    expect(page.units.map((unit) => unit.kind)).toEqual(['message', 'timeline', 'settled_tail']);
    expect(page.units[1]).toMatchObject({ event_indices: [0, 1] });
    expect(metrics.journal_reads).toBe(1);
  });

  it('rejects malformed and cross-room cursors while a fixed ceiling ignores newer messages', () => {
    const source = new Source(
      Array.from({ length: 25 }, (_, index) => chat(index + 1)),
      new Map(),
    );
    const first = buildTranscriptHistoryPage({ room: 'eng', source });
    expect(first.page.before_cursor).not.toBeNull();
    source.messages.push(chat(26));
    const older = buildTranscriptHistoryPage({
      room: 'eng', cursor: first.page.before_cursor!, source,
    });
    expect(older.page.units.map((unit) => unit.kind === 'message' && unit.message_id))
      .not.toContain(26);
    expect(() => buildTranscriptHistoryPage({ room: 'other', cursor: first.page.before_cursor!, source }))
      .toThrow('cursor belongs to a different room');
    expect(() => buildTranscriptHistoryPage({ room: 'eng', cursor: 'not-a-cursor', source }))
      .toThrow('invalid transcript history cursor');
    const oversizedPayload = JSON.stringify({
      v: 1,
      room: 'eng',
      ceiling_message_id: 25,
      before: { message_id: 25, unit_ordinal: 0 },
    }).replace(/}$/, `${' '.repeat(4096)}}`);
    const oversizedCursor = Buffer.from(oversizedPayload, 'utf8').toString('base64url');
    expect(oversizedCursor.length).toBeGreaterThan(4096);
    expect(() => buildTranscriptHistoryPage({ room: 'eng', cursor: oversizedCursor, source }))
      .toThrow('invalid transcript history cursor');
  });

  it('reports bounded payload and reader metrics for a large local scan', () => {
    const events = Array.from({ length: 1_000 }, (_, index) => toolPair(index, 1)).flat();
    events.push({ type: 'run.completed', status: 'completed', output_message_id: 1 });
    const source = new Source([run(1, 'completed', { outputMode: true })], new Map([[1, events]]));
    const samples = Array.from({ length: 6 }, () =>
      buildTranscriptHistoryPage({ room: 'eng', source }).metrics);
    const cold = samples[0]!;
    const warmMs = samples.slice(1).map((sample) => sample.duration_ms);
    console.info('[transcript-history-metrics]', JSON.stringify({ cold, warm_ms: warmMs }));

    expect(cold).toMatchObject({
      selected_units: 1_000,
      selected_text_slots: 1,
      message_reads: 1,
      message_records_read: 1,
      journal_reads: 1,
      journal_events_scanned: 2_001,
    });
    expect(cold.response_bytes).toBeLessThan(500_000);
    expect(cold.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
// harn:end historical-transcript-pages-budget-text-slots
