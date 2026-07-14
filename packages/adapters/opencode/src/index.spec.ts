import { describe, expect, it } from 'vitest';

import { OpenCodeAdapter } from './index.js';

// harn:assume live-inbox-capability-is-evidence-backed ref=opencode-capability-snapshot
describe('@codor/adapter-opencode barrel', () => {
  it('exposes only demonstrated capabilities', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.id).toBe('opencode');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: true,
      interactiveAttach: true,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
      thinking: true,
      thinking_levels: ['low', 'medium', 'high'],
      live_inbox: false,
      // Only full-access is enforced; the other two defer to opencode's own rules.
      policies: {
        'read-only': null,
        'workspace-write': null,
        'full-access': '--auto',
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed
