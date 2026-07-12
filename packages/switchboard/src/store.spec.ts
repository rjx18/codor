import { CHANNEL_ACCENTS, deriveRoomColor } from '@codor/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from './store.js';

let dir: string;
let store: Store;

const openRoom = (s: Store) =>
  s.createRoom({ id: 'eng', name: 'Engineering', owner: { handle: 'richard', display_name: 'Richard' } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codor-store-'));
  store = new Store(join(dir, 'test.sqlite'));
});

// harn:assume agent-member-credentials-stay-secret ref=member-credential-store-regression
describe('agent member credential storage', () => {
  it('persists only a replaceable hash and never projects it as member state', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'credentialed', display_name: 'Credentialed', state: 'idle',
    });
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);

    expect(() => store.setAgentCredentialHash('eng', agent.id, 'raw-token-must-not-land-here'))
      .toThrow('must be a SHA-256 digest');

    store.setAgentCredentialHash('eng', agent.id, firstHash);
    expect(store.findAgentByCredentialHash(firstHash)).toEqual({
      room: 'eng',
      member: agent,
    });
    expect(store.getMember('eng', agent.id)).not.toHaveProperty('credential_hash');
    expect(JSON.stringify(store.listMembers('eng'))).not.toContain(firstHash);

    store.setAgentCredentialHash('eng', agent.id, secondHash);
    expect(store.findAgentByCredentialHash(firstHash)).toBeUndefined();
    expect(store.findAgentByCredentialHash(secondHash)?.member.id).toBe(agent.id);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.findAgentByCredentialHash(secondHash)?.member.id).toBe(agent.id);
  });

  it('never assigns a member credential to a human', () => {
    const { owner } = openRoom(store);
    expect(() => store.setAgentCredentialHash('eng', owner.id, 'c'.repeat(64)))
      .toThrow('no active agent member');
  });
});
// harn:end agent-member-credentials-stay-secret

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('room seeding', () => {
  it('creates the owner human with role owner AND the system member atomically', () => {
    const { owner, system } = openRoom(store);
    expect(owner.kind).toBe('human');
    expect(owner.role).toBe('owner');
    expect(system.kind).toBe('system');
    expect(system.handle).toBe('switchboard');
    const members = store.listMembers('eng');
    expect(members).toHaveLength(2);
  });

  it('the system handle stays reserved: no second member can take it', () => {
    openRoom(store);
    expect(() =>
      store.addMember('eng', { kind: 'agent', handle: 'switchboard', display_name: 'X' }),
    ).toThrow();
  });
});

describe('ack and active member lifecycle storage', () => {
  it('roundtrips ack evidence and keeps removed identities outside active lookups', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', purpose: 'Implements', state: 'dead',
    });
    const acknowledgement = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '<ACK_OK>', ack: true,
      run: { status: 'completed', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    expect(store.getMessage('eng', acknowledgement.id)?.ack).toBe(true);
    expect(store.getMessage('eng', store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'plain',
    }).id)?.ack).toBeUndefined();

    const removed = store.updateMember('eng', agent.id, { removed_ts: new Date().toISOString() });
    expect(store.getMember('eng', agent.id)?.removed_ts).toBe(removed.removed_ts);
    expect(store.getMemberByHandle('eng', 'coder')).toBeUndefined();
    expect(store.listMembers('eng').some((member) => member.id === agent.id)).toBe(false);
    expect(store.listMembers('eng', { includeRemoved: true }).some((member) => member.id === agent.id))
      .toBe(true);
    expect(store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Replacement', state: 'idle',
    }).id).not.toBe(agent.id);
  });

  it('migrates legacy global handle uniqueness to active-only uniqueness', () => {
    store.close();
    const path = join(dir, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ts TEXT NOT NULL, config TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE members (
        id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), kind TEXT NOT NULL,
        handle TEXT NOT NULL, display_name TEXT NOT NULL, harness TEXT, session_ref TEXT,
        cwd TEXT, policy TEXT, host TEXT, state TEXT, custody TEXT, parent TEXT, role TEXT,
        conventions_sent INTEGER NOT NULL DEFAULT 0, misaddressed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (room, handle)
      );
      CREATE TABLE messages (
        room TEXT NOT NULL REFERENCES rooms(id), id INTEGER NOT NULL, author TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, refs TEXT NOT NULL,
        ledger_refs TEXT NOT NULL, reply_to INTEGER, run TEXT, ask TEXT, origin TEXT,
        ts TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (room, id)
      );
      INSERT INTO rooms VALUES ('eng', 'Engineering', '2026-07-11T00:00:00.000Z', '{}', 0);
      INSERT INTO members (id, room, kind, handle, display_name, state)
      VALUES ('01J00000000000000000000000', 'eng', 'agent', 'coder', 'Coder', 'dead');
    `);
    legacy.close();
    store = new Store(path);
    const old = store.getMember('eng', '01J00000000000000000000000')!;
    expect(old.roster_stale).toBe(true);
    store.updateMember('eng', old.id, { removed_ts: new Date().toISOString() });
    expect(store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Replacement', state: 'idle',
    })).toBeDefined();
  });
});

describe('message id allocation', () => {
  it('allocates dense monotonic per-room ids starting at 1', () => {
    const { owner } = openRoom(store);
    const first = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'one' });
    const second = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'two' });
    const third = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'three' });
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
  });

  it('ids are per-room: a second room starts at 1 again', () => {
    const { owner } = openRoom(store);
    store.createRoom({ id: 'ops', name: 'Ops', owner: { handle: 'richard', display_name: 'R' } });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'eng msg' });
    const opsOwner = store.listMembers('ops').find((m) => m.kind === 'human')!;
    expect(store.postMessage('ops', { author: opsOwner.id, kind: 'chat', body: 'ops msg' }).id).toBe(1);
  });
});

describe('bridge origin persistence', () => {
  it('deduplicates retries by bridge member, platform, and external id', () => {
    openRoom(store);
    const bridge = store.addMember('eng', {
      kind: 'bridge',
      handle: 'slack-bridge',
      display_name: 'Slack · C123',
    });
    const origin = { platform: 'slack', external_id: '171.42', sender_name: 'Sarah' };
    const first = store.postBridgeMessage('eng', bridge.id, 'Ship it', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });
    const retry = store.postBridgeMessage('eng', bridge.id, 'Ship it again', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });

    expect(first.deduped).toBe(false);
    expect(retry.deduped).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.body).toBe('Ship it');
    expect(store.listMessagesAfter('eng', 0)).toHaveLength(1);
  });

  it('rejects non-bridge authors and keeps distinct external ids', () => {
    const { owner } = openRoom(store);
    const origin = { platform: 'telegram', external_id: '7', sender_name: 'Lea' };
    expect(() => store.postBridgeMessage('eng', owner.id, 'No', origin, {
      mentions: [], refs: [], ledger_refs: [],
    })).toThrow('no such bridge member');
    const bridge = store.addMember('eng', {
      kind: 'bridge', handle: 'telegram-bridge', display_name: 'Telegram · 42',
    });
    store.postBridgeMessage('eng', bridge.id, 'One', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });
    store.postBridgeMessage('eng', bridge.id, 'Two', { ...origin, external_id: '8' }, {
      mentions: [], refs: [], ledger_refs: [],
    });
    expect(store.listMessagesAfter('eng', 0).map((message) => message.body)).toEqual(['One', 'Two']);
  });
});

describe('message history and search', () => {
  it('pages older messages by permanent room-local id in timeline order', () => {
    const { owner } = openRoom(store);
    for (let id = 1; id <= 7; id++) {
      store.postMessage('eng', { author: owner.id, kind: 'chat', body: `message ${id}` });
    }

    expect(store.listMessages('eng', { limit: 3 }).map((item) => item.id)).toEqual([5, 6, 7]);
    expect(store.listMessages('eng', { before: 5, limit: 3 }).map((item) => item.id)).toEqual([
      2, 3, 4,
    ]);
  });

  it('searches only the selected room and treats LIKE wildcards literally', () => {
    const { owner } = openRoom(store);
    const ops = store.createRoom({
      id: 'ops',
      name: 'Ops',
      owner: { handle: 'richard', display_name: 'Richard' },
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'Alpha 100% ready' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'alpha wildcard_ literal' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'unrelated' });
    store.postMessage('ops', { author: ops.owner.id, kind: 'chat', body: 'alpha in another room' });

    expect(store.searchMessages('eng', 'ALPHA').map((item) => item.id)).toEqual([2, 1]);
    expect(store.searchMessages('eng', '100%').map((item) => item.body)).toEqual([
      'Alpha 100% ready',
    ]);
    expect(store.searchMessages('eng', 'wildcard_').map((item) => item.body)).toEqual([
      'alpha wildcard_ literal',
    ]);
  });

  it('matches projected bodies while redaction is enabled and raw bodies only after opt-out', () => {
    const { owner } = openRoom(store);
    store.postMessage('eng', {
      author: owner.id,
      kind: 'chat',
      body: 'token sk-proj-abcdef1234567890abcdef',
    });

    expect(store.searchMessages('eng', 'sk-proj-abcdef')).toEqual([]);
    expect(store.searchMessages('eng', '[redacted]').map((item) => item.id)).toEqual([1]);
    store.updateRoomConfig('eng', { redaction_enabled: false });
    expect(store.searchMessages('eng', 'sk-proj-abcdef').map((item) => item.id)).toEqual([1]);
  });
});

describe('change log completeness', () => {
  it('every entity-type mutation appends exactly one row with monotonic seq', () => {
    const { owner } = openRoom(store);
    const baseline = store.currentSeq('eng');

    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'hi' }); // message
    store.updateMember('eng', owner.id, { display_name: 'Rich' }); // member
    store.createDelivery('eng', { message_id: message.id, recipient: owner.id, state: 'consumed' }); // inbox (human)
    store.bumpMeter('eng', '2026-07-10', { turns: 1, cost_usd: 0.19 }); // meter
    store.updateRoomConfig('eng', { turn_brake: 5 }); // room

    const changes = store.getChangesSince('eng', baseline);
    expect(changes.map((c) => c.entity)).toEqual(['message', 'member', 'inbox', 'meter', 'room']);
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('room creation itself is logged (room + two seeded members)', () => {
    openRoom(store);
    expect(store.getChangesSince('eng', 0).map((c) => c.entity)).toEqual([
      'room',
      'member',
      'member',
    ]);
  });

  it('in-place run finalization appends a message change (same id, new seq)', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/x.jsonl' },
    });
    const before = store.currentSeq('eng');
    const finalized = store.updateMessage('eng', run.id, {
      body: 'done @richard',
      run: { ...run.run!, status: 'completed', final_text: 'done @richard' },
    });
    expect(finalized.id).toBe(run.id);
    expect(finalized.seq).toBeGreaterThan(before);
    const changes = store.getChangesSince('eng', before);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.entity).toBe('message');
    expect(changes[0]!.entity_id).toBe(String(run.id));
    expect(owner.id).toBeTruthy();
  });

  it('agent deliveries do NOT pollute the client-visible inbox log', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const before = store.currentSeq('eng');
    store.createDelivery('eng', { message_id: message.id, recipient: agent.id });
    expect(store.getChangesSince('eng', before)).toHaveLength(0);
  });

  it('sync hydrates exactly the entities the log names since the cursor', () => {
    const { owner } = openRoom(store);
    const cursor = store.currentSeq('eng');
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'hi' });
    store.bumpMeter('eng', '2026-07-10', { turns: 1 });
    const result = store.sync('eng', cursor);
    expect(result.messages.map((m) => m.id)).toEqual([message.id]);
    expect(result.meters).toHaveLength(1);
    expect(result.members).toHaveLength(0); // unchanged since cursor
    expect(result.seq).toBe(store.currentSeq('eng'));
  });
});

describe('persistence across reopen', () => {
  it('interaction state machine rows survive a store reopen', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'ask',
      body: 'Which codeword?',
      ask: { interaction_id: 'int-1', kind: 'ask', prompt: 'Which codeword?' },
    });
    store.upsertInteraction({
      id: 'int-1',
      room: 'eng',
      member_id: agent.id,
      message_id: card.id,
      native_id: 'toolu_abc',
      kind: 'ask',
      targets: [owner.id],
      state: 'answered',
      answer: { 'Which codeword?': 'ALPHA' },
      answered_by: owner.id,
      answered_ts: new Date().toISOString(),
    });
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const revived = store.getInteraction('int-1')!;
    expect(revived.state).toBe('answered');
    expect(revived.answer).toEqual({ 'Which codeword?': 'ALPHA' });
    expect(revived.targets).toEqual([owner.id]);
    expect(store.listInteractions('eng', 'answered')).toHaveLength(1);
  });

  it('member cwd/policy/session_ref roundtrip across reopen (revive contract)', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      harness: 'codex',
      session_ref: '019f4ae0-8022-7a92-b81a-60e25f3f1c22',
      cwd: '/home/user/project',
      policy: 'workspace-write',
      state: 'idle',
      custody: 'mirrored',
    });
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const revived = store.getMember('eng', agent.id)!;
    expect(revived.cwd).toBe('/home/user/project');
    expect(revived.policy).toBe('workspace-write');
    expect(revived.session_ref).toBe('019f4ae0-8022-7a92-b81a-60e25f3f1c22');
    expect(revived.custody).toBe('mirrored');
    expect(
      store.findMemberBySessionRef('codex', '019f4ae0-8022-7a92-b81a-60e25f3f1c22'),
    ).toMatchObject({ room: 'eng', member: { id: agent.id } });
  });

  it('persists native mirrored-turn dedupe keys without storing event payloads', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'planner',
      display_name: 'Planner',
      harness: 'claude-code',
      session_ref: 'session-1',
      custody: 'mirrored',
    });
    const message = store.postMessage('eng', { author: agent.id, kind: 'run', body: 'done' });
    store.recordMirroredTurn('eng', agent.id, 'native-turn-1', message.id);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMirroredMessageId('eng', agent.id, 'native-turn-1')).toBe(message.id);
    expect(() =>
      store.recordMirroredTurn('eng', agent.id, 'native-turn-1', message.id),
    ).toThrow();
  });

  it('persists the attach CLI and native child process lease across reopen', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      harness: 'codex',
      session_ref: 'session-attach-1',
      cwd: '/work',
      state: 'idle',
      custody: 'mirrored',
    });
    const lease = store.createAttachLease({
      room: 'eng',
      member_id: agent.id,
      cli_pid: 123,
      heartbeat_ts: 1000,
    });
    store.setAttachLeaseChild(lease.id, 456, 456, 1100);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getAttachLeaseForMember(agent.id)).toEqual({
      id: lease.id,
      room: 'eng',
      member_id: agent.id,
      cli_pid: 123,
      child_pid: 456,
      process_group_id: 456,
      heartbeat_ts: 1100,
    });
    store.heartbeatAttachLease(lease.id, 1200);
    expect(store.listAttachLeases()).toEqual([
      expect.objectContaining({ id: lease.id, heartbeat_ts: 1200 }),
    ]);
    store.deleteAttachLease(lease.id);
    expect(store.getAttachLease(lease.id)).toBeUndefined();
  });
});

describe('mentions and refs', () => {
  it('mentions roundtrip as resolved member-id spans', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const spans = [{ member_id: agent.id, start: 0, end: 6 }];
    const message = store.postMessage('eng', {
      author: owner.id,
      kind: 'chat',
      body: '@coder start on #3',
      mentions: spans,
      refs: [3],
    });
    const reread = store.getMessage('eng', message.id)!;
    expect(reread.mentions).toEqual(spans);
    expect(reread.refs).toEqual([3]);
  });
});

describe('run blobs stay off the DB', () => {
  it('a finalized run message persists only the events_ref pointer', () => {
    openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'done',
      run: {
        status: 'completed',
        started_ts: new Date().toISOString(),
        tool_calls: 2,
        usage: { input_tokens: 100, output_tokens: 10 },
        events_ref: 'runs/1.jsonl',
        final_text: 'done',
      },
    });
    const reread = store.getMessage('eng', run.id)!;
    expect(reread.run!.events_ref).toBe('runs/1.jsonl');
    expect(reread.run).not.toHaveProperty('events');
  });
});

describe('deliveries (attempt WAL columns)', () => {
  it('binds run_msg_id in delivering state and roundtrips read_ts', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id,
      recipient: agent.id,
      hop_count: 4,
    });
    expect(delivery.state).toBe('queued');
    expect(delivery.attempt_count).toBe(0);
    expect(store.getDelivery('eng', delivery.id)!.hop_count).toBe(4);

    const inflight = store.updateDelivery('eng', delivery.id, {
      state: 'delivering',
      attempt_count: 1,
      run_msg_id: 99,
      batch_id: 'batch-1',
    });
    expect(inflight.run_msg_id).toBe(99);

    const held = store.updateDelivery('eng', delivery.id, { state: 'held' });
    expect(held.state).toBe('held');

    const inbox = store.createDelivery('eng', {
      message_id: message.id,
      recipient: owner.id,
      state: 'consumed',
    });
    const read = store.updateDelivery('eng', inbox.id, { read_ts: new Date().toISOString() });
    expect(read.read_ts).toBeDefined();
  });

  it('persists immutable routed payload context with an agent delivery', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id,
      recipient: agent.id,
      payload_snapshot: '{"pinned":true}',
    });
    expect(store.getDeliveryPayloadSnapshot('eng', delivery.id)).toBe('{"pinned":true}');
  });
});

describe('usage meters', () => {
  it('keeps reported dollars separate from the uncosted token subtotal', () => {
    openRoom(store);
    store.bumpMeter('eng', '2026-07-10', {
      turns: 1,
      cost_usd: 0.25,
      input_tokens: 100,
      output_tokens: 20,
    });
    const meter = store.bumpMeter('eng', '2026-07-10', {
      turns: 1,
      input_tokens: 40,
      output_tokens: 10,
      uncosted_tokens: 50,
    });
    expect(meter).toMatchObject({
      turns: 2,
      cost_usd: 0.25,
      input_tokens: 140,
      output_tokens: 30,
      uncosted_tokens: 50,
    });
  });
});

describe('atomic turn lifecycle', () => {
  it('rolls back the run placeholder and every binding when one batch delivery is invalid', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const beforeMessages = store.listMessages('eng').length;

    expect(() =>
      store.beginTurn('eng', {
        memberId: agent.id,
        deliveryIds: [delivery.id, 'missing-delivery'],
        startedTs: new Date().toISOString(),
        eventsRef: (id) => `runs/${id}.jsonl`,
      }),
    ).toThrow('missing-delivery');

    expect(store.listMessages('eng')).toHaveLength(beforeMessages);
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      state: 'queued',
      attempt_count: 0,
      run_msg_id: undefined,
    });
  });

  it('rolls back final message, input consumption, member, meter, and fanout together', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      state: 'running',
    });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const started = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${id}.jsonl`,
    });
    const running = started.runMessage;

    expect(() =>
      store.completeTurn('eng', {
        runMsgId: running.id,
        message: {
          body: '@richard done',
          run: { ...running.run!, status: 'completed', final_text: '@richard done' },
        },
        inputDeliveryIds: [delivery.id],
        memberId: agent.id,
        memberPatch: { state: 'idle' },
        meterDay: 'not-a-date',
        meterDelta: { turns: 1 },
        fanout: [{ recipient: owner.id, state: 'consumed' }],
      }),
    ).toThrow();

    expect(store.getMessage('eng', running.id)!.run!.status).toBe('running');
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('delivering');
    expect(store.getMember('eng', agent.id)!.state).toBe('running');
    expect(store.listDeliveries('eng', { recipient: owner.id })).toHaveLength(0);
    expect(store.getMeter('eng', 'not-a-date')).toBeUndefined();
  });
});

// harn:assume every-channel-has-a-visible-accent ref=channel-accent-regression
describe('channel accents', () => {
  it('gives a channel created without a colour one derived from its id', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'codor-accent-')), 'db.sqlite'));
    // This is the F3 root cause: the CLI (and the boot-seeded unit) create channels
    // with no colour at all, so the rail had nothing to show.
    const { room } = store.createRoom({
      id: 'desk', name: 'Desk', owner: { handle: 'richard', display_name: 'Richard' },
    });
    expect(room.config.color).toBe(deriveRoomColor('desk'));
    expect(store.getRoom('desk')!.config.color).toBe(deriveRoomColor('desk'));
  });

  it('keeps the colour a creator actually chose', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'codor-accent-')), 'db.sqlite'));
    const { room } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
      config: { color: '#123456' },
    });
    expect(room.config.color).toBe('#123456');
  });

  it('derives the same accent every time, so a channel does not change colour', () => {
    expect(deriveRoomColor('desk')).toBe(deriveRoomColor('desk'));
    expect(CHANNEL_ACCENTS).toContain(deriveRoomColor('anything-at-all'));
  });
});

// harn:assume agent-model-and-thinking-are-durable ref=durable-agent-config-regression
describe('a member keeps the model and thinking level it was given', () => {
  it('round-trips them through the database', () => {
    openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent',
      handle: 'alpha',
      display_name: 'alpha',
      harness: 'claude-code',
      cwd: '/tmp/work',
      policy: 'workspace-write',
      model: 'opus-4.8',
      thinking: 'high',
    });
    expect(alpha.model).toBe('opus-4.8');
    expect(alpha.thinking).toBe('high');

    // Read back through a SECOND store over the same file: the row, not the object.
    const reopened = new Store(join(dir, 'test.sqlite'));
    const read = reopened.getMember('eng', alpha.id)!;
    expect(read.model).toBe('opus-4.8');
    expect(read.thinking).toBe('high');
    reopened.close();
  });

  it('means the harness default when neither was given, rather than guessing one', () => {
    openRoom(store);
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'beta', harness: 'fake', cwd: '/tmp/work',
    });
    expect(beta.model).toBeUndefined();
    expect(beta.thinking).toBeUndefined();
  });

  it('keeps the columns when a legacy database rebuilds the members table', () => {
    // The lifecycle migration REBUILDS `members` from an explicit column list when it
    // finds the old global UNIQUE(room, handle). Adding our columns before that runs
    // would see them dropped straight back out — and then every insert would fail on a
    // column that no longer exists. This is the ordering, asserted.
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ts TEXT NOT NULL,
        config TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL REFERENCES rooms(id),
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        harness TEXT, session_ref TEXT, cwd TEXT, policy TEXT, host TEXT,
        state TEXT, custody TEXT, parent TEXT, role TEXT,
        conventions_sent INTEGER NOT NULL DEFAULT 0,
        misaddressed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (room, handle)
      );
    `);
    legacy.close();

    const migrated = new Store(legacyPath);
    const columns = (migrated.db.pragma('table_info(members)') as { name: string }[])
      .map((column) => column.name);
    expect(columns).toContain('model');
    expect(columns).toContain('thinking');

    // And it still works: an insert against the rebuilt table must not fail.
    openRoom(migrated);
    const alpha = migrated.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake',
      cwd: '/tmp/work', model: 'sonnet-5', thinking: 'medium',
    });
    expect(migrated.getMember('eng', alpha.id)!.model).toBe('sonnet-5');
    migrated.close();
  });
});

// harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-admission-regression
describe('a consumed delivery is never resurrected into a turn', () => {
  const queueOne = (body = '@alpha do it') => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake', cwd: '/work',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body });
    const delivery = store.createDelivery('eng', { message_id: message.id, recipient: alpha.id });
    return { alpha, delivery };
  };

  it('refuses a delivery consumed AFTER it was selected and BEFORE the turn began', () => {
    const { alpha, delivery } = queueOne();

    // The pump selects what is queued...
    const selected = store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });
    expect(selected.map((item) => item.id)).toEqual([delivery.id]);

    // ...and something consumes it in the window before the turn is admitted. At HEAD this
    // is reachable: the A5 removal drain consumes from outside the pump entirely.
    store.updateDelivery('eng', delivery.id, { state: 'consumed' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: selected.map((item) => item.id),
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });

    // It must not be handed to the agent as work...
    expect(started, 'a turn with nothing admissible must not begin').toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
    // ...and no empty run message may be posted in its name.
    expect(store.listMessages('eng', { limit: 20 }).filter((m) => m.kind === 'run')).toHaveLength(0);
  });

  it('proceeds with the remainder when only SOME of the batch was consumed', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake', cwd: '/work',
    });
    const first = store.createDelivery('eng', {
      message_id: store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@alpha one' }).id,
      recipient: alpha.id,
    });
    const second = store.createDelivery('eng', {
      message_id: store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@alpha two' }).id,
      recipient: alpha.id,
    });

    store.updateDelivery('eng', first.id, { state: 'consumed' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [first.id, second.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;

    expect(started.deliveries.map((item) => item.id)).toEqual([second.id]);
    expect(store.getDelivery('eng', first.id)!.state).toBe('consumed');
    expect(store.getDelivery('eng', second.id)!.state).toBe('delivering');
    expect(started.deliveries[0]!.run_msg_id).toBe(started.runMessage.id);
  });

  it('leaves a HELD delivery held — the admission set is closed, not widened', () => {
    const { alpha, delivery } = queueOne();
    store.updateDelivery('eng', delivery.id, { state: 'held' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });

    expect(started).toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('held');
  });

  it('re-admits a HELD delivery bound to the run being reused — the operator released it', () => {
    // An ambiguous turn parks its deliveries as `held`. When the operator releases one,
    // the daemon retries THAT run with the held group. Those deliveries are not being
    // swept into a turn: this run already claimed them, and the release is the request.
    // Restricting admission to `queued` alone would silently kill release_hold.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.updateDelivery('eng', delivery.id, { state: 'held' });

    const released = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;

    expect(released.runMessage.id).toBe(first.runMessage.id);
    expect(released.deliveries.map((item) => item.id)).toEqual([delivery.id]);
  });

  it('never re-admits a CONSUMED delivery, even for the run that claimed it', () => {
    // The one state that is admissible in no case at all.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.updateDelivery('eng', delivery.id, { state: 'consumed' });

    const retried = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    });

    expect(retried, 'work that was already taken is never handed out again').toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
  });

  it('still re-runs the deliveries a reconciled retry had already claimed', () => {
    // A crash-retry reuses its run message and re-runs deliveries that are ALREADY
    // `delivering` — this very run claimed them. Closing admission to `queued` alone
    // would silently kill crash recovery, so a delivery bound to the run being reused
    // is admissible too.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('delivering');

    const retried = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;

    expect(retried.runMessage.id, 'the retry reuses its run message').toBe(first.runMessage.id);
    expect(retried.deliveries.map((item) => item.id)).toEqual([delivery.id]);
    expect(retried.deliveries[0]!.attempt_count).toBe(2);
  });
});
