import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveDefaultAgent, type Message } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codor-default-')); store = new Store(join(dir, 'db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const { owner } = store.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'viewer', display_name: 'Viewer' } });
  const add = (handle: string) => store.addMember('eng', { kind: 'agent', handle, display_name: handle, harness: 'fake' });
  return { owner, a: add('investigator'), b: add('sol') };
}
function run(author: string, status: NonNullable<Message['run']>['status'], body = 'substantive') {
  return store.postMessage('eng', { author, kind: 'run', body,
    run: { status, started_ts: '2026-09-08T00:00:00Z', tool_calls: 0, events_ref: 'runs/test.jsonl', final_text: body,
      ...(status === 'running' && { output_mode: 'messages' as const }) } });
}

// harn:assume default-agent-orders-successful-terminal-replies ref=terminal-default-regression
describe('terminal default recipient', () => {
  it('ranks completed root2455/result2462 above interrupted2457 and publishes the same support default', () => {
    const { owner, a, b } = fixture();
    store.db.transaction(() => {
      for (let id = 1; id < 2455; id++) store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'history' });
    })();
    const root = run(a.id, 'running');
    expect(root.id).toBe(2455);
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'interjection' });
    expect(run(b.id, 'interrupted').id).toBe(2457);
    for (let id = 2458; id < 2462; id++) store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'interjection' });
    const result = store.createRunContinuation('eng', root.id);
    expect(result.id).toBe(2462);
    store.updateMessage('eng', root.id, { run: { ...root.run!, status: 'completed', result_message_id: result.id } });
    expect(store.latestFinalizedAgentAuthor('eng')).toBe(a.id);
    const support = store.roomSupport('eng', owner.id);
    expect(effectiveDefaultAgent({ members: store.listMembers('eng'), latestFinalizedAgentId: support.latest_finalized_agent_id })?.id).toBe(a.id);
  });

  it('ranks an earlier-started run by its later continuation and uses the root aggregate for an empty result', () => {
    const { a, b } = fixture();
    const root = run(a.id, 'running', 'earlier prose');
    run(b.id, 'completed', 'finished first');
    const result = store.createRunContinuation('eng', root.id);
    store.updateMessage('eng', root.id, { run: { ...root.run!, status: 'completed', result_message_id: result.id } });
    expect(store.latestFinalizedAgentAuthor('eng')).toBe(a.id);
  });

  it.each(['running', 'failed', 'interrupted', 'empty', 'ack', 'removed', 'deleted'])(
    'does not let %s replace a legacy successful default', (shape) => {
      const { a, b } = fixture();
      run(a.id, 'completed', 'legacy substantive');
      const candidate = run(b.id, ['running', 'failed', 'interrupted'].includes(shape)
        ? shape as 'running' | 'failed' | 'interrupted' : 'completed', shape === 'empty' ? ' \n\t ' : 'candidate');
      if (shape === 'ack') store.updateMessage('eng', candidate.id, { ack: true });
      if (shape === 'removed') store.updateMember('eng', b.id, { removed_ts: new Date().toISOString() });
      if (shape === 'deleted') store.db.prepare('UPDATE messages SET deleted=1 WHERE room=? AND id=?').run('eng', candidate.id);
      expect(store.latestFinalizedAgentAuthor('eng')).toBe(a.id);
    },
  );

  it('uses legacy body and continuation text when final_text is unavailable', () => {
    const { a, b } = fixture();
    const legacy = run(a.id, 'completed', 'legacy body');
    store.updateMessage('eng', legacy.id, { run: { ...legacy.run!, final_text: undefined } });
    expect(store.latestFinalizedAgentAuthor('eng')).toBe(a.id);
    const root = run(b.id, 'running', '');
    const result = store.createRunContinuation('eng', root.id);
    store.updateMessage('eng', result.id, { body: 'visible result' });
    store.updateMessage('eng', root.id, { run: { ...root.run!, status: 'completed', result_message_id: result.id } });
    expect(store.latestFinalizedAgentAuthor('eng')).toBe(b.id);
  });
});
// harn:end default-agent-orders-successful-terminal-replies
