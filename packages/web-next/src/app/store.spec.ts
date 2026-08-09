import type { Message, Room, ServerFrame, TranscriptHistoryUnit } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HISTORY_PAGE_SIZE,
  createClientStore,
  resetClientStoreForTest,
  roomSlice,
  useClientStore,
} from './store.js';

const room = (id: string): Room => ({
  id,
  name: id.toUpperCase(),
  created_ts: '2026-07-18T00:00:00.000Z',
  config: {
    turn_brake: null,
    spend_brake_usd: null,
    stall_minutes: 30,
    redaction_enabled: true,
    bridged: false,
  },
});

const message = (roomId: string, id: number): Message => ({
  room: roomId,
  id,
  seq: id,
  ts: `2026-07-18T00:00:${String(id).padStart(2, '0')}.000Z`,
  author: `${roomId}-human`,
  kind: 'chat',
  body: `${roomId} message ${id}`,
  mentions: [],
  refs: [],
  ledger_refs: [],
  deleted: false,
  ack: false,
  pinned: false,
});

const frame = (value: unknown): ServerFrame => value as ServerFrame;

afterEach(resetClientStoreForTest);

describe('room-keyed client state', () => {
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-client-error-correlation
  it('counts action errors by ref without changing the human-visible error list', () => {
    const store = useClientStore.getState();
    store.applyFrame(frame({ type: 'error', message: 'compact failed', ref: 'compact_member' }), 'eng');
    store.applyFrame(frame({ type: 'error', message: 'reset failed', ref: 'clear_member_context' }), 'eng');
    store.applyFrame(frame({ type: 'error', message: 'another reset failure', ref: 'clear_member_context' }), 'eng');
    store.applyFrame(frame({ type: 'error', message: 'uncorrelated' }), 'eng');

    expect(roomSlice(useClientStore.getState(), 'eng')).toMatchObject({
      errors: ['compact failed', 'reset failed', 'another reset failure', 'uncorrelated'],
      errorRefs: { compact_member: 1, clear_member_context: 2 },
    });
  });
  // harn:end member-context-reset-is-authorized-atomic-and-lazy

  it('keeps same-named room hydration staging isolated across computer stores', () => {
    const a = createClientStore();
    const b = createClientStore();
    a.getState().applyFrame(frame({ type: 'self', room: 'shared', member_id: 'human-a' }));
    b.getState().applyFrame(frame({ type: 'self', room: 'shared', member_id: 'human-b' }));
    a.getState().applyFrame(frame({ type: 'room', seq: 0, room: { ...room('shared'), name: 'Room A' } }));
    b.getState().applyFrame(frame({ type: 'room', seq: 0, room: { ...room('shared'), name: 'Room B' } }));
    a.getState().applyFrame(frame({ type: 'message', seq: 1, message: { ...message('shared', 1), body: 'A only' } }));
    b.getState().applyFrame(frame({ type: 'message', seq: 1, message: { ...message('shared', 1), body: 'B only' } }));
    a.getState().applyFrame(frame({ type: 'sync_complete', room: 'shared', seq: 1 }));
    b.getState().applyFrame(frame({ type: 'sync_complete', room: 'shared', seq: 1 }));

    expect(roomSlice(a.getState(), 'shared')).toMatchObject({
      selfMemberId: 'human-a',
      room: { name: 'Room A' },
      messages: { 1: { body: 'A only' } },
    });
    expect(roomSlice(b.getState(), 'shared')).toMatchObject({
      selfMemberId: 'human-b',
      room: { name: 'Room B' },
      messages: { 1: { body: 'B only' } },
    });
  });

  it('commits concurrent room snapshots independently and does not wait for support', () => {
    const store = useClientStore.getState();
    store.applyFrame(frame({ type: 'self', room: 'alpha', member_id: 'alpha-human' }));
    store.applyFrame(frame({ type: 'self', room: 'beta', member_id: 'beta-human' }));
    store.applyFrame(frame({ type: 'room', seq: 0, room: room('alpha') }));
    store.applyFrame(frame({ type: 'room', seq: 0, room: room('beta') }));
    store.applyFrame(frame({ type: 'message', seq: 0, message: message('alpha', 1) }));
    store.applyFrame(frame({ type: 'message', seq: 0, message: message('beta', 8) }));

    expect(roomSlice(useClientStore.getState(), 'alpha').hydrated).toBe(false);
    expect(roomSlice(useClientStore.getState(), 'beta').messages).toEqual({});

    store.applyFrame(frame({ type: 'sync_complete', room: 'beta', seq: 9, history_floor: 8 }));
    expect(roomSlice(useClientStore.getState(), 'beta')).toMatchObject({
      hydrated: true,
      selfMemberId: 'beta-human',
      seq: 9,
      historyCursor: 8,
      support: undefined,
    });
    expect(Object.keys(roomSlice(useClientStore.getState(), 'beta').messages)).toEqual(['8']);
    expect(roomSlice(useClientStore.getState(), 'alpha').hydrated).toBe(false);

    store.applyFrame(frame({ type: 'sync_complete', room: 'alpha', seq: 2, history_floor: 1 }));
    expect(Object.keys(roomSlice(useClientStore.getState(), 'alpha').messages)).toEqual(['1']);
  });

  it('keeps an inactive room at a rolling twenty-message tail', () => {
    const store = useClientStore.getState();
    store.setActiveRoom('alpha');
    store.applyFrame(frame({ type: 'self', room: 'beta', member_id: 'beta-human' }));
    store.applyFrame(frame({ type: 'room', seq: 0, room: room('beta') }));
    store.applyFrame(frame({ type: 'sync_complete', room: 'beta', seq: 1 }));
    for (let id = 1; id <= HISTORY_PAGE_SIZE + 5; id += 1) {
      store.applyFrame(frame({ type: 'message', seq: id + 1, message: message('beta', id) }));
    }

    const beta = roomSlice(useClientStore.getState(), 'beta');
    expect(Object.keys(beta.messages).map(Number)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(Math.min(...Object.keys(beta.messages).map(Number))).toBe(6);
    expect(beta.historyCursor).toBe(6);
  });

  it('keeps a live delta that races ahead of an addressed snapshot', () => {
    const store = useClientStore.getState();
    store.setActiveRoom('alpha');
    store.applyFrame(frame({ type: 'message', seq: 12, message: message('alpha', 12) }));
    store.applyFrame(frame({ type: 'self', room: 'alpha', member_id: 'alpha-human' }));
    store.applyFrame(frame({ type: 'room', seq: 10, room: room('alpha') }));
    store.applyFrame(frame({ type: 'message', seq: 10, message: message('alpha', 10) }));
    store.applyFrame(frame({ type: 'sync_complete', room: 'alpha', seq: 10, history_floor: 10 }));

    const alpha = roomSlice(useClientStore.getState(), 'alpha');
    expect(alpha.hydrated).toBe(true);
    expect(alpha.seq).toBe(12);
    expect(Object.keys(alpha.messages)).toEqual(['10', '12']);
  });

  // harn:assume paged-history-live-message-reconciliation ref=live-history-pin-delete-regression
  it('reconciles pin, unpin, and deletion frames into a materialized history row', () => {
    const store = useClientStore.getState();
    store.setActiveRoom('eng');
    const units: TranscriptHistoryUnit[] = [{ kind: 'message', message_id: 5 }];
    store.updateTranscriptHistory('eng', (history) => ({
      ...history,
      initialized: true,
      messages: { 5: message('eng', 5) },
      units,
    }));

    store.applyFrame(frame({
      type: 'message',
      seq: 6,
      message: { ...message('eng', 5), seq: 6, pinned: true },
    }));
    expect(roomSlice(useClientStore.getState(), 'eng').transcriptHistory.messages[5])
      .toMatchObject({ seq: 6, pinned: true });
    expect(roomSlice(useClientStore.getState(), 'eng').transcriptHistory.units).toEqual(units);

    store.applyFrame(frame({
      type: 'message',
      seq: 7,
      message: { ...message('eng', 5), seq: 7, pinned: false },
    }));
    expect(roomSlice(useClientStore.getState(), 'eng').transcriptHistory.messages[5])
      .toMatchObject({ seq: 7, pinned: false });

    store.applyFrame(frame({
      type: 'message',
      seq: 8,
      message: { ...message('eng', 5), seq: 8, deleted: true, pinned: false },
    }));
    const history = roomSlice(useClientStore.getState(), 'eng').transcriptHistory;
    expect(history.messages[5]).toMatchObject({ seq: 8, deleted: true, pinned: false });
    expect(history.units).toEqual(units);
  });
  // harn:end paged-history-live-message-reconciliation

  it('drops background evidence and clears a live buffer on demotion', () => {
    const store = useClientStore.getState();
    store.setActiveRoom('alpha');
    store.applyFrame(frame({
      type: 'run_event', room: 'alpha', message_id: 4, index: 0,
      event: { type: 'run.item', item_type: 'text_delta', payload: { text: 'alpha' } },
    }));
    expect(roomSlice(useClientStore.getState(), 'alpha').runEvents[4]?.events).toHaveLength(1);

    store.setActiveRoom('beta');
    expect(roomSlice(useClientStore.getState(), 'alpha').runEvents).toEqual({});
    store.applyFrame(frame({
      type: 'run_event', room: 'alpha', message_id: 4, index: 1,
      event: { type: 'run.item', item_type: 'text_delta', payload: { text: 'stale' } },
    }));
    expect(roomSlice(useClientStore.getState(), 'alpha').runEvents).toEqual({});
  });
});

describe('resubscribe preserves a hydrated, paged room', () => {
  it('keeps paged-in rows, the cursor, and support across a second sync', () => {
    const store = useClientStore.getState();
    // ACTIVE room: without this the room is background traffic, and the rolling
    // tail correctly trims it — which is the intended behaviour for an inactive
    // room, not the warm-resubscribe contract under test here.
    store.setActiveRoom('eng');
    // Hydrate the bounded tail, then page one window backwards — the state a
    // resume finds when an operator has scrolled through history.
    store.applyFrame(frame({ type: 'self', member_id: 'me' }), 'eng');
    store.applyFrame(frame({ type: 'room', seq: 0, room: room('eng') }), 'eng');
    for (let id = 21; id <= 40; id++) {
      store.applyFrame(frame({ type: 'message', seq: id, message: message('eng', id) }), 'eng');
    }
    store.applyFrame(frame({ type: 'sync_complete', seq: 40, history_floor: 21 }), 'eng');
    store.mergeHistoryPage('eng', Array.from({ length: 20 }, (_, index) => message('eng', index + 1)));

    const paged = roomSlice(useClientStore.getState(), 'eng');
    const pagedCursor = paged.historyCursor;
    // Whatever floor convention the store uses, paging must have moved the
    // cursor back and brought the older rows in.
    expect(pagedCursor).toBeLessThanOrEqual(21);
    expect(paged.messages[1]).toBeDefined();
    expect(Object.keys(paged.messages)).toHaveLength(40);

    // A resume resubscribes from the committed cursor and completes again.
    // Nothing about that is a fresh hydration, so nothing may be discarded.
    const resumed = useClientStore.getState();
    resumed.applyFrame(frame({ type: 'self', member_id: 'me' }), 'eng');
    resumed.applyFrame(frame({ type: 'message', seq: 41, message: message('eng', 41) }), 'eng');
    resumed.applyFrame(frame({ type: 'sync_complete', seq: 41 }), 'eng');

    const after = roomSlice(useClientStore.getState(), 'eng');
    expect(after.historyCursor).toBe(pagedCursor); // the operator's paging survived
    expect(after.messages[1]).toBeDefined(); // ...including the oldest paged row
    expect(after.messages[41]).toBeDefined(); // ...and the row that arrived while away
    expect(after.seq).toBe(41);
  });
});

describe('managed room-summary initialization', () => {
  it('distinguishes an authoritative empty load from an uninitialized store', () => {
    expect(useClientStore.getState().roomSummariesLoaded).toBe(false);
    useClientStore.getState().setRoomSummaries([]);
    expect(useClientStore.getState().roomSummaries).toEqual([]);
    expect(useClientStore.getState().roomSummariesLoaded).toBe(true);
  });
});

// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-state
describe('worktree group state', () => {
  const record = (id: string, alias: string, primary: boolean) => ({
    id,
    repository_id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
    room: 'eng',
    conversation_id: primary ? 'eng' : `wt-${id.toLowerCase()}`,
    alias,
    path: '/repo',
    git_admin_id: '/repo/.git',
    primary,
    source: primary ? 'main' as const : 'adopted' as const,
    lifecycle: 'active' as const,
    availability: 'available' as const,
    locked: false,
    registered_ts: '2026-08-07T00:00:00.000Z',
    updated_ts: '2026-08-07T00:00:00.000Z',
  });

  it('keeps the last successful root-scoped registration set per root', () => {
    useClientStore.getState().setWorktreeGroup('eng', {
      repositoryId: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
      registered: [record('01ARZ3NDEKTSV4RRFFQ69G5FAB', 'main', true)],
    });
    useClientStore.getState().setWorktreeGroup('eng', {
      registered: [
        record('01ARZ3NDEKTSV4RRFFQ69G5FAB', 'main', true),
        record('01ARZ3NDEKTSV4RRFFQ69G5FAC', 'review', false),
      ],
    });
    const group = useClientStore.getState().worktreeGroups.eng!;
    expect(group.registered.map((worktree) => worktree.alias)).toEqual(['main', 'review']);
    // A refresh without a repository id retains the last-good one.
    expect(group.repositoryId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAA');
    expect(group.loaded).toBe(true);
    // Other roots are untouched.
    expect(useClientStore.getState().worktreeGroups.ops).toBeUndefined();

    useClientStore.getState().reset();
    expect(useClientStore.getState().worktreeGroups).toEqual({});
  });

  it('tracks current-generation live evidence separately from retained room slices', () => {
    // A retained hydrated slice is last-good content, never readiness: only an
    // explicit live mark counts, and a generation reset withdraws exactly the
    // listed rooms without touching the slices.
    useClientStore.setState({
      rooms: {
        eng: { ...roomSlice(useClientStore.getState(), 'eng'), hydrated: true },
        'wt-a': { ...roomSlice(useClientStore.getState(), 'wt-a'), hydrated: true },
      },
    } as never);
    expect(useClientStore.getState().roomLive).toEqual({});

    useClientStore.getState().markRoomLive('eng');
    useClientStore.getState().markRoomLive('wt-a');
    expect(useClientStore.getState().roomLive).toEqual({ eng: true, 'wt-a': true });

    useClientStore.getState().markRoomsConnecting(['wt-a']);
    expect(useClientStore.getState().roomLive).toEqual({ eng: true });
    expect(useClientStore.getState().rooms['wt-a']?.hydrated).toBe(true);

    useClientStore.getState().reset();
    expect(useClientStore.getState().roomLive).toEqual({});
  });
});
// harn:end registered-worktree-navigation-is-promotion-gated
