import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const uuids = vi.hoisted(() => ({ values: [] as string[], fallback: 0 }));
vi.mock('node:crypto', () => ({
  randomUUID: () => uuids.values.shift() ?? `fallback-${++uuids.fallback}`,
}));

import { Store } from './store.js';

let dir: string | undefined;
let store: Store | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.useRealTimers();
});

describe('delivery FIFO', () => {
  it('preserves insertion order when timestamps tie and ids sort in reverse', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
    uuids.values = ['z-last-sort', 'm-middle-sort', 'a-first-sort'];
    dir = mkdtempSync(join(tmpdir(), 'wireroom-store-order-'));
    store = new Store(join(dir, 'db.sqlite'));
    const { owner } = store.createRoom({
      id: 'eng',
      name: 'Eng',
      owner: { handle: 'richard', display_name: 'Richard' },
    });

    store.createDelivery('eng', { message_id: 1, recipient: owner.id });
    store.createDelivery('eng', { message_id: 2, recipient: owner.id });
    store.createDelivery('eng', { message_id: 3, recipient: owner.id });

    const deliveries = store.listDeliveries('eng', { recipient: owner.id });
    expect(new Set(deliveries.map((delivery) => delivery.ts)).size).toBe(1);
    expect(deliveries.map((delivery) => delivery.id)).toEqual([
      'z-last-sort',
      'm-middle-sort',
      'a-first-sort',
    ]);
  });
});
