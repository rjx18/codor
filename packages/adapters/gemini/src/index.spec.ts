import { describe, expect, it } from 'vitest';

import { GeminiAdapter } from './index.js';

// harn:assume live-inbox-capability-is-evidence-backed-v2 ref=gemini-capability-snapshot
describe('@codor/adapter-gemini barrel', () => {
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
      live_inbox: false,
      policies: {
        'read-only': 'plan',
        'workspace-write': 'auto_edit',
        'full-access': 'yolo',
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed-v2
