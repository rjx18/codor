import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Member, ServerFrame, Session, SpawnOpts } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { Daemon, MAX_ATTACHMENT_BYTES } from './daemon.js';
import { BlobStore } from './blobs.js';
import { signChallenge, type AuthChallenge } from './crypto/challenge.js';
import { CryptoVault, PAIRING_CODE_ALPHABET } from './crypto/pairing.js';
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

const testCwd = (name = 'work') => {
  const path = join(dir, 'cwd', name);
  mkdirSync(path, { recursive: true });
  return path;
};

const spawnAgentWithToken = (handle: string, room = 'eng') => {
  let captured: Session | undefined;
  const originalSpawn = fake.spawn.bind(fake);
  const spawn = vi.spyOn(fake, 'spawn').mockImplementationOnce((opts: SpawnOpts) => {
    captured = originalSpawn(opts);
    return captured;
  });
  const agent = daemon.spawnMember(room, {
    harness: 'fake', handle, cwd: testCwd(`${room}-${handle}`),
  });
  spawn.mockRestore();
  const token = captured?.env?.CODOR_MEMBER_TOKEN;
  if (!token) throw new Error(`spawn did not issue a member credential for @${handle}`);
  return { agent, token };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codor-server-'));
  fake = new FakeAdapter('fake', { interactiveAttach: true });
  daemon = new Daemon({
    dbPath: join(dir, 'db.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
    ledger: new LedgerManager({ dataDir: dir }),
    homeDir: dir,
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
    homeDir: dir,
  });
  base = `http://127.0.0.1:${server.port}`;
});

// harn:assume agent-member-credentials-stay-secret ref=agent-principal-resolution-regression
// harn:assume agent-network-authority-is-narrow ref=agent-authz-regression
describe('agent member credential principal', () => {
  it('resolves dynamically, stays in one room, posts as self, and forbids management', async () => {
    let session: Session | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    vi.spyOn(fake, 'spawn').mockImplementation((opts: SpawnOpts) => {
      session = originalSpawn(opts);
      return session;
    });
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'live-agent', cwd: testCwd('agent'),
    });
    const agentToken = session!.env!.CODOR_MEMBER_TOKEN!;
    daemon.createRoom({
      id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' },
    });

    const roomList = await fetch(`${base}/api/rooms`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(roomList.status).toBe(200);
    expect((await roomList.json() as { rooms: { id: string }[] }).rooms.map((room) => room.id))
      .toEqual(['eng']);

    const ownHistory = await fetch(`${base}/api/rooms/eng/messages`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(ownHistory.status).toBe(200);
    const otherHistory = await fetch(`${base}/api/rooms/other/messages`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(otherHistory.status).toBe(403);
    const globalCatalog = await fetch(`${base}/api/adapters`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(globalCatalog.status).toBe(403);
    const createRoom = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'forbidden', name: 'Forbidden' }),
    });
    expect(createRoom.status).toBe(403);

    const client = await connectAs(agentToken);
    client.ws.send(JSON.stringify({ type: 'list_rooms' }));
    const rooms = await client.next((frame) => frame.type === 'rooms');
    expect(rooms.type === 'rooms' && rooms.rooms.map((room) => room.id)).toEqual(['eng']);

    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    const self = await client.next((frame) => frame.type === 'self');
    expect(self).toEqual({ type: 'self', member_id: agent.id });

    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: '@richard interim update' }));
    const posted = await client.next((frame) =>
      frame.type === 'message' && frame.message.author === agent.id);
    expect(posted.type === 'message' && posted.message).toMatchObject({
      author: agent.id,
      kind: 'chat',
      body: '@richard interim update',
    });

    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'configure', member_id: agent.id, policy: 'full-access' },
    }));
    const denied = await client.next((frame) =>
      frame.type === 'error' && frame.message.includes('agent cannot configure'));
    expect(denied).toMatchObject({ type: 'error', ref: 'act' });
    client.ws.close();

    expect(daemon.store.getMember('eng', agent.id)!.policy).toBeUndefined();
    expect(JSON.stringify(daemon.store.listMembers('eng'))).not.toContain(agentToken);
  });

  it('uses an explicit member token on the Unix socket while tokenless use stays owner', async () => {
    let session: Session | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    vi.spyOn(fake, 'spawn').mockImplementation((opts: SpawnOpts) => {
      session = originalSpawn(opts);
      return session;
    });
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'socket-agent', cwd: testCwd('socket-agent'),
    });
    const agentToken = session!.env!.CODOR_MEMBER_TOKEN!;
    const socketPath = join(dir, 'codor.sock');
    await server.close();
    server = await startServer({ daemon, token: TOKEN, socketPath, crypto, pushSubscriptions });

    const agentClient = await connectUrl(`ws+unix://${socketPath}:/ws?token=${agentToken}`);
    agentClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await agentClient.next((frame) => frame.type === 'self'))
      .toEqual({ type: 'self', member_id: agent.id });
    agentClient.ws.close();

    const ownerClient = await connectUrl(`ws+unix://${socketPath}:/ws`);
    ownerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await ownerClient.next((frame) => frame.type === 'self'))
      .toEqual({ type: 'self', member_id: daemon.ownerOf('eng').id });
    ownerClient.ws.close();
  });
});
// harn:end agent-network-authority-is-narrow
// harn:end agent-member-credentials-stay-secret

// harn:assume agent-sync-hydrates-only-own-queued-inbox ref=own-queued-sync-regression
describe('agent queued inbox hydration', () => {
  it('sends only the authenticated agent own queued rows and leaves them consumable', async () => {
    const alpha = spawnAgentWithToken('alpha');
    const beta = spawnAgentWithToken('beta');
    const gamma = spawnAgentWithToken('gamma');
    daemon.pauseMember('eng', alpha.agent.id);
    daemon.pauseMember('eng', gamma.agent.id);
    const posted = daemon.postAgentMessage('eng', beta.agent.id, '@alpha own @gamma other');
    const alphaDelivery = daemon.store.listDeliveries('eng', {
      recipient: alpha.agent.id,
      state: 'queued',
    }).find((delivery) => delivery.message_id === posted.id)!;
    const gammaDelivery = daemon.store.listDeliveries('eng', {
      recipient: gamma.agent.id,
      state: 'queued',
    }).find((delivery) => delivery.message_id === posted.id)!;

    const client = await connectAs(alpha.token);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    const inboxIds = client.frames
      .filter((frame): frame is Extract<ServerFrame, { type: 'inbox' }> => frame.type === 'inbox')
      .map((frame) => frame.delivery.id);
    expect(inboxIds).toContain(alphaDelivery.id);
    expect(inboxIds).not.toContain(gammaDelivery.id);

    client.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'consume_delivery', delivery_id: alphaDelivery.id },
    }));
    expect(await client.next((frame) =>
      frame.type === 'consume_result' && frame.delivery.id === alphaDelivery.id)).toMatchObject({
      type: 'consume_result',
      delivery: { id: alphaDelivery.id, state: 'consumed' },
      message: { id: posted.id },
    });
    client.ws.close();
  });
});
// harn:end agent-sync-hydrates-only-own-queued-inbox

describe('pin_message act (pins-are-durable-role-gated-markers)', () => {
  it('an owner pins over the ws and the flip syncs to subscribers', async () => {
    const posted = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'decision worth keeping',
    });
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'pin_message', message_id: posted.id, pinned: true },
    }));
    const framed = await client.next((frame) =>
      frame.type === 'message' && frame.message.id === posted.id && frame.message.pinned === true);
    expect(framed).toMatchObject({ type: 'message', message: { id: posted.id, pinned: true } });
    expect(daemon.store.getMessage('eng', posted.id)?.pinned).toBe(true);
    client.ws.close();
  });

  it('refuses a non-privileged principal with an error frame', async () => {
    const posted = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'no pinning for you',
    });
    const client = await connectAs(OBSERVER_TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'pin_message', message_id: posted.id, pinned: true },
    }));
    expect(await client.next((frame) => frame.type === 'error'))
      .toMatchObject({ type: 'error', ref: 'act' });
    expect(daemon.store.getMessage('eng', posted.id)?.pinned).toBeUndefined();
    client.ws.close();
  });
});

describe('pinned hydration endpoint (pin-strip-hydration-and-guards)', () => {
  it('returns the whole pinned set in id order to a reader, and refuses anon', async () => {
    const owner = daemon.ownerOf('eng').id;
    const a = daemon.store.postMessage('eng', { author: owner, kind: 'chat', body: 'first pin' });
    const b = daemon.store.postMessage('eng', { author: owner, kind: 'chat', body: 'second pin' });
    daemon.store.postMessage('eng', { author: owner, kind: 'chat', body: 'never pinned' });
    daemon.pinMessage('eng', b.id, true, owner); // pin later id first
    daemon.pinMessage('eng', a.id, true, owner);

    const res = await fetch(`${base}/api/rooms/eng/messages?pinned=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: { id: number }[]; has_more: boolean };
    expect(body.messages.map((message) => message.id)).toEqual([a.id, b.id]); // id order, pinned only
    expect(body.has_more).toBe(false);

    const anon = await fetch(`${base}/api/rooms/eng/messages?pinned=1`);
    expect(anon.status).toBe(401);
  });
});

describe('delete_message act (deleted-messages-are-purged-tombstones)', () => {
  it('an owner deletes over the ws and the tombstone syncs to subscribers', async () => {
    const posted = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'a sensitive line',
    });
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'delete_message', message_id: posted.id },
    }));
    const framed = await client.next((frame) =>
      frame.type === 'message' && frame.message.id === posted.id && frame.message.deleted === true);
    expect(framed).toMatchObject({ type: 'message', message: { id: posted.id, deleted: true, body: '' } });
    expect(daemon.store.getMessage('eng', posted.id)?.body).toBe('');
    client.ws.close();
  });

  it('refuses a non-privileged principal with an error frame', async () => {
    const posted = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'not yours to delete',
    });
    const client = await connectAs(OBSERVER_TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'delete_message', message_id: posted.id },
    }));
    expect(await client.next((frame) => frame.type === 'error'))
      .toMatchObject({ type: 'error', ref: 'act' });
    expect(daemon.store.getMessage('eng', posted.id)?.deleted).toBeUndefined();
    client.ws.close();
  });
});

describe('retry_run act (retried-runs-are-fresh-deliveries)', () => {
  it('an owner retries a failed run over the ws into a fresh run; an observer is refused', async () => {
    const alpha = spawnAgentWithToken('alpha');
    fake.enqueue({ kind: 'complete', status: 'failed', final_text: 'boom' });
    daemon.postHumanMessage('eng', '@alpha do the thing');
    await daemon.settle();
    const failed = daemon.store
      .listRunMessages('eng', { author: alpha.agent.id })
      .find((message) => message.run?.status === 'failed')!;
    expect(failed).toBeDefined();

    // An observer principal is refused.
    const denied = await connectAs(OBSERVER_TOKEN);
    denied.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await denied.next((frame) => frame.type === 'sync_complete');
    denied.ws.send(JSON.stringify({ type: 'act', room: 'eng', act: { act: 'retry_run', message_id: failed.id } }));
    expect(await denied.next((frame) => frame.type === 'error')).toMatchObject({ type: 'error', ref: 'act' });
    denied.ws.close();

    // The owner retries → a fresh completed run appears; the failed one stands.
    fake.enqueue({ kind: 'complete', final_text: 'done this time' });
    const owner = await connect();
    owner.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await owner.next((frame) => frame.type === 'sync_complete');
    owner.ws.send(JSON.stringify({ type: 'act', room: 'eng', act: { act: 'retry_run', message_id: failed.id } }));
    const fresh = await owner.next((frame) =>
      frame.type === 'message' && frame.message.kind === 'run'
      && frame.message.author === alpha.agent.id && frame.message.id !== failed.id
      && frame.message.run?.status === 'completed');
    expect(fresh).toBeTruthy();
    expect(daemon.store.getMessage('eng', failed.id)?.run?.status).toBe('failed');
    owner.ws.close();
  });
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

function postJsonOnConnection(
  agent: HttpAgent,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = httpRequest(url, {
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      }));
    });
    request.on('error', reject);
    request.end(encoded);
  });
}

async function authenticateDevice(device: CryptoVault): Promise<string> {
  const challengeResponse = await fetch(`${base}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: device.keys.identity.device_id }),
  });
  expect(challengeResponse.status).toBe(200);
  const offered = (await challengeResponse.json()) as {
    challenge: AuthChallenge;
    switchboard_device_id: string;
  };
  expect(offered.switchboard_device_id).toBe(crypto.keys.identity.device_id);
  const sessionResponse = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge_id: offered.challenge.challenge_id,
      signature: signChallenge(offered.challenge, device.keys.identity),
    }),
  });
  expect(sessionResponse.status).toBe(200);
  return ((await sessionResponse.json()) as { access_token: string }).access_token;
}

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
    expect((await fetch(`${base}/api/rooms/eng/ledger`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms/eng/ledger/risk-limits`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms`, {
      headers: { authorization: 'Bearer wrong-token' },
    })).status).toBe(401);
    expect((await fetch(`${base}/api/rooms?token=wrong-token`)).status).toBe(401);
  });

  it('gates bridge enable and ingress at admin and suppresses own-origin outbound echoes', async () => {
    const request = (token: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
    const payload = JSON.stringify({ platform: 'slack', channel: 'C123' });
    expect((await request(MEMBER_TOKEN, '/api/rooms/eng/bridges', { method: 'POST', body: payload })).status).toBe(403);
    expect((await request(OBSERVER_TOKEN, '/api/rooms/eng/bridges', { method: 'POST', body: payload })).status).toBe(403);
    const enabledResponse = await request(ADMIN_TOKEN, '/api/rooms/eng/bridges', { method: 'POST', body: payload });
    expect(enabledResponse.status).toBe(201);
    const enabled = (await enabledResponse.json()) as { member: Member; after: number };

    daemon.postHumanMessage('eng', 'Local message');
    const inbound = JSON.stringify({
      body: 'Slack message',
      origin: { platform: 'slack', external_id: '171.42', sender_name: 'Sarah' },
    });
    const first = await request(ADMIN_TOKEN, `/api/rooms/eng/bridges/${enabled.member.id}/messages`, {
      method: 'POST', body: inbound,
    });
    const retry = await request(ADMIN_TOKEN, `/api/rooms/eng/bridges/${enabled.member.id}/messages`, {
      method: 'POST', body: inbound,
    });
    expect(first.status).toBe(200);
    expect((await retry.json()) as { deduped: boolean }).toMatchObject({ deduped: true });
    expect((await request(MEMBER_TOKEN, `/api/rooms/eng/bridges/${enabled.member.id}/messages`, {
      method: 'POST', body: inbound,
    })).status).toBe(403);

    const outbound = await request(ADMIN_TOKEN, `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(enabled.after)}`);
    expect(outbound.status).toBe(200);
    const body = (await outbound.json()) as { messages: { body: string }[]; next_after: number };
    expect(body.messages.map((message) => message.body)).toEqual(['Local message']);
    expect(body.next_after).toBeGreaterThan(enabled.after);
  });

  it('holds outbound before a running placeholder, then mirrors its final body exactly once', async () => {
    const request = (path: string) => fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const enabledResponse = await fetch(`${base}/api/rooms/eng/bridges`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', channel: '-10022' }),
    });
    const enabled = (await enabledResponse.json()) as { member: Member; after: number };
    const owner = daemon.ownerOf('eng');
    const agent = daemon.store.addMember('eng', {
      kind: 'agent', handle: 'outbound-agent', display_name: 'Outbound agent',
    });
    const local = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'Before run' });
    const started = new Date().toISOString();
    const run = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/outbound.jsonl' },
    });
    daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'After run' });

    const blocked = (await (await request(
      `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(enabled.after)}`,
    )).json()) as { messages: { id: number; body: string }[]; next_after: number };
    expect(blocked.messages.map((message) => message.body)).toEqual(['Before run']);
    expect(blocked.next_after).toBe(local.id);

    daemon.store.updateMessage('eng', run.id, {
      body: 'Final agent answer',
      run: {
        status: 'completed',
        started_ts: started,
        ended_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: 'runs/outbound.jsonl',
        final_text: 'Final agent answer',
      },
    });
    const ready = (await (await request(
      `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(blocked.next_after)}`,
    )).json()) as { messages: { id: number; body: string }[]; next_after: number };
    expect(ready.messages.map((message) => message.body)).toEqual(['Final agent answer', 'After run']);
    expect(ready.messages.map((message) => message.id)).toEqual([run.id, run.id + 1]);

    const empty = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: {
        status: 'interrupted', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/empty.jsonl', final_text: '',
      },
    });
    const tail = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'Past empty run' });
    const afterEmpty = (await (await request(
      `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(ready.next_after)}`,
    )).json()) as { messages: { id: number; body: string }[]; next_after: number };
    expect(afterEmpty.messages.map((message) => message.body)).toEqual(['Past empty run']);
    expect(afterEmpty.next_after).toBe(tail.id);
    expect(empty.id).toBe(tail.id - 1);
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

  it('serves the room-scoped ledger graph to observer readers without a mutation route', async () => {
    daemon.addLedgerNote('eng', {
      name: 'launch-plan',
      type: 'decision',
      author: 'richard',
      body: 'Honor [[risk-limits]].',
    });
    daemon.addLedgerNote('eng', {
      name: 'risk-limits',
      type: 'constraint',
      author: 'richard',
      body: 'Stay bounded.',
    });
    const res = await fetch(`${base}/api/rooms/eng/ledger`, {
      headers: { authorization: `Bearer ${OBSERVER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      graph: { nodes: { id: string }[]; edges: { source: string; target: string }[] };
    };
    expect(body.graph.nodes.map((node) => node.id)).toContain('launch-plan');
    expect(body.graph.edges).toContainEqual({ source: 'launch-plan', target: 'risk-limits' });
    expect((await fetch(`${base}/api/rooms/eng/ledger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status).toBe(404);
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
    const completed = await complete.json() as Record<string, unknown>;
    expect(completed).toMatchObject({
      switchboard: { device_id: crypto.keys.identity.device_id },
      room_keys: [{ room: 'eng', generation: 1 }],
    });
    expect(completed).not.toHaveProperty('access_token');
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

    const deviceToken = await authenticateDevice(device);
    expect(deviceToken).not.toBe(TOKEN);
    expect((await fetch(`${base}/api/rooms`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).status).toBe(200);
    const socket = await connectAs(deviceToken);
    const closed = new Promise<number>((resolve) => socket.ws.once('close', resolve));
    const revoked = await fetch(`${base}/api/devices/${encodeURIComponent(device.keys.identity.device_id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect(await closed).toBe(4403);
    expect((await fetch(`${base}/api/rooms`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: device.keys.identity.device_id }),
    })).status).toBe(401);
    device.close();
  });

  // harn:assume pairing-code-exchange-uniform-and-rate-limited ref=pairing-code-exchange-rest-regression
  it('exchanges a short code uniformly and lets only paired owners mint another', async () => {
    const offerResponse = await fetch(`${base}/api/pairing/offers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    });
    const offer = await offerResponse.json() as {
      endpoint: string;
      pairing_token: string;
      pairing_code: string;
      expires_at: string;
      switchboard_sign_pub: string;
    };
    expect(offer.pairing_code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);

    const uniformFailure = { error: 'pairing code not found' };
    const malformed = await fetch(`${base}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 42 }),
    });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual(uniformFailure);
    const unknown = await fetch(`${base}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZ-ZZZ2' }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(uniformFailure);

    const exchangedResponse = await fetch(`${base}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: offer.pairing_code.replace('-', '').toLowerCase() }),
    });
    expect(exchangedResponse.status).toBe(200);
    const exchanged = await exchangedResponse.json() as typeof offer;
    expect(exchanged).toMatchObject({
      endpoint: offer.endpoint,
      expires_at: offer.expires_at,
      switchboard_sign_pub: offer.switchboard_sign_pub,
    });
    expect(exchanged).not.toHaveProperty('pairing_code');
    expect(exchanged.pairing_token).not.toBe(offer.pairing_token);

    const device = new CryptoVault(join(dir, 'code-device'));
    const request = { ...device.keys.publicIdentity(), kind: 'device', label: 'code browser' };
    expect((await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: `Pairing ${offer.pairing_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })).status).toBe(401);
    expect((await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: `Pairing ${exchanged.pairing_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })).status).toBe(200);
    const replay = await fetch(`${base}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: offer.pairing_code }),
    });
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual(uniformFailure);

    expect((await fetch(`${base}/api/pairing/offers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    })).status).toBe(403);
    expect((await fetch(`${base}/api/pairing/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    })).status).toBe(401);
    const deviceToken = await authenticateDevice(device);
    const pairedMint = await fetch(`${base}/api/pairing/offers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    });
    expect(pairedMint.status).toBe(200);
    expect((await pairedMint.json() as { pairing_code: string }).pairing_code)
      .toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
    device.close();
  });

  it('limits code guessing to five attempts per minute without burning the grant', async () => {
    const offer = crypto.pairing.issue(base);
    const compact = offer.pairing_code.replace('-', '');
    const alternatives = Array.from(PAIRING_CODE_ALPHABET)
      .filter((character) => character !== compact.at(-1))
      .slice(0, 5)
      .map((character) => `${compact.slice(0, -1)}${character}`);
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const code of alternatives) {
        expect(await postJsonOnConnection(agent, `${base}/api/pairing/exchange`, { code }))
          .toEqual({ status: 404, body: { error: 'pairing code not found' } });
      }
      expect(await postJsonOnConnection(
        agent,
        `${base}/api/pairing/exchange`,
        { code: offer.pairing_code },
      )).toEqual({ status: 404, body: { error: 'pairing code not found' } });
    } finally {
      agent.destroy();
    }
    const freshConnection = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      const exchanged = await postJsonOnConnection(
        freshConnection,
        `${base}/api/pairing/exchange`,
        { code: offer.pairing_code },
      );
      expect(exchanged.status).toBe(200);
      expect(exchanged.body).toMatchObject({ endpoint: base });
    } finally {
      freshConnection.destroy();
    }
  });
  // harn:end pairing-code-exchange-uniform-and-rate-limited

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

  // harn:assume run-evidence-search-is-bounded-and-redacted ref=run-search-server-regression
  it('adds bounded projected run hits without changing message-only search', async () => {
    const { agent: alpha, token: agentToken } = spawnAgentWithToken('search-agent');
    const message = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'needle in the timeline',
    });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: 'done' });
    const run = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'completed', started_ts: '2026-07-10T07:00:00.000Z',
        ended_ts: '2026-07-10T07:01:00.000Z', tool_calls: 1,
        events_ref: `runs/${String(posted.id)}.jsonl`, final_text: 'done',
      },
    });
    daemon.blobs.append('eng', run.run!.events_ref, {
      type: 'run.item', item_type: 'tool_call',
      payload: { call_id: 'search-call', tool: 'Bash', title: 'needle AKIAIOSFODNN7EXAMPLE' },
    });
    daemon.blobs.append('eng', run.run!.events_ref, {
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'search-call', status: 'ok', output_text: 'needle output' },
    });

    const headers = { authorization: `Bearer ${agentToken}` };
    const response = await fetch(`${base}/api/rooms/eng/search?q=needle&include=runs&limit=50`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messages: [{ id: message.id }],
      runs: [
        { message_id: run.id, item_index: 0, kind: 'tool_call', excerpt: expect.stringContaining('[redacted]') },
        { message_id: run.id, item_index: 1, kind: 'tool_result', excerpt: 'needle output' },
      ],
    });
    const rawSecret = await fetch(
      `${base}/api/rooms/eng/search?q=AKIAIOSFODNN7EXAMPLE&include=runs`,
      { headers },
    );
    expect(await rawSecret.json()).toMatchObject({ runs: [] });
    const messagesOnly = await fetch(`${base}/api/rooms/eng/search?q=needle`, { headers });
    expect(await messagesOnly.json()).not.toHaveProperty('runs');
    expect((await fetch(`${base}/api/rooms/eng/search?q=x&include=tools`, { headers })).status)
      .toBe(400);
    expect((await fetch(`${base}/api/rooms/eng/search?q=x&include=runs&limit=201`, { headers })).status)
      .toBe(400);

    daemon.createRoom({
      id: 'search-other', name: 'Search Other',
      owner: { handle: 'other-owner', display_name: 'Other Owner' },
    });
    expect((await fetch(`${base}/api/rooms/search-other/search?q=needle&include=runs`, { headers })).status)
      .toBe(403);
  });
  // harn:end run-evidence-search-is-bounded-and-redacted

  // harn:assume member-status-is-bounded-and-identity-safe ref=status-server-regression
  it('serves identity-safe status to readers and only same-room agent credentials', async () => {
    const { agent: alpha, token: agentToken } = spawnAgentWithToken('status-agent');
    const beta = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'status-peer', cwd: testCwd('status-peer'),
    });
    const now = new Date();
    daemon.store.updateMember('eng', alpha.id, { state: 'running' });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const run = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running', started_ts: new Date(now.getTime() - 1_000).toISOString(),
        tool_calls: 1, events_ref: `runs/${String(posted.id)}.jsonl`,
      },
    });
    daemon.blobs.append('eng', run.run!.events_ref, {
      type: 'run.item', item_type: 'tool_call', ts: now.toISOString(),
      payload: { call_id: 'status-call', tool: 'Bash', title: 'Check AKIAIOSFODNN7EXAMPLE' },
    });
    daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id], until_ts: new Date(now.getTime() + 60_000).toISOString(),
    }, now);

    const path = `/api/rooms/eng/members/${alpha.id}/status`;
    const observerResponse = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${OBSERVER_TOKEN}` },
    });
    expect(observerResponse.status).toBe(200);
    const status = await observerResponse.json();
    expect(status).toMatchObject({
      member: { handle: 'status-agent', state: 'running', waiting: { peers: ['status-peer'] } },
      current_run: { message_id: run.id, tool_calls: 1 },
      recent: [{ kind: 'tool', title: expect.stringContaining('[redacted]') }],
    });
    expect(JSON.stringify(status)).not.toContain(alpha.id);
    expect(JSON.stringify(status)).not.toContain(beta.id);
    expect(JSON.stringify(status)).not.toContain('AKIAIOSFODNN7EXAMPLE');

    expect((await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })).status).toBe(200);
    expect((await fetch(`${base}/api/rooms/eng/members/01ARZ3NDEKTSV4RRFFQ69G5FAV/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status).toBe(404);
    daemon.createRoom({
      id: 'status-other', name: 'Status Other',
      owner: { handle: 'status-owner', display_name: 'Status Owner' },
    });
    const otherOwner = daemon.ownerOf('status-other');
    expect((await fetch(`${base}/api/rooms/status-other/members/${otherOwner.id}/status`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })).status).toBe(403);
    daemon.endWait('eng', alpha.id);
  });
  // harn:end member-status-is-bounded-and-identity-safe

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
    // harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-pending-rest
    // The listing says whether discovery is still running, so a browser that arrives
    // early can tell an empty catalog from an unfinished one and ask again.
    expect(await adaptersRes.json()).toMatchObject({
      adapters: [{ id: 'fake', capabilities: { resume: true } }],
      discovering: false,
    });
    // harn:end model-catalogs-reach-a-browser-that-arrives-early

    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd('review') });
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
    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });
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
    expect(res.status).toBe(400);
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
      startServer({ daemon, token: TOKEN, socketPath: join(publicParent, 'codor.sock') }),
    ).rejects.toThrow('unix socket parent must be a private directory');
    expect(statSync(publicParent).mode & 0o777).toBe(0o755);
  });

  it('derives post authors and act authority from each authenticated human', async () => {
    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });

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
    const socketPath = join(dir, 'codor.sock');
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

    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });
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
        cwd: testCwd(),
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
    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });
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

  it('rejects attach lease follow-up actions from an administrator in another room', async () => {
    daemon.createRoom({
      id: 'ops',
      name: 'Ops',
      owner: { handle: 'ops-owner', display_name: 'Ops Owner' },
    });
    const agent = daemon.spawnMember('ops', {
      harness: 'fake',
      handle: 'ops-agent',
      cwd: testCwd('ops'),
    });
    fake.enqueue({ kind: 'complete', final_text: '@ops-owner initialized' });
    daemon.postHumanMessage('ops', '@ops-agent initialize');
    await daemon.settle();
    const { lease } = await daemon.acquireAttachLease('ops', agent.id, 4321);
    const futureHeartbeat = Date.now() + 60_000;
    daemon.store.heartbeatAttachLease(lease.id, futureHeartbeat);

    const rejectedAct = async (act: Record<string, unknown>): Promise<ServerFrame> => {
      const client = await connectAs(ADMIN_TOKEN);
      client.ws.send(JSON.stringify({ type: 'act', room: 'eng', act }));
      const error = await client.next((frame) => frame.type === 'error');
      client.ws.close();
      return error;
    };

    await expect(rejectedAct({
      act: 'attach_child',
      lease_id: lease.id,
      child_pid: 987_654_321,
      process_group_id: 987_654_321,
    })).resolves.toMatchObject({ type: 'error', ref: 'act' });
    expect(daemon.store.getAttachLease(lease.id)).toMatchObject({
      room: 'ops',
      child_pid: undefined,
      process_group_id: undefined,
    });

    await expect(rejectedAct({
      act: 'attach_heartbeat',
      lease_id: lease.id,
    })).resolves.toMatchObject({ type: 'error', ref: 'act' });
    expect(daemon.store.getAttachLease(lease.id)?.heartbeat_ts).toBe(futureHeartbeat);

    await expect(rejectedAct({
      act: 'attach_complete',
      lease_id: lease.id,
    })).resolves.toMatchObject({ type: 'error', ref: 'act' });
    expect(daemon.store.getAttachLease(lease.id)).toBeDefined();
    expect(daemon.store.getMember('ops', agent.id)).toMatchObject({ custody: 'mirrored' });
  });

  // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-server-regression
  it('carries member post wait intent through the real socket into only that delivery snapshot', async () => {
    const { agent: alpha, token } = spawnAgentWithToken('posting-alpha');
    const beta = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'posting-beta', cwd: testCwd('posting-beta'),
    });
    daemon.pauseMember('eng', beta.id);
    const client = await connectAs(token);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'post', room: 'eng', body: '@posting-beta blocking question', awaiting_reply: true,
    }));
    const blocking = await client.next((frame) =>
      frame.type === 'message' && frame.message.author === alpha.id && frame.message.body.includes('blocking'));
    const blockingId = blocking.type === 'message' ? blocking.message.id : 0;
    const blockingDelivery = daemon.store.listDeliveries('eng', { recipient: beta.id })
      .find((delivery) => delivery.message_id === blockingId)!;
    expect(JSON.parse(daemon.store.getDeliveryPayloadSnapshot('eng', blockingDelivery.id)!))
      .toMatchObject({ context: { awaitingReply: true } });

    client.ws.send(JSON.stringify({
      type: 'post', room: 'eng', body: '@posting-beta ordinary update',
    }));
    const ordinary = await client.next((frame) =>
      frame.type === 'message' && frame.message.author === alpha.id && frame.message.body.includes('ordinary'));
    const ordinaryId = ordinary.type === 'message' ? ordinary.message.id : 0;
    const ordinaryDelivery = daemon.store.listDeliveries('eng', { recipient: beta.id })
      .find((delivery) => delivery.message_id === ordinaryId)!;
    expect(JSON.parse(daemon.store.getDeliveryPayloadSnapshot('eng', ordinaryDelivery.id)!))
      .not.toHaveProperty('context.awaitingReply');
    client.ws.close();
  });
  // harn:end awaiting-reply-marker-is-delivery-context

  // harn:assume live-delivery-consumption-is-idempotent ref=consumption-server-regression
  it('lets an agent consume only its own queued delivery and returns a projected source message', async () => {
    const { agent: alpha, token: alphaToken } = spawnAgentWithToken('consume-alpha');
    const { token: betaToken } = spawnAgentWithToken('consume-beta');
    daemon.pauseMember('eng', alpha.id);
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const message = daemon.postHumanMessage('eng', `@consume-alpha inspect ${secret}`);
    const delivery = daemon.store.listDeliveries('eng', {
      recipient: alpha.id,
      state: 'queued',
    }).find((item) => item.message_id === message.id)!;

    const alphaClient = await connectAs(alphaToken);
    alphaClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'consume_delivery', delivery_id: delivery.id },
    }));
    const consumed = await alphaClient.next((frame) => frame.type === 'consume_result');
    expect(consumed).toMatchObject({
      type: 'consume_result',
      delivery: { id: delivery.id, recipient: alpha.id, state: 'consumed' },
      message: { id: message.id, body: expect.stringContaining('[redacted]') },
    });
    expect(JSON.stringify(consumed)).not.toContain(secret);
    expect(daemon.store.getMessage('eng', message.id)!.body).toContain(secret);

    alphaClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'consume_delivery', delivery_id: delivery.id },
    }));
    await vi.waitFor(() => {
      expect(alphaClient.frames.filter((frame) => frame.type === 'consume_result')).toHaveLength(2);
    });
    expect(alphaClient.frames.filter((frame) => frame.type === 'consume_result')[1])
      .toEqual(consumed);

    const betaClient = await connectAs(betaToken);
    betaClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'consume_delivery', delivery_id: delivery.id },
    }));
    await expect(betaClient.next((frame) => frame.type === 'error')).resolves.toMatchObject({
      type: 'error', ref: 'act', message: expect.stringContaining('not addressed'),
    });

    const humanClient = await connectAs(MEMBER_TOKEN);
    humanClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'consume_delivery', delivery_id: delivery.id },
    }));
    await expect(humanClient.next((frame) => frame.type === 'error')).resolves.toMatchObject({
      type: 'error', ref: 'act', message: expect.stringContaining('not addressed'),
    });

    alphaClient.ws.close();
    betaClient.ws.close();
    humanClient.ws.close();
  });
  // harn:end live-delivery-consumption-is-idempotent

  // harn:assume live-agent-waits-are-transient ref=wait-server-regression
  it('accepts self waits only from the running agent credential in its own room', async () => {
    const { agent: alpha, token: alphaToken } = spawnAgentWithToken('wait-alpha');
    const { agent: beta } = spawnAgentWithToken('wait-beta');
    daemon.store.updateMember('eng', alpha.id, { state: 'running' });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running',
        started_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: `runs/${String(posted.id)}.jsonl`,
      },
    });
    daemon.createRoom({
      id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' },
    });
    const untilTs = new Date(Date.now() + 60_000).toISOString();

    const agentClient = await connectAs(alphaToken);
    agentClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await agentClient.next((frame) => frame.type === 'sync_complete');
    agentClient.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'wait_begin', reason: 'mention', peers: [beta.id], until_ts: untilTs },
    }));
    await expect(agentClient.next((frame) =>
      frame.type === 'member' && frame.member.id === alpha.id && frame.member.waiting !== undefined))
      .resolves.toMatchObject({
        member: { id: alpha.id, waiting: { reason: 'mention', peers: [beta.id], until_ts: untilTs } },
      });

    const humanClient = await connectAs(MEMBER_TOKEN);
    humanClient.ws.send(JSON.stringify({
      type: 'act',
      room: 'eng',
      act: { act: 'wait_begin', reason: 'any', peers: [beta.id], until_ts: untilTs },
    }));
    await expect(humanClient.next((frame) => frame.type === 'error')).resolves.toMatchObject({
      type: 'error', ref: 'act', message: expect.stringContaining('forbidden'),
    });

    agentClient.ws.send(JSON.stringify({
      type: 'act',
      room: 'other',
      act: { act: 'wait_begin', reason: 'any', peers: [beta.id], until_ts: untilTs },
    }));
    await expect(agentClient.next((frame) => frame.type === 'error')).resolves.toMatchObject({
      type: 'error', ref: 'act', message: expect.stringContaining('belongs to room eng'),
    });

    const beforeEnd = agentClient.frames.length;
    agentClient.ws.send(JSON.stringify({ type: 'act', room: 'eng', act: { act: 'wait_end' } }));
    await vi.waitFor(() => {
      expect(agentClient.frames.slice(beforeEnd).some((frame) =>
        frame.type === 'member' && frame.member.id === alpha.id && frame.member.waiting === undefined))
        .toBe(true);
    });
    expect(daemon.sync('eng', 0).members.find((item) => item.id === alpha.id))
      .not.toHaveProperty('waiting');

    agentClient.ws.close();
    humanClient.ws.close();
  });
  // harn:end live-agent-waits-are-transient

  it('acts flow through: mark_read clears the unread count', async () => {
    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });
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

describe('Phase 3 REST boundaries', () => {
  it('creates derived-id channels with metadata, collision suffixes, and starting agents', async () => {
    const cwd = testCwd('create-project');
    const first = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Demo Site',
        owner: { handle: 'demo-owner', display_name: 'Demo Owner' },
        color: '#d45d5d',
        cwd,
        starting_agent: { harness: 'fake', handle: 'codor' },
      }),
    });
    expect(first.status).toBe(200);
    expect((await first.json() as { room: { id: string; config: { cwd: string; color: string } } }).room)
      .toMatchObject({ id: 'demo-site', config: { cwd, color: '#d45d5d' } });
    expect(daemon.store.getMemberByHandle('demo-site', 'codor')).toBeDefined();

    const second = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Demo Site', owner: { handle: 'second-owner', display_name: 'Second Owner' },
      }),
    });
    expect((await second.json() as { room: { id: string } }).room.id).toBe('demo-site-2');
  });

  it('lists only home-contained directories for admins with precise status codes', async () => {
    mkdirSync(join(dir, 'alpha'));
    mkdirSync(join(dir, '.hidden'));
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'file');
    const outside = mkdtempSync(join(tmpdir(), 'codor-server-outside-'));
    symlinkSync(outside, join(dir, 'escape'));
    try {
      const listed = await fetch(`${base}/api/local/dirs`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(listed.status).toBe(200);
      const listing = await listed.json() as {
        path: string; parent: string | null; dirs: { name: string; path: string }[];
      };
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBeNull();
      expect(listing.dirs.some((entry) => entry.name === 'alpha')).toBe(true);
      expect(listing.dirs.some((entry) => entry.name === '.hidden')).toBe(false);

      expect((await fetch(`${base}/api/local/dirs`, {
        headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      })).status).toBe(403);
      for (const [path, status] of [
        [outside, 403],
        [join(dir, 'escape'), 403],
        [file, 400],
        [join(dir, 'missing'), 404],
        ['relative', 400],
      ] as const) {
        const response = await fetch(`${base}/api/local/dirs?path=${encodeURIComponent(path)}`, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(response.status, path).toBe(status);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects bad member cwd before the adapter and stores expanded REST cwd', async () => {
    const spawn = vi.spyOn(fake, 'spawn');
    const missing = join(dir, 'missing-member-cwd');
    const rejected = await fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'fake', handle: 'bad-cwd', cwd: missing }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: `Error: working directory ${missing} does not exist` });
    expect(spawn).not.toHaveBeenCalled();

    mkdirSync(join(dir, 'cwd'));
    const accepted = await fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'fake', handle: 'good-cwd', cwd: '~/cwd' }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as Member).cwd).toBe(join(dir, 'cwd'));
  });

  it('keeps tailnet enrollment off by default and enrolls ordinary revocable devices when enabled', async () => {
    const device = new CryptoVault(join(dir, 'tailnet-device'));
    const request = { ...device.keys.publicIdentity(), kind: 'device', label: 'client label' };
    const off = await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Tailscale-User-Login': 'operator@example.com',
      },
      body: JSON.stringify(request),
    });
    expect(off.status).toBe(401);

    await server.close();
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
      trustTailscaleServe: true,
      homeDir: dir,
    });
    base = `http://127.0.0.1:${server.port}`;
    const on = await fetch(`${base}/api/pairing/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Tailscale-User-Login': 'operator@example.com',
      },
      body: JSON.stringify(request),
    });
    expect(on.status).toBe(200);
    expect(crypto.keys.getPeer(device.keys.identity.device_id)).toMatchObject({
      kind: 'device', label: 'operator@example.com',
    });

    const revoked = await fetch(`${base}/api/devices/${encodeURIComponent(device.keys.identity.device_id)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect(crypto.keys.getPeer(device.keys.identity.device_id)).toBeUndefined();
    device.close();
  });

  // harn:assume unpaired-browser-always-has-enrollment-path ref=trusted-pairing-status-regression
  it('reports trusted enrollment availability without leaking the tailnet identity', async () => {
    const headers = { 'Tailscale-User-Login': 'operator@example.com' };
    const off = await fetch(`${base}/api/pairing/status`, { headers });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ trusted_enrollment: false });

    await server.close();
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
      trustTailscaleServe: true,
      homeDir: dir,
    });
    base = `http://127.0.0.1:${server.port}`;

    const missingIdentity = await fetch(`${base}/api/pairing/status`);
    expect(missingIdentity.status).toBe(200);
    expect(await missingIdentity.json()).toEqual({ trusted_enrollment: false });

    const on = await fetch(`${base}/api/pairing/status`, { headers });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ trusted_enrollment: true });
  });
  // harn:end unpaired-browser-always-has-enrollment-path
});

// harn:assume rail-summary-served-not-guessed ref=rooms-summary-rest
describe('rooms summary', () => {
  it('serves preview, working, attention, and cursor-driven unread per readable room', async () => {
    daemon.postHumanMessage('eng', 'first message');
    const latest = daemon.postHumanMessage('eng', 'the newest line\nsecond line never previews');
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'railbot', cwd: testCwd('railbot'),
    });
    const otherAgent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'other-railbot', cwd: testCwd('other-railbot'),
    });

    const summaryOf = async (query = '') => {
      const res = await fetch(`${base}/api/rooms/summary${query}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { rooms: {
        id: string; working: boolean; attention: boolean; unread: number;
        latest?: { id: number; author_handle: string; preview: string };
      }[] };
      const eng = body.rooms.find((room) => room.id === 'eng');
      if (!eng) throw new Error('eng missing from summary');
      return eng;
    };

    const idle = await summaryOf();
    expect(idle.latest?.id).toBe(latest.id);
    expect(idle.latest?.author_handle).toBe('richard');
    expect(idle.latest?.preview).toBe('the newest line');
    expect(idle.working).toBe(false);
    expect(idle.attention).toBe(false);
    expect(idle.unread).toBe(0); // no cursor -> no invented read state

    expect((await summaryOf(`?cursors=eng:${latest.id - 1}`)).unread).toBe(1);
    expect((await summaryOf(`?cursors=eng:${latest.id}`)).unread).toBe(0);

    daemon.store.updateMember('eng', agent.id, { state: 'running' });
    expect((await summaryOf()).working).toBe(true);
    daemon.store.updateMember('eng', agent.id, { state: 'dead' });
    expect((await summaryOf()).attention).toBe(false); // a dormant corpse alone is not attention-worthy

    const started = new Date().toISOString();
    daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'the run failed',
      run: {
        status: 'failed', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/railbot-failed.jsonl', final_text: 'the run failed',
      },
    });
    expect((await summaryOf()).attention).toBe(true);

    daemon.store.updateMember('eng', otherAgent.id, { state: 'queued' });
    const working = await summaryOf();
    expect(working.working).toBe(true);
    expect(working.attention).toBe(false);
    daemon.store.updateMember('eng', otherAgent.id, { state: 'idle' });
    expect((await summaryOf()).attention).toBe(true);

    daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'the retry succeeded',
      run: {
        status: 'completed', started_ts: started, ended_ts: new Date().toISOString(),
        tool_calls: 0, events_ref: 'runs/railbot-completed.jsonl', final_text: 'the retry succeeded',
      },
    });
    expect((await summaryOf()).attention).toBe(false);

    daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '<ACK_OK>',
      ack: true,
      run: {
        status: 'completed', started_ts: started, ended_ts: new Date().toISOString(),
        tool_calls: 0, events_ref: 'runs/railbot-ack.jsonl', final_text: '<ACK_OK>',
      },
    });
    const afterAck = await summaryOf();
    expect(afterAck.latest?.preview).toBe('the retry succeeded');
    expect(afterAck.unread).toBe(0);
  });

  it('shows an agent principal only its own room', async () => {
    daemon.createRoom({
      id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' },
    });
    const { token } = spawnAgentWithToken('summary-agent');
    const res = await fetch(`${base}/api/rooms/summary`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rooms: { id: string }[] };
    expect(body.rooms.map((room) => room.id)).toEqual(['eng']);
  });

  it('rejects malformed cursors with 400', async () => {
    for (const bad of ['?cursors=eng', '?cursors=eng:abc', '?cursors=:7', '?cursors=eng:-1']) {
      const res = await fetch(`${base}/api/rooms/summary${bad}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(400);
    }
  });
});
// harn:end rail-summary-served-not-guessed

describe('git working state endpoint (room-git-state-read-only-from-known-cwds)', () => {
  const initRepo = (): string => {
    const repo = testCwd('gitrepo');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
    };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\nconst b = 2;\n'); // a working change
    return repo;
  };

  it('returns the live working state to an authenticated reader', async () => {
    const repo = initRepo();
    daemon.configureRoom('eng', { cwd: repo });
    const res = await fetch(`${base}/api/rooms/eng/git-diff`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      clean: boolean; cwds: string[]; files: { path: string; status: string }[];
    };
    expect(body.clean).toBe(false);
    expect(body.cwds).toContain(resolve(repo));
    expect(body.files.map((file) => file.path)).toContain('app.ts');
  });

  it('refuses an anonymous request', async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    expect((await fetch(`${base}/api/rooms/eng/git-diff`)).status).toBe(401);
  });

  it("refuses a cwd outside the room's known set", async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    const res = await fetch(`${base}/api/rooms/eng/git-diff?cwd=${encodeURIComponent('/etc')}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('message attachment endpoints (attachments-are-capped-files-served-inert)', () => {
  const upload = (
    room: string,
    name: string,
    body: Buffer | string,
    opts: { token?: string; mime?: string } = {},
  ): Promise<Response> =>
    fetch(`${base}/api/rooms/${room}/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        ...(opts.token !== undefined && { authorization: `Bearer ${opts.token}` }),
        'content-type': opts.mime ?? 'application/octet-stream',
      },
      body,
    });

  it('uploads a file and serves it back to an authenticated reader', async () => {
    const res = await upload('eng', 'note.txt', 'hello attachments', { token: TOKEN, mime: 'text/plain' });
    expect(res.status).toBe(200);
    const meta = await res.json() as { id: string; name: string; mime: string; size: number };
    expect(meta).toMatchObject({ name: 'note.txt', mime: 'text/plain', size: 17 });
    expect(meta.id).toMatch(/^[0-9a-f]{32}$/);

    const got = await fetch(`${base}/api/rooms/eng/attachments/${meta.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(got.status).toBe(200);
    // Non-raster mimes serve inert: the stored mime lives in metadata only.
    expect(got.headers.get('content-type')).toContain('application/octet-stream');
    expect(await got.text()).toBe('hello attachments');
  });

  it('serves raster images inline but every scriptable type as an inert download', async () => {
    const serve = async (name: string, body: string, mime: string) => {
      const meta = await (await upload('eng', name, body, { token: TOKEN, mime })).json() as { id: string };
      return fetch(`${base}/api/rooms/eng/attachments/${meta.id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    };

    const png = await serve('pixel.png', 'not-really-png-bytes', 'image/png');
    expect(png.headers.get('content-type')).toContain('image/png');
    expect(png.headers.get('content-disposition')).toContain('inline');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');

    // An uploaded html document must never render same-origin.
    const html = await serve('evil.html', '<script>fetch("/api")</script>', 'text/html');
    expect(html.headers.get('content-type')).toContain('application/octet-stream');
    expect(html.headers.get('content-disposition')).toContain('attachment');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');

    // svg is an image type that scripts — it is NOT in the inline set.
    const svg = await serve('sneaky.svg', '<svg onload="alert(1)"/>', 'image/svg+xml');
    expect(svg.headers.get('content-type')).toContain('application/octet-stream');
    expect(svg.headers.get('content-disposition')).toContain('attachment');
  });

  it('refuses anonymous upload and download', async () => {
    expect((await upload('eng', 'x.txt', 'hi')).status).toBe(401);
    const meta = await (await upload('eng', 'y.txt', 'hi', { token: TOKEN })).json() as { id: string };
    expect((await fetch(`${base}/api/rooms/eng/attachments/${meta.id}`)).status).toBe(401);
  });

  it('refuses a file over the 25 MB cap', async () => {
    const res = await upload('eng', 'big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024), { token: TOKEN });
    expect(res.status).toBe(413);
  });

  it('does not serve one room\'s attachment id from another room', async () => {
    daemon.createRoom({ id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' } });
    const meta = await (await upload('eng', 'z.txt', 'secret', { token: TOKEN })).json() as { id: string };
    const cross = await fetch(`${base}/api/rooms/other/attachments/${meta.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cross.status).toBe(404);
  });

  it('refuses a post referencing an unknown id, over the cap, or with nothing at all', async () => {
    const client = await connectAs(TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    // Unknown id (also the shape of a cross-room id): refused at post time.
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: 'x', attachments: ['a'.repeat(32)] }));
    expect((await client.next((frame) => frame.type === 'error')).type).toBe('error');

    // Over the 8-file cap: refused by the frame schema.
    const ids = Array.from({ length: 9 }, (_, i) => `id-${String(i)}`);
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: 'x', attachments: ids }));
    expect((await client.next((frame) => frame.type === 'error')).type).toBe('error');

    // Neither body nor attachments: refused server-side.
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: '   ' }));
    expect((await client.next((frame) => frame.type === 'error')).type).toBe('error');

    client.ws.close();
  });
});

// harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-server-regression
describe('room-addressed multiplexed subscriptions', () => {
  const createOtherRoom = () => daemon.createRoom({
    id: 'other', name: 'Other', owner: { handle: 'other-owner', display_name: 'Other Owner' },
  });

  it('attributes two addressed room hydrations, distinct selves, and live member fan-out on one socket', async () => {
    createOtherRoom();
    const client = await connect();

    client.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0, room_addressed: true,
    }));
    await client.next((frame) => frame.type === 'sync_complete' && frame.room === 'eng');
    client.ws.send(JSON.stringify({
      type: 'subscribe', room: 'other', since_seq: 0, room_addressed: true,
    }));
    await client.next((frame) => frame.type === 'sync_complete' && frame.room === 'other');

    const selves = client.frames.filter(
      (frame): frame is Extract<ServerFrame, { type: 'self' }> => frame.type === 'self',
    );
    expect(selves).toEqual(expect.arrayContaining([
      { type: 'self', room: 'eng', member_id: daemon.ownerOf('eng').id },
      { type: 'self', room: 'other', member_id: daemon.ownerOf('other').id },
    ]));
    expect(daemon.ownerOf('eng').id).not.toBe(daemon.ownerOf('other').id);
    expect(client.frames
      .filter((frame) => frame.type === 'member')
      .every((frame) => frame.room === 'eng' || frame.room === 'other')).toBe(true);

    const engLive = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'eng-live', cwd: testCwd('eng-live'),
    });
    const otherLive = daemon.spawnMember('other', {
      harness: 'fake', handle: 'other-live', cwd: testCwd('other-live'),
    });
    await expect(client.next((frame) =>
      frame.type === 'member' && frame.member.id === engLive.id && frame.room === 'eng'))
      .resolves.toBeDefined();
    await expect(client.next((frame) =>
      frame.type === 'member' && frame.member.id === otherLive.id && frame.room === 'other'))
      .resolves.toBeDefined();
    client.ws.close();
  });

  it('keeps capability state per room and preserves legacy frames on the same socket', async () => {
    createOtherRoom();
    const client = await connect();

    client.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0, room_addressed: true,
    }));
    await client.next((frame) => frame.type === 'sync_complete' && frame.room === 'eng');
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'other', since_seq: 0 }));
    const legacyComplete = await client.next(
      (frame) => frame.type === 'sync_complete' && !('room' in frame),
    );

    const legacySelf = client.frames.find(
      (frame) => frame.type === 'self' && frame.member_id === daemon.ownerOf('other').id,
    );
    expect(legacySelf).toEqual({ type: 'self', member_id: daemon.ownerOf('other').id });
    expect(legacyComplete).toEqual({
      type: 'sync_complete', seq: daemon.store.currentSeq('other'),
    });
    const otherHydratedMembers = client.frames.filter((frame) =>
      frame.type === 'member' && frame.seq === 0 && frame.member.id === daemon.ownerOf('other').id);
    expect(otherHydratedMembers).toHaveLength(1);
    expect(otherHydratedMembers[0]).not.toHaveProperty('room');

    const engLive = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'eng-mixed-live', cwd: testCwd('eng-mixed-live'),
    });
    const otherLive = daemon.spawnMember('other', {
      harness: 'fake', handle: 'other-mixed-live', cwd: testCwd('other-mixed-live'),
    });
    const addressed = await client.next((frame) =>
      frame.type === 'member' && frame.member.id === engLive.id);
    const legacy = await client.next((frame) =>
      frame.type === 'member' && frame.member.id === otherLive.id);
    expect(addressed).toHaveProperty('room', 'eng');
    expect(legacy).not.toHaveProperty('room');
    client.ws.close();
  });
});
// harn:end multiplexed-subscriptions-identify-their-room

describe('bounded cold hydration (subscribe)', () => {
  const seedTail = (count: number): number[] => {
    const owner = daemon.ownerOf('eng');
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: `m${String(i)}` }).id);
    }
    return ids;
  };

  it('honours a hydrate limit and stamps the served floor on sync_complete', async () => {
    const ids = seedTail(30);
    const client = await connectAs(TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0, hydrate_limit: 5 }));
    const complete = await client.next((frame) => frame.type === 'sync_complete');

    const messages = client.frames.filter((frame) => frame.type === 'message');
    expect(messages.length).toBeLessThan(30); // bounded, not the whole room
    expect(messages.length).toBeGreaterThanOrEqual(5); // the tail at least
    expect(complete).toHaveProperty('history_floor', ids.slice(-5)[0]);
    client.ws.close();
  });

  it('replays everything for a subscriber that sends no limit', async () => {
    const ids = seedTail(30);
    const client = await connectAs(TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    const complete = await client.next((frame) => frame.type === 'sync_complete');

    const seen = client.frames
      .filter((frame): frame is Extract<ServerFrame, { type: 'message' }> => frame.type === 'message')
      .map((frame) => frame.message.id);
    for (const id of ids) expect(seen).toContain(id); // byte-identical replay
    expect(complete).not.toHaveProperty('history_floor');
    client.ws.close();
  });
});

describe('compact_member act (manual-compaction-is-an-operator-act)', () => {
  it('an owner compacts an idle agent and the re-baseline reaches subscribers', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'compactable', cwd: testCwd('compactable'),
    });
    fake.compactUsage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 7_500 };
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'compact_member', member_id: agent.id },
    }));

    // The ring updates from the member frame the re-baseline rides out on.
    const framed = await client.next((frame) =>
      frame.type === 'member' &&
      frame.member.id === agent.id &&
      frame.member.lastUsage?.contextWindowUsedTokens === 7_500);
    expect(framed).toMatchObject({ type: 'member' });
    expect(fake.compactions).toHaveLength(1);
    client.ws.close();
  });

  it('refuses a non-privileged principal with an error frame, never touching the engine', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'untouchable', cwd: testCwd('untouchable'),
    });
    const client = await connectAs(OBSERVER_TOKEN);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'compact_member', member_id: agent.id },
    }));
    expect(await client.next((frame) => frame.type === 'error'))
      .toMatchObject({ type: 'error', ref: 'act' });
    expect(fake.compactions).toHaveLength(0);
    client.ws.close();
  });
});
