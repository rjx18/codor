// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  deleteLastGoodRoom,
  hydrateLastGoodRoom,
  loadLastGoodRoom,
  saveLastGoodRoom,
  snapshotLastGoodRoom,
  type LastGoodRoomSnapshot,
  type LastGoodRoomStorage,
} from './last-good-room.js';
import { createClientStore, roomSlice } from '../app/store.js';

const snapshot = (computerId: string, room: string): LastGoodRoomSnapshot => ({
  version: 2,
  computerId,
  publicRoom: room,
  summaries: [{
    id: room,
    name: `Room ${computerId}`,
    created_ts: '2026-08-10T00:00:00.000Z',
    working: false,
    attention: false,
    unread: 0,
  }],
  rooms: {
    [room]: {
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
      history: {
        messages: {},
        journals: {},
        units: [],
        beforeCursor: null,
        hasMore: false,
      },
    },
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

// harn:assume hosted-last-good-history-cache-is-per-room-and-bounded ref=hosted-last-good-room-map-regression
describe('hosted last-good room cache', () => {
  it('isolates same-named rooms per computer and forgets only the addressed snapshot', async () => {
    const storage = memoryStorage();
    await saveLastGoodRoom(snapshot('computer-a', 'same-room'), storage);
    await saveLastGoodRoom(snapshot('computer-b', 'same-room'), storage);

    expect((await loadLastGoodRoom('computer-a', storage))?.rooms['same-room']?.room.name).toBe('Room computer-a');
    expect((await loadLastGoodRoom('computer-b', storage))?.rooms['same-room']?.room.name).toBe('Room computer-b');

    await deleteLastGoodRoom('computer-a', storage);
    expect(await loadLastGoodRoom('computer-a', storage)).toBeUndefined();
    expect((await loadLastGoodRoom('computer-b', storage))?.rooms['same-room']?.room.name).toBe('Room computer-b');
  });

  it('rejects an oversized or cross-computer projection', async () => {
    const storage = memoryStorage();
    const oversized = snapshot('computer-a', 'same-room');
    oversized.rooms['same-room']!.history.units = Array.from({ length: 41 }, (_, index) => ({
      kind: 'message' as const,
      message_id: index + 1,
    }));
    oversized.rooms['same-room']!.history.messages = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => {
        const id = index + 1;
        return [id, {
          room: 'same-room', id, seq: id,
          ts: `2026-08-10T00:00:${String(id).padStart(2, '0')}.000Z`,
          author: 'human', kind: 'chat' as const, body: `message ${String(id)}`,
          mentions: [], refs: [], ledger_refs: [], deleted: false, ack: false, pinned: false,
        }];
      }),
    );
    await saveLastGoodRoom(oversized, storage);
    expect(await loadLastGoodRoom('computer-a', storage)).toBeUndefined();
  });

  it('migrates the disposable one-room cache into the per-room record once', async () => {
    const storage = memoryStorage();
    const current = snapshot('computer-a', 'room-a');
    const cached = current.rooms['room-a']!;
    await storage.put('computer-a', {
      version: 1,
      computerId: 'computer-a',
      room: cached.room,
      summaries: current.summaries,
      history: cached.history,
      savedAt: current.savedAt,
    });

    expect(await loadLastGoodRoom('computer-a', storage)).toEqual(current);
    expect(await storage.get('computer-a')).toEqual(current);
    expect(await loadLastGoodRoom('computer-a', storage)).toEqual(current);
  });

  it('projects forty text slots for every materialized room with independent cursors', () => {
    const store = createClientStore();
    const room = snapshot('computer-a', 'room-a').rooms['room-a']!.room;
    const background = snapshot('computer-a', 'room-b').rooms['room-b']!.room;
    store.getState().setActiveRoom(room.id);
    store.getState().setRoomSummaries([
      ...snapshot('computer-a', room.id).summaries,
      ...snapshot('computer-a', background.id).summaries,
    ]);
    store.getState().applyFrame({ type: 'room', seq: 1, room } as never, room.id);
    store.getState().applyFrame({ type: 'room', seq: 1, room: background } as never, background.id);
    const allMessages = Object.fromEntries(Array.from({ length: 45 }, (_, index) => {
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
    const cacheUnits = Array.from({ length: 40 }, (_, index) => ({
      kind: 'message' as const,
      message_id: index + 6,
    }));
    store.getState().updateTranscriptHistory(room.id, (history) => ({
      ...history,
      initialized: true,
      messages: allMessages,
      units: Array.from({ length: 45 }, (_, index) => ({
        kind: 'message' as const,
        message_id: index + 1,
      })),
      cacheWindow: {
        messages: Object.fromEntries(Object.entries(allMessages).slice(-40)),
        journals: {},
        units: cacheUnits,
        beforeCursor: 'head-older',
        hasMore: true,
      },
      beforeCursor: 'operator-loaded-older-page',
      hasMore: true,
    }));
    const backgroundMessage = {
      ...allMessages[45]!,
      room: background.id,
      id: 100,
      seq: 100,
      body: 'background room',
    };
    store.getState().updateTranscriptHistory(background.id, (history) => ({
      ...history,
      initialized: true,
      messages: { 100: backgroundMessage },
      units: [{ kind: 'message', message_id: 100 }],
      cacheWindow: {
        messages: { 100: backgroundMessage },
        journals: {},
        units: [{ kind: 'message', message_id: 100 }],
        beforeCursor: null,
        hasMore: false,
      },
      beforeCursor: null,
      hasMore: false,
    }));
    store.getState().setConnected(true);

    const projected = snapshotLastGoodRoom('computer-a', store, room.id);
    expect(projected?.summaries.map((summary) => summary.id)).toEqual([room.id, background.id]);
    expect(projected?.rooms[room.id]?.history.units).toEqual(cacheUnits);
    expect(Object.keys(projected?.rooms[room.id]?.history.messages ?? {}).map(Number)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 6),
    );
    expect(projected?.rooms[room.id]?.history.beforeCursor).toBe('head-older');
    expect(projected?.rooms[background.id]?.history.units).toEqual([
      { kind: 'message', message_id: 100 },
    ]);
    expect(Object.values(projected?.rooms[room.id]?.history.messages ?? {}).every((message) => (
      message.attachments === undefined && message.voice === undefined
    ))).toBe(true);

    const restored = createClientStore();
    hydrateLastGoodRoom(restored, projected!);
    expect(roomSlice(restored.getState(), room.id).transcriptHistory).toMatchObject({
      initialized: true,
      headNeedsRevalidation: true,
      failed: false,
      coldMessageIds: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [index + 6, true]),
      ),
    });
    expect(roomSlice(restored.getState(), background.id).transcriptHistory.units).toEqual([
      { kind: 'message', message_id: 100 },
    ]);
    expect(restored.getState().activeRoom).toBe(room.id);
  });
});
// harn:end hosted-last-good-history-cache-is-per-room-and-bounded
