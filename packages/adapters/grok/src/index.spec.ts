import { describe, expect, it } from 'vitest';

import { GrokAdapter } from './index.js';

describe('@codor/adapter-grok barrel', () => {
  it('exposes the conservative native capability contract', () => {
    const adapter = new GrokAdapter();
    expect(adapter.id).toBe('grok');
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
      policies: {
        'read-only': null,
        'workspace-write': null,
        'full-access': '--always-approve',
      },
    });
  });
});
