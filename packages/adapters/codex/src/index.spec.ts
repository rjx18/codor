import { describe, expect, it } from 'vitest';

import { CodexAdapter } from './index.js';

// harn:assume live-inbox-capability-is-evidence-backed ref=codex-capability-snapshot
describe('@codor/adapter-codex barrel', () => {
  it('exposes the adapter with its honest capabilities', () => {
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe('codex');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: true,
      interactiveAttach: true,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
      thinking: true,
      live_inbox: false,
      policies: {
        'read-only': 'read-only',
        'workspace-write': 'workspace-write',
        'full-access': 'danger-full-access',
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed
