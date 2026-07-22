import { describe, expect, it } from 'vitest';

import { CursorAdapter } from './index.js';

// harn:assume live-inbox-capability-is-evidence-backed-v2 ref=cursor-capability-snapshot
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
        'read-only': '--mode plan',
        'workspace-write': '--force --sandbox enabled',
        'full-access': '--force --sandbox disabled',
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed-v2
