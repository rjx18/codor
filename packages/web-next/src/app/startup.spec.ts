import type { RoomSummary } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { orderRooms, resolveStartupRoom } from './startup.js';

const room = (
  id: string,
  opts: { working?: boolean; latest?: string; created?: string } = {},
): RoomSummary => ({
  id,
  name: id,
  created_ts: opts.created ?? '2026-01-01T00:00:00.000Z',
  working: opts.working ?? false,
  attention: false,
  unread: 0,
  ...(opts.latest === undefined ? {} : { latest: { ts: opts.latest } }),
} as unknown as RoomSummary);

describe('resolveStartupRoom', () => {
  const authorized = [room('eng'), room('design'), room('ops')];

  it('prefers a valid explicit room over everything else', () => {
    expect(resolveStartupRoom(authorized, { explicit: 'ops', remembered: 'design' }))
      .toBe('ops');
  });

  it('falls back to a valid remembered room when none is named', () => {
    expect(resolveStartupRoom(authorized, { remembered: 'design' })).toBe('design');
  });

  it('discards an explicit room the account cannot see', () => {
    // A stale deep link must not become a speculative subscription.
    expect(resolveStartupRoom(authorized, { explicit: 'gone', remembered: 'design' }))
      .toBe('design');
  });

  it('discards a stale remembered room and falls to rail order', () => {
    expect(resolveStartupRoom(authorized, { remembered: 'deleted' }))
      .toBe(orderRooms(authorized)[0]?.id);
  });

  it('never invents a room when the account has none', () => {
    // The whole point: no placeholder id reaches a subscription.
    expect(resolveStartupRoom([], { explicit: 'eng', remembered: 'design' }))
      .toBeUndefined();
  });
});

describe('orderRooms', () => {
  it('puts working channels first, whatever their activity', () => {
    const quietWorking = room('a', { working: true, latest: '2026-01-01T00:00:00.000Z' });
    const busyIdle = room('b', { latest: '2026-06-01T00:00:00.000Z' });
    expect(orderRooms([busyIdle, quietWorking]).map((entry) => entry.id))
      .toEqual(['a', 'b']);
  });

  it('orders idle channels by latest activity', () => {
    const older = room('a', { latest: '2026-02-01T00:00:00.000Z' });
    const newer = room('b', { latest: '2026-05-01T00:00:00.000Z' });
    expect(orderRooms([older, newer]).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('breaks an activity tie with creation time, newest first', () => {
    const sameActivity = '2026-03-01T00:00:00.000Z';
    const oldRoom = room('a', { latest: sameActivity, created: '2026-01-01T00:00:00.000Z' });
    const newRoom = room('b', { latest: sameActivity, created: '2026-02-01T00:00:00.000Z' });
    expect(orderRooms([oldRoom, newRoom]).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('breaks a full tie by id, so the choice cannot depend on fetch order', () => {
    const created = '2026-01-01T00:00:00.000Z';
    const left = room('alpha', { created });
    const right = room('beta', { created });
    expect(orderRooms([right, left]).map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    expect(orderRooms([left, right]).map((entry) => entry.id)).toEqual(['alpha', 'beta']);
  });

  it('uses creation time when a room has no activity at all', () => {
    const never = room('a', { created: '2026-04-01T00:00:00.000Z' });
    const older = room('b', { latest: '2026-02-01T00:00:00.000Z' });
    expect(orderRooms([older, never]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
