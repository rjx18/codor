import type { Message, Room, ServerFrame } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HISTORY_PAGE_SIZE,
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
