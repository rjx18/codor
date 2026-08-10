// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  deleteLastGoodRoom,
  loadLastGoodRoom,
  saveLastGoodRoom,
  snapshotLastGoodRoom,
  type LastGoodRoomSnapshot,
  type LastGoodRoomStorage,
} from './last-good-room.js';
import { createClientStore } from '../app/store.js';

const snapshot = (computerId: string, room: string): LastGoodRoomSnapshot => ({
  version: 1,
  computerId,
  room: {
    id: room,
    name: `Room ${computerId}`,
    created_ts: '2026-08-10T00:00:00.000Z',
    config: {
      turn_brake: null,
      spend_brake_usd: null,
      stall_minutes: 30,
      redaction_enabled: true,
      bridged: false,
    },
  },
  summaries: [{
    id: room,
    name: `Room ${computerId}`,
    created_ts: '2026-08-10T00:00:00.000Z',
    working: false,
    attention: false,
    unread: 0,
  }],
  history: {
    messages: {},
    journals: {},
    units: [],
    beforeCursor: null,
    hasMore: false,
  },
  savedAt: '2026-08-10T00:00:00.000Z',
});

const memoryStorage = (): LastGoodRoomStorage => {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async (key) => { values.delete(key); },
  };
};

// harn:assume hosted-last-good-room-cache-is-bounded-read-only-projection ref=hosted-last-good-room-regression
describe('hosted last-good room cache', () => {
  it('isolates same-named rooms per computer and forgets only the addressed snapshot', async () => {
    const storage = memoryStorage();
    await saveLastGoodRoom(snapshot('computer-a', 'same-room'), storage);
    await saveLastGoodRoom(snapshot('computer-b', 'same-room'), storage);

    expect((await loadLastGoodRoom('computer-a', storage))?.room.name).toBe('Room computer-a');
    expect((await loadLastGoodRoom('computer-b', storage))?.room.name).toBe('Room computer-b');

    await deleteLastGoodRoom('computer-a', storage);
    expect(await loadLastGoodRoom('computer-a', storage)).toBeUndefined();
    expect((await loadLastGoodRoom('computer-b', storage))?.room.name).toBe('Room computer-b');
  });

  it('rejects an oversized or cross-computer projection', async () => {
    const storage = memoryStorage();
    const oversized = snapshot('computer-a', 'same-room');
    oversized.history.units = Array.from({ length: 21 }, (_, index) => ({
      kind: 'message' as const,
      message_id: index + 1,
    }));
    await saveLastGoodRoom(oversized, storage);
    expect(await loadLastGoodRoom('computer-a', storage)).toBeUndefined();
  });

  it('projects the newest materialized page with its own cursor and strips file and voice metadata', () => {
    const store = createClientStore();
    const room = snapshot('computer-a', 'room-a').room;
    store.getState().setActiveRoom(room.id);
    store.getState().setRoomSummaries(snapshot('computer-a', 'room-a').summaries);
    store.getState().applyFrame({ type: 'room', seq: 1, room } as never, room.id);
    const allMessages = Object.fromEntries(Array.from({ length: 25 }, (_, index) => {
      const id = index + 1;
      return [id, {
        room: room.id,
        id,
        seq: id,
        ts: `2026-08-10T00:00:${String(id).padStart(2, '0')}.000Z`,
        author: 'human',
        kind: 'chat' as const,
        body: `message ${String(id)}`,
        mentions: [],
        refs: [],
        ledger_refs: [],
        deleted: false,
        ack: false,
        pinned: false,
        attachments: [{ id: `attachment-${String(id)}`, name: 'secret.txt', mime: 'text/plain', size: 6 }],
        voice: { duration_seconds: 1, levels: [1, 2] },
      }];
    }));
    const headUnits = Array.from({ length: 20 }, (_, index) => ({
      kind: 'message' as const,
      message_id: index + 6,
    }));
    store.getState().updateTranscriptHistory(room.id, (history) => ({
      ...history,
      initialized: true,
      messages: allMessages,
      journals: {},
      units: Array.from({ length: 25 }, (_, index) => ({
        kind: 'message' as const,
        message_id: index + 1,
      })),
      latestPage: {
        messages: Object.values(allMessages).slice(-20),
        journals: [],
        units: headUnits,
        before_cursor: 'head-older',
        has_more: true,
      },
      beforeCursor: 'operator-loaded-older-page',
      hasMore: true,
    }));
    store.getState().setConnected(true);

    const projected = snapshotLastGoodRoom('computer-a', store, room.id);
    expect(projected?.summaries.map((summary) => summary.id)).toEqual([room.id]);
    expect(projected?.history.units).toEqual(Array.from({ length: 20 }, (_, index) => ({
      kind: 'message',
      message_id: index + 6,
    })));
    expect(Object.keys(projected?.history.messages ?? {}).map(Number)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 6),
    );
    expect(projected?.history.beforeCursor).toBe('head-older');
    expect(Object.values(projected?.history.messages ?? {}).every((message) => (
      message.attachments === undefined && message.voice === undefined
    ))).toBe(true);
  });
});
// harn:end hosted-last-good-room-cache-is-bounded-read-only-projection
