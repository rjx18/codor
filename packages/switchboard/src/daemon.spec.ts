import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@wireroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';

let dir: string;
let fake: FakeAdapter;
let claudeFake: FakeAdapter;
let codexFake: FakeAdapter;
let daemon: Daemon;
let frames: { room: string; frame: ServerFrame }[];

function newDaemon(): Daemon {
  const d = new Daemon({
    dbPath: join(dir, 'switchboard.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake, claudeFake, codexFake],
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
  fake = new FakeAdapter('fake', { interactiveAttach: true });
  claudeFake = new FakeAdapter('claude-code');
  codexFake = new FakeAdapter('codex');
  frames = [];
  daemon = newDaemon();
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
});

afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const spawnAgent = (handle: string, cwd = '/work') =>
  daemon.spawnMember('eng', { harness: 'fake', handle, cwd });

const runMessages = () =>
  daemon.store.listMessages('eng', { limit: 100 }).filter((m) => m.kind === 'run');

describe('member management', () => {
  it('renames mid-queue without retargeting mentions and rejects duplicate handles', async () => {
    const alpha = spawnAgent('alpha');
    spawnAgent('beta');
    fake.enqueue(
      {
        kind: 'ask',
        card: { kind: 'ask', prompt: 'Hold this turn?', options: [{ label: 'continue' }] },
        reply: () => 'first done',
      },
      { kind: 'complete', final_text: '@richard queued work done' },
    );
    daemon.postHumanMessage('eng', '@alpha start');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    const queuedMessage = daemon.postHumanMessage('eng', '@alpha queued work');
    expect(daemon.memberDetails('eng').find((item) => item.member.id === alpha.id)!.queued_count).toBe(1);

    expect(() => daemon.renameMember('eng', alpha.id, 'beta')).toThrow('already in use');
    const renamed = daemon.renameMember('eng', alpha.id, 'gamma', 'Gamma');
    expect(renamed.id).toBe(alpha.id);
    expect(queuedMessage.mentions).toEqual([
      expect.objectContaining({ member_id: alpha.id }),
    ]);
    const notice = daemon.store.listMessages('eng', { limit: 100 }).at(-1)!;
    expect(notice.kind).toBe('system');
    expect(notice.mentions.map((mention) => mention.member_id)).toEqual([alpha.id, alpha.id]);

    await daemon.answerInteraction('eng', interaction.id, 'continue');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(2);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })).toHaveLength(2);
  });

  it('pause holds the FIFO and unpause drains it as one turn', async () => {
    const alpha = spawnAgent('alpha');
    daemon.pauseMember('eng', alpha.id);
    daemon.postHumanMessage('eng', '@alpha one');
    daemon.postHumanMessage('eng', '@alpha two');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.memberDetails('eng').find((item) => item.member.id === alpha.id)!.queued_count).toBe(2);

    fake.enqueue({ kind: 'complete', final_text: '@richard both done' });
    daemon.unpauseMember('eng', alpha.id);
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]!.payload).toContain('@alpha one');
    expect(fake.deliveries[0]!.payload).toContain('@alpha two');
  });

  it('kill leaves a revivable dead member and revive attaches the exact session ref', async () => {
    const alpha = spawnAgent('alpha', '/persisted/work');
    fake.enqueue({ kind: 'complete', final_text: '@richard ready' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    const sessionRef = daemon.store.getMember('eng', alpha.id)!.session_ref!;

    expect(daemon.killMember('eng', alpha.id).state).toBe('dead');
    daemon.postHumanMessage('eng', '@alpha resume this');
    await daemon.settle();
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(1);

    fake.enqueue({ kind: 'complete', final_text: '@richard revived' });
    daemon.reviveMember('eng', alpha.id);
    await daemon.settle();
    expect(fake.wasAttached(sessionRef)).toBe(true);
    expect(fake.deliveries.at(-1)).toMatchObject({
      session_ref: sessionRef,
      cwd: '/persisted/work',
      attached: true,
    });
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
  });

  it('kill while blocked orphans the card and finalization preserves dead state', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Keep waiting?', options: [{ label: 'yes' }] },
      reply: () => 'unreachable',
    });
    daemon.postHumanMessage('eng', '@alpha block');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    daemon.killMember('eng', alpha.id);
    await daemon.settle();
    expect(daemon.store.getInteraction(interaction.id)!.state).toBe('orphaned');
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('dead');
  });
});

describe('mirrored join and adoption', () => {
  it('holds inbound deliveries, mirrors one routed run per native turn, then adopts and drains', async () => {
    const planner = daemon.joinMember('eng', {
      harness: 'fake',
      handle: 'planner',
      session_ref: 'native-planner-session',
      cwd: '/work/planning',
    });
    const reviewer = spawnAgent('reviewer');
    daemon.postHumanMessage('eng', '@planner draft the plan');
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.getMember('eng', planner.id)).toMatchObject({
      custody: 'mirrored',
      state: 'queued',
    });
    expect(daemon.memberDetails('eng').find((item) => item.member.id === planner.id)!.queued_count).toBe(1);
    expect(
      daemon.store.listMessages('eng', { limit: 50 }).some(
        (message) => message.kind === 'system' && message.body.includes('operator terminal'),
      ),
    ).toBe(true);

    fake.enqueue(
      { kind: 'complete', final_text: '@richard review complete' },
      { kind: 'complete', final_text: '@richard queued plan complete' },
    );
    const first = daemon.mirrorTurn({
      harness: 'fake',
      session_ref: 'native-planner-session',
      native_turn_id: 'native-turn-7',
      body: '@reviewer check this plan',
      transcript_path: '/native/transcript.jsonl',
    });
    const duplicate = daemon.mirrorTurn({
      harness: 'fake',
      session_ref: 'native-planner-session',
      native_turn_id: 'native-turn-7',
      body: 'must not replace the first body',
    });
    expect(first.deduped).toBe(false);
    expect(duplicate).toMatchObject({ deduped: true, message: { id: first.message.id } });
    expect(first.message).toMatchObject({
      kind: 'run',
      author: planner.id,
      body: '@reviewer check this plan',
      run: { status: 'completed', final_text: '@reviewer check this plan' },
    });
    expect(first.message.mentions).toEqual([
      expect.objectContaining({ member_id: reviewer.id }),
    ]);
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(1);

    const adopted = daemon.adoptMember('eng', planner.id);
    expect(adopted.custody).toBe('owned');
    await daemon.settle();
    expect(fake.wasAttached('native-planner-session')).toBe(true);
    expect(fake.deliveries).toHaveLength(2);
    expect(fake.deliveries[1]!.payload).toContain('draft the plan');
  });

  it('auto-adopts only a Claude SessionEnd; Codex remains explicit', () => {
    const claude = daemon.joinMember('eng', {
      harness: 'claude-code',
      handle: 'claude-live',
      session_ref: 'claude-session-1',
      cwd: '/work',
    });
    const codex = daemon.joinMember('eng', {
      harness: 'codex',
      handle: 'codex-live',
      session_ref: 'codex-session-1',
      cwd: '/work',
    });

    expect(daemon.mirrorSessionEnd('codex', 'codex-session-1')).toBe(false);
    expect(daemon.store.getMember('eng', codex.id)!.custody).toBe('mirrored');
    expect(daemon.mirrorSessionEnd('claude-code', 'claude-session-1')).toBe(true);
    expect(daemon.store.getMember('eng', claude.id)!.custody).toBe('owned');
    expect(claudeFake.wasAttached('claude-session-1')).toBe(true);
  });
});

describe('interactive attach custody leases', () => {
  it('waits for the current turn, holds racing deliveries, and drains after clean exit', async () => {
    const alpha = spawnAgent('alpha', '/persisted/work');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    const sessionRef = daemon.store.getMember('eng', alpha.id)!.session_ref!;

    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Finish before attach?', options: [{ label: 'yes' }] },
      reply: () => '@richard current turn finished',
    });
    daemon.postHumanMessage('eng', '@alpha begin current turn');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    const acquisition = daemon.acquireAttachLease('eng', alpha.id, 1234);
    daemon.postHumanMessage('eng', '@alpha queued while attach waits');
    await daemon.answerInteraction('eng', interaction.id, 'yes');
    const { lease, member } = await acquisition;

    expect(member).toMatchObject({ custody: 'mirrored', state: 'queued' });
    expect(fake.deliveries).toHaveLength(2);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(1);
    daemon.reportAttachChild(lease.id, 999_998, 999_998);
    expect(() => daemon.adoptMember('eng', alpha.id)).toThrow('active interactive attach lease');

    fake.enqueue({ kind: 'complete', final_text: '@richard attached work complete' });
    const completed = daemon.completeAttachLease(lease.id);
    expect(completed.status).toBe('completed');
    await daemon.settle();
    expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({ custody: 'owned', state: 'idle' });
    expect(fake.wasAttached(sessionRef)).toBe(true);
    expect(fake.deliveries).toHaveLength(3);
    expect(fake.deliveries.at(-1)!.payload).toContain('queued while attach waits');
  });

  it('marks custody uncertain after heartbeat loss and re-adopts only after the process group exits', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    const { lease } = await daemon.acquireAttachLease('eng', alpha.id, process.pid);
    const child = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      daemon.reportAttachChild(lease.id, child.pid!, child.pid!);
      daemon.postHumanMessage('eng', '@alpha wait safely');
      daemon.reconcileAttachLeases(lease.heartbeat_ts + 6_000);
      expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({
        custody: 'mirrored',
        state: 'custody_uncertain',
      });
      expect(fake.deliveries).toHaveLength(1);
      expect(() => daemon.adoptMember('eng', alpha.id)).toThrow('active interactive attach lease');

      process.kill(-child.pid!, 'SIGKILL');
      await closed;
      fake.enqueue({ kind: 'complete', final_text: '@richard safely resumed' });
      daemon.reconcileAttachLeases(lease.heartbeat_ts + 7_000);
      await daemon.settle();
      expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({
        custody: 'owned',
        state: 'idle',
      });
      expect(fake.deliveries).toHaveLength(2);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  });
});

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

  it.each(['completed', 'interrupted'] as const)(
    'finalizes and displays an empty %s run without routing it',
    async (status) => {
      const alpha = spawnAgent('alpha');
      fake.enqueue(
        status === 'completed'
          ? { kind: 'complete', final_text: '' }
          : { kind: 'die-silently' },
      );

      daemon.postHumanMessage('eng', '@alpha finish quietly');
      await daemon.settle();

      const run = runMessages()[0]!;
      expect(run.run!.status).toBe(status);
      expect(run.body).toBe('');
      expect(daemon.store.listDeliveries('eng', { recipient: daemon.ownerOf('eng').id })).toEqual([]);
      expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })[0]!.state).toBe('consumed');
    },
  );
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

describe('adapter lifecycle evidence', () => {
  it('journals confirmed spawn and persists the native session before a blocked turn completes', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Wait here?', options: [{ label: 'yes' }] },
      reply: () => 'done',
    });
    daemon.postHumanMessage('eng', '@alpha start');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );

    const run = runMessages()[0]!;
    expect(daemon.blobs.read('eng', run.run!.events_ref)[0]).toMatchObject({
      type: 'run.started',
      member: alpha.id,
    });
    expect(daemon.store.getMember('eng', alpha.id)!.session_ref).toBe('fake-session-1');

    await daemon.answerInteraction('eng', interaction.id, 'yes');
    await daemon.settle();
  });

  it('graceful close interrupts and drains a blocked turn before closing SQLite', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Block shutdown?', options: [{ label: 'yes' }] },
      reply: () => 'not reached',
    });
    daemon.postHumanMessage('eng', '@alpha block');
    await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );

    await daemon.close();
    daemon = newDaemon();
    const run = runMessages()[0]!;
    expect(run.run!.status).toBe('interrupted');
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })[0]!.state).toBe('consumed');
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

  it('propagates a missing adapter acknowledgement while leaving the answer durable', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Can you hear me?', options: [{ label: 'yes' }] },
      reply: () => 'done',
    });
    daemon.postHumanMessage('eng', '@alpha ask');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    fake.failNextResponse('stream closed before ack');

    await expect(daemon.answerInteraction('eng', interaction.id, 'yes')).rejects.toThrow(
      'stream closed before ack',
    );
    expect(daemon.store.getInteraction(interaction.id)!.state).toBe('answered');
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
    await daemon.close();

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
    await daemon.close();

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
    await daemon.close();

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
    const runCountBeforeRelease = runMessages().length;
    daemon.releaseHold('eng', delivery.id);
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
    expect(runMessages()).toHaveLength(runCountBeforeRelease);
    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('completed');
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
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    expect(fake.deliveries).toHaveLength(0);
  });

  it('holds confirmed-start evidence and refuses release while its process is alive', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.postHumanMessage('eng', 'process evidence');
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 1, run_msg_id: runMsg.id });
    daemon.store.setDeliveryAttemptProcess('eng', [delivery.id], { pid: process.pid });
    daemon.blobs.append('eng', runMsg.run!.events_ref, {
      type: 'run.started',
      member: alpha.id,
      trigger_msg: trigger.id,
    });
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    expect(() => daemon.releaseHold('eng', delivery.id)).toThrow('adapter process is alive');
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
    await daemon.close({ force: true }); // crash: the blocked run dies with the daemon

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
    await daemon.close({ force: true });

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
    await daemon.close({ force: true });

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
    await daemon.close({ force: true });

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

describe('routing-time payload snapshots', () => {
  it('delayed fanout recipients receive the same reference body even after the ref finalizes', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    daemon.store.updateMember('eng', alpha.id, { state: 'paused' });
    daemon.store.updateMember('eng', beta.id, { state: 'paused' });

    const refBase = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const referenced = daemon.store.updateMessage('eng', refBase.id, {
      run: {
        status: 'running',
        started_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: `runs/${refBase.id}.jsonl`,
      },
    });
    daemon.postHumanMessage('eng', `@alpha @beta compare #${referenced.id}`);

    daemon.store.updateMessage('eng', referenced.id, {
      body: 'LATE FINAL TEXT',
      run: {
        ...referenced.run!,
        status: 'completed',
        ended_ts: new Date().toISOString(),
        final_text: 'LATE FINAL TEXT',
      },
    });

    fake.enqueue(
      { kind: 'complete', final_text: '@richard alpha done' },
      { kind: 'complete', final_text: '@richard beta done' },
    );
    daemon.unpauseMember('eng', alpha.id);
    await daemon.settle();
    daemon.unpauseMember('eng', beta.id);
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(2);
    expect(fake.deliveries[0]!.payload).not.toContain('LATE FINAL TEXT');
    expect(fake.deliveries[1]!.payload).not.toContain('LATE FINAL TEXT');
    expect(fake.deliveries[0]!.payload).toContain(`referenced #${referenced.id}`);
    expect(fake.deliveries[1]!.payload).toContain(`referenced #${referenced.id}`);
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
    await daemon.close();

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
