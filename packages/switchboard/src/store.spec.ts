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

// harn:assume live-delivery-consumption-is-idempotent ref=consumption-store-regression
describe('queued delivery consumption', () => {
  // harn:assume agent-delivery-lifecycle-streams-v2 ref=steered-delivery-storage
  it('persists steering acknowledgement and migrates a legacy delivery table', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'steered-alpha', display_name: 'Steered Alpha', state: 'running',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'adjust course' });
    const delivery = store.createDelivery('eng', { message_id: message.id, recipient: alpha.id });
    const steeredTs = '2026-07-22T03:00:00.000Z';
    expect(store.updateDelivery('eng', delivery.id, {
      state: 'consumed', steered_ts: steeredTs,
    })).toMatchObject({ state: 'consumed', steered_ts: steeredTs });

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      state: 'consumed', steered_ts: steeredTs,
    });

    store.close();
    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.exec('ALTER TABLE deliveries DROP COLUMN steered_ts');
    legacy.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)?.steered_ts).toBeUndefined();
  });
  // harn:end agent-delivery-lifecycle-streams-v2

  it('is recipient-bound, idempotent, and wins cleanly before turn admission', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const message = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha take this live',
    });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: alpha.id,
    });
    const selected = store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });
    expect(selected.map((item) => item.id)).toEqual([delivery.id]);

    expect(() => store.consumeQueuedDelivery('eng', delivery.id, beta.id))
      .toThrow('is not addressed to member');
    const first = store.consumeQueuedDelivery('eng', delivery.id, alpha.id);
    expect(first).toEqual({ delivery: { ...delivery, state: 'consumed' }, message });
    expect(store.consumeQueuedDelivery('eng', delivery.id, alpha.id)).toEqual(first);

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: selected.map((item) => item.id),
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(started).toBeUndefined();
    expect(store.listMessages('eng', { limit: 100 }).filter((item) => item.kind === 'run'))
      .toEqual([]);
  });

  it('returns a non-queued delivery unchanged when turn admission won first', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'running',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'work' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: alpha.id,
    });
    store.updateDelivery('eng', delivery.id, { state: 'delivering' });

    expect(store.consumeQueuedDelivery('eng', delivery.id, alpha.id)).toEqual({
      delivery: { ...delivery, state: 'delivering' },
      message,
    });
  });
});
// harn:end live-delivery-consumption-is-idempotent

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

  // harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-welcome-transaction-regression
  it('optionally persists one authored Tutorial chat without changing ordinary room seeding', () => {
    const body = 'Welcome to the Desk';
    store.createRoom({
      id: 'desk',
      name: 'Desk',
      owner: { handle: 'richard', display_name: 'Richard' },
      bootstrapWelcome: {
        author: { handle: 'tutorial', display_name: 'Tutorial' },
        body,
      },
    });

    const tutorial = store.listMembers('desk').find((member) => member.handle === 'tutorial');
    expect(tutorial).toMatchObject({ kind: 'system', display_name: 'Tutorial' });
    expect(store.listMessages('desk')).toEqual([
      expect.objectContaining({ author: tutorial!.id, kind: 'chat', body }),
    ]);

    openRoom(store);
    expect(store.listMembers('eng').map((member) => member.handle).sort())
      .toEqual(['richard', 'switchboard']);
    expect(store.listMessages('eng')).toEqual([]);
  });

  it('rolls back the room and every seeded member when welcome insertion fails', () => {
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_bootstrap_welcome
      BEFORE INSERT ON messages
      WHEN NEW.room = 'broken'
      BEGIN SELECT RAISE(ABORT, 'injected welcome failure'); END`);
    blocker.close();

    expect(() => store.createRoom({
      id: 'broken',
      name: 'Broken',
      owner: { handle: 'richard', display_name: 'Richard' },
      bootstrapWelcome: {
        author: { handle: 'tutorial', display_name: 'Tutorial' },
        body: 'Welcome',
      },
    })).toThrow('injected welcome failure');
    expect(store.getRoom('broken')).toBeUndefined();
    expect(store.listMembers('broken')).toEqual([]);
    expect(store.listMessages('broken')).toEqual([]);
  });
  // harn:end empty-database-desk-seeds-tutorial-atomically

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

  // harn:assume run-evidence-search-is-bounded-and-redacted ref=run-list-bound-regression
  it('selects newest runs directly despite newer chat volume and filters by author', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const run = (author: string, label: string) => store.postMessage('eng', {
      author,
      kind: 'run',
      body: label,
      run: {
        status: 'completed', started_ts: '2026-07-10T07:00:00.000Z',
        ended_ts: '2026-07-10T07:01:00.000Z', tool_calls: 0,
        events_ref: `runs/${label}.jsonl`, final_text: label,
      },
    });
    const first = run(alpha.id, 'alpha-old');
    const middle = run(beta.id, 'beta');
    const newest = run(alpha.id, 'alpha-new');
    for (let index = 0; index < 20; index++) {
      store.postMessage('eng', { author: owner.id, kind: 'chat', body: `newer chat ${index}` });
    }

    expect(store.listRunMessages('eng', { limit: 2 }).map((item) => item.id))
      .toEqual([newest.id, middle.id]);
    expect(store.listRunMessages('eng', { author: alpha.id, limit: 2 }).map((item) => item.id))
      .toEqual([newest.id, first.id]);
  });
  // harn:end run-evidence-search-is-bounded-and-redacted

  // harn:assume member-status-is-bounded-and-identity-safe ref=status-store-regression
  it('selects only newest chat actions for one author inside the run time window', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'running',
    });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha one' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'owner noise' });
    store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha two' });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha three' });

    expect(store.listChatMessagesByAuthorWithin(
      'eng', alpha.id, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', 2,
    ).map((item) => item.body)).toEqual(['alpha three', 'alpha two']);
    expect(store.listChatMessagesByAuthorWithin(
      'eng', alpha.id, '2100-01-01T00:00:00.000Z', undefined, 5,
    )).toEqual([]);
  });
  // harn:end member-status-is-bounded-and-identity-safe

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

// harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=advisory-accounting-regression
describe('usage meters', () => {
  it('keeps exact, estimated, and unpriced usage in separate buckets', () => {
    openRoom(store);
    store.bumpMeter('eng', '2026-07-10', {
      turns: 1,
      cost_usd: 0.25,
      input_tokens: 100,
      output_tokens: 20,
    });
    const meter = store.bumpMeter('eng', '2026-07-10', {
      turns: 2,
      estimated_cost_usd: 0.4,
      input_tokens: 40,
      output_tokens: 10,
      uncosted_tokens: 50,
    });
    expect(meter).toMatchObject({
      turns: 3,
      cost_usd: 0.25,
      estimated_cost_usd: 0.4,
      input_tokens: 140,
      output_tokens: 30,
      uncosted_tokens: 50,
    });
  });

  it('migrates an existing meter table without inventing historical estimates', () => {
    openRoom(store);
    store.bumpMeter('eng', '2026-07-10', { turns: 1, input_tokens: 20, uncosted_tokens: 20 });
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('ALTER TABLE meters DROP COLUMN estimated_cost_usd');
    legacy.close();

    store = new Store(path);
    expect(store.getMeter('eng', '2026-07-10')).toMatchObject({
      turns: 1,
      estimated_cost_usd: 0,
      input_tokens: 20,
      uncosted_tokens: 20,
    });
  });
});
// harn:end estimated-cost-is-advisory-not-spend-brake-input

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

  // harn:assume turn-output-finalization-is-atomic ref=output-finalization-regression
  it('rolls back every output row before committing output, custody, accounting, and fanout together', () => {
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
      model: 'gpt-5.6-luna',
      eventsRef: (id) => `runs/${id}.jsonl`,
    });
    const running = started.runMessage;
    const continuation = store.createRunContinuation('eng', running.id);
    const orphan = store.createRunContinuation('eng', running.id);
    const outputs = [
      {
        id: running.id, body: 'first stretch', mentions: [], refs: [], ledger_refs: [],
        substantive: true,
      },
      {
        id: continuation.id, body: 'second stretch', mentions: [], refs: [], ledger_refs: [],
        substantive: true,
      },
    ];
    const completedRun = {
      ...running.run!,
      status: 'completed' as const,
      ended_ts: '2026-07-18T10:01:00.000Z',
      final_text: 'first stretchsecond stretch',
      estimated_cost_usd: 0.5,
      result_message_id: continuation.id,
    };

    expect(() =>
      store.completeTurn('eng', {
        runMsgId: running.id,
        message: { run: completedRun },
        outputs,
        resultMessageId: continuation.id,
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
    expect(store.getMessage('eng', running.id)).toMatchObject({ body: '', run: { status: 'running' } });
    expect(store.getMessage('eng', continuation.id)).toMatchObject({ body: '', deleted: undefined });
    expect(store.getMessage('eng', orphan.id)).toMatchObject({ body: '', deleted: undefined });

    const completed = store.completeTurn('eng', {
      runMsgId: running.id,
      message: { run: completedRun },
      outputs,
      resultMessageId: continuation.id,
      inputDeliveryIds: [delivery.id],
      memberId: agent.id,
      memberPatch: { state: 'idle' },
      meterDay: '2026-07-18',
      meterDelta: { turns: 1, estimated_cost_usd: 0.5, input_tokens: 80, output_tokens: 20 },
      fanout: [{ recipient: owner.id, state: 'consumed', payload_snapshot: 'full aggregate' }],
    });

    expect(completed.outputMessages.map((message) => message.id))
      .toEqual([running.id, continuation.id, orphan.id]);
    expect(store.getMessage('eng', running.id)).toMatchObject({
      body: 'first stretch',
      run: {
        status: 'completed',
        model: 'gpt-5.6-luna',
        estimated_cost_usd: 0.5,
        final_text: 'first stretchsecond stretch',
        result_message_id: continuation.id,
      },
    });
    expect(store.getMessage('eng', continuation.id)).toMatchObject({
      body: 'second stretch', run_parent_id: running.id,
    });
    expect(store.getMessage('eng', orphan.id)).toMatchObject({ deleted: true, body: '' });
    expect(store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(store.getMember('eng', agent.id)?.state).toBe('idle');
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.5, input_tokens: 80, output_tokens: 20,
    });
    expect(store.listDeliveries('eng', { recipient: owner.id })).toEqual([
      expect.objectContaining({ message_id: continuation.id }),
    ]);
    expect(store.getDeliveryPayloadSnapshot(
      'eng',
      store.listDeliveries('eng', { recipient: owner.id })[0]!.id,
    )).toBe('full aggregate');
    expect(store.countUnreadMessages('eng', owner.id)).toBe(2);
  });
  // harn:end turn-output-finalization-is-atomic
});

// harn:assume failed-finalization-reconciles-at-runtime ref=delivery-reconciliation-regression
describe('failed finalization reconciliation transaction', () => {
  it('fails the run, holds ambiguous input, meters and explains exactly once', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'repair-alpha', display_name: 'Repair Alpha', state: 'running',
    });
    const trigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@repair-alpha do the work',
    });
    const delivery = store.createDelivery('eng', {
      message_id: trigger.id, recipient: alpha.id,
    });
    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T10:00:00.000Z',
      model: 'gpt-5.6-terra',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.setDeliveryAttemptProcess('eng', [delivery.id], { pid: 1234 });

    const first = store.repairFailedFinalization('eng', {
      runMsgId: started.runMessage.id,
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      error: 'finalization could not commit: injected transaction failure',
      endedTs: '2026-07-18T10:01:00.000Z',
      usage: { input_tokens: 300, output_tokens: 20 },
      estimatedCostUsd: 0.75,
      meterDay: '2026-07-18',
      meterDelta: {
        turns: 1,
        estimated_cost_usd: 0.75,
        input_tokens: 300,
        output_tokens: 20,
      },
    });

    expect(first).toMatchObject({ repaired: true, held: [delivery.id] });
    expect(first.message?.run).toMatchObject({
      status: 'failed',
      model: 'gpt-5.6-terra',
      usage: { input_tokens: 300, output_tokens: 20 },
      estimated_cost_usd: 0.75,
      error: 'finalization could not commit: injected transaction failure',
    });
    expect(first.message).toMatchObject({ body: '', mentions: [], refs: [], ledger_refs: [] });
    expect(first.member?.state).toBe('idle');
    expect(first.deliveries).toEqual([
      expect.objectContaining({ id: delivery.id, state: 'held', run_msg_id: started.runMessage.id }),
    ]);
    expect(first.notice?.body).toContain('release_hold or redeliver');
    expect(store.getDeliveryAttemptProcess('eng', delivery.id)).toBeUndefined();
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.75, input_tokens: 300, output_tokens: 20,
    });

    const beforeMessages = store.listMessages('eng', { limit: 100 }).length;
    const second = store.repairFailedFinalization('eng', {
      runMsgId: started.runMessage.id,
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      error: 'finalization could not commit: should not land',
      endedTs: '2026-07-18T10:02:00.000Z',
      meterDay: '2026-07-18',
      meterDelta: { turns: 1, input_tokens: 999 },
    });
    expect(second).toEqual({ repaired: false, deliveries: [], held: [] });
    expect(store.listMessages('eng', { limit: 100 })).toHaveLength(beforeMessages);
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.75, input_tokens: 300, output_tokens: 20,
    });
  });

  it('treats a closed group or closed round as settled even with nonterminal participants', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'closed-alpha', display_name: 'Closed Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'closed-beta', display_name: 'Closed Beta', state: 'idle',
    });
    const seed = (groupId: string) => {
      const root = store.postMessage('eng', {
        author: owner.id,
        kind: 'chat',
        body: `@closed-alpha @closed-beta ${groupId}`,
      });
      return store.createCollaborationGroup('eng', {
        groupId,
        rootMessageId: root.id,
        participants: [
          { memberId: alpha.id, payloadSnapshot: `${groupId} alpha` },
          { memberId: beta.id, payloadSnapshot: `${groupId} beta` },
        ],
      });
    };

    const roundClosed = seed('round-closed');
    const roundDelivery = roundClosed.deliveries[0]!;
    expect(store.collaborationWorkIsSettled('eng', roundDelivery.id)).toBe(false);
    store.updateCollaborationRound('eng', roundClosed.group.id, 1, {
      state: 'closed', released_ts: '2026-07-18T10:10:00.000Z',
    });
    expect(store.findCollaborationParticipantByDelivery('eng', roundDelivery.id)?.terminal_status)
      .toBeUndefined();
    expect(store.collaborationWorkIsSettled('eng', roundDelivery.id)).toBe(true);

    const groupClosed = seed('group-closed');
    const groupDelivery = groupClosed.deliveries[0]!;
    expect(store.collaborationWorkIsSettled('eng', groupDelivery.id)).toBe(false);
    store.updateCollaborationGroup('eng', groupClosed.group.id, {
      state: 'completed', completed_ts: '2026-07-18T10:11:00.000Z',
    });
    expect(store.findCollaborationParticipantByDelivery('eng', groupDelivery.id)?.terminal_status)
      .toBeUndefined();
    expect(store.getCollaborationRound('eng', groupClosed.group.id, 1)?.state).toBe('collecting');
    expect(store.collaborationWorkIsSettled('eng', groupDelivery.id)).toBe(true);
  });
});
// harn:end failed-finalization-reconciles-at-runtime

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

  // harn:assume unresolved-delivery-fences-fresh-member-turns ref=durable-delivery-turn-fence-regression
  it('fences a fresh run behind another durable active attempt but permits exact-run recovery', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'fenced-alpha', display_name: 'Fenced Alpha', state: 'running',
    });
    const staleTrigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@fenced-alpha old work',
    });
    const staleDelivery = store.createDelivery('eng', {
      message_id: staleTrigger.id, recipient: alpha.id,
    });
    const stale = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [staleDelivery.id],
      startedTs: '2026-07-18T10:00:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    const freshTrigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@fenced-alpha new work',
    });
    const freshDelivery = store.createDelivery('eng', {
      message_id: freshTrigger.id, recipient: alpha.id,
    });

    const refused = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [freshDelivery.id],
      startedTs: '2026-07-18T10:01:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(refused).toBeUndefined();
    expect(store.getDelivery('eng', freshDelivery.id)?.state).toBe('queued');
    expect(store.listMessages('eng', { limit: 100 }).filter((message) => message.kind === 'run'))
      .toHaveLength(1);

    const resumed = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [staleDelivery.id],
      startedTs: '2026-07-18T10:02:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: stale.runMessage.id,
    });
    expect(resumed?.runMessage.id).toBe(stale.runMessage.id);
    expect(resumed?.deliveries[0]?.attempt_count).toBe(2);
  });
  // harn:end unresolved-delivery-fences-fresh-member-turns
});

// harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-store-regression
describe('atomic approval answers', () => {
  const seedApproval = () => {
    const { owner } = openRoom(store);
    const admin = store.addMember('eng', {
      kind: 'human', handle: 'review-admin', display_name: 'Review Admin', role: 'admin',
    });
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'approver', display_name: 'Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow Bash?',
      ask: {
        interaction_id: 'native-approval',
        kind: 'approval',
        prompt: 'Allow Bash?',
        options: [{ label: 'Allow once' }, { label: 'Deny' }],
      },
    });
    store.upsertInteraction({
      id: 'approval-1', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'native-approval', kind: 'approval', targets: [owner.id, admin.id], state: 'pending',
    });
    const deliveries = [owner.id, admin.id].map((recipient) => store.createDelivery('eng', {
      message_id: card.id, recipient, state: 'consumed',
    }));
    return { owner, card, deliveries };
  };

  it('commits the durable answer and every target-human read in one projection', () => {
    const seeded = seedApproval();
    const cursor = store.currentSeq('eng');
    const answeredTs = '2026-07-14T10:00:00.000Z';

    const result = store.answerApproval('eng', 'approval-1', 'Allow once', seeded.owner.id, answeredTs);

    expect(result.interaction).toMatchObject({
      state: 'answered', answer: 'Allow once', answered_by: seeded.owner.id, answered_ts: answeredTs,
    });
    expect(result.deliveries.map((delivery) => delivery.id)).toEqual(seeded.deliveries.map((item) => item.id));
    expect(result.deliveries.every((delivery) => delivery.read_ts === answeredTs)).toBe(true);
    expect(result.deliveries.every(
      (delivery) => delivery.interaction_resolved_ts === answeredTs,
    )).toBe(true);
    expect(store.sync('eng', cursor).inbox).toEqual(result.deliveries);
  });

  it('rolls back the answer and all reads when a later delivery update fails', () => {
    const seeded = seedApproval();
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_second_approval_read
      BEFORE UPDATE OF read_ts ON deliveries
      WHEN NEW.id = '${seeded.deliveries[1]!.id}'
      BEGIN SELECT RAISE(ABORT, 'injected read failure'); END`);
    blocker.close();

    expect(() => store.answerApproval(
      'eng', 'approval-1', 'Allow once', seeded.owner.id, '2026-07-14T10:00:00.000Z',
    )).toThrow('injected read failure');
    expect(store.getInteraction('approval-1')).toMatchObject({ state: 'pending' });
    expect(seeded.deliveries.map((delivery) => store.getDelivery('eng', delivery.id)?.read_ts))
      .toEqual([undefined, undefined]);
    expect(seeded.deliveries.map(
      (delivery) => store.getDelivery('eng', delivery.id)?.interaction_resolved_ts,
    )).toEqual([undefined, undefined]);
  });
});
// harn:end approval-answer-is-atomic-and-chatless

// harn:assume turns-reuse-one-root-and-append-output-messages ref=continuation-root-regression
describe('continuation message storage', () => {
  it('migrates a legacy database idempotently without losing messages', () => {
    const { owner } = openRoom(store);
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'preserve me' });
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('DROP INDEX IF EXISTS message_run_continuations; ALTER TABLE messages DROP COLUMN run_parent_id;');
    expect((legacy.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count)
      .toBe(1);
    legacy.close();

    store = new Store(path);
    expect(store.listMessages('eng', { limit: 10 }).map((message) => message.body))
      .toEqual(['preserve me']);
    store.close();
    store = new Store(path);
    expect(store.listMessages('eng', { limit: 10 })).toHaveLength(1);

    const reopened = new Database(path, { readonly: true });
    const columns = reopened.pragma('table_info(messages)') as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('run_parent_id');
    expect(reopened.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_run_continuations'",
    ).get()).toBeTruthy();
    reopened.close();
  });

  it('round-trips permanent rows and starts one messages-mode lifecycle root', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'codex', display_name: 'Codex', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'first stretch',
      run: {
        status: 'completed',
        started_ts: '2026-07-18T00:00:00.000Z',
        ended_ts: '2026-07-18T00:01:00.000Z',
        tool_calls: 0,
        events_ref: 'runs/1.jsonl',
        final_text: 'first stretch\ncontinuation stretch',
        output_mode: 'messages',
        result_message_id: 3,
      },
    });
    const interjection = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'please keep going',
    });
    const continuation = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'continuation stretch',
      run_parent_id: root.id,
    });
    expect([root.id, interjection.id, continuation.id]).toEqual([1, 2, 3]);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.listMessages('eng', { limit: 10 }).map((message) => ({
      id: message.id,
      body: message.body,
      parent: message.run_parent_id,
      mode: message.run?.output_mode,
      result: message.run?.result_message_id,
    }))).toEqual([
      { id: 1, body: 'first stretch', parent: undefined, mode: 'messages', result: 3 },
      { id: 2, body: 'please keep going', parent: undefined, mode: undefined, result: undefined },
      { id: 3, body: 'continuation stretch', parent: 1, mode: undefined, result: undefined },
    ]);

    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@codex next' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const current = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:02:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(current?.runMessage.run).toHaveProperty('output_mode', 'messages');
    expect(current?.runMessage.run_parent_id).toBeUndefined();
    const appended = store.createRunContinuation('eng', current!.runMessage.id);
    expect(appended).toMatchObject({
      id: current!.runMessage.id + 1,
      author: agent.id,
      kind: 'run',
      body: '',
      run_parent_id: current!.runMessage.id,
      run: undefined,
    });
    expect(store.listRunMessages('eng', { author: agent.id, limit: 1 })[0]?.id)
      .toBe(current!.runMessage.id);
  });

  // harn:assume run-cost-estimates-are-finalization-snapshots ref=run-estimate-regression
  it('snapshots the explicit model only on a fresh root and preserves it on retry', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'priced', display_name: 'Priced', state: 'running',
    });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@priced go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const first = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:00:00.000Z',
      model: 'gpt-5.6-luna',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    expect(first.runMessage.run?.model).toBe('gpt-5.6-luna');

    const retried = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:01:00.000Z',
      model: 'gpt-5.6-sol',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;
    expect(retried.runMessage.id).toBe(first.runMessage.id);
    expect(retried.runMessage.run?.model).toBe('gpt-5.6-luna');
  });
  // harn:end run-cost-estimates-are-finalization-snapshots
});
// harn:end turns-reuse-one-root-and-append-output-messages

// harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-store-regression
describe('approval delivery resolution migration', () => {
  it('backfills a pre-column answered approval and remains idempotent on reopen', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'legacy-approver', display_name: 'Legacy Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow legacy command?',
      ask: {
        interaction_id: 'legacy-native',
        kind: 'approval',
        prompt: 'Allow legacy command?',
        options: [{ label: 'Allow once' }],
      },
    });
    store.upsertInteraction({
      id: 'legacy-approval', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'legacy-native', kind: 'approval', targets: [owner.id], state: 'pending',
    });
    const delivery = store.createDelivery('eng', {
      message_id: card.id, recipient: owner.id, state: 'consumed',
    });
    const answeredTs = '2026-07-14T09:30:00.000Z';
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.prepare(
      `UPDATE pending_interactions
       SET state = 'acked', answer = '"Allow once"', answered_by = ?, answered_ts = ?
       WHERE id = 'legacy-approval'`,
    ).run(owner.id, answeredTs);
    legacy.prepare('UPDATE deliveries SET read_ts = NULL WHERE id = ?').run(delivery.id);
    legacy.exec('ALTER TABLE deliveries DROP COLUMN interaction_resolved_ts');
    legacy.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      read_ts: answeredTs,
      interaction_resolved_ts: answeredTs,
    });

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      read_ts: answeredTs,
      interaction_resolved_ts: answeredTs,
    });
  });

  it('resolves only target humans on the approval card', () => {
    const { owner } = openRoom(store);
    const outsider = store.addMember('eng', {
      kind: 'human', handle: 'outsider', display_name: 'Outsider', role: 'member',
    });
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'targeted-approver', display_name: 'Targeted Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow targeted command?',
      ask: { interaction_id: 'targeted-native', kind: 'approval', prompt: 'Allow targeted command?' },
    });
    store.upsertInteraction({
      id: 'targeted-approval', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'targeted-native', kind: 'approval', targets: [owner.id], state: 'pending',
    });
    const target = store.createDelivery('eng', {
      message_id: card.id, recipient: owner.id, state: 'consumed',
    });
    const unrelated = store.createDelivery('eng', {
      message_id: card.id, recipient: outsider.id, state: 'consumed',
    });

    const resolved = store.answerApproval(
      'eng', 'targeted-approval', 'Allow once', owner.id, '2026-07-14T10:00:00.000Z',
    );

    expect(resolved.deliveries.map((item) => item.id)).toEqual([target.id]);
    expect(store.getDelivery('eng', unrelated.id)).toMatchObject({
      read_ts: undefined,
      interaction_resolved_ts: undefined,
    });
  });
});
// harn:end approval-deliveries-project-resolution-separately

// harn:assume group-round-creation-is-atomic-and-idempotent ref=collaboration-round-materialization-regression
describe('collaboration round materialization', () => {
  const seed = () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha @beta investigate',
    });
    return { alpha, beta, root };
  };

  it('creates each group round once with stable ordinals, snapshots, and associations', () => {
    const { alpha, beta, root } = seed();
    const roundOne = store.createCollaborationGroup('eng', {
      groupId: 'group-1',
      rootMessageId: root.id,
      createdTs: '2026-07-14T12:00:00.000Z',
      participants: [
        { memberId: beta.id, payloadSnapshot: 'round one for beta' },
        { memberId: alpha.id, payloadSnapshot: 'round one for alpha' },
      ],
    });

    expect(roundOne.group).toMatchObject({
      id: 'group-1', room: 'eng', root_message_id: root.id, state: 'open',
    });
    expect(roundOne.round).toMatchObject({ group_id: 'group-1', round_number: 1, state: 'collecting' });
    expect(roundOne.participants.map((participant) => ({
      ordinal: participant.ordinal,
      member_id: participant.member_id,
      delivery_id: participant.delivery_id,
    }))).toEqual([
      { ordinal: 0, member_id: beta.id, delivery_id: roundOne.deliveries[0]!.id },
      { ordinal: 1, member_id: alpha.id, delivery_id: roundOne.deliveries[1]!.id },
    ]);
    expect(roundOne.deliveries.map((delivery) => ({
      recipient: delivery.recipient,
      group_id: delivery.group_id,
      group_round: delivery.group_round,
    }))).toEqual([
      { recipient: beta.id, group_id: 'group-1', group_round: 1 },
      { recipient: alpha.id, group_id: 'group-1', group_round: 1 },
    ]);
    expect(roundOne.deliveries.map((item) => store.getDeliveryPayloadSnapshot('eng', item.id)))
      .toEqual(['round one for beta', 'round one for alpha']);

    const retried = store.createCollaborationGroup('eng', {
      groupId: 'ignored-on-idempotent-retry',
      rootMessageId: root.id,
      createdTs: '2026-07-14T12:01:00.000Z',
      participants: [
        { memberId: beta.id, payloadSnapshot: 'round one for beta' },
        { memberId: alpha.id, payloadSnapshot: 'round one for alpha' },
      ],
    });
    expect(retried.group.id).toBe('group-1');
    expect(retried.deliveries.map((delivery) => delivery.id))
      .toEqual(roundOne.deliveries.map((delivery) => delivery.id));

    const roundTwo = store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 2,
      createdTs: '2026-07-14T12:02:00.000Z',
      participants: [{ memberId: alpha.id, payloadSnapshot: 'combined prior round' }],
    });
    const roundTwoRetry = store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 2,
      participants: [{ memberId: alpha.id, payloadSnapshot: 'combined prior round' }],
    });
    expect(roundTwoRetry.deliveries.map((delivery) => delivery.id))
      .toEqual(roundTwo.deliveries.map((delivery) => delivery.id));
    expect(store.listDeliveries('eng')).toHaveLength(3);

    expect(() => store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 3,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'duplicate alpha one' },
        { memberId: alpha.id, payloadSnapshot: 'duplicate alpha two' },
      ],
    })).toThrow(`duplicate collaboration participant: ${alpha.id}`);
    expect(store.getCollaborationRound('eng', 'group-1', 3)).toBeUndefined();
  });

  it('rolls back a later round after a participant insert failure', () => {
    const { alpha, beta, root } = seed();
    store.createCollaborationGroup('eng', {
      groupId: 'group-rollback',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha r1' },
        { memberId: beta.id, payloadSnapshot: 'beta r1' },
      ],
    });
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_second_round_participant
      BEFORE INSERT ON collaboration_participants
      WHEN NEW.group_id = 'group-rollback' AND NEW.round_number = 2 AND NEW.ordinal = 1
      BEGIN SELECT RAISE(ABORT, 'injected participant failure'); END`);
    blocker.close();

    expect(() => store.createCollaborationRound('eng', {
      groupId: 'group-rollback',
      roundNumber: 2,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha r2' },
        { memberId: beta.id, payloadSnapshot: 'beta r2' },
      ],
    })).toThrow('injected participant failure');
    expect(store.getCollaborationRound('eng', 'group-rollback', 2)).toBeUndefined();
    expect(store.listDeliveries('eng')).toHaveLength(2);
  });
});
// harn:end group-round-creation-is-atomic-and-idempotent

// harn:assume collaboration-groups-are-durable-state ref=collaboration-store-reopen-regression
describe('collaboration state migration and reopen', () => {
  it('migrates a populated pre-group database and persists a complete projection', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha @beta preserve me',
    });
    const legacyDelivery = store.createDelivery('eng', {
      message_id: root.id, recipient: alpha.id, payload_snapshot: 'legacy snapshot',
    });
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP INDEX IF EXISTS delivery_group_round_recipient_unique;
      DROP INDEX IF EXISTS delivery_group_round_lookup;
      DROP TABLE IF EXISTS collaboration_participants;
      DROP TABLE IF EXISTS collaboration_rounds;
      DROP TABLE IF EXISTS collaboration_groups;
      ALTER TABLE deliveries DROP COLUMN group_round;
      ALTER TABLE deliveries DROP COLUMN group_id;
    `);
    legacy.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMessage('eng', root.id)?.body).toBe('@alpha @beta preserve me');
    expect(store.getDelivery('eng', legacyDelivery.id)).toMatchObject({
      id: legacyDelivery.id, group_id: undefined, group_round: undefined,
    });
    const created = store.createCollaborationGroup('eng', {
      groupId: 'durable-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha grouped' },
        { memberId: beta.id, payloadSnapshot: 'beta grouped' },
      ],
    });
    store.updateCollaborationParticipant('eng', 'durable-group', 1, alpha.id, {
      terminal_status: 'completed',
      result_message_id: root.id,
      completed_ts: '2026-07-14T12:10:00.000Z',
    });
    const expected = store.getCollaborationRoundProjection('eng', 'durable-group', 1);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const reopened = store.getCollaborationRoundProjection('eng', 'durable-group', 1);
    expect(reopened).toEqual(expected);
    expect(reopened?.deliveries.map((delivery) => delivery.id))
      .toEqual(created.deliveries.map((delivery) => delivery.id));
    expect(store.findCollaborationParticipantByDelivery('eng', created.deliveries[1]!.id))
      .toEqual(created.participants[1]);
  });
});
// harn:end collaboration-groups-are-durable-state

// harn:assume eligible-multi-agent-routing-starts-one-group ref=multi-agent-group-regression
describe('atomic routed collaboration ingress', () => {
  it('rolls the root message back when later group materialization fails', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_atomic_group_second_participant
      BEFORE INSERT ON collaboration_participants
      WHEN NEW.group_id = 'atomic-group' AND NEW.ordinal = 1
      BEGIN SELECT RAISE(ABORT, 'injected atomic group failure'); END`);
    blocker.close();

    expect(() => store.commitRoutedMessage('eng', {
      message: {
        author: owner.id,
        kind: 'chat',
        body: '@alpha @beta atomic root',
      },
      plan: (message) => ({
        fanout: [],
        collaboration: {
          groupId: 'atomic-group',
          participants: [
            { memberId: alpha.id, payloadSnapshot: `alpha sees #${message.id}` },
            { memberId: beta.id, payloadSnapshot: `beta sees #${message.id}` },
          ],
        },
      }),
    })).toThrow('injected atomic group failure');
    expect(store.listMessages('eng')).toEqual([]);
    expect(store.getCollaborationGroup('eng', 'atomic-group')).toBeUndefined();
    expect(store.listDeliveries('eng')).toEqual([]);
  });
});
// harn:end eligible-multi-agent-routing-starts-one-group

// harn:assume collaboration-round-release-is-one-barrier ref=collaboration-round-release-store-regression
describe('collaboration round release transaction', () => {
  const seed = (groupId: string) => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: `${groupId}-alpha`, display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: `${groupId}-beta`, display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: `@${alpha.handle} @${beta.handle} release`,
    });
    const round = store.createCollaborationGroup('eng', {
      groupId,
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha round one' },
        { memberId: beta.id, payloadSnapshot: 'beta round one' },
      ],
    });
    return { alpha, beta, root, round };
  };

  it('stays pending until every slot is terminal, then releases only once', () => {
    const seeded = seed('release-group');
    expect(store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:00:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    })).toMatchObject({ status: 'pending', deliveries: [] });

    for (const participant of seeded.round.participants) {
      store.updateCollaborationParticipant(
        'eng',
        'release-group',
        1,
        participant.member_id,
        {
          terminal_status: 'completed',
          result_message_id: seeded.root.id,
          completed_ts: '2026-07-14T12:59:00.000Z',
        },
      );
    }
    const released = store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:00:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    });
    expect(released).toMatchObject({ status: 'released' });
    expect(released.deliveries).toHaveLength(1);
    expect(store.getCollaborationRound('eng', 'release-group', 1)?.state).toBe('released');

    const duplicate = store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:01:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    });
    expect(duplicate).toMatchObject({ status: 'already_released', deliveries: [] });
    expect(store.listDeliveries('eng')).toHaveLength(3);
  });

  it('closes the round and group atomically when there is no next recipient', () => {
    const seeded = seed('closed-group');
    for (const participant of seeded.round.participants) {
      store.updateCollaborationParticipant('eng', 'closed-group', 1, participant.member_id, {
        terminal_status: 'completed',
        result_message_id: seeded.root.id,
        completed_ts: '2026-07-14T13:10:00.000Z',
      });
    }
    expect(store.releaseCollaborationRound('eng', {
      groupId: 'closed-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:11:00.000Z',
      nextParticipants: [],
    })).toMatchObject({ status: 'closed', deliveries: [] });
    expect(store.getCollaborationRound('eng', 'closed-group', 1)?.state).toBe('closed');
    expect(store.getCollaborationGroup('eng', 'closed-group')).toMatchObject({
      state: 'completed', completed_ts: '2026-07-14T13:11:00.000Z',
    });
  });
});
// harn:end collaboration-round-release-is-one-barrier

// harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-reconciliation-regression
describe('atomic collaboration participant skipping', () => {
  it('rolls back delivery consumption when the skipped-slot update fails', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'skip-alpha', display_name: 'Alpha', state: 'dead',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'skip-beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@skip-alpha @skip-beta skip',
    });
    const round = store.createCollaborationGroup('eng', {
      groupId: 'skip-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha' },
        { memberId: beta.id, payloadSnapshot: 'beta' },
      ],
    });
    const alphaDelivery = round.deliveries[0]!;
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_skipped_participant
      BEFORE UPDATE OF terminal_status ON collaboration_participants
      WHEN NEW.delivery_id = '${alphaDelivery.id}'
      BEGIN SELECT RAISE(ABORT, 'injected skipped-slot failure'); END`);
    blocker.close();

    expect(() => store.skipCollaborationParticipant(
      'eng', alphaDelivery.id, '2026-07-14T13:20:00.000Z',
    )).toThrow('injected skipped-slot failure');
    expect(store.getDelivery('eng', alphaDelivery.id)?.state).toBe('queued');
    expect(store.findCollaborationParticipantByDelivery('eng', alphaDelivery.id)?.terminal_status)
      .toBeUndefined();
  });
});
// harn:end open-collaboration-groups-reconcile-without-resurrection

// harn:assume substantive-output-messages-drive-unread ref=message-activity-regression
// harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-regression
describe('durable room read activity', () => {
  it('counts only incoming chat and finalized non-ack runs at their content edge', () => {
    const { owner, system } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const started = '2026-07-18T10:00:00.000Z';

    const incoming = store.postMessage('eng', {
      author: agent.id, kind: 'chat', body: 'first result',
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'my own note' });
    store.postMessage('eng', { author: system.id, kind: 'system', body: 'maintenance' });
    store.postMessage('eng', {
      author: agent.id, kind: 'ask', body: 'choose',
      ask: { interaction_id: 'ask-read', kind: 'ask', prompt: 'choose' },
    });
    store.postMessage('eng', {
      author: agent.id, kind: 'approval', body: 'approve',
      ask: { interaction_id: 'approval-read', kind: 'approval', prompt: 'approve' },
    });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/read.jsonl' },
    });
    store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '<ACK_OK>',
      ack: true,
      run: {
        status: 'completed', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/ack.jsonl', final_text: '<ACK_OK>',
      },
    });

    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
    store.setMessagePinned('eng', incoming.id, true);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);

    store.updateMessage('eng', run.id, {
      body: 'second result',
      run: {
        ...run.run!, status: 'completed', ended_ts: started, final_text: 'second result',
      },
    });
    expect(store.countUnreadMessages('eng', owner.id)).toBe(2);

    store.deleteMessage('eng', incoming.id);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
    const read = store.markRoomRead('eng', owner.id, store.currentSeq('eng'));
    expect(read.read_seq).toBe(store.currentSeq('eng'));
    expect(store.countUnreadMessages('eng', owner.id)).toBe(0);

    const late = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/late.jsonl' },
    });
    store.markRoomRead('eng', owner.id, store.currentSeq('eng'));
    store.updateMessage('eng', late.id, {
      body: 'arrived after the read edge',
      run: {
        ...late.run!, status: 'completed', ended_ts: started,
        final_text: 'arrived after the read edge',
      },
    });
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
  });

  it('advances monotonically, rejects the future, and clears visible consumed deliveries', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const body = 'Need @richard';
    const message = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body,
      mentions: [{ member_id: owner.id, start: 5, end: 13 }],
    });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: owner.id, state: 'consumed',
    });
    const through = store.currentSeq('eng');
    expect(store.roomSupport('eng', owner.id).inbox.map((item) => item.delivery.id))
      .toEqual([delivery.id]);

    const first = store.markRoomRead('eng', owner.id, through);
    expect(first.deliveries.map((item) => item.id)).toEqual([delivery.id]);
    expect(store.getDelivery('eng', delivery.id)?.read_ts).toBeDefined();
    expect(store.roomSupport('eng', owner.id).inbox).toEqual([]);

    expect(store.markRoomRead('eng', owner.id, through - 1)).toEqual({
      read_seq: through,
      deliveries: [],
    });
    expect(store.markRoomRead('eng', owner.id, through)).toEqual({
      read_seq: through,
      deliveries: [],
    });
    expect(() => store.markRoomRead('eng', owner.id, store.currentSeq('eng') + 1))
      .toThrow('ahead of current seq');
    expect(() => store.markRoomRead('eng', agent.id, through)).toThrow('no human member');
  });

  it('migrates legacy activity and baselines every existing and new human idempotently', () => {
    const { owner, system } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    store.postMessage('eng', { author: agent.id, kind: 'chat', body: 'legacy result' });
    store.postMessage('eng', { author: system.id, kind: 'system', body: 'legacy notice' });
    store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '<ACK_OK>', ack: true,
      run: {
        status: 'completed', started_ts: '2026-07-18T10:00:00.000Z',
        ended_ts: '2026-07-18T10:00:01.000Z', tool_calls: 0,
        events_ref: 'runs/legacy-ack.jsonl', final_text: '<ACK_OK>',
      },
    });
    const expectedMessages = store.listMessages('eng').length;
    const expectedSeq = store.currentSeq('eng');
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('DROP INDEX IF EXISTS message_unread_activity; DROP TABLE room_read_cursors; ALTER TABLE messages DROP COLUMN activity_seq;');
    legacy.close();

    store = new Store(path);
    expect(store.listMessages('eng')).toHaveLength(expectedMessages);
    expect(store.getRoomReadSeq('eng', owner.id)).toBe(expectedSeq);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(0);
    const newcomer = store.addMember('eng', {
      kind: 'human', handle: 'viewer', display_name: 'Viewer', role: 'observer',
    });
    expect(store.getRoomReadSeq('eng', newcomer.id)).toBe(store.currentSeq('eng'));
    store.close();

    store = new Store(path);
    expect(store.getRoomReadSeq('eng', owner.id)).toBe(expectedSeq);
    expect(store.getRoomReadSeq('eng', newcomer.id)).toBe(store.currentSeq('eng'));
    const migrated = new Database(path, { readonly: true });
    const activities = migrated.prepare(
      'SELECT kind, ack, activity_seq FROM messages ORDER BY id',
    ).all() as { kind: string; ack: number; activity_seq: number | null }[];
    migrated.close();
    expect(activities.map((row) => row.activity_seq !== null)).toEqual([true, false, false]);
  });
});
// harn:end human-room-read-cursors-are-durable-and-monotonic
// harn:end substantive-output-messages-drive-unread

// harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-regression
// harn:assume actionable-inbox-clears-on-read-or-reply ref=actionable-inbox-regression
// harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-regression
describe('recipient-scoped room support and strict addressed hydration', () => {
  it('keeps routing, live work, interactions, and actionable inbox outside the exact tail', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'running',
    });
    const started = '2026-07-18T10:00:00.000Z';
    const live = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/live.jsonl' },
    });
    const card = store.postMessage('eng', {
      author: agent.id, kind: 'ask', body: 'Which path?',
      ask: { interaction_id: 'support-ask', kind: 'ask', prompt: 'Which path?' },
    });
    store.upsertInteraction({
      id: 'support-ask', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'native-support-ask', kind: 'ask', targets: [owner.id], state: 'pending',
    });
    const mentionBody = 'Review @richard';
    const mention = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body: mentionBody,
      mentions: [{ member_id: owner.id, start: 7, end: 15 }],
    });
    const actionable = store.createDelivery('eng', {
      message_id: mention.id, recipient: owner.id, state: 'consumed',
    });
    const untagged = store.postMessage('eng', {
      author: agent.id, kind: 'chat', body: 'default-routed noise',
    });
    store.createDelivery('eng', {
      message_id: untagged.id, recipient: owner.id, state: 'consumed',
    });
    const finalized = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: 'routing seed',
      run: {
        status: 'completed', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/final.jsonl', final_text: 'routing seed',
      },
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail one' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail two' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail three' });

    const strict = store.sync('eng', 0, {
      hydrateLimit: 3, subscriber: owner.id, strictTail: true, supportFor: owner.id,
    });
    expect(strict.messages.map((message) => message.body)).toEqual(['tail one', 'tail two', 'tail three']);
    expect(strict.messages).toHaveLength(3);
    expect(strict.history_floor).toBe(strict.messages[0]?.id);
    expect(strict.support?.active_runs.map((message) => message.id)).toEqual([live.id]);
    expect(strict.support?.interactions.map((message) => message.id)).toEqual([card.id]);
    expect(strict.support?.latest_finalized_agent_id).toBe(agent.id);
    expect(strict.support?.inbox.map((item) => item.delivery.id)).toEqual([actionable.id]);
    expect(strict.support?.inbox[0]).toMatchObject({
      author_handle: 'coder', message_kind: 'chat', preview: mentionBody,
    });
    expect(strict.support?.summary.working).toBe(true);
    expect(strict.support?.summary.latest?.id).toBe(strict.messages.at(-1)?.id);

    const legacy = store.sync('eng', 0, { hydrateLimit: 3, subscriber: owner.id });
    expect(legacy.messages.length).toBeGreaterThan(3);
    expect(legacy.messages.map((message) => message.id)).toContain(live.id);
    expect(legacy.messages.map((message) => message.id)).toContain(card.id);
    expect(legacy.messages.map((message) => message.id)).toContain(finalized.id);
    expect(legacy.support).toBeUndefined();
  });

  it('removes mention work after a formal self reply and bounds every preview', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const body = `@richard ${'x'.repeat(300)}`;
    const source = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body,
      mentions: [{ member_id: owner.id, start: 0, end: 8 }],
    });
    store.createDelivery('eng', {
      message_id: source.id, recipient: owner.id, state: 'consumed',
    });
    expect(store.roomSupport('eng', owner.id).inbox[0]?.preview).toHaveLength(140);
    store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'Handled', reply_to: source.id,
    });
    expect(store.roomSupport('eng', owner.id).inbox).toEqual([]);
  });
});
// harn:end addressed-cold-hydration-is-strict-and-legacy-safe
// harn:end actionable-inbox-clears-on-read-or-reply
// harn:end room-support-is-bounded-recipient-scoped-state
