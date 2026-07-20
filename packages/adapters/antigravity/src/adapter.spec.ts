import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const FIRST_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const LAST_CONVERSATION = '22222222-2222-4222-8222-222222222222';
const temporary: string[] = [];

function executable(options: {
  reply?: string;
  models?: string[];
  log?: boolean;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-antigravity-'));
  temporary.push(dir);
  const path = join(dir, 'agy');
  const reply = options.reply ?? 'the antigravity reply';
  const models = options.models ?? ['Gemini 3.5 Flash (High)', 'Gemini 3.1 Pro (High)'];
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === 'models') {
  process.stdout.write(${JSON.stringify(`${models.join('\n')}\n`)});
  process.exit(0);
}
const logIndex = argv.indexOf('--log-file');
if (logIndex !== -1 && ${options.log !== false}) {
  const log = argv[logIndex + 1];
  fs.writeFileSync(log, 'Stream exited for ${FIRST_CONVERSATION}\\nStream completed for ${LAST_CONVERSATION}\\n');
  if (process.env.CODOR_CAPTURE_LOG) fs.writeFileSync(process.env.CODOR_CAPTURE_LOG, log);
}
if (process.env.CODOR_FAKE_HANG === '1') setInterval(() => {}, 1000);
else {
  const text = process.env.CODOR_FAKE_ECHO_ARGV === '1'
    ? argv.join('\\n')
    : process.env.CODOR_FAKE_ECHO_ENV === '1'
      ? String(process.env.CODOR_TEST_MEMBER ?? '')
      : ${JSON.stringify(reply)};
  process.stdout.write(text, () => process.exit(Number(process.env.CODOR_FAKE_EXIT ?? '0')));
}
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

async function collect(
  adapter: AntigravityAdapter,
  session: Session,
  payload: string,
  hooks: Parameters<AntigravityAdapter['deliver']>[2] = {},
): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(session, payload, hooks)) events.push(event);
  return events;
}

afterEach(() => {
  for (const key of [
    'CODOR_CAPTURE_LOG',
    'CODOR_FAKE_ECHO_ARGV',
    'CODOR_FAKE_ECHO_ENV',
    'CODOR_FAKE_EXIT',
    'CODOR_FAKE_HANG',
    'CODOR_TEST_MEMBER',
  ]) delete process.env[key];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Antigravity protocol translation', () => {
  it('takes the last conversation UUID and ignores unrelated log lines', () => {
    expect(parseConversationId([
      `Stream exited for ${FIRST_CONVERSATION}`,
      'unrelated pid 123',
      `Stream completed for ${LAST_CONVERSATION}`,
    ].join('\n'))).toBe(LAST_CONVERSATION);
    expect(parseConversationId('no conversation here')).toBeUndefined();
  });

  it('maps canonical controls to exact agy argv and rejects thinking', () => {
    expect(antigravityMode('read-only')).toEqual({ mode: 'plan', skipPermissions: false });
    expect(antigravityMode('workspace-write')).toEqual({ mode: 'accept-edits', skipPermissions: false });
    expect(antigravityMode('full-access')).toEqual({ mode: 'accept-edits', skipPermissions: true });
    expect(() => antigravityMode('plan')).toThrow('valid policies');
    expect(antigravityArgs({
      harness: 'antigravity',
      cwd: '/work',
      model: 'Gemini 3.5 Flash (High)',
      policy: 'workspace-write',
      session_ref: LAST_CONVERSATION,
    }, '-prompt', '/tmp/agy.log')).toEqual([
      '--mode', 'accept-edits',
      '--add-dir', '/work',
      '--log-file', '/tmp/agy.log',
      '--print-timeout', '30m',
      '--model', 'Gemini 3.5 Flash (High)',
      '--conversation', LAST_CONVERSATION,
      '--print', '-prompt',
    ]);
    expect(() => antigravityArgs({
      harness: 'antigravity', cwd: '/work', thinking: 'high',
    }, 'go', '/tmp/log')).toThrow('does not support thinking');
  });
});

describe('AntigravityAdapter', () => {
  // harn:assume antigravity-session-resume-is-log-derived ref=antigravity-resume-regression
  it('streams one turn, reports its pid, promotes the last log id, and removes the log', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'codor-agy-log-'));
    temporary.push(captureDir);
    const capture = join(captureDir, 'path');
    process.env.CODOR_CAPTURE_LOG = capture;
    const adapter = new AntigravityAdapter(executable());
    const session = adapter.spawn({ cwd: process.cwd(), policy: 'workspace-write' });
    const started: number[] = [];
    const refs: string[] = [];
    const events = await collect(adapter, session, 'hello', {
      onStarted: ({ pid }) => { if (pid !== undefined) started.push(pid); },
      onSessionRef: (ref) => refs.push(ref),
    });
    expect(started).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', final_text: 'the antigravity reply',
    });
    expect(session.session_ref).toBe(LAST_CONVERSATION);
    expect(refs).toEqual([LAST_CONVERSATION]);
    expect(existsSync(readFileSync(capture, 'utf8'))).toBe(false);
  });

  it('starts fresh without inventing a session id when the log has none', async () => {
    const adapter = new AntigravityAdapter(executable({ log: false }));
    const session = adapter.spawn({ cwd: process.cwd() });
    const refs: string[] = [];
    await collect(adapter, session, 'hello', { onSessionRef: (ref) => refs.push(ref) });
    expect(session.session_ref).toBeUndefined();
    expect(refs).toEqual([]);
  });
  // harn:end antigravity-session-resume-is-log-derived

  // harn:assume antigravity-plain-output-is-bounded ref=antigravity-output-bound-regression
  it('bounds Unicode stdout and discloses truncation in exactly one terminal event', async () => {
    const adapter = new AntigravityAdapter(executable({ reply: 'é'.repeat(150_000) }));
    const events = await collect(adapter, adapter.spawn({ cwd: process.cwd() }), 'hello');
    const deltas = events.filter((event) => event.type === 'run.item' && event.item_type === 'text_delta');
    const liveBytes = deltas.reduce((sum, event) => (
      sum + Buffer.byteLength(String(event.payload.text), 'utf8')
    ), 0);
    const completed = events.filter((event) => event.type === 'run.completed');
    expect(liveBytes).toBeLessThanOrEqual(256 * 1024);
    expect(completed).toHaveLength(1);
    expect(Buffer.byteLength(String(completed[0]!.final_text), 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(String(completed[0]!.final_text).endsWith('[output truncated]')).toBe(true);
    expect(String(completed[0]!.final_text)).not.toContain('\uFFFD');
  });
  // harn:end antigravity-plain-output-is-bounded

  // harn:assume adapter-children-inherit-session-env ref=antigravity-env-regression
  it('merges the member environment into the agy child', async () => {
    process.env.CODOR_FAKE_ECHO_ENV = '1';
    const adapter = new AntigravityAdapter(executable());
    const events = await collect(adapter, {
      harness: 'antigravity', cwd: process.cwd(), env: { CODOR_TEST_MEMBER: 'member-value' },
    }, 'hello');
    expect(events.at(-1)).toMatchObject({ final_text: 'member-value' });
  });
  // harn:end adapter-children-inherit-session-env

  it('maps discovered slugs back to display names and rejects collisions', async () => {
    process.env.CODOR_FAKE_ECHO_ARGV = '1';
    const adapter = new AntigravityAdapter(executable());
    await expect(adapter.listModels()).resolves.toEqual({
      models: ['gemini-3.5-flash-high', 'gemini-3.1-pro-high'],
      source: 'discovered',
    });
    const events = await collect(adapter, adapter.spawn({
      cwd: process.cwd(), model: 'gemini-3.5-flash-high',
    }), 'hello');
    const argv = String((events.at(-1) as { final_text?: string }).final_text).split('\n');
    expect(argv[argv.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (High)');

    const collision = new AntigravityAdapter(executable({ models: ['A B', 'A-B'] }));
    await expect(collision.listModels()).rejects.toThrow("collide at slug 'a-b'");
  });

  it('classifies missing commands and nonzero exits as failed', async () => {
    const missing = new AntigravityAdapter(join(tmpdir(), 'codor-agy-missing'));
    expect((await collect(missing, missing.spawn({ cwd: process.cwd() }), 'hello')).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    process.env.CODOR_FAKE_EXIT = '7';
    const failing = new AntigravityAdapter(executable({ reply: 'partial' }));
    expect((await collect(failing, failing.spawn({ cwd: process.cwd() }), 'hello')).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed', final_text: 'partial' });
  });

  it('interrupts the active process group and emits one interrupted terminal', async () => {
    process.env.CODOR_FAKE_HANG = '1';
    const adapter = new AntigravityAdapter(executable());
    const session = adapter.spawn({ cwd: process.cwd() });
    const events = await collect(adapter, session, 'hello', {
      onStarted: () => adapter.interrupt(session),
    });
    expect(events.filter((event) => event.type === 'run.completed')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
  });

  it('declares best-effort resume without discovery or interaction response', async () => {
    const adapter = new AntigravityAdapter(executable());
    expect(adapter.capabilities).toMatchObject({ resume: true, discover: false, thinking: false });
    expect(adapter.discoverSessions()).toEqual([]);
    await expect(adapter.respondInteraction()).rejects.toThrow('no interaction response channel');
  });
});
