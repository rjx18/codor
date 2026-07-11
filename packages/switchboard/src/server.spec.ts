import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Member, ServerFrame } from '@wireroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Daemon } from './daemon.js';
import { BlobStore } from './blobs.js';
import { CryptoVault } from './crypto/pairing.js';
import { FakeAdapter } from './fake-adapter.js';
import { LedgerManager } from './ledger/watch.js';
import { PushSubscriptionStore } from './push/subscriptions.js';
import { type RunningServer, startServer } from './server.js';

const TOKEN = 'test-token-123';
const ADMIN_TOKEN = 'admin-token-123';
const MEMBER_TOKEN = 'member-token-123';
const OBSERVER_TOKEN = 'observer-token-123';

let dir: string;
let fake: FakeAdapter;
let daemon: Daemon;
let crypto: CryptoVault;
let pushSubscriptions: PushSubscriptionStore;
let server: RunningServer;
let base: string;
let admin: Member;
let member: Member;
let observer: Member;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-server-'));
  fake = new FakeAdapter('fake', { interactiveAttach: true });
  daemon = new Daemon({
    dbPath: join(dir, 'db.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
    ledger: new LedgerManager({ dataDir: dir }),
  });
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
  admin = daemon.store.addMember('eng', {
    kind: 'human', handle: 'admin-user', display_name: 'Admin', role: 'admin',
  });
  member = daemon.store.addMember('eng', {
    kind: 'human', handle: 'member-user', display_name: 'Member', role: 'member',
  });
  observer = daemon.store.addMember('eng', {
    kind: 'human', handle: 'observer-user', display_name: 'Observer', role: 'observer',
  });
  crypto = new CryptoVault(dir);
  crypto.roomKeys.ensureRoom('eng');
  pushSubscriptions = new PushSubscriptionStore(dir, crypto.keys);
  server = await startServer({
    daemon,
    token: TOKEN,
    principals: [
      { token: ADMIN_TOKEN, member_id: admin.id },
      { token: MEMBER_TOKEN, member_id: member.id },
      { token: OBSERVER_TOKEN, member_id: observer.id },
    ],
    crypto,
    pushSubscriptions,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await daemon.close();
  crypto.close();
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

const connectAs = (token: string) =>
  connectUrl(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
const connect = () => connectAs(TOKEN);

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
    expect((await fetch(`${base}/api/rooms/eng/messages`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms/eng/search?q=hello`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms/eng/ledger/risk-limits`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms`, {
      headers: { authorization: 'Bearer wrong-token' },
    })).status).toBe(401);
    expect((await fetch(`${base}/api/rooms?token=wrong-token`)).status).toBe(401);
  });

  it('serves a redacted, read-only ledger note to authenticated surfaces', async () => {
    daemon.addLedgerNote('eng', {
      name: 'risk-limits',
      type: 'constraint',
      author: 'richard',
      body: 'token sk-proj-abcdef1234567890abcdef must stay private',
    });
    const res = await fetch(`${base}/api/rooms/eng/ledger/risk-limits`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: { name: string; body: string } };
    expect(body.note.name).toBe('risk-limits');
    expect(body.note.body).toContain('[redacted]');
    expect(body.note.body).not.toContain('sk-proj-');
  });

  it('serves delta-sync from the change log cursor', async () => {
    const res = await fetch(`${base}/api/rooms/eng/sync?since_seq=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const sync = (await res.json()) as { seq: number; members: unknown[]; room: { id: string } };
    expect(sync.room.id).toBe('eng');
    expect(sync.members).toHaveLength(5); // owner, three role fixtures, and system
    expect(sync.seq).toBeGreaterThan(0);
  });

  it('enrolls both device keys only through a single-use pairing token', async () => {
    const device = new CryptoVault(join(dir, 'device'));
    const offerRes = await fetch(`${base}/api/pairing/offers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    });
    expect(offerRes.status).toBe(200);
    const offer = (await offerRes.json()) as { pairing_token: string };
    const request = {
      ...device.keys.publicIdentity(),
      kind: 'device',
      label: 'chromium',
    };
    const wrong = await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: 'Pairing wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(wrong.status).toBe(401);
    const complete = await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: `Pairing ${offer.pairing_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({
      switchboard: { device_id: crypto.keys.identity.device_id },
      room_keys: [{ room: 'eng', generation: 1 }],
      access_token: TOKEN,
    });
    expect(crypto.keys.getPeer(device.keys.identity.device_id)).toMatchObject({
      sign_public_key: device.keys.identity.sign_public_key,
      encryption_public_key: device.keys.identity.encryption_public_key,
    });
    const replay = await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: `Pairing ${offer.pairing_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(401);
    device.close();
  });

  it('registers and removes full Web Push subscriptions only for paired devices', async () => {
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const subscription = {
      endpoint: 'https://push.example.test/device-token',
      expirationTime: null,
      keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
    };
    const unpaired = await fetch(`${base}/api/devices/not-paired/push-subscription`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ subscription }),
    });
    expect(unpaired.status).toBe(400);

    const device = new CryptoVault(join(dir, 'push-browser'));
    const peer = crypto.keys.enrollPeer({
      ...device.keys.publicIdentity(),
      kind: 'device',
      label: 'push-browser',
    });
    crypto.roomKeys.enrollPeer(peer);
    const registered = await fetch(
      `${base}/api/devices/${encodeURIComponent(peer.device_id)}/push-subscription`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ subscription }),
      },
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      subscription: { device_id: peer.device_id, subscription },
    });
    expect(pushSubscriptions.get(peer.device_id)?.subscription).toEqual(subscription);

    const removed = await fetch(
      `${base}/api/devices/${encodeURIComponent(peer.device_id)}/push-subscription`,
      { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(removed.status).toBe(204);
    expect(pushSubscriptions.get(peer.device_id)).toBeUndefined();

    await fetch(`${base}/api/devices/${encodeURIComponent(peer.device_id)}/push-subscription`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ subscription }),
    });
    const devices = await fetch(`${base}/api/devices`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await devices.json()).toMatchObject({
      devices: [{ device_id: peer.device_id, label: 'push-browser', push_enabled: true }],
    });
    const generation = crypto.roomKeys.roomGeneration('eng');
    const revoked = await fetch(`${base}/api/devices/${encodeURIComponent(peer.device_id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect(crypto.keys.getPeer(peer.device_id)).toBeUndefined();
    expect(crypto.roomKeys.roomGeneration('eng')).toBe(generation + 1);
    expect(pushSubscriptions.get(peer.device_id)).toBeUndefined();
    device.close();
  });

  it('reports push disabled when no VAPID public key is configured', async () => {
    const response = await fetch(`${base}/api/push/config`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toEqual({ enabled: false });
  });

  it('reports push disabled when VAPID exists without a relay producer', async () => {
    await server.close();
    server = await startServer({
      daemon,
      token: TOKEN,
      crypto,
      pushSubscriptions,
      pushVapidPublicKey: 'configured-vapid-key',
      pushRelayEnabled: false,
    });
    base = `http://127.0.0.1:${server.port}`;

    const response = await fetch(`${base}/api/push/config`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(await response.json()).toEqual({
      enabled: false,
      vapid_public_key: 'configured-vapid-key',
    });
  });

  it('serves redacted before-id history pages and room-scoped body search', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const owner = daemon.ownerOf('eng');
    for (let id = 1; id <= 6; id++) {
      daemon.store.postMessage('eng', {
        author: owner.id,
        kind: 'chat',
        body: id === 2 ? 'needle sk-proj-abcdef1234567890abcdef' : `message ${id}`,
      });
    }

    const latestRes = await fetch(`${base}/api/rooms/eng/messages?limit=3`, { headers: auth });
    expect(latestRes.status).toBe(200);
    const latest = (await latestRes.json()) as {
      messages: { id: number; body: string }[];
      has_more: boolean;
    };
    expect(latest.messages.map((message) => message.id)).toEqual([4, 5, 6]);
    expect(latest.has_more).toBe(true);

    const olderRes = await fetch(`${base}/api/rooms/eng/messages?before=4&limit=3`, {
      headers: auth,
    });
    const older = (await olderRes.json()) as {
      messages: { id: number; body: string }[];
      has_more: boolean;
    };
    expect(older.messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(older.messages[1]!.body).toContain('[redacted]');
    expect(older.messages[1]!.body).not.toContain('sk-proj-');
    expect(older.has_more).toBe(false);

    const searchRes = await fetch(`${base}/api/rooms/eng/search?q=needle`, { headers: auth });
    const search = (await searchRes.json()) as { messages: { id: number; body: string }[] };
    expect(search.messages.map((message) => message.id)).toEqual([2]);
    expect(search.messages[0]!.body).toContain('[redacted]');

    const secretOracle = await fetch(`${base}/api/rooms/eng/search?q=sk-proj-abcdef`, {
      headers: auth,
    });
    expect(await secretOracle.json()).toEqual({ messages: [] });
    const projectedSearch = await fetch(
      `${base}/api/rooms/eng/search?q=${encodeURIComponent('[redacted]')}`,
      { headers: auth },
    );
    expect(await projectedSearch.json()).toMatchObject({ messages: [{ id: 2 }] });
  });

  it('validates history and search parameters and missing rooms', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/api/rooms/eng/messages?limit=0`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/rooms/eng/messages?before=nope`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/rooms/eng/search?q=`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/rooms/missing/messages`, { headers: auth })).status).toBe(404);
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

  it('keeps device revocation owner-only even when an admin bearer is valid', async () => {
    const device = new CryptoVault(join(dir, 'role-device'));
    const peer = crypto.keys.enrollPeer({
      ...device.keys.publicIdentity(), kind: 'device', label: 'role-device',
    });
    crypto.roomKeys.enrollPeer(peer);

    const forbidden = await fetch(`${base}/api/devices/${encodeURIComponent(peer.device_id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(forbidden.status).toBe(403);
    expect(crypto.keys.getPeer(peer.device_id)).toBeDefined();

    const allowed = await fetch(`${base}/api/devices/${encodeURIComponent(peer.device_id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect(crypto.keys.getPeer(peer.device_id)).toBeUndefined();
    device.close();
  });
});

describe('WebSocket', () => {
  it('rejects a public unix socket parent before listen', async () => {
    const publicParent = join(dir, 'public-socket-parent');
    mkdirSync(publicParent, { mode: 0o755 });
    chmodSync(publicParent, 0o755);
    await expect(
      startServer({ daemon, token: TOKEN, socketPath: join(publicParent, 'wireroom.sock') }),
    ).rejects.toThrow('unix socket parent must be a private directory');
    expect(statSync(publicParent).mode & 0o777).toBe(0o755);
  });

  it('derives post authors and act authority from each authenticated human', async () => {
    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/w' });

    const observerClient = await connectAs(OBSERVER_TOKEN);
    observerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await expect(observerClient.next((frame) => frame.type === 'self')).resolves.toMatchObject({
      type: 'self', member_id: observer.id,
    });
    observerClient.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: 'forbidden post' }));
    await expect(observerClient.next((frame) =>
      frame.type === 'error' && frame.message.includes('forbidden'))).resolves.toMatchObject({
      ref: 'post',
    });
    expect(daemon.store.searchMessages('eng', 'forbidden post')).toEqual([]);

    const memberClient = await connectAs(MEMBER_TOKEN);
    memberClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await memberClient.next((frame) => frame.type === 'sync_complete');
    memberClient.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: 'member commentary' }));
    await expect(memberClient.next((frame) =>
      frame.type === 'message' && frame.message.body === 'member commentary')).resolves.toMatchObject({
      message: { author: member.id },
    });
    memberClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'rename', member_id: alpha.id, handle: 'member-hack' },
    }));
    await expect(memberClient.next((frame) =>
      frame.type === 'error' && frame.message.includes('member cannot rename'))).resolves.toBeDefined();
    expect(daemon.store.getMember('eng', alpha.id)?.handle).toBe('alpha');

    const adminClient = await connectAs(ADMIN_TOKEN);
    adminClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await adminClient.next((frame) => frame.type === 'sync_complete');
    adminClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'rename', member_id: alpha.id, handle: 'admin-renamed' },
    }));
    await expect(adminClient.next((frame) =>
      frame.type === 'member' && frame.member.id === alpha.id && frame.member.handle === 'admin-renamed'))
      .resolves.toMatchObject({
      member: { handle: 'admin-renamed' },
    });
    adminClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'set_role', member_id: member.id, role: 'observer' },
    }));
    const roleError = await adminClient.next((frame) => frame.type === 'error');
    expect(roleError).toMatchObject({ message: expect.stringContaining('admin cannot set role') });

    const ownerClient = await connect();
    ownerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await ownerClient.next((frame) => frame.type === 'sync_complete');
    ownerClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'set_role', member_id: member.id, role: 'observer' },
    }));
    await expect(ownerClient.next((frame) =>
      frame.type === 'member' && frame.member.id === member.id && frame.member.role === 'observer'))
      .resolves.toBeDefined();

    observerClient.ws.close();
    memberClient.ws.close();
    adminClient.ws.close();
    ownerClient.ws.close();
  });

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
    expect(memberFrames.length).toBe(5); // hydrated owner, role fixtures, and system
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

  it('runs the attach lease acquire, child-report, and completion handshake', async () => {
    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/work' });
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();

    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'attach_acquire', member_id: alpha.id, cli_pid: 1234 },
    }));
    const acquired = await client.next(
      (frame) => frame.type === 'attach_lease' && frame.status === 'acquired',
    );
    expect(acquired).toMatchObject({
      type: 'attach_lease',
      status: 'acquired',
      member: { id: alpha.id, custody: 'mirrored' },
      lease: { cli_pid: 1234 },
    });
    const leaseId = (acquired as Extract<ServerFrame, { type: 'attach_lease' }>).lease!.id;
    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: {
        act: 'attach_child',
        lease_id: leaseId,
        child_pid: 999_997,
        process_group_id: 999_997,
      },
    }));
    await client.next(
      (frame) => frame.type === 'attach_lease' && frame.status === 'child_recorded',
    );
    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'attach_complete', lease_id: leaseId },
    }));
    const completed = await client.next(
      (frame) => frame.type === 'attach_lease' && frame.status === 'completed',
    );
    expect(completed).toMatchObject({ member: { id: alpha.id, custody: 'owned' } });
    expect(fake.wasAttached(daemon.store.getMember('eng', alpha.id)!.session_ref!)).toBe(true);
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

  it('configures opt-in brakes and stall timing over the shared act protocol', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: {
        act: 'configure_room',
        turn_brake: 3,
        spend_brake_usd: 2.5,
        stall_minutes: 12,
      },
    }));
    const room = await client.next(
      (frame) =>
        frame.type === 'room' &&
        frame.room.id === 'eng' &&
        frame.room.config.turn_brake === 3,
    );
    expect(room).toMatchObject({
      room: {
        config: { turn_brake: 3, spend_brake_usd: 2.5, stall_minutes: 12 },
      },
    });
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
