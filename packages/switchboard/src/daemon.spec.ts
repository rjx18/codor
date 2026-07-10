import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@wireroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';

let dir: string;
let fake: FakeAdapter;
let daemon: Daemon;
let frames: { room: string; frame: ServerFrame }[];

function newDaemon(): Daemon {
  const d = new Daemon({
    dbPath: join(dir, 'switchboard.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
  });
  d.onFrame((room, frame) => frames.push({ room, frame }));
  return d;
}

async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-daemon-'));
  fake = new FakeAdapter();
  frames = [];
  daemon = newDaemon();
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
});

afterEach(() => {
  daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const spawnAgent = (handle: string, cwd = '/work') =>
  daemon.spawnMember('eng', { harness: 'fake', handle, cwd });

const runMessages = () =>
  daemon.store.listMessages('eng', { limit: 100 }).filter((m) => m.kind === 'run');

describe('reply-is-the-run-message chaining', () => {
  it('a two-agent chain produces exactly ONE message per turn, routed from the finalized run', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    fake.enqueue(
      { kind: 'complete', final_text: '@beta your turn, see my analysis' },
      { kind: 'complete', final_text: 'done @richard' },
    );

    daemon.postHumanMessage('eng', '@alpha analyse the thing');
    await daemon.settle();

    const runs = runMessages();
    expect(runs).toHaveLength(2); // one per turn — never a separate reply msg
    const [alphaRun, betaRun] = runs;
    expect(alphaRun!.author).toBe(alpha.id);
    expect(alphaRun!.body).toBe('@beta your turn, see my analysis');
    expect(alphaRun!.run!.status).toBe('completed');
    // beta's delivery came FROM alpha's finalized run message id
    const betaDeliveries = daemon.store.listDeliveries('eng', { recipient: beta.id });
    expect(betaDeliveries).toHaveLength(1);
    expect(betaDeliveries[0]!.message_id).toBe(alphaRun!.id);
    expect(betaDeliveries[0]!.state).toBe('consumed');
    // beta's untagged reply defaulted back to… richard was mentioned
    expect(betaRun!.body).toBe('done @richard');
    // richard got an inbox record, never a turn
    const owner = daemon.ownerOf('eng');
    const inbox = daemon.store.listDeliveries('eng', { recipient: owner.id });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.state).toBe('consumed');
    expect(daemon.unreadCount('eng', owner.id)).toBe(1);
  });

  it('the finalized run payload delivered onward contains the wireroom header from the run message', async () => {
    spawnAgent('alpha');
    spawnAgent('beta');
    fake.enqueue(
      { kind: 'complete', final_text: '@beta please verify' },
      { kind: 'complete', final_text: 'verified' },
    );
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();
    const betaPayload = fake.deliveries[1]!.payload;
    const alphaRunId = runMessages()[0]!.id;
    expect(betaPayload).toContain(`msg=#${alphaRunId} from=@alpha (agent)`);
    expect(betaPayload).toContain('@beta please verify');
  });

  it('an untagged agent reply defaults to the trigger author (the delegator)', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    fake.enqueue(
      { kind: 'complete', final_text: '@beta compute it' },
      { kind: 'complete', final_text: 'the answer is 42' }, // untagged
      { kind: 'complete', final_text: '@richard chain complete' }, // ends the chain at a human
    );
    daemon.postHumanMessage('eng', '@alpha delegate something');
    await daemon.settle();
    // beta's untagged reply routed back to alpha (its trigger author)
    const alphaDeliveries = daemon.store.listDeliveries('eng', { recipient: alpha.id });
    expect(alphaDeliveries.length).toBe(2); // original + beta's reply
    const betaRun = runMessages().find((m) => m.author === beta.id)!;
    expect(alphaDeliveries[1]!.message_id).toBe(betaRun.id);
  });
});

describe('one inflight turn per member', () => {
  it('deliveries during a run queue and drain as ONE batched turn', async () => {
    spawnAgent('alpha');
    fake.enqueue(
      { kind: 'complete', final_text: 'first done' },
      { kind: 'complete', final_text: 'batch done' },
    );
    daemon.postHumanMessage('eng', '@alpha task one');
    daemon.postHumanMessage('eng', '@alpha task two');
    daemon.postHumanMessage('eng', '@alpha task three');
    await daemon.settle();

    expect(fake.maxConcurrent).toBe(1); // never two turns on one session
    expect(fake.deliveries).toHaveLength(2); // first turn + one batched turn
    const batched = fake.deliveries[1]!.payload;
    expect(batched).toContain('task two');
    expect(batched).toContain('task three'); // both headers in one payload
    expect(runMessages()).toHaveLength(2);
  });
});

describe('interactions: the full state machine', () => {
  it('ask → pending card → answered → acked → run resumes', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Which codeword?', options: [{ label: 'ALPHA' }, { label: 'BETA' }] },
      reply: (answer) => `chose ${String(answer)}`,
    });
    daemon.postHumanMessage('eng', '@alpha pick one');

    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('awaiting_input');
    const card = daemon.store.getMessage('eng', interaction.message_id)!;
    expect(card.kind).toBe('ask');
    expect(card.ask!.prompt).toBe('Which codeword?');
    // the card landed in the owner's inbox
    const owner = daemon.ownerOf('eng');
    expect(
      daemon.store.listDeliveries('eng', { recipient: owner.id }).some((d) => d.message_id === card.id),
    ).toBe(true);

    await daemon.answerInteraction('eng', interaction.id, 'ALPHA', owner.id);
    await daemon.settle();

    const after = daemon.store.getInteraction(interaction.id)!;
    expect(after.state).toBe('acked');
    expect(after.answer).toBe('ALPHA');
    expect(after.answered_by).toBe(owner.id);
    expect(fake.respondCalls).toEqual([{ interaction_id: interaction.native_id, answer: 'ALPHA' }]);
    const run = runMessages()[0]!;
    expect(run.run!.status).toBe('completed');
    expect(run.body).toBe('chose ALPHA');
  });

  it('the audit reply on the card never routes (no delivery, no turn)', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Proceed?', options: [{ label: 'yes' }] },
      reply: () => 'proceeding',
    });
    daemon.postHumanMessage('eng', '@alpha check something');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    const deliveriesBefore = daemon.store.listDeliveries('eng', { recipient: alpha.id }).length;
    await daemon.answerInteraction('eng', interaction.id, 'yes');
    await daemon.settle();

    const audit = daemon.store
      .listMessages('eng', { limit: 100 })
      .find((m) => m.reply_to === interaction.message_id)!;
    expect(audit.body).toBe('yes');
    // exactly the original delivery — the audit reply queued NOTHING new
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id }).length).toBe(deliveriesBefore);
    expect(fake.deliveries).toHaveLength(1);
  });
});

describe('kill-point matrix (boot reconcile)', () => {
  it('provably completed (blob has run.completed) → finalized from the journal, no re-run', async () => {
    const alpha = spawnAgent('alpha');
    // Construct the crash scene: run placeholder + delivering delivery +
    // a blob that already contains the completion (post-kill orphan write).
    const trigger = daemon.postHumanMessage('eng', 'setup');
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 1, run_msg_id: runMsg.id });
    daemon.blobs.append('eng', runMsg.run!.events_ref, {
      type: 'run.completed',
      status: 'completed',
      final_text: 'survived the crash @richard',
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const finalized = daemon.store.getMessage('eng', runMsg.id)!;
    expect(finalized.run!.status).toBe('completed');
    expect(finalized.body).toBe('survived the crash @richard');
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
    expect(fake.deliveries).toHaveLength(0); // never re-ran the turn
    // onward routing fired from the finalized message
    expect(daemon.unreadCount('eng', daemon.ownerOf('eng').id)).toBeGreaterThan(0);
  });

  it('provably never started (empty blob, first attempt) → retried ONCE reusing the same run message', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.postHumanMessage('eng', 'setup two');
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 1, run_msg_id: runMsg.id });
    // NO blob file — provably never started
    daemon.close();

    daemon = newDaemon();
    const runCountBefore = runMessages().length;
    fake.enqueue({ kind: 'complete', final_text: 'retry worked' });
    await daemon.reconcile();
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(1); // exactly one retry
    expect(runMessages().length).toBe(runCountBefore); // NO second run message
    const finalized = daemon.store.getMessage('eng', runMsg.id)!;
    expect(finalized.run!.status).toBe('completed');
    expect(finalized.body).toBe('retry worked');
    const after = daemon.store.getDelivery('eng', delivery.id)!;
    expect(after.state).toBe('consumed');
    expect(after.attempt_count).toBe(2);
  });

  it('ambiguous (events but no completion) → HELD with a system message; release_hold retries', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.postHumanMessage('eng', 'setup three');
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 1, run_msg_id: runMsg.id });
    daemon.blobs.append('eng', runMsg.run!.events_ref, {
      type: 'run.item',
      item_type: 'text_delta',
      payload: 'was mid-flight',
    });
    daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    expect(fake.deliveries).toHaveLength(0); // never silently re-delivered
    const held = daemon.store
      .listMessages('eng', { limit: 100 })
      .find((m) => m.kind === 'system' && m.body.includes('held'));
    expect(held).toBeDefined();

    fake.enqueue({ kind: 'complete', final_text: 'released and done' });
    daemon.releaseHold('eng', delivery.id);
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
  });

  it('a second failure is NOT retried again (retry once, then hold)', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.postHumanMessage('eng', 'setup four');
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 2, run_msg_id: runMsg.id });
    daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    expect(fake.deliveries).toHaveLength(0);
  });
});

describe('restart while blocked on an ask', () => {
  async function crashWhileBlocked() {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] },
      reply: (a) => `went ${String(a)}`,
    });
    daemon.postHumanMessage('eng', '@alpha choose');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    return { alpha, interaction };
  }

  it('pending ask re-raises on retry → re-correlated (same interaction, fresh native id), then answerable', async () => {
    const { alpha, interaction } = await crashWhileBlocked();
    const nativeBefore = interaction.native_id;
    daemon.close(); // crash: the blocked run dies with the daemon

    daemon = newDaemon();
    // the retried turn re-raises the SAME semantic ask (fresh native id)
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] },
      reply: (a) => `went ${String(a)}`,
    });
    await daemon.reconcile();

    const recorrelated = await until(() => {
      const i = daemon.store.getInteraction(interaction.id);
      return i && i.native_id !== nativeBefore ? i : undefined;
    });
    expect(recorrelated.state).toBe('pending'); // same row, fresh native id
    expect(daemon.store.listInteractions('eng').filter((i) => i.member_id === alpha.id)).toHaveLength(1);

    await daemon.answerInteraction('eng', interaction.id, 'left');
    await daemon.settle();
    expect(daemon.store.getInteraction(interaction.id)!.state).toBe('acked');
    expect(runMessages()[0]!.body).toBe('went left');
  });

  it('answered-but-unacked ASK replays the stored answer idempotently on re-raise', async () => {
    const { interaction } = await crashWhileBlocked();
    // answer lands, but the daemon dies before the ack: persist answered state
    daemon.store.upsertInteraction({
      ...daemon.store.getInteraction(interaction.id)!,
      state: 'answered',
      answer: 'right',
      answered_by: daemon.ownerOf('eng').id,
      answered_ts: new Date().toISOString(),
    });
    daemon.close();

    daemon = newDaemon();
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] },
      reply: (a) => `went ${String(a)}`,
    });
    await daemon.reconcile();
    await until(() => (daemon.store.getInteraction(interaction.id)!.state === 'acked' ? true : undefined));
    await daemon.settle();

    expect(fake.respondCalls.at(-1)!.answer).toBe('right'); // replayed, not re-asked
    expect(runMessages()[0]!.body).toBe('went right');
  });

  it('answered-but-unacked APPROVAL is never auto-resent: orphaned + fresh card', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'approval', prompt: 'Allow Bash?', tool: 'Bash', options: [{ label: 'allow once' }, { label: 'deny' }] },
      reply: (a) => `approval ${String(a)}`,
    });
    daemon.postHumanMessage('eng', '@alpha try a command');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    daemon.store.upsertInteraction({
      ...daemon.store.getInteraction(interaction.id)!,
      state: 'answered',
      answer: 'allow once',
      answered_by: daemon.ownerOf('eng').id,
      answered_ts: new Date().toISOString(),
    });
    daemon.close();

    daemon = newDaemon();
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'approval', prompt: 'Allow Bash?', tool: 'Bash', options: [{ label: 'allow once' }, { label: 'deny' }] },
      reply: (a) => `approval ${String(a)}`,
    });
    await daemon.reconcile();
    const fresh = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );

    expect(daemon.store.getInteraction(interaction.id)!.state).toBe('orphaned');
    expect(fresh.id).not.toBe(interaction.id); // a NEW card awaits a human
    expect(fake.respondCalls).toHaveLength(0); // the approval was NOT auto-resent
    expect(
      daemon.store.listMessages('eng', { limit: 100 }).some((m) => m.kind === 'system' && m.body.includes('expired')),
    ).toBe(true);
  });

  it('a turn that never re-raises orphans the leftover interaction (expired card)', async () => {
    const { interaction } = await crashWhileBlocked();
    daemon.close();

    daemon = newDaemon();
    fake.enqueue({ kind: 'complete', final_text: 'finished without asking' }); // no re-raise
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getInteraction(interaction.id)!.state).toBe('orphaned');
    expect(
      daemon.store.listMessages('eng', { limit: 100 }).some((m) => m.kind === 'system' && m.body.includes('expired')),
    ).toBe(true);
  });
});

describe('human inbox lifecycle + sync', () => {
  it('inbox arrival → unread count → mark_read → zero; sync reflects it', async () => {
    spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard need your eyes on this' });
    daemon.postHumanMessage('eng', '@alpha report to me');
    await daemon.settle();

    const owner = daemon.ownerOf('eng');
    expect(daemon.unreadCount('eng', owner.id)).toBe(1);
    const delivery = daemon.store.listDeliveries('eng', { recipient: owner.id })[0]!;

    const cursor = daemon.store.currentSeq('eng');
    daemon.markRead('eng', delivery.id);
    expect(daemon.unreadCount('eng', owner.id)).toBe(0);

    const sync = daemon.sync('eng', cursor);
    expect(sync.inbox).toHaveLength(1);
    expect(sync.inbox[0]!.read_ts).toBeDefined();
  });

  it('sync across a run finalization returns the message once, in final state', async () => {
    spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: 'all wrapped up' });
    const cursor = daemon.store.currentSeq('eng');
    daemon.postHumanMessage('eng', '@alpha wrap it up');
    await daemon.settle();

    const sync = daemon.sync('eng', cursor);
    const runs = sync.messages.filter((m) => m.kind === 'run');
    expect(runs).toHaveLength(1); // hydrated once despite post + finalize
    expect(runs[0]!.run!.status).toBe('completed');
    expect(runs[0]!.body).toBe('all wrapped up');
    expect(sync.seq).toBe(daemon.store.currentSeq('eng'));
  });
});

describe('revive uses the persisted cwd after restart', () => {
  it('a restarted daemon rebuilds the session from the member row (cwd + session_ref)', async () => {
    const alpha = spawnAgent('alpha', '/persisted/workdir');
    fake.enqueue({ kind: 'complete', final_text: 'first turn' });
    daemon.postHumanMessage('eng', '@alpha hello');
    await daemon.settle();
    const ref = daemon.store.getMember('eng', alpha.id)!.session_ref;
    expect(ref).toBeDefined();
    daemon.close();

    daemon = newDaemon(); // fresh process: in-memory sessions are gone
    fake.enqueue({ kind: 'complete', final_text: 'revived turn' });
    daemon.postHumanMessage('eng', '@alpha again');
    await daemon.settle();

    const second = fake.deliveries.at(-1)!;
    expect(second.cwd).toBe('/persisted/workdir'); // persisted cwd reused
    expect(second.session_ref).toBe(ref); // resumed, not respawned
    expect(fake.wasAttached(ref!)).toBe(true);
  });
});

describe('redaction before fanout', () => {
  it('frames and sync are redacted; the store and blob keep raw bytes', async () => {
    spawnAgent('alpha');
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    fake.enqueue({
      kind: 'complete',
      final_text: `@richard found creds ${secret} and ghp_abcdefghijklmnopqrstuv123456 in the repo`,
      items: [{ type: 'run.item', item_type: 'text_delta', payload: `leaked sk-proj-abcdef1234567890abcdef` }],
    });
    daemon.postHumanMessage('eng', '@alpha scan for secrets');
    await daemon.settle();

    const run = runMessages()[0]!;
    expect(run.body).toContain(secret); // raw in the store…
    const framed = frames.filter((f) => f.frame.type === 'message').map((f) => JSON.stringify(f.frame));
    expect(framed.some((f) => f.includes(secret))).toBe(false); // …never in frames
    expect(framed.some((f) => f.includes('[redacted]'))).toBe(true);
    expect(JSON.stringify(frames.filter((f) => f.frame.type === 'run_event'))).not.toContain('sk-proj-');

    const sync = daemon.sync('eng', 0);
    expect(JSON.stringify(sync)).not.toContain(secret);
    expect(JSON.stringify(daemon.readRunBlob('eng', run.id))).not.toContain('sk-proj-');
    // raw blob on disk untouched
    expect(JSON.stringify(daemon.blobs.read('eng', run.run!.events_ref))).toContain('sk-proj-');
  });

  it('the per-room opt-out disables the projection', async () => {
    daemon.store.updateRoomConfig('eng', { redaction_enabled: false });
    spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard key AKIAIOSFODNN7EXAMPLE here' });
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();
    const framed = frames.filter((f) => f.frame.type === 'message').map((f) => JSON.stringify(f.frame));
    expect(framed.some((f) => f.includes('AKIAIOSFODNN7EXAMPLE'))).toBe(true);
  });
});

describe('failed turns', () => {
  it('a failed run marks the member dead with a system message; revive requeues', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: 'exploded', status: 'failed' });
    daemon.postHumanMessage('eng', '@alpha do a thing');
    await daemon.settle();

    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('dead');
    expect(
      daemon.store.listMessages('eng', { limit: 50 }).some((m) => m.kind === 'system' && m.body.includes('died')),
    ).toBe(true);

    fake.enqueue({ kind: 'complete', final_text: 'better now' });
    daemon.postHumanMessage('eng', '@alpha try again'); // queues while dead
    await daemon.settle();
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(1);

    daemon.reviveMember('eng', alpha.id);
    await daemon.settle();
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(0);
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
  });
});
