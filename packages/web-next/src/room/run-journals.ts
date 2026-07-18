import type { WireEvent } from '@codor/protocol';
import { useSyncExternalStore } from 'react';

import { fetchRunEvents } from '@legacy/api.js';

// ── One room-scoped journal cache for the whole transcript (codex #516) ──────
// Both journal readers — the finalized-segment batch and every RunContent — go
// through here. The storm this replaces was triangular: the batch keyed its
// effect on the growing id list and re-issued a Promise.all over every
// not-yet-cached id on each streaming frame, committing only after a whole batch
// settled, while RunContent fetched the same journals again. 180 runs became
// 16,465 requests and exhausted the browser's connection pool.
//
// The fix is structural: one in-flight request per run id, each journal
// committed the moment it lands (never batched), bounded concurrency so a large
// room cannot saturate the pool, running runs served first, and a single refresh
// when a run turns terminal. Recently read rooms stay in a bounded room-keyed
// LRU: ids are room-local, but returning to a channel must not pay for the same
// evidence again.

const MAX_CONCURRENT = 4;
const MAX_CACHED_ROOMS = 3;

interface Entry {
  events: WireEvent[];
  /** True when this journal was read after the run reached a terminal status —
   *  the run can produce no more events, so it is never fetched again. */
  terminal: boolean;
}

interface Pending {
  id: number;
  terminal: boolean;
  priority: boolean;
}

interface RoomCache {
  active: number;
  queue: Pending[];
  journals: Map<number, Entry>;
  inflight: Map<number, boolean>;
  wantTerminal: Set<number>;
}

let currentRoom = '';
let version = 0;
const rooms = new Map<string, RoomCache>();
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function freshRoomCache(): RoomCache {
  return {
    active: 0,
    queue: [],
    journals: new Map(),
    inflight: new Map(),
    wantTerminal: new Set(),
  };
}

/** Get and touch a room in insertion-order LRU order. */
function roomCache(room: string): RoomCache {
  const cached = rooms.get(room) ?? freshRoomCache();
  rooms.delete(room);
  rooms.set(room, cached);
  while (rooms.size > MAX_CACHED_ROOMS) {
    const oldest = rooms.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rooms.delete(oldest);
  }
  return cached;
}

/** Promote one room as the only namespace allowed to START journal reads.
 * Recently visited room caches remain addressable by their room id, so returning
 * to a channel is immediate without allowing room-local message ids to collide. */
export function activateRunJournalRoom(room: string): void {
  if (room === currentRoom) return;
  currentRoom = room;
  roomCache(room);
  bump();
}

function pump(room: string, cache: RoomCache, token: () => string): void {
  // Demoted rooms may finish reads already on the wire, but they never start
  // queued work until selected again.
  if (room !== currentRoom || rooms.get(room) !== cache) return;
  while (cache.active < MAX_CONCURRENT && cache.queue.length > 0) {
    // Running runs first: a reader watching a live turn must not wait behind a
    // backlog of archived journals.
    const priorityIndex = cache.queue.findIndex((pending) => pending.priority);
    const next = cache.queue.splice(priorityIndex === -1 ? 0 : priorityIndex, 1)[0]!;
    cache.active += 1;
    cache.inflight.set(next.id, next.terminal);
    void fetchRunEvents(room, next.id, { token: token() })
      .then((events) => {
        if (rooms.get(room) === cache) {
          cache.journals.set(next.id, { events, terminal: next.terminal });
        }
      })
      .catch(() => {
        // Remember the failure at this terminality so it retries at most once
        // more (when the run settles), never in a loop.
        if (rooms.get(room) === cache) {
          cache.journals.set(next.id, { events: [], terminal: next.terminal });
        }
      })
      .finally(() => {
        cache.active -= 1;
        if (rooms.get(room) !== cache) return; // evicted while the read was in flight
        cache.inflight.delete(next.id);
        if (cache.wantTerminal.delete(next.id)) {
          cache.queue.push({ id: next.id, terminal: true, priority: false });
        }
        if (room === currentRoom) bump();
        pump(room, cache, token);
      });
  }
}

/**
 * Ask for a run's journal. Safe to call on every render pass: it is deduplicated
 * per id, so a cached or in-flight journal costs nothing. `terminal` says whether
 * the run has settled (a terminal read is final); `priority` puts a live run at
 * the front of the queue. Call from an effect — it can notify subscribers.
 */
export function requestRunJournal(
  room: string,
  token: () => string,
  id: number,
  opts: { terminal: boolean; priority?: boolean },
): void {
  // Effects belonging to a room that was just demoted must not steal the active
  // namespace back. Its queued work resumes when activateRunJournalRoom selects it.
  if (room !== currentRoom) return;
  const cache = roomCache(room);
  const have = cache.journals.get(id);
  if (have?.terminal === true) return; // settled and read — never again
  if (have !== undefined && !opts.terminal) return; // the running snapshot still serves
  const running = cache.inflight.get(id);
  if (running !== undefined) {
    // A terminal read is worth one refresh once the in-flight running read lands.
    if (opts.terminal && !running) cache.wantTerminal.add(id);
    return;
  }
  if (cache.queue.some((pending) => pending.id === id && pending.terminal === opts.terminal)) {
    pump(room, cache, token);
    return;
  }
  cache.queue.push({ id, terminal: opts.terminal, priority: opts.priority === true });
  pump(room, cache, token);
}

/** The cached journal for a run, or undefined while it is still unread. */
export function getRunJournal(room: string, id: number): WireEvent[] | undefined {
  return rooms.get(room)?.journals.get(id)?.events;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): number => version;

/** Re-renders the caller whenever any journal commits. */
export function useRunJournalVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: forget everything (used by unit tests, never by the app). */
export function resetRunJournalsForTest(): void {
  currentRoom = '';
  rooms.clear();
  bump();
}
