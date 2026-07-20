import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session, WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AntigravityAdapter,
  antigravityArgs,
  antigravityMode,
  parseConversationId,
} from './adapter.js';

const FIXTURE_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];

/**
 * A fake `agy` binary. In print mode it echoes a canned reply, writes a
 * glog-style conversation line to the --log-file path, and exits with
 * CODOR_FAKE_EXIT (default 0). With the `models` subcommand it lists models.
 */
function executable(reply: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-antigravity-'));
  dirs.push(dir);
  const path = join(dir, 'agy');
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === 'models') {
  process.stdout.write('Gemini 3.5 Flash (High)\\nGemini 3.1 Pro (High)\\n');
  process.exit(0);
}
const logIdx = argv.indexOf('--log-file');
if (logIdx !== -1) {
  fs.writeFileSync(argv[logIdx + 1], 'I0719 server.go:952] Stream goroutine exited for ${FIXTURE_CONVERSATION}, sending completion signal\\n');
}
process.stdout.write(${JSON.stringify(reply)});
process.exit(Number(process.env.CODOR_FAKE_EXIT ?? '0'));
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: AntigravityAdapter, session: Session, payload: string): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(session, payload)) events.push(event);
  return events;
}

afterEach(() => {
  delete process.env.CODOR_FAKE_EXIT;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseConversationId', () => {
  it('recovers the last conversation uuid logged', () => {
    const log = [
      'I0719 server.go:952] Stream goroutine exited for aaaaaaaa-1111-4111-8111-111111111111, sending completion signal',
      'I0719 conversation_manager.go:654] Stream completed for bbbbbbbb-2222-4222-8222-222222222222, clearing ResponsePending',
    ].join('\n');
    expect(parseConversationId(log)).toBe('bbbbbbbb-2222-4222-8222-222222222222');
  });

  it('returns undefined when no uuid is present', () => {
    expect(parseConversationId('I0719 server.go:1] Starting language server process with pid 27624')).toBeUndefined();
  });
});

describe('antigravityMode', () => {
  it('maps canonical policies onto agy modes and the skip-permissions flag', () => {
    expect(antigravityMode('read-only')).toEqual({ mode: 'plan', skipPermissions: false });
    expect(antigravityMode('workspace-write')).toEqual({ mode: 'accept-edits', skipPermissions: false });
    expect(antigravityMode('full-access')).toEqual({ mode: 'accept-edits', skipPermissions: true });
    expect(antigravityMode(undefined)).toEqual({ mode: 'accept-edits', skipPermissions: false });
    expect(() => antigravityMode('plan')).toThrow('valid policies');
  });
});

describe('antigravityArgs', () => {
  it('builds print, model, mode, add-dir, and log-file without stdin', () => {
    const args = antigravityArgs(
      { harness: 'antigravity', cwd: '/work', model: 'Gemini 3.5 Flash (High)', policy: 'workspace-write' },
      'do the thing',
      '/tmp/agy.log',
    );
    expect(args).toEqual([
      '--mode', 'accept-edits',
      '--add-dir', '/work',
      '--log-file', '/tmp/agy.log',
      '--print-timeout', '30m',
      '--model', 'Gemini 3.5 Flash (High)',
      '--print', 'do the thing',
    ]);
  });

  it('adds --dangerously-skip-permissions for full-access', () => {
    const args = antigravityArgs({ harness: 'antigravity', cwd: '/w', policy: 'full-access' }, 'go', '/tmp/l');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('adds --conversation only when resuming a known session', () => {
    const fresh = antigravityArgs({ harness: 'antigravity', cwd: '/w' }, 'go', '/tmp/l');
    expect(fresh).not.toContain('--conversation');
    const resumed = antigravityArgs({ harness: 'antigravity', cwd: '/w', session_ref: FIXTURE_CONVERSATION }, 'go', '/tmp/l');
    expect(resumed).toEqual(expect.arrayContaining(['--conversation', FIXTURE_CONVERSATION]));
  });

  it('rejects thinking levels the harness does not support', () => {
    expect(() => antigravityArgs({ harness: 'antigravity', cwd: '/w', thinking: 'high' }, 'go', '/tmp/l'))
      .toThrow('does not support thinking');
  });
});

describe('AntigravityAdapter subprocess and capability conformance', () => {
  it('streams the reply, completes, and recovers the conversation id from the log', async () => {
    const adapter = new AntigravityAdapter(executable('the antigravity reply'));
    const session = adapter.spawn({ cwd: process.cwd(), policy: 'workspace-write' });
    expect(session.session_ref).toBeUndefined();

    const events = await collect(adapter, session, 'hello');

    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'run.completed', status: 'completed', final_text: 'the antigravity reply' });
    expect(events.some((event) => event.type === 'run.item' && event.item_type === 'text_delta')).toBe(true);
    // The conversation id was captured for resume even though it never hit stdout.
    expect(session.session_ref).toBe(FIXTURE_CONVERSATION);
  });

  it('turns a nonzero exit into a failed run', async () => {
    process.env.CODOR_FAKE_EXIT = '1';
    const adapter = new AntigravityAdapter(executable('partial'));
    const session = adapter.spawn({ cwd: process.cwd() });
    const events = await collect(adapter, session, 'hello');
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
  });

  it('turns a missing command into a failed run', async () => {
    const adapter = new AntigravityAdapter(join(tmpdir(), 'codor-antigravity-does-not-exist'));
    const session = adapter.spawn({ cwd: process.cwd() });
    const events = await collect(adapter, session, 'hello');
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
  });

  it('discovers models from the agy models subcommand', async () => {
    const adapter = new AntigravityAdapter(executable('unused'));
    await expect(adapter.listModels()).resolves.toEqual({
      models: ['Gemini 3.5 Flash (High)', 'Gemini 3.1 Pro (High)'],
      source: 'discovered',
    });
  });

  it('declares resume without discovery and rejects interaction responses', async () => {
    const adapter = new AntigravityAdapter(executable('x'));
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.capabilities.discover).toBe(false);
    expect(adapter.discoverSessions()).toEqual([]);
    await expect(adapter.respondInteraction()).rejects.toThrow('no interaction response channel');
  });
});
