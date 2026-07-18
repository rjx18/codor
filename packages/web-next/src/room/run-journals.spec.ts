import type { WireEvent } from '@codor/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchRunEvents: vi.fn() }));
vi.mock('@legacy/api.js', () => api);

import {
  activateRunJournalRoom,
  getRunJournal,
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
