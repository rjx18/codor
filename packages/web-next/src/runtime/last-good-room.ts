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
  TranscriptHistoryPageSchema,
} from '@codor/protocol';

import { HISTORY_PAGE_SIZE, roomSlice, type ClientStore } from '../app/store.js';

export const LAST_GOOD_ROOM_DATABASE = 'codor-last-good-room-v1';
const STORE = 'rooms';

export interface LastGoodRoomSnapshot {
  version: 1;
  computerId: string;
  room: Room;
  summaries: RoomSummary[];
  history: {
    messages: Record<number, Message>;
    journals: Record<number, TranscriptHistoryJournal>;
    units: TranscriptHistoryUnit[];
    beforeCursor: string | null;
    hasMore: boolean;
  };
  savedAt: string;
}

export interface LastGoodRoomStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
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
  if (candidate.version !== 1
    || candidate.computerId !== computerId
    || !RoomSchema.safeParse(candidate.room).success
    || !Array.isArray(candidate.summaries)
    || !RoomSummarySchema.array().max(1).safeParse(candidate.summaries).success
    || candidate.summaries.some((summary) => summary.id !== candidate.room?.id)
    || typeof candidate.history !== 'object'
    || candidate.history === null
    || typeof candidate.history.messages !== 'object'
    || candidate.history.messages === null
    || typeof candidate.history.journals !== 'object'
    || candidate.history.journals === null
    || !Array.isArray(candidate.history.units)
    || candidate.history.units.length > HISTORY_PAGE_SIZE
    || typeof candidate.history.hasMore !== 'boolean'
    || !(typeof candidate.history.beforeCursor === 'string' || candidate.history.beforeCursor === null)
    || typeof candidate.savedAt !== 'string') return false;
  const messages = Object.values(candidate.history.messages);
  const journals = Object.values(candidate.history.journals);
  return TranscriptHistoryPageSchema.safeParse({
    messages,
    journals,
    units: candidate.history.units,
    before_cursor: candidate.history.beforeCursor,
    has_more: candidate.history.hasMore,
  }).success
    && messages.every((message) => {
      if (typeof message !== 'object' || message === null) return false;
      const projected = message as Partial<Message>;
      return projected.attachments === undefined && projected.voice === undefined;
    })
    && messages.every((message) => candidate.history?.messages[message.id] === message)
    && journals.every((journal) => candidate.history?.journals[journal.root_message_id] === journal);
}

// harn:assume hosted-last-good-room-cache-is-bounded-read-only-projection ref=hosted-last-good-room-store
export async function loadLastGoodRoom(
  computerId: string,
  storage: LastGoodRoomStorage | undefined = typeof indexedDB === 'undefined' ? undefined : indexedStorage,
): Promise<LastGoodRoomSnapshot | undefined> {
  if (!storage) return undefined;
  try {
    const value = await storage.get(computerId);
    return validSnapshot(value, computerId) ? value : undefined;
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
// harn:end hosted-last-good-room-cache-is-bounded-read-only-projection

export function snapshotLastGoodRoom(
  computerId: string,
  store: ClientStore,
  publicRoom: string,
): LastGoodRoomSnapshot | undefined {
  const state = store.getState();
  if (!state.connected || state.activeRoom !== publicRoom) return undefined;
  const slice = roomSlice(state, publicRoom);
  const room = slice.room;
  const history = slice.transcriptHistory;
  const latestPage = history.latestPage;
  if (!room || !history.initialized || history.legacyFallback || history.failed || !latestPage) return undefined;

  const units = latestPage.units;
  const messageIds = new Set<number>();
  const eventIndices = new Map<number, Set<number>>();
  for (const unit of units) {
    if (unit.kind === 'message') {
      messageIds.add(unit.message_id);
      continue;
    }
    messageIds.add(unit.root_message_id);
    messageIds.add(unit.output_message_id);
    const selected = eventIndices.get(unit.root_message_id) ?? new Set<number>();
    for (const index of unit.event_indices) selected.add(index);
    eventIndices.set(unit.root_message_id, selected);
  }
  const messages = Object.fromEntries([...messageIds].flatMap((id) => {
    const message = history.messages[id];
    if (message === undefined) return [];
    // The readable fallback is transcript text/evidence, never an authenticated
    // file or voice cache. Dropping metadata also prevents the cached renderer
    // from offering a download that cannot succeed while disconnected.
    const { attachments: _attachments, voice: _voice, ...projected } = message;
    return [[id, projected as Message] as const];
  }));
  const journals = Object.fromEntries([...eventIndices].flatMap(([root, selected]) => {
    const journal = history.journals[root];
    if (!journal) return [];
    return [[root, {
      root_message_id: root,
      events: journal.events.filter((event) => selected.has(event.index)),
    }] as const];
  }));
  return {
    version: 1,
    computerId,
    room,
    summaries: state.roomSummaries.filter((summary) => summary.id === publicRoom),
    history: {
      messages,
      journals,
      units,
      beforeCursor: latestPage.before_cursor,
      hasMore: latestPage.has_more,
    },
    savedAt: new Date().toISOString(),
  };
}

export function hydrateLastGoodRoom(store: ClientStore, snapshot: LastGoodRoomSnapshot): void {
  store.getState().hydrateLastGoodRoom(snapshot.room, snapshot.summaries, snapshot.history);
}
