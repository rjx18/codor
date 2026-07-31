import type { RoomSummary } from '@codor/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetchAuthorizedRooms resolves via fetchSummaries, falling back to fetchRooms;
// mock both so a rejection models the whole channel-list load failing.
const fetchSummaries = vi.fn();
const fetchRooms = vi.fn();
vi.mock('@runtime/api.js', () => ({
  fetchRooms: (...args: unknown[]) => fetchRooms(...args),
}));
vi.mock('./summary.js', () => ({
  fetchSummaries: (...args: unknown[]) => fetchSummaries(...args),
  primeRoomSummaries: () => undefined,
}));

const { retryAuthorizedRooms, loadAuthorizedRoomsOnce, resolveAuthorizedRooms } = await import('./startup.js');

const summaries: RoomSummary[] = [{ id: 'eng', name: 'eng', created_ts: '2026-01-01T00:00:00.000Z', working: false, attention: false, unread: 0 } as unknown as RoomSummary];
const never = () => new Promise<void>(() => undefined); // an attemptTimeout that never fires
const immediately = () => Promise.resolve(); // an attemptTimeout that fires at once

beforeEach(() => {
  fetchSummaries.mockReset();
  fetchRooms.mockReset();
});

describe('retryAuthorizedRooms (post-pairing bootstrap resilience)', () => {
  it('recovers once the host reconnects, instead of dead-ending', async () => {
    // Two failures (stale relay link) then success — as when the host notices its
    // half-open socket and reconnects within a keepalive cycle.
    fetchSummaries
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(summaries);
    fetchRooms.mockRejectedValue(new Error('offline'));
    const sleeps: number[] = [];
    const rooms = await retryAuthorizedRooms('tok', {
      delaysMs: [10, 20, 40, 80],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      attemptTimeout: never,
    });
    expect(rooms).toEqual(summaries);
    expect(sleeps).toEqual([10, 20, 40]); // backed off, stopped as soon as it recovered
  });

  it('advances past a never-settling attempt via the per-attempt timeout', async () => {
    // A hung request (session up, no response, no drop) must not stall the schedule.
    fetchSummaries.mockReturnValue(new Promise(() => undefined));
    fetchRooms.mockReturnValue(new Promise(() => undefined));
    const sleeps: number[] = [];
    const rooms = await retryAuthorizedRooms('tok', {
      delaysMs: [10, 20],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      attemptTimeout: immediately, // each attempt times out at once
    });
    expect(rooms).toBeUndefined();
    expect(sleeps).toEqual([10, 20]); // the schedule still advanced despite hung fetches
  });

  it('returns undefined only after the whole schedule fails', async () => {
    fetchSummaries.mockRejectedValue(new Error('offline'));
    fetchRooms.mockRejectedValue(new Error('offline'));
    const rooms = await retryAuthorizedRooms('tok', {
      delaysMs: [10, 20, 40],
      sleep: () => Promise.resolve(),
      attemptTimeout: never,
    });
    expect(rooms).toBeUndefined();
  });
});

describe('loadAuthorizedRoomsOnce (deadline-bounded single attempt)', () => {
  it('returns undefined when the request times out rather than hanging', async () => {
    fetchSummaries.mockReturnValue(new Promise(() => undefined)); // never settles
    fetchRooms.mockReturnValue(new Promise(() => undefined));
    const rooms = await loadAuthorizedRoomsOnce('tok', { attemptTimeout: immediately });
    expect(rooms).toBeUndefined();
  });

  it('returns rooms on a fast success', async () => {
    fetchSummaries.mockResolvedValue(summaries);
    const rooms = await loadAuthorizedRoomsOnce('tok', { attemptTimeout: never });
    expect(rooms).toEqual(summaries);
  });
});

describe('resolveAuthorizedRooms (relay-only extended retry)', () => {
  it('does NOT enter the retry on the direct path — fast-fail preserved', async () => {
    fetchSummaries.mockRejectedValue(new Error('offline'));
    fetchRooms.mockRejectedValue(new Error('offline'));
    const sleeps: number[] = [];
    const rooms = await resolveAuthorizedRooms('tok', {
      relayMode: false,
      delaysMs: [10, 20, 40],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      attemptTimeout: never,
    });
    expect(rooms).toBeUndefined();
    expect(sleeps).toEqual([]); // no retry schedule entered — unavailable state on first failure, as today
  });

  it('enters the extended retry in relay mode with no fallback room', async () => {
    fetchSummaries.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(summaries);
    fetchRooms.mockRejectedValue(new Error('offline'));
    const sleeps: number[] = [];
    const rooms = await resolveAuthorizedRooms('tok', {
      relayMode: true,
      delaysMs: [10, 20, 40],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      attemptTimeout: never,
    });
    expect(rooms).toEqual(summaries);
    expect(sleeps).toEqual([10]); // retried and recovered
  });

  it('does not retry even in relay mode when a fallback room exists', async () => {
    fetchSummaries.mockRejectedValue(new Error('offline'));
    fetchRooms.mockRejectedValue(new Error('offline'));
    const sleeps: number[] = [];
    const rooms = await resolveAuthorizedRooms('tok', {
      relayMode: true,
      remembered: 'eng',
      delaysMs: [10, 20],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      attemptTimeout: never,
    });
    expect(rooms).toBeUndefined();
    expect(sleeps).toEqual([]); // a remembered room is the offline fallback — no long retry
  });
});
