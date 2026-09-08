import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PostFrame, type PostOutcome, type ServerFrame, ServerFrameSchema } from '@codor/protocol';
import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import { CryptoVault } from './crypto/pairing.js';
import { startServer, type RunningServer } from './server.js';

let dir: string;
let daemon: Daemon;
let server: RunningServer | undefined;
let vault: CryptoVault;
const sockets = new Set<WebSocket>();
const request = (body = '@reader hello', submission_id = 'intent-1'): PostFrame & { submission_id: string } =>
  ({ type: 'post', room: 'eng', body, submission_id });
const actor = () => ({ id: daemon.ownerOf('eng').id, agent: false, room: 'eng' });
const submit = (frame = request(), sender = 'owner') => daemon.submitPost(sender, frame, actor(), () => undefined);
const counts = () => {
  const db = new Database(join(dir, 'db.sqlite'));
  try {
    return Object.fromEntries(['messages', 'schedules', 'deliveries', 'collaboration_groups', 'post_receipts', 'changes']
      .map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
  } finally { db.close(); }
};
const boot = () => new Daemon({ dbPath: join(dir, 'db.sqlite'), blobRoot: join(dir, 'blobs'),
  adapters: [new FakeAdapter('fake')], homeDir: dir });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'post-submission-'));
  daemon = boot();
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'owner', display_name: 'Owner' } });
  daemon.store.addMember('eng', { kind: 'human', handle: 'reader', display_name: 'Reader', role: 'member' });
  vault = new CryptoVault(join(dir, 'vault'));
});
afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  await server?.close(); server = undefined;
  await daemon.close(); vault.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
async function serve(principals?: { token: string; member_id: string }[]) {
  server = await startServer({ daemon, token: 'owner-token', crypto: vault, principals, homeDir: dir });
}
async function connect(token = 'owner-token') {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?token=${token}`);
  sockets.add(ws);
  const frames: ServerFrame[] = [];
  const waiting: Array<(frame: ServerFrame) => void> = [];
  ws.on('message', (raw) => {
    const frame = ServerFrameSchema.parse(JSON.parse(String(raw)));
    frames.push(frame); for (const notify of [...waiting]) notify(frame);
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, frames, next: (test: (frame: ServerFrame) => boolean) => {
    const found = frames.find(test);
    if (found) return Promise.resolve(found);
    return new Promise<ServerFrame>((resolve, reject) => {
      const done = (frame: ServerFrame) => {
        if (!test(frame)) return;
        clearTimeout(timer); waiting.splice(waiting.indexOf(done), 1); resolve(frame);
      };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(done), 1); reject(new Error('frame timeout')); }, 3000);
      waiting.push(done);
    });
  } };
}
const outcome = (frame: ServerFrame): PostOutcome => {
  if (frame.type !== 'post_accepted') throw new Error(JSON.stringify(frame));
  return frame.outcome;
};

// harn:assume post-receipts-commit-atomically-with-routing ref=p6-post-receipts-commit-atomically-with-routing
describe('durable acknowledged submission acceptance', () => {
  it('deduplicates immediate messages, sequence, fanout and notifications after restart', async () => {
    const emit = vi.fn(); daemon.onFrame(emit);
    const first = submit();
    const after = counts(); const notifications = emit.mock.calls.length;
    expect(submit()).toEqual(first);
    expect(counts()).toEqual(after); expect(emit).toHaveBeenCalledTimes(notifications);
    await daemon.close(); daemon = boot();
    expect(submit()).toEqual(first); expect(counts()).toEqual(after);
  });

  it('commits exactly one multi-agent group with all delivery ids and no repeated dispatch', () => {
    for (const handle of ['alpha', 'beta']) daemon.store.addMember('eng', {
      kind: 'agent', handle, display_name: handle, harness: 'fake', state: 'paused', cwd: dir,
    });
    const frame = request('@alpha @beta do the work');
    const first = submit(frame);
    expect(first.kind).toBe('message');
    if (first.kind !== 'message') return;
    expect(first.group_id).toBeTruthy(); expect(first.delivery_ids).toHaveLength(2);
    const after = counts();
    for (let i = 0; i < 10; i++) expect(submit(frame)).toEqual(first);
    expect(counts()).toEqual(after);
  });

  it('rolls message, seq, all group rows and receipt back together on receipt insert failure', () => {
    for (const handle of ['alpha', 'beta']) daemon.store.addMember('eng', {
      kind: 'agent', handle, display_name: handle, harness: 'fake', state: 'paused', cwd: dir,
    });
    const before = counts(); const emit = vi.fn(); daemon.onFrame(emit);
    const db = new Database(join(dir, 'db.sqlite'));
    db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON post_receipts BEGIN SELECT RAISE(ABORT, 'crash seam'); END");
    expect(() => submit(request('@alpha @beta atomic'))).toThrow('crash seam');
    expect(counts()).toEqual(before); expect(emit).not.toHaveBeenCalled();
    db.exec('DROP TRIGGER refuse_receipt'); db.close();
    expect(submit(request('@alpha @beta atomic')).kind).toBe('message');
  });

  it.each(['message', 'schedule'].flatMap((kind) => ['before-receipt', 'after-commit'].map((point) => ({ kind, point }))))('survives a real process kill $kind $point with no split receipt/fanout', async ({ kind, point }) => {
    const frame = request(kind === 'message' ? '@alpha @beta killed' : '[send_in=1h] @alpha killed');
    for (const handle of ['alpha', 'beta']) daemon.store.addMember('eng', {
      kind: 'agent', handle, display_name: handle, harness: 'fake', state: 'paused', cwd: dir,
    });
    const before = counts();
    await daemon.close();
    const module = pathToFileURL(resolve('dist/daemon.js')).href;
    const script = `
      import { Daemon } from ${JSON.stringify(module)};
      const daemon = new Daemon({ dbPath: ${JSON.stringify(join(dir, 'db.sqlite'))},
        blobRoot: ${JSON.stringify(join(dir, 'blobs'))}, adapters: [], homeDir: ${JSON.stringify(dir)} });
      const accept = daemon.store.acceptSubmission.bind(daemon.store);
      daemon.store.acceptSubmission = (sender, frame, create, authorize) => {
        const result = accept(sender, frame, () => {
          const outcome = create();
          if (${JSON.stringify(point)} === 'before-receipt') process.kill(process.pid, 'SIGKILL');
          return outcome;
        }, authorize);
        process.kill(process.pid, 'SIGKILL');
        return result;
      };
      daemon.submitPost('owner', ${JSON.stringify(frame)},
        { id: daemon.ownerOf('eng').id, agent: false, room: 'eng' }, () => {});
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    daemon = boot();
    const after = counts();
    expect(after.post_receipts - before.post_receipts).toBe(point === 'before-receipt' ? 0 : 1);
    expect(after.messages - before.messages).toBe(point === 'before-receipt' || kind === 'schedule' ? 0 : 1);
    expect(after.schedules - before.schedules).toBe(point === 'after-commit' && kind === 'schedule' ? 1 : 0);
    expect(after.collaboration_groups - before.collaboration_groups).toBe(point === 'before-receipt' || kind === 'schedule' ? 0 : 1);
    const accepted = submit(frame);
    expect(accepted.kind).toBe(kind);
    expect(counts().post_receipts - before.post_receipts).toBe(1);
    expect(counts().messages - before.messages).toBe(kind === 'message' ? 1 : 0);
    expect(counts().schedules - before.schedules).toBe(kind === 'schedule' ? 1 : 0);
    expect(counts().deliveries - before.deliveries).toBe(kind === 'message' ? 2 : 0);
    expect(counts().collaboration_groups - before.collaboration_groups).toBe(kind === 'message' ? 1 : 0);
  });

  it('freezes relative schedules and returns original outcomes after rename, send and restart', async () => {
    const frame = request('[send_in=1h] @reader original schedule');
    const first = submit(frame);
    if (first.kind !== 'schedule') throw new Error('expected schedule');
    const reader = daemon.store.listMembers('eng').find((member) => member.handle === 'reader')!;
    daemon.store.updateMember('eng', reader.id, { handle: 'renamed' });
    const before = counts();
    expect(submit(frame)).toEqual(first); expect(counts()).toEqual(before);
    await daemon.runDueSchedules(new Date(Date.parse(first.due_ts) + 1));
    // Target rename may refuse delayed delivery under existing scheduling policy;
    // neither terminal policy can rewrite the original acceptance receipt.
    const terminal = counts();
    await daemon.close(); daemon = boot();
    expect(submit(frame)).toEqual(first); expect(counts()).toEqual(terminal);
  });

  it('rolls schedule and sequence back when receipt persistence fails', () => {
    const before = counts(); const db = new Database(join(dir, 'db.sqlite'));
    db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON post_receipts BEGIN SELECT RAISE(ABORT, 'crash seam'); END");
    expect(() => submit(request('[send_in=1h] @reader schedule'))).toThrow('crash seam');
    expect(counts()).toEqual(before); db.close();
  });

  it('keeps deletion tombstones and uploaded/voice fingerprints without resolving files again', () => {
    const id = daemon.newAttachmentId(); daemon.ensureAttachmentDir('eng');
    writeFileSync(daemon.attachmentPath('eng', id), 'payload');
    writeFileSync(daemon.attachmentPath('eng', id) + '.json', JSON.stringify({ id, name: 'a.txt', mime: 'text/plain', size: 7 }));
    const frame = { ...request(), attachments: [id], voice: { duration_seconds: 2, levels: [1, 99] } };
    const first = submit(frame);
    if (first.kind !== 'message') throw new Error('expected message');
    expect(daemon.store.getMessage('eng', first.message_id)?.voice).toEqual(frame.voice);
    daemon.deleteMessage('eng', first.message_id, daemon.ownerOf('eng').id);
    const after = counts(); const lookup = vi.spyOn(daemon, 'resolveAttachmentsForPost');
    expect(submit(frame)).toEqual(first); expect(lookup).not.toHaveBeenCalled(); expect(counts()).toEqual(after);
    expect(daemon.store.getMessage('eng', first.message_id)?.deleted).toBe(true);
    expect(() => submit({ ...frame, voice: { duration_seconds: 3, levels: [1, 99] } })).toThrow('different post');
    expect(() => submit({ ...frame, attachments: ['other'] })).toThrow('different post');
  });

  it('binds ids to original room and sender while equal numeric message ids stay isolated', () => {
    daemon.createRoom({ id: 'other', name: 'Other', owner: { handle: 'owner', display_name: 'Owner' } });
    const first = submit();
    expect(() => submit({ ...request(), room: 'other' })).toThrow('different post');
    expect(() => submit(request('changed body'))).toThrow('different post');
    const second = submit(request(), 'human:another-stable-id');
    expect(second).not.toEqual(first);
    const local = daemon.submitPost('owner', { ...request('room two', 'second-intent'), room: 'other' },
      { id: daemon.ownerOf('other').id, agent: false, room: 'other' }, () => undefined);
    expect(local).toMatchObject({ room: 'other', message_id: 1 });
  });

  it('returns actual qualified destination and original fanout after target rename', () => {
    const root = join(dir, 'repo');
    const registered = daemon.store.registerWorktree('eng',
      { common_path: join(root, '.git'), primary_path: root, primary_git_admin_id: join(root, '.git') },
      { path: root, git_admin_id: join(root, '.git'), primary: true, availability: 'available', locked: false, branch: 'main' },
      { path: join(dir, 'child'), git_admin_id: join(root, '.git/worktrees/child'), primary: false,
        availability: 'available', locked: false, branch: 'feature/child' }, 'adopted').worktree;
    const child = registered.conversation_id!;
    const target = daemon.store.addMember(child, { kind: 'agent', handle: 'target', display_name: 'Target', harness: 'fake', state: 'paused', cwd: dir });
    const frame = request(`~${registered.alias}:@target qualified`);
    const first = submit(frame);
    expect(first).toMatchObject({ room: child, message_id: 1 });
    daemon.renameMember(child, target.id, 'renamed');
    const after = counts(); expect(submit(frame)).toEqual(first); expect(counts()).toEqual(after);
    expect(daemon.store.listMessages('eng')).toHaveLength(0);
    expect(() => daemon.submitPost('owner', frame, actor(), () => { throw new Error('revoked destination'); })).toThrow('revoked destination');
  });
});
// harn:end post-receipts-commit-atomically-with-routing

// harn:assume post-acknowledgements-are-optional-and-correlated ref=p6-post-acknowledgements-are-optional-and-correlated
describe('authenticated socket compatibility and crash windows', () => {
  it('advertises the optional capability only after authentication and preserves the epoch', async () => {
    await serve();
    const base = `http://127.0.0.1:${server!.port}/api/client-compatibility`;
    expect((await fetch(base)).status).toBe(401);
    expect(await (await fetch(base, { headers: { authorization: 'Bearer owner-token' } })).json())
      .toMatchObject({ browser_protocol: 2, post_acknowledgements: true });
  });

  it('old subscribers receive their ordinary echo and no unsolicited acknowledgement', async () => {
    await serve(); const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: '@reader legacy' }));
    await client.next((frame) => frame.type === 'message');
    client.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'barrier' }));
    await client.next((frame) => frame.type === 'rooms' && frame.ref === 'barrier');
    expect(client.frames.some((frame) => frame.type === 'post_accepted')).toBe(false);
    expect(counts().post_receipts).toBe(0);
  });

  it('lost echo and concurrent/repeated socket retries settle one durable fanout', async () => {
    await serve(); const clients = await Promise.all(Array.from({ length: 8 }, () => connect()));
    for (const client of clients) client.ws.send(JSON.stringify(request()));
    const results = await Promise.all(clients.map((client) => client.next((frame) => frame.type === 'post_accepted')));
    expect(new Set(results.map((frame) => JSON.stringify(outcome(frame)))).size).toBe(1);
    expect(counts()).toMatchObject({ messages: 1, deliveries: 1, post_receipts: 1 });
    // No ordinary echo was needed: these clients never subscribed.
    expect(clients.every((client) => !client.frames.some((frame) => frame.type === 'message'))).toBe(true);
  });

  it('authenticates and authorizes before looking up even an accepted receipt', async () => {
    const human = daemon.store.listMembers('eng').find((member) => member.handle === 'reader')!;
    await serve([{ token: 'member-token', member_id: human.id }]);
    const client = await connect('member-token');
    client.ws.send(JSON.stringify(request('member post')));
    await client.next((frame) => frame.type === 'post_accepted');
    daemon.store.updateMember('eng', human.id, { role: 'observer' });
    const lookup = vi.spyOn(daemon.store, 'acceptSubmission');
    client.ws.send(JSON.stringify(request('member post')));
    const denied = await client.next((frame) => frame.type === 'error');
    expect(denied).toMatchObject({ submission_id: 'intent-1', origin_room: 'eng' });
    expect(lookup).not.toHaveBeenCalled(); expect(counts().messages).toBe(1);
  });

  it('uses stable paired device identity across refreshed access tokens and rejects revoked sessions', async () => {
    const device = new CryptoVault(join(dir, 'browser'));
    vault.keys.enrollPeer({ ...device.keys.publicIdentity(), kind: 'device', label: 'Browser' });
    await serve();
    const firstToken = vault.browserSessions.issue(device.keys.identity.device_id).access_token;
    const first = await connect(firstToken); first.ws.send(JSON.stringify(request()));
    const accepted = await first.next((frame) => frame.type === 'post_accepted');
    const secondToken = vault.browserSessions.issue(device.keys.identity.device_id).access_token;
    expect(secondToken).not.toBe(firstToken);
    const second = await connect(secondToken); second.ws.send(JSON.stringify(request()));
    expect(await second.next((frame) => frame.type === 'post_accepted')).toEqual(accepted);
    expect(counts().messages).toBe(1);
    const closed = new Promise<number>((resolve) => second.ws.once('close', (code) => resolve(code)));
    vault.keys.revokePeer(device.keys.identity.device_id);
    expect(await closed).toBe(4403);
    expect(counts().messages).toBe(1);
    device.close();
  });

  it('correlates malformed and changed-payload refusals without writing a new operation', async () => {
    await serve(); const client = await connect();
    client.ws.send(JSON.stringify(request())); await client.next((frame) => frame.type === 'post_accepted');
    client.ws.send(JSON.stringify(request('different body')));
    expect(await client.next((frame) => frame.type === 'error')).toMatchObject({
      submission_id: 'intent-1', origin_room: 'eng', message: expect.stringContaining('different post'),
    });
    const next = await connect();
    next.ws.send(JSON.stringify({ ...request(), voice: { duration_seconds: -2, levels: [] } }));
    expect(await next.next((frame) => frame.type === 'error')).toMatchObject({ submission_id: 'intent-1', origin_room: 'eng' });
    expect(counts().messages).toBe(1);
  });
});
// harn:end post-acknowledgements-are-optional-and-correlated
