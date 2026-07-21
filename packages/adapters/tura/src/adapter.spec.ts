import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { TuraAdapter, turaArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-tura-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-tura');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

function waitFor(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = (): void => {
      if (existsSync(path)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Tura subprocess and capability conformance', () => {
  it('passes source-CLI arguments, model, resume token, cwd, and no stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const detail = JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8'),projectRoot:process.env.TURA_PROJECT_ROOT});
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_existing'}));
console.log(JSON.stringify({type:'cli.completed',sessionID:'ses_existing',status:'completed',finalText:detail}));
`);
    const adapter = new TuraAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-tura-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('ses_existing');
    session.cwd = cwd;
    session.model = 'openai/gpt-5.6-sol';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: ['--cwd', cwd, 'run', '--output', 'ndjson', '--agent-id', 'balanced', '--session-type', 'coding', '--model', 'openai/gpt-5.6-sol', '--session', 'ses_existing', 'PONG'],
      cwd: realpathSync(cwd),
      input: '',
      projectRoot: cwd,
    });
    expect(session.session_ref).toBe('ses_existing');
  });

  it('rejects unverified policy and thinking claims', () => {
    const adapter = new TuraAdapter('/fake/tura');
    expect(() => adapter.spawn({ cwd: '/work', policy: 'anything' })).toThrow('valid policies');
    expect(() => adapter.spawn({ cwd: '/work', thinking: 'high' })).toThrow('does not support thinking');
    expect(adapter.capabilities.policies).toEqual({
      'read-only': null, 'workspace-write': null, 'full-access': null,
    });
  });

  it('turns a missing binary and a nonzero exit into failed runs', async () => {
    const events: WireEvent[] = [];
    for await (const event of new TuraAdapter('/definitely/missing/tura').deliver(
      { harness: 'tura', cwd: process.cwd() }, 'hello',
    )) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);");
    const failed: WireEvent[] = [];
    for await (const event of new TuraAdapter(command).deliver(
      { harness: 'tura', cwd: process.cwd() }, 'hello',
    )) failed.push(event);
    expect(failed.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed', final_text: 'native failure' });
  });

  it('discovers root sessions through Tura session list JSON', () => {
    const command = executable(`
const expected = ['--json','session','list','--all'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
console.log(JSON.stringify([{id:'ses_first'},{id:'ses_second'},{title:'missing id'}]));
`);
    expect(new TuraAdapter(command).discoverSessions()).toEqual(['ses_first', 'ses_second']);
  });

  it('asks Tura to abort the native session before force-stopping the local process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-tura-abort-'));
    dirs.push(dir);
    const output = join(dir, 'abort.json');
    const command = executable(`
const fs = require('node:fs');
if (process.argv.includes('abort')) { fs.writeFileSync(process.env.TURA_ABORT_OUT, JSON.stringify(process.argv.slice(2))); process.exit(0); }
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_abort'}));
console.log(JSON.stringify({type:'message.part.delta',sessionID:'ses_abort',text:'working'}));
setInterval(() => {}, 1000);
`);
    const adapter = new TuraAdapter(command);
    const session = adapter.spawn({ cwd: dir });
    session.env = { TURA_ABORT_OUT: output };
    const iterator = adapter.deliver(session, 'wait')[Symbol.asyncIterator]();
    await iterator.next();
    adapter.interrupt(session);
    await waitFor(output);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['--cwd', dir, '--json', 'session', 'abort', 'ses_abort']);
    await iterator.return?.();
  });

  it('rejects interaction responses because Tura run has no response channel', async () => {
    await expect(new TuraAdapter().respondInteraction()).rejects.toThrow('no response channel');
  });
});

describe('Tura argv construction', () => {
  it('keeps policy out of argv until a real Tura mapping is verified', () => {
    const base = { harness: 'tura', cwd: '/work' };
    expect(turaArgs({ ...base, policy: 'read-only' }, 'go'))
      .toEqual(turaArgs({ ...base, policy: 'workspace-write' }, 'go'));
  });
});
