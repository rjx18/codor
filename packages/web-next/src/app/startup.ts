import type { RoomSummary } from '@codor/protocol';

import { fetchRooms } from '@legacy/api.js';

import { fetchSummaries, primeRoomSummaries } from './summary.js';

const REMEMBERED_ROOM_KEY = 'codor:web-next:room';

/**
 * The room this launch should open, or `undefined` when the account has none.
 *
 * There is deliberately no `'default'` anywhere in this path. A launch at `/`
 * used to subscribe to a room named `default` that no account owns, so the PWA
 * opened a phantom channel, hydrated nothing, and left a `room:"default"`
 * subscription on the socket for reconnect logic to faithfully restore.
 *
 * Precedence is explicit-then-remembered-then-rail-order, and every step is
 * validated against the authorized set: an id the operator can no longer see is
 * discarded rather than subscribed to speculatively.
 */
export function resolveStartupRoom(
  authorized: RoomSummary[],
  opts: { explicit?: string; remembered?: string },
): string | undefined {
  const known = (id: string | undefined): string | undefined =>
    id !== undefined && authorized.some((room) => room.id === id) ? id : undefined;
  return known(opts.explicit) ?? known(opts.remembered) ?? orderRooms(authorized)[0]?.id;
}

/**
 * Rail ordering: working channels first, then most recent activity, then
 * creation time. It matches what the rail itself renders, so "the first room"
 * means the same thing to the bootstrap and to the operator looking at it.
 * Creation time breaks activity ties, and the id breaks those, so the choice is
 * stable rather than dependent on fetch order.
 */
export function orderRooms(rooms: RoomSummary[]): RoomSummary[] {
  const activity = (room: RoomSummary): number =>
    Date.parse(room.latest?.ts ?? room.created_ts) || 0;
  return [...rooms].sort((left, right) => {
    if (left.working !== right.working) return left.working ? -1 : 1;
    const byActivity = activity(right) - activity(left);
    if (byActivity !== 0) return byActivity;
    const byCreation = (Date.parse(right.created_ts) || 0) - (Date.parse(left.created_ts) || 0);
    return byCreation !== 0 ? byCreation : left.id.localeCompare(right.id);
  });
}

export function rememberedRoom(): string | undefined {
  try {
    return window.localStorage.getItem(REMEMBERED_ROOM_KEY) ?? undefined;
  } catch {
    return undefined; // storage denied: a launch must still open a room
  }
}

export function rememberRoom(id: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_ROOM_KEY, id);
  } catch {
    // Remembering is a convenience, never a precondition for opening a room.
  }
}

export function forgetRoom(): void {
  try {
    window.localStorage.removeItem(REMEMBERED_ROOM_KEY);
  } catch {
    // Nothing to do; the stale id is already ignored by validation.
  }
}

/**
 * The authorized set, fetched BEFORE any connector exists. `useRooms()` cannot
 * serve this: it is connection-gated, and the connection is what we are trying
 * to point at a real room. Summaries carry the ordering signals, so they are
 * the primary source; the plain room list is the fallback when they fail.
 */
export async function fetchAuthorizedRooms(token: string): Promise<RoomSummary[]> {
  try {
    const summaries = await fetchSummaries(token);
    primeRoomSummaries(summaries); // the rail reuses this; one request per launch
    return summaries;
  } catch {
    const rooms = await fetchRooms({ token });
    const summaries = rooms.map((room) => ({
      id: room.id,
      name: room.name,
      created_ts: room.created_ts,
      color: room.config.color,
      working: false,
      attention: false,
      unread: 0,
    }));
    primeRoomSummaries(summaries);
    return summaries;
  }
}
