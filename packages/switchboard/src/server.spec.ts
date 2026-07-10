import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@wireroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Daemon } from './daemon.js';
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
  daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

function connect(): Promise<{ ws: WebSocket; frames: ServerFrame[]; next: (pred: (f: ServerFrame) => boolean) => Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN}`);
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

describe('REST', () => {
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
});

describe('WebSocket', () => {
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
    await client.next((f) => f.type === 'room');
    const memberFrames = client.frames.filter((f) => f.type === 'member');
    expect(memberFrames.length).toBe(2); // hydrated owner + system

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
