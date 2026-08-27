import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from './blobs.js';
import { Store } from './store.js';
import {
  buildTranscriptHistoryPage,
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
      status: 'completed',
      started_ts: '2026-08-28T00:00:00.000Z',
      ended_ts: '2026-08-28T00:00:01.000Z',
      tool_calls: opts.events.filter((event) =>
        event.type === 'run.item' && event.item_type === 'tool_call').length,
      events_ref: ref,
      output_mode: 'messages',
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

// harn:assume transcript-history-index-is-derived-and-rebuildable ref=transcript-history-index-regression
// harn:assume indexed-transcript-pages-read-only-selected-evidence ref=indexed-transcript-page-regression
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
});
// harn:end indexed-transcript-pages-read-only-selected-evidence
// harn:end transcript-history-index-is-derived-and-rebuildable
