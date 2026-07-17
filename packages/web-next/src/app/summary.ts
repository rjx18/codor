// Rail summaries: the server truth for every readable room (preview, working,
// attention, unread). Unread is cursor arithmetic — this device remembers the last
// message id it saw per room and the server counts past it; no cursor, no count.
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchRooms } from '@legacy/api.js';
import { useRoomStore } from '@legacy/state.js';

export interface RoomSummaryLatest {
  id: number;
  ts: string;
  kind: string;
  author_handle: string;
  author_kind: 'human' | 'agent' | 'extension';
  preview: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  created_ts: string;
  color?: string;
  working: boolean;
  attention: boolean;
  latest?: RoomSummaryLatest;
  unread: number;
}

const CURSOR_KEY = 'nx-room-cursors';
const POLL_MS = 30_000;

export function readCursors(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CURSOR_KEY) ?? '{}');
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

export function writeCursor(room: string, messageId: number): void {
  const cursors = readCursors();
  if ((cursors[room] ?? -1) >= messageId) return;
  cursors[room] = messageId;
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify(cursors));
  } catch {
    // Storage full/blocked: unread just stays served from the older cursor.
  }
}

async function fetchSummaries(token: string): Promise<RoomSummary[]> {
  const cursors = readCursors();
  const query = Object.entries(cursors)
    .map(([room, id]) => `${room}:${id}`)
    .join(',');
  const response = await fetch(
    `/api/rooms/summary${query === '' ? '' : `?cursors=${encodeURIComponent(query)}`}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`summary failed: ${response.status}`);
  const body = (await response.json()) as { rooms: RoomSummary[] };
  return body.rooms;
}

/** Poll the summary while connected; advance the active room's cursor as its
 *  messages arrive so its unread stays zero while the operator is looking at it. */
export function useRoomSummaries(activeRoom: string, token: () => string): RoomSummary[] {
  const connected = useRoomStore((s) => s.connected);
  const messages = useRoomStore((s) => s.messages);
  const [summaries, setSummaries] = useState<RoomSummary[]>([]);
  const busyRef = useRef(false);

  const refresh = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    void fetchSummaries(token())
      .then(setSummaries)
      .catch(() =>
        // A switchboard predating the summary endpoint still lists rooms —
        // rows degrade to name-only (no preview/working/unread) instead of
        // the rail collapsing to just the active channel.
        fetchRooms({ token: token() })
          .then((rooms) => setSummaries(rooms.map((room) => ({
            id: room.id,
            name: room.name,
            created_ts: room.created_ts,
            color: room.config.color,
            working: false,
            attention: false,
            unread: 0,
          }))))
          .catch(() => undefined),
      )
      .finally(() => {
        busyRef.current = false;
      });
  }, [token]);

  // The room being read is by definition read: its cursor follows the tail.
  useEffect(() => {
    const ids = Object.keys(messages).map(Number).filter(Number.isInteger);
    if (ids.length === 0) return;
    writeCursor(activeRoom, Math.max(...ids));
    setSummaries((prior) =>
      prior.map((room) => (room.id === activeRoom && room.unread !== 0 ? { ...room, unread: 0 } : room)),
    );
  }, [activeRoom, messages]);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
    // activeRoom in the deps: switching (incl. into a just-created channel)
    // refreshes the rail immediately instead of waiting out the poll.
  }, [connected, refresh, activeRoom]);

  return summaries;
}
