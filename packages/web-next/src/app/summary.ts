import type { RoomSummary } from '@codor/protocol';
import { useEffect, useMemo, useState } from 'react';

import { fetchRooms } from '@runtime/api.js';
import { relayFetch } from '@runtime/relay-transport.js';

import { useClientStore } from './store.js';

export type { RoomSummary } from '@codor/protocol';

/** The bootstrap's result, so a launch fetches the durable summary ONCE. */
let primed: RoomSummary[] | undefined;

export function primeRoomSummaries(summaries: RoomSummary[]): void {
  primed = summaries;
}

export async function fetchSummaries(token: string): Promise<RoomSummary[]> {
  const response = await relayFetch('/api/rooms/summary?read_state=durable', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`summary failed: ${response.status}`);
  const body = (await response.json()) as { rooms: RoomSummary[] };
  return body.rooms;
}

export function resolveRoomSummaries(
  managedCold: RoomSummary[],
  managedColdLoaded: boolean,
  cold: RoomSummary[],
  rooms: ReturnType<typeof useClientStore.getState>['rooms'],
  childRoomIds: ReadonlySet<string> = new Set(),
): RoomSummary[] {
  // harn:assume worktree-child-conversations-stay-nested-and-isolated ref=worktree-summary-filter
  const base = managedColdLoaded ? managedCold : cold;
  const byId = new Map(
    base.filter((summary) => !childRoomIds.has(summary.id)).map((summary) => [summary.id, summary]),
  );
  for (const slice of Object.values(rooms)) {
    if (slice.support !== undefined) {
      if (childRoomIds.has(slice.support.room)) continue;
      byId.set(slice.support.room, slice.support.summary);
    } else if (slice.room !== undefined && !byId.has(slice.room.id)) {
      if (childRoomIds.has(slice.room.id)) continue;
      byId.set(slice.room.id, {
        id: slice.room.id,
        name: slice.room.name,
        created_ts: slice.room.created_ts,
        color: slice.room.config.color,
        working: false,
        attention: false,
        unread: 0,
      });
    }
  }
  return [...byId.values()];
  // harn:end worktree-child-conversations-stay-nested-and-isolated
}

/**
 * REST supplies the cold rail before the socket is ready. From then on each
 * room's addressed room_support frame is the live authority; there is no timer
 * and no browser-local read cursor.
 */
export function useRoomSummaries(token: () => string): RoomSummary[] {
  const rooms = useClientStore((state) => state.rooms);
  const worktreeGroups = useClientStore((state) => state.worktreeGroups);
  const managedCold = useClientStore((state) => state.roomSummaries);
  const managedColdLoaded = useClientStore((state) => state.roomSummariesLoaded);
  const [cold, setCold] = useState<RoomSummary[]>(primed ?? []);
  const childRoomIds = useMemo(() => new Set(
    Object.values(worktreeGroups).flatMap((group) => group.registered
      .filter((worktree) => !worktree.primary)
      .map((worktree) => worktree.conversation_id)),
  ), [worktreeGroups]);

  useEffect(() => {
    // Startup already resolved the authorized set to pick a room; refetching it
    // here would be a second identical request on every launch.
    if (primed !== undefined) {
      setCold(primed);
      return;
    }
    let current = true;
    void fetchSummaries(token())
      .then((summaries) => { if (current) setCold(summaries); })
      .catch(() =>
        fetchRooms({ token: token() })
          .then((items) => {
            if (!current) return;
            setCold(items.map((room) => ({
              id: room.id,
              name: room.name,
              created_ts: room.created_ts,
              color: room.config.color,
              working: false,
              attention: false,
              unread: 0,
            })));
          })
          .catch(() => undefined),
      );
    return () => { current = false; };
  }, [token]);

  return useMemo(() => {
    return resolveRoomSummaries(managedCold, managedColdLoaded, cold, rooms, childRoomIds);
  }, [childRoomIds, cold, managedCold, managedColdLoaded, rooms]);
}
