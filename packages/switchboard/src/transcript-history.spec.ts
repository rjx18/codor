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

const run = (
  id: number,
  status: 'running' | 'completed' | 'failed' | 'interrupted',
  opts: { outputMode?: boolean; ended?: number } = {},
): Message => ({
  id, room: 'eng', author: MEMBER, kind: 'run', body: '',
  mentions: [], refs: [], ledger_refs: [], ts: at(id), seq: id,
  run: {
    status,
    started_ts: at(id),
    ...(status !== 'running' && { ended_ts: at(opts.ended ?? id + 1) }),
    tool_calls: 0,
    events_ref: `runs/${String(id)}.jsonl`,
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

// harn:assume historical-transcript-pages-are-unit-bounded-and-room-bound ref=transcript-history-page-builder
describe('buildTranscriptHistoryPage', () => {
  it('walks a huge run internally without splitting tool pairs or duplicating units', () => {
    const events = Array.from({ length: 25 }, (_, index) => toolPair(index, 1)).flat();
    events.push({ type: 'run.completed', status: 'completed', output_message_id: 1 });
    const source = new Source([run(1, 'completed', { outputMode: true })], new Map([[1, events]]));

    const fingerprints: string[] = [];
    let cursor: string | undefined;
    let firstMetrics: ReturnType<typeof buildTranscriptHistoryPage>['metrics'] | undefined;
    do {
      const result = buildTranscriptHistoryPage({ room: 'eng', cursor, source });
      firstMetrics ??= result.metrics;
      expect(result.page.units.length).toBeLessThanOrEqual(20);
      for (const unit of result.page.units) {
        fingerprints.push(JSON.stringify(unit));
        if (unit.kind === 'tool') expect(unit.event_indices).toHaveLength(2);
      }
      cursor = result.page.before_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(fingerprints).toHaveLength(26);
    expect(new Set(fingerprints)).toHaveLength(26);
    expect(firstMetrics).toMatchObject({
      selected_units: 20,
      journal_reads: 1,
      journal_events_scanned: 51,
    });
  });

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
    expect(page.units.map((unit) => unit.kind)).toEqual(['prose', 'message', 'tool', 'terminal']);
    expect(page.units.map((unit) => unit.kind === 'message' ? unit.message_id : unit.output_message_id))
      .toEqual([2, 3, 4, 4]);
    expect(page.messages.map((message) => message.id)).toEqual([2, 3, 4]);
  });

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
    expect(page.units.map((unit) => unit.kind)).toEqual(['prose', 'message', 'tool', 'terminal']);
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
    expect(page.units.map((unit) => unit.kind)).toEqual(['message', 'timeline', 'terminal']);
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
      selected_units: 20,
      message_reads: 1,
      message_records_read: 1,
      journal_reads: 1,
      journal_events_scanned: 2_001,
    });
    expect(cold.response_bytes).toBeLessThan(20_000);
    expect(cold.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
// harn:end historical-transcript-pages-are-unit-bounded-and-room-bound
