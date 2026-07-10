import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@wireroom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from './adapter.js';

const dirs: string[] = [];

const hookSettings = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith(`wireroom-claude-hooks-${process.pid}-`))
    .sort();

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wireroom-claude-adapter-'));
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
  it('turns a missing CLI into a failed run instead of an unhandled child error', async () => {
    const settingsBefore = hookSettings();
    const adapter = new ClaudeCodeAdapter('/definitely/missing/wireroom-claude');
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
