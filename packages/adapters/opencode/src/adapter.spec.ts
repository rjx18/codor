import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { OpenCodeAdapter, openCodeArgs, openCodeAutoApprove } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-opencode');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: OpenCodeAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OpenCode subprocess and capability conformance', () => {
  it('enables CLI-owned auto approval only for explicit full-access policies', () => {
    expect(openCodeAutoApprove('read-only')).toBe(false);
    expect(openCodeAutoApprove('workspace-write')).toBe(false);
    expect(openCodeAutoApprove('full-access')).toBe(true);
    expect(() => openCodeAutoApprove('auto')).toThrow('valid policies');
  });

  it('maps canonical policies and thinking levels to documented argv', () => {
    const base = { harness: 'opencode', cwd: '/work' };
    expect(openCodeArgs({ ...base, policy: 'read-only' }, 'go')).not.toContain('--auto');
    expect(openCodeArgs({ ...base, policy: 'workspace-write' }, 'go')).not.toContain('--auto');
    expect(openCodeArgs({ ...base, policy: 'full-access' }, 'go')).toContain('--auto');
    for (const thinking of ['low', 'medium', 'high'] as const) {
      expect(openCodeArgs({ ...base, thinking }, 'go')).toEqual(
        expect.arrayContaining(['--variant', thinking]),
      );
    }
  });

  it('passes JSON, model, auto, resume, payload, and cwd without stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const detail = JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8')});
console.log(JSON.stringify({type:'step_start',sessionID:'ses_existing',part:{type:'step-start'}}));
console.log(JSON.stringify({type:'text',sessionID:'ses_existing',part:{type:'text',text:detail,time:{start:1,end:2}}}));
console.log(JSON.stringify({type:'step_finish',sessionID:'ses_existing',part:{type:'step-finish',tokens:{input:1,output:2},cost:0.01}}));
`);
    const adapter = new OpenCodeAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-opencode-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('ses_existing');
    session.cwd = cwd;
    session.model = 'opencode/deepseek-v4-flash-free';
    session.policy = 'full-access';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: [
        'run', '--format', 'json',
        '--model', 'opencode/deepseek-v4-flash-free',
        '--auto',
        '--session', 'ses_existing',
        'PONG',
      ],
      cwd,
      input: '',
    });
    expect(done.usage).toEqual({ input_tokens: 1, output_tokens: 2, cost_usd: 0.01 });
    expect(session.session_ref).toBe('ses_existing');
  });

  it('turns missing commands and nonzero exits into failed runs', async () => {
    expect((await collect(new OpenCodeAdapter('/definitely/missing/codor-opencode'))).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    expect((await collect(new OpenCodeAdapter(command))).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('discovers every root id through the documented global JSON database command', () => {
    const command = executable(`
const expected = ['db','--format','json','SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
console.log(JSON.stringify([{id:'ses_first'},{id:'ses_second'},{title:'missing id'}]));
`);
    expect(new OpenCodeAdapter(command).discoverSessions()).toEqual(['ses_first', 'ses_second']);
  });

  it('rejects interaction responses because run owns headless permissions', async () => {
    await expect(new OpenCodeAdapter().respondInteraction()).rejects.toThrow(
      'no response channel',
    );
  });
});

// harn:assume adapters-own-their-model-catalog ref=opencode-model-discovery
describe('opencode model discovery', () => {
  const stub = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-models-'));
    const command = join(dir, 'opencode');
    writeFileSync(command, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(command, 0o755);
    return command;
  };

  it('reports the models the operator’s own installation configured', async () => {
    // opencode's catalog is per-installation, so it is asked, never hardcoded.
    const command = stub('echo "anthropic/claude-sonnet-5"; echo "openai/gpt-4o"');
    const catalog = await new OpenCodeAdapter(command).listModels();
    expect(catalog).toEqual({
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o'],
      source: 'discovered',
    });
  });

  it('fails rather than reporting an empty catalog as fact', async () => {
    await expect(new OpenCodeAdapter(stub('exit 0')).listModels()).rejects.toThrow();
  });

  it('fails when the harness is not installed', async () => {
    await expect(new OpenCodeAdapter('/definitely/missing/codor-opencode').listModels())
      .rejects.toThrow();
  });

  it('fails when the harness exits non-zero', async () => {
    await expect(new OpenCodeAdapter(stub('echo boom >&2; exit 1')).listModels())
      .rejects.toThrow();
  });
});

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-regression
describe('the declared policy mapping matches the arguments actually built', () => {
  it('declares a flag only where it emits one, and null where it enforces nothing', () => {
    const { policies } = new OpenCodeAdapter().capabilities;
    for (const [policy, native] of Object.entries(policies)) {
      const args = openCodeArgs({ harness: 'opencode', cwd: '/work', policy }, 'go');
      expect(args.includes('--auto'), policy).toBe(native !== null);
      expect(openCodeAutoApprove(policy), policy).toBe(native !== null);
    }
    expect(policies['read-only']).toBeNull();
    expect(policies['workspace-write']).toBeNull();
  });

  it('builds the SAME arguments for both unenforced levels', () => {
    const base = { harness: 'opencode', cwd: '/work' };
    expect(openCodeArgs({ ...base, policy: 'read-only' }, 'go'))
      .toEqual(openCodeArgs({ ...base, policy: 'workspace-write' }, 'go'));
  });
});
