import { describe, expect, it } from 'vitest';

import { GeminiAdapter } from './index.js';

describe('@wireroom/adapter-gemini barrel', () => {
  it('exposes only demonstrated capabilities', () => {
    const adapter = new GeminiAdapter();
    expect(adapter.id).toBe('gemini');
    expect(adapter.capabilities).toEqual({
      resume: true,
      discover: true,
      interactiveAttach: true,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
      thinking: false,
    });
  });
});
