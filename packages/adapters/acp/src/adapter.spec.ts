import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Session, WireEvent } from '@codor/protocol';

import { AcpAdapter, resolveAcpExecutable } from './adapter.js';

const fake = fileURLToPath(new URL('../test-fixtures/fake-agent.mjs', import.meta.url));

const launch = (...args: string[]) => ({ executable: process.execPath, argv: [fake, ...args] });

async function collectTurn(adapter: AcpAdapter, session: Session): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  const iterator = adapter.deliver(session, 'hello')[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === 'approval.raised') {
      await adapter.respondInteraction(session, next.value.card.interaction_id, 'Allow once');
    }
  }
  return events;
}

// harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-adapter-regression
describe('ACP adapter', () => {
  it('resolves executable files and symlinks but rejects executable-named directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-path-'));
    const executable = join(dir, 'agent');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    symlinkSync(executable, join(dir, 'linked'));
    mkdirSync(join(dir, 'directory'), { mode: 0o755 });
    expect(resolveAcpExecutable('agent', { PATH: dir })).toBe(executable);
    expect(resolveAcpExecutable('linked', { PATH: dir })).toBe(join(dir, 'linked'));
    expect(() => resolveAcpExecutable('directory', { PATH: dir })).toThrow('executable is unavailable');
  });

  it('negotiates v1, streams canonical evidence, resolves permission, and reuses the process', async () => {
    const adapter = new AcpAdapter();
    const session = adapter.spawn({ cwd: process.cwd(), acp_launch: launch() });
    const runtimeSnapshots: unknown[] = [];
    const first: WireEvent[] = [];
    const iterator = adapter.deliver(session, 'hello', {
      onSessionRuntime: (runtime) => runtimeSnapshots.push(runtime),
    })[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      first.push(next.value);
      if (next.value.type === 'approval.raised') {
        await adapter.respondInteraction(session, next.value.card.interaction_id, 'Allow once');
      }
    }
    expect(runtimeSnapshots).toEqual([{
      session_ref: 'fake-acp-session', lifecycle: { load: true, resume: true },
    }]);
    expect(first.map((event) => event.type)).toContain('approval.raised');
    expect(first).toContainEqual(expect.objectContaining({
      type: 'run.completed', status: 'completed',
      usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
    }));
    expect(await collectTurn(adapter, session)).toContainEqual(expect.objectContaining({
      type: 'run.completed', status: 'completed',
      usage: { input_tokens: 6, cached_input_tokens: 2, output_tokens: 4 },
    }));
    expect(session.acp_usage_baseline).toMatchObject({ totalTokens: 33, inputTokens: 16 });
    adapter.interrupt(session);
  });

  it('restores through any persisted common mechanism and fails only when all disappear', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'codor-acp-log-')), 'methods.txt');
    const restored: Session = {
      harness: 'acp', cwd: process.cwd(), session_ref: 'fake-acp-session',
      lifecycle: { load: true, resume: true },
      acp_usage_baseline: { totalTokens: 100, inputTokens: 60, outputTokens: 30 },
      acp_launch: launch('--log', log, '--no-resume'),
    };
    const adapter = new AcpAdapter();
    expect(await collectTurn(adapter, restored)).toContainEqual(expect.objectContaining({
      status: 'completed',
      usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
    }));
    expect(readFileSync(log, 'utf8')).toContain('session/load');
    adapter.interrupt(restored);

    const unavailable: Session = {
      ...restored,
      acp_launch: launch('--no-resume', '--no-load'),
    };
    const failed = await collectTurn(new AcpAdapter(), unavailable);
    expect(failed).toEqual([expect.objectContaining({
      type: 'run.completed', status: 'failed',
      error: 'ACP agent no longer supports a persisted restoration mechanism',
    })]);
  });

  it('uses ACP cancellation and reports an interrupted terminal result', async () => {
    const adapter = new AcpAdapter();
    const session = adapter.spawn({ cwd: process.cwd(), acp_launch: launch('--wait') });
    const events: WireEvent[] = [];
    const iterator = adapter.deliver(session, 'wait')[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 50));
    adapter.interrupt(session);
    for (let next = await pending; !next.done; next = await iterator.next()) events.push(next.value);
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', status: 'interrupted' }));
  });

  it('reports provider prompt failures once without exposing provider details', async () => {
    const adapter = new AcpAdapter();
    const session = adapter.spawn({ cwd: process.cwd(), acp_launch: launch('--fail') });
    const events = await collectTurn(adapter, session);
    expect(events).toEqual([{
      type: 'run.completed', status: 'failed', error: 'ACP agent turn failed',
    }]);
    adapter.interrupt(session);
  });
});
// harn:end acp-v1-events-and-capabilities-are-negotiated
