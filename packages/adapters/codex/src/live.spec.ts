import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@wireroom/protocol';
import { afterAll, describe, expect, it } from 'vitest';

import { CodexAdapter } from './adapter.js';

/**
 * Live smoke: two tiny real `codex exec` turns (PONG + resume), read-only
 * sandbox. Spend-gated behind WIREROOM_LIVE_SMOKE=1 so the suite doesn't
 * re-bill on every phase's `pnpm -r test`; run explicitly per phase spec.
 */
const LIVE = process.env.WIREROOM_LIVE_SMOKE === '1';

describe.skipIf(!LIVE)('codex live smoke (WIREROOM_LIVE_SMOKE=1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wireroom-codex-smoke-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const adapter = new CodexAdapter();
  const session = adapter.spawn({ cwd: dir, policy: 'read-only', model: 'gpt-5.4-mini' });

  it('PONG turn completes and captures a session_ref', { timeout: 180_000 }, async () => {
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(
      session,
      'Reply with the single word PONG and nothing else.',
    )) {
      events.push(event);
    }
    const done = events.find((e) => e.type === 'run.completed');
    expect(done).toMatchObject({ status: 'completed', final_text: 'PONG' });
    expect(session.session_ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('resume reuses the same thread and retains context', { timeout: 180_000 }, async () => {
    const events: WireEvent[] = [];
    const before = session.session_ref;
    for await (const event of adapter.deliver(
      session,
      'What word did you reply with last turn? Reply with that word only.',
    )) {
      events.push(event);
    }
    const done = events.find((e) => e.type === 'run.completed');
    expect(done).toMatchObject({ status: 'completed', final_text: 'PONG' });
    expect(session.session_ref).toBe(before);
  });

  it('discoverSessions sees the smoke thread in the rollout store', () => {
    expect(adapter.discoverSessions()).toContain(session.session_ref);
  });
});
