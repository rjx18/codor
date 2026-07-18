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
// when a run turns terminal. Requests from a room the reader has left are
// ignored on arrival — message ids are room-local, so a stale journal must never
// be served for a colliding id.

const MAX_CONCURRENT = 4;

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

let currentRoom = '';
let generation = 0;
let version = 0;
let active = 0;
let queue: Pending[] = [];
const journals = new Map<number, Entry>();
const inflight = new Map<number, boolean>(); // id → whether that read is the terminal one
const wantTerminal = new Set<number>();
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function switchRoom(room: string): void {
  currentRoom = room;
  generation += 1; // in-flight reads from the previous room are dropped on arrival
  journals.clear();
  inflight.clear();
  wantTerminal.clear();
  queue = [];
  active = 0;
  bump();
}

/** Promote one room as the only journal namespace. Calling this even for a
 * room with no runs clears stale journals and in-flight arrivals from the room
 * the reader just demoted. */
export function activateRunJournalRoom(room: string): void {
  if (room !== currentRoom) switchRoom(room);
}

function pump(token: () => string): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    // Running runs first: a reader watching a live turn must not wait behind a
    // backlog of archived journals.
    const priorityIndex = queue.findIndex((pending) => pending.priority);
    const next = queue.splice(priorityIndex === -1 ? 0 : priorityIndex, 1)[0]!;
    const mine = generation;
    const room = currentRoom;
    active += 1;
    inflight.set(next.id, next.terminal);
    void fetchRunEvents(room, next.id, { token: token() })
      .then((events) => {
        if (mine === generation) journals.set(next.id, { events, terminal: next.terminal });
      })
      .catch(() => {
        // Remember the failure at this terminality so it retries at most once
        // more (when the run settles), never in a loop.
        if (mine === generation) journals.set(next.id, { events: [], terminal: next.terminal });
      })
      .finally(() => {
        active -= 1;
        if (mine !== generation) return; // stale room — drop it entirely
        inflight.delete(next.id);
        if (wantTerminal.delete(next.id)) {
          queue.push({ id: next.id, terminal: true, priority: false });
        }
        bump();
        pump(token);
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
  if (room !== currentRoom) switchRoom(room);
  const have = journals.get(id);
  if (have?.terminal === true) return; // settled and read — never again
  if (have !== undefined && !opts.terminal) return; // the running snapshot still serves
  const running = inflight.get(id);
  if (running !== undefined) {
    // A terminal read is worth one refresh once the in-flight running read lands.
    if (opts.terminal && !running) wantTerminal.add(id);
    return;
  }
  if (queue.some((pending) => pending.id === id && pending.terminal === opts.terminal)) return;
  queue.push({ id, terminal: opts.terminal, priority: opts.priority === true });
  pump(token);
}

/** The cached journal for a run, or undefined while it is still unread. */
export function getRunJournal(room: string, id: number): WireEvent[] | undefined {
  if (room !== currentRoom) return undefined;
  return journals.get(id)?.events;
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
  switchRoom('');
}
