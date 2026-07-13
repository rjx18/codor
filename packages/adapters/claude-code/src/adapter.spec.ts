import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter, claudeArgs } from './adapter.js';

const dirs: string[] = [];

const hookSettings = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith(`codor-claude-hooks-${process.pid}-`))
    .sort();

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-claude-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-claude');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

const initAndAsk = `
const readline = require('node:readline');
const lines = readline.createInterface({input: process.stdin});
let count = 0;
lines.on('line', () => {
  count++;
  if (count === 1) {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'}));
    console.log(JSON.stringify({
      type:'control_request',
      request_id:'req-1',
      request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Continue?',options:[{label:'yes'}]}]}}
    }));
  }
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('claude subprocess and interaction lifecycle', () => {
  it('maps every canonical policy and thinking level to documented argv', () => {
    const base = { harness: 'claude-code', cwd: '/work' };
    expect(claudeArgs({ ...base, policy: 'read-only' }, '/settings')).toContain('plan');
    expect(claudeArgs({ ...base, policy: 'workspace-write' }, '/settings')).toContain('acceptEdits');
    expect(claudeArgs({ ...base, policy: 'full-access' }, '/settings')).toContain('bypassPermissions');
    for (const thinking of ['low', 'medium', 'high'] as const) {
      expect(claudeArgs({ ...base, thinking }, '/settings')).toEqual(
        expect.arrayContaining(['--effort', thinking]),
      );
    }
    expect(() => claudeArgs({ ...base, policy: 'yolo' }, '/settings')).toThrow(
      'valid policies: read-only, workspace-write, full-access',
    );
  });

  it('turns a missing CLI into a failed run instead of an unhandled child error', async () => {
    const settingsBefore = hookSettings();
    const adapter = new ClaudeCodeAdapter('/definitely/missing/codor-claude');
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    expect(hookSettings()).toEqual(settingsBefore);
  });

  it('resolves an answer only after output later than the registered boundary', async () => {
    const command = executable(`${initAndAsk}
  if (count === 2) {
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',usage:{input_tokens:1,output_tokens:1}}));
  }
});
`);
    const adapter = new ClaudeCodeAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    let acknowledgement: Promise<void> | undefined;
    const lifecycle: string[] = [];
    for await (const event of adapter.deliver(session, 'hello', {
      onStarted: () => lifecycle.push('started'),
      onSessionRef: (ref) => lifecycle.push(`session:${ref}`),
    })) {
      if (event.type === 'ask.raised') {
        acknowledgement = adapter.respondInteraction(session, event.card.interaction_id, 'yes');
      }
    }
    await expect(acknowledgement).resolves.toBeUndefined();
    expect(lifecycle).toEqual([
      'started',
      'session:22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('rejects an answer when the child exits without post-response stream progress', async () => {
    const command = executable(`${initAndAsk}
  if (count === 2) process.exit(0);
});
`);
    const adapter = new ClaudeCodeAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    let acknowledgement: Promise<void> | undefined;
    for await (const event of adapter.deliver(session, 'hello')) {
      if (event.type === 'ask.raised') {
        acknowledgement = adapter.respondInteraction(session, event.card.interaction_id, 'yes');
        void acknowledgement.catch(() => undefined);
      }
    }
    await expect(acknowledgement).rejects.toThrow('ended before interaction acknowledgement');
  });
});

// harn:assume adapter-children-inherit-session-env ref=claude-env-regression
// harn:assume live-inbox-capability-is-evidence-backed ref=claude-live-inbox-regression
describe('member environment and live inbox settings', () => {
  it('merges the session environment and generates the exact PostToolUse hook', async () => {
    const command = executable(`
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
readline.createInterface({input: process.stdin}).once('line', () => {
  console.log(JSON.stringify({
    type:'result',subtype:'success',is_error:false,
    result:JSON.stringify({settings,home:process.env.HOME,path:process.env.PATH,member:process.env.CODOR_TEST_SESSION_ENV}),
    usage:{input_tokens:1,output_tokens:1}
  }));
});
`);
    const adapter = new ClaudeCodeAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    session.env = { HOME: '/codor/session-home', CODOR_TEST_SESSION_ENV: 'member-value' };
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hello')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    const detail = JSON.parse(done.final_text!);

    expect(adapter.capabilities.live_inbox).toBe(true);
    expect(detail).toMatchObject({
      home: '/codor/session-home',
      path: process.env.PATH,
      member: 'member-value',
      settings: {
        hooks: {
          PostToolUse: [{ hooks: [{
            type: 'command',
            command: 'codor inbox --new --consume --format hook',
          }] }],
        },
      },
    });
  });
});
// harn:end live-inbox-capability-is-evidence-backed
// harn:end adapter-children-inherit-session-env

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-regression
describe('the declared policy mapping matches the arguments actually built', () => {
  it('declares exactly what --permission-mode receives', () => {
    // A declaration that drifts from the argv is just a new way to lie to the operator,
    // so assert the declaration against the flags the adapter really emits.
    const { policies } = new ClaudeCodeAdapter().capabilities;
    const base = { harness: 'claude-code', cwd: '/work' };
    for (const [policy, native] of Object.entries(policies)) {
      const args = claudeArgs({ ...base, policy }, '/settings');
      expect(args[args.indexOf('--permission-mode') + 1], policy).toBe(native);
    }
  });
});
