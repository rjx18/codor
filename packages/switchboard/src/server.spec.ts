import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@wireroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Daemon } from './daemon.js';
import { BlobStore } from './blobs.js';
import { FakeAdapter } from './fake-adapter.js';
import { type RunningServer, startServer } from './server.js';

const TOKEN = 'test-token-123';

let dir: string;
let fake: FakeAdapter;
let daemon: Daemon;
let server: RunningServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-server-'));
  fake = new FakeAdapter();
  daemon = new Daemon({ dbPath: join(dir, 'db.sqlite'), blobRoot: join(dir, 'blobs'), adapters: [fake] });
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
  server = await startServer({ daemon, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

function connectUrl(url: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; next: (pred: (f: ServerFrame) => boolean) => Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: ServerFrame[] = [];
    const waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(frame)) waiters.splice(i, 1)[0]!.resolve(frame);
      }
    });
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        next: (pred) => {
          const found = frames.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('frame timeout')), 3000);
            waiters.push({
              pred,
              resolve: (f) => {
                clearTimeout(timer);
                res(f);
              },
            });
          });
        },
      }),
    );
    ws.on('error', reject);
  });
}

const connect = () => connectUrl(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN}`);

describe('REST', () => {
  it('fails closed when the configured token is missing or empty', async () => {
    await expect(startServer({ daemon, token: '' })).rejects.toThrow('non-empty authentication token');
    await expect(
      startServer({ daemon, token: undefined as unknown as string }),
    ).rejects.toThrow('non-empty authentication token');
  });

  it('rejects requests without the pairing token', async () => {
    expect((await fetch(`${base}/api/rooms`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms/eng/sync?since_seq=0`)).status).toBe(401);
  });

  it('serves delta-sync from the change log cursor', async () => {
    const res = await fetch(`${base}/api/rooms/eng/sync?since_seq=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const sync = (await res.json()) as { seq: number; members: unknown[]; room: { id: string } };
    expect(sync.room.id).toBe('eng');
    expect(sync.members).toHaveLength(2); // owner + system, seeded
    expect(sync.seq).toBeGreaterThan(0);
  });

  it('lists registered adapters and exposes full member lifecycle REST actions', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const adaptersRes = await fetch(`${base}/api/adapters`, { headers: auth });
    expect(await adaptersRes.json()).toMatchObject({
      adapters: [{ id: 'fake', capabilities: { resume: true } }],
    });

    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/review' });
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();

    const detailsRes = await fetch(`${base}/api/rooms/eng/members`, { headers: auth });
    const details = (await detailsRes.json()) as {
      members: { member: { id: string }; spend: { turns: number } }[];
    };
    expect(details.members.find((item) => item.member.id === alpha.id)?.spend.turns).toBe(1);

    const renamedRes = await fetch(`${base}/api/rooms/eng/members/${alpha.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'reviewer', display_name: 'Reviewer' }),
    });
    expect(await renamedRes.json()).toMatchObject({ id: alpha.id, handle: 'reviewer' });

    for (const [action, state] of [
      ['pause', 'paused'],
      ['unpause', 'idle'],
      ['kill', 'dead'],
      ['revive', 'idle'],
    ] as const) {
      const res = await fetch(`${base}/api/rooms/eng/members/${alpha.id}/${action}`, {
        method: 'POST',
        headers: auth,
      });
      expect(await res.json()).toMatchObject({ id: alpha.id, state });
    }
    expect(fake.wasAttached(daemon.store.getMember('eng', alpha.id)!.session_ref!)).toBe(true);
  });

  it('serves run blobs through the redacted endpoint', async () => {
    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/w' });
    fake.enqueue({
      kind: 'complete',
      final_text: 'clean',
      items: [{ type: 'run.item', item_type: 'text_delta', payload: 'found sk-proj-abcdef1234567890abcdef' }],
    });
    daemon.postHumanMessage('eng', '@alpha scan');
    await daemon.settle();
    const runId = daemon.store.listMessages('eng', { limit: 10 }).find((m) => m.kind === 'run')!.id;
    const res = await fetch(`${base}/api/rooms/eng/runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.text();
    expect(body).not.toContain('sk-proj-');
    expect(body).toContain('[redacted]');
  });

  it('rejects traversal room ids and blob paths outside blobRoot', async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: '../escape',
        name: 'Escape',
        owner: { handle: 'attacker', display_name: 'Attacker' },
      }),
    });
    expect(res.status).toBe(500);
    expect(daemon.store.listRooms().map((room) => room.id)).toEqual(['eng']);

    const blobs = new BlobStore(join(dir, 'contained-blobs'));
    expect(() => blobs.path('../escape', 'runs/1.jsonl')).toThrow('escapes');
    expect(() => blobs.path('eng', '../../../escape.jsonl')).toThrow('escapes');
  });
});

describe('WebSocket', () => {
  it('serves the identical room and sync frames over a mode-0600 unix socket', async () => {
    const socketPath = join(dir, 'wireroom.sock');
    const ipc = await startServer({ daemon, token: TOKEN, socketPath });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const client = await connectUrl(`ws+unix://${socketPath}:/ws`);
    client.ws.send(JSON.stringify({ type: 'list_rooms' }));
    const rooms = await client.next((frame) => frame.type === 'rooms');
    expect(rooms).toMatchObject({ type: 'rooms', rooms: [{ id: 'eng', name: 'Eng' }] });

    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    expect(client.frames.some((frame) => frame.type === 'member')).toBe(true);
    client.ws.close();
    await ipc.close();
  });

  it('rejects a bad token at the handshake', async () => {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=wrong`);
      ws.on('close', (code) => resolve(code));
    });
    expect(closed).toBe(4401);
  });

  it('subscribe hydrates from since_seq, then live frames follow a post', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    const completedSync = await client.next((frame) => frame.type === 'sync_complete');
    const memberFrames = client.frames.filter((f) => f.type === 'member');
    expect(memberFrames.length).toBe(2); // hydrated owner + system
    expect(
      client.frames
        .filter((frame) => frame.type !== 'sync_complete')
        .every((frame) => !('seq' in frame) || frame.seq === 0),
    ).toBe(true);
    expect(completedSync).toMatchObject({ type: 'sync_complete', seq: daemon.store.currentSeq('eng') });

    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/w' });
    fake.enqueue({ kind: 'complete', final_text: 'live and finalized' });
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: '@alpha go' }));

    const finalized = await client.next(
      (f) => f.type === 'message' && f.message.kind === 'run' && f.message.run?.status === 'completed',
    );
    expect(finalized.type).toBe('message');
    // frames carry seq — the cursor for the next reconnect
    expect((finalized as { seq: number }).seq).toBeGreaterThan(0);
    client.ws.close();
  });

  it('joins and deduplicates mirrored native turns over the shared protocol', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: {
        act: 'join',
        harness: 'fake',
        handle: 'planner',
        session_ref: 'native-session-1',
        cwd: '/work',
      },
    }));
    await client.next(
      (frame) => frame.type === 'member' && frame.member.handle === 'planner' && frame.member.custody === 'mirrored',
    );

    const turn = {
      type: 'mirror_turn',
      harness: 'fake',
      session_ref: 'native-session-1',
      native_turn_id: 'turn-1',
      body: '@richard mirrored result',
    };
    client.ws.send(JSON.stringify(turn));
    const first = await client.next(
      (frame) => frame.type === 'mirror_ack' && frame.native_turn_id === 'turn-1',
    );
    expect(first).toMatchObject({ type: 'mirror_ack', deduped: false });
    client.ws.send(JSON.stringify(turn));
    const duplicate = await client.next(
      (frame) => frame.type === 'mirror_ack' && frame.native_turn_id === 'turn-1' && frame.deduped === true,
    );
    expect(duplicate).toMatchObject({ message_id: (first as { message_id: number }).message_id });
    expect(
      daemon.store.listMessages('eng', { limit: 100 }).filter((message) => message.kind === 'run'),
    ).toHaveLength(1);
    client.ws.close();
  });

  it('acts flow through: mark_read clears the unread count', async () => {
    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/w' });
    fake.enqueue({ kind: 'complete', final_text: '@richard ping' });
    daemon.postHumanMessage('eng', '@alpha report');
    await daemon.settle();
    const owner = daemon.ownerOf('eng');
    const delivery = daemon.store.listDeliveries('eng', { recipient: owner.id })[0]!;
    expect(daemon.unreadCount('eng', owner.id)).toBe(1);

    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: daemon.store.currentSeq('eng') }));
    client.ws.send(
      JSON.stringify({ type: 'act', room: 'eng', act: { act: 'mark_read', delivery_id: delivery.id } }),
    );
    await client.next((f) => f.type === 'inbox' && f.delivery.read_ts !== undefined);
    expect(daemon.unreadCount('eng', owner.id)).toBe(0);
    client.ws.close();
  });

  it('invalid frames come back as error frames, not disconnects', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe' })); // missing room/since_seq
    const error = await client.next((f) => f.type === 'error');
    expect(error.type).toBe('error');
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });
});
