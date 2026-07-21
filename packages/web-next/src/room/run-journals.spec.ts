import type { WireEvent } from '@codor/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchRunEvents: vi.fn() }));
vi.mock('@runtime/api.js', () => api);

import {
  activateRunJournalRoom,
  getRunJournal,
  refreshMutableRunJournals,
  requestRunJournal,
  resetRunJournalsForTest,
} from './run-journals.js';

const token = (): string => 'test-token';
const journal = (room: string): WireEvent[] => [{
  type: 'run.item',
  item_type: 'text_delta',
  payload: { text: `${room} evidence` },
}];

beforeEach(() => {
  resetRunJournalsForTest();
  api.fetchRunEvents.mockReset();
  api.fetchRunEvents.mockImplementation(async (room: string) => journal(room));
});

describe('room-keyed run journal cache', () => {
  it('retains a visited room without colliding on room-local message ids', async () => {
    activateRunJournalRoom('alpha');
    requestRunJournal('alpha', token, 7, { terminal: true });
    await vi.waitFor(() => expect(getRunJournal('alpha', 7)).toEqual(journal('alpha')));

    activateRunJournalRoom('beta');
    requestRunJournal('beta', token, 7, { terminal: true });
    await vi.waitFor(() => expect(getRunJournal('beta', 7)).toEqual(journal('beta')));

    activateRunJournalRoom('alpha');
    requestRunJournal('alpha', token, 7, { terminal: true });
    expect(getRunJournal('alpha', 7)).toEqual(journal('alpha'));
    expect(getRunJournal('beta', 7)).toEqual(journal('beta'));
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(2);
  });

  it('bounds retained rooms and refetches an evicted room', async () => {
    for (const room of ['alpha', 'beta', 'gamma', 'delta']) {
      activateRunJournalRoom(room);
      requestRunJournal(room, token, 1, { terminal: true });
      await vi.waitFor(() => expect(getRunJournal(room, 1)).toEqual(journal(room)));
    }

    expect(getRunJournal('alpha', 1)).toBeUndefined();
    expect(getRunJournal('beta', 1)).toEqual(journal('beta'));

    activateRunJournalRoom('alpha');
    requestRunJournal('alpha', token, 1, { terminal: true });
    await vi.waitFor(() => expect(getRunJournal('alpha', 1)).toEqual(journal('alpha')));
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(5);
  });
});

describe('refreshMutableRunJournals', () => {
  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  };

  it('re-reads mutable evidence and leaves terminal evidence alone', async () => {
    api.fetchRunEvents.mockResolvedValue(journal('eng'));
    activateRunJournalRoom('eng');
    requestRunJournal('eng', token, 1, { terminal: false }); // still running
    requestRunJournal('eng', token, 2, { terminal: true }); // settled
    await settle();
    const readsBefore = api.fetchRunEvents.mock.calls.length;

    refreshMutableRunJournals('eng', token);
    await settle();

    const refreshed = api.fetchRunEvents.mock.calls.slice(readsBefore).map((call) => call[1]);
    // The still-running turn is re-read; the settled one is final and is not.
    expect(refreshed).toContain(1);
    expect(refreshed).not.toContain(2);
  });

  it('queues exactly one follow-up read for an in-flight journal', async () => {
    let release: ((events: WireEvent[]) => void) | undefined;
    api.fetchRunEvents.mockImplementation(async () => await new Promise<WireEvent[]>((resolve) => {
      release = resolve;
    }));
    activateRunJournalRoom('eng');
    requestRunJournal('eng', token, 7, { terminal: false });
    await settle();
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(1);

    // Several resumes land while that read is still outstanding.
    refreshMutableRunJournals('eng', token);
    refreshMutableRunJournals('eng', token);
    refreshMutableRunJournals('eng', token);
    await settle();
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(1); // nothing stacked up

    api.fetchRunEvents.mockResolvedValue(journal('eng'));
    release?.(journal('eng'));
    await settle();

    // Exactly ONE follow-up, not one per refresh.
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(2);
  });

  it('never reads journals for an inactive room', async () => {
    api.fetchRunEvents.mockResolvedValue(journal('eng'));
    activateRunJournalRoom('eng');
    requestRunJournal('eng', token, 3, { terminal: false });
    await settle();
    const readsBefore = api.fetchRunEvents.mock.calls.length;

    activateRunJournalRoom('design');
    refreshMutableRunJournals('eng', token);
    await settle();

    expect(api.fetchRunEvents.mock.calls.length).toBe(readsBefore);
  });
});

describe('terminal reads dominate queued mutable reads', () => {
  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
  };

  it('never lets a queued refresh overwrite final evidence', async () => {
    // Fill all four slots so the next reads have to queue rather than run.
    const holds: ((events: WireEvent[]) => void)[] = [];
    api.fetchRunEvents.mockImplementation(async () => await new Promise<WireEvent[]>((resolve) => {
      holds.push(resolve);
    }));
    activateRunJournalRoom('eng');
    for (const id of [101, 102, 103, 104]) {
      requestRunJournal('eng', token, id, { terminal: false });
    }
    await settle();
    expect(api.fetchRunEvents).toHaveBeenCalledTimes(4); // every slot busy

    // A resume queues a MUTABLE read for id 9, and the run then settles and
    // asks for a TERMINAL read of the same id. Both are pending at once.
    requestRunJournal('eng', token, 9, { terminal: false });
    requestRunJournal('eng', token, 9, { terminal: true });

    // Free the slots; the queued work now runs.
    api.fetchRunEvents.mockResolvedValue(journal('eng'));
    for (const release of holds) release(journal('eng'));
    await settle();

    // Exactly one read for id 9 — the terminal one — so the mutable snapshot
    // can never land second and overwrite the final evidence.
    const readsForNine = api.fetchRunEvents.mock.calls.filter((call) => call[1] === 9);
    expect(readsForNine).toHaveLength(1);

    // And it is cached as terminal, so IT is never read again — while the
    // still-running ids remain refreshable, which is the point of the split.
    requestRunJournal('eng', token, 9, { terminal: true });
    refreshMutableRunJournals('eng', token);
    await settle();
    expect(api.fetchRunEvents.mock.calls.filter((call) => call[1] === 9)).toHaveLength(1);
  });
});
