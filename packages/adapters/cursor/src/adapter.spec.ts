import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CursorAdapter, cursorArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-cursor-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-cursor-agent');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: CursorAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cursor subprocess and capability conformance', () => {
  it('maps Codor policy chips onto cursor-agent flags', () => {
    const base = { harness: 'cursor', cwd: '/work' } as const;
    expect(cursorArgs({ ...base, policy: 'read-only' }, 'go'))
      .toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(cursorArgs({ ...base, policy: 'workspace-write' }, 'go'))
      .toEqual(expect.arrayContaining(['--force', '--sandbox', 'enabled']));
    expect(cursorArgs({ ...base, policy: 'full-access' }, 'go'))
      .toEqual(expect.arrayContaining(['--force', '--sandbox', 'disabled']));
    expect(() => cursorArgs({ ...base, policy: 'plan' }, 'go')).toThrow('valid policies');
    expect(() => cursorArgs({ ...base, thinking: 'high' }, 'go'))
      .toThrow('does not support thinking');
  });

  it('rejects an unknown policy at spawn', () => {
    expect(() => new CursorAdapter().spawn({ cwd: '/work', policy: 'yolo' }))
      .toThrow("unknown policy 'yolo'");
  });

  it('passes headless, model, policy, resume, and prompt with the -- guard and no stdin', async () => {
    const command = executable(`
const detail = JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() });
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222',model:'cursor-test'}));
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:detail}]},timestamp_ms:1}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:detail,session_id:'22222222-2222-4222-8222-222222222222',usage:{inputTokens:1,outputTokens:1}}));
`);
    const adapter = new CursorAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-cursor-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('22222222-2222-4222-8222-222222222222');
    session.cwd = cwd;
    session.model = 'cursor-test';
    session.policy = 'read-only';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(done.type).toBe('run.completed');
    const detail = JSON.parse(done.final_text!);
    expect(detail).toEqual({
      argv: [
        '-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust',
        '--model', 'cursor-test',
        '--mode', 'plan',
        '--resume', '22222222-2222-4222-8222-222222222222',
        '--', 'PONG',
      ],
      cwd: realpathSync(cwd),
    });
    expect(session.session_ref).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('turns missing commands and nonzero exits into failed runs', async () => {
    expect((await collect(new CursorAdapter('/definitely/missing/cursor-agent'))).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    expect((await collect(new CursorAdapter(command))).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('does not enumerate the session store headlessly', () => {
    expect(new CursorAdapter().discoverSessions()).toEqual([]);
  });

  it('rejects interaction responses because ask and runtime approvals are false', async () => {
    await expect(new CursorAdapter().respondInteraction()).rejects.toThrow(
      'no interaction response channel',
    );
  });
});

// harn:assume adapter-children-inherit-session-env ref=cursor-env-regression
describe('member environment inheritance', () => {
  it('merges session values over the inherited process environment', async () => {
    const command = executable(`
const detail = JSON.stringify({home:process.env.HOME,path:process.env.PATH,member:process.env.CODOR_TEST_SESSION_ENV});
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222',model:'cursor-test'}));
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:detail}]},timestamp_ms:1}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:detail,session_id:'22222222-2222-4222-8222-222222222222',usage:{inputTokens:1,outputTokens:1}}));
`);
    const adapter = new CursorAdapter(command);
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
