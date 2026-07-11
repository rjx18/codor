import { describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from './index.js';

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
    });
  });
});
