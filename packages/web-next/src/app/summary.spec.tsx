// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { resolveRoomSummaries } from './summary.js';

describe('managed room summaries', () => {
  it('treats a loaded empty list as authoritative', () => {
    const previous = [{
      id: 'computer-A-room',
      name: 'A',
      created_ts: '2026-08-01T00:00:00.000Z',
      working: false,
      attention: false,
      unread: 0,
    }];

    expect(resolveRoomSummaries([], true, previous, {})).toEqual([]);
    expect(resolveRoomSummaries([], false, previous, {})).toEqual(previous);
  });

  // harn:assume worktree-child-conversations-stay-nested-and-isolated ref=worktree-summary-filter-regression
  it('keeps retained child slices out of the top-level channel projection', () => {
    const root = {
      id: 'workspace',
      name: 'Workspace',
      created_ts: '2026-08-01T00:00:00.000Z',
      working: false,
      attention: false,
      unread: 0,
    };
    const child = {
      id: 'wt-child',
      name: 'feature/review',
      created_ts: '2026-08-01T00:01:00.000Z',
      working: true,
      attention: false,
      unread: 4,
    };
    const projection = resolveRoomSummaries(
      [root, child],
      true,
      [],
      { 'wt-child': { room: { id: 'wt-child', name: 'feature/review' } } } as never,
      new Set(['wt-child']),
    );

    expect(projection.map((summary) => summary.id)).toEqual(['workspace']);
  });
  // harn:end worktree-child-conversations-stay-nested-and-isolated
});
