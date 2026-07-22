import { describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from './index.js';

// harn:assume live-inbox-capability-is-evidence-backed-v2 ref=claude-capability-snapshot
describe('@codor/adapter-claude-code barrel', () => {
  it('exposes the adapter with its honest capabilities', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.id).toBe('claude-code');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: true,
      interactiveAttach: true,
      ask: true,
      approvals: 'runtime',
      extensions: true,
      thinking: true,
      thinking_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      live_inbox: true,
      policies: {
        'read-only': 'plan',
        'workspace-write': 'acceptEdits',
        'full-access': 'bypassPermissions',
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed-v2
