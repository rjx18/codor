import type {
  Message,
  Room,
  RoomSummary,
  TranscriptHistoryJournal,
  TranscriptHistoryUnit,
} from '@codor/protocol';
import {
  RoomSchema,
  RoomSummarySchema,
  TranscriptHistoryCacheWindowSchema,
  TranscriptHistoryPageSchema,
} from '@codor/protocol';

import type { ClientStore } from '../app/store.js';

export const LAST_GOOD_ROOM_DATABASE = 'codor-last-good-room-v1';
const STORE = 'rooms';

export interface LastGoodRoomSnapshot {
  version: 2;
  computerId: string;
  publicRoom: string;
  summaries: RoomSummary[];
  rooms: Record<string, {
    room: Room;
    history: {
      messages: Record<number, Message>;
      journals: Record<number, TranscriptHistoryJournal>;
      units: TranscriptHistoryUnit[];
      beforeCursor: string | null;
      hasMore: boolean;
    };
  }>;
  savedAt: string;
}

export interface LastGoodRoomStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface LegacyLastGoodRoomSnapshot {
  version: 1;
  computerId: string;
  room: Room;
  summaries: RoomSummary[];
  history: LastGoodRoomSnapshot['rooms'][string]['history'];
  savedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LAST_GOOD_ROOM_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('last-good database open failed'));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = act(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('last-good database request failed'));
    });
  } finally {
    database.close();
  }
}

const indexedStorage: LastGoodRoomStorage = {
  get: (key) => transact<unknown>('readonly', (store) => store.get(key)),
  put: async (key, value) => { await transact<IDBValidKey>('readwrite', (store) => store.put(value, key)); },
  delete: async (key) => { await transact<undefined>('readwrite', (store) => store.delete(key)); },
};

function validSnapshot(value: unknown, computerId: string): value is LastGoodRoomSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LastGoodRoomSnapshot>;
  if (candidate.version !== 2
    || candidate.computerId !== computerId
    || typeof candidate.publicRoom !== 'string'
    || !Array.isArray(candidate.summaries)
    || !RoomSummarySchema.array().max(256).safeParse(candidate.summaries).success
    || typeof candidate.rooms !== 'object'
    || candidate.rooms === null
    || Object.keys(candidate.rooms).length > 256
    || typeof candidate.savedAt !== 'string') return false;
  if (candidate.rooms[candidate.publicRoom] === undefined) return false;
  return Object.entries(candidate.rooms).every(([roomId, cached]) => {
    if (typeof cached !== 'object' || cached === null
      || !RoomSchema.safeParse(cached.room).success
      || cached.room.id !== roomId
      || typeof cached.history !== 'object'
      || cached.history === null) return false;
    const messages = Object.values(cached.history.messages ?? {});
    const journals = Object.values(cached.history.journals ?? {});
    return TranscriptHistoryCacheWindowSchema.safeParse({
      messages,
      journals,
      units: cached.history.units,
      before_cursor: cached.history.beforeCursor,
      has_more: cached.history.hasMore,
    }).success && messages.every((message) => {
      if (typeof message !== 'object' || message === null) return false;
      const projected = message as Partial<Message>;
      return projected.attachments === undefined && projected.voice === undefined;
    })
      && messages.every((message) => cached.history.messages[message.id] === message)
      && journals.every((journal) => cached.history.journals[journal.root_message_id] === journal);
  });
}

function migrateLegacySnapshot(
  value: unknown,
  computerId: string,
): LastGoodRoomSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<LegacyLastGoodRoomSnapshot>;
  if (candidate.version !== 1
    || candidate.computerId !== computerId
    || !RoomSchema.safeParse(candidate.room).success
    || !RoomSummarySchema.array().max(1).safeParse(candidate.summaries).success
    || candidate.summaries?.some((summary) => summary.id !== candidate.room?.id) === true
    || typeof candidate.history !== 'object'
    || candidate.history === null
    || typeof candidate.savedAt !== 'string') return undefined;
  const messages = Object.values(candidate.history.messages ?? {});
  const journals = Object.values(candidate.history.journals ?? {});
  if (!TranscriptHistoryPageSchema.safeParse({
    messages,
    journals,
    units: candidate.history.units,
    before_cursor: candidate.history.beforeCursor,
    has_more: candidate.history.hasMore,
  }).success || messages.some((message) => message.attachments !== undefined || message.voice !== undefined)) {
    return undefined;
  }
  const room = candidate.room as Room;
  const summaries = candidate.summaries as RoomSummary[];
  const history = candidate.history as LegacyLastGoodRoomSnapshot['history'];
  const migrated: LastGoodRoomSnapshot = {
    version: 2,
    computerId,
    publicRoom: room.id,
    summaries,
    rooms: {
      [room.id]: {
        room,
        history,
      },
    },
    savedAt: candidate.savedAt,
  };
  return validSnapshot(migrated, computerId) ? migrated : undefined;
}

// harn:assume hosted-last-good-history-cache-is-per-room-and-bounded ref=hosted-last-good-room-map-store
export async function loadLastGoodRoom(
  computerId: string,
  storage: LastGoodRoomStorage | undefined = typeof indexedDB === 'undefined' ? undefined : indexedStorage,
): Promise<LastGoodRoomSnapshot | undefined> {
  if (!storage) return undefined;
  try {
    const value = await storage.get(computerId);
    if (validSnapshot(value, computerId)) return value;
    const migrated = migrateLegacySnapshot(value, computerId);
    if (migrated !== undefined) await storage.put(computerId, migrated);
    return migrated;
  } catch {
    return undefined;
  }
}

export async function saveLastGoodRoom(
  snapshot: LastGoodRoomSnapshot,
  storage: LastGoodRoomStorage | undefined = typeof indexedDB === 'undefined' ? undefined : indexedStorage,
): Promise<void> {
  if (!validSnapshot(snapshot, snapshot.computerId) || !storage) return;
  await storage.put(snapshot.computerId, snapshot);
}

export async function deleteLastGoodRoom(
  computerId: string,
  storage: LastGoodRoomStorage | undefined = typeof indexedDB === 'undefined' ? undefined : indexedStorage,
): Promise<void> {
  if (!storage) return;
  try {
    await storage.delete(computerId);
  } catch {
    // Forget remains authoritative even if optional local cache cleanup fails.
  }
}
// harn:end hosted-last-good-history-cache-is-per-room-and-bounded

export function snapshotLastGoodRoom(
  computerId: string,
  store: ClientStore,
  publicRoom: string,
): LastGoodRoomSnapshot | undefined {
  const state = store.getState();
  if (!state.connected) return undefined;
  const rooms = Object.fromEntries(Object.entries(state.rooms).flatMap(([roomId, slice]) => {
    const room = slice.room;
    const history = slice.transcriptHistory;
    const cache = history.cacheWindow;
    if (!room || !history.initialized || history.legacyFallback || history.failed || !cache) return [];
    const messages = Object.fromEntries(Object.entries(cache.messages).map(([id, message]) => {
      // The readable fallback is transcript text/evidence, never an authenticated
      // file or voice cache. Dropping metadata also prevents the cached renderer
      // from offering a download that cannot succeed while disconnected.
      const { attachments: _attachments, voice: _voice, ...projected } = message;
      return [id, projected as Message];
    }));
    return [[roomId, {
      room,
      history: {
        messages,
        journals: cache.journals,
        units: cache.units,
        beforeCursor: cache.beforeCursor,
        hasMore: cache.hasMore,
      },
    }]];
  }));
  if (rooms[publicRoom] === undefined) return undefined;
  return {
    version: 2,
    computerId,
    publicRoom,
    summaries: state.roomSummaries,
    rooms,
    savedAt: new Date().toISOString(),
  };
}

export function hydrateLastGoodRoom(store: ClientStore, snapshot: LastGoodRoomSnapshot): void {
  for (const [roomId, cached] of Object.entries(snapshot.rooms)) {
    if (roomId === snapshot.publicRoom) continue;
    store.getState().hydrateLastGoodRoom(cached.room, snapshot.summaries, cached.history);
  }
  const active = snapshot.rooms[snapshot.publicRoom]!;
  store.getState().hydrateLastGoodRoom(active.room, snapshot.summaries, active.history);
}
