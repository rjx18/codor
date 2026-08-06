import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  BROWSER_PROTOCOL_EPOCH,
  VoiceTranscribeError,
  type Member,
  type ServerFrame,
  type Session,
  type SpawnOpts,
} from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { VoiceProviderDefinition } from './voice-providers.js';

import { Daemon, MAX_ATTACHMENT_BYTES } from './daemon.js';
import { BlobStore } from './blobs.js';
import { signChallenge, type AuthChallenge } from './crypto/challenge.js';
import { CryptoVault, PAIRING_CODE_ALPHABET } from './crypto/pairing.js';
import { openSealedBox } from './crypto/roomkeys.js';
import { FakeAdapter } from './fake-adapter.js';
import { LedgerManager } from './ledger/watch.js';
import { isPipePath, localSocketPath } from './local-socket.js';
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
let fakeInstalled: boolean;

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
  fakeInstalled = true;
  fake = new FakeAdapter('fake', { interactiveAttach: true });
  Object.assign(fake, { executable: 'fake' });
  daemon = new Daemon({
    dbPath: join(dir, 'db.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
    ledger: new LedgerManager({ dataDir: dir }),
    homeDir: dir,
    executableOnPath: () => fakeInstalled,
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
    systemHostname: `  Work Station / East ${'x'.repeat(80)}  `,
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
    client.ws.send(JSON.stringify({
      type: 'list_rooms', all: true, ref: 'agent-list',
    }));
    expect(await client.next((frame) => frame.type === 'rooms' && frame.ref === 'agent-list'))
      .toMatchObject({ type: 'rooms', ref: 'agent-list', rooms: [{ id: 'eng' }] });
    for (const [ref, frame] of [
      ['agent-create', {
        type: 'create_room', ref: 'agent-create',
        request: { name: 'Forbidden', owner: { handle: 'richard', display_name: 'Richard' } },
      }],
      ['agent-rename', {
        type: 'act', room: 'eng', ref: 'agent-rename', act: { act: 'rename_room', name: 'Nope' },
      }],
      ['agent-archive', {
        type: 'act', room: 'eng', ref: 'agent-archive', act: { act: 'archive_room' },
      }],
    ] as const) {
      client.ws.send(JSON.stringify(frame));
      expect(await client.next((candidate) => candidate.type === 'error' && candidate.ref === ref))
        .toMatchObject({ type: 'error', ref });
    }
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
    const socketPath = localSocketPath(dir);
    await server.close();
    server = await startServer({ daemon, token: TOKEN, socketPath, crypto, pushSubscriptions });

    const agentClient = await connectUrl(localWsUrl(socketPath, `/ws?token=${agentToken}`));
    agentClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await agentClient.next((frame) => frame.type === 'self'))
      .toEqual({ type: 'self', member_id: agent.id });
    agentClient.ws.close();

    const ownerClient = await connectUrl(localWsUrl(socketPath, '/ws'));
    ownerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await ownerClient.next((frame) => frame.type === 'self'))
      .toEqual({ type: 'self', member_id: daemon.ownerOf('eng').id });
    ownerClient.ws.close();
  });
});
// harn:end agent-network-authority-is-narrow
// harn:end agent-member-credentials-stay-secret

// harn:assume management-frames-correlate-one-result ref=management-correlation-server-regression
// harn:assume channel-archive-is-durable-soft-state ref=channel-archive-server-regression
describe('correlated channel management over WebSocket', () => {
  it('ignores unrelated room results, creates, renames, archives, and filters discovery', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'unrelated-list' }));
    client.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'target-list' }));
    const listed = await client.next((frame) => frame.type === 'rooms' && frame.ref === 'target-list');
    expect(listed).toMatchObject({ type: 'rooms', ref: 'target-list', rooms: [{ id: 'eng' }] });
    expect(client.frames.some((frame) => frame.type === 'rooms' && frame.ref === 'unrelated-list')).toBe(true);

    client.ws.send(JSON.stringify({
      type: 'create_room',
      ref: 'create-channel',
      request: {
        id: 'new-channel',
        name: 'New Channel',
        owner: { handle: 'richard', display_name: 'Richard' },
        cwd: testCwd('new-channel'),
      },
    }));
    const created = await client.next((frame) => frame.type === 'room' && frame.ref === 'create-channel');
    expect(created).toMatchObject({
      type: 'room', ref: 'create-channel', room: { id: 'new-channel', name: 'New Channel' },
    });

    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'new-channel', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');
    client.ws.send(JSON.stringify({
      type: 'act', room: 'new-channel', ref: 'rename-channel',
      act: { act: 'rename_room', name: 'Renamed Channel' },
    }));
    const renamed = await client.next((frame) => frame.type === 'room' && frame.ref === 'rename-channel');
    expect(renamed).toMatchObject({
      type: 'room', ref: 'rename-channel', room: { name: 'Renamed Channel' },
    });

    const owner = daemon.ownerOf('new-channel');
    const member = daemon.store.addMember('new-channel', {
      kind: 'agent', handle: 'kept-agent', display_name: 'Kept Agent', state: 'idle',
    });
    const message = daemon.store.postMessage('new-channel', {
      author: owner.id, kind: 'chat', body: 'kept message',
    });
    client.ws.send(JSON.stringify({
      type: 'act', room: 'new-channel', ref: 'archive-channel', act: { act: 'archive_room' },
    }));
    const archived = await client.next((frame) => frame.type === 'room' && frame.ref === 'archive-channel');
    expect(archived).toMatchObject({
      type: 'room', ref: 'archive-channel', room: { config: { archived_ts: expect.any(String) } },
    });
    expect(daemon.store.getMember('new-channel', member.id)).toBeDefined();
    expect(daemon.store.getMessage('new-channel', message.id)?.body).toBe('kept message');

    client.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'active-list' }));
    const active = await client.next((frame) => frame.type === 'rooms' && frame.ref === 'active-list');
    expect(active.type === 'rooms' && active.rooms.some((room) => room.id === 'new-channel')).toBe(false);
    client.ws.send(JSON.stringify({ type: 'list_rooms', all: true, ref: 'all-list' }));
    const all = await client.next((frame) => frame.type === 'rooms' && frame.ref === 'all-list');
    expect(all.type === 'rooms' && all.rooms.map((room) => room.id)).toContain('new-channel');
    client.ws.close();
  });

  it('owner-gates channel mutation while preserving read/list access', async () => {
    const created = daemon.store.getRoom('eng')!;
    const ownerClient = await connect();
    ownerClient.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'owner-list', all: true }));
    expect(await ownerClient.next((frame) => frame.type === 'rooms' && frame.ref === 'owner-list'))
      .toMatchObject({ type: 'rooms', ref: 'owner-list' });

    const adminClient = await connectAs(ADMIN_TOKEN);
    adminClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'admin-rename', act: { act: 'rename_room', name: 'Nope' },
    }));
    expect(await adminClient.next((frame) => frame.type === 'error' && frame.ref === 'admin-rename'))
      .toMatchObject({ type: 'error', ref: 'admin-rename', message: expect.stringContaining('cannot rename room') });

    const memberClient = await connectAs(MEMBER_TOKEN);
    memberClient.ws.send(JSON.stringify({ type: 'list_rooms', ref: 'member-list' }));
    expect(await memberClient.next((frame) => frame.type === 'rooms' && frame.ref === 'member-list'))
      .toMatchObject({ type: 'rooms', ref: 'member-list' });
    memberClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'member-archive', act: { act: 'archive_room' },
    }));
    expect(await memberClient.next((frame) => frame.type === 'error' && frame.ref === 'member-archive'))
      .toMatchObject({ type: 'error', ref: 'member-archive' });

    const observerClient = await connectAs(OBSERVER_TOKEN);
    observerClient.ws.send(JSON.stringify({
      type: 'create_room', ref: 'observer-create',
      request: { name: 'Forbidden', owner: { handle: 'richard', display_name: 'Richard' } },
    }));
    expect(await observerClient.next((frame) => frame.type === 'error' && frame.ref === 'observer-create'))
      .toMatchObject({ type: 'error', ref: 'observer-create' });
    expect(daemon.store.getRoom('eng')).toEqual(created);

    ownerClient.ws.close();
    adminClient.ws.close();
    memberClient.ws.close();
    observerClient.ws.close();
  });
});
// harn:end channel-archive-is-durable-soft-state
// harn:end management-frames-correlate-one-result

// harn:assume agent-management-correlates-safe-member-results ref=agent-management-server-regression
// harn:assume agent-add-selects-public-adapter-or-detached-preset ref=agent-add-server-regression
// harn:assume agent-pause-refuses-active-turn ref=agent-pause-server-regression
// harn:assume roles-gate-human-acts-not-agents ref=role-matrix-integration
// harn:assume agent-network-authority-is-narrow ref=agent-room-authorization
describe('correlated agent management over WebSocket', () => {
  it('correlates lifecycle results, gates mutations, and keeps admin state inert', async () => {
    const owner = await connect();
    const cwd = testCwd('structured-agent');
    const deliveriesBefore = fake.deliveries.length;
    owner.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await owner.next((frame) => frame.type === 'sync_complete');
    owner.ws.send(JSON.stringify({ type: 'list_agents', room: 'eng', ref: 'agent-list-empty' }));
    expect(await owner.next((frame) => frame.type === 'agents' && frame.ref === 'agent-list-empty'))
      .toMatchObject({ type: 'agents', room: 'eng', agents: [], ref: 'agent-list-empty' });

    owner.ws.send(JSON.stringify({
      type: 'add_agent', room: 'eng', ref: 'agent-add', adapter: 'fake',
      handle: 'worker', cwd, policy: 'read-only',
    }));
    const added = await owner.next((frame) => frame.type === 'member' && frame.ref === 'agent-add');
    expect(added).toMatchObject({ type: 'member', room: 'eng', ref: 'agent-add', member: {
      kind: 'agent', handle: 'worker', harness: 'fake', state: 'idle', policy: 'read-only',
    } });
    if (added.type !== 'member') throw new Error('missing correlated member');
    const agentId = added.member.id;

    owner.ws.send(JSON.stringify({ type: 'list_agents', room: 'eng', ref: 'agent-list' }));
    const listed = await owner.next((frame) => frame.type === 'agents' && frame.ref === 'agent-list');
    expect(listed).toMatchObject({ type: 'agents', agents: [{ id: agentId, handle: 'worker' }] });
    expect(owner.frames.some((frame) => frame.type === 'member' && frame.ref === undefined)).toBe(true);

    for (const [ref, act, expected] of [
      ['agent-configure', { act: 'configure', member_id: agentId, model: 'safe-model' }, { model: 'safe-model' }],
      ['agent-rename', { act: 'rename', member_id: agentId, handle: 'worker-renamed' }, { handle: 'worker-renamed' }],
      ['agent-pause', { act: 'pause', member_id: agentId }, { state: 'paused' }],
      ['agent-revive', { act: 'revive', member_id: agentId }, { state: 'idle' }],
    ] as const) {
      owner.ws.send(JSON.stringify({ type: 'act', room: 'eng', ref, act }));
      expect(await owner.next((frame) => frame.type === 'member' && frame.ref === ref))
        .toMatchObject({ type: 'member', ref, member: expected });
    }

    const memberClient = await connectAs(MEMBER_TOKEN);
    memberClient.ws.send(JSON.stringify({ type: 'list_agents', room: 'eng', ref: 'member-list' }));
    expect(await memberClient.next((frame) => frame.type === 'agents' && frame.ref === 'member-list'))
      .toMatchObject({ type: 'agents', ref: 'member-list' });
    memberClient.ws.send(JSON.stringify({
      type: 'add_agent', room: 'eng', ref: 'member-add', adapter: 'fake', handle: 'member-agent', cwd,
    }));
    expect(await memberClient.next((frame) => frame.type === 'error' && frame.ref === 'member-add'))
      .toMatchObject({ type: 'error', ref: 'member-add', message: expect.stringContaining('manage agents') });

    const observerClient = await connectAs(OBSERVER_TOKEN);
    observerClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'observer-pause', act: { act: 'pause', member_id: agentId },
    }));
    expect(await observerClient.next((frame) => frame.type === 'error' && frame.ref === 'observer-pause'))
      .toMatchObject({ type: 'error', ref: 'observer-pause' });

    const adminClient = await connectAs(ADMIN_TOKEN);
    adminClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'admin-configure',
      act: { act: 'configure', member_id: agentId, model: 'admin-model' },
    }));
    expect(await adminClient.next((frame) => frame.type === 'member' && frame.ref === 'admin-configure'))
      .toMatchObject({ type: 'member', ref: 'admin-configure', member: { id: agentId, model: 'admin-model' } });

    let agentSession: Session | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    vi.spyOn(fake, 'spawn').mockImplementationOnce((opts: SpawnOpts) => {
      agentSession = originalSpawn(opts);
      return agentSession;
    });
    const principalAgent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'principal-agent', cwd: testCwd('principal-agent'),
    });
    const principalToken = agentSession!.env!.CODOR_MEMBER_TOKEN!;
    const agentClient = await connectAs(principalToken);
    agentClient.ws.send(JSON.stringify({ type: 'list_agents', room: 'eng', ref: 'principal-list' }));
    expect(await agentClient.next((frame) => frame.type === 'agents' && frame.ref === 'principal-list'))
      .toMatchObject({ type: 'agents', ref: 'principal-list' });
    daemon.createRoom({ id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' } });
    agentClient.ws.send(JSON.stringify({ type: 'list_agents', room: 'other', ref: 'cross-room-list' }));
    expect(await agentClient.next((frame) => frame.type === 'error' && frame.ref === 'cross-room-list'))
      .toMatchObject({ type: 'error', ref: 'cross-room-list' });
    agentClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'principal-remove', act: { act: 'remove', member_id: agentId },
    }));
    expect(await agentClient.next((frame) => frame.type === 'error' && frame.ref === 'principal-remove'))
      .toMatchObject({ type: 'error', ref: 'principal-remove' });

    owner.ws.send(JSON.stringify({
      type: 'act', room: 'eng', ref: 'agent-remove', act: { act: 'remove', member_id: agentId },
    }));
    expect(await owner.next((frame) => frame.type === 'member' && frame.ref === 'agent-remove'))
      .toMatchObject({ type: 'member', ref: 'agent-remove', member: { removed_ts: expect.any(String), state: 'dead' } });
    owner.ws.send(JSON.stringify({ type: 'list_agents', room: 'eng', ref: 'agent-list-after-remove' }));
    expect(await owner.next((frame) => frame.type === 'agents' && frame.ref === 'agent-list-after-remove'))
      .toMatchObject({ type: 'agents', agents: [{ handle: 'principal-agent' }] });
    expect(fake.deliveries.length).toBe(deliveriesBefore);

    owner.ws.close();
    adminClient.ws.close();
    memberClient.ws.close();
    observerClient.ws.close();
    agentClient.ws.close();
    expect(principalAgent.kind).toBe('agent');
  });
});
// harn:end agent-network-authority-is-narrow
// harn:end roles-gate-human-acts-not-agents
// harn:end agent-pause-refuses-active-turn
// harn:end agent-add-selects-public-adapter-or-detached-preset
// harn:end agent-management-correlates-safe-member-results

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

const localWsUrl = (socketPath: string, suffix: string): string =>
  `${isPipePath(socketPath) ? 'ws+unix:///' : 'ws+unix://'}${socketPath}:${suffix}`;

function connectUrl(url: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; next: (pred: (f: ServerFrame) => boolean) => Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const wsOptions: WebSocket.ClientOptions = {};
    if (url.includes('\\\\.\\pipe\\')) {
      wsOptions.createConnection = (connectOptions) => {
        const normalized = {
          ...(connectOptions as unknown as Record<string, unknown>),
        };
        for (const key of ['socketPath', 'path']) {
          const value = normalized[key];
          if (typeof value === 'string' && value.startsWith('/\\\\.\\pipe\\')) {
            normalized[key] = value.slice(1);
          }
        }
        return netConnect(normalized as never);
      };
    }
    const ws = new WebSocket(url, wsOptions);
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
  expect(offered).not.toHaveProperty('hostname');
  const sessionResponse = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge_id: offered.challenge.challenge_id,
      signature: signChallenge(offered.challenge, device.keys.identity),
    }),
  });
  expect(sessionResponse.status).toBe(200);
  const session = (await sessionResponse.json()) as { access_token: string; hostname?: string };
  expect(session.hostname).toBe(`Work-Station-East-${'x'.repeat(45)}`);
  expect(session.hostname).toHaveLength(63);
  return session.access_token;
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

  it('reveals a bounded hostname only after a successful signed browser session', async () => {
    const challenge = await fetch(`${base}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: 'not-paired' }),
    });
    expect(challenge.status).toBe(401);
    expect(await challenge.json()).not.toHaveProperty('hostname');

    const refused = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge_id: 'missing', signature: 'bad' }),
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).not.toHaveProperty('hostname');
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
      run: {
        status: 'running', started_ts: started, tool_calls: 0,
        events_ref: 'runs/outbound.jsonl', output_mode: 'messages',
      },
    });
    const continuation = daemon.store.createRunContinuation('eng', run.id);
    const afterRun = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'After run' });

    const blocked = (await (await request(
      `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(enabled.after)}`,
    )).json()) as { messages: { id: number; body: string }[]; next_after: number };
    expect(blocked.messages.map((message) => message.body)).toEqual(['Before run']);
    expect(blocked.next_after).toBe(local.id);

    daemon.store.updateMessage('eng', run.id, {
      body: 'First agent stretch',
      run: {
        status: 'completed',
        started_ts: started,
        ended_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: 'runs/outbound.jsonl',
        final_text: 'First agent stretchSecond agent stretch',
        output_mode: 'messages',
        result_message_id: continuation.id,
      },
    });
    daemon.store.updateMessage('eng', continuation.id, { body: 'Second agent stretch' });
    const ready = (await (await request(
      `/api/rooms/eng/bridges/${enabled.member.id}/outbound?after=${String(blocked.next_after)}`,
    )).json()) as { messages: { id: number; body: string }[]; next_after: number };
    expect(ready.messages.map((message) => message.body)).toEqual([
      'First agent stretch', 'Second agent stretch', 'After run',
    ]);
    expect(ready.messages.map((message) => message.id))
      .toEqual([run.id, continuation.id, afterRun.id]);

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
    expect(completed).not.toHaveProperty('hostname');
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
      adapters: [{ id: 'fake', installed: true, capabilities: { resume: true } }],
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

  // harn:assume adapter-refresh-is-authorized-and-incremental ref=adapter-refresh-rest
  // harn:assume new-agent-requests-require-available-native-or-detected-acp ref=new-agent-provider-availability-regression
  it('authorizes refresh and rejects stale spawn and starting-agent requests', async () => {
    const postRefresh = (token: string) => fetch(`${base}/api/adapters/refresh`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    expect((await postRefresh(MEMBER_TOKEN)).status).toBe(403);
    expect((await postRefresh(OBSERVER_TOKEN)).status).toBe(403);
    expect((await postRefresh(ADMIN_TOKEN)).status).toBe(200);

    fakeInstalled = false;
    const refreshed = await postRefresh(TOKEN);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ adapters: [{ id: 'fake', installed: false }] });

    const spawn = await fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'fake', handle: 'stale', cwd: testCwd('stale-spawn') }),
    });
    expect(spawn.status).toBe(400);

    const create = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'stale-create', name: 'Stale Create',
        owner: { handle: 'stale-owner', display_name: 'Stale Owner' }, cwd: testCwd('stale-create'),
        starting_agent: { harness: 'fake', handle: 'stale' },
      }),
    });
    expect(create.status).toBe(400);
    expect(daemon.store.getRoom('stale-create')).toBeUndefined();

    // A named provider id on a NON-acp harness is refused at the boundary, before persistence.
    const nativeWithProvider = await fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: 'fake', handle: 'wrong', cwd: testCwd('wrong'), acp_provider: 'kimi',
      }),
    });
    expect(nativeWithProvider.status).toBe(400);
    expect(await nativeWithProvider.text()).toContain('only for the acp harness');
    expect(daemon.store.listMembers('eng').some((m) => m.handle === 'wrong')).toBe(false);
  });

  // harn:assume acp-launch-is-structured-authorized-and-bounded ref=acp-launch-regression
  it('keeps structured launch input behind agent management and out of errors', async () => {
    const secret = 'profile-secret-that-must-not-echo';
    const response = await fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: 'fake', handle: 'unsafe-config', cwd: testCwd('unsafe-config'),
        acp_launch: { executable: 'provider', argv: ['--profile', secret] },
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('accepted only for the acp harness');
    expect(body).not.toContain(secret);
  });
  // harn:end acp-launch-is-structured-authorized-and-bounded
  // harn:end new-agent-requests-require-available-native-or-detected-acp
  // harn:end adapter-refresh-is-authorized-and-incremental

  // harn:assume account-usage-limits-are-probed-periodically-and-honestly-refreshable ref=usage-refresh-auth-regression
  it('authorizes the usage refresh, returns whether a probe ran, and leaks no credential', async () => {
    const postUsageRefresh = (token: string) => fetch(`${base}/api/usage/refresh`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    expect((await postUsageRefresh(MEMBER_TOKEN)).status).toBe(403);
    expect((await postUsageRefresh(OBSERVER_TOKEN)).status).toBe(403);

    const ok = await postUsageRefresh(ADMIN_TOKEN);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    // A distinguishable outcome, never a credential.
    expect(body).toEqual({ outcome: expect.stringMatching(/^(refreshed|cooldown|coalesced|failed)$/) });
    expect(JSON.stringify(body)).not.toMatch(/token|bearer|secret|oauth|authorization/i);
  });
  // harn:end account-usage-limits-are-probed-periodically-and-honestly-refreshable

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
  it.skipIf(process.platform === 'win32')('rejects a public unix socket parent before listen', async () => {
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

  it.skipIf(process.platform === 'win32')('serves the identical room and sync frames over a mode-0600 unix socket', async () => {
    const socketPath = join(dir, 'codor.sock');
    const ipc = await startServer({ daemon, token: TOKEN, socketPath });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const client = await connectUrl(`ws+unix://${socketPath}:/ws`);
    client.ws.send(JSON.stringify({ type: 'list_rooms' }));
    const rooms = await client.next((frame) => frame.type === 'rooms');
    expect(rooms).toMatchObject({ type: 'rooms', rooms: [{ id: 'eng', name: 'Eng' }] });
    // The reply carries each listed room's committed seq so a multiplexed client
    // can detect and warm-resync a room that fell behind.
    expect(rooms.type === 'rooms' && rooms.room_seqs).toEqual({ eng: daemon.store.currentSeq('eng') });

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

  // harn:assume browser-created-channel-delivers-its-room-key ref=browser-room-key-regression
  it('returns a new room key only to the paired browser that created it', async () => {
    const browser = new CryptoVault(join(dir, 'creating-browser'));
    const peer = crypto.keys.enrollPeer({
      ...browser.keys.publicIdentity(), kind: 'device', label: 'creating browser',
    });
    crypto.roomKeys.enrollPeer(peer);
    const browserToken = await authenticateDevice(browser);

    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'First Browser Room',
        owner: { handle: 'browser-owner', display_name: 'Browser Owner' },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      room: { id: string };
      room_key: { room: string; generation: number; sealed_key: string };
    };
    expect(body.room_key).toMatchObject({ room: body.room.id, generation: 1 });
    expect(openSealedBox(body.room_key.sealed_key, browser.keys.identity))
      .toEqual(crypto.roomKeys.roomKey(body.room.id));

    const operatorResponse = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Operator Room',
        owner: { handle: 'operator-owner', display_name: 'Operator Owner' },
      }),
    });
    expect(await operatorResponse.json()).not.toHaveProperty('room_key');
    browser.close();
  });
  // harn:end browser-created-channel-delivers-its-room-key

  it('lists only home-contained directories for admins with precise status codes', async () => {
    mkdirSync(join(dir, 'alpha'));
    mkdirSync(join(dir, '.hidden'));
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'file');
    const outside = mkdtempSync(join(tmpdir(), 'codor-server-outside-'));
    symlinkSync(outside, join(dir, 'escape'), 'junction');
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

// harn:assume durable-room-summaries-stream-and-fallback ref=durable-room-summary-regression
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

  it('serves durable activity unread from the shared projection while preserving legacy cursors', async () => {
    const { agent, token: agentToken } = spawnAgentWithToken('durable-summary-agent');
    const message = daemon.postAgentMessage('eng', agent.id, 'a substantive update');

    const durable = await fetch(`${base}/api/rooms/summary?read_state=durable`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(durable.status).toBe(200);
    const durableBody = await durable.json() as { rooms: { id: string; unread: number }[] };
    expect(durableBody.rooms.find((room) => room.id === 'eng')?.unread).toBe(1);

    const legacyNoCursor = await fetch(`${base}/api/rooms/summary`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await legacyNoCursor.json() as { rooms: { id: string; unread: number }[] }).rooms
      .find((room) => room.id === 'eng')?.unread).toBe(0);
    const legacyCursor = await fetch(`${base}/api/rooms/summary?cursors=eng:${String(message.id - 1)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await legacyCursor.json() as { rooms: { id: string; unread: number }[] }).rooms
      .find((room) => room.id === 'eng')?.unread).toBe(1);

    const agentDurable = await fetch(`${base}/api/rooms/summary?read_state=durable`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentDurable.status).toBe(400);
    const badMode = await fetch(`${base}/api/rooms/summary?read_state=browser`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(badMode.status).toBe(400);
  });
});
// harn:end durable-room-summaries-stream-and-fallback

// harn:assume room-git-inspection-read-only-from-known-cwds ref=room-git-inspection-server-regression
describe('git inspection endpoints (room-git-inspection-read-only-from-known-cwds)', () => {
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
    expect((await fetch(`${base}/api/rooms/eng/git-history`)).status).toBe(401);
  });

  it("refuses a cwd outside the room's known set", async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    const res = await fetch(`${base}/api/rooms/eng/git-diff?cwd=${encodeURIComponent('/etc')}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('pages commit metadata and reads a selected full hash', async () => {
    const repo = initRepo();
    daemon.configureRoom('eng', { cwd: repo });
    const history = await fetch(`${base}/api/rooms/eng/git-history?limit=1&cursor=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(history.status).toBe(200);
    const page = await history.json() as { repository: boolean; commits: { hash: string; subject: string }[] };
    expect(page.repository).toBe(true);
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]?.subject).toBe('init');

    const detail = await fetch(
      `${base}/api/rooms/eng/git-diff?commit=${page.commits[0]!.hash}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ comparison: 'root', files_truncated: false });
  });

  it('rejects unbounded paging and arbitrary revision syntax', async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    for (const query of ['limit=51', 'cursor=-1', 'cursor=10001']) {
      const res = await fetch(`${base}/api/rooms/eng/git-history?${query}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(400);
    }
    const revision = await fetch(`${base}/api/rooms/eng/git-diff?commit=HEAD`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(revision.status).toBe(400);
  });
});
// harn:end room-git-inspection-read-only-from-known-cwds

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

// harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-regression
// harn:assume actionable-inbox-clears-on-read-or-reply ref=actionable-inbox-regression
// harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-regression
describe('addressed room support', () => {
  it('sends exactly the requested tail plus redacted support while legacy keeps every outlier', async () => {
    const owner = daemon.ownerOf('eng');
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'support-agent', cwd: testCwd('support-agent'),
    });
    const started = '2026-07-18T10:00:00.000Z';
    const live = daemon.store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/support-live.jsonl' },
    });
    const card = daemon.store.postMessage('eng', {
      author: agent.id, kind: 'ask', body: 'Choose a path',
      ask: { interaction_id: 'server-support-ask', kind: 'ask', prompt: 'Choose a path' },
    });
    daemon.store.upsertInteraction({
      id: 'server-support-ask', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'server-native-ask', kind: 'ask', targets: [owner.id], state: 'pending',
    });
    const secret = 'sk-proj-abcdef1234567890abcdef';
    const mentionBody = `@richard review ${secret}`;
    const mention = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body: mentionBody,
      mentions: [{ member_id: owner.id, start: 0, end: 8 }],
    });
    daemon.store.createDelivery('eng', {
      message_id: mention.id, recipient: owner.id, state: 'consumed',
    });
    const finalized = daemon.store.postMessage('eng', {
      author: agent.id, kind: 'run', body: 'routing seed',
      run: {
        status: 'completed', started_ts: started, ended_ts: started, tool_calls: 0,
        events_ref: 'runs/support-final.jsonl', final_text: 'routing seed',
      },
    });
    const tail = ['tail one', 'tail two', 'tail three'].map((body) =>
      daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body }));

    const addressed = await connect();
    addressed.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0,
      hydrate_limit: 3, room_addressed: true,
    }));
    await addressed.next((frame) => frame.type === 'sync_complete' && frame.room === 'eng');
    const addressedMessages = addressed.frames.filter(
      (frame): frame is Extract<ServerFrame, { type: 'message' }> => frame.type === 'message',
    );
    expect(addressedMessages.map((frame) => frame.message.id)).toEqual(tail.map((message) => message.id));
    const support = addressed.frames.find(
      (frame): frame is Extract<ServerFrame, { type: 'room_support' }> => frame.type === 'room_support',
    );
    expect(support?.support.active_runs.map((message) => message.id)).toEqual([live.id]);
    expect(support?.support.interactions.map((message) => message.id)).toEqual([card.id]);
    expect(support?.support.latest_finalized_agent_id).toBe(agent.id);
    expect(support?.support.inbox).toHaveLength(1);
    expect(support?.support.inbox[0]?.preview).toContain('[redacted]');
    expect(JSON.stringify(support)).not.toContain(secret);
    addressed.ws.close();

    const legacy = await connect();
    legacy.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0, hydrate_limit: 3,
    }));
    await legacy.next((frame) => frame.type === 'sync_complete');
    const legacyIds = legacy.frames
      .filter((frame): frame is Extract<ServerFrame, { type: 'message' }> => frame.type === 'message')
      .map((frame) => frame.message.id);
    expect(legacyIds.length).toBeGreaterThan(3);
    expect(legacyIds).toEqual(expect.arrayContaining([live.id, card.id, mention.id, finalized.id]));
    expect(legacy.frames.some((frame) => frame.type === 'room_support')).toBe(false);
    legacy.ws.close();
  });

  it('streams two rooms without polling and suppresses irrelevant member changes', async () => {
    daemon.createRoom({
      id: 'other', name: 'Other', owner: { handle: 'other-owner', display_name: 'Other Owner' },
    });
    const engAgent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'quiet-agent', cwd: testCwd('quiet-agent'),
    });
    const otherAgent = daemon.spawnMember('other', {
      harness: 'fake', handle: 'other-agent', cwd: testCwd('other-agent'),
    });
    const client = await connect();
    for (const room of ['eng', 'other']) {
      client.ws.send(JSON.stringify({
        type: 'subscribe', room, since_seq: 0, hydrate_limit: 3, room_addressed: true,
      }));
      await client.next((frame) => frame.type === 'sync_complete' && frame.room === room);
    }
    const engSupportBefore = client.frames.filter(
      (frame) => frame.type === 'room_support' && frame.support.room === 'eng',
    ).length;

    daemon.postAgentMessage('other', otherAgent.id, 'background project result');
    const streamed = await client.next((frame) =>
      frame.type === 'room_support'
      && frame.support.room === 'other'
      && frame.support.summary.unread === 1);
    expect(streamed).toMatchObject({ type: 'room_support', support: { room: 'other' } });

    const memberFramesBefore = client.frames.filter(
      (frame) => frame.type === 'member' && frame.member.id === engAgent.id,
    ).length;
    daemon.configureMember('eng', engAgent.id, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.frames.filter(
      (frame) => frame.type === 'member' && frame.member.id === engAgent.id,
    ).length).toBeGreaterThan(memberFramesBefore);
    expect(client.frames.filter(
      (frame) => frame.type === 'room_support' && frame.support.room === 'eng',
    )).toHaveLength(engSupportBefore);
    client.ws.close();
  });

  it('converges paired sockets, isolates another human, clears inbox, and refuses agents', async () => {
    const { agent, token: agentToken } = spawnAgentWithToken('support-principal-agent');
    const ownerA = await connect();
    const ownerB = await connect();
    const observerClient = await connectAs(OBSERVER_TOKEN);
    for (const client of [ownerA, ownerB, observerClient]) {
      client.ws.send(JSON.stringify({
        type: 'subscribe', room: 'eng', since_seq: 0, hydrate_limit: 3, room_addressed: true,
      }));
      await client.next((frame) => frame.type === 'sync_complete' && frame.room === 'eng');
    }

    daemon.postAgentMessage('eng', agent.id, '@richard needs review');
    for (const client of [ownerA, ownerB]) {
      const support = await client.next((frame) =>
        frame.type === 'room_support'
        && frame.support.room === 'eng'
        && frame.support.summary.unread === 1
        && frame.support.inbox.length === 1);
      expect(support).toBeDefined();
    }
    const observerSupport = await observerClient.next((frame) =>
      frame.type === 'room_support'
      && frame.support.room === 'eng'
      && frame.support.summary.unread === 1);
    expect(observerSupport.type === 'room_support' && observerSupport.support.inbox).toEqual([]);

    const throughSeq = daemon.store.currentSeq('eng');
    ownerA.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'mark_room_read', through_seq: throughSeq },
    }));
    for (const client of [ownerA, ownerB]) {
      const cleared = await client.next((frame) =>
        frame.type === 'room_support'
        && frame.seq > 0
        && frame.support.room === 'eng'
        && frame.support.summary.unread === 0
        && frame.support.inbox.length === 0);
      expect(cleared).toBeDefined();
    }
    expect(daemon.roomSupport('eng', observer.id).summary.unread).toBe(1);

    const agentClient = await connectAs(agentToken);
    agentClient.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0, room_addressed: true,
    }));
    await agentClient.next((frame) => frame.type === 'sync_complete' && frame.room === 'eng');
    expect(agentClient.frames.some((frame) => frame.type === 'room_support')).toBe(false);
    agentClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'mark_room_read', through_seq: throughSeq },
    }));
    expect(await agentClient.next((frame) =>
      frame.type === 'error' && frame.message.includes('agent cannot mark room read')))
      .toMatchObject({ type: 'error', ref: 'act' });

    ownerA.ws.close();
    ownerB.ws.close();
    observerClient.ws.close();
    agentClient.ws.close();
  });
});
// harn:end addressed-cold-hydration-is-strict-and-legacy-safe
// harn:end actionable-inbox-clears-on-read-or-reply
// harn:end room-support-is-bounded-recipient-scoped-state

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

// harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-server-dispatch
describe('clear_member_context act', () => {
  it('dispatches an owner reset and publishes the authoritative cleared member', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'clearable', cwd: testCwd('clearable'),
    });
    daemon.store.updateMember('eng', agent.id, { session_ref: 'native-retained' });
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'sync_complete');

    client.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'clear_member_context', member_id: agent.id },
    }));

    const frame = await client.next((candidate) =>
      candidate.type === 'member' &&
      candidate.member.id === agent.id &&
      candidate.member.session_ref === undefined);
    expect(frame).toMatchObject({ type: 'member', member: { id: agent.id } });
    expect(fake.resets).toHaveLength(1);
    expect(fake.resets[0]).toMatchObject({ harness: 'fake', cwd: testCwd('clearable') });
    client.ws.close();
  });

  it('correlates daemon refusal to the clear act and rejects a non-admin before dispatch', async () => {
    const fresh = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'already-fresh', cwd: testCwd('already-fresh'),
    });
    const owner = await connect();
    owner.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await owner.next((frame) => frame.type === 'sync_complete');
    owner.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'clear_member_context', member_id: fresh.id },
    }));
    expect(await owner.next((frame) => frame.type === 'error' && frame.ref === 'clear_member_context'))
      .toMatchObject({ type: 'error', ref: 'clear_member_context', message: expect.stringContaining('fresh context') });

    const denied = await connectAs(MEMBER_TOKEN);
    denied.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await denied.next((frame) => frame.type === 'sync_complete');
    denied.ws.send(JSON.stringify({
      type: 'act', room: 'eng', act: { act: 'clear_member_context', member_id: fresh.id },
    }));
    expect(await denied.next((frame) => frame.type === 'error'))
      .toMatchObject({ type: 'error', ref: 'act' });
    expect(fake.resets).toHaveLength(0);
    owner.ws.close();
    denied.ws.close();
  });
});
// harn:end member-context-reset-is-authorized-atomic-and-lazy

// harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=browser-protocol-regression
describe('browser protocol epoch', () => {
  const currentBrowserProtocol = BROWSER_PROTOCOL_EPOCH;
  const enrollBrowser = (label: string): CryptoVault => {
    const device = new CryptoVault(join(dir, label));
    const peer = crypto.keys.enrollPeer({
      ...device.keys.publicIdentity(),
      kind: 'device',
      label,
    });
    crypto.roomKeys.enrollPeer(peer);
    return device;
  };

  it('observes without enforcing during the reader-first bootstrap', async () => {
    const device = enrollBrowser('observe-browser');
    const browserToken = await authenticateDevice(device);
    const browser = await connectAs(browserToken);
    browser.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0,
      room_addressed: true, client_kind: 'browser',
      browser_protocol: currentBrowserProtocol,
    }));
    expect(await browser.next((frame) => frame.type === 'sync_complete'))
      .toMatchObject({ type: 'sync_complete', room: 'eng' });
    expect(server.observedBrowserProtocols()).toEqual([currentBrowserProtocol]);
    browser.ws.close();

    const preEpoch = await connectAs(browserToken);
    preEpoch.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0, room_addressed: true,
    }));
    expect(await preEpoch.next((frame) => frame.type === 'sync_complete'))
      .toMatchObject({ type: 'sync_complete', room: 'eng' });
    preEpoch.ws.close();

    const compatibility = await fetch(
      `${base}/api/client-compatibility?browser_protocol=${String(currentBrowserProtocol)}&client_kind=browser`,
      { headers: { authorization: `Bearer ${browserToken}` } },
    );
    expect(compatibility.status).toBe(200);
    expect(compatibility.headers.get('cache-control')).toBe('no-store');
    expect(await compatibility.json()).toEqual({
      browser_protocol: currentBrowserProtocol,
      minimum_browser_protocol: 0,
      compatible: true,
    });
    device.close();
  });

  it('refuses only stale browsers before hydration while epoch-less agent and Unix clients hydrate', async () => {
    const device = enrollBrowser('gated-browser');
    const browserToken = await authenticateDevice(device);
    const { agent, token: agentToken } = spawnAgentWithToken('epoch-agent');
    const socketPath = localSocketPath(dir);
    const observed: number[] = [];
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
      homeDir: dir,
      socketPath,
      minimumBrowserProtocol: currentBrowserProtocol,
      onBrowserProtocolObserved: (protocol) => observed.push(protocol),
    });
    base = `http://127.0.0.1:${server.port}`;

    const stale = await connectAs(browserToken);
    const staleClosed = new Promise<number>((resolve) => stale.ws.once('close', resolve));
    stale.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0,
      room_addressed: true, client_kind: 'browser',
    }));
    expect(await stale.next((frame) => frame.type === 'upgrade_required')).toEqual({
      type: 'upgrade_required',
      minimum_browser_protocol: currentBrowserProtocol,
      current_browser_protocol: currentBrowserProtocol,
    });
    expect(await staleClosed).toBe(4406);
    expect(stale.frames.map((frame) => frame.type)).toEqual(['upgrade_required']);

    const current = await connectAs(browserToken);
    current.ws.send(JSON.stringify({
      type: 'subscribe', room: 'eng', since_seq: 0,
      room_addressed: true, client_kind: 'browser',
      browser_protocol: currentBrowserProtocol,
    }));
    expect(await current.next((frame) => frame.type === 'sync_complete'))
      .toMatchObject({ type: 'sync_complete', room: 'eng' });
    current.ws.close();
    expect(observed).toContain(currentBrowserProtocol);

    const agentClient = await connectUrl(localWsUrl(socketPath, `/ws?token=${agentToken}`));
    agentClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await agentClient.next((frame) => frame.type === 'self'))
      .toEqual({ type: 'self', member_id: agent.id });
    expect(await agentClient.next((frame) => frame.type === 'sync_complete'))
      .toMatchObject({ type: 'sync_complete' });
    agentClient.ws.close();

    const ownerClient = await connectUrl(localWsUrl(socketPath, '/ws'));
    ownerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    expect(await ownerClient.next((frame) => frame.type === 'sync_complete'))
      .toMatchObject({ type: 'sync_complete' });
    ownerClient.ws.close();

    const refused = await fetch(`${base}/api/client-compatibility?client_kind=browser`, {
      headers: { authorization: `Bearer ${browserToken}` },
    });
    expect(refused.status).toBe(426);
    expect(await refused.json()).toMatchObject({ compatible: false });
    const agentCompatibility = await fetch(`${base}/api/client-compatibility?client_kind=browser`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentCompatibility.status).toBe(200);
    expect(await agentCompatibility.json()).toMatchObject({ compatible: true });
    device.close();
  });
});
// harn:end browser-protocol-epoch-blocks-only-stale-browser-ui

// harn:assume descriptor-safe-durable-inert-snapshots-of-successful-output ref=produced-artifact-server-regression
describe('produced-artifact endpoints (descriptor-safe-durable-inert-snapshots-of-successful-output)', () => {
  const stageArtifact = (room: string, name: string, mediaType: string, bytes: Buffer) => {
    const id = daemon.newArtifactId();
    daemon.ensureArtifactDir(room);
    writeFileSync(daemon.artifactPath(room, id), bytes);
    const meta = {
      id, name, media_type: mediaType, size: bytes.length,
      source_message_id: 1, produced_at: '2026-07-22T00:00:00.000Z',
    };
    daemon.recordArtifact(room, meta);
    return meta;
  };

  it('lists and serves a produced raster artifact inline to a room reader', async () => {
    const meta = stageArtifact('eng', 'chart.png', 'image/png', Buffer.from('png-bytes'));

    const list = await fetch(`${base}/api/rooms/eng/artifacts`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { artifacts: { id: string; name: string; media_type: string }[] };
    expect(body.artifacts.map((a) => a.id)).toContain(meta.id);

    const got = await fetch(`${base}/api/rooms/eng/artifacts/${meta.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('image/png');
    expect(got.headers.get('content-disposition')).toContain('inline');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await got.text()).toBe('png-bytes');
  });

  it('returns per-run snapshot-failure states beside the artifacts', async () => {
    daemon.recordArtifactError('eng', 42);
    const list = await fetch(`${base}/api/rooms/eng/artifacts`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { artifacts: unknown[]; errors: { source_message_id: number }[] };
    expect(body.errors.map((error) => error.source_message_id)).toContain(42);
    expect(JSON.stringify(body.errors)).not.toContain('/'); // path-free
  });

  it('serves a document artifact as an inert nosniff download', async () => {
    const meta = stageArtifact('eng', 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    const got = await fetch(`${base}/api/rooms/eng/artifacts/${meta.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('application/octet-stream');
    expect(got.headers.get('content-disposition')).toContain('attachment');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses anonymous list and serve', async () => {
    const meta = stageArtifact('eng', 'chart.png', 'image/png', Buffer.from('png'));
    expect((await fetch(`${base}/api/rooms/eng/artifacts`)).status).toBe(401);
    expect((await fetch(`${base}/api/rooms/eng/artifacts/${meta.id}`)).status).toBe(401);
  });

  it('does not serve one room\'s artifact id from another room', async () => {
    daemon.createRoom({ id: 'other', name: 'Other', owner: { handle: 'elsewhere', display_name: 'Elsewhere' } });
    const meta = stageArtifact('eng', 'secret.png', 'image/png', Buffer.from('png'));
    const cross = await fetch(`${base}/api/rooms/other/artifacts/${meta.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cross.status).toBe(404);
  });

  it('returns 404 for an unknown or malformed artifact id', async () => {
    const unknown = await fetch(`${base}/api/rooms/eng/artifacts/${'a'.repeat(32)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(unknown.status).toBe(404);
    const malformed = await fetch(`${base}/api/rooms/eng/artifacts/not-a-valid-id`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(malformed.status).toBe(404);
  });
});
// harn:end descriptor-safe-durable-inert-snapshots-of-successful-output

interface StubVoiceOpts {
  available?: boolean;
  reason?: string;
  transcribe?: (input: { audio: Uint8Array; mimeType: string }) => Promise<{ text: string }>;
  onCreate?: () => void;
}

const stubVoice = (id: string, opts: StubVoiceOpts = {}): VoiceProviderDefinition => ({
  id,
  label: `${id} label`,
  status: async () => ({ available: opts.available ?? true, ...(opts.reason ? { reason: opts.reason } : {}) }),
  create: () => {
    opts.onCreate?.();
    return { id, label: id, transcribe: opts.transcribe ?? (async () => ({ text: 'stub transcript' })) };
  },
});

const restartVoice = async (opts: {
  voiceProvider?: string;
  voiceProviders?: VoiceProviderDefinition[];
  voiceTimeoutMs?: number;
}) => {
  await server.close();
  server = await startServer({ daemon, token: TOKEN, crypto, pushSubscriptions, homeDir: dir, ...opts });
  base = `http://127.0.0.1:${server.port}`;
};

const postAudio = (body: BodyInit, headers: Record<string, string> = {}) => {
  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'audio/wav', ...headers },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' };
  return fetch(`${base}/api/voice/transcribe`, init);
};

const oversizedStream = (): ReadableStream<Uint8Array> => {
  let sent = 0;
  const total = 9 * 1024 * 1024;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const chunk = new Uint8Array(128 * 1024);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
};

// harn:assume voice-provider-catalog-is-named-and-safe ref=voice-catalog-rest-regression
describe('GET /api/voice/providers', () => {
  it('requires bearer auth', async () => {
    await restartVoice({ voiceProviders: [stubVoice('codex', { available: true })] });
    const res = await fetch(`${base}/api/voice/providers`);
    expect(res.status).toBe(401);
  });

  it('projects only safe metadata plus enabled/selected', async () => {
    await restartVoice({
      voiceProvider: 'codex',
      voiceProviders: [stubVoice('codex', { available: false, reason: 'run `codex login`' })],
    });
    const res = await fetch(`${base}/api/voice/providers`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      enabled: boolean; selected: string; providers: Record<string, unknown>[];
    };
    expect(body.enabled).toBe(true);
    expect(body.selected).toBe('codex');
    expect(body.providers).toEqual([
      { id: 'codex', label: 'codex label', available: false, reason: 'run `codex login`' },
    ]);
    expect(Object.keys(body.providers[0]!).sort()).toEqual(['available', 'id', 'label', 'reason']);
  });
});
// harn:end voice-provider-catalog-is-named-and-safe

// harn:assume voice-transcribe-endpoint-is-authorized-and-bounded ref=voice-transcribe-rest-regression
describe('POST /api/voice/transcribe', () => {
  it('returns the provider transcript for authed audio', async () => {
    await restartVoice({ voiceProviders: [stubVoice('codex', { transcribe: async () => ({ text: 'hello there' }) })] });
    const res = await postAudio(new Uint8Array([1, 2, 3, 4]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello there' });
  });

  it('refuses without bearer auth', async () => {
    await restartVoice({ voiceProviders: [stubVoice('codex')] });
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1]),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an oversized declared content-length with 413', async () => {
    await restartVoice({ voiceProviders: [stubVoice('codex')] });
    const res = await postAudio(Buffer.alloc(9 * 1024 * 1024));
    expect(res.status).toBe(413);
  });

  it('rejects an oversized streamed body with 413', async () => {
    await restartVoice({ voiceProviders: [stubVoice('codex')] });
    const res = await postAudio(oversizedStream());
    expect(res.status).toBe(413);
  });

  it('maps an input-coded provider error to 400', async () => {
    await restartVoice({
      voiceProviders: [stubVoice('codex', {
        transcribe: async () => { throw new VoiceTranscribeError('input', 'too short'); },
      })],
    });
    const res = await postAudio(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too short' });
  });

  it('maps an upstream-coded error to 502 preserving the body', async () => {
    await restartVoice({
      voiceProviders: [stubVoice('codex', {
        transcribe: async () => { throw new VoiceTranscribeError('upstream', 'endpoint said boom'); },
      })],
    });
    const res = await postAudio(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'endpoint said boom' });
  });

  it('rejects a concurrent second transcription with 429', async () => {
    await restartVoice({
      voiceProviders: [stubVoice('codex', {
        transcribe: () => new Promise((r) => setTimeout(() => r({ text: 'slow' }), 300)),
      })],
    });
    const first = postAudio(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 40));
    const second = await postAudio(new Uint8Array([1, 2, 3]));
    expect(second.status).toBe(429);
    expect((await first).status).toBe(200);
  });

  it('times out a slow provider with 504', async () => {
    await restartVoice({
      voiceTimeoutMs: 20,
      voiceProviders: [stubVoice('codex', { transcribe: () => new Promise<never>(() => {}) })],
    });
    const res = await postAudio(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(504);
  });
});
// harn:end voice-transcribe-endpoint-is-authorized-and-bounded

// harn:assume voice-provider-selection-is-operator-config ref=voice-selection-regression
describe('voice provider selection is operator config', () => {
  it('disables the catalog and endpoint when set to none', async () => {
    await restartVoice({ voiceProvider: 'none', voiceProviders: [stubVoice('codex')] });
    const post = await postAudio(new Uint8Array([1, 2, 3]));
    expect(post.status).toBe(404);
    const catalog = await fetch(`${base}/api/voice/providers`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await catalog.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('resolves only the configured provider; a non-selected one is never created', async () => {
    let secondaryCreated = false;
    await restartVoice({
      voiceProvider: 'primary',
      voiceProviders: [
        stubVoice('primary', { transcribe: async () => ({ text: 'from primary' }) }),
        stubVoice('secondary', { onCreate: () => { secondaryCreated = true; } }),
      ],
    });
    const res = await postAudio(new Uint8Array([1, 2, 3]));
    expect(await res.json()).toEqual({ text: 'from primary' });
    expect(secondaryCreated).toBe(false);
  });
});
// harn:end voice-provider-selection-is-operator-config

// harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-post-regression
describe('voice message post', () => {
  it('fans out bounded voice metadata verbatim on a human post', async () => {
    const client = await connect(); // owner
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'self');

    const voice = { duration_seconds: 3.5, levels: [0, 40, 80, 100] };
    client.ws.send(JSON.stringify({ type: 'post', room: 'eng', body: '🎤 "hi there"', voice }));
    const posted = await client.next((frame) =>
      frame.type === 'message' && frame.message.kind === 'chat' && frame.message.body === '🎤 "hi there"');
    expect(posted.type === 'message' && posted.message.voice).toEqual(voice);
    client.ws.close();
  });

  it('refuses an out-of-bounds voice frame with a clean error', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'self');

    client.ws.send(JSON.stringify({
      type: 'post', room: 'eng', body: 'x', voice: { duration_seconds: 999, levels: [] },
    }));
    const error = await client.next((frame) => frame.type === 'error');
    expect(error.type === 'error' && error.message).toMatch(/invalid frame/);
    client.ws.close();
  });

  it('carries no voice on the agent post path even when the frame includes it', async () => {
    const { agent, token } = spawnAgentWithToken('voicer');
    const client = await connectAs(token);
    client.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await client.next((frame) => frame.type === 'self');

    client.ws.send(JSON.stringify({
      type: 'post', room: 'eng', body: '@richard update', voice: { duration_seconds: 2, levels: [1, 2] },
    }));
    const posted = await client.next((frame) =>
      frame.type === 'message' && frame.message.author === agent.id);
    expect(posted.type === 'message' && posted.message.voice).toBeUndefined();
    client.ws.close();
  });
});
// harn:end voice-message-metadata-is-bounded-and-additive

describe('named ACP providers over REST', () => {
  let dir: string;
  let daemon: Daemon;
  let server: RunningServer;
  let base: string;
  let present: Set<string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codor-acp-rest-'));
    present = new Set<string>();
    daemon = new Daemon({
      dbPath: join(dir, 'db.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [Object.assign(new FakeAdapter('acp'), { configurable: true }) as unknown as FakeAdapter],
      ledger: new LedgerManager({ dataDir: dir }),
      homeDir: dir,
      executableOnPath: (executable) => present.has(executable),
      discoverModels: false,
    });
    daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
    server = await startServer({
      daemon, token: TOKEN, principals: [],
      crypto: new CryptoVault(dir),
      pushSubscriptions: new PushSubscriptionStore(dir, new CryptoVault(join(dir, 'k')).keys),
      homeDir: dir,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // harn:assume named-acp-provider-catalog-is-path-detected-and-command-private ref=acp-provider-catalog-rest-regression
  it('publishes named provider metadata over catalog and refresh without any command material', async () => {
    const read = async (path: string, method = 'GET') => (await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}` },
    })).json() as Promise<{ adapters: { id: string; acp_provider?: string; installed: boolean }[] }>;

    const initial = await read('/api/adapters');
    const named = initial.adapters.filter((entry) => entry.acp_provider !== undefined);
    expect(named.map((entry) => entry.id)).toEqual(['acp:kimi', 'acp:kilo']);
    expect(named.every((entry) => entry.installed === false)).toBe(true);
    // No entry — named or native — ever serializes an executable or argv.
    const serialized = JSON.stringify(initial.adapters);
    expect(serialized).not.toContain('executable');
    expect(serialized).not.toContain('argv');

    // Authorized refresh re-detects: kimi flips to installed, still command-private.
    present.add('kimi');
    const refreshed = await read('/api/adapters/refresh', 'POST');
    expect(refreshed.adapters.find((entry) => entry.acp_provider === 'kimi')?.installed).toBe(true);
    expect(JSON.stringify(refreshed.adapters)).not.toContain('argv');
  });
  // harn:end named-acp-provider-catalog-is-path-detected-and-command-private

  // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-rest-regression
  it('accepts a safe named provider id and enforces the one-of contract without leaking commands', async () => {
    present.add('kimi');
    const spawn = (body: Record<string, unknown>) => fetch(`${base}/api/rooms/eng/members`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'a', cwd: dir, ...body }),
    });

    // Named request carries only the safe id; the member projects it and never a command.
    const ok = await spawn({ harness: 'acp', handle: 'kimo', acp_provider: 'kimi' });
    expect(ok.status).toBe(200);
    const member = await ok.json() as Member & { acp_launch?: unknown };
    expect(member.acp_provider).toBe('kimi');
    expect(member).not.toHaveProperty('acp_launch');
    expect(JSON.stringify(member)).not.toContain('argv');

    // Both provider and custom launch is ambiguous → rejected before persistence.
    const both = await spawn({
      harness: 'acp', handle: 'both', acp_provider: 'kimi',
      acp_launch: { executable: 'x', argv: ['acp'] },
    });
    expect(both.status).toBe(400);
    // Neither is unlaunchable → rejected.
    expect((await spawn({ harness: 'acp', handle: 'neither' })).status).toBe(400);
    // A currently-undetected curated id → rejected, and the safe id is echoed, not a command.
    const stale = await spawn({ harness: 'acp', handle: 'staly', acp_provider: 'kilo' });
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("'kilo'");
    expect(daemon.store.listMembers('eng').map((m) => m.handle)).not.toContain('staly');
  });
  // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
});

// harn:assume individual-agent-preset-selection-snapshots-one-ordinary-spawn-v2 ref=agent-preset-spawn-server-regression
describe('ordinary WebSocket spawn display names', () => {
  it('atomically persists a supplied name, defaults omission, and rejects a member principal', async () => {
    const ownerClient = await connect();
    ownerClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await ownerClient.next((frame) => frame.type === 'sync_complete');

    ownerClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng',
      act: {
        act: 'spawn', harness: 'fake', handle: 'display-scout', display_name: 'Display Scout',
        cwd: testCwd('display-scout'), policy: 'read-only',
      },
    }));
    const named = await ownerClient.next((frame) =>
      frame.type === 'member' && frame.member.handle === 'display-scout');
    expect(named.type === 'member' ? named.member.display_name : undefined).toBe('Display Scout');
    expect(daemon.store.getMemberByHandle('eng', 'display-scout')?.display_name).toBe('Display Scout');

    ownerClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng',
      act: { act: 'spawn', harness: 'fake', handle: 'handle-name', cwd: testCwd('handle-name') },
    }));
    const defaulted = await ownerClient.next((frame) =>
      frame.type === 'member' && frame.member.handle === 'handle-name');
    expect(defaulted.type === 'member' ? defaulted.member.display_name : undefined).toBe('handle-name');
    ownerClient.ws.close();

    const spawn = vi.spyOn(fake, 'spawn');
    const memberClient = await connectAs(MEMBER_TOKEN);
    memberClient.ws.send(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }));
    await memberClient.next((frame) => frame.type === 'sync_complete');
    memberClient.ws.send(JSON.stringify({
      type: 'act', room: 'eng',
      act: { act: 'spawn', harness: 'fake', handle: 'member-spawn', cwd: testCwd('member-spawn') },
    }));
    const denied = await memberClient.next((frame) => frame.type === 'error');
    expect(denied.type === 'error' ? denied.message : '').toMatch(/forbidden/);
    expect(spawn).not.toHaveBeenCalled();
    expect(daemon.store.getMemberByHandle('eng', 'member-spawn')).toBeUndefined();
    spawn.mockRestore();
    memberClient.ws.close();
  });
});
// harn:end individual-agent-preset-selection-snapshots-one-ordinary-spawn-v2

describe('universal pairing mint (relay-enabled routes)', () => {
  it('serves the dual-door offer from /api/pairing/offers and maps /api/relay/pair to the code line', async () => {
    const canned = {
      endpoint: 'wss://relay.test',
      pairing_token: 'universal-token',
      pairing_code: 'AB23-CD45',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      switchboard_sign_pub: 'sign-pub',
      doors: 'both' as const,
    };
    let pairCalls = 0;
    let lastEndpoint: string | undefined;
    const relay = {
      status: () => ({ enabled: true, relay_url: 'wss://relay.test', session_id: 's', devices: 0 }),
      enable: () => {},
      disable: () => {},
      rotate: () => 's',
      pair: async (endpoint?: string) => {
        pairCalls += 1;
        lastEndpoint = endpoint;
        return canned;
      },
    };
    const relayServer = await startServer({ daemon, token: TOKEN, crypto, relay, port: 0 });
    const rbase = `http://127.0.0.1:${relayServer.port}`;
    try {
      // Settings' mint endpoint returns the FULL universal offer (both doors).
      const offersRes = await fetch(`${rbase}/api/pairing/offers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: rbase }),
      });
      expect(offersRes.status).toBe(200);
      expect(await offersRes.json()).toMatchObject({
        pairing_code: 'AB23-CD45',
        pairing_token: 'universal-token',
        doors: 'both',
      });
      expect(lastEndpoint).toBe(rbase); // Settings' endpoint is threaded to the mint

      // The relay CLI endpoint maps the same universal offer down to a code line.
      const pairRes = await fetch(`${rbase}/api/relay/pair`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(pairRes.status).toBe(200);
      expect(await pairRes.json()).toEqual({ code: 'AB23-CD45', expires_at: canned.expires_at, doors: 'both' });

      expect(pairCalls).toBe(2); // both surfaces funnel through the one mint
    } finally {
      await relayServer.close();
    }
  });
});
