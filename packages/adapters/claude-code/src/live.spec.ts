import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@wireroom/protocol';
import { afterAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from './adapter.js';

/**
 * Live smoke: one tiny PONG turn + one real AskUserQuestion answered through
 * respondInteraction on stdin. Spend-gated behind WIREROOM_LIVE_SMOKE=1.
 */
const LIVE = process.env.WIREROOM_LIVE_SMOKE === '1';

describe.skipIf(!LIVE)('claude live smoke (WIREROOM_LIVE_SMOKE=1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wireroom-claude-smoke-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const adapter = new ClaudeCodeAdapter();

  it('PONG turn completes with cost and captures a session_ref', { timeout: 240_000 }, async () => {
    const session = adapter.spawn({ cwd: dir });
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(
      session,
      'Reply with the single word PONG and nothing else.',
    )) {
      events.push(event);
    }
    const done = events.find((e) => e.type === 'run.completed');
    expect(done).toMatchObject({ status: 'completed', final_text: 'PONG' });
    expect((done as { usage?: { cost_usd?: number } }).usage?.cost_usd).toBeTypeOf('number');
    expect(session.session_ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a live AskUserQuestion is answered via stdin control', { timeout: 240_000 }, async () => {
    const session = adapter.spawn({ cwd: dir });
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(
      session,
      "Use the AskUserQuestion tool to ask me exactly one question: 'Which codeword?' " +
        'with exactly two options, ALPHA and BETA. After I answer, reply with only the chosen codeword.',
    )) {
      events.push(event);
      if (event.type === 'ask.raised') {
        await adapter.respondInteraction(session, event.card.interaction_id, {
          'Which codeword?': 'ALPHA',
        });
      }
    }
    expect(events.some((e) => e.type === 'ask.raised')).toBe(true);
    const done = events.find((e) => e.type === 'run.completed');
    expect(done).toMatchObject({ status: 'completed', final_text: 'ALPHA' });
  });
});
