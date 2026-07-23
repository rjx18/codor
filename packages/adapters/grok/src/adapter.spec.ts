import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { GrokAdapter, grokApprovalArgs, grokArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-grok-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-grok');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Grok subprocess and capability conformance', () => {
  it('maps documented effort and approval controls', () => {
    expect(grokApprovalArgs('read-only')).toEqual([]);
    expect(grokApprovalArgs('workspace-write')).toEqual([]);
    expect(grokApprovalArgs('full-access')).toEqual(['--always-approve']);
    expect(() => grokApprovalArgs('plan')).toThrow('valid policies');
    expect(grokArgs({ harness: 'grok', cwd: '/work', session_ref: 'session', model: 'grok-4.5', policy: 'full-access', thinking: 'high' }, 'go'))
      .toEqual([
        '-p', 'go', '--output-format', 'streaming-json', '--no-auto-update',
        '--model', 'grok-4.5', '--effort', 'high', '--always-approve', '--resume', 'session',
      ]);
  });

  it('passes headless arguments and translates a streaming turn', async () => {
    const command = executable(`
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({type:'session.started',session_id:'22222222-2222-4222-8222-222222222222'}));
console.log(JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input})}));
console.log(JSON.stringify({type:'response.completed',status:'completed',usage:{input_tokens:2,output_tokens:3}}));
`);
    const adapter = new GrokAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-grok-cwd-'));
    dirs.push(cwd);
    const session = adapter.spawn({ cwd, model: 'grok-4.5', policy: 'read-only', thinking: 'medium' });
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(done).toMatchObject({ type: 'run.completed', status: 'completed', usage: { input_tokens: 2, output_tokens: 3 } });
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: ['-p', 'PONG', '--output-format', 'streaming-json', '--no-auto-update', '--model', 'grok-4.5', '--effort', 'medium'],
      cwd,
      input: '',
    });
    expect(session.session_ref).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('discovers UUID sessions from ~/.grok/sessions', () => {
    const home = mkdtempSync(join(tmpdir(), 'codor-grok-home-'));
    dirs.push(home);
    mkdirSync(join(home, 'sessions', '44444444-4444-4444-8444-444444444444'), { recursive: true });
    mkdirSync(join(home, 'sessions', 'not-a-session'), { recursive: true });
    expect(new GrokAdapter('grok', home).discoverSessions())
      .toEqual(['44444444-4444-4444-8444-444444444444']);
  });

  it('turns missing commands into failed runs', async () => {
    const events: WireEvent[] = [];
    for await (const event of new GrokAdapter('/definitely/missing/codor-grok').deliver(
      new GrokAdapter().spawn({ cwd: process.cwd() }), 'hello')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
  });
});
