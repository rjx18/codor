import { describe, expect, it } from 'vitest';

import { CopilotAdapter } from './index.js';

describe('@wireroom/adapter-copilot barrel', () => {
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
    });
  });
});
