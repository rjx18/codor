import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CopilotAdapter, copilotAllowAll, copilotArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-copilot-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-copilot');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: CopilotAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Copilot subprocess and capability conformance', () => {
  it('enables allow-all only for explicit full-access policies', () => {
    expect(copilotAllowAll('read-only')).toBe(false);
    expect(copilotAllowAll('workspace-write')).toBe(false);
    expect(copilotAllowAll('full-access')).toBe(true);
    expect(() => copilotAllowAll('allow-all')).toThrow('valid policies');
    for (const policy of ['read-only', 'workspace-write'] as const) {
      expect(copilotArgs({
        harness: 'copilot', cwd: '/work', session_ref: '33333333-3333-4333-8333-333333333333',
        policy,
      }, 'go')).not.toContain('--allow-all');
    }
    expect(copilotArgs({
      harness: 'copilot', cwd: '/work', session_ref: '33333333-3333-4333-8333-333333333333',
      policy: 'full-access',
    }, 'go')).toContain('--allow-all');
    for (const thinking of ['low', 'medium', 'high'] as const) {
      expect(() => copilotArgs({
        harness: 'copilot', cwd: '/work', session_ref: '33333333-3333-4333-8333-333333333333',
        thinking,
      }, 'go')).toThrow('does not support thinking');
    }
  });

  it('passes JSONL, no-ask, model, policy, exact session, prompt, cwd, and no stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const detail = JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8')});
console.log(JSON.stringify({type:'assistant.message',data:{messageId:'message-1',content:detail}}));
console.log(JSON.stringify({type:'assistant.usage',data:{model:'gpt-5.4-mini',inputTokens:1,outputTokens:2,cost:0.5}}));
console.log(JSON.stringify({type:'session.idle',data:{}}));
`);
    const adapter = new CopilotAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-copilot-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('33333333-3333-4333-8333-333333333333');
    session.cwd = cwd;
    session.model = 'gpt-5.4-mini';
    session.policy = 'full-access';
    const lifecycle: string[] = [];
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG', {
      onStarted: () => lifecycle.push('started'),
      onSessionRef: (ref) => lifecycle.push(`session:${ref}`),
    })) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: [
        '--output-format=json',
        '--stream=on',
        '--no-ask-user',
        '--no-color',
        '--model', 'gpt-5.4-mini',
        '--allow-all',
        '--session-id', '33333333-3333-4333-8333-333333333333',
        '--prompt', 'PONG',
      ],
      cwd,
      input: '',
    });
    expect(done.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(lifecycle).toEqual([
      'started',
      'session:33333333-3333-4333-8333-333333333333',
    ]);
  });

  it('preallocates a resumable UUID for new sessions', () => {
    expect(new CopilotAdapter().spawn({ cwd: '/tmp' }).session_ref)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  });

  it('turns missing commands and nonzero exits into failed runs', async () => {
    expect((await collect(new CopilotAdapter('/definitely/missing/codor-copilot'))).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    expect((await collect(new CopilotAdapter(command))).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('discovers only UUID-named local session directories', () => {
    const home = mkdtempSync(join(tmpdir(), 'codor-copilot-home-'));
    dirs.push(home);
    const state = join(home, 'session-state');
    mkdirSync(join(state, '44444444-4444-4444-8444-444444444444'), { recursive: true });
    mkdirSync(join(state, 'not-a-session'), { recursive: true });
    writeFileSync(join(state, '55555555-5555-4555-8555-555555555555'), 'not a directory');
    expect(new CopilotAdapter('copilot', home).discoverSessions())
      .toEqual(['44444444-4444-4444-8444-444444444444']);
  });

  it('rejects interaction responses because ask_user is disabled', async () => {
    await expect(new CopilotAdapter().respondInteraction()).rejects.toThrow(
      'no response channel',
    );
  });
});

// harn:assume adapter-children-inherit-session-env ref=copilot-env-regression
describe('member environment inheritance', () => {
  it('merges session values over the inherited process environment', async () => {
    const command = executable(`
const detail = JSON.stringify({home:process.env.HOME,path:process.env.PATH,member:process.env.CODOR_TEST_SESSION_ENV});
console.log(JSON.stringify({type:'assistant.message',data:{messageId:'message-1',content:detail}}));
console.log(JSON.stringify({type:'assistant.usage',data:{inputTokens:1,outputTokens:1}}));
console.log(JSON.stringify({type:'session.idle',data:{}}));
`);
    const adapter = new CopilotAdapter(command);
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
  it('declares a flag only where it emits one, and null where it enforces nothing', () => {
    // copilot emits --allow-all for full-access and NOTHING for the other two, so those
    // two build identical arguments. Declaring null is the honest way to say the
    // operator's choice is not enforced by us at all.
    const { policies } = new CopilotAdapter().capabilities;
    for (const [policy, native] of Object.entries(policies)) {
      const args = copilotArgs({ harness: 'copilot', cwd: '/work', policy }, 'go');
      expect(args.includes('--allow-all'), policy).toBe(native !== null);
      expect(copilotAllowAll(policy), policy).toBe(native !== null);
    }
    expect(policies['read-only']).toBeNull();
    expect(policies['workspace-write']).toBeNull();
  });

  it('builds the SAME arguments for both unenforced levels', () => {
    const base = { harness: 'copilot', cwd: '/work' };
    expect(copilotArgs({ ...base, policy: 'read-only' }, 'go'))
      .toEqual(copilotArgs({ ...base, policy: 'workspace-write' }, 'go'));
  });
});
