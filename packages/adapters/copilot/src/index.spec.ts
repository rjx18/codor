import { describe, expect, it } from 'vitest';

import { CopilotAdapter } from './index.js';

describe('@codor/adapter-copilot barrel', () => {
  it('exposes only documented and fixture-demonstrated capabilities', () => {
    const adapter = new CopilotAdapter();
    expect(adapter.id).toBe('copilot');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: true,
      interactiveAttach: true,
      ask: false,
      approvals: 'spawn-time',
      extensions: true,
      thinking: false,
      // Only full-access is enforced; the other two defer to copilot's own rules.
      policies: {
        'read-only': null,
        'workspace-write': null,
        'full-access': '--allow-all',
      },
    });
  });
});
