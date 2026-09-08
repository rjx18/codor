import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Connection } from '@runtime/ws.js';

// harn:assume composer-drafts-stay-in-memory-with-source-owner ref=p6-composer-drafts-stay-in-memory-with-source-owner
interface Cell<T> {
  value: T;
  listeners: Set<() => void>;
  set: Dispatch<SetStateAction<T>>;
  subscribe(listener: () => void): () => void;
  snapshot(): T;
}
// Connection identity scopes even identical room names across computers. The
// weak owner and page lifetime are the only retention policy; no disk storage.
const owners = new WeakMap<Connection, Map<string, Map<string, Cell<unknown>>>>();

export function useComposerMemory<T>(
  owner: Connection, room: string, key: string, initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  let rooms = owners.get(owner);
  if (!rooms) owners.set(owner, rooms = new Map());
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
// harn:end composer-drafts-stay-in-memory-with-source-owner
