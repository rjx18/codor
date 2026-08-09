import type { Message, TranscriptHistoryPage, TranscriptHistoryUnit } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@runtime/api.js', () => ({ fetchTranscriptHistory: api.fetch }));

import {
  createClientStore,
  mirrorClientStore,
  resetClientStoreForTest,
  roomSlice,
  type TranscriptHistoryState,
  useClientStore,
} from '../app/store.js';
import {
  ensureTranscriptHistory,
  mergeTranscriptPages,
  refreshTranscriptHistoryHead,
  revealTranscriptTarget,
  targetMaterialized,
  transcriptUnitKey,
} from './transcript-history.js';

const TS = '2026-08-08T00:00:00.000Z';
const message = (id: number, kind: Message['kind'] = 'chat'): Message => ({
  id,
  room: 'same',
  author: kind === 'run' ? 'agent' : 'human',
  kind,
  body: `message ${String(id)}`,
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: TS,
  seq: id,
  ...(kind === 'run' && {
    run: {
      status: 'completed' as const,
      started_ts: TS,
      ended_ts: TS,
      tool_calls: 0,
      events_ref: `runs/${String(id)}.jsonl`,
    },
  }),
});

const messageUnit = (id: number): TranscriptHistoryUnit => ({ kind: 'message', message_id: id });
const proseUnit = (root: number, output: number, index: number): TranscriptHistoryUnit => ({
  kind: 'prose', root_message_id: root, output_message_id: output, event_indices: [index],
});
const page = (
  units: TranscriptHistoryUnit[],
  messages: Message[],
  cursor: string | null,
  hasMore = cursor !== null,
): TranscriptHistoryPage => ({
  units,
  messages,
  journals: [],
  before_cursor: cursor,
  has_more: hasMore,
});

const emptyHistory = (): TranscriptHistoryState => ({
  initialized: false,
  loadingHead: false,
  loadingCursor: undefined,
  failed: false,
  coldMessageIds: undefined,
  messages: {},
  journals: {},
  units: [],
  beforeCursor: undefined,
  hasMore: true,
});

beforeEach(() => api.fetch.mockReset());
afterEach(resetClientStoreForTest);

// harn:assume transcript-history-prepends-one-deliberate-page ref=deliberate-history-top-reach-regression
describe('combined transcript page merging', () => {
  it('keeps stable unit identities when an older page extends the same output row', () => {
    const current = mergeTranscriptPages(
      emptyHistory(),
      [page([proseUnit(1, 1, 20)], [message(1, 'run')], 'older')],
      'head',
    );
    const merged = mergeTranscriptPages(
      current,
      [page([proseUnit(1, 1, 10)], [message(1, 'run')], null)],
      'older',
    );
    expect(merged.units.map(transcriptUnitKey)).toEqual([
      'prose:1:1:10',
      'prose:1:1:20',
    ]);
  });
});
// harn:end transcript-history-prepends-one-deliberate-page

// harn:assume transcript-targets-walk-combined-pages ref=combined-history-target-regression
describe('combined transcript target walking', () => {
  it('does not treat a context-only complete message as a revealed target', async () => {
    const store = createClientStore();
    store.getState().setActiveRoom('same');
    api.fetch
      .mockResolvedValueOnce(page([messageUnit(9)], [message(5), message(9)], 'next'))
      .mockResolvedValueOnce(page([messageUnit(5)], [message(5)], null));

    expect(await revealTranscriptTarget(store, 'same', 5, () => 'token')).toBe(true);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(targetMaterialized(roomSlice(store.getState(), 'same').transcriptHistory, 5)).toBe(true);
  });

  it('allows a lifecycle root to resolve to a visible family unit', () => {
    const history = mergeTranscriptPages(
      emptyHistory(),
      [page([proseUnit(4, 6, 1)], [message(4, 'run'), { ...message(6, 'run'), run_parent_id: 4 }], null)],
      'head',
    );
    expect(targetMaterialized(history, 4)).toBe(true);
    expect(targetMaterialized(history, 6)).toBe(true);
  });
});
// harn:end transcript-targets-walk-combined-pages

// harn:assume missed-terminal-history-refreshes-through-combined-head ref=combined-history-head-regression
describe('combined transcript head recovery', () => {
  it('keeps a failed initial head uninitialized and retries it honestly', async () => {
    const store = createClientStore();
    store.getState().setActiveRoom('same');
    api.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await ensureTranscriptHistory(store, 'same', () => 'token')).toBe(false);
    expect(roomSlice(store.getState(), 'same').transcriptHistory).toMatchObject({
      initialized: false,
      failed: true,
      beforeCursor: undefined,
      hasMore: true,
    });

    api.fetch.mockResolvedValueOnce(page([], [], null, false));
    expect(await ensureTranscriptHistory(store, 'same', () => 'token')).toBe(true);
    expect(roomSlice(store.getState(), 'same').transcriptHistory).toMatchObject({
      initialized: true,
      failed: false,
      beforeCursor: null,
      hasMore: false,
    });
  });

  it('captures cold WebSocket ids once while later live arrivals remain outside the cold snapshot', async () => {
    const store = createClientStore();
    store.getState().setActiveRoom('same');
    store.getState().applyFrame({
      type: 'message',
      seq: 1,
      message: message(1),
    });
    let release!: (value: TranscriptHistoryPage) => void;
    api.fetch.mockImplementationOnce(() => new Promise<TranscriptHistoryPage>((resolve) => { release = resolve; }));

    const pending = ensureTranscriptHistory(store, 'same', () => 'token');
    store.getState().applyFrame({
      type: 'message',
      seq: 2,
      message: message(2),
    });
    expect(roomSlice(store.getState(), 'same').transcriptHistory.coldMessageIds)
      .toEqual({ 1: true });
    release(page([messageUnit(1)], [message(1)], null, false));
    await pending;
  });

  it('deduplicates reconnect signals and bridges to overlap without discarding older pages', async () => {
    const store = createClientStore();
    store.getState().setActiveRoom('same');
    store.getState().updateTranscriptHistory('same', (history) => mergeTranscriptPages(
      history,
      [page([messageUnit(1), messageUnit(2)], [message(1), message(2)], null, false)],
      'head',
    ));
    let release!: (value: TranscriptHistoryPage) => void;
    api.fetch
      .mockImplementationOnce(() => new Promise<TranscriptHistoryPage>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(page([messageUnit(2), messageUnit(3)], [message(2), message(3)], null, false));

    const first = refreshTranscriptHistoryHead(store, 'same', () => 'token');
    const duplicate = refreshTranscriptHistoryHead(store, 'same', () => 'token');
    expect(first).toBe(duplicate);
    release(page([messageUnit(3), messageUnit(4)], [message(3), message(4)], 'bridge'));
    await first;

    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(roomSlice(store.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey))
      .toEqual(['message:1', 'message:2', 'message:3', 'message:4']);
  });

  it('preserves rendered history after failure and permits a later retry', async () => {
    const store = createClientStore();
    store.getState().setActiveRoom('same');
    store.getState().updateTranscriptHistory('same', (history) => mergeTranscriptPages(
      history,
      [page([messageUnit(1)], [message(1)], null, false)],
      'head',
    ));
    api.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await refreshTranscriptHistoryHead(store, 'same', () => 'token')).toBe(false);
    expect(roomSlice(store.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey))
      .toEqual(['message:1']);
    expect(roomSlice(store.getState(), 'same').transcriptHistory.failed).toBe(true);

    api.fetch.mockResolvedValueOnce(page([messageUnit(1), messageUnit(2)], [message(1), message(2)], null, false));
    expect(await refreshTranscriptHistoryHead(store, 'same', () => 'token')).toBe(true);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps identical room ids isolated by source store and credential', async () => {
    const a = createClientStore();
    const b = createClientStore();
    a.getState().setActiveRoom('same');
    b.getState().setActiveRoom('same');
    api.fetch
      .mockResolvedValueOnce(page([messageUnit(1)], [message(1)], null, false))
      .mockResolvedValueOnce(page([messageUnit(2)], [message(2)], null, false));
    await Promise.all([
      refreshTranscriptHistoryHead(a, 'same', () => 'token-a'),
      refreshTranscriptHistoryHead(b, 'same', () => 'token-b'),
    ]);
    expect(roomSlice(a.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey)).toEqual(['message:1']);
    expect(roomSlice(b.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey)).toEqual(['message:2']);
    expect(api.fetch.mock.calls.map((call) => call[2]?.token)).toEqual(['token-a', 'token-b']);
  });
});
// harn:end missed-terminal-history-refreshes-through-combined-head

// harn:assume finalized-browser-history-is-combined-page-owned ref=captured-history-source-regression
// harn:assume hosted-computer-sessions-keep-state-isolated ref=captured-history-source-regression
describe('captured transcript history source', () => {
  it('keeps an unresolved mirrored request on A after switching to same-room B', async () => {
    const a = createClientStore();
    const b = createClientStore();
    a.getState().setActiveRoom('same');
    b.getState().setActiveRoom('same');
    let releaseA!: (value: TranscriptHistoryPage) => void;
    api.fetch.mockImplementation((_room, _cursor, options) => {
      if (options?.token === 'token-a') {
        return new Promise<TranscriptHistoryPage>((resolve) => { releaseA = resolve; });
      }
      return Promise.resolve(page([messageUnit(2)], [message(2)], null, false));
    });

    mirrorClientStore(a);
    const pendingA = refreshTranscriptHistoryHead(useClientStore, 'same', () => 'token-a');
    mirrorClientStore(b);
    const pendingB = refreshTranscriptHistoryHead(useClientStore, 'same', () => 'token-b');
    await pendingB;
    releaseA(page([messageUnit(1)], [message(1)], null, false));
    await pendingA;

    expect(roomSlice(a.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey))
      .toEqual(['message:1']);
    expect(roomSlice(b.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey))
      .toEqual(['message:2']);
    expect(api.fetch.mock.calls.map((call) => call[2]?.token))
      .toEqual(['token-a', 'token-b']);
  });

  // harn:assume transcript-targets-walk-combined-pages ref=captured-history-target-regression
  it('keeps a target walk on its admitted source after the mirror switches', async () => {
    const a = createClientStore();
    const b = createClientStore();
    a.getState().setActiveRoom('same');
    b.getState().setActiveRoom('same');
    let releaseHead!: (value: TranscriptHistoryPage) => void;
    api.fetch
      .mockImplementationOnce(() => new Promise<TranscriptHistoryPage>((resolve) => { releaseHead = resolve; }))
      .mockResolvedValueOnce(page([messageUnit(5)], [message(5)], null, false));

    mirrorClientStore(a);
    const pending = revealTranscriptTarget(useClientStore, 'same', 5, () => 'token-a');
    mirrorClientStore(b);
    releaseHead(page([messageUnit(9)], [message(5), message(9)], 'older'));

    expect(await pending).toBe(true);
    expect(roomSlice(a.getState(), 'same').transcriptHistory.units.map(transcriptUnitKey))
      .toEqual(['message:5', 'message:9']);
    expect(roomSlice(b.getState(), 'same').transcriptHistory.units).toEqual([]);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(api.fetch.mock.calls.map((call) => call[2]?.token))
      .toEqual(['token-a', 'token-a']);
  });
  // harn:end transcript-targets-walk-combined-pages
});
// harn:end hosted-computer-sessions-keep-state-isolated
// harn:end finalized-browser-history-is-combined-page-owned

// harn:assume paged-history-live-message-reconciliation ref=page-message-race-regression
describe('paged history message reconciliation', () => {
  it('does not let an older page restore a stale live mutation', () => {
    const current = mergeTranscriptPages(
      emptyHistory(),
      [page([messageUnit(5)], [message(5)], 'older')],
      'head',
    );
    const live = { ...message(5), seq: 50, pinned: true, deleted: false };
    const withLive = { ...current, messages: { ...current.messages, 5: live } };
    const stalePage = page(
      [messageUnit(5)],
      [{ ...message(5), seq: 40, pinned: false, deleted: false }],
      null,
      false,
    );

    const merged = mergeTranscriptPages(withLive, [stalePage], 'older');

    expect(merged.messages[5]).toEqual(live);
    expect(merged.units).toEqual(current.units);
  });
});
// harn:end paged-history-live-message-reconciliation
