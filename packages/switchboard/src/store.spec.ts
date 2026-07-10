import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from './store.js';

let dir: string;
let store: Store;

const openRoom = (s: Store) =>
  s.createRoom({ id: 'eng', name: 'Engineering', owner: { handle: 'richard', display_name: 'Richard' } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-store-'));
  store = new Store(join(dir, 'test.sqlite'));
});

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
    });
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const revived = store.getMember('eng', agent.id)!;
    expect(revived.cwd).toBe('/home/user/project');
    expect(revived.policy).toBe('workspace-write');
    expect(revived.session_ref).toBe('019f4ae0-8022-7a92-b81a-60e25f3f1c22');
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
    const delivery = store.createDelivery('eng', { message_id: message.id, recipient: agent.id });
    expect(delivery.state).toBe('queued');
    expect(delivery.attempt_count).toBe(0);

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
