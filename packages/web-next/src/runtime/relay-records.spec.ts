import { describe, expect, it } from 'vitest';

import {
  type RelayComputer,
  type RelayIndex,
  addComputer,
  emptyIndex,
  forgetComputer,
  migrateFromV1,
  selectActiveComputer,
  setActive,
} from './relay-records.js';

const pc = (id: string, paired_at: string): RelayComputer => ({ id, label: `pc-${id}`, paired_at, gen: 1 });
const index = (computers: RelayComputer[], active_id?: string): RelayIndex => ({ version: 2, computers, active_id });

describe('selectActiveComputer', () => {
  it('is undefined when there are no computers', () => {
    expect(selectActiveComputer(emptyIndex())).toBeUndefined();
  });

  it('returns the sole computer straight in (no active_id needed)', () => {
    expect(selectActiveComputer(index([pc('a', '2026-01-01')]))?.id).toBe('a');
  });

  it('honors a valid active_id over the last-paired default', () => {
    const i = index([pc('a', '2026-01-03'), pc('b', '2026-01-01')], 'b');
    expect(selectActiveComputer(i)?.id).toBe('b');
  });

  it('falls back to the last paired when active_id is stale', () => {
    const i = index([pc('a', '2026-01-01'), pc('b', '2026-01-03')], 'gone');
    expect(selectActiveComputer(i)?.id).toBe('b');
  });

  it('defaults multiple computers to the last paired', () => {
    const i = index([pc('a', '2026-01-01'), pc('b', '2026-01-05'), pc('c', '2026-01-03')]);
    expect(selectActiveComputer(i)?.id).toBe('b');
  });
});

describe('addComputer', () => {
  it('appends a new computer and makes it active', () => {
    const i = addComputer(index([pc('a', '2026-01-01')]), pc('b', '2026-01-02'));
    expect(i.computers.map((c) => c.id)).toEqual(['a', 'b']);
    expect(i.active_id).toBe('b');
  });

  it('re-pairing an existing computer updates it in place and reactivates it', () => {
    const i = addComputer(index([pc('a', '2026-01-01'), pc('b', '2026-01-02')], 'b'), {
      id: 'a',
      label: 'renamed',
      paired_at: '2026-02-01',
      gen: 2,
    });
    expect(i.computers).toHaveLength(2);
    expect(i.computers.find((c) => c.id === 'a')?.label).toBe('renamed');
    expect(i.active_id).toBe('a');
  });
});

describe('forgetComputer', () => {
  it('removes a non-active computer and keeps the active selection', () => {
    const i = forgetComputer(index([pc('a', '2026-01-01'), pc('b', '2026-01-02')], 'a'), 'b');
    expect(i.computers.map((c) => c.id)).toEqual(['a']);
    expect(i.active_id).toBe('a');
  });

  it('forgetting the active computer falls back to the last paired remaining', () => {
    const i = forgetComputer(index([pc('a', '2026-01-01'), pc('b', '2026-01-05'), pc('c', '2026-01-03')], 'b'), 'b');
    expect(i.computers.map((c) => c.id)).toEqual(['a', 'c']);
    expect(i.active_id).toBe('c'); // last paired of the remainder
  });

  it('forgetting the last computer drops to no active (⇒ code entry)', () => {
    const i = forgetComputer(index([pc('a', '2026-01-01')], 'a'), 'a');
    expect(i.computers).toHaveLength(0);
    expect(i.active_id).toBeUndefined();
  });
});

describe('setActive', () => {
  it('persists a switch to a known computer', () => {
    expect(setActive(index([pc('a', '1'), pc('b', '2')], 'a'), 'b').active_id).toBe('b');
  });
  it('is a no-op for an unknown id', () => {
    expect(setActive(index([pc('a', '1')], 'a'), 'zzz').active_id).toBe('a');
  });
});

describe('migrateFromV1', () => {
  it('turns a legacy single record into a one-computer active index', () => {
    const i = migrateFromV1(pc('legacy', '2026-01-01'));
    expect(i.version).toBe(2);
    expect(i.computers.map((c) => c.id)).toEqual(['legacy']);
    expect(i.active_id).toBe('legacy');
  });
  it('an install with no legacy record migrates to empty', () => {
    expect(migrateFromV1(undefined).computers).toHaveLength(0);
  });
});
