import { describe, expect, it } from 'vitest';

import { OpenCodeAdapter } from './index.js';

describe('@wireroom/adapter-opencode barrel', () => {
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
    });
  });
});
