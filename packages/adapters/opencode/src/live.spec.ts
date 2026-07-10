import { describe, expect, it } from 'vitest';

import { OpenCodeAdapter } from './adapter.js';

/**
 * The P1.7b live PONG was run exactly once and captured under fixtures/. This
 * opt-in check is for a future operator re-probe only; normal builds never spend.
 */
const LIVE = process.env.WIREROOM_OPENCODE_LIVE_SMOKE === '1';

describe.skipIf(!LIVE)('OpenCode live smoke (explicit re-probe only)', () => {
  it('returns PONG on the pinned free model', { timeout: 180_000 }, async () => {
    const adapter = new OpenCodeAdapter();
    const session = adapter.spawn({
      cwd: process.cwd(),
      model: 'opencode/deepseek-v4-flash-free',
      policy: 'read-only',
    });
    const events = [];
    for await (const event of adapter.deliver(session, 'Reply PONG only.')) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'completed',
      final_text: 'PONG',
    });
  });
});
