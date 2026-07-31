import type { RoomSummary } from '@codor/protocol';

import { fetchRooms } from '@runtime/api.js';

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

/**
 * Backoff schedule (ms) for the post-pairing channel-list load. Its total (~2.6
 * min) must comfortably cover the worst case: keepalive detection of a half-open
 * host link (~60s) plus teardown plus the host's own backoff reconnect (up to
 * ~60s), so the browser does not give up before the host is reachable again.
 */
export const AUTHORIZED_ROOMS_RETRY_MS = [500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000];

/** Per-attempt deadline: a hung request (no drop, no response) must not stall the schedule. */
export const AUTHORIZED_ROOMS_ATTEMPT_TIMEOUT_MS = 15_000;

interface RetryDeps {
  delaysMs?: number[];
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  attemptTimeout?: (ms: number) => Promise<void>;
}

/** One channel-list load bounded by a deadline: undefined on error OR timeout, so
 *  a never-settling request can never hang the caller. */
export async function loadAuthorizedRoomsOnce(token: string, deps: RetryDeps = {}): Promise<RoomSummary[] | undefined> {
  const ms = deps.attemptTimeoutMs ?? AUTHORIZED_ROOMS_ATTEMPT_TIMEOUT_MS;
  const attemptTimeout = deps.attemptTimeout ?? ((n: number) => new Promise<void>((resolve) => setTimeout(resolve, n)));
  const timedOut = Symbol('timeout');
  try {
    const result = await Promise.race<RoomSummary[] | typeof timedOut>([
      fetchAuthorizedRooms(token),
      attemptTimeout(ms).then(() => timedOut),
    ]);
    return result === timedOut ? undefined : result;
  } catch {
    return undefined; // request failed (session lost / error)
  }
}

/**
 * Keep retrying the channel-list load with backoff before giving up. A relay host
 * can take up to a keepalive missed-pong cycle to notice a silently stale link and
 * reconnect, so a paired launch in that window must not dead-end on the offline
 * screen. Each attempt is deadline-bounded; the whole schedule is bounded so a
 * genuinely offline device still settles. Returns undefined only after every
 * attempt fails.
 */
export async function retryAuthorizedRooms(token: string, deps: RetryDeps = {}): Promise<RoomSummary[] | undefined> {
  const delays = deps.delaysMs ?? AUTHORIZED_ROOMS_RETRY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const delay of delays) {
    await sleep(delay);
    const rooms = await loadAuthorizedRoomsOnce(token, deps);
    if (rooms !== undefined) return rooms;
  }
  return undefined;
}

/**
 * Resolve the authorized channels for bootstrap: one deadline-bounded attempt,
 * then — ONLY in relay mode with no room to fall back to — the extended backoff
 * retry that rides out a reconnecting relay host. The direct localhost/Tailscale
 * path keeps its fast-fail (a single failed load → the unavailable screen at
 * once), so an offline direct switchboard never leaves the root blank for minutes.
 */
export async function resolveAuthorizedRooms(
  token: string,
  opts: RetryDeps & { relayMode: boolean; explicit?: string; remembered?: string },
): Promise<RoomSummary[] | undefined> {
  const first = await loadAuthorizedRoomsOnce(token, opts);
  if (first !== undefined) return first;
  if (opts.relayMode && opts.explicit === undefined && opts.remembered === undefined) {
    return retryAuthorizedRooms(token, opts);
  }
  return undefined;
}
