import { describe, expect, it } from 'vitest';

import { groupByProject } from './project-groups.js';

describe('project channel groups', () => {
  it('groups projects alphabetically and keeps ungrouped channels last', () => {
    const groups = groupByProject([
      { id: 'unassigned' },
      { id: 'two', project: 'Zulu' },
      { id: 'one', project: 'Alpha' },
      { id: 'three', project: 'Alpha' },
    ]);

    expect(groups.map((group) => group.project)).toEqual(['Alpha', 'Zulu', undefined]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['one', 'three']);
  });
});
