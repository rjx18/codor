import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { GeminiAdapter, geminiApprovalMode, geminiArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-gemini-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-gemini');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: GeminiAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Gemini subprocess and capability conformance', () => {
  it('maps Codor policy chips onto Gemini approval modes', () => {
    expect(geminiApprovalMode('read-only')).toBe('plan');
    expect(geminiApprovalMode('workspace-write')).toBe('auto_edit');
    expect(geminiApprovalMode('full-access')).toBe('yolo');
    expect(() => geminiApprovalMode('plan')).toThrow('valid policies');
    for (const [policy, mode] of [
      ['read-only', 'plan'],
      ['workspace-write', 'auto_edit'],
      ['full-access', 'yolo'],
    ] as const) {
      expect(geminiArgs({ harness: 'gemini', cwd: '/work', policy }, 'go'))
        .toEqual(expect.arrayContaining(['--approval-mode', mode]));
    }
    for (const thinking of ['low', 'medium', 'high'] as const) {
      expect(() => geminiArgs({ harness: 'gemini', cwd: '/work', thinking }, 'go'))
        .toThrow('does not support thinking');
    }
  });

  it('passes headless, model, policy, resume, prompt, and cwd without stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({type:'init',timestamp:new Date().toISOString(),session_id:'22222222-2222-4222-8222-222222222222',model:'gemini-test'}));
console.log(JSON.stringify({type:'message',timestamp:new Date().toISOString(),role:'assistant',content:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input}),delta:true}));
console.log(JSON.stringify({type:'result',timestamp:new Date().toISOString(),status:'success',stats:{input_tokens:1,output_tokens:1}}));
`);
    const adapter = new GeminiAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-gemini-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('22222222-2222-4222-8222-222222222222');
    session.cwd = cwd;
    session.model = 'gemini-test';
    session.policy = 'read-only';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1);
    expect(done?.type).toBe('run.completed');
    const detail = JSON.parse((done as Extract<WireEvent, { type: 'run.completed' }>).final_text!);
    expect(detail).toEqual({
      argv: [
        '--output-format', 'stream-json',
        '--model', 'gemini-test',
        '--approval-mode', 'plan',
        '--resume', '22222222-2222-4222-8222-222222222222',
        '--prompt', 'PONG',
      ],
      cwd,
      input: '',
    });
    expect(session.session_ref).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('turns missing commands and nonzero exits into failed runs', async () => {
    expect((await collect(new GeminiAdapter('/definitely/missing/codor-gemini'))).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    expect((await collect(new GeminiAdapter(command))).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('discovers main session UUIDs from project-scoped JSONL metadata', () => {
    const home = mkdtempSync(join(tmpdir(), 'codor-gemini-home-'));
    dirs.push(home);
    const chats = join(home, 'tmp', 'project-a', 'chats');
    mkdirSync(join(chats, 'parent-session'), { recursive: true });
    writeFileSync(
      join(chats, 'session-2026-07-10-main.jsonl'),
      '{"$set":{"sessionId":"44444444-4444-4444-8444-444444444444","projectHash":"project-a"}}\n',
    );
    writeFileSync(
      join(chats, 'session-2026-07-10-subagent.jsonl'),
      '{"$set":{"sessionId":"55555555-5555-4555-8555-555555555555","projectHash":"project-a","kind":"subagent"}}\n',
    );
    expect(new GeminiAdapter('gemini', home).discoverSessions())
      .toEqual(['44444444-4444-4444-8444-444444444444']);
  });

  it('rejects interaction responses because ask and runtime approvals are false', async () => {
    await expect(new GeminiAdapter().respondInteraction()).rejects.toThrow(
      'no interaction response channel',
    );
  });
});

// harn:assume adapter-children-inherit-session-env ref=gemini-env-regression
describe('member environment inheritance', () => {
  it('merges session values over the inherited process environment', async () => {
    const command = executable(`
const detail = JSON.stringify({home:process.env.HOME,path:process.env.PATH,member:process.env.CODOR_TEST_SESSION_ENV});
console.log(JSON.stringify({type:'init',timestamp:new Date().toISOString(),session_id:'22222222-2222-4222-8222-222222222222',model:'gemini-test'}));
console.log(JSON.stringify({type:'message',timestamp:new Date().toISOString(),role:'assistant',content:detail,delta:true}));
console.log(JSON.stringify({type:'result',timestamp:new Date().toISOString(),status:'success',stats:{input_tokens:1,output_tokens:1}}));
`);
    const adapter = new GeminiAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    session.env = { HOME: '/codor/session-home', CODOR_TEST_SESSION_ENV: 'member-value' };
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hello')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;

    expect(adapter.capabilities.live_inbox).toBe(false);
    expect(JSON.parse(done.final_text!)).toEqual({
      home: '/codor/session-home', path: process.env.PATH, member: 'member-value',
    });
  });
});
// harn:end adapter-children-inherit-session-env

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-regression
describe('the declared policy mapping matches the arguments actually built', () => {
  it('declares exactly what --approval-mode receives', () => {
    const { policies } = new GeminiAdapter().capabilities;
    for (const [policy, native] of Object.entries(policies)) {
      expect(geminiApprovalMode(policy), policy).toBe(native);
    }
  });
});
