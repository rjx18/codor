import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Connection } from '@runtime/ws.js';

// harn:assume composer-memory-survives-session-connector-handover-v2 ref=p6-composer-drafts-stay-in-memory-with-source-owner
interface Cell<T> {
  value: T;
  listeners: Set<() => void>;
  set: Dispatch<SetStateAction<T>>;
  subscribe(listener: () => void): () => void;
  snapshot(): T;
}
// Session identity survives cached/live handover and isolates equal room names. The
// weak owner and page lifetime are the only retention policy; no disk storage.
const owners = new WeakMap<object, Map<string, Map<string, Cell<unknown>>>>();

export function useComposerMemory<T>(
  owner: Connection, room: string, key: string, initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const identity = owner.compositionOwner ?? owner;
  let rooms = owners.get(identity);
  if (!rooms) owners.set(identity, rooms = new Map());
  let fields = rooms.get(room);
  if (!fields) rooms.set(room, fields = new Map());
  let cell = fields.get(key) as Cell<T> | undefined;
  if (!cell) {
    const created: Cell<T> = {
      value: initial, listeners: new Set(),
      set: (next) => {
        const value = typeof next === 'function'
          ? (next as (prior: T) => T)(created.value) : next;
        if (Object.is(created.value, value)) return;
        created.value = value;
        for (const listener of created.listeners) listener();
      },
      subscribe: (listener) => { created.listeners.add(listener); return () => { created.listeners.delete(listener); }; },
      snapshot: () => created.value,
    };
    cell = created;
    fields.set(key, cell as Cell<unknown>);
  }
  return [useSyncExternalStore(cell.subscribe, cell.snapshot, cell.snapshot), cell.set];
}
// harn:end composer-memory-survives-session-connector-handover-v2
