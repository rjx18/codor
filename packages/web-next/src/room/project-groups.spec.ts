import { describe, expect, it } from 'vitest';

import { groupByProject, projectArchiveStatus } from './project-groups.js';

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

  it('distinguishes projects with active channels from fully archived projects', () => {
    const active = [{ id: 'active', project: 'PersonalOS' }];

    expect(projectArchiveStatus('PersonalOS', active)).toBe('still-active');
    expect(projectArchiveStatus('Completed', active)).toBe('fully-archived');
  });
});
