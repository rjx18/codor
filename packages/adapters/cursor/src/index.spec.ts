import { describe, expect, it } from 'vitest';

import { CursorAdapter } from './index.js';

describe('@codor/adapter-cursor barrel', () => {
  it('exposes only demonstrated capabilities', () => {
    const adapter = new CursorAdapter();
    expect(adapter.id).toBe('cursor');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: false,
      interactiveAttach: false,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
      thinking: false,
      live_inbox: false,
      policies: {
        'read-only': 'plan',
        'workspace-write': 'force+sandbox',
        'full-access': 'yolo',
      },
    });
  });
});
