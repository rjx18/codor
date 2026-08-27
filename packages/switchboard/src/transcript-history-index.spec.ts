import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from './blobs.js';
import { Store } from './store.js';
import {
  buildTranscriptHistoryPage,
  maintainIndexedTranscriptHistoryMessage,
  type TranscriptHistorySource,
} from './transcript-history.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { store: Store; blobs: BlobStore; ownerId: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'codor-history-index-'));
  roots.push(root);
  const dbPath = join(root, 'codor.sqlite');
  const store = new Store(dbPath);
  const created = store.createRoom({
    id: 'eng',
    name: 'Engineering',
    owner: { handle: 'richard', display_name: 'Richard' },
  });
  return {
    store,
    blobs: new BlobStore(join(root, 'blobs')),
    ownerId: created.owner.id,
    dbPath,
  };
}

function source(
  store: Store,
  blobs: BlobStore,
  indexed: boolean,
): TranscriptHistorySource {
  return {
    listMessages: (room, opts) => store.listMessages(room, opts),
    getMessage: (room, id) => store.getMessage(room, id),
    readRunJournal: (room, rootMessageId) => {
      const root = store.getMessage(room, rootMessageId);
      return root?.run === undefined ? [] : blobs.read(room, root.run.events_ref);
    },
    ...(indexed ? {
      transcriptHistoryIndex: store.transcriptHistoryIndex,
      readRunJournalWithSpans: (room: string, rootMessageId: number) => {
        const root = store.getMessage(room, rootMessageId);
        return root?.run === undefined
          ? { events: [], spans: [] }
          : blobs.readWithSpans(room, root.run.events_ref);
      },
      readRunJournalSpans: (room: string, rootMessageId: number, spans: Parameters<BlobStore['readSpans']>[2]) => {
        const root = store.getMessage(room, rootMessageId);
        return root?.run === undefined ? [] : blobs.readSpans(room, root.run.events_ref, spans);
      },
    } : {}),
  };
}

function finalizeRun(opts: {
  store: Store;
  blobs: BlobStore;
  ownerId: string;
  events: readonly WireEvent[];
  finalText?: string;
  status?: 'completed' | 'failed' | 'interrupted';
  outputMode?: boolean;
}): number {
  const root = opts.store.postMessage('eng', {
    author: opts.ownerId,
    kind: 'run',
    body: opts.finalText ?? '',
  });
  const ref = `runs/${String(root.id)}.jsonl`;
  for (const event of opts.events) opts.blobs.append('eng', ref, event);
  opts.store.updateMessage('eng', root.id, {
    body: opts.finalText ?? '',
    run: {
      status: opts.status ?? 'completed',
      started_ts: '2026-08-28T00:00:00.000Z',
      ended_ts: '2026-08-28T00:00:01.000Z',
      tool_calls: opts.events.filter((event) =>
        event.type === 'run.item' && event.item_type === 'tool_call').length,
      events_ref: ref,
      ...(opts.outputMode === false ? {} : { output_mode: 'messages' as const }),
      final_text: opts.finalText,
      result_message_id: root.id,
    },
  });
  return root.id;
}

const toolPair = (call: number, outputMessageId: number): WireEvent[] => [
  {
    type: 'run.item',
    item_type: 'tool_call',
    output_message_id: outputMessageId,
    payload: { call_id: `call-${String(call)}`, tool: 'Read', title: `Read ${String(call)}` },
  },
  {
    type: 'run.item',
    item_type: 'tool_result',
    output_message_id: outputMessageId,
    payload: { call_id: `call-${String(call)}`, status: 'ok', output_text: 'done' },
  },
];

// harn:assume transcript-history-index-is-write-maintained-and-rebuildable ref=transcript-history-index-regression
// harn:assume indexed-transcript-pages-read-only-current-selected-evidence ref=indexed-transcript-page-regression
describe('derived transcript history index', () => {
  it('backfills atomically with exact legacy parity, then survives reopen', () => {
    const { store, blobs, ownerId, dbPath } = fixture();
    for (let index = 0; index < 45; index += 1) {
      store.postMessage('eng', { author: ownerId, kind: 'chat', body: `message ${String(index)}` });
    }
    const events = [
      ...toolPair(1, 46),
      {
        type: 'run.item' as const,
        item_type: 'text_block' as const,
        output_message_id: 46,
        payload: { text: 'complete' },
      },
      { type: 'run.completed' as const, status: 'completed' as const, output_message_id: 46 },
    ];
    finalizeRun({ store, blobs, ownerId, events, finalText: 'complete' });

    const legacy = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, false) });
    const cold = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(cold.page).toEqual(legacy.page);
    expect(cold.metrics.index_backfilled).toBe(true);
    expect(store.transcriptHistoryIndex.roomState('eng').complete).toBe(true);

    const warm = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(warm.page).toEqual(legacy.page);
    expect(warm.metrics.index_backfilled).toBe(false);
    expect(warm.metrics.message_records_read).toBeLessThanOrEqual(22);
    expect(warm.metrics.journal_events_scanned).toBe(3);

    store.close();
    const reopened = new Store(dbPath);
    expect(reopened.transcriptHistoryIndex.roomState('eng').complete).toBe(true);
    const reopenedPage = buildTranscriptHistoryPage({
      room: 'eng',
      source: source(reopened, blobs, true),
    });
    expect(reopenedPage.page).toEqual(legacy.page);
    expect(reopenedPage.metrics.index_backfilled).toBe(false);
    reopened.close();
  });

  it('retries a failed lazy backfill without publishing a complete marker', () => {
    const { store, blobs, ownerId } = fixture();
    const rootId = finalizeRun({
      store,
      blobs,
      ownerId,
      events: [
        { type: 'run.item', item_type: 'text_block', output_message_id: 1, payload: { text: 'x' } },
        { type: 'run.completed', status: 'completed', output_message_id: 1 },
      ],
      finalText: 'x',
    });
    const failing = source(store, blobs, true);
    failing.readRunJournalWithSpans = () => {
      throw new Error('fixture backfill failure');
    };
    expect(() => buildTranscriptHistoryPage({ room: 'eng', source: failing }))
      .toThrow('fixture backfill failure');
    expect(store.transcriptHistoryIndex.roomState('eng').complete).toBe(false);

    const retried = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(retried.page.units.some((unit) =>
      unit.kind !== 'message' && unit.root_message_id === rootId)).toBe(true);
    expect(store.transcriptHistoryIndex.roomState('eng').complete).toBe(true);
    store.close();
  });

  it('incrementally adopts ordinary, terminal, and deleted message mutations', () => {
    const { store, blobs, ownerId } = fixture();
    store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'initial' });
    buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });

    const ordinary = store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'new ordinary' });
    let page = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(page.page.messages.find((message) => message.id === ordinary.id)?.body)
      .toBe('new ordinary');
    expect(page.metrics.index_backfilled).toBe(false);

    const interaction = store.postMessage('eng', {
      author: ownerId,
      kind: 'ask',
      body: 'excluded interaction',
      ask: { interaction_id: 'indexed-interaction', kind: 'ask', prompt: 'Choose?' },
    });
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);
    page = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(page.page.messages.some((message) => message.id === interaction.id)).toBe(false);

    const rootId = finalizeRun({
      store,
      blobs,
      ownerId,
      events: [
        { type: 'run.item', item_type: 'text_block', output_message_id: ordinary.id + 1,
          payload: { text: 'terminal prose' } },
        { type: 'run.completed', status: 'completed', output_message_id: ordinary.id + 1 },
      ],
      finalText: 'terminal prose',
    });
    maintainIndexedTranscriptHistoryMessage({
      room: 'eng',
      message: store.getMessage('eng', rootId)!,
      source: source(store, blobs, true),
    });
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);
    page = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    expect(page.page.units.some((unit) =>
      unit.kind === 'prose' && unit.root_message_id === rootId)).toBe(true);

    store.deleteMessage('eng', ordinary.id);
    page = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, true) });
    const deleted = page.page.messages.find((message) => message.id === ordinary.id);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.body).toBe('');
    store.close();
  });

  it('bounds warmed Mac-shaped head and predecessor reads by selected evidence', () => {
    const { store, blobs, ownerId } = fixture();
    for (let index = 0; index < 1_200; index += 1) {
      store.postMessage('eng', {
        author: ownerId,
        kind: 'chat',
        body: `historical message ${String(index)} ${'x'.repeat(200)}`,
      });
    }
    const outputId = 1_201;
    const events = [
      ...Array.from({ length: 500 }, (_, index) => toolPair(index, outputId)).flat(),
      {
        type: 'run.item' as const,
        item_type: 'text_block' as const,
        output_message_id: outputId,
        payload: { text: 'newest prose' },
      },
      { type: 'run.completed' as const, status: 'completed' as const, output_message_id: outputId },
    ];
    finalizeRun({ store, blobs, ownerId, events, finalText: 'newest prose' });
    const indexedSource = source(store, blobs, true);
    const cold = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    const head = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    const predecessor = buildTranscriptHistoryPage({
      room: 'eng',
      cursor: head.page.before_cursor!,
      source: indexedSource,
    });
    console.info('[indexed-transcript-history-mac-shape]', JSON.stringify({
      cold: cold.metrics,
      head: head.metrics,
      predecessor: predecessor.metrics,
    }));

    expect(cold.metrics.message_records_read).toBeGreaterThanOrEqual(1_201);
    expect(head.metrics.selected_text_slots).toBe(20);
    expect(head.metrics.message_records_read).toBeLessThanOrEqual(22);
    expect(head.metrics.journal_events_scanned).toBe(events.length - 1);
    expect(head.metrics.index_rows_read).toBeLessThanOrEqual(head.page.units.length + 21);
    expect(predecessor.metrics.message_records_read).toBeLessThanOrEqual(20);
    expect(predecessor.metrics.journal_events_scanned).toBe(0);
    expect(predecessor.metrics.index_rows_read).toBeLessThanOrEqual(41);
    expect(head.metrics.duration_ms).toBeLessThan(8_000);
    expect(predecessor.metrics.duration_ms).toBeLessThan(8_000);
    store.close();
  });

  it('keeps the next page fixed-cost after 1,200 successful ordinary writes', () => {
    const { store, blobs, ownerId } = fixture();
    for (let index = 0; index < 25; index += 1) {
      store.postMessage('eng', { author: ownerId, kind: 'chat', body: `seed ${String(index)}` });
    }
    const indexedSource = source(store, blobs, true);
    buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    for (let index = 0; index < 1_200; index += 1) {
      store.postMessage('eng', {
        author: ownerId,
        kind: 'chat',
        body: `unattended ${String(index)}`,
      });
    }
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);

    const legacy = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, false) });
    const indexed = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    expect(indexed.page).toEqual(legacy.page);
    expect(indexed.metrics.index_backfilled).toBe(false);
    expect(indexed.metrics.message_records_read).toBe(21);
    expect(indexed.metrics.journal_events_scanned).toBe(0);
    expect(indexed.metrics.index_rows_read).toBeLessThanOrEqual(41);
    store.close();
  });

  it('matches legacy pages for every terminal family shape after eager maintenance', () => {
    const { store, blobs, ownerId } = fixture();
    store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'seed' });
    const indexedSource = source(store, blobs, true);
    buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });

    const maintain = (messageId: number): void => {
      const message = store.getMessage('eng', messageId)!;
      maintainIndexedTranscriptHistoryMessage({ room: 'eng', message, source: indexedSource });
      expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);
    };

    const completedId = store.latestMessageId('eng') + 1;
    const completed = finalizeRun({
      store,
      blobs,
      ownerId,
      finalText: 'first\n\nsecond',
      events: [
        { type: 'run.item', item_type: 'text_block', output_message_id: completedId,
          payload: { text: 'first' }, ts: '2026-08-28T00:00:00.100Z' },
        { type: 'run.item', item_type: 'text_block', output_message_id: completedId,
          payload: { text: 'second' }, ts: '2026-08-28T00:00:00.200Z' },
        { type: 'run.completed', status: 'completed', output_message_id: completedId },
      ],
    });
    maintain(completed);

    const failedId = store.latestMessageId('eng') + 1;
    const failed = finalizeRun({
      store,
      blobs,
      ownerId,
      status: 'failed',
      events: [{ type: 'run.completed', status: 'failed', output_message_id: failedId,
        error: 'failed fixture' }],
    });
    maintain(failed);

    const interruptedId = store.latestMessageId('eng') + 1;
    const interrupted = finalizeRun({
      store,
      blobs,
      ownerId,
      status: 'interrupted',
      events: [{ type: 'run.completed', status: 'interrupted', output_message_id: interruptedId,
        error: 'interrupted fixture' }],
    });
    maintain(interrupted);

    const toolId = store.latestMessageId('eng') + 1;
    const toolOnly = finalizeRun({
      store,
      blobs,
      ownerId,
      outputMode: false,
      events: [
        ...toolPair(99, toolId),
        { type: 'run.completed', status: 'completed', output_message_id: toolId },
      ],
    });
    maintain(toolOnly);

    const legacy = store.postMessage('eng', { author: ownerId, kind: 'run', body: '' });
    const legacyRef = `runs/${String(legacy.id)}.jsonl`;
    store.updateMessage('eng', legacy.id, {
      run: {
        status: 'running',
        started_ts: new Date(Date.now() - 2_000).toISOString(),
        tool_calls: 0,
        events_ref: legacyRef,
      },
    });
    const interjection = store.postMessage('eng', {
      author: ownerId, kind: 'chat', body: 'legacy interjection',
    });
    const interjectionTime = Date.parse(interjection.ts);
    blobs.append('eng', legacyRef, {
      type: 'run.item', item_type: 'text_block',
      payload: { text: 'legacy before' }, ts: new Date(interjectionTime - 1_000).toISOString(),
    });
    blobs.append('eng', legacyRef, {
      type: 'run.item', item_type: 'text_block',
      payload: { text: 'legacy after' }, ts: new Date(interjectionTime + 1_000).toISOString(),
    });
    blobs.append('eng', legacyRef, {
      type: 'run.completed', status: 'completed',
    });
    const legacyTerminal = store.updateMessage('eng', legacy.id, {
      body: 'legacy before\n\nlegacy after',
      run: {
        ...store.getMessage('eng', legacy.id)!.run!,
        status: 'completed',
        ended_ts: new Date(Date.now() + 2_000).toISOString(),
        result_message_id: legacy.id,
        final_text: 'legacy before\n\nlegacy after',
      },
    });
    maintainIndexedTranscriptHistoryMessage({
      room: 'eng', message: legacyTerminal, source: indexedSource,
    });
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);

    const modern = store.postMessage('eng', { author: ownerId, kind: 'run', body: '' });
    store.updateMessage('eng', modern.id, {
      run: {
        status: 'running',
        started_ts: '2026-08-28T00:01:00.000Z',
        tool_calls: 0,
        events_ref: `runs/${String(modern.id)}.jsonl`,
        output_mode: 'messages',
      },
    });
    const continuation = store.createRunContinuation('eng', modern.id);
    const modernEvents: WireEvent[] = [
      { type: 'run.item', item_type: 'text_delta', output_message_id: modern.id,
        payload: { text: 'root' }, ts: '2026-08-28T00:01:00.100Z' },
      ...toolPair(100, continuation.id).map((event) => ({ ...event, output_message_id: continuation.id })),
      { type: 'run.item', item_type: 'text_block', output_message_id: continuation.id,
        payload: { text: 'continuation' }, ts: '2026-08-28T00:01:00.200Z' },
      { type: 'run.completed', status: 'completed', output_message_id: continuation.id },
    ];
    const modernRef = store.getMessage('eng', modern.id)!.run!.events_ref;
    for (const event of modernEvents) blobs.append('eng', modernRef, event);
    store.updateMessage('eng', continuation.id, { body: 'continuation' });
    const modernTerminal = store.updateMessage('eng', modern.id, {
      body: 'root',
      run: {
        ...store.getMessage('eng', modern.id)!.run!,
        status: 'completed',
        ended_ts: '2026-08-28T00:01:01.000Z',
        result_message_id: continuation.id,
        final_text: 'continuation',
      },
    });
    maintainIndexedTranscriptHistoryMessage({
      room: 'eng', message: modernTerminal, source: indexedSource,
    });
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);

    const deleted = store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'delete me' });
    store.deleteMessage('eng', deleted.id);
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);

    const legacyPage = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, false) });
    const indexed = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    expect(indexed.page).toEqual(legacyPage.page);
    expect(indexed.page.units.filter((unit) => unit.kind === 'settled_tail')).toHaveLength(2);
    expect(indexed.page.units.some((unit) => unit.kind === 'tool')).toBe(true);
    expect(indexed.page.units.some((unit) =>
      unit.kind === 'prose' && unit.output_message_id === continuation.id)).toBe(true);
    expect(indexed.page.messages.find((message) => message.id === deleted.id)?.deleted).toBe(true);
    store.close();
  });

  it('preserves legacy timestamp interleaving before any continuation chronology floor', () => {
    const { store, blobs, ownerId } = fixture();
    store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'seed' });
    const indexedSource = source(store, blobs, true);
    buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });

    const root = store.postMessage('eng', { author: ownerId, kind: 'run', body: '' });
    const eventsRef = `runs/${String(root.id)}.jsonl`;
    store.updateMessage('eng', root.id, {
      run: {
        status: 'running',
        started_ts: new Date(Date.now() - 2_000).toISOString(),
        tool_calls: 0,
        events_ref: eventsRef,
      },
    });
    const interjection = store.postMessage('eng', {
      author: ownerId, kind: 'chat', body: 'legacy interjection',
    });
    const interjectionTime = Date.parse(interjection.ts);
    blobs.append('eng', eventsRef, {
      type: 'run.item', item_type: 'text_block',
      payload: { text: 'before' }, ts: new Date(interjectionTime - 1_000).toISOString(),
    });
    blobs.append('eng', eventsRef, {
      type: 'run.item', item_type: 'text_block',
      payload: { text: 'after' }, ts: new Date(interjectionTime + 1_000).toISOString(),
    });
    blobs.append('eng', eventsRef, { type: 'run.completed', status: 'completed' });
    const terminal = store.updateMessage('eng', root.id, {
      body: 'before\n\nafter',
      run: {
        ...store.getMessage('eng', root.id)!.run!,
        status: 'completed',
        ended_ts: new Date(interjectionTime + 2_000).toISOString(),
        result_message_id: root.id,
        final_text: 'before\n\nafter',
      },
    });
    maintainIndexedTranscriptHistoryMessage({ room: 'eng', message: terminal, source: indexedSource });

    const legacy = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, false) });
    const indexed = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    expect(indexed.page).toEqual(legacy.page);
    const prose = indexed.page.units
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => unit.kind === 'prose' && unit.root_message_id === root.id);
    const interjected = indexed.page.units.findIndex((unit) =>
      unit.kind === 'message' && unit.message_id === interjection.id);
    expect(prose).toHaveLength(2);
    expect(prose[0]!.index).toBeLessThan(interjected);
    expect(interjected).toBeLessThan(prose[1]!.index);
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);
    store.close();
  });

  it('re-keys earlier indexed rows when the first permanent continuation floor finalizes', () => {
    const { store, blobs, ownerId } = fixture();
    const seed = store.postMessage('eng', { author: ownerId, kind: 'chat', body: 'seed' });
    const indexedSource = source(store, blobs, true);
    buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    expect(store.transcriptHistoryIndex.roomState('eng').continuationFloor).toBeUndefined();

    const root = store.postMessage('eng', { author: ownerId, kind: 'run', body: '' });
    const eventsRef = `runs/${String(root.id)}.jsonl`;
    store.updateMessage('eng', root.id, {
      run: {
        status: 'running',
        started_ts: '2026-08-28T00:00:00.000Z',
        tool_calls: 0,
        events_ref: eventsRef,
        output_mode: 'messages',
      },
    });
    const interjection = store.postMessage('eng', {
      author: ownerId, kind: 'chat', body: 'between permanent outputs',
    });
    const continuation = store.createRunContinuation('eng', root.id);
    const events: WireEvent[] = [
      { type: 'run.item', item_type: 'text_block', output_message_id: root.id,
        payload: { text: 'root prose' }, ts: '2026-08-28T00:00:00.100Z' },
      { type: 'run.item', item_type: 'text_block', output_message_id: continuation.id,
        payload: { text: 'continuation prose' }, ts: '2026-08-28T00:00:00.200Z' },
      { type: 'run.completed', status: 'completed', output_message_id: continuation.id },
    ];
    for (const event of events) blobs.append('eng', eventsRef, event);
    store.updateMessage('eng', continuation.id, { body: 'continuation prose' });
    const terminal = store.updateMessage('eng', root.id, {
      body: 'root prose',
      run: {
        ...store.getMessage('eng', root.id)!.run!,
        status: 'completed',
        ended_ts: '2026-08-28T00:00:01.000Z',
        result_message_id: continuation.id,
        final_text: 'root prose\n\ncontinuation prose',
      },
    });
    maintainIndexedTranscriptHistoryMessage({ room: 'eng', message: terminal, source: indexedSource });

    const legacy = buildTranscriptHistoryPage({ room: 'eng', source: source(store, blobs, false) });
    const indexed = buildTranscriptHistoryPage({ room: 'eng', source: indexedSource });
    expect(indexed.page).toEqual(legacy.page);
    expect(indexed.page.units.map((unit) => unit.kind === 'message'
      ? `message:${String(unit.message_id)}`
      : `${unit.kind}:${String(unit.output_message_id)}`)).toEqual([
      `message:${String(seed.id)}`,
      `prose:${String(root.id)}`,
      `message:${String(interjection.id)}`,
      `prose:${String(continuation.id)}`,
    ]);
    expect(indexed.page.messages.some((message) => message.id === continuation.id)).toBe(true);
    expect(indexed.metrics.index_backfilled).toBe(false);
    expect(indexed.metrics.message_records_read).toBeLessThanOrEqual(5);
    expect(store.transcriptHistoryIndex.roomState('eng').continuationFloor).toBe(root.id);
    expect(store.transcriptHistoryIndex.dirtyMessageIds('eng')).toEqual([]);
    store.close();
  });
});
// harn:end indexed-transcript-pages-read-only-current-selected-evidence
// harn:end transcript-history-index-is-write-maintained-and-rebuildable
