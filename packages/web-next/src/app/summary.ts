import type { RoomSummary } from '@codor/protocol';
import { useEffect, useMemo, useState } from 'react';

import { fetchRooms } from '@legacy/api.js';

import { useClientStore } from './store.js';

export type { RoomSummary } from '@codor/protocol';

async function fetchSummaries(token: string): Promise<RoomSummary[]> {
  const response = await fetch('/api/rooms/summary?read_state=durable', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`summary failed: ${response.status}`);
  const body = (await response.json()) as { rooms: RoomSummary[] };
  return body.rooms;
}

/**
 * REST supplies the cold rail before the socket is ready. From then on each
 * room's addressed room_support frame is the live authority; there is no timer
 * and no browser-local read cursor.
 */
export function useRoomSummaries(token: () => string): RoomSummary[] {
  const rooms = useClientStore((state) => state.rooms);
  const [cold, setCold] = useState<RoomSummary[]>([]);

  useEffect(() => {
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
    const byId = new Map(cold.map((summary) => [summary.id, summary]));
    for (const slice of Object.values(rooms)) {
      if (slice.support !== undefined) {
        byId.set(slice.support.room, slice.support.summary);
      } else if (slice.room !== undefined && !byId.has(slice.room.id)) {
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
  }, [cold, rooms]);
}
