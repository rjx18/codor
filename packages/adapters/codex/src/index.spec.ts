import { describe, expect, it } from 'vitest';

import { CodexAdapter } from './index.js';

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
      policies: {
        'read-only': 'read-only',
        'workspace-write': 'workspace-write',
        'full-access': 'danger-full-access',
      },
    });
  });
});
