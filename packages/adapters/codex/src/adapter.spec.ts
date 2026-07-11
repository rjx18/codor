import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter, codexArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-codex-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-codex');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: CodexAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('codex subprocess lifecycle', () => {
  it('maps every canonical policy and thinking level to documented argv', () => {
    const base = { harness: 'codex', cwd: '/work' };
    expect(codexArgs({ ...base, policy: 'read-only' }, 'go')).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only']),
    );
    expect(codexArgs({ ...base, policy: 'workspace-write' }, 'go')).toEqual(
      expect.arrayContaining(['--sandbox', 'workspace-write']),
    );
    expect(codexArgs({ ...base, policy: 'full-access' }, 'go')).toEqual(
      expect.arrayContaining(['--sandbox', 'danger-full-access']),
    );
    for (const thinking of ['low', 'medium', 'high'] as const) {
      expect(codexArgs({ ...base, thinking }, 'go')).toEqual(
        expect.arrayContaining(['-c', `model_reasoning_effort=${thinking}`]),
      );
    }
    expect(() => codexArgs({ ...base, policy: 'danger-full-access' }, 'go')).toThrow(
      'valid policies: read-only, workspace-write, full-access',
    );
  });

  it('turns a missing CLI into a failed run instead of an unhandled child error', async () => {
    const events = await collect(new CodexAdapter('/definitely/missing/codor-codex'));
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
  });

  it('classifies empty stdout plus a nonzero exit as failed and preserves bounded stderr', async () => {
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    const events = await collect(new CodexAdapter(command));
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('reports confirmed spawn before the native session reference', async () => {
    const command = executable(`
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}));
`);
    const adapter = new CodexAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    const lifecycle: string[] = [];
    for await (const _event of adapter.deliver(session, 'hello', {
      onStarted: ({ pid }) => lifecycle.push(`started:${String(pid)}`),
      onSessionRef: (ref) => lifecycle.push(`session:${ref}`),
    })) {
      // drain
    }
    expect(lifecycle[0]).toMatch(/^started:\d+$/);
    expect(lifecycle[1]).toBe('session:11111111-1111-4111-8111-111111111111');
    expect(session.session_ref).toBe('11111111-1111-4111-8111-111111111111');
  });
});
