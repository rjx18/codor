import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentLimit, HarnessAdapter, Message, ServerFrame, Session, SpawnOpts, WireEvent } from '@codor/protocol';
import { createTurnTranslator as createCodexTurnTranslator } from '@codor/adapter-codex';
import { AcpAdapter } from '@codor/adapter-acp';
import { createTurnTranslator, wireEventFromHook } from '@codor/adapter-claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

import { Daemon, RECOVERY_ATTEMPT_CEILING, interactionKey } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import { localSocketPath } from './local-socket.js';
import { Store } from './store.js';

let dir: string;
let fake: FakeAdapter;
let claudeFake: FakeAdapter;
let codexFake: FakeAdapter;
let thinkingFake: FakeAdapter;
let daemon: Daemon;
let frames: { room: string; frame: ServerFrame }[];

function newDaemon(): Daemon {
  const d = new Daemon({
    dbPath: join(dir, 'switchboard.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake, claudeFake, codexFake, thinkingFake],
    homeDir: dir,
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
  dir = mkdtempSync(join(tmpdir(), 'codor-daemon-'));
  fake = new FakeAdapter('fake', { interactiveAttach: true }, async (session, step) => {
    const room = session.env?.CODOR_CHANNEL;
    const memberId = session.env?.CODOR_MEMBER_ID;
    if (!room || !memberId) throw new Error('fake live step has no member environment');
    if (step.kind === 'interim_post') {
      daemon.postAgentMessage(room, memberId, step.body, undefined, step.awaiting_reply === true);
      return;
    }
    const peers = step.peers.map((peer) =>
      daemon.store.getMember(room, peer)?.id ?? daemon.store.getMemberByHandle(room, peer)?.id ?? peer);
    daemon.beginWait(room, memberId, {
      reason: step.reason,
      peers,
      until_ts: new Date(Date.now() + Math.max(60_000, step.duration_ms + 1_000)).toISOString(),
    });
    const deadline = Date.now() + step.duration_ms;
    // harn:assume fake-adapter-drives-live-collaboration ref=fake-live-wait-consumption
    // harn:assume interim-group-replies-end-waits-without-advancing-the-barrier ref=fake-direct-reply-wait-consumption
    while (Date.now() < deadline && daemon.memberStatus(room, memberId).member.waiting !== undefined) {
      const directReply = daemon.store.listDeliveries(room, {
        recipient: memberId,
        state: 'queued',
      }).find((delivery) => {
        const message = daemon.store.getMessage(room, delivery.message_id);
        return message !== undefined && peers.includes(message.author) &&
          message.mentions.some((mention) => mention.member_id === memberId);
      });
      if (directReply) {
        daemon.consumeDelivery(room, directReply.id, memberId);
        daemon.endWait(room, memberId);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // harn:end interim-group-replies-end-waits-without-advancing-the-barrier
    // harn:end fake-adapter-drives-live-collaboration
    if (
      daemon.store.getMember(room, memberId)?.state === 'running' &&
      daemon.memberStatus(room, memberId).member.waiting !== undefined
    ) {
      daemon.endWait(room, memberId);
    }
  });
  claudeFake = new FakeAdapter('claude-code', { extensions: true });
  codexFake = new FakeAdapter('codex');
  // `fake` must keep thinking:false — a test below relies on it rejecting a thinking level.
  thinkingFake = new FakeAdapter('thinking-fake', { thinking: true });
  frames = [];
  daemon = newDaemon();
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
});

afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const testCwd = (name = 'work') => {
  const path = join(dir, 'cwd', name);
  mkdirSync(path, { recursive: true });
  return path;
};

const spawnAgent = (handle: string, cwd = testCwd()) =>
  daemon.spawnMember('eng', { harness: 'fake', handle, cwd });

const runMessages = () =>
  daemon.store.listMessages('eng', { limit: 100 }).filter((m) => m.kind === 'run' && m.run !== undefined);

const resultMessageFor = (root: Message) => daemon.store.getMessage(
  root.room,
  root.run?.result_message_id ?? root.id,
)!;

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-writer-regression
// harn:assume finalized-turn-routes-aggregate-from-terminal-output ref=aggregate-routing-regression
describe('chronological continuation writer', () => {
  it('inserts before its first event, keeps permanent chronology, and routes one aggregate from the terminal row', async () => {
    const alpha = spawnAgent('chronology-alpha');
    const beta = spawnAgent('aggregate-beta');
    daemon.pauseMember('eng', beta.id);
    const owner = daemon.store.getMemberByHandle('eng', 'richard')!;
    fake.enqueue({
      kind: 'complete',
      // Native final_text is only the final suffix. The root and onward payload
      // must still carry the full aggregate reconstructed from journal truth.
      final_text: 'second stretch @richard @aggregate-beta',
      items: [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'first stretch' } },
        {
          type: 'run.item', item_type: 'tool_call',
          payload: { call_id: 'chronology-call', tool: 'Bash', title: 'Inspect chronology' },
        },
        {
          type: 'run.item', item_type: 'reasoning_summary',
          payload: { text: 'folded reasoning' },
        },
        {
          type: 'run.item', item_type: 'tool_result',
          payload: { call_id: 'chronology-call', output: 'done' },
        },
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'second stretch @richard @aggregate-beta' } },
      ],
      item_delay_ms: 50,
    });

    const trigger = daemon.postHumanMessage('eng', '@chronology-alpha start');
    const root = await until(() => daemon.store.listRunMessages('eng', {
      author: alpha.id, limit: 1,
    })[0]);
    await until(() => daemon.blobs.read('eng', root.run!.events_ref)
      .some((event) => event.type === 'run.item' && event.item_type === 'tool_call')
      ? true
      : undefined);
    const interjection = daemon.postHumanMessage('eng', 'human interjection');
    await daemon.settle();

    const continuations = daemon.store.listRunContinuations('eng', root.id);
    expect([trigger.id, root.id, interjection.id, continuations[0]?.id]).toEqual([1, 2, 3, 4]);
    expect(daemon.store.getMessage('eng', root.id)).toMatchObject({
      body: 'first stretch',
      run: {
        status: 'completed', output_mode: 'messages', result_message_id: 4,
        final_text: 'first stretchsecond stretch @richard @aggregate-beta',
      },
    });
    expect(continuations).toEqual([
      expect.objectContaining({ id: 4, body: 'second stretch @richard @aggregate-beta', run_parent_id: 2 }),
    ]);

    const journal = daemon.blobs.read('eng', root.run!.events_ref);
    expect(journal.filter((event) => event.type === 'run.item').map((event) => event.output_message_id))
      .toEqual([2, 2, 2, 2, 4]);
    expect(journal.find((event) => event.type === 'run.completed')).toHaveProperty(
      'output_message_id', 4,
    );
    const continuationFrame = frames.findIndex(({ frame }) =>
      frame.type === 'message' && frame.message.id === 4);
    const firstContinuationEvent = frames.findIndex(({ frame }) =>
      frame.type === 'run_event'
      && frame.event.type === 'run.item'
      && frame.event.output_message_id === 4);
    expect(continuationFrame).toBeGreaterThanOrEqual(0);
    expect(firstContinuationEvent).toBeGreaterThan(continuationFrame);

    const onward = daemon.store.listDeliveries('eng', { recipient: beta.id })
      .find((delivery) => delivery.message_id === 4)!;
    expect(onward).toBeDefined();
    expect(JSON.parse(daemon.store.getDeliveryPayloadSnapshot('eng', onward.id)!)).toMatchObject({
      context: {
        message: {
          id: 4,
          body: 'first stretchsecond stretch @richard @aggregate-beta',
          run: { result_message_id: 4 },
        },
      },
    });
    expect(daemon.store.countUnreadMessages('eng', owner.id)).toBe(2);
  });
});
// harn:end finalized-turn-routes-aggregate-from-terminal-output
// harn:end continuation-writer-follows-journaled-output-ownership

// harn:assume agent-member-credentials-stay-secret ref=member-session-environment-regression
describe('agent member session credentials', () => {
  it('composes the scoped env, stores only a hash, and rotates on revive and rebuild', async () => {
    const originalSpawn = fake.spawn.bind(fake);
    const originalAttach = fake.attach.bind(fake);
    let capturedSession: Session | undefined;
    vi.spyOn(fake, 'spawn').mockImplementation((opts: SpawnOpts) => {
      capturedSession = originalSpawn(opts);
      return capturedSession;
    });
    vi.spyOn(fake, 'attach').mockImplementation((sessionRef) => {
      capturedSession = originalAttach(sessionRef);
      return capturedSession;
    });

    const alpha = spawnAgent('alpha');
    const firstToken = capturedSession!.env!.CODOR_MEMBER_TOKEN!;
    // harn:assume member-session-masks-operator-token ref=member-token-mask-regression
    expect(capturedSession!.env).toMatchObject({
      CODOR_SOCKET: localSocketPath(dir),
      CODOR_CHANNEL: 'eng',
      CODOR_MEMBER_ID: alpha.id,
      CODOR_MEMBER_TOKEN: firstToken,
      CODOR_TOKEN: firstToken,
    });
    // harn:end member-session-masks-operator-token
    expect(firstToken.length).toBeGreaterThanOrEqual(40);
    expect(daemon.authenticateAgentToken(firstToken)).toMatchObject({
      room: 'eng', member: { id: alpha.id },
    });
    expect(JSON.stringify(daemon.store.getMember('eng', alpha.id))).not.toContain(firstToken);

    fake.enqueue({ kind: 'complete', final_text: '@richard credential-safe result' });
    daemon.postHumanMessage('eng', '@alpha establish the native session');
    await daemon.settle();
    const run = runMessages().at(-1)!;
    expect(fake.deliveries.at(-1)!.payload).not.toContain(firstToken);
    expect(JSON.stringify(daemon.blobs.read('eng', run.run!.events_ref))).not.toContain(firstToken);
    expect(JSON.stringify(frames)).not.toContain(firstToken);

    daemon.killMember('eng', alpha.id);
    expect(daemon.authenticateAgentToken(firstToken)).toBeUndefined();
    capturedSession = undefined;
    daemon.reviveMember('eng', alpha.id);
    const revivedToken = capturedSession!.env!.CODOR_MEMBER_TOKEN!;
    expect(revivedToken).not.toBe(firstToken);
    expect(daemon.authenticateAgentToken(firstToken)).toBeUndefined();
    expect(daemon.authenticateAgentToken(revivedToken)?.member.id).toBe(alpha.id);

    await daemon.close({ force: true });
    daemon = newDaemon();
    capturedSession = undefined;
    fake.enqueue({ kind: 'complete', final_text: '@richard rebuilt safely' });
    daemon.postHumanMessage('eng', '@alpha run after restart');
    await daemon.settle();
    const rebuiltToken = capturedSession!.env!.CODOR_MEMBER_TOKEN!;
    expect(rebuiltToken).not.toBe(revivedToken);
    expect(daemon.authenticateAgentToken(revivedToken)).toBeUndefined();
    expect(daemon.authenticateAgentToken(rebuiltToken)?.member.id).toBe(alpha.id);
  });
});
// harn:end agent-member-credentials-stay-secret

// harn:assume live-delivery-consumption-is-idempotent ref=consumption-daemon-regression
describe('live queued-delivery consumption', () => {
  it('removes work queued during a blocked turn without admitting a second run', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Keep this turn open?', options: [{ label: 'finish' }] },
      reply: () => '@richard first turn done',
    });
    daemon.postHumanMessage('eng', '@alpha start the first turn');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    const queuedMessage = daemon.postHumanMessage('eng', '@alpha consume this while blocked');
    const queued = daemon.store.listDeliveries('eng', {
      recipient: alpha.id,
      state: 'queued',
    }).find((delivery) => delivery.message_id === queuedMessage.id)!;

    const first = daemon.consumeDelivery('eng', queued.id, alpha.id);
    expect(first).toMatchObject({
      delivery: { id: queued.id, state: 'consumed' },
      message: { id: queuedMessage.id, body: '@alpha consume this while blocked' },
    });
    expect(daemon.consumeDelivery('eng', queued.id, alpha.id)).toEqual(first);

    await daemon.answerInteraction('eng', interaction.id, 'finish');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]!.payload).not.toContain('consume this while blocked');
    expect(runMessages()).toHaveLength(1);
    expect(runMessages()[0]!.run!.final_text).toBe('@richard first turn done');
    expect(resultMessageFor(runMessages()[0]!).body).toBe('@richard first turn done');
  });
});
// harn:end live-delivery-consumption-is-idempotent

// harn:assume live-agent-waits-are-transient ref=wait-daemon-regression
describe('transient live waits', () => {
  const createRunningAgent = (handle: string) => {
    const agent = spawnAgent(handle, testCwd(handle));
    daemon.store.updateMember('eng', agent.id, { state: 'running' });
    const posted = daemon.store.postMessage('eng', { author: agent.id, kind: 'run', body: '' });
    const run = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running',
        started_ts: new Date(Date.now() - 3_600_000).toISOString(),
        tool_calls: 0,
        events_ref: `runs/${String(posted.id)}.jsonl`,
      },
    });
    return { agent, run };
  };

  // harn:assume answered-approval-tools-can-register-live-waits ref=approved-tool-wait-regression
  it('allows an approved tool to begin and end a wait before its stream ack', () => {
    const beta = spawnAgent('approval-beta', testCwd('approval-beta'));
    const { agent: alpha } = createRunningAgent('approval-alpha');
    const owner = daemon.store.getMemberByHandle('eng', 'richard')!;
    const interactionId = 'approval-wait-window';
    const card = daemon.store.postMessage('eng', {
      author: alpha.id,
      kind: 'ask',
      body: 'Allow this collaboration command?',
      ask: { interaction_id: interactionId, kind: 'approval', prompt: 'Run codor post --wait' },
    });
    const answered = daemon.store.upsertInteraction({
      id: interactionId,
      room: 'eng',
      member_id: alpha.id,
      message_id: card.id,
      native_id: 'native-approval-wait-window',
      kind: 'approval',
      targets: [owner.id],
      state: 'answered',
      answer: 'yes',
      answered_by: owner.id,
      answered_ts: new Date().toISOString(),
    });
    daemon.store.updateMember('eng', alpha.id, { state: 'awaiting_input' });
    const untilTs = new Date(Date.now() + 60_000).toISOString();

    expect(daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id], until_ts: untilTs,
    })).toMatchObject({ waiting: { peers: [beta.id], reason: 'reply' } });
    expect(daemon.endWait('eng', alpha.id)).not.toHaveProperty('waiting');

    daemon.store.upsertInteraction({
      ...answered,
      state: 'pending',
      answer: undefined,
      answered_by: undefined,
      answered_ts: undefined,
    });
    expect(() => daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id], until_ts: untilTs,
    })).toThrow('cannot wait while awaiting_input');
  });
  // harn:end answered-approval-tools-can-register-live-waits

  it('overlays waits, exempts only their live deadline, and clears on end, kill, and restart', async () => {
    const beta = spawnAgent('beta', testCwd('beta'));
    const { agent: alpha, run } = createRunningAgent('alpha');
    const now = new Date();
    const untilTs = new Date(now.getTime() + 2 * 3_600_000).toISOString();

    expect(() => daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [alpha.id], until_ts: untilTs,
    }, now)).toThrow('at least one other member');
    expect(() => daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id], until_ts: new Date(now.getTime() - 1).toISOString(),
    }, now)).toThrow('deadline must be in the future');
    const idle = spawnAgent('idle', testCwd('idle'));
    expect(() => daemon.beginWait('eng', idle.id, {
      reason: 'reply', peers: [beta.id], until_ts: untilTs,
    }, now)).toThrow('cannot wait while idle');
    const otherOwner = daemon.createRoom({
      id: 'other', name: 'Other', owner: { handle: 'other-owner', display_name: 'Other Owner' },
    }).owner;
    expect(() => daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [otherOwner.id], until_ts: untilTs,
    }, now)).toThrow('no active wait peer');
    const hydrationCursor = daemon.store.currentSeq('eng');

    expect(daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id, beta.id], until_ts: untilTs,
    }, now)).toMatchObject({
      id: alpha.id,
      waiting: { reason: 'reply', peers: [beta.id], since_ts: now.toISOString(), until_ts: untilTs },
    });
    expect(daemon.store.getMember('eng', alpha.id)).not.toHaveProperty('waiting');
    expect(daemon.sync('eng', hydrationCursor).members.find((item) => item.id === alpha.id)).toMatchObject({
      waiting: { peers: [beta.id], reason: 'reply' },
    });
    expect([...frames].reverse().find((item) =>
      item.frame.type === 'member' && item.frame.member.id === alpha.id)?.frame)
      .toMatchObject({ type: 'member', member: { waiting: { reason: 'reply' } } });

    daemon.checkStalls(new Date(now.getTime() + 60 * 60_000));
    expect(daemon.store.getMessage('eng', run.id)!.run!.stalled_since).toBeUndefined();
    daemon.checkStalls(new Date(now.getTime() + 3 * 60 * 60_000));
    expect(daemon.store.getMessage('eng', run.id)!.run!.stalled_since).toBeDefined();

    expect(daemon.endWait('eng', alpha.id)).not.toHaveProperty('waiting');
    expect(daemon.endWait('eng', alpha.id)).not.toHaveProperty('waiting');
    expect(daemon.sync('eng', hydrationCursor).members.find((item) => item.id === alpha.id))
      .not.toHaveProperty('waiting');

    daemon.beginWait('eng', alpha.id, {
      reason: 'any', peers: [beta.id], until_ts: untilTs,
    }, now);
    daemon.killMember('eng', alpha.id);
    expect(daemon.sync('eng', 0).members.find((item) => item.id === alpha.id))
      .not.toHaveProperty('waiting');

    const { agent: gamma } = createRunningAgent('gamma');
    daemon.beginWait('eng', gamma.id, {
      reason: 'mention', peers: [beta.id], until_ts: untilTs,
    }, now);
    await daemon.close({ force: true });
    daemon = newDaemon();
    expect(daemon.sync('eng', 0).members.find((item) => item.id === gamma.id))
      .not.toHaveProperty('waiting');
  });

  it('clears the wait before a completed turn emits its idle member frame', async () => {
    const beta = spawnAgent('beta', testCwd('completion-beta'));
    const alpha = spawnAgent('alpha', testCwd('completion-alpha'));
    fake.enqueue({ kind: 'complete', final_text: '@richard done', delay_ms: 100 });
    daemon.postHumanMessage('eng', '@alpha wait briefly');
    await until(() => daemon.store.getMember('eng', alpha.id)?.state === 'running' ? true : undefined);
    daemon.beginWait('eng', alpha.id, {
      reason: 'reply',
      peers: [beta.id],
      until_ts: new Date(Date.now() + 60_000).toISOString(),
    });
    await daemon.settle();

    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
    expect(daemon.sync('eng', 0).members.find((item) => item.id === alpha.id))
      .not.toHaveProperty('waiting');
    const lastMember = [...frames].reverse().find((item) =>
      item.frame.type === 'member' && item.frame.member.id === alpha.id)?.frame;
    expect(lastMember).toMatchObject({ type: 'member', member: { id: alpha.id, state: 'idle' } });
    expect(lastMember && 'member' in lastMember ? lastMember.member : undefined)
      .not.toHaveProperty('waiting');
  });
});
// harn:end live-agent-waits-are-transient

// harn:assume inflight-member-state-survives-new-delivery ref=preserve-live-state-regression
describe('queued work during a live turn', () => {
  it('keeps the member running while the new delivery remains consumable', async () => {
    const alpha = spawnAgent('alpha', testCwd('live-queue-alpha'));
    const beta = spawnAgent('beta', testCwd('live-queue-beta'));
    fake.enqueue({ kind: 'complete', final_text: '@richard original turn done', delay_ms: 100 });
    daemon.postHumanMessage('eng', '@alpha start the live turn');
    await until(() => daemon.store.getMember('eng', alpha.id)?.state === 'running' ? true : undefined);

    const reply = daemon.postAgentMessage('eng', beta.id, '@alpha live reply');
    const delivery = daemon.store.listDeliveries('eng', {
      recipient: alpha.id,
      state: 'queued',
    }).find((candidate) => candidate.message_id === reply.id)!;
    expect(daemon.store.getMember('eng', alpha.id)?.state).toBe('running');
    expect(runMessages().filter((message) => message.author === alpha.id)).toHaveLength(1);

    expect(daemon.consumeDelivery('eng', delivery.id, alpha.id).delivery.state).toBe('consumed');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(1);
  });
});
// harn:end inflight-member-state-survives-new-delivery

// harn:assume active-turn-steering-is-ordered-and-durable ref=daemon-active-turn-steering-regression
describe('active-turn steering', () => {
  const enableSteering = (): void => {
    Object.assign(fake.capabilities, { live_inbox: true });
  };

  it('consumes an active delivery only after steering acknowledgement', async () => {
    enableSteering();
    const alpha = spawnAgent('steering-alpha', testCwd('steering-alpha'));
    fake.enqueue({ kind: 'complete', final_text: '@richard original done', delay_ms: 120 });
    daemon.postHumanMessage('eng', '@steering-alpha start');
    await until(() => fake.deliveries.length === 1 && daemon.store.getMember('eng', alpha.id)?.state === 'running'
      ? true
      : undefined);

    const correction = daemon.postHumanMessage('eng', '@steering-alpha focus on the failing test');
    const steered = await until(() => daemon.store.listDeliveries('eng', { recipient: alpha.id })
      .find((delivery) => delivery.message_id === correction.id)?.steered_ts === undefined
      ? undefined
      : daemon.store.listDeliveries('eng', { recipient: alpha.id })
        .find((delivery) => delivery.message_id === correction.id));

    expect(steered).toMatchObject({ state: 'consumed', steered_ts: expect.any(String) });
    expect(fake.steers).toHaveLength(1);
    expect(fake.steers[0]?.payload).toContain('focus on the failing test');
    expect(fake.deliveries).toHaveLength(1);
    expect(frames).toContainEqual(expect.objectContaining({
      room: 'eng',
      frame: expect.objectContaining({
        type: 'inbox',
        delivery: expect.objectContaining({ id: steered.id, state: 'consumed', steered_ts: steered.steered_ts }),
      }),
    }));
    await daemon.settle();
  });

  it('uses ordinary delivery while idle and serializes active steering in FIFO order', async () => {
    enableSteering();
    const idle = spawnAgent('idle-alpha', testCwd('idle-alpha'));
    fake.enqueue({ kind: 'complete', final_text: '@richard idle delivery done' });
    daemon.postHumanMessage('eng', '@idle-alpha ordinary idle work');
    await daemon.settle();
    expect(fake.steers).toHaveLength(0);
    expect(fake.deliveries).toHaveLength(1);

    const active = spawnAgent('ordered-alpha', testCwd('ordered-alpha'));
    fake.steerDelayMs = 25;
    fake.enqueue({ kind: 'complete', final_text: '@richard ordered done', delay_ms: 160 });
    daemon.postHumanMessage('eng', '@ordered-alpha start');
    await until(() => fake.deliveries.length === 2 && daemon.store.getMember('eng', active.id)?.state === 'running'
      ? true
      : undefined);
    daemon.postHumanMessage('eng', '@ordered-alpha first correction');
    daemon.postHumanMessage('eng', '@ordered-alpha second correction');
    await until(() => fake.steers.length === 2 ? true : undefined);
    expect(fake.steers.map((steer) => steer.payload.match(/(first|second) correction/)?.[0]))
      .toEqual(['first correction', 'second correction']);
    expect(fake.maxConcurrentSteers).toBe(1);
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(2);
  });

  it('restores failed steering to the ordinary next-turn queue', async () => {
    enableSteering();
    const alpha = spawnAgent('recovery-alpha', testCwd('recovery-alpha'));
    fake.failNextSteer('native steering failed');
    fake.enqueue(
      { kind: 'complete', final_text: '@richard first turn done', delay_ms: 120 },
      { kind: 'complete', final_text: '@richard queued recovery done' },
    );
    daemon.postHumanMessage('eng', '@recovery-alpha start');
    await until(() => fake.deliveries.length === 1 && daemon.store.getMember('eng', alpha.id)?.state === 'running'
      ? true
      : undefined);
    const correction = daemon.postHumanMessage('eng', '@recovery-alpha preserve this correction');
    await until(() => fake.steers.length === 1 && daemon.store.listDeliveries('eng', {
      recipient: alpha.id, state: 'queued',
    }).some((delivery) => delivery.message_id === correction.id) ? true : undefined);
    const queued = daemon.store.listDeliveries('eng', { recipient: alpha.id })
      .find((delivery) => delivery.message_id === correction.id)!;
    expect(queued).toMatchObject({ state: 'queued' });
    expect(queued.steered_ts).toBeUndefined();

    await daemon.settle();
    expect(fake.deliveries).toHaveLength(2);
    expect(fake.deliveries[1]?.payload).toContain('preserve this correction');
    expect(daemon.store.getDelivery('eng', queued.id)).toMatchObject({ state: 'consumed' });
    expect(daemon.store.getDelivery('eng', queued.id)?.steered_ts).toBeUndefined();
  });
});
// harn:end active-turn-steering-is-ordered-and-durable

// harn:assume fake-adapter-drives-live-collaboration ref=fake-live-step-regression
// harn:assume interim-agent-posts-are-nonfinal-routing ref=interim-post-regression
// harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-daemon-regression
describe('scripted live collaboration', () => {
  it('posts and waits inside one live turn without replacing finalization or the default', async () => {
    const beta = spawnAgent('beta', testCwd('live-beta'));
    fake.enqueue({ kind: 'complete', final_text: '@richard beta baseline' });
    daemon.postHumanMessage('eng', '@beta establish the prior default');
    await daemon.settle();
    expect(daemon.store.latestFinalizedAgentAuthor('eng')).toBe(beta.id);
    daemon.pauseMember('eng', beta.id);

    const alpha = spawnAgent('alpha', testCwd('live-alpha'));
    fake.enqueue({
      kind: 'complete',
      final_text: '@richard alpha final',
      items: [{
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'live-call', tool: 'Bash', title: 'Run live checks' },
      }],
      steps: [
        { kind: 'interim_post', body: '@beta please check the fixture', awaiting_reply: true },
        { kind: 'wait', reason: 'reply', peers: ['beta'], duration_ms: 100 },
      ],
    });
    daemon.postHumanMessage('eng', '@alpha begin live work');
    await until(() => daemon.memberStatus('eng', alpha.id).member.waiting ? true : undefined);

    const interim = daemon.store.listMessages('eng', { limit: 100 })
      .find((message) => message.kind === 'chat' && message.body.includes('please check'))!;
    const running = daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0]!;
    expect(interim).toMatchObject({ author: alpha.id, kind: 'chat', ack: undefined });
    expect(running.run!.status).toBe('running');
    expect(daemon.store.latestFinalizedAgentAuthor('eng')).toBe(beta.id);
    expect(daemon.memberStatus('eng', alpha.id).member.waiting).toMatchObject({
      peers: ['beta'], reason: 'reply',
    });

    const untagged = daemon.postHumanMessage('eng', 'continue with the established default');
    expect(daemon.store.listDeliveries('eng', { recipient: beta.id })
      .some((delivery) => delivery.message_id === untagged.id)).toBe(true);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })
      .some((delivery) => delivery.message_id === untagged.id)).toBe(false);
    const interimDelivery = daemon.store.listDeliveries('eng', { recipient: beta.id })
      .find((delivery) => delivery.message_id === interim.id)!;
    expect(JSON.parse(daemon.store.getDeliveryPayloadSnapshot('eng', interimDelivery.id)!))
      .toMatchObject({ context: { awaitingReply: true } });

    await daemon.settle();
    const completed = daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0]!;
    expect(completed).toMatchObject({
      id: running.id,
      run: { status: 'completed', final_text: '@richard alpha final' },
    });
    expect(resultMessageFor(completed)).toMatchObject({
      body: '@richard alpha final', run_parent_id: running.id,
    });
    expect(daemon.blobs.read('eng', running.run!.events_ref)
      .find((event) => event.type === 'run.item')).toHaveProperty('ts');
    expect(daemon.memberStatus('eng', alpha.id).member).not.toHaveProperty('waiting');

    fake.enqueue({ kind: 'complete', final_text: '' });
    daemon.unpauseMember('eng', beta.id);
    await daemon.settle();
    expect(fake.deliveries.at(-1)!.payload).toContain('from=@alpha (chat, awaiting reply)');
  });
});
// harn:end awaiting-reply-marker-is-delivery-context
// harn:end interim-agent-posts-are-nonfinal-routing
// harn:end fake-adapter-drives-live-collaboration

// harn:assume interim-agent-posts-are-nonfinal-routing ref=interim-routing-exclusion-review
// harn:assume default-recipient-fallback-chain ref=interim-default-fallback-review
describe('interim post routing exclusions', () => {
  it('keeps the author run live and preserves only the later adapter final text', async () => {
    const alpha = spawnAgent('alpha', testCwd('interim-final-alpha'));
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Finish the live turn?', options: [{ label: 'finish' }] },
      reply: () => '@richard adapter final only',
    });
    daemon.postHumanMessage('eng', '@alpha begin the live turn');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    const running = daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0]!;

    const interim = daemon.postAgentMessage('eng', alpha.id, '@richard interim progress only');
    const during = daemon.store.getMessage('eng', running.id)!;
    expect(interim).toMatchObject({ kind: 'chat', author: alpha.id });
    expect(during).toMatchObject({ id: running.id, body: '', run: { status: 'running' } });
    expect(during.run!.final_text).toBeUndefined();

    await daemon.answerInteraction('eng', interaction.id, 'finish');
    await daemon.settle();
    const completed = daemon.store.getMessage('eng', running.id)!;
    expect(completed).toMatchObject({
      id: running.id,
      run: { status: 'completed', final_text: '@richard adapter final only' },
    });
    expect(resultMessageFor(completed)).toMatchObject({
      body: '@richard adapter final only', run_parent_id: running.id,
    });
  });

  it('does not let an interim author replace the latest finalized default', async () => {
    const beta = spawnAgent('beta', testCwd('interim-default-beta'));
    fake.enqueue({ kind: 'complete', final_text: '@richard beta remains the default' });
    daemon.postHumanMessage('eng', '@beta establish the default');
    await daemon.settle();
    daemon.pauseMember('eng', beta.id);

    const alpha = spawnAgent('alpha', testCwd('interim-default-alpha'));
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Finish alpha?', options: [{ label: 'finish' }] },
      reply: () => '@richard alpha final',
    });
    daemon.postHumanMessage('eng', '@alpha start unrelated work');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    daemon.postAgentMessage('eng', alpha.id, 'alpha interim without a recipient');

    expect(daemon.store.latestFinalizedAgentAuthor('eng')).toBe(beta.id);
    const untagged = daemon.postHumanMessage('eng', 'continue with the current default');
    expect(daemon.store.listDeliveries('eng', { recipient: beta.id })).toContainEqual(
      expect.objectContaining({ message_id: untagged.id, state: 'queued' }),
    );
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })
      .some((delivery) => delivery.message_id === untagged.id)).toBe(false);

    await daemon.answerInteraction('eng', interaction.id, 'finish');
    await daemon.settle();
  });
});
// harn:end default-recipient-fallback-chain
// harn:end interim-agent-posts-are-nonfinal-routing

// harn:assume member-status-is-bounded-and-identity-safe ref=status-daemon-regression
describe('bounded member status', () => {
  it('merges projected latest-run tools and live posts without identity or raw payload fields', () => {
    const beta = spawnAgent('beta', testCwd('status-beta'));
    const alpha = spawnAgent('alpha', testCwd('status-alpha'));
    const now = new Date();
    const startedTs = new Date(now.getTime() - 5_000).toISOString();
    daemon.store.updateMember('eng', alpha.id, { state: 'running' });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const run = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running', started_ts: startedTs, tool_calls: 6,
        events_ref: `runs/${String(posted.id)}.jsonl`,
      },
    });
    for (let index = 0; index < 6; index++) {
      const callId = `call-${String(index)}`;
      const ts = new Date(now.getTime() - 1_000 + index * 100).toISOString();
      daemon.blobs.append('eng', run.run!.events_ref, {
        type: 'run.item', item_type: 'tool_call', ts,
        payload: {
          call_id: callId,
          tool: 'Bash',
          title: index === 5 ? 'Inspect AKIAIOSFODNN7EXAMPLE' : `Tool ${String(index)}`,
          input: { raw_command: 'must not escape status' },
        },
      });
      daemon.blobs.append('eng', run.run!.events_ref, {
        type: 'run.item', item_type: 'tool_result', ts,
        payload: { call_id: callId, status: index === 4 ? 'error' : 'ok', duration_ms: index + 10 },
      });
    }
    const interim = daemon.postAgentMessage('eng', alpha.id, 'progress AKIAIOSFODNN7EXAMPLE');
    daemon.beginWait('eng', alpha.id, {
      reason: 'reply', peers: [beta.id], until_ts: new Date(now.getTime() + 60_000).toISOString(),
    }, now);

    const status = daemon.memberStatus('eng', alpha.id, now);
    expect(status.member).toMatchObject({
      handle: 'alpha', state: 'running', waiting: { peers: ['beta'], reason: 'reply' },
    });
    expect(status.current_run).toMatchObject({
      message_id: run.id, started_ts: startedTs, elapsed_ms: 5_000, tool_calls: 6,
    });
    expect(status.recent).toHaveLength(5);
    expect(status.recent[0]).toMatchObject({ kind: 'post', ts: interim.ts });
    expect(status.recent).toContainEqual(expect.objectContaining({
      kind: 'tool', title: expect.stringContaining('[redacted]'), status: 'ok', duration_ms: 15,
    }));
    expect(status.recent).toContainEqual(expect.objectContaining({
      kind: 'post', title: expect.stringContaining('[redacted]'), ts: interim.ts,
    }));
    expect(JSON.stringify(status)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(status)).not.toContain('raw_command');
    expect(daemon.store.getMessage('eng', interim.id)!.body).toContain('AKIAIOSFODNN7EXAMPLE');
    daemon.endWait('eng', alpha.id);
  });
});
// harn:end member-status-is-bounded-and-identity-safe

// harn:assume run-evidence-search-is-bounded-and-redacted ref=run-search-daemon-regression
describe('bounded run evidence search', () => {
  it('searches projected tool titles and outputs newest-first within the requested run window', () => {
    const alpha = spawnAgent('alpha', testCwd('search-alpha'));
    const addRun = (title: string, output: string) => {
      const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: title });
      const run = daemon.store.updateMessage('eng', posted.id, {
        run: {
          status: 'completed', started_ts: '2026-07-10T07:00:00.000Z',
          ended_ts: '2026-07-10T07:01:00.000Z', tool_calls: 1,
          events_ref: `runs/${String(posted.id)}.jsonl`, final_text: title,
        },
      });
      daemon.blobs.append('eng', run.run!.events_ref, {
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: `call-${String(run.id)}`, tool: 'Bash', title },
      });
      daemon.blobs.append('eng', run.run!.events_ref, {
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: `call-${String(run.id)}`, status: 'ok', output_text: output },
      });
      return run;
    };

    const oldest = addRun('oldest-only needle', 'old output');
    for (let index = 0; index < 49; index++) addRun(`filler ${String(index)}`, 'nothing');
    const newer = addRun('shared needle newest', 'result needle output');
    expect(daemon.searchRunEvidence('eng', 'oldest-only')).toEqual([]);
    expect(daemon.searchRunEvidence('eng', 'oldest-only', 51)).toEqual([
      expect.objectContaining({ message_id: oldest.id, item_index: 0, kind: 'tool_call' }),
    ]);
    expect(daemon.searchRunEvidence('eng', 'needle', 51)[0]).toMatchObject({
      message_id: newer.id, item_index: 0, kind: 'tool_call',
    });
    expect(daemon.searchRunEvidence('eng', 'needle', 51)).toContainEqual(expect.objectContaining({
      message_id: newer.id, item_index: 1, kind: 'tool_result',
    }));

    const secret = addRun('Inspect AKIAIOSFODNN7EXAMPLE', 'safe');
    expect(daemon.searchRunEvidence('eng', 'AKIAIOSFODNN7EXAMPLE', 52)).toEqual([]);
    expect(daemon.searchRunEvidence('eng', '[redacted]', 52)).toContainEqual(expect.objectContaining({
      message_id: secret.id, kind: 'tool_call', excerpt: expect.stringContaining('[redacted]'),
    }));
    expect(() => daemon.searchRunEvidence('eng', 'needle', 201)).toThrow('1 to 200');
  });
});
// harn:end run-evidence-search-is-bounded-and-redacted

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

  // harn:assume copilot-vscode-revive-requires-exact-live-cache ref=revive-session-regression
  it('kill leaves a revivable dead member and revive attaches the exact session ref', async () => {
    const persistedCwd = testCwd('persisted-work');
    const alpha = spawnAgent('alpha', persistedCwd);
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
      cwd: persistedCwd,
      attached: true,
    });
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
  });
  // harn:end copilot-vscode-revive-requires-exact-live-cache

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

// harn:assume copilot-vscode-revive-requires-exact-live-cache ref=revive-session-regression
describe('copilot-vscode ephemeral revive', () => {
  it('reuses only the exact live cached session and bridge generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-copilot-vscode-revive-'));
    let bridgeLive = true;
    let generation = 'bridge-a';
    const raw = new FakeAdapter('copilot-vscode', { resume: false });
    const originalSpawn = raw.spawn.bind(raw);
    vi.spyOn(raw, 'spawn').mockImplementation((opts) => {
      const session = originalSpawn(opts) as Session & { bridge_generation?: string };
      session.bridge_generation = generation;
      return session;
    });
    const adapter = Object.assign(raw, {
      available: () => bridgeLive,
      canReviveSession: (session: Session) =>
        bridgeLive && (session as Session & { bridge_generation?: string }).bridge_generation === generation,
    });
    const local = new Daemon({
      dbPath: join(root, 'switchboard.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [adapter],
      homeDir: root,
      discoverModels: false,
    });
    try {
      local.createRoom({ id: 'vscode', name: 'VS Code', owner: { handle: 'owner', display_name: 'Owner' } });
      const member = local.spawnMember('vscode', {
        harness: 'copilot-vscode', handle: 'copilot', cwd: root, model: 'gpt-5.6-luna',
      });
      raw.enqueue({ kind: 'complete', final_text: '@owner initialized' });
      local.postHumanMessage('vscode', '@copilot initialize');
      await local.settle();
      const sessionRef = local.store.getMember('vscode', member.id)!.session_ref!;

      local.killMember('vscode', member.id);
      local.postHumanMessage('vscode', '@copilot continue');
      raw.enqueue({ kind: 'complete', final_text: '@owner continued' });
      local.reviveMember('vscode', member.id);
      await local.settle();
      expect(raw.wasAttached(sessionRef)).toBe(false);
      expect(raw.deliveries.at(-1)).toMatchObject({
        session_ref: sessionRef, cwd: root, model: 'gpt-5.6-luna', attached: false,
      });

      local.killMember('vscode', member.id);
      bridgeLive = false;
      expect(() => local.reviveMember('vscode', member.id)).toThrow(
        "adapter 'copilot-vscode' cannot revive @copilot after its live session or bridge was lost",
      );

      bridgeLive = true;
      generation = 'bridge-a';
      local.configureMember('vscode', member.id, { model: 'gpt-5.6-next' });
      expect(() => local.reviveMember('vscode', member.id)).toThrow(
        "adapter 'copilot-vscode' cannot revive @copilot after its live session or bridge was lost",
      );
      expect(local.store.getMember('vscode', member.id)?.state).toBe('dead');

      bridgeLive = true;
      generation = 'bridge-b';
      expect(() => local.reviveMember('vscode', member.id)).toThrow(
        "adapter 'copilot-vscode' cannot revive @copilot after its live session or bridge was lost",
      );
    } finally {
      await local.close({ force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a daemon restart loses the in-memory native session cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-copilot-vscode-lost-cache-'));
    const firstAdapter = Object.assign(new FakeAdapter('copilot-vscode', { resume: false }), {
      available: () => true,
      canReviveSession: () => true,
    });
    const first = new Daemon({
      dbPath: join(root, 'switchboard.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [firstAdapter],
      homeDir: root,
      discoverModels: false,
    });
    let memberId: string;
    try {
      first.createRoom({ id: 'lost-cache', name: 'Lost cache', owner: { handle: 'owner', display_name: 'Owner' } });
      const member = first.spawnMember('lost-cache', {
        harness: 'copilot-vscode', handle: 'copilot', cwd: root,
      });
      memberId = member.id;
      first.killMember('lost-cache', member.id);
    } finally {
      await first.close({ force: true });
    }

    const secondAdapter = Object.assign(new FakeAdapter('copilot-vscode', { resume: false }), {
      available: () => true,
      canReviveSession: () => true,
    });
    const second = new Daemon({
      dbPath: join(root, 'switchboard.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [secondAdapter],
      homeDir: root,
      discoverModels: false,
    });
    try {
      expect(() => second.reviveMember('lost-cache', memberId!)).toThrow(
        "adapter 'copilot-vscode' cannot revive @copilot after its live session or bridge was lost",
      );
    } finally {
      await second.close({ force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps ACP and other non-resumable adapters on the fail-closed boundary', async () => {
    const make = (id: string) => new FakeAdapter(id, { resume: false });
    for (const adapter of [make('acp'), make('other-ephemeral')]) {
      const root = mkdtempSync(join(tmpdir(), `codor-${adapter.id}-revive-`));
      const local = new Daemon({
        dbPath: join(root, 'switchboard.sqlite'),
        blobRoot: join(root, 'blobs'),
        adapters: [adapter],
        homeDir: root,
        discoverModels: false,
      });
      local.createRoom({ id: adapter.id, name: adapter.id, owner: { handle: 'owner', display_name: 'Owner' } });
      const member = local.spawnMember(adapter.id, {
        harness: adapter.id, handle: 'ephemeral', cwd: root,
        ...(adapter.id === 'acp' && {
          acp_launch: { executable: process.execPath, argv: [] },
        }),
      });
      local.killMember(adapter.id, member.id);
      expect(() => local.reviveMember(adapter.id, member.id)).toThrow(
        `adapter '${adapter.id}' does not support resume`,
      );
      await local.close({ force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
// harn:end copilot-vscode-revive-requires-exact-live-cache

describe('room bridges', () => {
  it('creates a post-only non-addressable bridge and routes retry-safe ingress', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initial answer' });
    daemon.postHumanMessage('eng', '@alpha establish the default recipient');
    await daemon.settle();

    const enabled = daemon.enableBridge('eng', 'slack', 'C123');
    expect(enabled.member).toMatchObject({ kind: 'bridge', handle: 'slack-bridge' });
    expect(daemon.store.getRoom('eng')?.config.bridged).toBe(true);
    expect(daemon.enableBridge('eng', 'slack', 'C123').member.id).toBe(enabled.member.id);
    expect(() => daemon.enableBridge('eng', 'slack', 'C999')).toThrow('another channel');

    fake.enqueue({ kind: 'complete', final_text: '@richard received via Slack' });
    const origin = { platform: 'slack', external_id: '171.42', sender_name: 'Sarah' };
    const first = daemon.postBridgeMessage('eng', enabled.member.id, 'Please continue', origin);
    const retry = daemon.postBridgeMessage('eng', enabled.member.id, 'Duplicate retry', origin);
    await daemon.settle();

    expect(first.deduped).toBe(false);
    expect(retry).toMatchObject({ deduped: true, message: { id: first.message.id } });
    expect(fake.deliveries).toHaveLength(2);
    expect(fake.deliveries.at(-1)?.payload).toContain('Please continue');
    expect(first.message.origin).toEqual(origin);

    fake.enqueue({ kind: 'complete', final_text: '@richard explicit bridge delivery received' });
    const explicit = daemon.postBridgeMessage(
      'eng',
      enabled.member.id,
      `@alpha inspect #${String(first.message.id)} [[launch-plan]]`,
      { ...origin, external_id: '171.43' },
    ).message;
    await daemon.settle();
    expect(explicit.mentions).toEqual([expect.objectContaining({ member_id: alpha.id })]);
    expect(explicit.refs).toEqual([first.message.id]);
    expect(explicit.ledger_refs).toEqual(['launch-plan']);
    expect(fake.deliveries).toHaveLength(3);
    expect(fake.deliveries.at(-1)?.payload).toContain('@alpha inspect');
  });

  it('cannot mention a bridge or use a bridge to answer an interaction', async () => {
    const alpha = spawnAgent('alpha');
    spawnAgent('beta');
    const bridge = daemon.enableBridge('eng', 'telegram', '-10022').member;
    daemon.postHumanMessage('eng', '@telegram-bridge this is commentary');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.listMessages('eng', { limit: 10 }).at(-1)?.mentions).toEqual([]);

    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Approve?', options: [{ label: 'yes' }] },
      reply: () => 'done',
    });
    daemon.postHumanMessage('eng', '@alpha ask');
    const interaction = await until(() => daemon.store.listInteractions('eng', 'pending')[0]);
    await expect(daemon.answerInteraction('eng', interaction.id, 'yes', bridge.id))
      .rejects.toThrow('is not addressed to member');
  });
});

describe('mirrored join and adoption', () => {
  it('holds inbound deliveries, mirrors one routed run per native turn, then adopts and drains', async () => {
    const planner = daemon.joinMember('eng', {
      harness: 'fake',
      handle: 'planner',
      session_ref: 'native-planner-session',
      cwd: testCwd('planning'),
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

    const runsBeforeLateHook = runMessages().length;
    expect(() =>
      daemon.mirrorTurn({
        harness: 'fake',
        session_ref: 'native-planner-session',
        native_turn_id: 'native-turn-after-adopt',
        body: '@reviewer this hook must be dropped',
      }),
    ).toThrow('is not mirrored; native turn was dropped');
    expect(runMessages()).toHaveLength(runsBeforeLateHook);
    expect(fake.deliveries).toHaveLength(2);
  });

  it('auto-adopts only a Claude SessionEnd; Codex remains explicit', () => {
    const claude = daemon.joinMember('eng', {
      harness: 'claude-code',
      handle: 'claude-live',
      session_ref: 'claude-session-1',
      cwd: testCwd(),
    });
    const codex = daemon.joinMember('eng', {
      harness: 'codex',
      handle: 'codex-live',
      session_ref: 'codex-session-1',
      cwd: testCwd(),
    });

    expect(daemon.mirrorSessionEnd('codex', 'codex-session-1')).toBe(false);
    expect(daemon.store.getMember('eng', codex.id)!.custody).toBe('mirrored');
    expect(daemon.mirrorSessionEnd('claude-code', 'claude-session-1')).toBe(true);
    expect(daemon.store.getMember('eng', claude.id)!.custody).toBe('owned');
    expect(claudeFake.wasAttached('claude-session-1')).toBe(true);
  });

  it('rolls back the mirrored run and fanout when its native-id mapping cannot persist', () => {
    const planner = daemon.joinMember('eng', {
      harness: 'fake',
      handle: 'planner',
      session_ref: 'native-planner-fault-session',
      cwd: testCwd('planning'),
    });
    const owner = daemon.ownerOf('eng');
    const recordMirroredTurn = daemon.store.recordMirroredTurn.bind(daemon.store);
    let failOnce = true;
    const recordSpy = vi.spyOn(daemon.store, 'recordMirroredTurn').mockImplementation(
      (room, memberId, nativeTurnId, messageId) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('dedupe write failed');
        }
        recordMirroredTurn(room, memberId, nativeTurnId, messageId);
      },
    );

    const turn = {
      harness: 'fake',
      session_ref: 'native-planner-fault-session',
      native_turn_id: 'native-turn-fault',
      body: '@richard persisted exactly once',
    };
    expect(() => daemon.mirrorTurn(turn)).toThrow('dedupe write failed');
    expect(runMessages()).toEqual([]);
    expect(daemon.store.listDeliveries('eng', { recipient: owner.id })).toEqual([]);

    const retry = daemon.mirrorTurn(turn);
    expect(retry.deduped).toBe(false);
    expect(runMessages()).toHaveLength(1);
    expect(runMessages()[0]).toMatchObject({ author: planner.id, body: turn.body });
    expect(daemon.store.listDeliveries('eng', { recipient: owner.id })).toHaveLength(1);
    recordSpy.mockRestore();
  });
});

describe('interactive attach custody leases', () => {
  it('rejects awaiting input, then holds racing deliveries and drains after clean exit', async () => {
    const alpha = spawnAgent('alpha', testCwd('persisted-work'));
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
    await expect(daemon.acquireAttachLease('eng', alpha.id, 1234)).rejects.toThrow(
      'awaiting input; answer or interrupt it before attach',
    );
    await daemon.answerInteraction('eng', interaction.id, 'yes');
    await daemon.settle();
    const acquisition = daemon.acquireAttachLease('eng', alpha.id, 1234);
    daemon.postHumanMessage('eng', '@alpha queued while attached');
    const { lease, member } = await acquisition;

    expect(member).toMatchObject({ custody: 'mirrored', state: 'idle' });
    expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({ custody: 'mirrored', state: 'queued' });
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
    expect(fake.deliveries.at(-1)!.payload).toContain('queued while attached');
  });

  it('kill and revive both refuse an active attach lease', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    await daemon.acquireAttachLease('eng', alpha.id, 1234);

    expect(() => daemon.killMember('eng', alpha.id)).toThrow('active interactive attach lease');
    daemon.store.updateMember('eng', alpha.id, { state: 'dead' });
    expect(() => daemon.reviveMember('eng', alpha.id)).toThrow('active interactive attach lease');
    expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({ custody: 'mirrored', state: 'dead' });
  });

  it('fails closed when a childless lease expires, then permits explicit adoption', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    const { lease } = await daemon.acquireAttachLease('eng', alpha.id, 1234);
    daemon.postHumanMessage('eng', '@alpha queued during uncertain custody');

    daemon.reconcileAttachLeases(lease.heartbeat_ts + 6_000);
    expect(daemon.store.getMember('eng', alpha.id)).toMatchObject({
      custody: 'mirrored',
      state: 'custody_uncertain',
    });
    expect(daemon.store.getAttachLease(lease.id)).toBeDefined();
    expect(fake.deliveries).toHaveLength(1);

    fake.enqueue({ kind: 'complete', final_text: '@richard explicitly recovered' });
    expect(daemon.adoptMember('eng', alpha.id)).toMatchObject({ custody: 'owned', state: 'idle' });
    await daemon.settle();
    expect(daemon.store.getAttachLease(lease.id)).toBeUndefined();
    expect(fake.deliveries).toHaveLength(2);
  });

  it('fails closed when attach completes before recording a child', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();
    const { lease } = await daemon.acquireAttachLease('eng', alpha.id, 1234);

    const completed = daemon.completeAttachLease(lease.id);
    expect(completed.status).toBe('uncertain');
    expect(completed.member).toMatchObject({ custody: 'mirrored', state: 'custody_uncertain' });
    expect(daemon.store.getAttachLease(lease.id)).toBeDefined();
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

      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid!, 'SIGKILL');
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
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  });
});

describe('ephemeral extensions', () => {
  const fixture = (name: string): string[] =>
    readFileSync(
      new URL(`../../adapters/claude-code/fixtures/${name}`, import.meta.url),
      'utf8',
    ).trim().split('\n');

  it('uses hook lifecycle, enriches from Agent tool calls, and journals mapped summaries', async () => {
    const parent = daemon.spawnMember('eng', {
      harness: 'claude-code',
      handle: 'claude',
      cwd: testCwd(),
    });
    const [started, ended] = fixture('hooks-log.jsonl')
      .map((line) => wireEventFromHook(JSON.parse(line)))
      .filter((event): event is NonNullable<typeof event> => event !== undefined);
    claudeFake.enqueue({
      kind: 'complete',
      final_text: '@richard parent complete',
      items: [
        {
          type: 'run.item',
          item_type: 'tool_call',
          payload: {
            tool: 'Agent',
            id: 'toolu-agent-1',
            input: { description: 'Inspect cache invalidation', prompt: 'Review the cache paths.' },
          },
        },
        started!,
        ended!,
      ],
    });
    daemon.postHumanMessage('eng', '@claude delegate the cache review');
    await daemon.settle();

    const extension = daemon.store.listMembers('eng').find((member) => member.kind === 'extension')!;
    expect(extension).toMatchObject({
      handle: 'claude-ext-a4fdb5',
      display_name: 'Inspect cache invalidation',
      parent: parent.id,
      state: 'dead',
      session_ref: 'a4fdb5021f374a8d1',
    });
    const run = runMessages().find((message) => message.author === parent.id)!;
    const events = daemon.readRunBlob('eng', run.id);
    expect(events.find((event) => event.type === 'extension.started')).toMatchObject({
      parent: parent.id,
      ext_member: extension.id,
      description: 'Inspect cache invalidation',
      agent_type: 'general-purpose',
    });
    expect(events.find((event) => event.type === 'extension.ended')).toMatchObject({
      ext_member: extension.id,
      summary: 'PONG',
    });

    const translator = createTurnTranslator();
    const streamEvents = fixture('hooks-subagent.jsonl')
      .flatMap((line) => translator.push(line))
      .filter((event) => event.type === 'run.item');
    claudeFake.enqueue({
      kind: 'complete',
      final_text: '@richard stream-only complete',
      items: streamEvents,
    });
    daemon.postHumanMessage('eng', '@claude stream-only observation');
    await daemon.settle();
    expect(daemon.store.listMembers('eng').filter((member) => member.kind === 'extension')).toHaveLength(1);

    claudeFake.enqueue({ kind: 'complete', final_text: '@richard extension text stayed plain' });
    const plain = daemon.postHumanMessage('eng', `@${extension.handle} status?`);
    await daemon.settle();
    expect(plain.mentions).toEqual([]);
    expect(daemon.store.listDeliveries('eng', { recipient: extension.id })).toHaveLength(0);
  });

  it('retires a still-running extension when its parent finalizes without a stop hook', async () => {
    const parent = daemon.spawnMember('eng', {
      harness: 'claude-code',
      handle: 'claude',
      cwd: testCwd(),
    });
    claudeFake.enqueue({
      kind: 'complete',
      final_text: '@richard parent ended without SubagentStop',
      items: [
        {
          type: 'extension.started',
          parent: 'native-parent',
          ext_member: 'native-extension-without-stop',
          agent_type: 'general-purpose',
        },
      ],
    });
    daemon.postHumanMessage('eng', '@claude start one extension');
    await daemon.settle();

    const extension = daemon.store.listMembers('eng').find((member) => member.parent === parent.id)!;
    expect(extension).toMatchObject({ kind: 'extension', state: 'dead' });
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

  it('the finalized run payload delivered onward contains the codor header from the run message', async () => {
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

  it('routes an untagged human message to the latest finalized agent across full room history', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha establish the default recipient');
    await daemon.settle();
    daemon.pauseMember('eng', alpha.id);

    for (let index = 0; index < 501; index++) {
      daemon.postSystemMessage('eng', `later system event ${String(index)}`);
    }
    const continuation = daemon.postHumanMessage('eng', 'continue from the deep history');

    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })).toContainEqual(
      expect.objectContaining({ message_id: continuation.id, state: 'queued' }),
    );
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

describe('meters, opt-in brakes, and stall flags', () => {
  it('runs a ten-turn agent chain to completion with the default brakes off', async () => {
    spawnAgent('alpha');
    spawnAgent('beta');
    fake.enqueue(...Array.from({ length: 10 }, (_, index) => ({
      kind: 'complete' as const,
      final_text:
        index === 9
          ? '@richard ten-hop chain complete'
          : `@${index % 2 === 0 ? 'beta' : 'alpha'} hop ${index + 1}`,
    })));
    daemon.postHumanMessage('eng', '@alpha start the long chain');
    await daemon.settle();

    expect(runMessages()).toHaveLength(10);
    expect(daemon.store.listDeliveries('eng', { state: 'held' })).toHaveLength(0);
    const meter = daemon.store.getMeter('eng', new Date().toISOString().slice(0, 10))!;
    expect(meter).toMatchObject({
      turns: 10,
      input_tokens: 1000,
      output_tokens: 200,
      uncosted_tokens: 0,
    });
    expect(meter.cost_usd).toBeCloseTo(0.1);
  });

  it('holds the fourth agent hop at turn_brake=3 and release resumes it', async () => {
    const alpha = spawnAgent('alpha');
    spawnAgent('beta');
    daemon.configureRoom('eng', { turn_brake: 3 });
    fake.enqueue(
      { kind: 'complete', final_text: '@beta hop one' },
      { kind: 'complete', final_text: '@alpha hop two' },
      { kind: 'complete', final_text: '@beta hop three' },
      { kind: 'complete', final_text: '@alpha hop four' },
    );
    daemon.postHumanMessage('eng', '@alpha start checked chain');
    await daemon.settle();

    const held = daemon.store.listDeliveries('eng', { state: 'held' });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ recipient: alpha.id, hop_count: 4 });
    expect(runMessages()).toHaveLength(4);
    expect(daemon.pushLog.at(-1)?.body).toContain('turn brake before hop 4');

    fake.enqueue({ kind: 'complete', final_text: '@richard released checkpoint complete' });
    daemon.releaseHold('eng', held[0]!.id);
    await daemon.settle();
    expect(runMessages()).toHaveLength(5);
    expect(daemon.store.getDelivery('eng', held[0]!.id)!.state).toBe('consumed');
  });

  it('spend brakes use reported dollars while tokens-only usage stays visibly uncosted', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    daemon.configureRoom('eng', { spend_brake_usd: 0.5 });
    fake.enqueue({
      kind: 'complete',
      final_text: '@beta cost threshold reached',
      usage: { input_tokens: 40, output_tokens: 10, cost_usd: 0.5 },
    });
    daemon.postHumanMessage('eng', '@alpha spend once');
    await daemon.settle();
    const held = daemon.store.listDeliveries('eng', { recipient: beta.id, state: 'held' });
    expect(held).toHaveLength(1);
    expect(daemon.pushLog.at(-1)?.body).toContain('spend brake at $0.50');

    fake.enqueue({
      kind: 'complete',
      final_text: '@richard tokens-only completion',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    daemon.releaseHold('eng', held[0]!.id);
    await daemon.settle();
    const day = new Date().toISOString().slice(0, 10);
    expect(daemon.store.getMeter('eng', day)).toMatchObject({
      turns: 2,
      cost_usd: 0.5,
      input_tokens: 52,
      output_tokens: 13,
      uncosted_tokens: 15,
    });
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === alpha.id)!.spend)
      .toMatchObject({ cost_usd: 0.5, uncosted_tokens: 0 });
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === beta.id)!.spend)
      .toMatchObject({ cost_usd: 0, uncosted_tokens: 15 });
  });

  // harn:assume resolved-run-cost-estimates-are-finalization-snapshots ref=resolved-run-estimate-regression
  // harn:assume estimated-cost-is-advisory-not-spend-brake-input-v2 ref=advisory-accounting-regression
  it('stores one resolved-model cached-aware estimate without repricing or braking', async () => {
    const priced = daemon.spawnMember('eng', {
      harness: 'fake',
      handle: 'priced',
      cwd: testCwd('priced'),
      model: 'gpt-5.5',
    });
    daemon.configureRoom('eng', { spend_brake_usd: 0.5 });
    fake.enqueue({
      kind: 'complete',
      final_text: '@richard priced tokens-only completion',
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 200_000, cached_input_tokens: 100_000, output_tokens: 100_000 },
    });
    daemon.postHumanMessage('eng', '@priced spend once');
    await daemon.settle();

    const root = runMessages().find((message) => message.author === priced.id)!;
    expect(root.run).toMatchObject({
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 200_000, cached_input_tokens: 100_000, output_tokens: 100_000 },
      estimated_cost_usd: 3.55,
    });
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === priced.id)!.spend)
      .toMatchObject({ cost_usd: 0, estimated_cost_usd: 3.55, uncosted_tokens: 0 });
    expect(daemon.store.getMeter('eng', new Date().toISOString().slice(0, 10)))
      .toMatchObject({ cost_usd: 0, estimated_cost_usd: 3.55, uncosted_tokens: 0 });

    daemon.configureMember('eng', priced.id, { model: 'gpt-5.6-luna' });
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === priced.id)!.spend)
      .toMatchObject({ cost_usd: 0, estimated_cost_usd: 3.55, uncosted_tokens: 0 });
    expect(daemon.store.listDeliveries('eng', { state: 'held' })).toHaveLength(0);

    fake.enqueue({
      kind: 'complete',
      final_text: '@richard exact cost wins',
      usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.25 },
    });
    daemon.postHumanMessage('eng', '@priced exact turn');
    await daemon.settle();
    const exactRoot = runMessages().filter((message) => message.author === priced.id).at(-1)!;
    expect(exactRoot.run).toMatchObject({
      model: 'gpt-5.6-luna',
      usage: { cost_usd: 0.25 },
    });
    expect(exactRoot.run?.estimated_cost_usd).toBeUndefined();
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === priced.id)!.spend)
      .toMatchObject({ cost_usd: 0.25, estimated_cost_usd: 3.55, uncosted_tokens: 0 });
  });
  // harn:end estimated-cost-is-advisory-not-spend-brake-input-v2
  // harn:end resolved-run-cost-estimates-are-finalization-snapshots

  it('rechecks spend before a queued agent hop starts and releases it exactly once', async () => {
    const gamma = spawnAgent('gamma');
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    daemon.configureRoom('eng', { spend_brake_usd: 0.5 });
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Keep gamma occupied?', options: [{ label: 'continue' }] },
      reply: () => '@richard gamma initial turn complete',
    });
    daemon.postHumanMessage('eng', '@gamma block while work queues');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === gamma.id),
    );

    fake.enqueue(
      {
        kind: 'complete',
        final_text: '@gamma queued while spend is low',
        usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01 },
      },
      {
        kind: 'complete',
        final_text: '@richard spend threshold crossed',
        usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.6 },
      },
      { kind: 'complete', final_text: '@richard released queued work' },
    );
    daemon.postHumanMessage('eng', '@alpha queue work for gamma');
    await until(() =>
      runMessages().find((message) => message.author === alpha.id && message.run?.status === 'completed'),
    );
    daemon.postHumanMessage('eng', '@beta add reported spend');
    await until(() =>
      runMessages().find((message) => message.author === beta.id && message.run?.status === 'completed'),
    );

    await daemon.answerInteraction('eng', interaction.id, 'continue');
    await daemon.settle();
    const held = daemon.store.listDeliveries('eng', { recipient: gamma.id, state: 'held' });
    expect(held).toHaveLength(1);
    expect(held[0]!.hop_count).toBe(1);
    expect(fake.deliveries).toHaveLength(3);
    expect(daemon.pushLog.at(-1)?.body).toContain('spend brake at $0.61');

    daemon.releaseHold('eng', held[0]!.id);
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(4);
    expect(daemon.store.getDelivery('eng', held[0]!.id)!.state).toBe('consumed');
  });

  it('resets onward hop count when any delivery in the batch is human-authored', async () => {
    const alpha = spawnAgent('alpha');
    const gamma = spawnAgent('gamma');
    const beta = spawnAgent('beta');
    daemon.pauseMember('eng', gamma.id);
    daemon.pauseMember('eng', beta.id);
    daemon.postHumanMessage('eng', '@gamma human item first');

    fake.enqueue(
      { kind: 'complete', final_text: '@gamma agent item second' },
      { kind: 'complete', final_text: '@beta onward after mixed batch' },
    );
    daemon.postHumanMessage('eng', '@alpha create the agent item');
    await daemon.settle();
    expect(
      daemon.store.listDeliveries('eng', { recipient: gamma.id, state: 'queued' }).map((item) => item.hop_count),
    ).toEqual([0, 1]);

    daemon.unpauseMember('eng', gamma.id);
    await daemon.settle();
    const onward = daemon.store.listDeliveries('eng', { recipient: beta.id, state: 'queued' });
    expect(onward).toHaveLength(1);
    expect(onward[0]!.hop_count).toBe(1);
  });

  it('flags an eventless running turn on a fake clock and clears without interrupting', async () => {
    const alpha = spawnAgent('alpha');
    daemon.configureRoom('eng', { stall_minutes: 1 });
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Wait here?', options: [{ label: 'continue' }] },
      reply: () => '@richard resumed after stall',
    });
    daemon.postHumanMessage('eng', '@alpha begin a blocking turn');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );
    const running = runMessages().find((message) => message.run?.status === 'running')!;
    daemon.checkStalls(new Date(Date.parse(running.run!.started_ts) + 2 * 60_000));
    expect(daemon.store.getMessage('eng', running.id)!.run!.stalled_since).toBeDefined();
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('awaiting_input');
    expect(daemon.pushLog.at(-1)?.body).toContain(`run #${running.id} has stalled`);

    await daemon.answerInteraction('eng', interaction.id, 'continue');
    await daemon.settle();
    expect(daemon.store.getMessage('eng', running.id)!.run!.status).toBe('completed');
    expect(daemon.store.getMessage('eng', running.id)!.run!.stalled_since).toBeUndefined();
    expect(fake.respondCalls).toHaveLength(1);
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
    // The close re-queues what the interrupted turn was carrying, so the next boot
    // re-takes it instead of the instruction being silently eaten (#492).
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })[0]!.state).toBe('queued');
  });
});

describe('interactions: the full state machine', () => {
  // harn:assume interaction-ack-preserves-finalized-member-state ref=interaction-ack-finalization-regression
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
    expect(run.run!.final_text).toBe('chose ALPHA');
    expect(resultMessageFor(run).body).toBe('chose ALPHA');
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');

    fake.enqueue({ kind: 'complete', final_text: 'follow-up complete' });
    daemon.postHumanMessage('eng', '@alpha follow up');
    await daemon.settle();
    expect(runMessages()).toHaveLength(2);
    expect(runMessages()[1]!.body).toBe('follow-up complete');
  });
  // harn:end interaction-ack-preserves-finalized-member-state

  it('rejects an interaction answer from a human outside the persisted targets', async () => {
    const alpha = spawnAgent('alpha');
    const observer = daemon.store.addMember('eng', {
      kind: 'human', handle: 'watcher', display_name: 'Watcher', role: 'observer',
    });
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Choose?', options: [{ label: 'yes' }] },
      reply: () => 'not reached',
    });
    daemon.postHumanMessage('eng', '@alpha ask');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id));

    await expect(daemon.answerInteraction('eng', interaction.id, 'yes', observer.id))
      .rejects.toThrow('is not addressed');
    expect(daemon.store.getInteraction(interaction.id)?.state).toBe('pending');
    expect(fake.respondCalls).toEqual([]);
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
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'setup',
    });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'delivering', attempt_count: 1, run_msg_id: runMsg.id });
    daemon.blobs.append('eng', runMsg.run!.events_ref, {
      type: 'run.completed',
      status: 'completed',
      model: 'gpt-5.6-sol',
      final_text: 'survived the crash @richard',
      usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 5 },
    });
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const finalized = daemon.store.getMessage('eng', runMsg.id)!;
    expect(finalized.run!.status).toBe('completed');
    expect(finalized.run).toMatchObject({
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 5 },
      estimated_cost_usd: 0.0001615,
    });
    expect(finalized.body).toBe('survived the crash @richard');
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
    expect(fake.deliveries).toHaveLength(0); // never re-ran the turn
    // onward routing fired from the finalized message
    expect(daemon.unreadCount('eng', daemon.ownerOf('eng').id)).toBeGreaterThan(0);
  });

  it('boot repair promotes a staged ACP cursor before the next cumulative turn', async () => {
    const acpRoot = mkdtempSync(join(tmpdir(), 'codor-acp-cursor-crash-'));
    const dbPath = join(acpRoot, 'switchboard.sqlite');
    const fakeAgent = fileURLToPath(new URL(
      '../../adapters/acp/test-fixtures/fake-agent.mjs', import.meta.url,
    ));
    const createAcpDaemon = () => new Daemon({
      dbPath,
      blobRoot: join(acpRoot, 'blobs'),
      adapters: [Object.assign(new AcpAdapter(), { configurable: true })],
      homeDir: acpRoot,
    });
    let crashDaemon = createAcpDaemon();
    crashDaemon.createRoom({
      id: 'cursor-crash', name: 'Cursor crash',
      owner: { handle: 'owner', display_name: 'Owner' },
    });
    const member = crashDaemon.spawnMember('cursor-crash', {
      harness: 'acp', handle: 'helper', cwd: acpRoot,
      acp_launch: {
        executable: process.execPath,
        argv: [fakeAgent, '--no-permission', '--initial-turns', '1'],
      },
    });
    crashDaemon.store.setAgentSessionRuntime(
      'cursor-crash', member.id, 'fake-acp-session', { load: true, resume: true },
    );
    const owner = crashDaemon.ownerOf('cursor-crash');
    const trigger = crashDaemon.store.postMessage('cursor-crash', {
      author: owner.id, kind: 'chat', body: '@helper crashed work',
    });
    const delivery = crashDaemon.store.createDelivery('cursor-crash', {
      message_id: trigger.id, recipient: member.id,
    });
    const started = crashDaemon.store.beginTurn('cursor-crash', {
      memberId: member.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    const firstCursor = {
      totalTokens: 20, inputTokens: 10, outputTokens: 5,
      cachedReadTokens: 3, cachedWriteTokens: 2,
    };
    crashDaemon.store.stageAgentUsageBaseline(
      'cursor-crash', member.id, started.runMessage.id, firstCursor,
    );
    crashDaemon.blobs.append('cursor-crash', started.runMessage.run!.events_ref, {
      type: 'run.completed', status: 'completed',
      usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
    });
    await crashDaemon.close();

    crashDaemon = createAcpDaemon();
    await crashDaemon.reconcile();
    await crashDaemon.settle();
    expect(crashDaemon.store.getAgentRuntimeConfig('cursor-crash', member.id)?.usage_baseline)
      .toEqual(firstCursor);

    crashDaemon.postHumanMessage('cursor-crash', '@helper next turn');
    await crashDaemon.settle();
    const latest = crashDaemon.store.listMessages('cursor-crash', { limit: 20 })
      .filter((message) => message.kind === 'run')
      .at(-1);
    expect(latest?.run?.usage).toEqual({
      input_tokens: 6, cached_input_tokens: 2, output_tokens: 4,
    });
    expect(crashDaemon.store.getAgentRuntimeConfig('cursor-crash', member.id)?.usage_baseline)
      .toMatchObject({ totalTokens: 33, cachedWriteTokens: 3 });
    await crashDaemon.close();
    rmSync(acpRoot, { recursive: true, force: true });
  });

  it('provably never started (empty blob, first attempt) → retried ONCE reusing the same run message', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'setup two',
    });
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
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'setup three',
    });
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

  it('release_hold refuses a crash retry while interactive custody is mirrored', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@alpha initialize');
    await daemon.settle();

    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'crash-held setup',
    });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running',
        started_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: `runs/${posted.id}.jsonl`,
      },
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: trigger.id,
      recipient: alpha.id,
    });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: 'delivering',
      attempt_count: 1,
      run_msg_id: runMsg.id,
    });
    daemon.blobs.append('eng', runMsg.run!.events_ref, {
      type: 'run.item',
      item_type: 'text_delta',
      payload: 'ambiguous output',
    });
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    await daemon.acquireAttachLease('eng', alpha.id, 1234);

    const deliveriesBeforeRelease = fake.deliveries.length;
    expect(() => daemon.releaseHold('eng', delivery.id)).toThrow('is not switchboard-owned');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(deliveriesBeforeRelease);
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('held');
    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('running');
  });

  it('redeliver interrupts the last-bound crashed run before creating a fresh run', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'redeliver trigger',
    });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const abandoned = daemon.store.updateMessage('eng', posted.id, {
      run: {
        status: 'running',
        started_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: `runs/${posted.id}.jsonl`,
      },
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: trigger.id,
      recipient: alpha.id,
    });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: 'held',
      attempt_count: 1,
      run_msg_id: abandoned.id,
    });
    fake.enqueue({ kind: 'complete', final_text: '@richard fresh attempt complete' });

    daemon.redeliver('eng', delivery.id);
    await daemon.settle();

    expect(daemon.store.getMessage('eng', abandoned.id)).toMatchObject({
      body: '',
      run: { status: 'interrupted' },
    });
    expect(runMessages()).toHaveLength(2);
    expect(runMessages()[1]).toMatchObject({
      body: '@richard fresh attempt complete',
      run: { status: 'completed' },
    });
  });

  it('a second failure is NOT retried again (retry once, then hold)', async () => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'setup four',
    });
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
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id,
      kind: 'chat',
      body: 'process evidence',
    });
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
    expect(runMessages()[0]!.run!.final_text).toBe('went left');
    expect(resultMessageFor(runMessages()[0]!).body).toBe('went left');
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
    expect(runMessages()[0]!.run!.final_text).toBe('went right');
    expect(resultMessageFor(runMessages()[0]!).body).toBe('went right');
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

  it('lets a human mark only their own inbox delivery read', async () => {
    const other = daemon.store.addMember('eng', {
      kind: 'human', handle: 'other-user', display_name: 'Other', role: 'member',
    });
    const owner = daemon.ownerOf('eng');
    const message = daemon.store.postMessage('eng', {
      author: other.id, kind: 'chat', body: '@richard private inbox item',
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: message.id, recipient: owner.id, state: 'consumed',
    });

    expect(() => daemon.markRead('eng', delivery.id, other.id)).toThrow('does not belong');
    expect(daemon.store.getDelivery('eng', delivery.id)?.read_ts).toBeUndefined();
    daemon.markRead('eng', delivery.id, owner.id);
    expect(daemon.store.getDelivery('eng', delivery.id)?.read_ts).toBeDefined();
  });

  // harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-regression
  // harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-regression
  it('advances the durable room edge, emits cleared deliveries, and returns projected support', () => {
    const owner = daemon.ownerOf('eng');
    const agent = spawnAgent('room-reader');
    const body = '@richard inspect sk-proj-abcdef1234567890abcdef';
    const message = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body,
      mentions: [{ member_id: owner.id, start: 0, end: 8 }],
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: message.id, recipient: owner.id, state: 'consumed',
    });
    expect(daemon.roomSupport('eng', owner.id).inbox[0]?.preview).toContain('[redacted]');
    frames.length = 0;

    const support = daemon.markRoomRead('eng', daemon.store.currentSeq('eng'), owner.id);
    expect(support.summary.unread).toBe(0);
    expect(support.inbox).toEqual([]);
    expect(frames).toContainEqual({
      room: 'eng',
      frame: expect.objectContaining({
        type: 'inbox',
        delivery: expect.objectContaining({ id: delivery.id, read_ts: expect.any(String) }),
      }),
    });
    expect(daemon.store.getMessage('eng', message.id)?.body).toContain('sk-proj-');
  });
  // harn:end room-support-is-bounded-recipient-scoped-state
  // harn:end human-room-read-cursors-are-durable-and-monotonic

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
    const persistedCwd = testCwd('persisted-workdir');
    const alpha = spawnAgent('alpha', persistedCwd);
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
    expect(second.cwd).toBe(persistedCwd); // persisted cwd reused
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
      items: [{ type: 'run.item', item_type: 'text_delta', payload: { text: 'leaked sk-proj-abcdef1234567890abcdef' } }],
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
  // harn:assume failed-run-details-never-route-as-replies ref=failed-run-daemon-regression
  it('keeps overflow detail on the failed run and never makes it a reply body', async () => {
    const alpha = spawnAgent('alpha');
    const detail = 'Prompt is too long: context window exceeded';
    fake.enqueue({ kind: 'complete', final_text: detail, error: detail, status: 'failed' });
    daemon.postHumanMessage('eng', '@alpha continue the incident');
    await daemon.settle();

    const run = daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0]!;
    expect(run.body).toBe('');
    expect(run.mentions).toEqual([]);
    expect(run.refs).toEqual([]);
    expect(run.run).toMatchObject({ status: 'failed', error: detail });
    expect(run.run).not.toHaveProperty('final_text');
    expect(daemon.store.listDeliveries('eng').filter((delivery) => delivery.message_id === run.id))
      .toEqual([]);
    expect(daemon.store.getMember('eng', alpha.id)?.state).toBe('dead');
  });

  it('keeps partial journal evidence visible without turning a failed root into a reply', async () => {
    const alpha = spawnAgent('partial-failure-alpha');
    const owner = daemon.store.getMemberByHandle('eng', 'richard')!;
    const detail = 'provider failed after partial output';
    fake.enqueue({
      kind: 'complete',
      status: 'failed',
      final_text: detail,
      error: detail,
      items: [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'root evidence' } },
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'continuation evidence' } },
      ],
      item_delay_ms: 40,
    });
    daemon.postHumanMessage('eng', '@partial-failure-alpha start');
    const root = await until(() => daemon.store.listRunMessages('eng', {
      author: alpha.id, limit: 1,
    })[0]);
    await until(() => daemon.blobs.read('eng', root.run!.events_ref)
      .some((event) => event.type === 'run.item') ? true : undefined);
    daemon.postHumanMessage('eng', 'human interjection');
    await daemon.settle();

    const failed = daemon.store.getMessage('eng', root.id)!;
    const continuations = daemon.store.listRunContinuations('eng', root.id);
    expect(failed).toMatchObject({ body: '', run: { status: 'failed', error: detail } });
    expect(failed.run).not.toHaveProperty('final_text');
    expect(continuations).toEqual([
      expect.objectContaining({ body: 'continuation evidence', run_parent_id: root.id }),
    ]);
    expect(daemon.blobs.read('eng', root.run!.events_ref)
      .filter((event) => event.type === 'run.item')
      .map((event) => event.output_message_id)).toEqual([root.id, continuations[0]!.id]);
    expect(daemon.store.listDeliveries('eng').filter((delivery) =>
      delivery.message_id === root.id || delivery.message_id === continuations[0]!.id)).toEqual([]);
    expect(daemon.store.countUnreadMessages('eng', owner.id)).toBe(2);
  });
  // harn:end failed-run-details-never-route-as-replies

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

  // harn:assume run-failure-evidence-is-surfaced ref=run-failure-evidence-regression
  it('keeps error evidence on a run reclassified failed-to-interrupted by an operator', async () => {
    const alpha = spawnAgent('alpha');
    const detail = 'error_during_execution: provider crashed as the interrupt landed';
    fake.enqueue({ kind: 'fail-on-interrupt', error: detail });
    daemon.postHumanMessage('eng', '@alpha wait for interrupt');
    await until(() =>
      daemon.store.getMember('eng', alpha.id)?.state === 'running' ? alpha : undefined,
    );

    daemon.interruptMember('eng', alpha.id);
    await daemon.settle();

    const run = runMessages()[0]!;
    expect(run.run).toMatchObject({ status: 'interrupted', error: detail });
    expect(run.body).toBe('');
  });

  it('quotes a failed run reference as labeled error evidence, not empty context', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    const detail = 'Prompt is too long: context window exceeded';
    fake.enqueue({ kind: 'complete', final_text: detail, error: detail, status: 'failed' });
    daemon.postHumanMessage('eng', '@alpha continue the incident');
    await daemon.settle();
    const failedRun = daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0]!;

    fake.enqueue({ kind: 'complete', final_text: 'looking' });
    daemon.postHumanMessage('eng', `@beta look at #${failedRun.id}`);
    await daemon.settle();

    const delivered = fake.deliveries.at(-1)!;
    expect(delivered.payload).toContain(`[run failed] ${detail}`);
  });

  // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-daemon-regression
  it('seeds an estimated gauge from the adapter peek on boot reconcile', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: 'establish a session ref' });
    daemon.postHumanMessage('eng', '@alpha hello');
    await daemon.settle();

    fake.peekUsage = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 12_000, estimated: true };
    await daemon.reconcile();
    await daemon.settle();

    const detailed = daemon.memberDetails('eng').find((d) => d.member.id === alpha.id)!;
    expect(detailed.member.lastUsage).toEqual({
      contextWindowMaxTokens: 1_000_000,
      contextWindowUsedTokens: 12_000,
      estimated: true,
    });
  });

  it('never lets a peek seed overwrite a live usage report', async () => {
    const alpha = spawnAgent('alpha');
    const live = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 55_000 };
    fake.enqueue({ kind: 'complete', final_text: 'ok', agent_usage: live });
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();

    fake.peekUsage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 1, estimated: true };
    await daemon.reconcile();
    await daemon.settle();

    const detailed = daemon.memberDetails('eng').find((d) => d.member.id === alpha.id)!;
    expect(detailed.member.lastUsage).toEqual(live);
  });

  it('drops delayed peek evidence after clear or configured-model change', async () => {
    const stale = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 44_000, estimated: true };
    const pending = new Map<string, (usage: AgentUsage) => void>();
    vi.spyOn(fake, 'peekContextUsage').mockImplementation((ref) =>
      new Promise((resolve) => pending.set(ref, resolve)));

    const cleared = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'peek-cleared', cwd: testCwd('peek-cleared'), model: 'old',
    });
    fake.enqueue({ kind: 'complete', final_text: 'establish' });
    daemon.postHumanMessage('eng', '@peek-cleared establish');
    await daemon.settle();
    const clearedRef = daemon.store.getMember('eng', cleared.id)!.session_ref!;
    await daemon.reconcile();
    await until(() => pending.has(clearedRef) ? true : undefined);
    await daemon.clearMemberContext('eng', cleared.id, daemon.ownerOf('eng').id);
    pending.get(clearedRef)!(stale);
    await daemon.settle();
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === cleared.id)?.member)
      .not.toHaveProperty('lastUsage');

    const reconfigured = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'peek-model', cwd: testCwd('peek-model'), model: 'old',
    });
    fake.enqueue({ kind: 'complete', final_text: 'establish' });
    daemon.postHumanMessage('eng', '@peek-model establish');
    await daemon.settle();
    const reconfiguredRef = daemon.store.getMember('eng', reconfigured.id)!.session_ref!;
    await daemon.reconcile();
    await until(() => pending.has(reconfiguredRef) ? true : undefined);
    daemon.configureMember('eng', reconfigured.id, { model: 'new' });
    pending.get(reconfiguredRef)!(stale);
    await daemon.settle();
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === reconfigured.id)?.member)
      .not.toHaveProperty('lastUsage');
  });

  it('drops live, completion, and compaction usage from an obsolete configured model', async () => {
    const oldUsage = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 80_000 };
    const turning = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'old-turn-usage', cwd: testCwd('old-turn-usage'), model: 'old',
    });
    fake.enqueue({
      kind: 'complete', final_text: 'old model completed', agent_usage: oldUsage,
      items: [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'started old model' } },
        { type: 'usage_updated', usage: oldUsage },
      ],
      item_delay_ms: 50,
    });
    daemon.postHumanMessage('eng', '@old-turn-usage go');
    await until(() => daemon.store.listRunMessages('eng', { author: turning.id, limit: 1 })
      .some((run) => daemon.blobs.read('eng', run.run!.events_ref)
        .some((event) => event.type === 'run.item')) ? true : undefined);
    daemon.configureMember('eng', turning.id, { model: 'new' });
    await daemon.settle();
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === turning.id)?.member)
      .not.toHaveProperty('lastUsage');
    expect(daemon.store.getMemberContextWindow('eng', turning.id)).toBeUndefined();

    const compacting = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'old-compact-usage', cwd: testCwd('old-compact-usage'), model: 'old',
    });
    fake.enqueue({ kind: 'complete', final_text: 'establish' });
    daemon.postHumanMessage('eng', '@old-compact-usage establish');
    await daemon.settle();
    fake.compactUsage = oldUsage;
    fake.holdCompactions();
    const compaction = daemon.compactMember('eng', compacting.id, daemon.ownerOf('eng').id);
    await until(() => fake.compactions.length === 1 ? true : undefined);
    daemon.configureMember('eng', compacting.id, { model: 'new' });
    fake.releaseCompactions();
    await compaction;
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === compacting.id)?.member)
      .not.toHaveProperty('lastUsage');
    expect(daemon.store.getMemberContextWindow('eng', compacting.id)).toBeUndefined();
  });
  // harn:end last-agent-usage-is-transient-and-seeded

  it('does not re-broadcast a member frame for an unchanged usage snapshot', async () => {
    const alpha = spawnAgent('alpha');
    const usage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 50_000 };
    fake.enqueue({
      kind: 'complete',
      final_text: 'ok',
      items: [
        { type: 'usage_updated', usage },
        { type: 'usage_updated', usage },
      ],
    });
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();

    // The turn-end idle transition frame also carries the overlay; the guard
    // only suppresses the usage-triggered re-broadcast during the run.
    const usageFrames = frames.filter((item) =>
      item.frame.type === 'member' &&
      item.frame.member.id === alpha.id &&
      item.frame.member.state === 'running' &&
      item.frame.member.lastUsage?.contextWindowUsedTokens === 50_000);
    expect(usageFrames).toHaveLength(1);
  });
  // harn:end run-failure-evidence-is-surfaced

  it('classifies a nonzero exit after operator interrupt as interrupted, not dead', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'fail-on-interrupt' });
    daemon.postHumanMessage('eng', '@alpha wait for interrupt');
    await until(() =>
      daemon.store.getMember('eng', alpha.id)?.state === 'running' ? alpha : undefined,
    );

    daemon.interruptMember('eng', alpha.id);
    await daemon.settle();

    expect(runMessages()[0]!.run!.status).toBe('interrupted');
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
    expect(
      daemon.store.listMessages('eng', { limit: 50 }).some((message) =>
        message.kind === 'system' && message.body.includes('died mid-run'),
      ),
    ).toBe(false);
  });
});

// harn:assume vscode-copilot-recoverable-native-failure-preserves-context ref=vscode-copilot-recoverable-finalization-regression
describe('copilot-vscode recoverable native stops', () => {
  it('keeps the member available and drains a later explicit delivery without retrying the failed turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-copilot-vscode-recoverable-'));
    const adapter = new FakeAdapter('copilot-vscode', { resume: false });
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    vi.spyOn(adapter, 'deliver').mockImplementation(async function* (_session, _payload, hooks = {}) {
      hooks.onStarted?.({});
      calls += 1;
      if (calls === 1) {
        await firstTurn;
        yield {
          type: 'run.completed',
          status: 'failed',
          error: 'native stop after partial response',
          recoverable: true,
        };
        return;
      }
      yield { type: 'run.completed', status: 'completed', final_text: 'continued explicitly' };
    });
    const registered = Object.assign(adapter, { available: () => true });
    const local = new Daemon({
      dbPath: join(root, 'switchboard.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [registered],
      homeDir: root,
      discoverModels: false,
    });
    try {
      local.createRoom({ id: 'recoverable', name: 'Recoverable', owner: { handle: 'owner', display_name: 'Owner' } });
      const member = local.spawnMember('recoverable', {
        harness: 'copilot-vscode', handle: 'copilot', cwd: root,
      });
      local.postHumanMessage('recoverable', '@copilot first prompt');
      await until(() => local.store.getMember('recoverable', member.id)?.state === 'running' ? true : undefined);
      local.postHumanMessage('recoverable', '@copilot continue explicitly');
      releaseFirst();
      await local.settle();

      expect(calls).toBe(2);
      expect(local.store.getMember('recoverable', member.id)?.state).toBe('idle');
      const runs = local.store.listRunMessages('recoverable', { author: member.id, limit: 10 });
      expect(runs).toHaveLength(2);
      const failedRun = runs.find((run) => run.run?.status === 'failed');
      const continuedRun = runs.find((run) => run.run?.status === 'completed');
      expect(failedRun?.run).toMatchObject({
        status: 'failed', error: 'native stop after partial response',
      });
      expect(failedRun?.body).toBe('');
      expect(continuedRun?.body).toBe('continued explicitly');
      expect(local.store.listMessages('recoverable', { limit: 100 }).some((message) =>
        message.kind === 'system' && message.body.includes('died mid-run'),
      )).toBe(false);
    } finally {
      await local.close({ force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
// harn:end vscode-copilot-recoverable-native-failure-preserves-context

// harn:assume copilot-vscode-boot-admission-fails-closed-without-live-cache ref=copilot-vscode-session-admission-regression
it('fails closed before a restarted Copilot VS Code member can consume queued work without its live cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codor-copilot-vscode-boot-admission-'));
  const firstAdapter = Object.assign(new FakeAdapter('copilot-vscode', { resume: false }), {
    available: () => true,
    canReviveSession: () => true,
  });
  let firstCalls = 0;
  vi.spyOn(firstAdapter, 'deliver').mockImplementation(async function* (session, _payload, hooks = {}) {
    session.session_ref ??= 'native-session';
    hooks.onStarted?.({});
    hooks.onSessionRef?.(session.session_ref);
    firstCalls += 1;
    yield firstCalls === 1
      ? {
          type: 'run.completed',
          status: 'failed',
          error: 'native stop after partial response',
          recoverable: true,
        }
      : { type: 'run.completed', status: 'completed', final_text: 'same daemon still works' };
  });
  const first = new Daemon({
    dbPath: join(root, 'switchboard.sqlite'),
    blobRoot: join(root, 'blobs'),
    adapters: [firstAdapter],
    homeDir: root,
    discoverModels: false,
  });
  let firstClosed = false;

  try {
    first.createRoom({ id: 'restart', name: 'Restart', owner: { handle: 'owner', display_name: 'Owner' } });
    const member = first.spawnMember('restart', {
      harness: 'copilot-vscode', handle: 'copilot', cwd: root,
    });
    first.postHumanMessage('restart', '@copilot first prompt');
    await first.settle();
    expect(first.store.getMember('restart', member.id)).toMatchObject({
      state: 'idle', session_ref: 'native-session',
    });

    first.postHumanMessage('restart', '@copilot same daemon continuation');
    await first.settle();
    expect(firstCalls).toBe(2);
    expect(first.store.getMember('restart', member.id)?.state).toBe('idle');
    const previousRuns = first.store.listRunMessages('restart', { author: member.id, limit: 10 }).length;
    await first.close({ force: true });
    firstClosed = true;

    const secondAdapter = Object.assign(new FakeAdapter('copilot-vscode', { resume: false }), {
      available: () => true,
      canReviveSession: () => true,
    });
    const attach = vi.spyOn(secondAdapter, 'attach');
    const deliver = vi.spyOn(secondAdapter, 'deliver');
    const second = new Daemon({
      dbPath: join(root, 'switchboard.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [secondAdapter],
      homeDir: root,
      discoverModels: false,
    });
    try {
      const prompt = second.postHumanMessage('restart', '@copilot after daemon restart');
      await second.settle();
      const queued = second.store.listDeliveries('restart', {
        recipient: member.id,
        state: 'queued',
      }).find((delivery) => delivery.message_id === prompt.id);
      expect(queued).toBeDefined();

      await second.reconcile();
      await second.settle();

      expect(attach).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(second.store.listRunMessages('restart', { author: member.id, limit: 10 })).toHaveLength(previousRuns);
      expect(second.store.listRunMessages('restart', { author: member.id, limit: 10 }))
        .not.toContainEqual(expect.objectContaining({ run: expect.objectContaining({ status: 'running' }) }));
      expect(second.store.listDeliveries('restart', { recipient: member.id, state: 'delivering' })).toHaveLength(0);
      expect(second.store.getMember('restart', member.id)?.state).toBe('dead');
      const notice = second.store.listMessages('restart', { limit: 100 }).find((message) =>
        message.kind === 'system' && message.body.includes('lost its live VS Code Copilot session'));
      expect(notice?.body).toContain('revive');
      expect(notice?.body).toContain('recreate');
    } finally {
      await second.close({ force: true });
    }
  } finally {
    if (!firstClosed) await first.close({ force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
// harn:end copilot-vscode-boot-admission-fails-closed-without-live-cache

describe('Phase 3 usability core', () => {
  it('stops a two-agent reply chain at exact ACK_OK and retains the prior default', async () => {
    const alpha = spawnAgent('alpha');
    const beta = spawnAgent('beta');
    fake.enqueue(
      { kind: 'complete', final_text: '@beta finished; acknowledge if no action is needed' },
      { kind: 'complete', final_text: '  <ACK_OK>\n' },
    );
    daemon.postHumanMessage('eng', '@alpha begin');
    await daemon.settle();

    const runs = runMessages();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ author: beta.id, body: '  <ACK_OK>\n', ack: true });
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })).toHaveLength(1);
    expect(daemon.store.latestFinalizedAgentAuthor('eng')).toBe(alpha.id);

    fake.enqueue(
      { kind: 'complete', final_text: '@beta contains <ACK_OK> but is substantive' },
      { kind: 'complete', final_text: '@richard received substantive reply' },
    );
    daemon.postHumanMessage('eng', '@alpha continue');
    await daemon.settle();
    expect(runMessages().at(-2)!.ack).toBeUndefined();
    expect(fake.deliveries.at(-1)!.payload).toContain('contains <ACK_OK> but is substantive');
  });

  it('delivers one roster block on first turn and once per membership transition', async () => {
    const alpha = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'alpha', cwd: testCwd(), purpose: 'Implements changes',
    });
    const beta = spawnAgent('beta');
    const deliver = async (label: string) => {
      fake.enqueue({ kind: 'complete', final_text: `@richard ${label}` });
      daemon.postHumanMessage('eng', `@alpha ${label}`);
      await daemon.settle();
      return fake.deliveries.at(-1)!.payload;
    };
    const rosterCount = (payload: string) => payload.match(/\[roster:/g)?.length ?? 0;

    const first = await deliver('first');
    expect(rosterCount(first)).toBe(1);
    expect(first).toContain('@richard (human)');
    expect(first).toContain('@switchboard (system)');
    expect(first).toContain('@alpha (agent, Implements changes)');
    expect(rosterCount(await deliver('unchanged'))).toBe(0);

    daemon.renameMember('eng', beta.id, 'reviewer');
    expect(await deliver('after rename')).toContain('@reviewer (agent)');
    expect(rosterCount(await deliver('rename consumed'))).toBe(0);

    const planner = daemon.joinMember('eng', {
      harness: 'fake', handle: 'planner', session_ref: 'native-planner', cwd: testCwd('planner'),
      purpose: 'Plans work',
    });
    expect(await deliver('after join')).toContain('@planner (agent, Plans work)');
    daemon.adoptMember('eng', planner.id);
    expect(rosterCount(await deliver('after adopt'))).toBe(1);

    daemon.killMember('eng', beta.id);
    daemon.removeMember('eng', beta.id);
    const removed = await deliver('after remove');
    expect(rosterCount(removed)).toBe(1);
    expect(removed).not.toContain('@reviewer (agent)');
    expect(daemon.store.getMember('eng', alpha.id)!.roster_stale).toBe(false);
  });

  // harn:assume channel-starting-agent-handle-persisted ref=starting-agent-config-regression
  it('derives collision-safe channel ids and retains starting identity on spawn failure', () => {
    const project = testCwd('demo-project');
    const first = daemon.createRoom({
      name: 'Demo Site',
      owner: { handle: 'owner-a', display_name: 'Owner A' },
      color: '#d45d5d',
      cwd: project,
      starting_agent: { harness: 'fake', handle: 'codor' },
    });
    expect(first.room).toMatchObject({
      id: 'demo-site',
      config: { color: '#d45d5d', cwd: project, starting_agent_handle: 'codor' },
    });
    expect(daemon.store.getMemberByHandle('demo-site', 'codor')).toMatchObject({ cwd: project });
    expect(daemon.createRoom({
      name: 'Demo Site', owner: { handle: 'owner-b', display_name: 'Owner B' },
    }).room.id).toBe('demo-site-2');

    vi.spyOn(fake, 'spawn').mockImplementationOnce(() => { throw new Error('fixture spawn failed'); });
    const failed = daemon.createRoom({
      name: 'Still Useful',
      owner: { handle: 'owner-c', display_name: 'Owner C' },
      cwd: project,
      starting_agent: { harness: 'fake', handle: 'codor' },
    });
    expect(failed.room.id).toBe('still-useful');
    expect(failed.room.config.starting_agent_handle).toBe('codor');
    expect(daemon.store.listMembers('still-useful').map((member) => member.kind).sort())
      .toEqual(['agent', 'human', 'system']);
    expect(daemon.store.getMemberByHandle('still-useful', 'codor')).toMatchObject({ state: 'dead' });
    expect(daemon.store.listMessages('still-useful', { limit: 10 }).at(-1)?.body)
      .toMatch(/fixture spawn failed.*remove it and spawn a replacement/);
  });

  // harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=starting-agent-create-regression
  // harn:assume spawn-default-cwd-is-absolute-or-empty ref=implicit-starting-agent-cwd-regression
  it('persists friendly starting identity and an implicit absolute channel cwd', () => {
    const created = daemon.createRoom({
      name: 'Review Room',
      owner: { handle: 'owner-review', display_name: 'Owner Review' },
      starting_agent: {
        harness: 'fake',
        handle: 'review-lead',
        display_name: 'Review Lead',
      },
    });
    expect(created.room.config.cwd).toBe(process.cwd());
    expect(daemon.store.getMemberByHandle(created.room.id, 'review-lead')).toMatchObject({
      display_name: 'Review Lead',
      cwd: process.cwd(),
    });

    expect(() => daemon.createRoom({
      name: 'Duplicate Owner Agent',
      owner: { handle: 'same-name', display_name: 'Same Name' },
      starting_agent: { harness: 'fake', handle: 'same-name', display_name: 'Same Name' },
    })).toThrow('starting agent handle @same-name is already in use by the channel owner');
    expect(daemon.store.getRoom('duplicate-owner-agent')).toBeUndefined();
  });
  // harn:end spawn-default-cwd-is-absolute-or-empty
  // harn:end starting-agent-name-derives-one-valid-identity-v6
  // harn:end channel-starting-agent-handle-persisted

  // harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-expansion-regression
  // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-snapshot-regression
  it('expands a current ordered roster into detached safe member snapshots', () => {
    const first = daemon.createAgentPreset({
      label: 'First', handle: 'first-roster-agent', harness: 'fake',
    });
    const second = daemon.createAgentPreset({
      label: 'Second', handle: 'second-roster-agent', display_name: 'Second Display',
      harness: 'fake', policy: 'workspace-write',
    });
    daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });
    const cwd = testCwd('roster');
    const created = daemon.createRoom({
      id: 'roster-room', name: 'Roster Room', owner: { handle: 'roster-owner', display_name: 'Roster Owner' },
      cwd, default_roster: true,
    });

    expect(created.room.config).toMatchObject({ cwd });
    expect(created.room.config.starting_agent_handle).toBeUndefined();
    expect(created.initialAgents.map((member) => member.handle))
      .toEqual(['first-roster-agent', 'second-roster-agent']);
    expect(created.initialAgents.map((member) => member.state)).toEqual(['idle', 'idle']);
    expect(created.initialAgents.map((member) => member.policy))
      .toEqual(['read-only', 'workspace-write']);
    expect(created.initialAgents[0]!.display_name).toBe('first-roster-agent');
    expect(created.initialAgents.every((member) => member.cwd === cwd)).toBe(true);

    daemon.updateAgentPreset(first.id, {
      label: 'First changed', handle: 'first-roster-renamed', harness: 'fake', policy: 'full-access',
    });
    expect(daemon.store.getMemberByHandle('roster-room', 'first-roster-agent')).toMatchObject({
      handle: 'first-roster-agent', policy: 'read-only', state: 'idle',
    });
    expect(daemon.store.getMemberByHandle('roster-room', 'first-roster-renamed')).toBeUndefined();
  });
  // harn:end default-roster-channel-members-are-detached-ordered-snapshots
  // harn:end default-roster-channel-selection-is-exclusive-and-preflighted

  // harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-expansion-regression
  it('rejects roster/Starting-agent mixing and invalid complete rosters before mutation', () => {
    const first = daemon.createAgentPreset({
      label: 'Valid', handle: 'valid-roster-agent', harness: 'fake',
    });
    daemon.replaceDefaultRoster({ preset_ids: [first.id] });
    const spawn = vi.spyOn(fake, 'spawn');
    expect(() => daemon.createRoom({
      id: 'mixed-roster', name: 'Mixed', owner: { handle: 'owner-mixed', display_name: 'Owner Mixed' },
      default_roster: true,
      starting_agent: { harness: 'fake', handle: 'legacy-agent' },
    } as never)).toThrow('mutually exclusive');
    expect(() => daemon.createRoom({
      id: 'owner-roster', name: 'Owner collision', owner: { handle: 'valid-roster-agent', display_name: 'Owner' },
      default_roster: true,
    })).toThrow('already in use by the channel owner');
    expect(daemon.store.getRoom('mixed-roster')).toBeUndefined();
    expect(daemon.store.getRoom('owner-roster')).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
  // harn:end default-roster-channel-selection-is-exclusive-and-preflighted

  it('normalizes cwd inputs before every local member or adapter mutation', () => {
    const project = testCwd('project');
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'file');
    const spawn = vi.spyOn(fake, 'spawn');

    expect(daemon.spawnMember('eng', {
      harness: 'fake', handle: 'home-path', cwd: '~/cwd/project',
    }).cwd).toBe(project);
    expect(daemon.joinMember('eng', {
      harness: 'fake', handle: 'joined-path', session_ref: 'joined-cwd', cwd: '~/cwd/project',
    }).cwd).toBe(project);
    expect(daemon.createRoom({
      name: 'Cwd Room', owner: { handle: 'cwd-owner', display_name: 'Cwd Owner' }, cwd: '~/cwd/project',
    }).room.config.cwd).toBe(project);

    const calls = spawn.mock.calls.length;
    expect(() => daemon.spawnMember('eng', {
      harness: 'fake', handle: 'relative', cwd: 'relative',
    })).toThrow('working directory relative must be absolute');
    expect(() => daemon.spawnMember('eng', {
      harness: 'fake', handle: 'missing', cwd: join(dir, 'missing'),
    })).toThrow(`working directory ${join(dir, 'missing')} does not exist`);
    expect(() => daemon.spawnMember('eng', {
      harness: 'fake', handle: 'file', cwd: file,
    })).toThrow(`${file} is not a directory`);
    expect(() => daemon.joinMember('eng', {
      harness: 'fake', handle: 'missing-join', session_ref: 'missing-join', cwd: join(dir, 'missing'),
    })).toThrow(`working directory ${join(dir, 'missing')} does not exist`);
    expect(() => daemon.createRoom({
      name: 'Missing Cwd',
      owner: { handle: 'missing-owner', display_name: 'Missing Owner' },
      cwd: join(dir, 'missing'),
    })).toThrow(`working directory ${join(dir, 'missing')} does not exist`);
    expect(daemon.store.getRoom('missing-cwd')).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(calls);
  });

  it('tombstones a removed agent, preserves attribution, and frees the handle', () => {
    const alpha = spawnAgent('alpha');
    const historical = daemon.store.postMessage('eng', {
      author: alpha.id, kind: 'chat', body: 'historical alpha message',
    });
    // A5: remove no longer REFUSES a live member — it kills it first, so the member is
    // still dead before it is tombstoned. The invariant is preserved; the ritual is not.
    daemon.killMember('eng', alpha.id);
    expect(daemon.store.listMessages('eng', { limit: 20 }).some((message) =>
      message.kind === 'system' && message.body.includes('remove it and spawn a replacement')))
      .toBe(true);
    const removed = daemon.removeMember('eng', alpha.id);

    expect(removed.removed_ts).toBeDefined();
    expect(daemon.store.getMember('eng', alpha.id)?.removed_ts).toBe(removed.removed_ts);
    expect(daemon.store.listMembers('eng').some((member) => member.id === alpha.id)).toBe(false);
    expect(daemon.store.getMessage('eng', historical.id)?.author).toBe(alpha.id);
    const replacement = spawnAgent('alpha');
    expect(replacement.id).not.toBe(alpha.id);
  });

  it('keeps raw S1 evidence in the journal but strips it from live frames', async () => {
    spawnAgent('alpha');
    const diff = { path: 'src/app.ts', unified: '--- a/src/app.ts\n+++ b/src/app.ts\n' };
    const image = { media_type: 'image/png', data_b64: 'aW1hZ2U=' };
    fake.enqueue({
      kind: 'complete',
      final_text: '@richard evidence complete',
      items: [{
        type: 'run.item',
        item_type: 'tool_result',
        payload: {
          call_id: 'edit-1', status: 'ok', output_text: 'done', diff, image,
          raw: { provider_secret: 'native-only' },
        },
      }],
    });
    daemon.postHumanMessage('eng', '@alpha collect evidence');
    await daemon.settle();

    const live = frames.find(({ frame }) =>
      frame.type === 'run_event' && frame.event.type === 'run.item' &&
      frame.event.item_type === 'tool_result')!.frame;
    expect((live as Extract<ServerFrame, { type: 'run_event' }>).event.payload)
      .not.toHaveProperty('raw');
    const run = runMessages()[0]!;
    expect(daemon.blobs.read('eng', run.run!.events_ref)).toContainEqual(
      expect.objectContaining({
        type: 'run.item',
        payload: expect.objectContaining({ raw: { provider_secret: 'native-only' }, diff, image }),
      }),
    );
  });

  // harn:assume canonical-spawn-controls-enforced ref=daemon-spawn-control-regression
  it('rejects canonical control violations before a directly registered adapter spawns', () => {
    const spawn = vi.spyOn(fake, 'spawn');
    expect(fake.capabilities.thinking).toBe(false);
    expect(() => daemon.spawnMember('eng', {
      harness: 'fake', handle: 'policy-break', cwd: testCwd(), policy: 'not-a-policy',
    })).toThrow('valid policies: read-only, workspace-write, full-access');
    expect(() => daemon.spawnMember('eng', {
      harness: 'fake', handle: 'thinker', cwd: testCwd(), thinking: 'high',
    })).toThrow("adapter 'fake' does not support thinking levels");
    expect(spawn).not.toHaveBeenCalled();
  });
  // harn:end canonical-spawn-controls-enforced
});

// harn:assume adapters-own-their-model-catalog ref=adapter-model-discovery-regression
describe('adapter model discovery', () => {
  const adapterWith = (id: string, listModels?: () => Promise<unknown>) =>
    ({ ...new FakeAdapter(id), id, listModels } as never);

  const daemonWith = (adapters: never[], discoverModels = true) => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-models-'));
    return new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters,
      homeDir: dir,
      discoverModels,
    });
  };

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('serves the models a harness reported, with their source', async () => {
    const daemon = daemonWith([
      adapterWith('discovers', () => Promise.resolve({ models: ['a/b'], source: 'discovered' })),
    ]);
    await settle();
    expect(daemon.registeredAdapters()[0]).toMatchObject({
      models: ['a/b'],
      models_source: 'discovered',
    });
  });

  it('degrades silently when a harness cannot be asked', async () => {
    // A missing binary, a non-zero exit, a hang killed by the timeout: all the same.
    const daemon = daemonWith([
      adapterWith('broken', () => Promise.reject(new Error('ENOENT'))),
    ]);
    await settle();
    const [adapter] = daemon.registeredAdapters();
    expect(adapter!.models).toBeUndefined();
    expect(adapter!.id).toBe('broken');
  });

  it('drops output it cannot validate rather than trusting harness stdout', async () => {
    const daemon = daemonWith([
      adapterWith('noisy', () => Promise.resolve({
        models: ['ok/model', 'rm -rf /', 'two words', '<script>'],
        source: 'discovered',
      })),
    ]);
    await settle();
    expect(daemon.registeredAdapters()[0]!.models).toEqual(['ok/model']);
  });

  it('keeps the provider-prefixed ids opencode actually reports', async () => {
    const daemon = daemonWith([
      adapterWith('nested', () => Promise.resolve({
        models: ['openrouter/anthropic/claude-sonnet-5', 'openai/gpt-4o'],
        source: 'discovered',
      })),
    ]);
    await settle();
    expect(daemon.registeredAdapters()[0]!.models).toEqual([
      'openrouter/anthropic/claude-sonnet-5',
      'openai/gpt-4o',
    ]);
  });

  it('refuses a model id that is really a flag', async () => {
    const daemon = daemonWith([
      adapterWith('hostile', () => Promise.resolve({
        models: ['--dangerously-skip-permissions', 'ok/model'],
        source: 'discovered',
      })),
    ]);
    await settle();
    expect(daemon.registeredAdapters()[0]!.models).toEqual(['ok/model']);
  });

  // harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-pending-regression
  it('says discovery is pending while a slow harness is still answering', async () => {
    let answer!: (catalog: unknown) => void;
    const slow = new Promise((resolve) => { answer = resolve as (catalog: unknown) => void; });
    const daemon = daemonWith([adapterWith('slow', () => slow as Promise<never>)]);

    // A browser arriving here must be told the empty catalog is not the final word.
    expect(daemon.modelDiscoveryPending()).toBe(true);
    expect(daemon.registeredAdapters()[0]!.models).toBeUndefined();

    answer({ models: ['a/b'], source: 'discovered' });
    await settle();
    await settle();
    expect(daemon.modelDiscoveryPending()).toBe(false);
    expect(daemon.registeredAdapters()[0]!.models).toEqual(['a/b']);
  });

  it('says nothing is pending when no harness can answer', () => {
    expect(daemonWith([adapterWith('silent')]).modelDiscoveryPending()).toBe(false);
  });

  it('stops being pending even when the harness fails', async () => {
    const daemon = daemonWith([adapterWith('broken', () => Promise.reject(new Error('ENOENT')))]);
    await settle();
    await settle();
    // Otherwise a client would ask again forever.
    expect(daemon.modelDiscoveryPending()).toBe(false);
  });
  // harn:end model-catalogs-reach-a-browser-that-arrives-early

  it('can be switched off so the browser suite stays hermetic', async () => {
    const daemon = daemonWith(
      [adapterWith('discovers', () => Promise.resolve({ models: ['a/b'], source: 'discovered' }))],
      false,
    );
    await settle();
    expect(daemon.registeredAdapters()[0]!.models).toBeUndefined();
  });

  it('leaves a harness that cannot enumerate without a list', async () => {
    const daemon = daemonWith([adapterWith('silent')]);
    await settle();
    expect(daemon.registeredAdapters()[0]!.models).toBeUndefined();
  });

  // harn:assume adapter-catalog-distinguishes-installed-and-configurable ref=adapter-catalog-regression
  // harn:assume adapter-refresh-is-authorized-and-incremental ref=adapter-refresh-runtime
  // harn:assume new-agent-requests-require-available-native-or-detected-acp ref=new-agent-provider-availability-regression
  it('filters built-ins, refreshes newly available models once, and rejects stale creation', async () => {
    const available = new Set<string>();
    const listModels = vi.fn(() => Promise.resolve({ models: ['new/model'], source: 'discovered' as const }));
    const builtin = Object.assign(adapterWith('codex', listModels), { executable: 'codex' });
    const custom = adapterWith('custom');
    const dir = mkdtempSync(join(tmpdir(), 'codor-availability-'));
    const daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'), blobRoot: join(dir, 'blobs'),
      adapters: [builtin, custom], homeDir: dir,
      executableOnPath: (executable) => available.has(executable),
    });
    daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'owner', display_name: 'Owner' } });

    expect(daemon.registeredAdapters()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', installed: false }),
      expect.objectContaining({ id: 'custom', installed: true }),
    ]));
    expect(listModels).not.toHaveBeenCalled();
    expect(() => daemon.spawnMember('eng', {
      harness: 'codex', handle: 'stale', cwd: dir,
    })).toThrow("harness 'codex' is not installed");
    expect(() => daemon.createRoom({
      id: 'stale-room', name: 'Stale', owner: { handle: 'owner2', display_name: 'Owner 2' },
      cwd: dir, starting_agent: { harness: 'codex', handle: 'stale' },
    })).toThrow("harness 'codex' is not installed");
    expect(daemon.store.getRoom('stale-room')).toBeUndefined();

    available.add('codex');
    daemon.refreshAdapterAvailability();
    await settle();
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(daemon.registeredAdapters().find((adapter) => adapter.id === 'codex')).toMatchObject({
      installed: true, models: ['new/model'],
    });
    daemon.refreshAdapterAvailability();
    await settle();
    expect(listModels).toHaveBeenCalledTimes(1);
    await daemon.close();
  });

  it('uses the bridge availability hook before discovering live Copilot models', async () => {
    let live = false;
    const listModels = vi.fn(() => Promise.resolve({
      models: ['gpt-5.6-luna'], source: 'discovered' as const,
    }));
    const bridge = Object.assign(adapterWith('copilot-vscode', listModels), {
      available: () => live,
    });
    const dir = mkdtempSync(join(tmpdir(), 'codor-copilot-models-'));
    const daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [bridge],
      homeDir: dir,
    });
    expect(daemon.registeredAdapters()).toMatchObject([
      expect.objectContaining({ id: 'copilot-vscode', installed: false }),
    ]);
    expect(listModels).not.toHaveBeenCalled();

    live = true;
    daemon.refreshAdapterAvailability();
    await settle();
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(daemon.registeredAdapters()).toMatchObject([
      expect.objectContaining({
        id: 'copilot-vscode', installed: true, models: ['gpt-5.6-luna'],
      }),
    ]);

    live = false;
    daemon.refreshAdapterAvailability();
    expect(daemon.registeredAdapters()).toMatchObject([
      expect.objectContaining({ id: 'copilot-vscode', installed: false }),
    ]);
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a configurable ACP session privately and resumes it after restart', async () => {
    const acpRoot = mkdtempSync(join(tmpdir(), 'codor-acp-daemon-'));
    const dbPath = join(acpRoot, 'switchboard.sqlite');
    const fakeAgent = fileURLToPath(new URL('../../adapters/acp/test-fixtures/fake-agent.mjs', import.meta.url));
    const log = join(acpRoot, 'methods.txt');
    const adapter = Object.assign(new AcpAdapter(), { configurable: true });
    let acpDaemon = new Daemon({
      dbPath, blobRoot: join(acpRoot, 'blobs'), adapters: [adapter], homeDir: acpRoot,
    });
    acpDaemon.createRoom({ id: 'acp-room', name: 'ACP', owner: { handle: 'owner', display_name: 'Owner' } });
    const member = acpDaemon.spawnMember('acp-room', {
      harness: 'acp', handle: 'helper', cwd: acpRoot,
      acp_launch: {
        executable: process.execPath,
        argv: [fakeAgent, '--no-permission', '--log', log],
      },
    });
    const acpCatalog = acpDaemon.registeredAdapters();
    expect(acpCatalog).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'acp', installed: false, configurable: true,
    })]));
    // Named providers are a separate detected class in the SAME catalog, command-private.
    expect(acpCatalog.filter((entry) => entry.transport === 'acp' && entry.acp_provider !== undefined)
      .map((entry) => entry.id)).toEqual(['acp:kimi', 'acp:kilo']);
    for (const entry of acpCatalog) {
      expect(entry).not.toHaveProperty('executable');
      expect(entry).not.toHaveProperty('argv');
    }
    expect(acpDaemon.store.getMember('acp-room', member.id)).not.toHaveProperty('acp_launch');
    acpDaemon.postHumanMessage('acp-room', '@helper first');
    await acpDaemon.settle();
    expect(acpDaemon.store.getMember('acp-room', member.id)?.session_ref).toBe('fake-acp-session');
    expect(acpDaemon.store.getAgentRuntimeConfig('acp-room', member.id)?.lifecycle).toEqual({
      load: true, resume: true,
    });
    await acpDaemon.close();

    acpDaemon = new Daemon({
      dbPath, blobRoot: join(acpRoot, 'blobs'),
      adapters: [Object.assign(new AcpAdapter(), { configurable: true })], homeDir: acpRoot,
    });
    acpDaemon.postHumanMessage('acp-room', '@helper second');
    await acpDaemon.settle();
    expect(readFileSync(log, 'utf8')).toContain('session/resume');
    expect(acpDaemon.store.listMessages('acp-room', { limit: 20 }).filter(
      (message) => message.kind === 'run' && message.run?.status === 'completed',
    )).toHaveLength(2);
    await acpDaemon.close();
    rmSync(acpRoot, { recursive: true, force: true });
  });
  // harn:end new-agent-requests-require-available-native-or-detected-acp
  // harn:end adapter-refresh-is-authorized-and-incremental
  // harn:end adapter-catalog-distinguishes-installed-and-configurable
});
// harn:end adapters-own-their-model-catalog

// harn:assume durable-agent-runtime-configuration ref=durable-agent-runtime-regression
describe('a rebuilt session is the same agent it was before', () => {
  const spawnThinker = (model?: string, thinking?: 'low' | 'medium' | 'high') =>
    daemon.spawnMember('eng', {
      harness: 'thinking-fake',
      handle: 'alpha',
      cwd: testCwd(),
      ...(model !== undefined && { model }),
      ...(thinking !== undefined && { thinking }),
    });

  it('carries the model and thinking level across a switchboard restart', async () => {
    // The harness holds NOTHING. Model and thinking are argv, re-derived from the
    // session every turn — so if a restart rebuilds the session without them, the
    // operator's agent quietly becomes a different, cheaper one, mid-conversation.
    spawnThinker('opus-4.8', 'high');
    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard before' });
    daemon.postHumanMessage('eng', '@alpha before the restart');
    await daemon.settle();
    expect(thinkingFake.deliveries[0]).toMatchObject({ model: 'opus-4.8', thinking: 'high' });

    await daemon.close();
    daemon = newDaemon(); // the restart: the in-memory session map is gone

    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard after' });
    daemon.postHumanMessage('eng', '@alpha after the restart');
    await daemon.settle();

    const after = thinkingFake.deliveries[1]!;
    expect(after.model, 'a restart must not silently downgrade the model').toBe('opus-4.8');
    expect(after.thinking, 'nor the thinking level').toBe('high');
  });

  it('revives a dead agent as the same agent', async () => {
    const alpha = spawnThinker('opus-4.8', 'low');
    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard hi' });
    daemon.postHumanMessage('eng', '@alpha hello');
    await daemon.settle();

    daemon.killMember('eng', alpha.id);
    daemon.reviveMember('eng', alpha.id);
    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard back' });
    daemon.postHumanMessage('eng', '@alpha you are back');
    await daemon.settle();

    expect(thinkingFake.deliveries.at(-1)).toMatchObject({ model: 'opus-4.8', thinking: 'low' });
  });

  it('means the harness default when the member never had either', async () => {
    // Absent is a real value: it means "whatever the harness defaults to". It must be
    // stored as absent and handed over as absent — never guessed at.
    spawnThinker();
    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard ok' });
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();

    await daemon.close();
    daemon = newDaemon();

    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard still ok' });
    daemon.postHumanMessage('eng', '@alpha again');
    await daemon.settle();

    const after = thinkingFake.deliveries.at(-1)!;
    expect(after.model).toBeUndefined();
    expect(after.thinking).toBeUndefined();
  });

  it('persists the private ACP usage cursor and does not recharge an equal restored snapshot', async () => {
    const acpRoot = mkdtempSync(join(tmpdir(), 'codor-acp-usage-restart-'));
    const dbPath = join(acpRoot, 'switchboard.sqlite');
    const fakeAgent = fileURLToPath(new URL(
      '../../adapters/acp/test-fixtures/fake-agent.mjs', import.meta.url,
    ));
    const createAcpDaemon = () => new Daemon({
      dbPath,
      blobRoot: join(acpRoot, 'blobs'),
      adapters: [Object.assign(new AcpAdapter(), { configurable: true })],
      homeDir: acpRoot,
    });
    let acpDaemon = createAcpDaemon();
    acpDaemon.createRoom({
      id: 'acp-usage', name: 'ACP usage', owner: { handle: 'owner', display_name: 'Owner' },
    });
    const member = acpDaemon.spawnMember('acp-usage', {
      harness: 'acp', handle: 'helper', cwd: acpRoot,
      acp_launch: { executable: process.execPath, argv: [fakeAgent, '--no-permission'] },
    });
    acpDaemon.postHumanMessage('acp-usage', '@helper first');
    await acpDaemon.settle();
    expect(acpDaemon.store.getAgentRuntimeConfig('acp-usage', member.id)?.usage_baseline)
      .toMatchObject({ totalTokens: 20, inputTokens: 10, outputTokens: 5 });
    await acpDaemon.close();

    acpDaemon = createAcpDaemon();
    acpDaemon.postHumanMessage('acp-usage', '@helper second');
    await acpDaemon.settle();
    const runs = acpDaemon.store.listMessages('acp-usage', { limit: 20 })
      .filter((message) => message.kind === 'run' && message.run?.status === 'completed');
    expect(runs.map((message) => message.run?.usage)).toEqual([
      { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
      { input_tokens: 0, output_tokens: 0 },
    ]);
    expect(acpDaemon.store.getMember('acp-usage', member.id)).not.toHaveProperty('acp_usage_baseline');
    await acpDaemon.close();
    rmSync(acpRoot, { recursive: true, force: true });
  });
});
// harn:end durable-agent-runtime-configuration

// harn:assume one-control-chooses-an-agent-everywhere ref=shared-policy-control-regression
describe('a channel-seeded agent gets the permission the operator chose', () => {
  it('spawns the starting agent with its policy', () => {
    // F11: the create-channel contract had nowhere to put a policy, so every
    // channel-seeded agent — including the one the systemd unit boot-seeds — spawned
    // with none at all, while the spawn dialog could set one. Same agent, same
    // question, two different answers.
    daemon.createRoom({
      id: 'ops',
      name: 'Ops',
      owner: { handle: 'richard', display_name: 'Richard' },
      cwd: testCwd('ops'),
      starting_agent: {
        harness: 'fake',
        handle: 'codor',
        policy: 'full-access',
      },
    });
    const seeded = daemon.store.listMembers('ops').find((member) => member.handle === 'codor')!;
    expect(seeded.policy).toBe('full-access');
  });

  it('still seeds an agent that was given no policy, and says so honestly', () => {
    daemon.createRoom({
      id: 'ops2',
      name: 'Ops 2',
      owner: { handle: 'richard', display_name: 'Richard' },
      cwd: testCwd('ops2'),
      starting_agent: { harness: 'fake', handle: 'codor' },
    });
    const seeded = daemon.store.listMembers('ops2').find((member) => member.handle === 'codor')!;
    expect(seeded.policy).toBeUndefined();
  });
});

// harn:assume member-config-is-changed-not-respawned ref=configure-member-regression
describe('changing an agent keeps the agent', () => {
  const richardId = () => daemon.ownerOf('eng').id;
  const spawnThinker = () =>
    daemon.spawnMember('eng', {
      harness: 'thinking-fake',
      handle: 'alpha',
      cwd: testCwd(),
      model: 'haiku',
      thinking: 'low',
      policy: 'read-only',
    });

  it('runs the NEXT turn on the new settings, with the same conversation', async () => {
    const alpha = spawnThinker();
    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard one' });
    daemon.postHumanMessage('eng', '@alpha one');
    await daemon.settle();
    const before = thinkingFake.deliveries[0]!;
    expect(before).toMatchObject({ model: 'haiku', thinking: 'low', policy: 'read-only' });

    daemon.configureMember('eng', alpha.id, {
      model: 'opus-4.8', thinking: 'high', policy: 'workspace-write',
    }, { actor: richardId() });

    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard two' });
    daemon.postHumanMessage('eng', '@alpha two');
    await daemon.settle();
    const after = thinkingFake.deliveries[1]!;
    expect(after).toMatchObject({ model: 'opus-4.8', thinking: 'high', policy: 'workspace-write' });
    // The conversation is the point: the agent resumes, it is not replaced.
    expect(after.session_ref, 'the conversation must survive the change').toBe(before.session_ref);
    expect(after.attached || after.session_ref === before.session_ref).toBe(true);
  });

  it('clears a setting back to the harness default when asked, rather than guessing', () => {
    const alpha = spawnThinker();
    const updated = daemon.configureMember('eng', alpha.id, { model: null, thinking: null }, {});
    expect(updated.model).toBeUndefined();
    expect(updated.thinking).toBeUndefined();
  });

  it('survives a switchboard restart', async () => {
    const alpha = spawnThinker();
    daemon.configureMember('eng', alpha.id, { model: 'opus-4.8' }, { actor: richardId() });
    await daemon.close();
    daemon = newDaemon();

    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard ok' });
    daemon.postHumanMessage('eng', '@alpha still you?');
    await daemon.settle();
    expect(thinkingFake.deliveries.at(-1)!.model).toBe('opus-4.8');
  });

  it('refuses a thinking level the harness cannot honour, rather than recording it', () => {
    const beta = daemon.spawnMember('eng', { harness: 'fake', handle: 'beta', cwd: testCwd('b') });
    expect(() => daemon.configureMember('eng', beta.id, { thinking: 'high' }, {}))
      .toThrow("adapter 'fake' does not support thinking levels");
    // And it recorded nothing.
    expect(daemon.store.getMember('eng', beta.id)!.thinking).toBeUndefined();
  });
});
// harn:end member-config-is-changed-not-respawned

// harn:assume a-permission-change-is-never-silent ref=configure-audit-regression
describe('a permission change is never silent', () => {
  const systemBodies = () =>
    daemon.store.listMessages('eng', { limit: 100 })
      .filter((message) => message.kind === 'system')
      .map((message) => message.body);

  it('posts who changed what, from which value to which', () => {
    const alpha = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'alpha', cwd: testCwd(), policy: 'read-only',
    });
    daemon.configureMember('eng', alpha.id, { policy: 'full-access' }, {
      actor: daemon.ownerOf('eng').id,
    });
    // A capability change visible only as a flicker in a member frame is one nobody saw.
    expect(systemBodies()).toContainEqual(
      expect.stringContaining('@richard changed @alpha — policy: read-only → full-access'),
    );
  });

  it('says nothing when nothing changed', () => {
    const alpha = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'alpha', cwd: testCwd(), policy: 'read-only',
    });
    const before = systemBodies().length;
    daemon.configureMember('eng', alpha.id, { policy: 'read-only' }, {
      actor: daemon.ownerOf('eng').id,
    });
    expect(systemBodies()).toHaveLength(before);
  });

  it('refuses a member this switchboard does not own', () => {
    const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: testCwd() });
    daemon.store.updateMember('eng', alpha.id, { custody: 'mirrored' });
    // A half-applied remote change is worse than a refused one.
    expect(() => daemon.configureMember('eng', alpha.id, { policy: 'full-access' }, {}))
      .toThrow(/mirrored from another switchboard/);
    expect(daemon.store.getMember('eng', alpha.id)!.policy).not.toBe('full-access');
  });

  it('configures a dead member, and revive brings back the agent last asked for', async () => {
    const alpha = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'alpha', cwd: testCwd(), policy: 'read-only',
    });
    fake.enqueue({ kind: 'complete', final_text: '@richard hi' });
    daemon.postHumanMessage('eng', '@alpha hello');
    await daemon.settle();

    daemon.killMember('eng', alpha.id);
    daemon.configureMember('eng', alpha.id, { policy: 'workspace-write' }, {
      actor: daemon.ownerOf('eng').id,
    });
    daemon.reviveMember('eng', alpha.id);

    fake.enqueue({ kind: 'complete', final_text: '@richard back' });
    daemon.postHumanMessage('eng', '@alpha back?');
    await daemon.settle();
    expect(fake.deliveries.at(-1)!.policy).toBe('workspace-write');
  });
});
// harn:end a-permission-change-is-never-silent

// harn:assume member-config-is-changed-not-respawned ref=configure-member-regression
describe('a turn is never assembled from a mixture of old and new settings', () => {
  it('completes an in-flight turn on the OLD settings and runs the next entirely on the NEW', async () => {
    // The guarantee is structural, not careful: a turn builds its arguments once, from
    // the session object it holds. configure never touches that object — it writes the
    // row and DROPS the cached session — so the running turn cannot see half a change,
    // and the next turn rebuilds from one row and therefore sees all of it.
    const alpha = daemon.spawnMember('eng', {
      harness: 'thinking-fake',
      handle: 'alpha',
      cwd: testCwd(),
      model: 'haiku',
      thinking: 'low',
      policy: 'read-only',
    });
    thinkingFake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Hold this turn open?', options: [{ label: 'ok' }] },
      reply: () => 'held turn done',
    });
    daemon.postHumanMessage('eng', '@alpha start a long turn');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );

    // Change everything, mid-turn.
    daemon.configureMember('eng', alpha.id, {
      model: 'opus-4.8', thinking: 'high', policy: 'full-access',
    }, { actor: daemon.ownerOf('eng').id });

    // The turn in flight is untouched: every field is the one it started with.
    expect(thinkingFake.deliveries[0]).toMatchObject({
      model: 'haiku', thinking: 'low', policy: 'read-only',
    });

    // And it still finishes — a settings change does not disturb a running turn.
    await daemon.answerInteraction('eng', interaction.id, 'ok');
    await daemon.settle();
    expect(runMessages().at(-1)!.run!.status).toBe('completed');

    thinkingFake.enqueue({ kind: 'complete', final_text: '@richard next' });
    daemon.postHumanMessage('eng', '@alpha next turn');
    await daemon.settle();

    // The next turn is entirely the new agent. Not one field of the old one survives.
    expect(thinkingFake.deliveries.at(-1)).toMatchObject({
      model: 'opus-4.8', thinking: 'high', policy: 'full-access',
    });
  });
});
// harn:end member-config-is-changed-not-respawned

// harn:assume removing-an-agent-is-one-deliberate-step ref=remove-member-regression
describe('removing an agent leaves nothing of it behind', () => {
  it('removes a RUNNING member in one step, interrupting it first', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Hold the turn', options: [{ label: 'ok' }] },
      reply: () => 'done',
    });
    daemon.postHumanMessage('eng', '@alpha start');
    await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((item) => item.member_id === alpha.id),
    );

    daemon.removeMember('eng', alpha.id);

    // Dead before removed — the invariant is preserved, not bypassed.
    const removed = daemon.store.getMember('eng', alpha.id)!;
    expect(removed.state).toBe('dead');
    expect(removed.removed_ts).toBeDefined();
    // No half-state: the card it was waiting on is not left pending forever.
    expect(daemon.store.listInteractions('eng', 'pending')).toHaveLength(0);
    // And it is gone from the roster the operator sees.
    expect(daemon.memberDetails('eng').map((item) => item.member.id)).not.toContain(alpha.id);
  });

  it('consumes the work still queued for it, rather than leaving it in the pump', async () => {
    const alpha = spawnAgent('alpha');
    daemon.pauseMember('eng', alpha.id); // hold the queue so work piles up
    daemon.postHumanMessage('eng', '@alpha one');
    daemon.postHumanMessage('eng', '@alpha two');
    await daemon.settle();
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(2);

    daemon.removeMember('eng', alpha.id);

    // Work addressed to a member that no longer exists has nowhere to go.
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(0);
    expect(daemon.store.listMessages('eng', { limit: 100 }).map((message) => message.body))
      .toContainEqual(expect.stringContaining('2 queued messages dropped'));
  });

  it('refuses the whole operation while an interactive attach lease is held', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard ready' });
    daemon.postHumanMessage('eng', '@alpha ready?');
    await daemon.settle();
    await daemon.acquireAttachLease('eng', alpha.id, 4242);
    // Refused BEFORE anything is written: no orphaned lease, no half-removed member.
    expect(() => daemon.removeMember('eng', alpha.id)).toThrow(/attach lease/);
    const untouched = daemon.store.getMember('eng', alpha.id)!;
    expect(untouched.state).not.toBe('dead');
    expect(untouched.removed_ts).toBeUndefined();
  });

  it('keeps the author of every message the agent ever wrote', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard I did the thing' });
    daemon.postHumanMessage('eng', '@alpha do the thing');
    await daemon.settle();
    const run = runMessages().at(-1)!;

    daemon.removeMember('eng', alpha.id);

    // The tombstone is the whole point: the row survives so history keeps its author.
    expect(daemon.store.getMember('eng', alpha.id)!.handle).toBe('alpha');
    expect(daemon.store.listMessages('eng', { limit: 100 }).find((m) => m.id === run.id)!.author)
      .toBe(alpha.id);
  });
});
// harn:end removing-an-agent-is-one-deliberate-step

// harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-admission-regression
describe('the turn pump never resurrects consumed work', () => {
  const runs = () => daemon.store.listMessages('eng', { limit: 100 }).filter((m) => m.kind === 'run');

  it('starts no turn, and posts no empty run, when its whole batch was consumed', async () => {
    const alpha = spawnAgent('alpha');
    daemon.pauseMember('eng', alpha.id); // hold the queue so the work is still selectable
    daemon.postHumanMessage('eng', '@alpha work');
    await daemon.settle();
    const [queued] = daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });

    // Consumed from OUTSIDE the pump — exactly what the A5 removal drain does.
    daemon.store.updateDelivery('eng', queued!.id, { state: 'consumed' });

    daemon.unpauseMember('eng', alpha.id);
    await daemon.settle();

    expect(fake.deliveries, 'consumed work must never reach the harness').toHaveLength(0);
    expect(runs(), 'an empty run message is a defect of its own').toHaveLength(0);
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
  });

  it('runs the remainder when only part of the batch was consumed', async () => {
    const alpha = spawnAgent('alpha');
    daemon.pauseMember('eng', alpha.id);
    daemon.postHumanMessage('eng', '@alpha one');
    daemon.postHumanMessage('eng', '@alpha two');
    await daemon.settle();
    const queued = daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });
    expect(queued).toHaveLength(2);

    daemon.store.updateDelivery('eng', queued[0]!.id, { state: 'consumed' });

    fake.enqueue({ kind: 'complete', final_text: '@richard did the rest' });
    daemon.unpauseMember('eng', alpha.id);
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]!.payload).toContain('@alpha two');
    expect(fake.deliveries[0]!.payload, 'the consumed one must not be in the payload')
      .not.toContain('@alpha one');
  });

  // Requirement (d): the invariant must hold against EVERY site that consumes, not once.
  it('holds when the member is removed mid-queue (the A5 removal drain)', async () => {
    const alpha = spawnAgent('alpha');
    daemon.pauseMember('eng', alpha.id);
    daemon.postHumanMessage('eng', '@alpha work');
    await daemon.settle();

    daemon.removeMember('eng', alpha.id); // kills, tombstones, and drains its queue

    await daemon.settle();
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' })).toHaveLength(0);
  });

  it('holds when a turn completes (the end-of-turn consumption)', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'complete', final_text: '@richard done' });
    daemon.postHumanMessage('eng', '@alpha work');
    await daemon.settle();

    // Its deliveries are consumed by completeTurn; nothing may re-deliver them.
    const consumed = daemon.store.listDeliveries('eng', { recipient: alpha.id, state: 'consumed' });
    expect(consumed.length).toBeGreaterThan(0);

    await daemon.settle();
    expect(fake.deliveries, 'a completed turn is not re-run').toHaveLength(1);
    expect(runs()).toHaveLength(1);
  });
});
// harn:end only-an-admissible-delivery-becomes-delivering

// harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-daemon-regression
describe('durable ephemeral approval answers', () => {
  const raise = async (kind: 'ask' | 'approval', prompt: string) => {
    const alpha = spawnAgent(`interaction-${kind}`);
    fake.enqueue({
      kind: 'ask',
      card: { kind, prompt, options: [{ label: 'Allow once' }, { label: 'Deny' }] },
      reply: (answer) => `adapter received ${String(answer)}`,
    });
    daemon.postHumanMessage('eng', `@${alpha.handle} request permission`);
    const interaction = await until(() => daemon.store.listInteractions('eng', 'pending')
      .find((item) => item.member_id === alpha.id));
    return { alpha, interaction };
  };

  it('reads every target inbox and emits committed frames without an approval chat', async () => {
    const admin = daemon.store.addMember('eng', {
      kind: 'human', handle: 'approval-admin', display_name: 'Approval Admin', role: 'admin',
    });
    const { interaction } = await raise('approval', 'Deploy to production?');
    const owner = daemon.ownerOf('eng');
    const targetDeliveries = daemon.store.listDeliveries('eng')
      .filter((delivery) => delivery.message_id === interaction.message_id);
    expect(targetDeliveries.map((delivery) => delivery.recipient).sort())
      .toEqual([owner.id, admin.id].sort());
    frames = [];

    await daemon.answerInteraction('eng', interaction.id, 'Allow once', owner.id);
    await daemon.settle();

    expect(daemon.store.getInteraction(interaction.id)).toMatchObject({
      state: 'acked', answer: 'Allow once', answered_by: owner.id,
    });
    expect(targetDeliveries.map((delivery) => daemon.store.getDelivery('eng', delivery.id)?.read_ts)
      .every((readTs) => readTs !== undefined)).toBe(true);
    expect(targetDeliveries.map(
      (delivery) => daemon.store.getDelivery('eng', delivery.id)?.interaction_resolved_ts,
    ).every((resolvedTs) => resolvedTs !== undefined)).toBe(true);
    expect(frames.filter(({ frame }) => frame.type === 'inbox'
      && frame.delivery.message_id === interaction.message_id)
      .map(({ frame }) => frame.type === 'inbox' ? frame.delivery.read_ts : undefined))
      .toHaveLength(2);
    expect(daemon.store.listMessages('eng', { limit: 100 })
      .filter((message) => message.reply_to === interaction.message_id)).toEqual([]);
    expect(fake.respondCalls.at(-1)).toEqual({
      interaction_id: interaction.native_id, answer: 'Allow once',
    });
  });

  it('preserves the visible reply audit for an ordinary question', async () => {
    const { interaction } = await raise('ask', 'Which environment?');
    await daemon.answerInteraction('eng', interaction.id, 'Allow once');
    await daemon.settle();

    expect(daemon.store.listMessages('eng', { limit: 100 })
      .find((message) => message.reply_to === interaction.message_id)).toMatchObject({
        kind: 'chat', body: 'Allow once',
      });
  });

  it('surfaces acknowledgement failure after persisting answer and inbox reads', async () => {
    const { interaction } = await raise('approval', 'Run the command?');
    const deliveries = daemon.store.listDeliveries('eng')
      .filter((delivery) => delivery.message_id === interaction.message_id);
    fake.failNextResponse('stream closed before approval ack');

    await expect(daemon.answerInteraction('eng', interaction.id, 'Allow once')).rejects.toThrow(
      'stream closed before approval ack',
    );
    expect(daemon.store.getInteraction(interaction.id)).toMatchObject({ state: 'answered' });
    expect(deliveries.map((delivery) => daemon.store.getDelivery('eng', delivery.id)?.read_ts)
      .every((readTs) => readTs !== undefined)).toBe(true);
    expect(deliveries.map(
      (delivery) => daemon.store.getDelivery('eng', delivery.id)?.interaction_resolved_ts,
    ).every((resolvedTs) => resolvedTs !== undefined)).toBe(true);
    expect(daemon.store.listMessages('eng', { limit: 100 })
      .some((message) => message.reply_to === interaction.message_id)).toBe(false);
  });

  // harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-daemon-regression
  it('keeps a notification-read approval unresolved and answerable', async () => {
    const { interaction } = await raise('approval', 'Approve after opening the notification?');
    const owner = daemon.ownerOf('eng');
    const delivery = daemon.store.listDeliveries('eng', { recipient: owner.id })
      .find((candidate) => candidate.message_id === interaction.message_id)!;

    const read = daemon.markRead('eng', delivery.id, owner.id);

    expect(read.read_ts).toBeDefined();
    expect(read.interaction_resolved_ts).toBeUndefined();
    expect(daemon.store.getInteraction(interaction.id)).toMatchObject({ state: 'pending' });
  });

  it('resolves target deliveries when an unanswered approval becomes orphaned', async () => {
    const { alpha, interaction } = await raise('approval', 'Approve before the agent is killed?');
    const deliveries = daemon.store.listDeliveries('eng')
      .filter((delivery) => delivery.message_id === interaction.message_id);
    frames = [];

    daemon.killMember('eng', alpha.id);

    expect(daemon.store.getInteraction(interaction.id)).toMatchObject({ state: 'orphaned' });
    expect(deliveries.map((delivery) => daemon.store.getDelivery('eng', delivery.id))
      .every((delivery) => delivery?.read_ts !== undefined
        && delivery.interaction_resolved_ts !== undefined)).toBe(true);
    expect(frames.filter(({ frame }) => frame.type === 'inbox'
      && frame.delivery.message_id === interaction.message_id)).toHaveLength(deliveries.length);
  });
  // harn:end approval-deliveries-project-resolution-separately
});
// harn:end approval-answer-is-atomic-and-chatless

// harn:assume collaboration-round-release-is-one-barrier ref=collaboration-barrier-regression
// harn:assume group-participant-terminality-commits-with-the-turn ref=collaboration-finalization-regression
// harn:assume grouped-deliveries-retain-agent-briefings ref=grouped-delivery-briefing-regression
describe('barriered collaboration rounds', () => {
  it('waits for every first-round result and releases one finish-order-independent bundle', async () => {
    const alpha = spawnAgent('group-alpha');
    const beta = spawnAgent('group-beta');
    const gamma = spawnAgent('group-gamma');
    fake.enqueue(
      { kind: 'complete', final_text: '@group-gamma alpha result', delay_ms: 80 },
      { kind: 'complete', final_text: '@group-alpha @group-gamma beta result', delay_ms: 5 },
      { kind: 'complete', final_text: 'gamma received the bundle' },
      { kind: 'complete', final_text: 'alpha received the bundle' },
    );

    const root = daemon.postHumanMessage(
      'eng',
      '@group-alpha @group-beta compare the implementations',
    );
    await until(() => {
      const betaRun = runMessages().find((message) => message.author === beta.id);
      const alphaRun = runMessages().find((message) => message.author === alpha.id);
      return betaRun?.run?.status === 'completed' && alphaRun?.run?.status === 'running'
        ? true
        : undefined;
    });
    expect(fake.deliveries).toHaveLength(2);
    expect(daemon.store.getCollaborationGroupByRoot('eng', root.id)).toBeDefined();
    expect(daemon.store.listCollaborationRounds(
      'eng', daemon.store.getCollaborationGroupByRoot('eng', root.id)!.id,
    )).toHaveLength(1);

    await daemon.settle();
    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    expect(group.state).toBe('completed');
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('released');
    expect(daemon.store.getCollaborationRound('eng', group.id, 2)?.state).toBe('closed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([alpha.id, beta.id]);
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)
      .map((participant) => participant.member_id)).toEqual([gamma.id, alpha.id]);

    const roundOnePayloads = fake.deliveries.slice(0, 2).map((delivery) => delivery.payload);
    for (const payload of roundOnePayloads) {
      expect(payload).toContain('[group routing:');
      expect(payload).toContain('[roster:');
      expect(payload).toContain('[conventions:');
      expect(payload).toContain('@mention invokes');
    }

    const roundTwoPayloads = fake.deliveries.slice(2).map((delivery) => delivery.payload);
    expect(roundTwoPayloads).toHaveLength(2);
    const groupCore = (payload: string): string => {
      const briefing = payload.search(/\n\[(?:roster|conventions):/);
      return briefing === -1 ? payload : payload.slice(0, briefing);
    };
    expect(groupCore(roundTwoPayloads[0]!).replace('you=@group-gamma', 'you=@recipient'))
      .toBe(groupCore(roundTwoPayloads[1]!).replace('you=@group-alpha', 'you=@recipient'));
    expect(roundTwoPayloads[0]!.indexOf('@group-alpha - completed'))
      .toBeLessThan(roundTwoPayloads[0]!.indexOf('@group-beta - completed'));
    const gammaPayload = roundTwoPayloads.find((payload) => payload.includes('you=@group-gamma'))!;
    const alphaPayload = roundTwoPayloads.find((payload) => payload.includes('you=@group-alpha'))!;
    expect(gammaPayload).toContain('[conventions:');
    expect(alphaPayload).not.toContain('[conventions:');
  });

  it('refreshes conventions after misaddress without changing the shared group core', async () => {
    const alpha = spawnAgent('brief-alpha');
    const beta = spawnAgent('brief-beta');
    fake.enqueue({ kind: 'complete', final_text: '@missing-member could not be resolved' });
    daemon.postHumanMessage('eng', '@brief-alpha establish ordinary context');
    await daemon.settle();
    expect(daemon.store.getMember('eng', alpha.id)?.misaddressed).toBe(true);

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@brief-beta establish ordinary context');
    await daemon.settle();
    expect(daemon.store.getMember('eng', beta.id)?.conventions_sent).toBe(true);

    fake.enqueue(
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );
    daemon.postHumanMessage('eng', '@brief-alpha @brief-beta compare with refreshed context');
    await daemon.settle();

    const grouped = fake.deliveries.filter((delivery) =>
      delivery.payload.includes('compare with refreshed context'));
    const alphaPayload = grouped.find((delivery) =>
      delivery.payload.includes('you=@brief-alpha'))!.payload;
    const betaPayload = grouped.find((delivery) =>
      delivery.payload.includes('you=@brief-beta'))!.payload;
    expect(alphaPayload).toContain('[conventions:');
    expect(betaPayload).not.toContain('[conventions:');
    expect(alphaPayload).toContain('[group routing:');
    expect(betaPayload).toContain('[group routing:');
    expect(daemon.store.getMember('eng', alpha.id)?.misaddressed).toBe(false);
  });

  it('presents failed and acknowledged slots but routes only completed substantive mentions', async () => {
    const alpha = spawnAgent('status-alpha');
    const beta = spawnAgent('status-beta');
    const charlie = spawnAgent('status-charlie');
    const gamma = spawnAgent('status-gamma');
    const delta = spawnAgent('status-delta');
    fake.enqueue(
      { kind: 'complete', status: 'failed', final_text: '@status-gamma failure text' },
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '@status-delta inspect the combined result' },
      { kind: 'complete', final_text: 'delta done' },
    );

    const root = daemon.postHumanMessage(
      'eng',
      '@status-alpha @status-beta @status-charlie compare status handling',
    );
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.terminal_status)).toEqual([
      'failed', 'completed', 'completed',
    ]);
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)
      .map((participant) => participant.member_id)).toEqual([delta.id]);
    expect(daemon.store.listDeliveries('eng', { recipient: gamma.id })).toEqual([]);
    const deltaPayload = fake.deliveries.find((delivery) =>
      delivery.payload.includes('you=@status-delta') && delivery.payload.includes('completed round 1'))!.payload;
    expect(deltaPayload).toContain('@status-alpha - failed');
    expect(deltaPayload).toContain('@status-beta - acknowledged');
    expect(deltaPayload).not.toContain('\n<ACK_OK>\n');
    expect(daemon.store.getMessage(
      'eng',
      daemon.store.listCollaborationParticipants('eng', group.id, 1)[1]!.result_message_id!,
    )?.ack).toBe(true);
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([alpha.id, beta.id, charlie.id]);
  });
});
// harn:end grouped-deliveries-retain-agent-briefings

describe('continuation collaboration results', () => {
  it('records the terminal fragment id while the next round receives the full aggregate', async () => {
    const alpha = spawnAgent('aggregate-group-alpha');
    const beta = spawnAgent('aggregate-group-beta');
    const gamma = spawnAgent('aggregate-group-gamma');
    fake.enqueue(
      {
        kind: 'complete',
        final_text: 'alpha firstalpha second @aggregate-group-gamma',
        items: [
          { type: 'run.item', item_type: 'text_delta', payload: { text: 'alpha first' } },
          {
            type: 'run.item', item_type: 'text_delta',
            payload: { text: 'alpha second @aggregate-group-gamma' },
          },
        ],
        item_delay_ms: 60,
      },
      { kind: 'complete', final_text: '<ACK_OK>', delay_ms: 5 },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );

    const trigger = daemon.postHumanMessage(
      'eng',
      '@aggregate-group-alpha @aggregate-group-beta compare aggregate routing',
    );
    const alphaRoot = await until(() => daemon.store.listRunMessages('eng', {
      author: alpha.id, limit: 1,
    })[0]);
    await until(() => daemon.blobs.read('eng', alphaRoot.run!.events_ref)
      .some((event) => event.type === 'run.item' && event.item_type === 'text_delta')
      ? true
      : undefined);
    daemon.postHumanMessage('eng', 'human message between alpha stretches');
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', trigger.id)!;
    const alphaParticipant = daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .find((participant) => participant.member_id === alpha.id)!;
    const result = daemon.store.getMessage('eng', alphaParticipant.result_message_id!)!;
    const lifecycleRoot = daemon.store.getRunRoot('eng', result)!;
    expect(alphaParticipant.terminal_status).toBe('completed');
    expect(result).toMatchObject({ run_parent_id: lifecycleRoot.id });
    expect(result.id).not.toBe(lifecycleRoot.id);
    expect(lifecycleRoot.run).toMatchObject({
      final_text: 'alpha firstalpha second @aggregate-group-gamma',
      result_message_id: result.id,
    });
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)
      .map((participant) => participant.member_id)).toEqual([gamma.id]);
    const gammaPayload = fake.deliveries.find((delivery) =>
      delivery.payload.includes('you=@aggregate-group-gamma')
      && delivery.payload.includes('completed round 1'))!.payload;
    expect(gammaPayload).toContain('alpha firstalpha second @aggregate-group-gamma');
    expect(gammaPayload).toContain(
      `completed round 1 result 1/2 - @aggregate-group-alpha - completed - #${String(result.id)}`,
    );
  });
});

// harn:end group-participant-terminality-commits-with-the-turn
// harn:end collaboration-round-release-is-one-barrier

// harn:assume group-generated-deliveries-obey-existing-brakes ref=group-generated-brake-regression
describe('collaboration delivery brakes', () => {
  it('holds a generated second round at the spend brake and releases it exactly once', async () => {
    const alpha = spawnAgent('brake-alpha');
    const beta = spawnAgent('brake-beta');
    const gamma = spawnAgent('brake-gamma');
    daemon.configureRoom('eng', { spend_brake_usd: 0.01 });
    fake.enqueue(
      { kind: 'complete', final_text: '@brake-gamma inspect the combined result' },
      { kind: 'complete', final_text: 'beta result without another recipient' },
    );

    const root = daemon.postHumanMessage('eng', '@brake-alpha @brake-beta compare under brake');
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const held = daemon.store.listDeliveries('eng', { recipient: gamma.id, state: 'held' });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ group_id: group.id, group_round: 2, hop_count: 1 });
    expect(fake.deliveries).toHaveLength(2);
    expect(group.state).toBe('open');
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('released');
    expect(daemon.store.getCollaborationRound('eng', group.id, 2)?.state).toBe('collecting');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)[0]?.terminal_status)
      .toBeUndefined();

    fake.enqueue({ kind: 'complete', final_text: 'gamma finished after release' });
    daemon.releaseHold('eng', held[0]!.id);
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(3);
    expect(daemon.store.getDelivery('eng', held[0]!.id)?.state).toBe('consumed');
    expect(daemon.store.getCollaborationGroup('eng', group.id)?.state).toBe('completed');
    expect(daemon.store.getCollaborationRound('eng', group.id, 2)?.state).toBe('closed');
  });
});
// harn:end group-generated-deliveries-obey-existing-brakes

// harn:assume eligible-multi-agent-routing-starts-one-group ref=multi-agent-group-regression
// harn:assume interim-agent-posts-are-nonfinal-routing ref=interim-post-regression
describe('collaboration ingress boundaries', () => {
  it('keeps one-agent human routing ordinary', async () => {
    const alpha = spawnAgent('single-alpha');
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });

    const root = daemon.postHumanMessage('eng', '@single-alpha handle this directly');
    await daemon.settle();

    expect(daemon.store.getCollaborationGroupByRoot('eng', root.id)).toBeUndefined();
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id }))
      .toEqual([expect.objectContaining({ message_id: root.id, group_id: undefined })]);
  });

  it('starts one retry-safe group from multi-agent bridge ingress', async () => {
    const alpha = spawnAgent('bridge-alpha');
    const beta = spawnAgent('bridge-beta');
    const bridge = daemon.enableBridge('eng', 'slack', 'C-GROUP').member;
    fake.enqueue(
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );
    const origin = { platform: 'slack', external_id: 'group-1', sender_name: 'Sarah' };

    const first = daemon.postBridgeMessage(
      'eng', bridge.id, '@bridge-alpha @bridge-beta compare this', origin,
    );
    const duplicate = daemon.postBridgeMessage(
      'eng', bridge.id, '@bridge-alpha @bridge-beta duplicate', origin,
    );
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', first.message.id)!;
    expect(duplicate).toMatchObject({ deduped: true, message: { id: first.message.id } });
    expect(group.state).toBe('completed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([alpha.id, beta.id]);
    expect(daemon.store.listCollaborationGroups('eng')).toHaveLength(1);
  });

  it('starts a group from an ordinary finalized agent result with two recipients', async () => {
    const alpha = spawnAgent('final-alpha');
    const beta = spawnAgent('final-beta');
    const gamma = spawnAgent('final-gamma');
    fake.enqueue(
      { kind: 'complete', final_text: '@final-beta @final-gamma compare my result' },
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );

    daemon.postHumanMessage('eng', '@final-alpha produce a result');
    await daemon.settle();

    const result = runMessages().find((message) => message.author === alpha.id)!;
    const group = daemon.store.getCollaborationGroupByRoot('eng', result.id)!;
    expect(group.state).toBe('completed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([beta.id, gamma.id]);
  });

  it('starts and deduplicates a group from a mirrored finalized result', async () => {
    const planner = daemon.joinMember('eng', {
      harness: 'fake',
      handle: 'mirror-planner',
      session_ref: 'mirror-group-session',
      cwd: testCwd('mirror-group'),
    });
    const beta = spawnAgent('mirror-beta');
    const gamma = spawnAgent('mirror-gamma');
    fake.enqueue(
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );

    const first = daemon.mirrorTurn({
      harness: 'fake',
      session_ref: 'mirror-group-session',
      native_turn_id: 'mirror-group-turn',
      body: '@mirror-beta @mirror-gamma review the mirrored result',
    });
    const duplicate = daemon.mirrorTurn({
      harness: 'fake',
      session_ref: 'mirror-group-session',
      native_turn_id: 'mirror-group-turn',
      body: 'duplicate must not route',
    });
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', first.message.id)!;
    expect(first.message.author).toBe(planner.id);
    expect(duplicate).toMatchObject({ deduped: true, message: { id: first.message.id } });
    expect(group.state).toBe('completed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([beta.id, gamma.id]);
    expect(daemon.store.listCollaborationGroups('eng')).toHaveLength(1);
  });

  it('keeps a multi-recipient agent interim post immediate and outside any group', async () => {
    const alpha = spawnAgent('interim-alpha');
    const gamma = spawnAgent('interim-gamma');
    const delta = spawnAgent('interim-delta');
    fake.enqueue(
      { kind: 'complete', final_text: '<ACK_OK>' },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );

    const interim = daemon.postAgentMessage(
      'eng', alpha.id, '@interim-gamma @interim-delta immediate question',
    );
    await daemon.settle();

    expect(daemon.store.getCollaborationGroupByRoot('eng', interim.id)).toBeUndefined();
    expect(daemon.store.listDeliveries('eng', { recipient: gamma.id })).toHaveLength(1);
    expect(daemon.store.listDeliveries('eng', { recipient: delta.id })).toHaveLength(1);
  });
});
// harn:end interim-agent-posts-are-nonfinal-routing
// harn:end eligible-multi-agent-routing-starts-one-group

// harn:assume grouped-deliveries-have-an-isolated-batch-class ref=group-batch-pump-regression
describe('concurrent collaboration group isolation', () => {
  it('serializes one shared member without batching two queued groups together', async () => {
    const alpha = spawnAgent('shared-alpha');
    const beta = spawnAgent('shared-beta');
    const gamma = spawnAgent('shared-gamma');
    daemon.pauseMember('eng', alpha.id);
    fake.enqueue(
      { kind: 'complete', final_text: 'beta group one done' },
      { kind: 'complete', final_text: 'gamma group two done' },
    );

    const first = daemon.postHumanMessage('eng', '@shared-alpha @shared-beta first group');
    const second = daemon.postHumanMessage('eng', '@shared-alpha @shared-gamma second group');
    await daemon.settle();
    expect(daemon.store.getCollaborationGroupByRoot('eng', first.id)?.state).toBe('open');
    expect(daemon.store.getCollaborationGroupByRoot('eng', second.id)?.state).toBe('open');

    fake.enqueue(
      { kind: 'complete', final_text: 'alpha group one done' },
      { kind: 'complete', final_text: 'alpha group two done' },
    );
    daemon.unpauseMember('eng', alpha.id);
    await daemon.settle();

    expect(fake.deliveries.filter((delivery) => delivery.payload.includes('you=@shared-alpha')))
      .toHaveLength(2);
    expect(runMessages().filter((message) => message.author === alpha.id)).toHaveLength(2);
    expect(daemon.store.getCollaborationGroupByRoot('eng', first.id)?.state).toBe('completed');
    expect(daemon.store.getCollaborationGroupByRoot('eng', second.id)?.state).toBe('completed');
  });
});
// harn:end grouped-deliveries-have-an-isolated-batch-class

// harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-reconciliation-regression
describe('collaboration recovery and unavailable participants', () => {
  it('marks a dead before-start participant skipped and lets its peer close the group', async () => {
    const alpha = spawnAgent('dead-alpha');
    const beta = spawnAgent('live-beta');
    daemon.killMember('eng', alpha.id);
    fake.enqueue({ kind: 'complete', final_text: 'beta finished without onward work' });

    const root = daemon.postHumanMessage('eng', '@dead-alpha @live-beta compare availability');
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const participants = daemon.store.listCollaborationParticipants('eng', group.id, 1);
    expect(participants.map((participant) => participant.terminal_status))
      .toEqual(['skipped', 'completed']);
    expect(daemon.store.getDelivery('eng', participants[0]!.delivery_id)?.state).toBe('consumed');
    expect(group.state).toBe('completed');
    expect(participants.map((participant) => participant.member_id)).toEqual([alpha.id, beta.id]);
  });

  it('releases a fully terminal round exactly once after restart', async () => {
    const alpha = spawnAgent('restart-alpha');
    const beta = spawnAgent('restart-beta');
    const gamma = spawnAgent('restart-gamma');
    daemon.pauseMember('eng', alpha.id);
    daemon.pauseMember('eng', beta.id);
    const root = daemon.postHumanMessage('eng', '@restart-alpha @restart-beta recover release');
    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const participants = daemon.store.listCollaborationParticipants('eng', group.id, 1);
    const completedTs = '2026-07-14T13:30:00.000Z';
    for (const [index, participant] of participants.entries()) {
      const body = index === 0 ? '@restart-gamma inspect after restart' : 'beta done';
      const result = daemon.store.postMessage('eng', {
        author: participant.member_id,
        kind: 'run',
        body,
        mentions: index === 0
          ? [{ member_id: gamma.id, start: 0, end: '@restart-gamma'.length }]
          : [],
        run: {
          status: 'completed',
          started_ts: completedTs,
          ended_ts: completedTs,
          tool_calls: 0,
          events_ref: `runs/restart-${String(index)}.jsonl`,
          final_text: body,
        },
      });
      daemon.store.updateDelivery('eng', participant.delivery_id, {
        state: 'consumed', run_msg_id: result.id,
      });
      daemon.store.updateCollaborationParticipant('eng', group.id, 1, participant.member_id, {
        terminal_status: 'completed', result_message_id: result.id, completed_ts: completedTs,
      });
    }

    await daemon.close({ force: true });
    daemon = newDaemon();
    fake.enqueue({ kind: 'complete', final_text: 'gamma recovery done' });
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.listCollaborationRounds('eng', group.id).map((round) => round.state))
      .toEqual(['released', 'closed']);
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)
      .map((participant) => participant.member_id)).toEqual([gamma.id]);
    expect(fake.deliveries.filter((delivery) => delivery.payload.includes('round=2')))
      .toHaveLength(1);
  });

  it('settles an invalid already-delivering group participant truthfully at boot without throwing', async () => {
    const alpha = spawnAgent('boot-group-alpha');
    const worktree = registerQualifiedFixture('boot-group-target', 'boot-group-target');
    const remote = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'boot-group-remote', cwd: testCwd('boot-group-remote'),
    });
    daemon.pauseMember('eng', alpha.id);
    daemon.pauseMember(worktree.conversation_id, remote.id);

    const root = daemon.postHumanMessage(
      'eng',
      '@boot-group-alpha ~boot-group-target:@boot-group-remote group up',
    );
    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const remoteParticipant = daemon.store
      .listCollaborationParticipants('eng', group.id, 1)
      .find((participant) => participant.member_id === remote.id)!;
    const remoteDelivery = daemon.store.getDelivery('eng', remoteParticipant.delivery_id)!;
    // The scoped attempt had already started when its target went stale.
    const run = daemon.store.postMessage('eng', {
      author: remote.id,
      author_target: remoteDelivery.target,
      kind: 'run',
      body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:30:00.000Z',
        tool_calls: 0, events_ref: `runs/${String(root.id)}.jsonl`,
      },
    });
    daemon.store.updateDelivery('eng', remoteDelivery.id, {
      state: 'delivering', run_msg_id: run.id, attempt_count: 1,
    });
    daemon.store.updateMember(worktree.conversation_id, remote.id, { state: 'running' });
    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T00:31:00.000Z');

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const refusals = () =>
      daemon.store.listMessages('eng').filter((message) =>
        message.kind === 'system' && message.body.includes('qualified target refused'));
    expect(daemon.store.getDelivery('eng', remoteDelivery.id)?.state).toBe('consumed');
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(daemon.store.findCollaborationParticipantByDelivery('eng', remoteDelivery.id))
      .toMatchObject({ terminal_status: 'interrupted' });
    expect(refusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);
    // The surviving participant is not terminal, so the barrier holds: no
    // closed round, no next round, no new deliveries.
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('collecting');
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);

    // A repeated restart settles nothing twice and reopens nothing.
    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(refusals()).toHaveLength(1);
    expect(daemon.store.findCollaborationParticipantByDelivery('eng', remoteDelivery.id))
      .toMatchObject({ terminal_status: 'interrupted' });
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('collecting');
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);
  });
});
// harn:end open-collaboration-groups-reconcile-without-resurrection

// harn:assume same-round-terminal-peers-end-live-waits ref=collaboration-wait-release-regression
describe('group wait wake-up', () => {
  it('clears a wait when every named same-round peer is terminal and lets the waiter finish', async () => {
    const alpha = spawnAgent('wait-alpha');
    const beta = spawnAgent('wait-beta');
    fake.enqueue(
      {
        kind: 'complete',
        final_text: 'alpha resumed after peer completion',
        steps: [{ kind: 'wait', reason: 'reply', peers: ['wait-beta'], duration_ms: 300 }],
      },
      { kind: 'complete', final_text: '@wait-alpha beta final is barriered', delay_ms: 20 },
      { kind: 'complete', final_text: 'alpha next round done' },
    );

    const started = Date.now();
    const root = daemon.postHumanMessage('eng', '@wait-alpha @wait-beta coordinate');
    await daemon.settle();

    expect(Date.now() - started).toBeLessThan(250);
    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    expect(group.state).toBe('completed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .find((participant) => participant.member_id === alpha.id)?.terminal_status).toBe('completed');
    expect(daemon.sync('eng', 0).members.find((member) => member.id === alpha.id))
      .not.toHaveProperty('waiting');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 2)
      .map((participant) => participant.member_id)).toEqual([alpha.id]);
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .map((participant) => participant.member_id)).toEqual([alpha.id, beta.id]);
  });

  it('does not auto-clear a grouped wait whose named peer is outside the round', async () => {
    const alpha = spawnAgent('outside-wait-alpha');
    spawnAgent('outside-wait-beta');
    spawnAgent('outside-wait-gamma');
    fake.enqueue(
      {
        kind: 'complete',
        final_text: 'alpha finished after its own timeout',
        steps: [{
          kind: 'wait',
          reason: 'reply',
          peers: ['outside-wait-gamma'],
          duration_ms: 120,
        }],
      },
      { kind: 'complete', final_text: 'beta finished first', delay_ms: 10 },
    );

    const started = Date.now();
    daemon.postHumanMessage(
      'eng',
      '@outside-wait-alpha @outside-wait-beta coordinate without gamma',
    );
    await daemon.settle();

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(daemon.sync('eng', 0).members.find((member) => member.id === alpha.id))
      .not.toHaveProperty('waiting');
  });

  // harn:assume interim-group-replies-end-waits-without-advancing-the-barrier ref=interim-group-reply-regression
  it('consumes an interim peer answer immediately without advancing the collecting round', async () => {
    const alpha = spawnAgent('interim-wait-alpha');
    const beta = spawnAgent('interim-wait-beta');
    fake.enqueue(
      {
        kind: 'complete',
        final_text: 'alpha authoritative final after the interim answer',
        steps: [{
          kind: 'wait',
          reason: 'reply',
          peers: ['interim-wait-beta'],
          duration_ms: 1_000,
        }],
      },
      {
        kind: 'complete',
        final_text: 'beta authoritative final after its interim answer',
        steps: [{
          kind: 'interim_post',
          body: '@interim-wait-alpha immediate in-round answer',
        }],
        delay_ms: 200,
      },
    );

    const root = daemon.postHumanMessage(
      'eng',
      '@interim-wait-alpha @interim-wait-beta coordinate with an immediate answer',
    );
    const interim = await until(() => daemon.store.listMessages('eng', { limit: 100 })
      .find((message) => message.kind === 'chat' && message.body.includes('immediate in-round')));
    await until(() => {
      const alphaRun = runMessages().find((message) => message.author === alpha.id);
      const betaRun = runMessages().find((message) => message.author === beta.id);
      return alphaRun?.run?.status === 'completed' && betaRun?.run?.status === 'running'
        ? true
        : undefined;
    });

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const roundOne = daemon.store.listCollaborationParticipants('eng', group.id, 1);
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('collecting');
    expect(roundOne.find((participant) => participant.member_id === alpha.id)?.terminal_status)
      .toBe('completed');
    expect(roundOne.find((participant) => participant.member_id === beta.id)?.terminal_status)
      .toBeUndefined();
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);
    expect(daemon.memberStatus('eng', alpha.id).member).not.toHaveProperty('waiting');
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })
      .find((delivery) => delivery.message_id === interim.id)?.state).toBe('consumed');

    await daemon.settle();
    expect(daemon.store.getCollaborationGroup('eng', group.id)?.state).toBe('completed');
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('closed');
  });
  // harn:end interim-group-replies-end-waits-without-advancing-the-barrier
});
// harn:end same-round-terminal-peers-end-live-waits

// harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-recovery-regression
describe('answered approval restart recovery', () => {
  it('never resurrects the old read card and permits only a fresh native approval', async () => {
    const alpha = spawnAgent('restart-approval');
    const turn = {
      kind: 'ask' as const,
      card: {
        kind: 'approval' as const,
        prompt: 'Allow Bash?',
        tool: 'Bash',
        options: [{ label: 'Allow once' }, { label: 'Deny' }],
      },
      reply: (answer: unknown) => `approval ${String(answer)}`,
    };
    fake.enqueue(turn);
    daemon.postHumanMessage('eng', '@restart-approval try a command');
    const old = await until(() => daemon.store.listInteractions('eng', 'pending')
      .find((item) => item.member_id === alpha.id));
    fake.failNextResponse('lost approval acknowledgement');
    await expect(daemon.answerInteraction('eng', old.id, 'Allow once')).rejects.toThrow(
      'lost approval acknowledgement',
    );
    const oldDeliveries = daemon.store.listDeliveries('eng')
      .filter((delivery) => delivery.message_id === old.message_id);
    expect(oldDeliveries.every((delivery) => delivery.read_ts !== undefined)).toBe(true);
    expect(oldDeliveries.every(
      (delivery) => delivery.interaction_resolved_ts !== undefined,
    )).toBe(true);

    await daemon.close({ force: true });
    daemon = newDaemon();
    fake.enqueue(turn);
    await daemon.reconcile();
    const fresh = await until(() => daemon.store.listInteractions('eng', 'pending')
      .find((item) => item.member_id === alpha.id));

    expect(daemon.store.getInteraction(old.id)).toMatchObject({ state: 'orphaned' });
    expect(fresh.id).not.toBe(old.id);
    expect(oldDeliveries.map((delivery) => daemon.store.getDelivery('eng', delivery.id)?.read_ts)
      .every((readTs) => readTs !== undefined)).toBe(true);
    expect(oldDeliveries.map(
      (delivery) => daemon.store.getDelivery('eng', delivery.id)?.interaction_resolved_ts,
    ).every((resolvedTs) => resolvedTs !== undefined)).toBe(true);
    expect(daemon.store.listDeliveries('eng')
      .filter((delivery) => delivery.message_id === fresh.message_id)
      .every((delivery) => delivery.read_ts === undefined
        && delivery.interaction_resolved_ts === undefined)).toBe(true);
  });
});
// harn:end approval-answer-is-atomic-and-chatless

describe('agent delivery lifecycle frames (agent-delivery-lifecycle-streams)', () => {
  it('streams queued, delivering, and consumed live for an agent delivery', async () => {
    const agent = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: dir });
    fake.enqueue({ kind: 'complete', final_text: 'done' });
    daemon.postHumanMessage('eng', '@alpha do the thing');
    await daemon.settle();

    const states = frames
      .filter((f) => f.frame.type === 'inbox')
      .map((f) => (f.frame as Extract<ServerFrame, { type: 'inbox' }>).delivery)
      .filter((d) => d.recipient === agent.id)
      .map((d) => d.state);

    expect(states).toContain('queued');
    expect(states).toContain('delivering');
    expect(states.at(-1)).toBe('consumed');
    expect(states.indexOf('queued')).toBeLessThan(states.indexOf('delivering'));
    expect(states.indexOf('delivering')).toBeLessThan(states.lastIndexOf('consumed'));
  });
});

describe('usage limits (agent-usage-limits-reported-not-guessed)', () => {
  it('a run.limits event lands on the member row and streams as a member frame', async () => {
    const agent = daemon.spawnMember('eng', { harness: 'fake', handle: 'limited', cwd: dir });
    fake.enqueue({
      kind: 'complete',
      final_text: 'done',
      items: [{
        type: 'run.limits',
        limits: [
          { window: 'five_hour', status: 'allowed', resets_at: '2026-07-17T12:00:00.000Z' },
          { window: 'weekly', status: 'allowed_warning', used_percent: 91 },
        ],
      }],
    });
    daemon.postHumanMessage('eng', '@limited check in');
    await daemon.settle();

    const persisted = daemon.store.getMember('eng', agent.id);
    expect(persisted?.limits).toEqual([
      { window: 'five_hour', status: 'allowed', resets_at: '2026-07-17T12:00:00.000Z' },
      { window: 'weekly', status: 'allowed_warning', used_percent: 91 },
    ]);

    const framed = [...frames].reverse().find((item) =>
      item.frame.type === 'member' && item.frame.member.id === agent.id && item.frame.member.limits !== undefined);
    expect(framed).toBeDefined();

    // Member status, not run content: the journal carries no run.limits event.
    const run = daemon.store.listRunMessages('eng', { author: agent.id, limit: 1 })[0]!;
    const journal = daemon.readRunBlob('eng', run.id);
    expect(journal.some((e) => e.type === 'run.limits')).toBe(false);
  });

  it('fans account probes out by harness, emits only changes, and ignores failures', async () => {
    const reported: AgentLimit[] = [
      { window: 'five_hour', used_percent: 21, resets_at: '2026-07-17T12:00:00.000Z' },
      { window: 'seven_day', used_percent: 64 },
    ];
    let failing = false;
    const probeLimits = vi.fn(async () => {
      if (failing) throw new Error('provider unavailable');
      return reported;
    });
    const adapter: HarnessAdapter = Object.assign(new FakeAdapter('claude-code'), { probeLimits });
    const backgroundErrors: Error[] = [];
    const probeDaemon = new Daemon({
      dbPath: join(dir, 'limits-probe.sqlite'),
      blobRoot: join(dir, 'limits-probe-blobs'),
      adapters: [adapter, new FakeAdapter('codex')],
      discoverModels: false,
      limitsProbeMs: 20,
      onBackgroundError: (error) => backgroundErrors.push(error),
      homeDir: dir,
    });

    try {
      probeDaemon.createRoom({
        id: 'probe-a', name: 'Probe A', owner: { handle: 'owner-a', display_name: 'Owner A' },
      });
      probeDaemon.createRoom({
        id: 'probe-b', name: 'Probe B', owner: { handle: 'owner-b', display_name: 'Owner B' },
      });
      const first = probeDaemon.spawnMember('probe-a', {
        harness: 'claude-code', handle: 'probe-first', cwd: testCwd('probe-first'),
      });
      const second = probeDaemon.spawnMember('probe-b', {
        harness: 'claude-code', handle: 'probe-second', cwd: testCwd('probe-second'),
      });
      const otherHarness = probeDaemon.spawnMember('probe-a', {
        harness: 'codex', handle: 'probe-codex', cwd: testCwd('probe-codex'),
      });
      const removed = probeDaemon.spawnMember('probe-a', {
        harness: 'claude-code', handle: 'probe-removed', cwd: testCwd('probe-removed'),
      });
      probeDaemon.store.updateMember('probe-a', removed.id, { removed_ts: new Date().toISOString() });

      const probeFrames: { room: string; frame: ServerFrame }[] = [];
      probeDaemon.onFrame((room, frame) => probeFrames.push({ room, frame }));
      await until(() =>
        probeDaemon.store.getMember('probe-a', first.id)?.limits !== undefined
        && probeDaemon.store.getMember('probe-b', second.id)?.limits !== undefined
          ? true
          : undefined);

      expect(probeDaemon.store.getMember('probe-a', first.id)?.limits).toEqual(reported);
      expect(probeDaemon.store.getMember('probe-b', second.id)?.limits).toEqual(reported);
      expect(probeDaemon.store.getMember('probe-a', otherHarness.id)?.limits).toBeUndefined();
      expect(probeDaemon.store.getMember('probe-a', removed.id)?.limits).toBeUndefined();
      const limitFrames = () => probeFrames.filter((item) =>
        item.frame.type === 'member' && item.frame.member.limits !== undefined);
      expect(limitFrames().map((item) => item.frame.type === 'member' && item.frame.member.id).sort())
        .toEqual([first.id, second.id].sort());

      const unchangedFrameCount = limitFrames().length;
      const callsBeforeUnchanged = probeLimits.mock.calls.length;
      await until(() => probeLimits.mock.calls.length > callsBeforeUnchanged ? true : undefined);
      expect(limitFrames()).toHaveLength(unchangedFrameCount);

      failing = true;
      const callsBeforeFailure = probeLimits.mock.calls.length;
      await until(() => probeLimits.mock.calls.length > callsBeforeFailure ? true : undefined);
      expect(limitFrames()).toHaveLength(unchangedFrameCount);
      expect(probeDaemon.store.getMember('probe-a', first.id)?.limits).toEqual(reported);
      expect(backgroundErrors).toEqual([]);
    } finally {
      await probeDaemon.close();
    }
  });
});

// harn:assume account-usage-limits-are-probed-periodically-and-honestly-refreshable ref=usage-probe-regression
describe('account usage probing (account-usage-limits-are-probed-periodically-and-honestly-refreshable)', () => {
  const reported: AgentLimit[] = [{ window: 'five_hour', used_percent: 21 }];

  function buildProbeDaemon(
    probeImpl: () => Promise<AgentLimit[] | undefined>,
    opts: Record<string, unknown>,
    tag: string,
  ) {
    const probeLimits = vi.fn(probeImpl);
    const adapter: HarnessAdapter = Object.assign(new FakeAdapter('claude-code'), { probeLimits });
    const probeDaemon = new Daemon({
      dbPath: join(dir, `${tag}.sqlite`),
      blobRoot: join(dir, `${tag}-blobs`),
      adapters: [adapter, new FakeAdapter('codex')],
      discoverModels: false,
      homeDir: dir,
      ...opts,
    });
    return { probeDaemon, probeLimits };
  }

  it('probes immediately on boot for members already present, before any interval tick', async () => {
    // Seed a persisted member, then reconstruct with a long interval: the only
    // way probeLimits can be called in the window is the immediate boot probe.
    const seed = buildProbeDaemon(async () => reported, { limitsProbeMs: 25 }, 'usage-boot');
    let memberId: string;
    try {
      seed.probeDaemon.createRoom({ id: 'usage', name: 'Usage', owner: { handle: 'owner', display_name: 'Owner' } });
      memberId = seed.probeDaemon.spawnMember('usage', { harness: 'claude-code', handle: 'agent', cwd: testCwd('usage-boot') }).id;
      await until(() => seed.probeDaemon.store.getMember('usage', memberId)?.limits !== undefined ? true : undefined);
    } finally {
      await seed.probeDaemon.close();
    }

    const boot = buildProbeDaemon(async () => reported, { limitsProbeMs: 5 * 60_000 }, 'usage-boot');
    try {
      await until(() => boot.probeDaemon.store.getMember('usage', memberId)?.limits !== undefined ? true : undefined);
      expect(boot.probeLimits).toHaveBeenCalledTimes(1); // boot only — the 5-minute interval has not ticked
    } finally {
      await boot.probeDaemon.close();
    }
  });

  it('re-probes on the default five-minute cadence', async () => {
    // Pre-seed a member so the boot probe has a target, then drive the interval
    // with a fake clock to prove the default cadence is five minutes.
    const seed = buildProbeDaemon(async () => reported, { limitsProbeMs: 25 }, 'usage-cadence');
    try {
      seed.probeDaemon.createRoom({ id: 'usage', name: 'Usage', owner: { handle: 'owner', display_name: 'Owner' } });
      seed.probeDaemon.spawnMember('usage', { harness: 'claude-code', handle: 'agent', cwd: testCwd('usage-cadence') });
      await until(() => seed.probeLimits.mock.calls.length >= 1 ? true : undefined);
    } finally {
      await seed.probeDaemon.close();
    }

    vi.useFakeTimers();
    try {
      // No limitsProbeMs → the production default (5 minutes).
      const cadence = buildProbeDaemon(async () => reported, {}, 'usage-cadence');
      try {
        await vi.advanceTimersByTimeAsync(0); // flush the async boot probe
        expect(cadence.probeLimits).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5 * 60_000); // one cadence tick
        expect(cadence.probeLimits).toHaveBeenCalledTimes(2);
      } finally {
        await cadence.probeDaemon.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces overlapping automatic and manual probes behind an in-flight one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { probeDaemon, probeLimits } = buildProbeDaemon(
      async () => { calls += 1; await gate; return reported; },
      { limitsProbeMs: 10, manualUsageRefreshCooldownMs: 5 }, // short cooldown so we hit the coalesce path
      'usage-coalesce',
    );
    try {
      probeDaemon.createRoom({ id: 'usage', name: 'Usage', owner: { handle: 'owner', display_name: 'Owner' } });
      probeDaemon.spawnMember('usage', { harness: 'claude-code', handle: 'agent', cwd: testCwd('usage-coalesce') });
      await until(() => calls >= 1 ? true : undefined); // one probe is in flight, awaiting the gate
      await new Promise((resolve) => setTimeout(resolve, 20)); // past the 5ms cooldown
      // A manual refresh past the cooldown but with a probe already running reports
      // coalesced, and several 10ms interval ticks also coalesce behind it.
      expect(await probeDaemon.refreshUsageLimits()).toEqual({ outcome: 'coalesced' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toBe(1);
    } finally {
      release();
      await probeDaemon.close();
    }
    expect(probeLimits.mock.calls.length).toBe(1);
  });

  it('throttles manual refreshes with a cooldown and preserves last-good on failure', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const { probeDaemon, probeLimits } = buildProbeDaemon(
      async () => { if (mode === 'fail') throw new Error('provider down'); return reported; },
      { limitsProbeMs: 5 * 60_000, manualUsageRefreshCooldownMs: 80 },
      'usage-cooldown',
    );
    try {
      probeDaemon.createRoom({ id: 'usage', name: 'Usage', owner: { handle: 'owner', display_name: 'Owner' } });
      const memberId = probeDaemon.spawnMember('usage', { harness: 'claude-code', handle: 'agent', cwd: testCwd('usage-cooldown') }).id;
      // The boot probe (no members yet) already stamped the cooldown; let it lapse
      // so the first real manual refresh runs.
      await new Promise((resolve) => setTimeout(resolve, 120));
      // First manual refresh probes successfully and lands the limits.
      expect(await probeDaemon.refreshUsageLimits()).toEqual({ outcome: 'refreshed' });
      await until(() => probeDaemon.store.getMember('usage', memberId)?.limits !== undefined ? true : undefined);
      const afterFirst = probeLimits.mock.calls.length;
      // A second click within the cooldown reports cooldown and does not probe.
      expect(await probeDaemon.refreshUsageLimits()).toEqual({ outcome: 'cooldown' });
      expect(probeLimits.mock.calls.length).toBe(afterFirst);
      // After the cooldown, a failing provider is reported honestly while the
      // last-good gauge is preserved.
      await new Promise((resolve) => setTimeout(resolve, 120));
      mode = 'fail';
      expect(await probeDaemon.refreshUsageLimits()).toEqual({ outcome: 'failed' });
      expect(probeLimits.mock.calls.length).toBe(afterFirst + 1);
      expect(probeDaemon.store.getMember('usage', memberId)?.limits).toEqual(reported);
    } finally {
      await probeDaemon.close();
    }
  });
});
// harn:end account-usage-limits-are-probed-periodically-and-honestly-refreshable

// harn:assume run-events-merge-by-journal-index ref=daemon-journal-index-stamp
describe('run_event journal indices (run-events-merge-by-journal-index)', () => {
  it('stamps consecutive indices matching the journal across a scripted turn', async () => {
    daemon.spawnMember('eng', { harness: 'fake', handle: 'indexer', cwd: dir });
    fake.enqueue({
      kind: 'complete',
      final_text: 'done',
      items: [
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'one' } },
        {
          type: 'run.item',
          item_type: 'tool_call',
          payload: { call_id: 'c1', tool: 'Bash', title: 'ls', input: {} },
        },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'c1', status: 'ok' } },
      ],
    });
    daemon.postHumanMessage('eng', '@indexer count things');
    await daemon.settle();

    const runFrames = frames
      .filter((f) => f.frame.type === 'run_event')
      .map((f) => f.frame as Extract<ServerFrame, { type: 'run_event' }>);
    expect(runFrames.length).toBeGreaterThanOrEqual(4); // run.started + 3 items
    const indices = runFrames.map((frame) => frame.index);
    expect(indices.every((value) => typeof value === 'number')).toBe(true);
    // Consecutive and aligned with the journal: frame N points at journal[N].
    const run = daemon.store.listRunMessages('eng', { limit: 1 })[0]!;
    const journal = daemon.readRunBlob('eng', run.id);
    const withoutTs = (event: unknown): unknown => {
      const { ts: _ts, ...rest } = event as Record<string, unknown>;
      return rest;
    };
    for (const frame of runFrames) {
      // The journal copy may carry the daemon's ts stamp; position must match.
      expect(withoutTs(journal[frame.index!])).toEqual(withoutTs(frame.event));
    }
  });

  // harn:assume compaction-timeline-items-are-durable-run-evidence ref=compaction-journal-regression
  it('journals and index-streams compaction while keeping its usage baseline transient', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'compactor', cwd: testCwd('compactor'),
    });
    const baseline = {
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 18_700,
    } as const;
    fake.enqueue({
      kind: 'complete',
      final_text: 'continued after compaction',
      items: [
        { type: 'timeline', item: { type: 'compaction', status: 'loading' } },
        {
          type: 'timeline',
          item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 149_900 },
        },
        { type: 'usage_updated', usage: baseline },
      ],
    });

    daemon.postHumanMessage('eng', '@compactor compact this context');
    await daemon.settle();

    const run = daemon.store.listRunMessages('eng', { author: agent.id, limit: 1 })[0]!;
    const journal = daemon.readRunBlob('eng', run.id);
    const timelineFrames = frames.flatMap(({ frame }) =>
      frame.type === 'run_event' && frame.message_id === run.id && frame.event.type === 'timeline'
        ? [frame]
        : []);
    expect(timelineFrames.map((frame) => frame.event)).toEqual([
      {
        type: 'timeline',
        output_message_id: run.id,
        item: { type: 'compaction', status: 'loading' },
      },
      {
        type: 'timeline',
        output_message_id: run.id,
        item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 149_900 },
      },
    ]);
    for (const frame of timelineFrames) expect(journal[frame.index!]).toEqual(frame.event);
    expect(journal.some((event) => event.type === 'usage_updated')).toBe(false);
    expect(daemon.sync('eng', 0).members.find((member) => member.id === agent.id)?.lastUsage)
      .toEqual(baseline);
  });
  // harn:end compaction-timeline-items-are-durable-run-evidence
});
// harn:end run-events-merge-by-journal-index

// harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-daemon-regression
describe('transient lastUsage telemetry', () => {
  const liveUsage = {
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 120_000,
  } as const;
  const completedUsage = {
    inputTokens: 40,
    cachedInputTokens: 30,
    outputTokens: 5,
    totalCostUsd: 0.02,
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 125_000,
  } as const;

  it('broadcasts live and completed usage while persisting neither member cache nor live event', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'usage-agent', cwd: testCwd('usage-agent'),
    });
    fake.enqueue({
      kind: 'complete',
      final_text: 'done',
      items: [{ type: 'usage_updated', usage: liveUsage }],
      agent_usage: completedUsage,
    });

    daemon.postHumanMessage('eng', '@usage-agent report usage');
    await daemon.settle();

    const broadcasts = frames.flatMap((item) =>
      item.frame.type === 'member' && item.frame.member.id === agent.id &&
      item.frame.member.lastUsage !== undefined
        ? [item.frame.member.lastUsage]
        : []);
    expect(broadcasts).toContainEqual(liveUsage);
    expect(broadcasts).toContainEqual(completedUsage);
    expect(daemon.sync('eng', 0).members.find((member) => member.id === agent.id)?.lastUsage)
      .toEqual(completedUsage);
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === agent.id)?.member.lastUsage)
      .toEqual(completedUsage);
    expect(daemon.store.getMember('eng', agent.id)).not.toHaveProperty('lastUsage');

    const run = daemon.store.listRunMessages('eng', { author: agent.id, limit: 1 })[0]!;
    const journal = daemon.readRunBlob('eng', run.id);
    expect(journal.some((event) => event.type === 'usage_updated')).toBe(false);
    expect(journal.find((event) => event.type === 'run.completed')).toMatchObject({
      agent_usage: completedUsage,
    });
  });

  it('starts absent after restart and repopulates safely on the next reporting turn', async () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'restart-usage', cwd: testCwd('restart-usage'),
    });
    fake.enqueue({ kind: 'complete', final_text: 'first', agent_usage: completedUsage });
    daemon.postHumanMessage('eng', '@restart-usage first turn');
    await daemon.settle();
    expect(daemon.sync('eng', 0).members.find((member) => member.id === agent.id)?.lastUsage)
      .toEqual(completedUsage);

    await daemon.close();
    frames = [];
    daemon = newDaemon();

    const afterRestart = daemon.sync('eng', 0).members.find((member) => member.id === agent.id);
    expect(afterRestart).toBeDefined();
    expect(afterRestart).not.toHaveProperty('lastUsage');
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === agent.id)?.member)
      .not.toHaveProperty('lastUsage');

    const nextUsage = {
      inputTokens: 12,
      outputTokens: 2,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 30_000,
    } as const;
    fake.enqueue({ kind: 'complete', final_text: 'second', agent_usage: nextUsage });
    daemon.postHumanMessage('eng', '@restart-usage second turn');
    await daemon.settle();

    expect(daemon.sync('eng', 0).members.find((member) => member.id === agent.id)?.lastUsage)
      .toEqual(nextUsage);
  });
});
// harn:end last-agent-usage-is-transient-and-seeded

describe('persisted context window (current-context-window-truth-outlives-restarts)', () => {
  it('round-trips the member context_window column and migrates a pre-column db', () => {
    const dbPath = join(dir, 'ctx-window.sqlite');
    let store = new Store(dbPath);
    const { owner } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    expect(store.getMemberContextWindow('eng', owner.id)).toBeUndefined();
    store.setMemberContextWindow('eng', owner.id, 1_000_000);
    expect(store.getMemberContextWindow('eng', owner.id)).toBe(1_000_000);
    store.close();

    // Simulate a database written before the context_window column existed.
    const legacy = new Database(dbPath);
    legacy.exec('ALTER TABLE members DROP COLUMN context_window');
    legacy.close();

    store = new Store(dbPath); // reopening runs the idempotent migration
    expect(store.getMemberContextWindow('eng', owner.id)).toBeUndefined();
    store.setMemberContextWindow('eng', owner.id, 258_400);
    expect(store.getMemberContextWindow('eng', owner.id)).toBe(258_400);
    store.close();
  });

  it('persists an engine-reported window once and only rewrites on change', async () => {
    const agent = spawnAgent('gauge');
    const writes = vi.spyOn(daemon.store, 'setMemberContextWindow');
    const usage = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 90_000 };
    fake.enqueue({
      kind: 'complete', final_text: 'one',
      items: [{ type: 'usage_updated', usage }], agent_usage: usage,
    });
    daemon.postHumanMessage('eng', '@gauge first');
    await daemon.settle();
    fake.enqueue({
      kind: 'complete', final_text: 'two',
      items: [{ type: 'usage_updated', usage }], agent_usage: usage,
    });
    daemon.postHumanMessage('eng', '@gauge second');
    await daemon.settle();

    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBe(1_000_000);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('a restarted daemon seeds the estimate with the persisted window over the peek guess', async () => {
    const agent = spawnAgent('gauge');
    fake.enqueue({
      kind: 'complete', final_text: 'establish',
      agent_usage: { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 80_000 },
    });
    daemon.postHumanMessage('eng', '@gauge go');
    await daemon.settle();

    await daemon.close();
    daemon = newDaemon();
    fake.peekUsage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 12_000, estimated: true };
    await daemon.reconcile();
    await daemon.settle();

    const detail = daemon.memberDetails('eng').find((d) => d.member.id === agent.id)!;
    expect(detail.member.lastUsage).toEqual({
      contextWindowMaxTokens: 1_000_000, // persisted engine truth beats the artifact-scan guess
      contextWindowUsedTokens: 12_000,
      estimated: true,
    });
  });

  it('a member with no persisted window keeps the peek estimate untouched', async () => {
    const agent = spawnAgent('fresh');
    fake.enqueue({ kind: 'complete', final_text: 'no usage reported' });
    daemon.postHumanMessage('eng', '@fresh go');
    await daemon.settle();

    fake.peekUsage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 5_000, estimated: true };
    await daemon.reconcile();
    await daemon.settle();

    const detail = daemon.memberDetails('eng').find((d) => d.member.id === agent.id)!;
    expect(detail.member.lastUsage).toEqual({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 5_000,
      estimated: true,
    });
  });
});

describe('message pinning (pins-are-durable-role-gated-markers)', () => {
  const postChat = (author: string, body = 'decision worth keeping') =>
    daemon.store.postMessage('eng', { author, kind: 'chat', body });

  it('owner pins then unpins, each flip emitting one message frame', () => {
    const owner = daemon.ownerOf('eng');
    const msg = postChat(owner.id);
    frames = [];

    const pinned = daemon.pinMessage('eng', msg.id, true, owner.id);
    expect(pinned.pinned).toBe(true);
    expect(daemon.store.getMessage('eng', msg.id)?.pinned).toBe(true);

    const unpinned = daemon.pinMessage('eng', msg.id, false, owner.id);
    expect(unpinned.pinned).toBeUndefined();
    expect(daemon.store.getMessage('eng', msg.id)?.pinned).toBeUndefined();

    const pinFrames = frames.filter(({ frame }) =>
      frame.type === 'message' && frame.message.id === msg.id);
    expect(pinFrames).toHaveLength(2);
    expect(pinFrames[0]!.frame.type === 'message' && pinFrames[0]!.frame.message.pinned).toBe(true);
  });

  it('an admin may pin; members, observers, and agents are refused', () => {
    const owner = daemon.ownerOf('eng');
    const admin = daemon.store.addMember('eng', {
      kind: 'human', handle: 'boss', display_name: 'Boss', role: 'admin',
    });
    const member = daemon.store.addMember('eng', {
      kind: 'human', handle: 'mate', display_name: 'Mate', role: 'member',
    });
    const observer = daemon.store.addMember('eng', {
      kind: 'human', handle: 'watcher', display_name: 'Watcher', role: 'observer',
    });
    const agent = spawnAgent('alpha');
    const msg = postChat(owner.id);

    expect(daemon.pinMessage('eng', msg.id, true, admin.id).pinned).toBe(true);
    expect(() => daemon.pinMessage('eng', msg.id, true, member.id)).toThrow('only owners and admins');
    expect(() => daemon.pinMessage('eng', msg.id, true, observer.id)).toThrow('only owners and admins');
    expect(() => daemon.pinMessage('eng', msg.id, false, agent.id)).toThrow('only owners and admins');
  });

  it('re-pinning to the same value changes nothing and emits nothing', () => {
    const owner = daemon.ownerOf('eng');
    const msg = postChat(owner.id);
    daemon.pinMessage('eng', msg.id, true, owner.id);
    const seqAfterFirst = daemon.store.getMessage('eng', msg.id)!.seq;
    frames = [];

    const again = daemon.pinMessage('eng', msg.id, true, owner.id);
    expect(again.pinned).toBe(true);
    expect(daemon.store.getMessage('eng', msg.id)!.seq).toBe(seqAfterFirst); // no new change-log seq
    expect(frames.filter(({ frame }) => frame.type === 'message')).toHaveLength(0);
  });

  it('re-adds the pinned column on a pre-column database and round-trips the flag', () => {
    const dbPath = join(dir, 'pin-migration.sqlite');
    let store = new Store(dbPath);
    const { owner } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const msg = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'keep me' });
    store.close();

    // Simulate a database written before the pinned column existed.
    const legacy = new Database(dbPath);
    legacy.exec('ALTER TABLE messages DROP COLUMN pinned');
    legacy.close();

    store = new Store(dbPath); // reopening runs the idempotent migration
    expect(store.getMessage('eng', msg.id)?.pinned).toBeUndefined();
    expect(store.setMessagePinned('eng', msg.id, true).pinned).toBe(true);
    expect(store.getMessage('eng', msg.id)?.pinned).toBe(true);
    store.close();
  });

  it('lists pinned messages in id order, excluding never-pinned and deleted rows', () => {
    const dbPath = join(dir, 'pinned-list.sqlite');
    const store = new Store(dbPath);
    const { owner } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const post = (body: string) => store.postMessage('eng', { author: owner.id, kind: 'chat', body });
    const a = post('a'); post('b'); const c = post('c'); const d = post('d');
    store.setMessagePinned('eng', d.id, true); // pinned first, but a later id
    store.setMessagePinned('eng', a.id, true);
    store.setMessagePinned('eng', c.id, true);
    store.deleteMessage('eng', c.id); // deletion clears c's pin

    // a and d only, id-ascending; b never pinned, c's pin cleared by deletion.
    expect(store.listPinnedMessages('eng').map((m) => m.id)).toEqual([a.id, d.id]);
    store.close();
  });

  it('refuses to pin a deleted message and leaves its state unchanged', () => {
    const owner = daemon.ownerOf('eng');
    const msg = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'purge then pin' });
    daemon.deleteMessage('eng', msg.id, owner.id);

    expect(() => daemon.pinMessage('eng', msg.id, true, owner.id)).toThrow('cannot pin a deleted message');
    expect(daemon.store.getMessage('eng', msg.id)!.pinned).toBeUndefined();
    expect(daemon.store.getMessage('eng', msg.id)!.deleted).toBe(true);
  });
});

describe('message deletion (deleted-messages-are-purged-tombstones)', () => {
  const postChat = (author: string, body = 'a mistaken message') =>
    daemon.store.postMessage('eng', { author, kind: 'chat', body });

  it('owner purges a chat message to a tombstone, emitting one frame', () => {
    const owner = daemon.ownerOf('eng');
    const msg = postChat(owner.id, 'delete me');
    frames = [];

    const tombstone = daemon.deleteMessage('eng', msg.id, owner.id);
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.body).toBe('');
    // id, author, kind, and timestamp survive so ordering/attribution hold.
    expect(tombstone.id).toBe(msg.id);
    expect(tombstone.author).toBe(owner.id);
    expect(tombstone.ts).toBe(msg.ts);

    const stored = daemon.store.getMessage('eng', msg.id)!;
    expect(stored.body).toBe('');
    expect(stored.mentions).toEqual([]);
    expect(stored.deleted).toBe(true);

    const deleteFrames = frames.filter(({ frame }) =>
      frame.type === 'message' && frame.message.id === msg.id);
    expect(deleteFrames).toHaveLength(1);
  });

  it('an admin may delete; members, observers, and agents are refused', () => {
    const owner = daemon.ownerOf('eng');
    const admin = daemon.store.addMember('eng', {
      kind: 'human', handle: 'boss', display_name: 'Boss', role: 'admin',
    });
    const member = daemon.store.addMember('eng', {
      kind: 'human', handle: 'mate', display_name: 'Mate', role: 'member',
    });
    const observer = daemon.store.addMember('eng', {
      kind: 'human', handle: 'watcher', display_name: 'Watcher', role: 'observer',
    });
    const agent = spawnAgent('alpha');

    expect(daemon.deleteMessage('eng', postChat(owner.id).id, admin.id).deleted).toBe(true);
    expect(() => daemon.deleteMessage('eng', postChat(owner.id).id, member.id)).toThrow('only owners and admins');
    expect(() => daemon.deleteMessage('eng', postChat(owner.id).id, observer.id)).toThrow('only owners and admins');
    expect(() => daemon.deleteMessage('eng', postChat(owner.id).id, agent.id)).toThrow('only owners and admins');
  });

  it('refuses run and system messages — only chat qualifies', () => {
    const owner = daemon.ownerOf('eng');
    const agent = spawnAgent('runner');
    const runMsg = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'ran a tool',
      run: { status: 'completed', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/x.jsonl' },
    });
    expect(() => daemon.deleteMessage('eng', runMsg.id, owner.id)).toThrow('only chat messages');
    const sysMsg = daemon.store.postMessage('eng', { author: owner.id, kind: 'system', body: 'system note' });
    expect(() => daemon.deleteMessage('eng', sysMsg.id, owner.id)).toThrow('only chat messages');
  });

  it('re-deleting is a silent no-op', () => {
    const owner = daemon.ownerOf('eng');
    const msg = postChat(owner.id);
    daemon.deleteMessage('eng', msg.id, owner.id);
    const seqAfterFirst = daemon.store.getMessage('eng', msg.id)!.seq;
    frames = [];

    const again = daemon.deleteMessage('eng', msg.id, owner.id);
    expect(again.deleted).toBe(true);
    expect(daemon.store.getMessage('eng', msg.id)!.seq).toBe(seqAfterFirst);
    expect(frames.filter(({ frame }) => frame.type === 'message')).toHaveLength(0);
  });

  it('clears a pin and cancels still-pending deliveries, leaving consumed ones', () => {
    const owner = daemon.ownerOf('eng');
    const agent = spawnAgent('beta');
    const msg = postChat(owner.id, 'pinned, queued, then deleted');
    daemon.pinMessage('eng', msg.id, true, owner.id);
    const queued = daemon.store.createDelivery('eng', { message_id: msg.id, recipient: agent.id, state: 'queued' });
    const consumed = daemon.store.createDelivery('eng', { message_id: msg.id, recipient: agent.id, state: 'consumed' });

    daemon.deleteMessage('eng', msg.id, owner.id);

    expect(daemon.store.getMessage('eng', msg.id)!.pinned).toBeUndefined(); // a tombstone cannot stay pinned
    expect(daemon.store.getDelivery('eng', queued.id)!.state).toBe('consumed'); // cancelled — never delivers
    expect(daemon.store.getDelivery('eng', consumed.id)!.state).toBe('consumed'); // untouched history
  });

  it('re-adds the deleted column on a pre-column database and purges in place', () => {
    const dbPath = join(dir, 'delete-migration.sqlite');
    let store = new Store(dbPath);
    const { owner } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const msg = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'keep then purge' });
    store.close();

    const legacy = new Database(dbPath);
    legacy.exec('ALTER TABLE messages DROP COLUMN deleted');
    legacy.close();

    store = new Store(dbPath);
    expect(store.getMessage('eng', msg.id)?.deleted).toBeUndefined();
    const tomb = store.deleteMessage('eng', msg.id);
    expect(tomb.deleted).toBe(true);
    expect(tomb.body).toBe('');
    expect(store.getMessage('eng', msg.id)?.deleted).toBe(true);
    store.close();
  });
});

describe('run retry (retried-runs-are-fresh-deliveries)', () => {
  const failedRunFor = async (agentId: string): Promise<Message> => {
    fake.enqueue({ kind: 'complete', status: 'failed', final_text: 'boom' });
    daemon.postHumanMessage('eng', '@alpha do the thing');
    await daemon.settle();
    return runMessages().find((m) => m.author === agentId && m.run?.status === 'failed')!;
  };

  it('admin retries a failed run: bound delivery re-queues into a fresh run, the failed run untouched', async () => {
    const alpha = spawnAgent('alpha');
    const failed = await failedRunFor(alpha.id);
    expect(daemon.store.getMember('eng', alpha.id)?.state).toBe('dead'); // failure killed it

    fake.enqueue({ kind: 'complete', final_text: 'done this time' });
    daemon.retryRun('eng', failed.id, daemon.ownerOf('eng').id);
    await daemon.settle();

    const runs = runMessages().filter((m) => m.author === alpha.id);
    expect(runs).toHaveLength(2); // the failed one plus a fresh one
    const fresh = runs.find((m) => m.id !== failed.id)!;
    expect(fresh.run?.status).toBe('completed');
    expect(daemon.store.getMessage('eng', failed.id)?.run?.status).toBe('failed'); // evidence stands
    expect(daemon.store.getMember('eng', alpha.id)?.state).toBe('idle'); // revived, ran, settled
  });

  it('retries an interrupted run without needing a revive', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'die-silently' }); // EOF with no completion → interrupted
    daemon.postHumanMessage('eng', '@alpha do the thing');
    await daemon.settle();
    const interrupted = runMessages().find((m) => m.author === alpha.id && m.run?.status === 'interrupted')!;
    expect(interrupted).toBeDefined();

    fake.enqueue({ kind: 'complete', final_text: 'recovered' });
    daemon.retryRun('eng', interrupted.id, daemon.ownerOf('eng').id);
    await daemon.settle();

    expect(runMessages().filter((m) => m.author === alpha.id && m.run?.status === 'completed')).toHaveLength(1);
  });

  it('members, observers, and agents are refused', async () => {
    const alpha = spawnAgent('alpha');
    const failed = await failedRunFor(alpha.id);
    const member = daemon.store.addMember('eng', { kind: 'human', handle: 'mate', display_name: 'Mate', role: 'member' });
    const observer = daemon.store.addMember('eng', { kind: 'human', handle: 'watcher', display_name: 'Watcher', role: 'observer' });
    expect(() => daemon.retryRun('eng', failed.id, member.id)).toThrow('only owners and admins');
    expect(() => daemon.retryRun('eng', failed.id, observer.id)).toThrow('only owners and admins');
    expect(() => daemon.retryRun('eng', failed.id, alpha.id)).toThrow('only owners and admins');
  });

  it('refuses completed runs and non-run messages', () => {
    const owner = daemon.ownerOf('eng');
    const chat = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'not a run' });
    expect(() => daemon.retryRun('eng', chat.id, owner.id)).toThrow('only run messages');
    const completed = daemon.store.postMessage('eng', {
      author: owner.id, kind: 'run', body: 'ok',
      run: { status: 'completed', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/c.jsonl' },
    });
    expect(() => daemon.retryRun('eng', completed.id, owner.id)).toThrow('only failed or interrupted');
  });

  it('skips deliveries whose trigger was deleted and refuses when none survive', async () => {
    const alpha = spawnAgent('alpha');
    const failed = await failedRunFor(alpha.id);
    const owner = daemon.ownerOf('eng');
    // Delete the triggering message; its snapshot must not resurrect on retry.
    const trigger = daemon.store.listDeliveries('eng').find((d) => d.run_msg_id === failed.id)!;
    daemon.deleteMessage('eng', trigger.message_id, owner.id);

    expect(() => daemon.retryRun('eng', failed.id, owner.id)).toThrow('nothing to retry');
  });
});

describe('run item timestamps (prose-blocks-carry-first-delta-timestamps)', () => {
  it('journals every run item with a ts — text and reasoning, not only tools', async () => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'complete',
      final_text: 'done',
      items: [
        { type: 'run.item', item_type: 'reasoning_summary', payload: { text: 'thinking it through' } },
        { type: 'run.item', item_type: 'text_delta', payload: { text: 'starting now' } },
        { type: 'run.item', item_type: 'tool_call', payload: { call_id: 't1', tool: 'Bash', title: 'ls', input: {} } },
        { type: 'run.item', item_type: 'tool_result', payload: { call_id: 't1', status: 'ok', output_text: 'ok' } },
      ],
    });
    daemon.postHumanMessage('eng', '@alpha go');
    await daemon.settle();

    const run = runMessages().find((m) => m.author === alpha.id)!;
    const items = daemon.blobs.read('eng', run.run!.events_ref).filter((event) => event.type === 'run.item');
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const event of items) expect(event).toHaveProperty('ts'); // every item, not only tools
    expect(items.find((event) => event.item_type === 'text_delta')).toHaveProperty('ts');
    expect(items.find((event) => event.item_type === 'reasoning_summary')).toHaveProperty('ts');
  });
});

describe('git working state (diff explorer)', () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (repo: string, args: string[]): void => {
    execFileSync('git', args, { cwd: repo, env: gitEnv });
  };
  const initRepo = (name = 'repo'): string => {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'gone.txt'), 'delete me\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'initial']);
    return repo;
  };

  it('reports modified, untracked, and deleted files with statuses and counts', async () => {
    const repo = initRepo();
    daemon.configureRoom('eng', { cwd: repo });
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\nfour\n'); // +1 line
    writeFileSync(join(repo, 'new.txt'), 'brand new\nlines\n'); // untracked, +2
    rmSync(join(repo, 'gone.txt')); // deleted from the working tree

    const state = await daemon.gitWorkingState('eng');
    expect(state.clean).toBe(false);
    expect(state.selected).toBe(resolve(repo));
    const byPath = new Map(state.files.map((file) => [file.path, file]));

    expect(byPath.get('keep.txt')?.status).toBe('modified');
    expect(byPath.get('keep.txt')?.additions).toBe(1);
    expect(byPath.get('keep.txt')?.diff).toContain('four');
    expect(byPath.get('new.txt')?.status).toBe('untracked');
    expect(byPath.get('new.txt')?.additions).toBe(2);
    expect(byPath.get('gone.txt')?.status).toBe('deleted');
    expect(byPath.get('gone.txt')?.deletions).toBeGreaterThanOrEqual(1);
  });

  it('returns a clean, empty state for a repo with no working changes', async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    const state = await daemon.gitWorkingState('eng');
    expect(state.repository).toBe(true);
    expect(state.clean).toBe(true);
    expect(state.files).toEqual([]);
  });

  it('reports a known non-git directory honestly without mutating it', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    daemon.configureRoom('eng', { cwd: plain });
    const state = await daemon.gitWorkingState('eng');
    // Honest repository truth: the entry must be able to hide itself, and the
    // read-only inspection must never turn the directory INTO a repository.
    expect(state.repository).toBe(false);
    expect(state.clean).toBe(true);
    expect(state.files).toEqual([]);
    expect(existsSync(join(plain, '.git'))).toBe(false);
  });

  it('offers the distinct cwds of the room\'s agent members', async () => {
    const repo = initRepo();
    daemon.spawnMember('eng', { harness: 'fake', handle: 'coder', cwd: repo });
    const state = await daemon.gitWorkingState('eng');
    expect(state.cwds).toContain(resolve(repo));
    expect(state.selected).toBe(resolve(repo));
  });

  it("refuses a cwd outside the room's known set", async () => {
    daemon.configureRoom('eng', { cwd: initRepo() });
    await expect(daemon.gitWorkingState('eng', join(dir, 'not-a-known-cwd')))
      .rejects.toThrow(/known directories/);
  });

  it('never mutates the working tree (read-only git surface)', async () => {
    const repo = initRepo();
    daemon.configureRoom('eng', { cwd: repo });
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\nfour\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const snapshot = () => ({
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo }).toString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString(),
      staged: execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo }).toString(),
    });

    const before = snapshot();
    await daemon.gitWorkingState('eng');
    const after = snapshot();

    expect(after).toEqual(before);
    expect(after.staged).toBe(''); // the read never staged anything
  });

  // harn:assume git-history-pages-are-local-and-commit-addressed ref=git-history-daemon-regression
  it('pages local-branch history and renders root plus first-parent merge evidence', async () => {
    const repo = initRepo('history');
    daemon.configureRoom('eng', { cwd: repo });
    const main = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim();
    writeFileSync(join(repo, 'remove.txt'), 'remove in feature\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '--amend', '--no-edit']);
    const root = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    git(repo, ['checkout', '-q', '-b', 'feature/history']);
    git(repo, ['mv', 'gone.txt', 'renamed.txt']);
    rmSync(join(repo, 'remove.txt'));
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 4]));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'feature rename and binary']);
    const feature = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    git(repo, ['checkout', '-q', main]);
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\nmain\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main change']);
    git(repo, ['merge', '-q', '--no-ff', 'feature/history', '-m', 'merge feature history']);
    const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    const first = await daemon.gitHistory('eng', undefined, 0, 2);
    expect(first.repository).toBe(true);
    expect(first.commits).toHaveLength(2);
    expect(first.commits[0]).toMatchObject({ hash: merge, subject: 'merge feature history' });
    expect(first.commits[0]?.parents).toHaveLength(2);
    expect(first.commits.some((commit) => commit.refs.some((ref) => ref.includes(main)))).toBe(true);
    expect(first.next_cursor).toBe(2);
    const second = await daemon.gitHistory('eng', undefined, first.next_cursor!, 2);
    expect(second.commits.map((commit) => commit.hash)).not.toContain(merge);
    expect([...first.commits, ...second.commits].map((commit) => commit.hash)).toContain(feature);

    const mergeState = await daemon.gitCommitState('eng', merge);
    expect(mergeState.comparison).toBe('first-parent');
    expect(mergeState.commit.parents).toHaveLength(2);
    expect(mergeState.files.find((file) => file.path === 'renamed.txt')).toMatchObject({
      old_path: 'gone.txt', status: 'renamed',
    });
    expect(mergeState.files.find((file) => file.path === 'image.bin')).toMatchObject({
      status: 'added', binary: true, additions: 0, deletions: 0,
    });
    expect(mergeState.files.find((file) => file.path === 'remove.txt')?.status).toBe('deleted');

    const rootState = await daemon.gitCommitState('eng', root);
    expect(rootState.comparison).toBe('root');
    expect(rootState.base).toBeNull();
    expect(rootState.files.some((file) => file.status === 'added')).toBe(true);
  });

  it('reports non-repositories and repositories without commits honestly', async () => {
    const plain = join(dir, 'history-plain');
    mkdirSync(plain);
    daemon.configureRoom('eng', { cwd: plain });
    expect(await daemon.gitHistory('eng')).toMatchObject({ repository: false, commits: [] });

    const empty = join(dir, 'history-empty');
    mkdirSync(empty);
    git(empty, ['init', '-q']);
    daemon.configureRoom('eng', { cwd: empty });
    expect(await daemon.gitHistory('eng')).toMatchObject({ repository: true, commits: [], next_cursor: null });
  });

  it('rejects revision syntax and unreachable commit objects', async () => {
    const repo = initRepo('history-validation');
    daemon.configureRoom('eng', { cwd: repo });
    await expect(daemon.gitCommitState('eng', 'HEAD')).rejects.toThrow(/full 40-character/);

    git(repo, ['checkout', '-q', '--orphan', 'discarded']);
    git(repo, ['rm', '-q', '-rf', '.']);
    writeFileSync(join(repo, 'discarded.txt'), 'not reachable later\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'discarded object']);
    const discarded = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    const main = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo })
      .toString().split('\n').find((name) => name !== '' && name !== 'discarded')!;
    git(repo, ['checkout', '-q', main]);
    git(repo, ['branch', '-D', 'discarded']);
    await expect(daemon.gitCommitState('eng', discarded)).rejects.toThrow(/not reachable/);
  });

  it('truncates oversized historical patches without changing repository state', async () => {
    const repo = initRepo('history-limit');
    daemon.configureRoom('eng', { cwd: repo });
    writeFileSync(join(repo, 'large.txt'), 'line\n'.repeat(20_000));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'large patch']);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo }).toString();
    const state = await daemon.gitCommitState('eng', commit);
    const file = state.files.find((candidate) => candidate.path === 'large.txt');
    expect(file?.truncated).toBe(true);
    expect(file?.diff).toContain('diff truncated');
    expect(execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo }).toString()).toBe(before);
  });
  // harn:end git-history-pages-are-local-and-commit-addressed
});

// harn:assume descriptor-safe-durable-inert-snapshots-of-successful-output ref=produced-artifact-daemon-regression
describe('produced-artifact snapshots (descriptor-safe-durable-inert-snapshots-of-successful-output)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  // Drive one finalized fake turn journaling the given run items.
  async function produceEvents(handle: string, cwd: string, items: WireEvent[]): Promise<void> {
    daemon.spawnMember('eng', { harness: 'fake', handle, cwd });
    fake.enqueue({ kind: 'complete', final_text: 'done', items });
    daemon.postHumanMessage('eng', `@${handle} produce`);
    await daemon.settle();
  }

  const fileChanges = (changes: { path: string; change: string }[]): WireEvent[] =>
    changes.map((c) => ({ type: 'run.item', item_type: 'file_change', payload: c })) as unknown as WireEvent[];

  const toolResult = (path: string, status: 'ok' | 'error'): WireEvent =>
    ({ type: 'run.item', item_type: 'tool_result',
       payload: { call_id: 't1', status, diff: { path, unified: '--- a\n+++ b\n' } } }) as unknown as WireEvent;

  // Journal file_change items (Codex/ACP-completed style).
  async function produce(handle: string, cwd: string, changes: { path: string; change: string }[]): Promise<void> {
    await produceEvents(handle, cwd, fileChanges(changes));
  }

  it('snapshots a produced image inside the cwd, keeps it after the source is deleted, and carries no local path', async () => {
    const cwd = testCwd('produce-ok');
    writeFileSync(join(cwd, 'chart.png'), PNG);
    await produce('maker', cwd, [{ path: 'chart.png', change: 'created' }]);

    const artifacts = daemon.listArtifacts('eng');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ name: 'chart.png', media_type: 'image/png', size: PNG.length });
    expect(JSON.stringify(artifacts[0])).not.toContain(cwd); // provenance only, never a path

    // Durable: deleting the source leaves the snapshot bytes intact.
    rmSync(join(cwd, 'chart.png'));
    expect(readFileSync(daemon.artifactPath('eng', artifacts[0]!.id)).equals(PNG)).toBe(true);
  });

  it('refuses a read-only path, a symlink, an outside-cwd path, an active type, and an oversize file', async () => {
    const cwd = testCwd('produce-refuse');
    writeFileSync(join(cwd, 'secret.png'), PNG); // exists but only READ — no file_change
    writeFileSync(join(cwd, 'target.png'), PNG);
    symlinkSync(join(cwd, 'target.png'), join(cwd, 'link.png'));
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, PNG);
    writeFileSync(join(cwd, 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(cwd, 'big.png'), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));

    await produce('refuser', cwd, [
      { path: 'link.png', change: 'created' },
      { path: outside, change: 'created' },
      { path: 'page.html', change: 'created' },
      { path: 'big.png', change: 'created' },
    ]);

    expect(daemon.listArtifacts('eng')).toEqual([]);
  });

  it('caps the number of snapshots per run', async () => {
    const cwd = testCwd('produce-cap');
    const changes: { path: string; change: string }[] = [];
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(cwd, `img${String(i)}.png`), PNG);
      changes.push({ path: `img${String(i)}.png`, change: 'created' });
    }
    await produce('capper', cwd, changes);
    expect(daemon.listArtifacts('eng')).toHaveLength(8); // MAX_ARTIFACTS_PER_RUN
  });

  it('survives a daemon restart via its on-disk metadata sidecar', async () => {
    const cwd = testCwd('produce-restart');
    writeFileSync(join(cwd, 'kept.png'), PNG);
    await produce('keeper', cwd, [{ path: 'kept.png', change: 'created' }]);
    const before = daemon.listArtifacts('eng');
    expect(before).toHaveLength(1);
    await daemon.close();

    const restarted = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [new FakeAdapter('fake')],
      discoverModels: false,
      homeDir: dir,
    });
    try {
      expect(restarted.listArtifacts('eng').map((artifact) => artifact.id)).toEqual(before.map((artifact) => artifact.id));
    } finally {
      await restarted.close();
    }
  });

  it('snapshots a file from a successful tool_result diff (Claude-style, no file_change)', async () => {
    const cwd = testCwd('produce-claude');
    writeFileSync(join(cwd, 'out.png'), PNG);
    await produceEvents('claude', cwd, [toolResult('out.png', 'ok')]);
    const artifacts = daemon.listArtifacts('eng');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ name: 'out.png', media_type: 'image/png' });
  });

  it('refuses a failed tool_result diff even when the named file exists', async () => {
    const cwd = testCwd('produce-failed');
    writeFileSync(join(cwd, 'partial.png'), PNG);
    await produceEvents('failer', cwd, [toolResult('partial.png', 'error')]);
    expect(daemon.listArtifacts('eng')).toEqual([]);
  });

  it('refuses an absolute path into another member\'s cwd', async () => {
    const cwdA = testCwd('produce-alpha');
    const cwdB = testCwd('produce-beta');
    // beta makes cwdB a real room-known cwd; alpha must still be refused reaching into it.
    daemon.spawnMember('eng', { harness: 'fake', handle: 'beta', cwd: cwdB });
    writeFileSync(join(cwdB, 'secret.png'), PNG);
    await produce('alpha', cwdA, [{ path: join(cwdB, 'secret.png'), change: 'created' }]);
    expect(daemon.listArtifacts('eng')).toEqual([]);
  });

  it('records a durable path-free per-run failure and no orphan when the blob write fails', async () => {
    const cwd = testCwd('produce-blobfail');
    writeFileSync(join(cwd, 'x.png'), PNG);
    vi.spyOn(daemon as unknown as { persistArtifactBlob: () => void }, 'persistArtifactBlob')
      .mockImplementationOnce(() => { throw new Error('disk full'); });
    await produce('blobfail', cwd, [{ path: 'x.png', change: 'created' }]);
    expect(daemon.listArtifacts('eng')).toEqual([]); // nothing committed
    const errors = daemon.listArtifactErrors('eng');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).not.toContain(cwd); // path-free failure state
    expect(readdirSync(join(dir, 'artifacts', 'eng')).filter((f) => !f.endsWith('.json'))).toEqual([]); // no orphan/temp
  });

  it('rolls back the published blob and records a failure when the sidecar write fails', async () => {
    const cwd = testCwd('produce-metafail');
    writeFileSync(join(cwd, 'y.png'), PNG);
    vi.spyOn(daemon as unknown as { persistArtifactMeta: () => void }, 'persistArtifactMeta')
      .mockImplementationOnce(() => { throw new Error('sidecar failed'); });
    await produce('metafail', cwd, [{ path: 'y.png', change: 'created' }]);
    expect(daemon.listArtifacts('eng')).toEqual([]); // no committed sidecar
    expect(daemon.listArtifactErrors('eng')).toHaveLength(1);
    expect(readdirSync(join(dir, 'artifacts', 'eng'))).toEqual([]); // published blob rolled back — no orphan bytes
  });

  it('drops temp and orphan (sidecar-less) blobs on restart, keeping committed artifacts', async () => {
    const cwd = testCwd('produce-cleanup');
    writeFileSync(join(cwd, 'keep.png'), PNG);
    await produce('cleaner', cwd, [{ path: 'keep.png', change: 'created' }]);
    const kept = daemon.listArtifacts('eng');
    expect(kept).toHaveLength(1);
    const engDir = join(dir, 'artifacts', 'eng');
    writeFileSync(join(engDir, 'b'.repeat(32)), PNG); // orphan blob (no sidecar)
    writeFileSync(join(engDir, `${'c'.repeat(32)}.tmp`), PNG); // leftover temp
    await daemon.close();

    const restarted = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [new FakeAdapter('fake')],
      discoverModels: false,
      homeDir: dir,
    });
    try {
      expect(restarted.listArtifacts('eng').map((artifact) => artifact.id)).toEqual(kept.map((artifact) => artifact.id));
      const remaining = readdirSync(engDir).filter((f) => !f.endsWith('.json'));
      expect(remaining).toEqual([kept[0]!.id]); // only the committed blob survives
    } finally {
      await restarted.close();
    }
  });

  it('snapshots a native Codex no-diff completed file change (real translator to finalization)', async () => {
    const cwd = testCwd('produce-codex');
    writeFileSync(join(cwd, 'codex.png'), PNG);
    // Drive the REAL native Codex translator for a completed fileChange with no diff body.
    const events = createCodexTurnTranslator().push('item/completed', {
      threadId: 't', turnId: 'u',
      item: { type: 'fileChange', id: 'fc', changes: [{ path: 'codex.png', kind: { type: 'add' } }], status: 'completed' },
    });
    await produceEvents('codexer', cwd, events as WireEvent[]);
    const artifacts = daemon.listArtifacts('eng');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ name: 'codex.png', media_type: 'image/png' });
  });

  it('refuses a candidate that escapes the member cwd through an intermediate symlink', async () => {
    const cwd = testCwd('produce-escape');
    const secret = join(dir, 'secret-loot');
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, 'loot.png'), PNG);
    symlinkSync(secret, join(cwd, 'out')); // cwd/out -> outside dir (intermediate symlink)
    await produce('escaper', cwd, [{ path: 'out/loot.png', change: 'created' }]);
    // The opened descriptor's canonical path is outside the member cwd — refused.
    expect(daemon.listArtifacts('eng')).toEqual([]);
  });

  it('refuses an oversize produced file (byte cap on actual bytes)', async () => {
    const cwd = testCwd('produce-oversize');
    writeFileSync(join(cwd, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
    await produce('heavy', cwd, [{ path: 'huge.png', change: 'created' }]);
    expect(daemon.listArtifacts('eng')).toEqual([]);
  });

  it('refuses to publish a schema-invalid metadata sidecar', () => {
    daemon.ensureArtifactDir('eng');
    const id = daemon.newArtifactId();
    const invalid = { id, name: 'x.png', media_type: '', size: 1, source_message_id: 1, produced_at: '2026-07-22T00:00:00.000Z' };
    expect(() => (daemon as unknown as { persistArtifactMeta: (r: string, i: string, m: unknown) => void })
      .persistArtifactMeta('eng', id, invalid)).toThrow();
    expect(daemon.getArtifactMeta('eng', id)).toBeUndefined(); // nothing committed
  });

  it('bounds the durable per-run failure feed', () => {
    for (let i = 0; i < 60; i += 1) daemon.recordArtifactError('eng', i + 1);
    expect(daemon.listArtifactErrors('eng')).toHaveLength(50); // MAX_ARTIFACT_ERRORS_PER_ROOM
  });

  it('cleans error temp state on restart, keeping real failure records', async () => {
    daemon.recordArtifactError('eng', 7);
    const errDir = join(dir, 'artifact-errors', 'eng');
    writeFileSync(join(errDir, '999.json.tmp'), '{}'); // leftover temp from an interrupted write
    await daemon.close();

    const restarted = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [new FakeAdapter('fake')],
      discoverModels: false,
      homeDir: dir,
    });
    try {
      expect(restarted.listArtifactErrors('eng').map((error) => error.source_message_id)).toEqual([7]);
      expect(readdirSync(errDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      await restarted.close();
    }
  });
});
// harn:end descriptor-safe-durable-inert-snapshots-of-successful-output

describe('message attachments', () => {
  const stage = (room: string, name: string, mime: string, bytes: string) => {
    const id = daemon.newAttachmentId();
    daemon.ensureAttachmentDir(room);
    writeFileSync(daemon.attachmentPath(room, id), bytes);
    const meta = { id, name, mime, size: Buffer.byteLength(bytes) };
    daemon.recordAttachment(room, meta);
    return meta;
  };

  it('round-trips attachment metadata on a posted message', () => {
    const meta = stage('eng', 'shot.png', 'image/png', 'PNGDATA');
    const message = daemon.postHumanMessage('eng', 'here is the shot', { attachments: [meta] });
    expect(daemon.store.getMessage('eng', message.id)?.attachments).toEqual([meta]);
    expect(daemon.postHumanMessage('eng', 'no files').attachments).toBeUndefined();
  });

  it('adds the attachments column to a pre-existing database', () => {
    const dbPath = join(dir, 'migrate.sqlite');
    const seed = new Store(dbPath);
    const { owner } = seed.createRoom({ id: 'm', name: 'M', owner: { handle: 'richard', display_name: 'Richard' } });
    const before = seed.postMessage('m', { author: owner.id, kind: 'chat', body: 'old' });
    seed.close();
    // Simulate a database created before the attachments column existed.
    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE messages DROP COLUMN attachments');
    raw.close();
    const migrated = new Store(dbPath);
    expect(migrated.getMessage('m', before.id)?.attachments).toBeUndefined();
    const att = { id: 'a'.repeat(32), name: 'f.png', mime: 'image/png', size: 3 };
    const after = migrated.postMessage('m', { author: owner.id, kind: 'chat', body: 'new', attachments: [att] });
    expect(migrated.getMessage('m', after.id)?.attachments).toEqual([att]);
    migrated.close();
  });

  it('appends attachment absolute paths to an agent delivery payload', async () => {
    spawnAgent('alpha');
    const meta = stage('eng', 'log.txt', 'text/plain', 'hello world');
    fake.enqueue({ kind: 'complete', final_text: '@richard read it' });
    daemon.postHumanMessage('eng', '@alpha read the log', { attachments: [meta] });
    await daemon.settle();
    const payload = fake.deliveries.at(-1)!.payload;
    expect(payload).toContain(daemon.attachmentPath('eng', meta.id));
    expect(payload).toContain('log.txt');
  });

  it('unlinks attachment files from disk on delete and nulls the column', () => {
    const meta = stage('eng', 'shot.png', 'image/png', 'PNGDATA');
    const message = daemon.postHumanMessage('eng', 'delete me', { attachments: [meta] });
    const path = daemon.attachmentPath('eng', meta.id);
    expect(existsSync(path)).toBe(true);
    daemon.deleteMessage('eng', message.id, daemon.ownerOf('eng').id);
    expect(existsSync(path)).toBe(false); // bytes gone from disk
    expect(existsSync(`${path}.json`)).toBe(false); // sidecar gone
    expect(daemon.store.getMessage('eng', message.id)?.attachments).toBeUndefined();
  });

  it('sweeps unreferenced attachments older than a day, keeping referenced and fresh ones', () => {
    const referenced = stage('eng', 'keep.png', 'image/png', 'KEEP');
    daemon.postHumanMessage('eng', 'keep this', { attachments: [referenced] });
    const orphanOld = stage('eng', 'old.bin', 'application/octet-stream', 'OLD');
    const orphanFresh = stage('eng', 'fresh.bin', 'application/octet-stream', 'FRESH');

    const oldPath = daemon.attachmentPath('eng', orphanOld.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, twoDaysAgo, twoDaysAgo);
    utimesSync(`${oldPath}.json`, twoDaysAgo, twoDaysAgo);

    daemon.sweepOrphanAttachments();

    expect(existsSync(daemon.attachmentPath('eng', referenced.id))).toBe(true); // referenced: kept
    expect(existsSync(daemon.attachmentPath('eng', orphanFresh.id))).toBe(true); // fresh orphan: kept
    expect(existsSync(oldPath)).toBe(false); // old orphan: swept
  });
});

describe('shutdown-interrupted delivery requeue (boot recovery)', () => {
  // Build a run left `running` at boot with a bound delivery in the given state —
  // the state a shutdown mid-turn strands. No live turn runs; the store is posed.
  const strand = (opts: { body?: string; state?: 'consumed' | 'delivering'; attempt?: number }) => {
    const alpha = spawnAgent('alpha');
    const trigger = daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: opts.body ?? '@alpha do the thing',
    });
    const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runMsg = daemon.store.updateMessage('eng', posted.id, {
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: `runs/${posted.id}.jsonl` },
    });
    const delivery = daemon.store.createDelivery('eng', { message_id: trigger.id, recipient: alpha.id });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: opts.state ?? 'consumed', attempt_count: opts.attempt ?? 1, run_msg_id: runMsg.id,
    });
    return { alpha, trigger, runMsg, delivery };
  };

  it('re-queues a stranded delivery into a fresh completing turn, run finalized interrupted', async () => {
    const { runMsg, delivery, alpha } = strand({ body: '@alpha finish the deploy', attempt: 1 });
    await daemon.close();

    daemon = newDaemon();
    fake.enqueue({ kind: 'complete', final_text: 'deploy finished after restart @richard' });
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('interrupted');
    expect(fake.deliveries.at(-1)!.payload).toContain('finish the deploy');
    const fresh = runMessages().find((m) => m.id !== runMsg.id && m.author === alpha.id)!;
    expect(fresh.run!.status).toBe('completed');
    expect(fresh.body).toBe('deploy finished after restart @richard');
    expect(daemon.store.getDelivery('eng', delivery.id)!.attempt_count).toBe(2); // preserved 1 → +1 this turn
  });

  it('does not re-queue a delivery at the retry ceiling, and names it in a system message', async () => {
    const { runMsg, delivery } = strand({ body: '@alpha poison', attempt: RECOVERY_ATTEMPT_CEILING });
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed'); // fenced
    expect(fake.deliveries).toHaveLength(0); // never re-ran
    const fence = daemon.store.listMessages('eng', { limit: 100 })
      .find((m) => m.kind === 'system' && m.body.includes('retry ceiling'));
    expect(fence?.body).toContain('@alpha');
  });

  it('does not re-queue a delivery whose trigger message was deleted', async () => {
    const owner = daemon.ownerOf('eng');
    const { runMsg, delivery, trigger } = strand({ body: '@alpha deleted instruction', attempt: 1 });
    daemon.deleteMessage('eng', trigger.id, owner.id); // purge the trigger
    await daemon.close();

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed'); // purge stays purged
    expect(fake.deliveries).toHaveLength(0);
  });

  it('leaves operator redeliver unchanged — it resets and re-runs even past the recovery ceiling', async () => {
    // Above the recovery fence: recovery would leave this consumed, but operator
    // redeliver resets the attempt count, so it must still re-run to completion.
    const { runMsg, delivery } = strand({ body: '@alpha redeliver me', state: 'held', attempt: RECOVERY_ATTEMPT_CEILING + 1 });
    fake.enqueue({ kind: 'complete', final_text: 'operator redeliver done @richard' });

    daemon.redeliver('eng', delivery.id);
    await daemon.settle();

    expect(daemon.store.getMessage('eng', runMsg.id)!.run!.status).toBe('interrupted');
    const fresh = runMessages().find((m) => m.id !== runMsg.id)!;
    expect(fresh.run!.status).toBe('completed');
    expect(fresh.body).toBe('operator redeliver done @richard');
  });
});

describe('graceful shutdown delivery requeue (close seam)', () => {
  // A turn that is genuinely IN FLIGHT when the daemon stops: it blocks until
  // close() interrupts it through the same adapter path SIGTERM drives, so the
  // run finalizes before the store closes — the shape live fire exposed (#492).
  const startBlockedTurn = async (body = '@alpha finish the deploy') => {
    const alpha = spawnAgent('alpha');
    fake.enqueue({ kind: 'ask', card: { kind: 'ask', prompt: 'blocked mid-turn' }, reply: () => 'answered' });
    const trigger = daemon.postHumanMessage('eng', body);
    const running = await until(() => runMessages().find((m) => m.run?.status === 'running'));
    const delivery = daemon.store.listDeliveries('eng').find((d) => d.run_msg_id === running.id)!;
    return { alpha, trigger, running, delivery };
  };

  it('a graceful close re-queues the in-flight turn it interrupts; the next boot re-takes it', async () => {
    const { alpha, running, delivery } = await startBlockedTurn();
    expect(delivery.state).toBe('delivering');

    await daemon.close(); // graceful (non-force) — the real restart path

    daemon = newDaemon();
    const healed = daemon.store.getDelivery('eng', delivery.id)!;
    expect(healed.state).toBe('queued'); // not silently eaten
    expect(healed.attempt_count).toBe(1); // preserved, not reset
    expect(healed.run_msg_id).toBeUndefined();
    expect(daemon.store.getMessage('eng', running.id)!.run!.status).toBe('interrupted');

    fake.enqueue({ kind: 'complete', final_text: 'deploy finished after restart @richard' });
    await daemon.reconcile();
    await daemon.settle();

    const fresh = runMessages().find((m) =>
      m.id !== running.id && m.author === alpha.id && m.run?.status === 'completed')!;
    expect(fresh.body).toBe('deploy finished after restart @richard');
    expect(daemon.store.getDelivery('eng', delivery.id)!.attempt_count).toBe(2); // 1 preserved + this turn
  });

  it('never re-queues a turn that completed in the instant before the interrupt landed', async () => {
    // close() marks lifecycle cause BEFORE interrupting. This adapter turn does
    // not react to interrupt and completes normally inside that window, so the
    // status gate — not a post-finalization requeue helper — must keep it final.
    const alpha = spawnAgent('alpha');
    fake.enqueue({
      kind: 'complete',
      final_text: 'answered before the interrupt',
      delay_ms: 20,
    });
    daemon.postHumanMessage('eng', '@alpha quick question');
    const running = await until(() => runMessages().find((message) =>
      message.author === alpha.id && message.run?.status === 'running'));
    await daemon.close();

    daemon = newDaemon();
    expect(daemon.store.getMessage('eng', running.id)?.run?.status).toBe('completed');
    const consumed = daemon.store.listDeliveries('eng')
      .find((delivery) => delivery.run_msg_id === running.id)!;
    expect(consumed.state).toBe('consumed');
    await daemon.reconcile();
    await daemon.settle();
    expect(runMessages().filter((message) => message.author === alpha.id)).toHaveLength(1);
  });

  it('never re-queues a turn an operator deliberately stopped', async () => {
    const { alpha, running, delivery } = await startBlockedTurn('@alpha stoppable work');
    const before = fake.deliveries.length;

    daemon.interruptMember('eng', alpha.id); // the operator's Stop
    await until(() => (daemon.store.getMessage('eng', running.id)!.run!.status !== 'running' ? true : undefined));
    await daemon.close();

    daemon = newDaemon();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed'); // a Stop stays stopped
    await daemon.reconcile();
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(before); // never re-taken
  });

  it('fences a delivery at the retry ceiling at the close seam, naming it', async () => {
    const { running, delivery } = await startBlockedTurn('@alpha poison work');
    // Pose it at the ceiling, as a repeat offender would be by now.
    daemon.store.updateDelivery('eng', delivery.id, { attempt_count: RECOVERY_ATTEMPT_CEILING });

    await daemon.close();

    daemon = newDaemon();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed'); // fenced
    const fence = daemon.store.listMessages('eng', { limit: 200 })
      .find((m) => m.kind === 'system' && m.body.includes('retry ceiling'));
    expect(fence?.body).toContain('@alpha');
    expect(fence?.body).toContain(`#${String(running.id)}`);
  });

  it('leaves a deleted trigger purged at the close seam', async () => {
    const owner = daemon.ownerOf('eng');
    const { trigger, delivery } = await startBlockedTurn('@alpha deleted work');
    daemon.deleteMessage('eng', trigger.id, owner.id); // purge the instruction

    await daemon.close();

    daemon = newDaemon();
    expect(daemon.store.getDelivery('eng', delivery.id)!.state).toBe('consumed'); // purge stays purged
    expect(daemon.store.listMessages('eng', { limit: 200 }).some((message) =>
      message.kind === 'system' && message.body.includes('the instruction was deleted'))).toBe(true);
  });
});

// harn:assume lifecycle-retries-only-live-collaboration-work ref=lifecycle-collaboration-retry-regression
// harn:assume collaboration-lifecycle-interruption-is-nonterminal ref=lifecycle-collaboration-finalization-regression
describe('lifecycle interruption and collaboration terminality', () => {
  const startGroupedBlockedTurn = async (prefix: string) => {
    const alpha = spawnAgent(`${prefix}-alpha`);
    const beta = spawnAgent(`${prefix}-beta`);
    fake.enqueue(
      { kind: 'fail-on-interrupt', error: 'native process exited after lifecycle SIGINT' },
      { kind: 'complete', final_text: `${prefix} beta completed` },
    );
    const root = daemon.postHumanMessage(
      'eng',
      `@${prefix}-alpha @${prefix}-beta compare lifecycle behavior`,
    );
    const running = await until(() => {
      const alphaRun = runMessages().find((message) =>
        message.author === alpha.id && message.run?.status === 'running');
      const betaRun = runMessages().find((message) =>
        message.author === beta.id && message.run?.status === 'completed');
      return alphaRun && betaRun ? alphaRun : undefined;
    });
    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const delivery = daemon.store.listDeliveries('eng').find((candidate) =>
      candidate.group_id === group.id && candidate.recipient === alpha.id)!;
    return { alpha, beta, root, group, running, delivery };
  };

  it('requeues a lifecycle-interrupted participant as nonterminal, then records only the retry result', async () => {
    const seeded = await startGroupedBlockedTurn('retryable');
    await daemon.close();

    daemon = newDaemon();
    expect(daemon.store.getMessage('eng', seeded.running.id)?.run?.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', seeded.delivery.id)).toMatchObject({
      state: 'queued', attempt_count: 1, run_msg_id: undefined,
    });
    expect(daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.delivery.id,
    )?.terminal_status).toBeUndefined();
    expect(daemon.store.getCollaborationRound('eng', seeded.group.id, 1)?.state).toBe('collecting');

    fake.enqueue({ kind: 'complete', final_text: 'retryable alpha completed once' });
    await daemon.reconcile();
    await daemon.settle();

    const retriedDelivery = daemon.store.getDelivery('eng', seeded.delivery.id)!;
    const participant = daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.delivery.id,
    )!;
    expect(retriedDelivery).toMatchObject({ state: 'consumed', attempt_count: 2 });
    expect(participant.terminal_status).toBe('completed');
    expect(participant.result_message_id).not.toBe(seeded.running.id);
    expect(daemon.store.getMessage('eng', participant.result_message_id!)?.body)
      .toBe('retryable alpha completed once');
    expect(daemon.store.getCollaborationGroup('eng', seeded.group.id)?.state).toBe('completed');
    expect(daemon.store.getCollaborationRound('eng', seeded.group.id, 1)?.state).toBe('closed');
  });

  it('terminalizes a ceiling-refused lifecycle participant and releases its barrier', async () => {
    const seeded = await startGroupedBlockedTurn('ceiling');
    daemon.store.updateDelivery('eng', seeded.delivery.id, {
      attempt_count: RECOVERY_ATTEMPT_CEILING,
    });

    await daemon.close();
    daemon = newDaemon();

    expect(daemon.store.getDelivery('eng', seeded.delivery.id)?.state).toBe('consumed');
    expect(daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.delivery.id,
    )).toMatchObject({
      terminal_status: 'interrupted', result_message_id: seeded.running.id,
    });
    expect(daemon.store.getCollaborationRound('eng', seeded.group.id, 1)?.state).toBe('closed');
    expect(daemon.store.getCollaborationGroup('eng', seeded.group.id)?.state).toBe('completed');
    expect(daemon.store.listMessages('eng', { limit: 200 }).filter((message) =>
      message.kind === 'system' && message.body.includes('retry ceiling'))).toHaveLength(1);
    const before = fake.deliveries.length;
    await daemon.reconcile();
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(before);
  });

  it('uses lifecycle refusal for a newly closed group instead of failed-finalization repair', async () => {
    const seeded = await startGroupedBlockedTurn('closed-work');
    daemon.store.updateCollaborationGroup('eng', seeded.group.id, {
      state: 'completed', completed_ts: '2026-07-18T10:20:00.000Z',
    });

    await daemon.close();
    daemon = newDaemon();

    expect(daemon.store.getMessage('eng', seeded.running.id)?.run?.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', seeded.delivery.id)?.state).toBe('consumed');
    expect(daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.delivery.id,
    )).toMatchObject({
      terminal_status: 'interrupted', result_message_id: seeded.running.id,
    });
    expect(daemon.store.listMessages('eng', { limit: 200 }).some((message) =>
      message.kind === 'system'
      && message.body.includes('collaboration work was already settled'))).toBe(true);
    expect(daemon.store.listMessages('eng', { limit: 200 }).some((message) =>
      message.kind === 'system' && message.body.includes('could not finalize'))).toBe(false);
  });

  it('keeps an operator Stop terminal and never turns it into lifecycle retry', async () => {
    const seeded = await startGroupedBlockedTurn('operator');
    daemon.interruptMember('eng', seeded.alpha.id);
    await daemon.settle();

    expect(daemon.store.getMessage('eng', seeded.running.id)?.run?.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', seeded.delivery.id)?.state).toBe('consumed');
    expect(daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.delivery.id,
    )).toMatchObject({
      terminal_status: 'interrupted', result_message_id: seeded.running.id,
    });
    expect(daemon.store.getCollaborationGroup('eng', seeded.group.id)?.state).toBe('completed');
    const before = fake.deliveries.length;
    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(before);
  });
});
// harn:end collaboration-lifecycle-interruption-is-nonterminal
// harn:end lifecycle-retries-only-live-collaboration-work

// harn:assume lifecycle-retries-only-live-collaboration-work ref=lifecycle-collaboration-retry-regression
describe('exact-run lifecycle crash settlement', () => {
  it('settles a stranded run even while another run by the same author is being retried', async () => {
    const alpha = spawnAgent('same-author-alpha');
    const owner = daemon.ownerOf('eng');
    const seedRun = (body: string, state: 'delivering' | 'consumed') => {
      const trigger = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body });
      const posted = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
      const run = daemon.store.updateMessage('eng', posted.id, {
        run: {
          status: 'running',
          started_ts: '2026-07-18T09:00:00.000Z',
          tool_calls: 0,
          events_ref: `runs/${String(posted.id)}.jsonl`,
        },
      });
      const delivery = daemon.store.createDelivery('eng', {
        message_id: trigger.id, recipient: alpha.id,
      });
      daemon.store.updateDelivery('eng', delivery.id, {
        state, attempt_count: 1, run_msg_id: run.id,
      });
      return { run, delivery };
    };
    const retrying = seedRun('@same-author-alpha retry this run', 'delivering');
    const stranded = seedRun('@same-author-alpha settle this other run', 'consumed');
    daemon.store.updateMember('eng', alpha.id, { state: 'running' });
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'hold the first recovered run open' },
      reply: () => 'first recovered run answered',
    });

    await daemon.reconcile();

    expect(daemon.store.getMessage('eng', retrying.run.id)?.run?.status).toBe('running');
    expect(daemon.store.getMessage('eng', stranded.run.id)?.run?.status).toBe('interrupted');
    expect(daemon.store.getDelivery('eng', stranded.delivery.id)).toMatchObject({
      state: 'queued', attempt_count: 1, run_msg_id: undefined,
    });
    expect(daemon.store.getMember('eng', alpha.id)?.state).not.toBe('idle');
    await until(() => daemon.store.getMember('eng', alpha.id)?.state === 'awaiting_input'
      ? true
      : undefined);

    daemon.interruptMember('eng', alpha.id);
    await daemon.settle();
  });
});
// harn:end lifecycle-retries-only-live-collaboration-work

// harn:assume failed-finalization-reconciles-at-runtime ref=delivery-reconciliation-regression
describe('failed turn finalization reconciliation', () => {
  const seedClosedDuplicateAttempt = () => {
    const alpha = spawnAgent('duplicate-alpha');
    const beta = spawnAgent('duplicate-beta');
    const owner = daemon.ownerOf('eng');
    const root = daemon.store.postMessage('eng', {
      author: owner.id,
      kind: 'chat',
      body: '@duplicate-alpha @duplicate-beta compare the repair',
    });
    const projection = daemon.store.createCollaborationGroup('eng', {
      groupId: 'duplicate-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha payload' },
        { memberId: beta.id, payloadSnapshot: 'beta payload' },
      ],
    });
    const alphaDelivery = projection.deliveries.find((delivery) => delivery.recipient === alpha.id)!;
    const betaDelivery = projection.deliveries.find((delivery) => delivery.recipient === beta.id)!;
    const resultFor = (author: string, status: 'completed' | 'interrupted') => {
      const posted = daemon.store.postMessage('eng', { author, kind: 'run', body: '' });
      return daemon.store.updateMessage('eng', posted.id, {
        run: {
          status,
          started_ts: '2026-07-18T08:30:00.000Z',
          ended_ts: '2026-07-18T08:31:00.000Z',
          tool_calls: 0,
          events_ref: `runs/${String(posted.id)}.jsonl`,
        },
      });
    };
    const originalResult = resultFor(alpha.id, 'interrupted');
    const betaResult = resultFor(beta.id, 'completed');
    daemon.store.updateDelivery('eng', alphaDelivery.id, {
      state: 'consumed', attempt_count: 1, run_msg_id: originalResult.id,
    });
    daemon.store.updateDelivery('eng', betaDelivery.id, {
      state: 'consumed', attempt_count: 1, run_msg_id: betaResult.id,
    });
    daemon.store.recordCollaborationParticipantTerminal('eng', {
      deliveryId: alphaDelivery.id,
      status: 'interrupted',
      resultMessageId: originalResult.id,
      completedTs: '2026-07-18T08:31:00.000Z',
    });
    daemon.store.recordCollaborationParticipantTerminal('eng', {
      deliveryId: betaDelivery.id,
      status: 'completed',
      resultMessageId: betaResult.id,
      completedTs: '2026-07-18T08:31:00.000Z',
    });
    daemon.store.updateCollaborationRound('eng', projection.group.id, 1, {
      state: 'closed', released_ts: '2026-07-18T08:32:00.000Z',
    });
    daemon.store.updateCollaborationGroup('eng', projection.group.id, {
      state: 'completed', completed_ts: '2026-07-18T08:32:00.000Z',
    });

    const postedRetry = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const retry = daemon.store.updateMessage('eng', postedRetry.id, {
      run: {
        status: 'running',
        started_ts: '2026-07-18T08:34:00.000Z',
        tool_calls: 0,
        events_ref: `runs/${String(postedRetry.id)}.jsonl`,
      },
    });
    daemon.store.updateMember('eng', alpha.id, { state: 'running' });
    daemon.store.updateDelivery('eng', alphaDelivery.id, {
      state: 'delivering',
      attempt_count: RECOVERY_ATTEMPT_CEILING,
      run_msg_id: retry.id,
      batch_id: `batch-${String(retry.id)}`,
    });
    daemon.blobs.append('eng', retry.run!.events_ref, {
      type: 'run.completed',
      status: 'completed',
      final_text: '@duplicate-beta this obsolete answer must never route',
      usage: { input_tokens: 30_320, output_tokens: 41 },
    });
    return {
      alpha,
      beta,
      projection,
      alphaDelivery,
      originalResult,
      retry,
    };
  };

  it('repairs the copied-live closed-result topology on boot, once, without routing', async () => {
    const seeded = seedClosedDuplicateAttempt();
    const beforeMessages = daemon.store.listMessages('eng', { limit: 100 }).length;
    await daemon.close({ force: true });

    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const repaired = daemon.store.getMessage('eng', seeded.retry.id)!;
    expect(repaired.run).toMatchObject({
      status: 'failed',
      error: 'finalization could not commit: its collaboration work was already settled',
    });
    const retainedTerminal = daemon.blobs.read('eng', repaired.run!.events_ref).at(-1)!;
    expect(retainedTerminal).toMatchObject({
      type: 'run.completed',
      status: 'completed',
      usage: { input_tokens: 30_320, output_tokens: 41 },
    });
    expect(daemon.store.getDelivery('eng', seeded.alphaDelivery.id)).toMatchObject({
      state: 'consumed', run_msg_id: seeded.retry.id,
    });
    expect(daemon.store.findCollaborationParticipantByDelivery(
      'eng', seeded.alphaDelivery.id,
    )).toMatchObject({
      terminal_status: 'interrupted', result_message_id: seeded.originalResult.id,
    });
    expect(daemon.store.getCollaborationGroup('eng', seeded.projection.group.id)?.state)
      .toBe('completed');
    expect(daemon.store.getCollaborationRound('eng', seeded.projection.group.id, 1)?.state)
      .toBe('closed');
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.listDeliveries('eng').filter((delivery) =>
      delivery.message_id === repaired.id)).toHaveLength(0);
    const notices = daemon.store.listMessages('eng', { limit: 100 }).filter((message) =>
      message.kind === 'system' && message.body.includes('duplicate instruction was consumed'));
    expect(notices).toHaveLength(1);
    expect(daemon.store.listMessages('eng', { limit: 100 })).toHaveLength(beforeMessages + 1);
    const day = new Date().toISOString().slice(0, 10);
    expect(daemon.store.getMeter('eng', day)).toMatchObject({
      turns: 1, input_tokens: 30_320, output_tokens: 41, uncosted_tokens: 30_361,
    });

    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.listMessages('eng', { limit: 100 }).filter((message) =>
      message.kind === 'system' && message.body.includes('duplicate instruction was consumed')))
      .toHaveLength(1);
    expect(daemon.store.getMeter('eng', day)).toMatchObject({
      turns: 1, input_tokens: 30_320, output_tokens: 41, uncosted_tokens: 30_361,
    });

    fake.enqueue({ kind: 'complete', final_text: 'later work is admitted' });
    daemon.postHumanMessage('eng', '@duplicate-alpha later work');
    await daemon.settle();
    expect(runMessages().some((message) =>
      message.author === seeded.alpha.id && message.run?.status === 'completed'
      && message.body === 'later work is admitted')).toBe(true);
  });

  it('holds a generic runtime finalization failure and redeliver clears the fence', async () => {
    const alpha = spawnAgent('runtime-repair');
    const completeTurn = vi.spyOn(daemon.store, 'completeTurn');
    completeTurn.mockImplementationOnce(() => {
      throw new Error('injected completeTurn failure');
    });
    fake.enqueue({
      kind: 'complete',
      final_text: '@richard output that must not route',
      usage: { input_tokens: 333, output_tokens: 22 },
    });
    const trigger = daemon.postHumanMessage('eng', '@runtime-repair do fragile work');
    await daemon.settle();

    const failed = runMessages().find((message) => message.author === alpha.id)!;
    const delivery = daemon.store.listDeliveries('eng').find((candidate) =>
      candidate.message_id === trigger.id && candidate.recipient === alpha.id)!;
    expect(failed.run).toMatchObject({
      status: 'failed',
      error: 'finalization could not commit: injected completeTurn failure',
    });
    expect(delivery.state).toBe('held');
    expect(daemon.store.getMember('eng', alpha.id)?.state).toBe('idle');
    expect(daemon.store.listDeliveries('eng').filter((candidate) =>
      candidate.message_id === failed.id)).toHaveLength(0);
    expect(daemon.store.listMessages('eng', { limit: 100 }).filter((message) =>
      message.kind === 'system' && message.body.includes('release_hold or redeliver')))
      .toHaveLength(1);
    expect(frames.some(({ frame }) => frame.type === 'meter'
      && frame.meter.input_tokens === 333 && frame.meter.output_tokens === 22)).toBe(true);

    fake.enqueue({ kind: 'complete', final_text: 'operator recovery completed' });
    daemon.redeliver('eng', delivery.id);
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(runMessages().filter((message) =>
      message.author === alpha.id && message.run?.status === 'completed'
      && message.body === 'operator recovery completed')).toHaveLength(1);
  });

  it('rethrows a post-commit error instead of misreporting the committed run as repaired', async () => {
    const backgroundErrors: Error[] = [];
    vi.spyOn(daemon as unknown as { onBackgroundError(error: Error): void }, 'onBackgroundError')
      .mockImplementation((error) => backgroundErrors.push(error));
    const actualComplete = daemon.store.completeTurn.bind(daemon.store);
    vi.spyOn(daemon.store, 'completeTurn').mockImplementationOnce((room, opts) => {
      actualComplete(room, opts);
      throw new Error('injected after-commit failure');
    });
    const alpha = spawnAgent('post-commit-alpha');
    fake.enqueue({ kind: 'complete', final_text: 'durably completed' });
    daemon.postHumanMessage('eng', '@post-commit-alpha finish durably');
    await daemon.settle();

    const run = runMessages().find((message) => message.author === alpha.id)!;
    expect(run.run?.status).toBe('completed');
    expect(backgroundErrors.map((error) => error.message)).toContain('injected after-commit failure');
    expect(daemon.store.listMessages('eng', { limit: 100 }).some((message) =>
      message.kind === 'system' && message.body.includes('could not finalize'))).toBe(false);
  });
});
// harn:end failed-finalization-reconciles-at-runtime

describe('bounded cold hydration (store)', () => {
  /** A room with a long tail plus one of each correctness outlier, all OLD
   *  enough to fall outside a small bound. */
  const seedBoundedRoom = () => {
    const owner = daemon.ownerOf('eng');
    const alpha = spawnAgent('alpha');
    // Outlier: a finalized non-ack agent run — the default-recipient seed.
    const seedPost = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: 'old agent reply' });
    const recipientSeedId = daemon.store.updateMessage('eng', seedPost.id, {
      run: {
        status: 'completed', started_ts: new Date().toISOString(), ended_ts: new Date().toISOString(),
        tool_calls: 0, events_ref: `runs/${seedPost.id}.jsonl`, final_text: 'old agent reply',
      },
    }).id;
    // Outlier: a run still running.
    const runningPost = daemon.store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    const runningRunId = daemon.store.updateMessage('eng', runningPost.id, {
      run: {
        status: 'running', started_ts: new Date().toISOString(),
        tool_calls: 0, events_ref: `runs/${runningPost.id}.jsonl`,
      },
    }).id;
    // Outlier: the card of an unresolved ask.
    const askId = daemon.store.postMessage('eng', { author: alpha.id, kind: 'ask', body: 'which one?' }).id;
    daemon.store.upsertInteraction({
      id: 'int-old', room: 'eng', member_id: alpha.id, message_id: askId,
      native_id: 'native-old', kind: 'ask', targets: [owner.id], state: 'pending',
    });
    // Outlier: a message the subscriber has an unread consumed delivery for.
    const unreadId = daemon.store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'unread mention' }).id;
    const delivery = daemon.store.createDelivery('eng', { message_id: unreadId, recipient: owner.id });
    daemon.store.updateDelivery('eng', delivery.id, { state: 'consumed' });
    // A long contiguous tail on top of them.
    const tailIds: number[] = [];
    for (let i = 0; i < 30; i++) {
      tailIds.push(daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: `tail ${i}` }).id);
    }
    return { owner, recipientSeedId, runningRunId, askId, unreadId, tailIds };
  };

  it('serves the contiguous tail plus every outlier class, with the floor excluding outliers', () => {
    const seeded = seedBoundedRoom();
    const sync = daemon.store.sync('eng', 0, { hydrateLimit: 10, subscriber: seeded.owner.id });

    const ids = sync.messages.map((message) => message.id);
    const tail = seeded.tailIds.slice(-10);
    for (const id of tail) expect(ids).toContain(id); // the whole contiguous tail
    expect(ids).toContain(seeded.runningRunId); // a live turn, however old
    expect(ids).toContain(seeded.askId); // an unresolved card stays answerable
    expect(ids).toContain(seeded.unreadId); // or the inbox badge undercounts
    expect(ids).toContain(seeded.recipientSeedId); // the default-recipient seed
    // Bounded: the tail plus outliers only, not the whole room.
    expect(ids.length).toBeLessThan(seeded.tailIds.length);
    // The floor is the tail's alone — an outlier must not drag the cursor back.
    expect(sync.history_floor).toBe(tail[0]);
    expect(sync.members.length).toBeGreaterThan(0); // full roster
  });

  it('leaves a cold sync without a bound byte-identical to today', () => {
    seedBoundedRoom();
    const bounded = daemon.store.sync('eng', 0, {});
    const legacy = daemon.store.sync('eng', 0);
    expect(bounded).toEqual(legacy);
    expect(legacy.history_floor).toBeUndefined();
    // Everything replays: the bound is what shrinks it, and there is none.
    expect(legacy.messages.length).toBeGreaterThan(30);
  });

  it('ignores a bound on a warm sync so a reconnect can never miss a change', () => {
    const seeded = seedBoundedRoom();
    const cold = daemon.store.sync('eng', 0);
    // An in-place finalization after the cursor.
    daemon.store.updateMessage('eng', seeded.runningRunId, {
      run: {
        status: 'interrupted', started_ts: new Date().toISOString(), ended_ts: new Date().toISOString(),
        tool_calls: 0, events_ref: `runs/${seeded.runningRunId}.jsonl`,
      },
    });
    const warmBounded = daemon.store.sync('eng', cold.seq, { hydrateLimit: 1, subscriber: seeded.owner.id });
    const warmPlain = daemon.store.sync('eng', cold.seq);
    expect(warmBounded).toEqual(warmPlain);
    expect(warmBounded.history_floor).toBeUndefined();
    expect(warmBounded.messages.map((m) => m.id)).toContain(seeded.runningRunId);
  });
});

// harn:assume manual-compaction-is-an-operator-act ref=compact-member-contract-spec
describe('manual engine compaction', () => {
  const owner = () => daemon.ownerOf('eng');

  const human = (handle: string, role: 'observer' | 'member' | 'admin') =>
    daemon.store.addMember('eng', {
      kind: 'human', handle, display_name: handle, role,
    });

  it('compacts an idle agent and lands the engine re-baseline on the ring', async () => {
    const agent = spawnAgent('alpha');
    fake.compactUsage = { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 12_000 };

    // The ring updates because a member frame carries the re-baseline out.
    const frames: Member[] = [];
    const stop = daemon.onFrame((_room, frame) => {
      if (frame.type === 'member') frames.push(frame.member);
    });
    await daemon.compactMember('eng', agent.id, owner().id);
    stop();

    expect(fake.compactions).toHaveLength(1); // the harness did the compacting
    const landed = frames.filter((member) => member.id === agent.id).at(-1);
    expect(landed?.lastUsage?.contextWindowUsedTokens).toBe(12_000);
  });

  it('refuses an agent principal, so an agent can never compact itself', async () => {
    const agent = spawnAgent('alpha');
    await expect(daemon.compactMember('eng', agent.id, agent.id))
      .rejects.toThrow(/only owners and admins/);
    expect(fake.compactions).toHaveLength(0);
  });

  it('refuses a member and an observer, admitting only owner and admin', async () => {
    const agent = spawnAgent('alpha');
    for (const role of ['observer', 'member'] as const) {
      const principal = human(`h-${role}`, role);
      await expect(daemon.compactMember('eng', agent.id, principal.id))
        .rejects.toThrow(/only owners and admins/);
    }
    const admin = human('h-admin', 'admin');
    await daemon.compactMember('eng', agent.id, admin.id);
    expect(fake.compactions).toHaveLength(1);
  });

  it('refuses a running member — compaction mid-turn races the engine', async () => {
    const agent = spawnAgent('alpha');
    fake.enqueue({ kind: 'ask', question: 'may I?' });
    daemon.postHumanMessage('eng', `@alpha rotate the keys`);
    await vi.waitFor(() => {
      expect(runMessages().some((m) => m.run?.status === 'running')).toBe(true);
    });

    await expect(daemon.compactMember('eng', agent.id, owner().id))
      .rejects.toThrow(/is running — stop the turn before compacting/);
    expect(fake.compactions).toHaveLength(0);
  });

  it('refuses a paused agent — a retained session is not evidence of idle', async () => {
    const agent = spawnAgent('alpha');
    daemon.pauseMember('eng', agent.id);
    await expect(daemon.compactMember('eng', agent.id, owner().id))
      .rejects.toThrow(/only an idle agent can be compacted/);
    expect(fake.compactions).toHaveLength(0);
  });

  it('refuses a non-agent target', async () => {
    const bystander = human('bystander', 'member');
    await expect(daemon.compactMember('eng', bystander.id, owner().id))
      .rejects.toThrow(/no such agent member/);
  });

  it('tells the operator plainly when the harness cannot compact', async () => {
    const agent = spawnAgent('alpha');
    Reflect.deleteProperty(fake, 'compactSession'); // a harness without the capability
    await expect(daemon.compactMember('eng', agent.id, owner().id))
      .rejects.toThrow(/does not support compaction/);
  });

  it('leaves the ring alone when the engine reports no re-baseline', async () => {
    const agent = spawnAgent('alpha');
    fake.compactUsage = undefined;
    const frames: Member[] = [];
    const stop = daemon.onFrame((_room, frame) => {
      if (frame.type === 'member') frames.push(frame.member);
    });
    await daemon.compactMember('eng', agent.id, owner().id);
    stop();
    expect(fake.compactions).toHaveLength(1);
    expect(frames.some((member) => member.lastUsage !== undefined)).toBe(false);
    // Still exactly one completion edge: silence would leave a UI spinning.
    expect(frames.filter((member) => member.id === agent.id)).toHaveLength(1);
  });
});
// harn:end manual-compaction-is-an-operator-act

// harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-daemon-regression
describe('member task projection landing (member-task-projection-is-durable-and-session-scoped)', () => {
  const replace = (id: string, status: string): WireEvent =>
    ({ type: 'run.tasks', update: { op: 'replace', items: [{ id, content: 'Do', status }] } }) as unknown as WireEvent;

  async function emit(handle: string, cwd: string, ...items: WireEvent[]): Promise<string> {
    const member = daemon.spawnMember('eng', { harness: 'fake', handle, cwd });
    fake.enqueue({ kind: 'complete', final_text: 'done', items });
    daemon.postHumanMessage('eng', `@${handle} go`);
    await daemon.settle();
    return member.id;
  }

  it('lands run.tasks on the member and streams a member frame, never a run event', async () => {
    frames = [];
    const id = await emit('planner', testCwd('planner'), replace('a', 'in_progress'));
    expect(daemon.store.getMember('eng', id)?.tasks?.items.map((task) => task.id)).toEqual(['a']);
    expect(frames.some(({ frame }) => frame.type === 'member' && frame.member.id === id && frame.member.tasks?.items.length === 1)).toBe(true);
    expect(frames.some(({ frame }) => frame.type === 'run_event' && (frame.event as { type?: string }).type === 'run.tasks')).toBe(false);
  });

  it('treats an identical duplicate delivery as a no-op', async () => {
    const id = await emit('dup', testCwd('dup'), replace('a', 'pending'), replace('a', 'pending'));
    expect(daemon.store.getMember('eng', id)?.tasks?.items).toEqual([{ id: 'a', content: 'Do', status: 'pending' }]);
  });

  it('preserves the projection across a daemon restart', async () => {
    const id = await emit('keeper', testCwd('keeper'), replace('a', 'completed'));
    await daemon.close();
    const restarted = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'), blobRoot: join(dir, 'blobs'),
      adapters: [new FakeAdapter('fake')], discoverModels: false, homeDir: dir,
    });
    try {
      expect(restarted.store.getMember('eng', id)?.tasks?.items).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });

  it('preserves tasks across a real kill/revive attach and clears on a different native session', async () => {
    const cwd = testCwd('rebinder');
    const alpha = spawnAgent('rebinder', cwd);
    // A turn establishes the native session and lands the checklist.
    fake.enqueue({ kind: 'complete', final_text: 'done', items: [replace('a', 'pending')] });
    daemon.postHumanMessage('eng', '@rebinder go');
    await daemon.settle();
    const sessionRef = daemon.store.getMember('eng', alpha.id)!.session_ref!;
    expect(daemon.store.getMember('eng', alpha.id)?.tasks?.items).toHaveLength(1);

    // Kill then revive: the adapter re-attaches the EXACT persisted native session and
    // the task projection survives (a same-session revive preserves it).
    expect(daemon.killMember('eng', alpha.id).state).toBe('dead');
    fake.enqueue({ kind: 'complete', final_text: 'revived' });
    daemon.reviveMember('eng', alpha.id);
    await daemon.settle();
    expect(fake.wasAttached(sessionRef)).toBe(true);
    expect(daemon.store.getMember('eng', alpha.id)!.state).toBe('idle');
    expect(daemon.store.getMember('eng', alpha.id)?.tasks?.items).toHaveLength(1);

    // A genuinely different native session then clears the projection.
    expect(daemon.store.setAgentSessionRuntime('eng', alpha.id, `${sessionRef}-fresh`, { load: true, resume: true }).tasks).toBeUndefined();
  });
});
// harn:end member-task-projection-is-durable-and-session-scoped

// harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-runtime-lease
describe('explicit member context reset', () => {
  const owner = () => daemon.ownerOf('eng');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  async function establish(handle: string) {
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle, cwd: testCwd(handle), model: 'kept-model',
      policy: 'workspace-write', purpose: 'keep purpose',
    });
    fake.enqueue({
      kind: 'complete', final_text: '<ACK_OK>',
      agent_usage: {
        contextWindowMaxTokens: 1_000_000,
        contextWindowUsedTokens: 125_000,
      },
      items: [{
        type: 'run.tasks',
        update: { op: 'replace', items: [{ id: 'old', content: 'Old task', status: 'pending' }] },
      }],
    });
    daemon.postHumanMessage('eng', `@${handle} establish retained context`);
    await daemon.settle();
    const ready = daemon.store.getMember('eng', agent.id)!;
    expect(ready.session_ref).toBeDefined();
    expect(ready.tasks?.items).toHaveLength(1);
    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBe(1_000_000);
    return ready;
  }

  // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-daemon-regression
  it('retires first, clears session-scoped state without a paid turn, and lazily starts fresh', async () => {
    const agent = await establish('reset-alpha');
    daemon.store.updateMember('eng', agent.id, { misaddressed: true });
    const oldCredential = (daemon.store.db.prepare('SELECT credential_hash FROM members WHERE id = ?')
      .get(agent.id) as { credential_hash: string }).credential_hash;
    const deliveriesBefore = fake.deliveries.length;

    await daemon.clearMemberContext('eng', agent.id, owner().id);

    expect(fake.resets).toHaveLength(1);
    expect(fake.resets[0]?.session_ref).toBe(agent.session_ref);
    expect(fake.deliveries).toHaveLength(deliveriesBefore); // click spent no turn
    const cleared = daemon.store.getMember('eng', agent.id)!;
    expect(cleared).toMatchObject({
      id: agent.id, handle: 'reset-alpha', model: 'kept-model',
      policy: 'workspace-write', purpose: 'keep purpose', state: 'idle',
      misaddressed: true, conventions_sent: false, roster_stale: true,
    });
    expect(cleared.session_ref).toBeUndefined();
    expect(cleared.tasks).toBeUndefined();
    const clearedFrame = frames.map(({ frame }) => frame)
      .filter((frame): frame is Extract<ServerFrame, { type: 'member' }> =>
        frame.type === 'member' && frame.member.id === agent.id)
      .at(-1);
    expect(clearedFrame?.member.lastUsage).toBeUndefined();
    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBeUndefined();
    expect(daemon.store.findAgentByCredentialHash(oldCredential)).toBeUndefined();
    expect(daemon.store.listMessages('eng', { limit: 100 }).some((message) =>
      message.kind === 'system' &&
      message.body.includes("@richard cleared @reset-alpha's native context"))).toBe(true);

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@reset-alpha first fresh delivery');
    await daemon.settle();
    const fresh = daemon.store.getMember('eng', agent.id)!;
    expect(fresh.session_ref).toBeDefined();
    expect(fresh.session_ref).not.toBe(agent.session_ref);
    const newCredential = (daemon.store.db.prepare('SELECT credential_hash FROM members WHERE id = ?')
      .get(agent.id) as { credential_hash: string }).credential_hash;
    expect(newCredential).not.toBe(oldCredential);
    const delivered = fake.deliveries.at(-1)!;
    expect(delivered.payload).toContain('first fresh delivery');
    expect(delivered.payload).toContain('[conventions:');
    expect(delivered.attached).toBe(false);
  });
  // harn:end member-task-projection-is-durable-and-session-scoped

  it('leases turn admission so a delivery arriving during retirement is first on the fresh session', async () => {
    const agent = await establish('reset-lease');
    const oldRef = agent.session_ref;
    const deliveriesBefore = fake.deliveries.length;
    fake.holdResets();
    const reset = daemon.clearMemberContext('eng', agent.id, owner().id);
    await until(() => fake.resets.length === 1 ? true : undefined);

    await expect(daemon.acquireAttachLease('eng', agent.id, process.pid))
      .rejects.toThrow('context is being cleared');
    expect(daemon.store.getAttachLeaseForMember(agent.id)).toBeUndefined();

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@reset-lease queued after lease');
    await tick();
    expect(fake.deliveries).toHaveLength(deliveriesBefore);
    expect(daemon.store.listDeliveries('eng', { recipient: agent.id, state: 'queued' }))
      .toHaveLength(1);

    fake.releaseResets();
    await reset;
    await daemon.settle();
    const delivery = fake.deliveries.at(-1)!;
    expect(delivery.payload).toContain('queued after lease');
    expect(delivery.session_ref).not.toBe(oldRef);
    expect(delivery.attached).toBe(false);
  });

  it('keeps reset and manual compaction mutually exclusive', async () => {
    const resetting = await establish('reset-vs-compact');
    fake.holdResets();
    const reset = daemon.clearMemberContext('eng', resetting.id, owner().id);
    await until(() => fake.resets.length === 1 ? true : undefined);
    await expect(daemon.compactMember('eng', resetting.id, owner().id))
      .rejects.toThrow('context is being cleared');
    fake.releaseResets();
    await reset;

    const compacting = await establish('compact-vs-reset');
    fake.holdCompactions();
    const compaction = daemon.compactMember('eng', compacting.id, owner().id);
    await until(() => fake.compactions.length === 1 ? true : undefined);
    await expect(daemon.clearMemberContext('eng', compacting.id, owner().id))
      .rejects.toThrow('is compacting');
    fake.releaseCompactions();
    await compaction;
  });

  it('preserves durable state when retirement fails and releases the lease', async () => {
    const agent = await establish('reset-fail');
    const before = daemon.store.getMember('eng', agent.id)!;
    const credential = (daemon.store.db.prepare('SELECT credential_hash FROM members WHERE id = ?')
      .get(agent.id) as { credential_hash: string }).credential_hash;
    fake.failNextReset('native retirement failed');

    await expect(daemon.clearMemberContext('eng', agent.id, owner().id))
      .rejects.toThrow('native retirement failed');

    expect(daemon.store.getMember('eng', agent.id)).toMatchObject({
      session_ref: before.session_ref,
      tasks: before.tasks,
      conventions_sent: before.conventions_sent,
      roster_stale: before.roster_stale,
    });
    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBe(1_000_000);
    expect(daemon.store.findAgentByCredentialHash(credential)?.member.id).toBe(agent.id);

    // The finally released admission; ordinary work can still use the old session.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@reset-fail continue old context');
    await daemon.settle();
    expect(fake.deliveries.at(-1)?.session_ref).toBe(before.session_ref);
  });

  it('refuses non-admins, a never-run member, pre-existing backlog, duplicate reset, and unsupported adapters', async () => {
    const memberHuman = daemon.store.addMember('eng', {
      kind: 'human', handle: 'member-human', display_name: 'Member Human', role: 'member',
    });
    const neverRun = spawnAgent('never-run');
    await expect(daemon.clearMemberContext('eng', neverRun.id, owner().id))
      .rejects.toThrow('already has a fresh context');

    const agent = await establish('reset-guards');
    await expect(daemon.clearMemberContext('eng', agent.id, memberHuman.id))
      .rejects.toThrow('only owners and admins');
    daemon.store.updateMember('eng', agent.id, { custody: 'mirrored' });
    await expect(daemon.clearMemberContext('eng', agent.id, owner().id))
      .rejects.toThrow('not switchboard-owned');
    daemon.store.updateMember('eng', agent.id, { custody: 'owned' });

    const source = daemon.store.postMessage('eng', {
      author: owner().id, kind: 'chat', body: 'manual backlog',
    });
    const queued = daemon.store.createDelivery('eng', {
      message_id: source.id, recipient: agent.id, state: 'queued',
    });
    await expect(daemon.clearMemberContext('eng', agent.id, owner().id))
      .rejects.toThrow('has pending delivery');
    daemon.store.updateDelivery('eng', queued.id, { state: 'consumed' });

    fake.holdResets();
    const first = daemon.clearMemberContext('eng', agent.id, owner().id);
    await until(() => fake.resets.length > 0 ? true : undefined);
    await expect(daemon.clearMemberContext('eng', agent.id, owner().id))
      .rejects.toThrow('already being cleared');
    fake.releaseResets();
    await first;

    const unsupported = await establish('reset-unsupported');
    Reflect.deleteProperty(fake, 'resetSession');
    await expect(daemon.clearMemberContext('eng', unsupported.id, owner().id))
      .rejects.toThrow("does not support clearing context");
  });

  it('passes no session to the adapter after restart and still clears the persisted reference', async () => {
    const agent = await establish('reset-restart');
    await daemon.close();
    fake = new FakeAdapter('fake', { interactiveAttach: true });
    daemon = newDaemon();

    await daemon.clearMemberContext('eng', agent.id, daemon.ownerOf('eng').id);

    expect(fake.resets).toEqual([undefined]);
    expect(daemon.store.getMember('eng', agent.id)?.session_ref).toBeUndefined();
  });
});
// harn:end member-context-reset-is-authorized-atomic-and-lazy

// harn:assume current-context-window-truth-outlives-restarts ref=persisted-window-seed
describe('configured model context-window invalidation', () => {
  it('preserves a same-model report and invalidates it only on an actual model change', () => {
    const agent = daemon.spawnMember('eng', {
      harness: 'thinking-fake', handle: 'window-model', cwd: testCwd('window-model'), model: 'old',
    });
    daemon.store.setMemberContextWindow('eng', agent.id, 1_000_000);
    daemon.configureMember('eng', agent.id, { model: 'old' });
    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBe(1_000_000);
    daemon.configureMember('eng', agent.id, { model: 'new' });
    expect(daemon.store.getMemberContextWindow('eng', agent.id)).toBeUndefined();
  });
});
// harn:end current-context-window-truth-outlives-restarts

describe('named ACP providers (detection and command-private launch)', () => {
  // harn:assume named-acp-provider-catalog-is-path-detected-and-command-private ref=acp-provider-catalog-regression
  it('publishes the exact catalog shape and detects named providers by PATH, command-private', async () => {
    const present = new Set<string>();
    const dir = mkdtempSync(join(tmpdir(), 'codor-named-catalog-'));
    const acpDaemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'), blobRoot: join(dir, 'blobs'),
      adapters: [
        Object.assign(new FakeAdapter('codex') as unknown as AcpAdapter, { executable: 'codex' }),
        Object.assign(new AcpAdapter(), { configurable: true }),
      ], homeDir: dir,
      executableOnPath: (executable) => present.has(executable),
      discoverModels: false,
    });
    // A native adapter carries its own id as harness and no ACP transport/advanced flags.
    const native = acpDaemon.registeredAdapters().find((entry) => entry.id === 'codex');
    expect(native).toMatchObject({ id: 'codex', harness: 'codex' });
    expect(native).not.toHaveProperty('transport');
    expect(native).not.toHaveProperty('advanced');
    // The generic ACP transport is the sole Advanced custom-command tile, on harness acp.
    expect(acpDaemon.registeredAdapters().find((entry) => entry.id === 'acp')).toMatchObject({
      id: 'acp', harness: 'acp', configurable: true, transport: 'acp', advanced: true, installed: false,
    });
    const named = () => acpDaemon.registeredAdapters().filter((entry) => entry.acp_provider !== undefined);
    // Startup: both curated providers appear, uninstalled, in stable DEFINITION order.
    expect(named().map((entry) => [entry.id, entry.acp_provider, entry.harness, entry.transport, entry.installed]))
      .toEqual([
        ['acp:kimi', 'kimi', 'acp', 'acp', false],
        ['acp:kilo', 'kilo', 'acp', 'acp', false],
      ]);
    for (const entry of named()) {
      expect(entry).not.toHaveProperty('executable'); // command-private
      expect(entry).not.toHaveProperty('argv');
      expect(entry).not.toHaveProperty('advanced'); // named providers are primary, not Advanced
      expect(entry.capabilities.resume).toBe(false); // conservative generic-ACP capabilities
    }
    // false -> true -> false as the binary appears and disappears; refresh recomputes.
    present.add('kimi');
    acpDaemon.refreshAdapterAvailability();
    expect(named().find((entry) => entry.acp_provider === 'kimi')?.installed).toBe(true);
    present.delete('kimi');
    acpDaemon.refreshAdapterAvailability();
    expect(named().find((entry) => entry.acp_provider === 'kimi')?.installed).toBe(false);
    await acpDaemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // harn:end named-acp-provider-catalog-is-path-detected-and-command-private

  // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-spawn-regression
  it('resolves a detected named provider to a private launch and refuses unknown or stale ids', async () => {
    const present = new Set<string>(['kimi']);
    const dir = mkdtempSync(join(tmpdir(), 'codor-named-spawn-'));
    let acpDaemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'), blobRoot: join(dir, 'blobs'),
      adapters: [Object.assign(new FakeAdapter('acp') as unknown as AcpAdapter, { configurable: true })], homeDir: dir,
      executableOnPath: (executable) => present.has(executable),
      discoverModels: false,
    });
    acpDaemon.createRoom({ id: 'acp', name: 'ACP', owner: { handle: 'owner', display_name: 'Owner' } });

    // Unknown id fails before any member is persisted.
    expect(() => acpDaemon.spawnMember('acp', {
      harness: 'acp', handle: 'ghost', cwd: dir, acp_provider: 'ghost',
    })).toThrow("unknown ACP provider 'ghost'");
    // Stale id (curated but not currently detected) fails before persistence.
    expect(() => acpDaemon.spawnMember('acp', {
      harness: 'acp', handle: 'staly', cwd: dir, acp_provider: 'kilo',
    })).toThrow("ACP provider 'kilo' is not currently installed");
    expect(acpDaemon.store.listMembers('acp').some((m) => m.handle === 'ghost' || m.handle === 'staly')).toBe(false);

    // Detected named id succeeds: public id projected, exact private launch persisted, never leaked.
    const member = acpDaemon.spawnMember('acp', {
      harness: 'acp', handle: 'kimo', cwd: dir, acp_provider: 'kimi',
    });
    expect(acpDaemon.store.getMember('acp', member.id)?.acp_provider).toBe('kimi');
    expect(acpDaemon.store.getMember('acp', member.id)).not.toHaveProperty('acp_launch');
    expect(acpDaemon.store.getAgentRuntimeConfig('acp', member.id)?.acp_launch)
      .toEqual({ executable: 'kimi', argv: ['acp'] });
    await acpDaemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds a named session from its exact persisted private launch and fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-named-rebuild-'));
    const dbPath = join(dir, 'switchboard.sqlite');
    const blobRoot = join(dir, 'blobs');
    // A fake acp adapter that RECORDS the launch it is spawned with; `fail` simulates an
    // unavailable executable so a rebuild can be shown to fail closed.
    const launches: unknown[] = [];
    const makeAdapter = (fail = false) => {
      const adapter = Object.assign(new FakeAdapter('acp'), { configurable: true });
      const original = adapter.spawn.bind(adapter);
      adapter.spawn = (opts) => {
        launches.push(opts.acp_launch);
        if (fail) throw new Error('ACP agent executable is unavailable');
        return original(opts);
      };
      return adapter as unknown as AcpAdapter;
    };

    let acpDaemon = new Daemon({
      dbPath, blobRoot, adapters: [makeAdapter()], homeDir: dir,
      executableOnPath: () => true, discoverModels: false,
    });
    acpDaemon.createRoom({ id: 'acp', name: 'ACP', owner: { handle: 'owner', display_name: 'Owner' } });
    const member = acpDaemon.spawnMember('acp', {
      harness: 'acp', handle: 'kimo', cwd: dir, acp_provider: 'kimi',
    });
    expect(launches.at(-1)).toEqual({ executable: 'kimi', argv: ['acp'] }); // initial spawn
    await acpDaemon.close();

    // Restart: a real turn rebuilds the session and re-passes the EXACT persisted launch.
    launches.length = 0;
    const live = makeAdapter();
    (live as unknown as FakeAdapter).enqueue({ kind: 'complete', final_text: '@richard ready' });
    acpDaemon = new Daemon({
      dbPath, blobRoot, adapters: [live], homeDir: dir,
      executableOnPath: () => true, discoverModels: false,
    });
    acpDaemon.postHumanMessage('acp', '@kimo hello');
    await acpDaemon.settle();
    expect(launches).toContainEqual({ executable: 'kimi', argv: ['acp'] });
    await acpDaemon.close();

    // Fail-closed: the executable is unavailable at rebuild -> spawn throws -> member,
    // provider, and private launch are all left unchanged.
    acpDaemon = new Daemon({
      dbPath, blobRoot, adapters: [makeAdapter(true)], homeDir: dir,
      executableOnPath: () => true, discoverModels: false,
    });
    acpDaemon.postHumanMessage('acp', '@kimo again');
    await acpDaemon.settle();
    expect(acpDaemon.store.getMember('acp', member.id)?.harness).toBe('acp');
    expect(acpDaemon.store.getMember('acp', member.id)?.acp_provider).toBe('kimi');
    expect(acpDaemon.store.getAgentRuntimeConfig('acp', member.id)?.acp_launch)
      .toEqual({ executable: 'kimi', argv: ['acp'] });
    await acpDaemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
});

// harn:assume compaction-reinjects-codor-briefing ref=compaction-reinject-regression
describe('codor briefing re-injection after compaction', () => {
  const owner = () => daemon.ownerOf('eng');
  const compactionCompleted: WireEvent = {
    type: 'timeline',
    item: { type: 'compaction', status: 'completed', trigger: 'auto' },
  };

  // Run one delivery so the first-delivery briefing has already been sent and
  // its gates are closed (conventions_sent=true, roster_stale=false).
  const establishBriefing = async (handle: string) => {
    const agent = spawnAgent(handle);
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', `@${handle} establish context`);
    await daemon.settle();
    const member = daemon.store.getMember('eng', agent.id)!;
    expect(member.conventions_sent).toBe(true);
    expect(member.roster_stale).toBe(false);
    return agent;
  };

  it('re-arms and re-injects the briefing after an auto-compaction consumed by an active turn', async () => {
    const agent = await establishBriefing('compact-alpha');

    // The compaction boundary rides the live deliver() iterator of an active
    // turn — exactly how auto-compaction surfaces for both runtimes.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>', items: [compactionCompleted] });
    daemon.postHumanMessage('eng', '@compact-alpha do work');
    await daemon.settle();

    const rearmed = daemon.store.getMember('eng', agent.id)!;
    expect(rearmed.conventions_sent).toBe(false);
    expect(rearmed.roster_stale).toBe(true);

    // The very next delivery carries the full briefing again.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@compact-alpha follow up');
    await daemon.settle();
    const followup = fake.deliveries.at(-1)!.payload;
    expect(followup).toContain('[conventions:');
    expect(followup).toContain('[roster:');

    // Gates close again after the re-injected delivery.
    const settled = daemon.store.getMember('eng', agent.id)!;
    expect(settled.conventions_sent).toBe(true);
    expect(settled.roster_stale).toBe(false);
  });

  it('leaves the briefing gates closed for a normal turn with no compaction', async () => {
    const agent = await establishBriefing('compact-normal');

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@compact-normal ordinary work');
    await daemon.settle();

    const member = daemon.store.getMember('eng', agent.id)!;
    expect(member.conventions_sent).toBe(true);
    expect(member.roster_stale).toBe(false);
    expect(fake.deliveries.at(-1)!.payload).not.toContain('[conventions:');
  });

  it('re-arms and re-injects after an operator manual compaction', async () => {
    const agent = await establishBriefing('compact-beta');

    await daemon.compactMember('eng', agent.id, owner().id);
    const rearmed = daemon.store.getMember('eng', agent.id)!;
    expect(rearmed.conventions_sent).toBe(false);
    expect(rearmed.roster_stale).toBe(true);

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@compact-beta after compaction');
    await daemon.settle();
    expect(fake.deliveries.at(-1)!.payload).toContain('[conventions:');
  });

  it('preserves a concurrently raised misaddress flag through the re-arm', async () => {
    const agent = await establishBriefing('compact-gamma');
    // Simulate a misaddress raised concurrently with the compaction. The manual
    // path re-arms without an intervening delivery, so nothing consumes the
    // flag — proving the re-arm itself never clears misaddressed.
    daemon.store.updateMember('eng', agent.id, { misaddressed: true });

    await daemon.compactMember('eng', agent.id, owner().id);

    const member = daemon.store.getMember('eng', agent.id)!;
    expect(member.misaddressed).toBe(true);
    expect(member.conventions_sent).toBe(false);
    expect(member.roster_stale).toBe(true);
  });

  it('re-injects exactly once for repeated compactions before the next delivery', async () => {
    const agent = await establishBriefing('compact-repeat');

    // Two completed boundaries in one turn — the re-arm is idempotent.
    fake.enqueue({
      kind: 'complete',
      final_text: '<ACK_OK>',
      items: [compactionCompleted, compactionCompleted],
    });
    daemon.postHumanMessage('eng', '@compact-repeat churn');
    await daemon.settle();
    expect(daemon.store.getMember('eng', agent.id)!.conventions_sent).toBe(false);

    // First delivery after the repeated compactions re-injects.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@compact-repeat first');
    await daemon.settle();
    expect(fake.deliveries.at(-1)!.payload).toContain('[conventions:');

    // The delivery after that does not — the briefing was consumed once.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@compact-repeat second');
    await daemon.settle();
    expect(fake.deliveries.at(-1)!.payload).not.toContain('[conventions:');
  });

  it('does not re-arm when the manual compaction fails', async () => {
    const agent = await establishBriefing('compact-fail');
    fake.compactSession = async () => {
      throw new Error('engine compaction failed');
    };

    await expect(daemon.compactMember('eng', agent.id, owner().id))
      .rejects.toThrow(/engine compaction failed/);

    const member = daemon.store.getMember('eng', agent.id)!;
    expect(member.conventions_sent).toBe(true);
    expect(member.roster_stale).toBe(false);
  });

  it('preserves the re-armed briefing flags across kill and revive', async () => {
    const agent = await establishBriefing('compact-revive');
    await daemon.compactMember('eng', agent.id, owner().id);
    expect(daemon.store.getMember('eng', agent.id)!.conventions_sent).toBe(false);

    expect(daemon.killMember('eng', agent.id).state).toBe('dead');
    daemon.reviveMember('eng', agent.id);

    const member = daemon.store.getMember('eng', agent.id)!;
    expect(member.conventions_sent).toBe(false);
    expect(member.roster_stale).toBe(true);
  });
});
// harn:end compaction-reinjects-codor-briefing

// harn:assume manual-compaction-leases-out-turn-admission ref=compaction-lease-regression
describe('manual compaction leases out turn admission', () => {
  const owner = () => daemon.ownerOf('eng');

  // One delivery so the first-delivery briefing has been sent and its gates are
  // closed (conventions_sent=true), matching a real member mid-conversation.
  const establishBriefing = async (handle: string) => {
    const agent = spawnAgent(handle);
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', `@${handle} establish context`);
    await daemon.settle();
    expect(daemon.store.getMember('eng', agent.id)!.conventions_sent).toBe(true);
    return agent;
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('defers a delivery during a held compaction, then delivers it with the re-injected briefing', async () => {
    const agent = await establishBriefing('lease-alpha');

    fake.holdCompactions();
    const compaction = daemon.compactMember('eng', agent.id, owner().id);

    // A delivery landing while the compaction is held must be deferred: queued,
    // no turn started, nothing handed to the engine.
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@lease-alpha work during compaction');
    await tick();
    expect(daemon.store.listDeliveries('eng', { recipient: agent.id, state: 'queued' })).toHaveLength(1);
    expect(fake.deliveries.some((d) => d.payload.includes('work during compaction'))).toBe(false);
    expect(daemon.store.getMember('eng', agent.id)!.state).not.toBe('running');

    // Release: the compaction re-arms the briefing, then the finally admits the
    // deferred delivery — which therefore carries the fresh briefing.
    fake.releaseCompactions();
    await compaction;
    await daemon.settle();

    const delivered = fake.deliveries.find((d) => d.payload.includes('work during compaction'));
    expect(delivered).toBeDefined();
    expect(delivered!.payload).toContain('[conventions:');
    expect(delivered!.payload).toContain('[roster:');
  });

  it('does not start a turn while a compaction is held', async () => {
    const agent = await establishBriefing('lease-beta');
    const deliveriesBefore = fake.deliveries.length;

    fake.holdCompactions();
    const compaction = daemon.compactMember('eng', agent.id, owner().id);

    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@lease-beta racing turn');
    await tick();
    // No turn was admitted: the engine saw no new delivery and the member never
    // went running.
    expect(fake.deliveries).toHaveLength(deliveriesBefore);
    expect(daemon.store.getMember('eng', agent.id)!.state).not.toBe('running');

    fake.releaseCompactions();
    await compaction;
    await daemon.settle();
    expect(fake.deliveries.length).toBeGreaterThan(deliveriesBefore);
  });

  it('releases the lease and admits deferred work without a briefing when the compaction fails', async () => {
    const agent = await establishBriefing('lease-gamma');
    let rejectCompaction: (reason: Error) => void = () => undefined;
    fake.compactSession = () => new Promise((_, reject) => { rejectCompaction = reject; });

    const compaction = daemon.compactMember('eng', agent.id, owner().id).catch((e: unknown) => e);
    fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>' });
    daemon.postHumanMessage('eng', '@lease-gamma queued during failing compaction');
    await tick();
    expect(fake.deliveries.some((d) => d.payload.includes('queued during failing compaction'))).toBe(false);

    rejectCompaction(new Error('engine compaction failed'));
    const result = await compaction;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/engine compaction failed/);
    await daemon.settle();

    // Lease released → the deferred delivery is admitted. No compaction happened,
    // so conventions_sent stays true and the delivery carries no briefing.
    const delivered = fake.deliveries.find((d) => d.payload.includes('queued during failing compaction'));
    expect(delivered).toBeDefined();
    expect(delivered!.payload).not.toContain('[conventions:');
    expect(daemon.store.getMember('eng', agent.id)!.conventions_sent).toBe(true);
  });

  it('refuses a second compaction while one is already pending', async () => {
    const agent = await establishBriefing('lease-delta');
    fake.holdCompactions();
    const first = daemon.compactMember('eng', agent.id, owner().id);

    await expect(daemon.compactMember('eng', agent.id, owner().id))
      .rejects.toThrow(/already compacting/);

    fake.releaseCompactions();
    await first;
  });
});
// harn:end manual-compaction-leases-out-turn-admission
// harn:assume interaction-recorrelation-keys-on-semantic-identity-with-detail ref=interaction-recorrelation-regression
describe('interaction re-correlation keys on semantic identity with detail', () => {
  it('distinguishes cards by detail and ignores the native id', () => {
    const base = {
      kind: 'approval' as const,
      prompt: 'Allow Codex to run a command?',
      options: [{ label: 'allow once' }, { label: 'deny' }],
      tool: 'shell',
    };
    const a = interactionKey('approval', { ...base, interaction_id: 'n1', detail: 'rm -rf a' });
    const b = interactionKey('approval', { ...base, interaction_id: 'n2', detail: 'rm -rf b' });
    // Different command detail -> different key -> two concurrent cards never coalesce.
    expect(a).not.toBe(b);
    // Same semantic card, DIFFERENT native id -> same key -> a crash re-raise still
    // re-correlates to the same row.
    const sameA = interactionKey('approval', { ...base, interaction_id: 'n3', detail: 'rm -rf a' });
    expect(sameA).toBe(a);
  });

  it('re-correlates a pending approval re-raised with a fresh native id (same row, count 1)', async () => {
    const alpha = spawnAgent('recorrelate-approval');
    const card = {
      kind: 'approval' as const,
      prompt: 'Allow Codex to run a command?',
      tool: 'shell',
      detail: 'curl https://example.com',
      options: [{ label: 'allow once' }, { label: 'deny' }],
    };
    fake.enqueue({ kind: 'ask', card, reply: (a) => `did ${String(a)}` });
    daemon.postHumanMessage('eng', '@recorrelate-approval please');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    const nativeBefore = interaction.native_id;
    await daemon.close({ force: true }); // crash the blocked run

    daemon = newDaemon();
    fake.enqueue({ kind: 'ask', card, reply: (a) => `did ${String(a)}` });
    await daemon.reconcile();

    const recorrelated = await until(() => {
      const i = daemon.store.getInteraction(interaction.id);
      return i && i.native_id !== nativeBefore ? i : undefined;
    });
    expect(recorrelated.state).toBe('pending');
    // Exactly one row survived: detail-in-key did not break crash re-correlation.
    expect(daemon.store.listInteractions('eng').filter((i) => i.member_id === alpha.id)).toHaveLength(1);
  });

  it('orphans a leftover approval card when its run finalizes without re-raising', async () => {
    const alpha = spawnAgent('orphan-approval');
    fake.enqueue({
      kind: 'ask',
      card: {
        kind: 'approval',
        prompt: 'Allow Codex to run a command?',
        tool: 'shell',
        detail: 'make deploy',
        options: [{ label: 'allow once' }, { label: 'deny' }],
      },
      reply: (a) => `did ${String(a)}`,
    });
    daemon.postHumanMessage('eng', '@orphan-approval please');
    const interaction = await until(() =>
      daemon.store.listInteractions('eng', 'pending').find((i) => i.member_id === alpha.id),
    );
    await daemon.close({ force: true });

    daemon = newDaemon();
    // The retried turn does NOT re-raise the approval; it just completes.
    fake.enqueue({ kind: 'complete', final_text: 'done without asking' });
    await daemon.reconcile();
    await daemon.settle();

    expect(await until(() => {
      const i = daemon.store.getInteraction(interaction.id);
      return i && i.state === 'orphaned' ? i : undefined;
    })).toBeDefined();
  });

  it('two simultaneous elicitations with distinct elicitationId do not coalesce', async () => {
    const alpha = spawnAgent('elicit-concurrent');
    const base = {
      kind: 'approval' as const,
      prompt: 'MCP server “acme-mcp” asks you to open a link',
      tool: 'mcp_elicitation',
      options: [{ label: 'mark completed' }, { label: 'decline' }],
    };
    // Identical prompt/tool/options; the ONLY difference is the elicitationId in
    // the semantic detail. The daemon must keep them as two distinct rows.
    fake.enqueue({
      kind: 'multi_ask',
      cards: [
        { ...base, detail: 'acme-mcp · https://a.example/one · elic-1' },
        { ...base, detail: 'acme-mcp · https://a.example/two · elic-2' },
      ],
      reply: () => 'both handled',
    });
    daemon.postHumanMessage('eng', '@elicit-concurrent please');
    const pendings = await until(() => {
      const list = daemon.store.listInteractions('eng', 'pending').filter((i) => i.member_id === alpha.id);
      return list.length === 2 ? list : undefined;
    });
    expect(pendings).toHaveLength(2);
    expect(new Set(pendings.map((i) => i.message_id)).size).toBe(2);
    for (const pending of pendings) await daemon.answerInteraction('eng', pending.id, 'mark completed');
    await daemon.settle();
  });
});
// harn:end interaction-recorrelation-keys-on-semantic-identity-with-detail

// harn:assume child-members-own-isolated-runtime ref=conversation-runtime-isolation-regression
describe('registered child conversations own isolated agent runtime', () => {
  it('keeps sessions, credentials, tasks, usage, and restart state room-local', async () => {
    const childResult = daemon.store.registerWorktree(
      'eng',
      {
        common_path: join(dir, 'runtime-repository', '.git'),
        primary_path: join(dir, 'runtime-repository'),
        primary_git_admin_id: join(dir, 'runtime-repository', '.git'),
      },
      {
        path: join(dir, 'runtime-repository'),
        git_admin_id: join(dir, 'runtime-repository', '.git'),
        primary: true,
        availability: 'available',
        locked: false,
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
      },
      {
        path: join(dir, 'runtime-child'),
        git_admin_id: join(dir, 'runtime-repository', '.git', 'worktrees', 'runtime-child'),
        primary: false,
        availability: 'available',
        locked: false,
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'feature/runtime-child',
      },
      'runtime-child',
      'adopted',
    );
    const child = childResult.worktree.conversation_id;
    const sessions: Session[] = [];
    const originalSpawn = fake.spawn.bind(fake);
    const spawnSpy = vi.spyOn(fake, 'spawn').mockImplementation((opts: SpawnOpts) => {
      const session = originalSpawn(opts);
      sessions.push(session);
      return session;
    });

    const main = daemon.spawnMember('eng', {
      harness: 'fake',
      handle: 'same-runtime-handle',
      cwd: testCwd('runtime-main'),
    });
    const secondary = daemon.spawnMember(child, {
      harness: 'fake',
      handle: 'same-runtime-handle',
      cwd: testCwd('runtime-child'),
    });
    spawnSpy.mockRestore();

    expect(main.id).not.toBe(secondary.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      cwd: join(dir, 'cwd', 'runtime-main'),
      env: { CODOR_CHANNEL: 'eng', CODOR_MEMBER_ID: main.id },
    });
    expect(sessions[1]).toMatchObject({
      cwd: join(dir, 'cwd', 'runtime-child'),
      env: { CODOR_CHANNEL: child, CODOR_MEMBER_ID: secondary.id },
    });
    const mainToken = sessions[0]!.env!.CODOR_MEMBER_TOKEN!;
    const childToken = sessions[1]!.env!.CODOR_MEMBER_TOKEN!;
    expect(childToken).not.toBe(mainToken);
    expect(daemon.authenticateAgentToken(mainToken)).toMatchObject({ room: 'eng', member: { id: main.id } });
    expect(daemon.authenticateAgentToken(childToken)).toMatchObject({ room: child, member: { id: secondary.id } });
    expect(daemon.store.listMembers(child).filter((member) => member.kind === 'agent'))
      .toEqual([expect.objectContaining({ id: secondary.id, handle: 'same-runtime-handle' })]);

    daemon.store.applyMemberTaskUpdate('eng', main.id, {
      op: 'replace', items: [{ id: 'main-task', content: 'Main task', status: 'pending' }],
    });
    daemon.store.applyMemberTaskUpdate(child, secondary.id, {
      op: 'replace', items: [{ id: 'child-task', content: 'Child task', status: 'in_progress' }],
    });
    const mainUsage = {
      inputTokens: 11,
      outputTokens: 3,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 40_000,
    } as const;
    const childUsage = {
      inputTokens: 22,
      outputTokens: 6,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 80_000,
    } as const;
    fake.enqueue({ kind: 'complete', final_text: 'main runtime', agent_usage: mainUsage });
    daemon.postHumanMessage('eng', '@same-runtime-handle main turn');
    await daemon.settle();
    fake.enqueue({ kind: 'complete', final_text: 'child runtime', agent_usage: childUsage });
    daemon.postHumanMessage(child, '@same-runtime-handle child turn');
    await daemon.settle();

    const mainMeterBefore = daemon.store.getMeter('eng', '2026-08-06');
    const childMeterBefore = daemon.store.getMeter(child, '2026-08-06');
    daemon.store.bumpMeter('eng', '2026-08-06', { turns: 1, input_tokens: 11 });
    daemon.store.bumpMeter(child, '2026-08-06', { turns: 2, output_tokens: 22 });
    const mainMeter = daemon.store.getMeter('eng', '2026-08-06')!;
    const childMeter = daemon.store.getMeter(child, '2026-08-06')!;
    expect(mainMeter.turns - (mainMeterBefore?.turns ?? 0)).toBe(1);
    expect(mainMeter.input_tokens - (mainMeterBefore?.input_tokens ?? 0)).toBe(11);
    expect(childMeter.turns - (childMeterBefore?.turns ?? 0)).toBe(2);
    expect(childMeter.output_tokens - (childMeterBefore?.output_tokens ?? 0)).toBe(22);

    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === main.id)?.member.lastUsage)
      .toEqual(mainUsage);
    expect(daemon.memberDetails(child).find((detail) => detail.member.id === secondary.id)?.member.lastUsage)
      .toEqual(childUsage);
    expect(daemon.store.getMember('eng', main.id)?.tasks?.items).toEqual([
      { id: 'main-task', content: 'Main task', status: 'pending' },
    ]);
    expect(daemon.store.getMember(child, secondary.id)?.tasks?.items).toEqual([
      { id: 'child-task', content: 'Child task', status: 'in_progress' },
    ]);
    expect(daemon.store.getMeter('eng', '2026-08-06')).toEqual(mainMeter);
    expect(daemon.store.getMeter(child, '2026-08-06')).toEqual(childMeter);
    expect(daemon.store.listMessages('eng').map((message) => message.body)).toContain('main runtime');
    expect(daemon.store.listMessages(child).map((message) => message.body)).toContain('child runtime');
    expect(daemon.store.listMessages('eng').map((message) => message.body)).not.toContain('child runtime');
    expect(daemon.store.listMessages(child).map((message) => message.body)).not.toContain('main runtime');

    await daemon.close({ force: true });
    frames = [];
    daemon = newDaemon();
    expect(daemon.store.getMember('eng', main.id)?.tasks?.items).toEqual([
      { id: 'main-task', content: 'Main task', status: 'pending' },
    ]);
    expect(daemon.store.getMember(child, secondary.id)?.tasks?.items).toEqual([
      { id: 'child-task', content: 'Child task', status: 'in_progress' },
    ]);
    expect(daemon.store.getMeter('eng', '2026-08-06')).toEqual(mainMeter);
    expect(daemon.store.getMeter(child, '2026-08-06')).toEqual(childMeter);
    expect(daemon.memberDetails('eng').find((detail) => detail.member.id === main.id)?.member)
      .not.toHaveProperty('lastUsage');
    expect(daemon.memberDetails(child).find((detail) => detail.member.id === secondary.id)?.member)
      .not.toHaveProperty('lastUsage');
  });
});
// harn:end child-members-own-isolated-runtime

const registerQualifiedFixture = (alias: string, childName: string) => {
  const result = daemon.store.registerWorktree(
    'eng',
    {
      common_path: join(dir, 'qualified-repository', '.git'),
      primary_path: join(dir, 'qualified-repository'),
      primary_git_admin_id: join(dir, 'qualified-repository', '.git'),
    },
    {
      path: join(dir, 'qualified-repository'),
      git_admin_id: join(dir, 'qualified-repository', '.git'),
      primary: true,
      availability: 'available',
      locked: false,
      branch: 'main',
    },
    {
      path: join(dir, childName),
      git_admin_id: join(dir, 'qualified-repository', '.git', 'worktrees', childName),
      primary: false,
      availability: 'available',
      locked: false,
      branch: `feature/${childName}`,
    },
    alias,
    'adopted',
  );
  return result.worktree;
};

// harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-turn-orchestration-regression
// harn:assume cross-worktree-runtime-stays-target-local ref=cross-worktree-runtime-regression
// harn:assume target-member-turns-serialize-across-origins ref=cross-origin-turn-scheduler-regression
describe('qualified target orchestration', () => {
  it('keeps foreign output in the origin, runs the target home, and serializes origins', async () => {
    const targetWorktree = registerQualifiedFixture('target-a', 'target-a');
    const originWorktree = registerQualifiedFixture('origin-b', 'origin-b');
    const targetRoom = targetWorktree.conversation_id;
    const originRoom = originWorktree.conversation_id;
    let targetSession: Session | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    const spawnSpy = vi.spyOn(fake, 'spawn').mockImplementationOnce((opts: SpawnOpts) => {
      targetSession = originalSpawn(opts);
      return targetSession;
    });
    const target = daemon.spawnMember(targetRoom, {
      harness: 'fake', handle: 'same-target', cwd: testCwd('qualified-target-home'),
    });
    spawnSpy.mockRestore();
    const targetToken = targetSession?.env?.CODOR_MEMBER_TOKEN;
    if (!targetSession || !targetToken) throw new Error('target fixture did not receive a session token');

    fake.enqueue(
      { kind: 'complete', final_text: 'first target answer', delay_ms: 35 },
      { kind: 'complete', final_text: 'second target answer' },
    );
    const first = daemon.postHumanMessage('eng', '~target-a:@same-target first request');
    await until(() => fake.deliveries.length === 1 ? true : undefined);
    expect(targetSession.env?.CODOR_CHANNEL).toBe('eng');
    const activeTargetToken = targetSession.env?.CODOR_MEMBER_TOKEN;
    expect(activeTargetToken).toBeDefined();
    expect(daemon.authenticateAgentToken(activeTargetToken!)).toMatchObject({
      room: 'eng', homeRoom: targetRoom, member: { id: target.id },
      invocation: { originRoom: 'eng', targetRoom },
    });
    expect(fake.deliveries[0]?.cwd).toBe(testCwd('qualified-target-home'));
    expect(fake.deliveries[0]?.payload).toContain('channel=eng');

    const second = daemon.postHumanMessage(originRoom, '~target-a:@same-target second request');
    expect(second.room).toBe(originRoom);
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(2);
    expect(fake.maxConcurrent).toBe(1);
    expect(fake.steers).toHaveLength(0);
    expect(fake.deliveries.map((delivery) => delivery.payload.match(/channel=([^ ]+)/)?.[1]))
      .toEqual(['eng', originRoom]);
    expect(targetSession.env?.CODOR_CHANNEL).toBe(targetRoom);
    expect(daemon.authenticateAgentToken(activeTargetToken!)).toBeUndefined();

    const firstRun = daemon.store.listRunMessages('eng', { author: target.id, limit: 10 })[0]!;
    expect(firstRun.author_target).toMatchObject({
      worktree_id: targetWorktree.id,
      conversation_id: targetRoom,
      member_id: target.id,
      alias: 'target-a',
      handle: 'same-target',
    });
    expect(daemon.store.listMessages('eng').map((message) => message.body))
      .toContain('first target answer');
    expect(daemon.store.listMessages(originRoom).map((message) => message.body))
      .toContain('second target answer');
    expect(daemon.store.listMessages(targetRoom).map((message) => message.body))
      .not.toContain('first target answer');
    expect(daemon.store.listMessages(targetRoom).map((message) => message.body))
      .not.toContain('second target answer');
    expect(first.body).toBe('~target-a:@same-target first request');
  });

  it('keeps mixed local and qualified ingress in one origin-owned collaboration group', async () => {
    const targetWorktree = registerQualifiedFixture('mixed-target', 'mixed-target');
    const local = spawnAgent('mixed-local');
    const remote = daemon.spawnMember(targetWorktree.conversation_id, {
      harness: 'fake', handle: 'mixed-remote', cwd: testCwd('mixed-remote'),
    });
    daemon.pauseMember('eng', local.id);
    daemon.pauseMember(targetWorktree.conversation_id, remote.id);

    const root = daemon.postHumanMessage('eng', '@mixed-local ~mixed-target:@mixed-remote compare scopes');
    const deliveries = daemon.store.listDeliveries('eng').filter((delivery) => delivery.message_id === root.id);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((delivery) => delivery.group_id)).size).toBe(1);
    expect(deliveries.find((delivery) => delivery.recipient === local.id)?.target).toBeUndefined();
    expect(deliveries.find((delivery) => delivery.recipient === remote.id)?.target).toMatchObject({
      conversation_id: targetWorktree.conversation_id,
      alias: 'mixed-target',
      handle: 'mixed-remote',
    });
    expect(daemon.store.getCollaborationGroupByRoot('eng', root.id)?.room).toBe('eng');
    await daemon.settle();
  });

  it('starts an origin-owned group from a foreign author with mixed target scopes', async () => {
    const authorWorktree = registerQualifiedFixture('foreign-author', 'foreign-author');
    const peerWorktree = registerQualifiedFixture('foreign-peer', 'foreign-peer');
    const author = daemon.spawnMember(authorWorktree.conversation_id, {
      harness: 'fake', handle: 'foreign-author', cwd: testCwd('foreign-author'),
    });
    const localTarget = daemon.spawnMember(authorWorktree.conversation_id, {
      harness: 'fake', handle: 'author-peer', cwd: testCwd('author-peer'),
    });
    const foreignTarget = daemon.spawnMember(peerWorktree.conversation_id, {
      harness: 'fake', handle: 'foreign-peer', cwd: testCwd('foreign-peer'),
    });
    daemon.pauseMember(authorWorktree.conversation_id, localTarget.id);
    daemon.pauseMember(peerWorktree.conversation_id, foreignTarget.id);
    fake.enqueue({
      kind: 'complete',
      final_text: '@author-peer ~foreign-peer:@foreign-peer compare the two scopes',
    });

    daemon.postHumanMessage('eng', '~foreign-author:@foreign-author produce a scoped group');
    await daemon.settle();

    const result = runMessages().find((message) => message.author === author.id)!;
    const group = daemon.store.getCollaborationGroupByRoot('eng', result.id)!;
    const participants = daemon.store.listCollaborationParticipants('eng', group.id, 1);
    expect(group.room).toBe('eng');
    expect(daemon.store.getMessage('eng', result.id)?.author_target).toMatchObject({
      worktree_id: authorWorktree.id,
      conversation_id: authorWorktree.conversation_id,
      alias: 'foreign-author',
      member_id: author.id,
    });
    expect(participants.map((participant) => participant.member_id)).toEqual([
      localTarget.id, foreignTarget.id,
    ]);
    const deliveries = participants.map((participant) =>
      daemon.store.getDelivery('eng', participant.delivery_id)!);
    expect(deliveries.map((delivery) => delivery.target?.alias)).toEqual([
      'foreign-author', 'foreign-peer',
    ]);
    const payloads = deliveries.map((delivery) =>
      JSON.parse(daemon.store.getDeliveryPayloadSnapshot('eng', delivery.id)!).payload as string);
    expect(payloads[0]).toContain(`group request #${String(result.id)} - ~foreign-author:@foreign-author`);
    expect(payloads[0]).toContain('@author-peer');
    expect(payloads[0]).toContain('~foreign-peer:@foreign-peer');
    expect(payloads[0]).toContain('[group routing:');
    expect(payloads[1]).toBe(payloads[0].replace('you=@author-peer', 'you=@foreign-peer'));
  });

  it('routes a child-origin onward mention to the registered main target', async () => {
    const targetWorktree = registerQualifiedFixture('child-origin', 'child-origin');
    const childRoom = targetWorktree.conversation_id;
    const remote = daemon.spawnMember(childRoom, {
      harness: 'fake', handle: 'child-agent', cwd: testCwd('child-agent'),
    });
    const main = spawnAgent('main-agent');
    daemon.pauseMember('eng', main.id);

    const root = daemon.postHumanMessage(childRoom, '~main:@main-agent please answer in the root');
    const delivery = daemon.store.listDeliveries(childRoom, { recipient: main.id })[0];
    expect(root.room).toBe(childRoom);
    expect(delivery).toMatchObject({
      room: childRoom,
      recipient: main.id,
      target: {
        conversation_id: 'eng',
        alias: 'main',
        handle: 'main-agent',
      },
    });
    expect(daemon.store.listDeliveries('eng', { recipient: main.id })).toEqual([]);
    expect(remote.kind).toBe('agent');
    await daemon.settle();
  });

  it('settles a queued target after unregister without fallback or adapter execution', async () => {
    const worktree = registerQualifiedFixture('stale-queued', 'stale-queued');
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'stale-queued-agent', cwd: testCwd('stale-queued-agent'),
    });
    daemon.pauseMember(worktree.conversation_id, target.id);
    const root = daemon.postHumanMessage('eng', '~stale-queued:@stale-queued-agent queued once');
    const delivery = daemon.store.listDeliveries('eng', { recipient: target.id })
      .find((candidate) => candidate.message_id === root.id)!;
    expect(delivery.state).toBe('queued');

    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T00:10:00.000Z');
    await daemon.maybeStartTurn(worktree.conversation_id, target.id);

    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(runMessages().some((message) => message.author === target.id)).toBe(false);
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.listMessages('eng').some((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toBe(true);
  });

  it('refuses a held target after unregister instead of releasing it to a fallback', () => {
    const worktree = registerQualifiedFixture('stale-held', 'stale-held');
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'stale-held-agent', cwd: testCwd('stale-held-agent'),
    });
    daemon.pauseMember(worktree.conversation_id, target.id);
    const root = daemon.postHumanMessage('eng', '~stale-held:@stale-held-agent hold once');
    const delivery = daemon.store.listDeliveries('eng', { recipient: target.id })
      .find((candidate) => candidate.message_id === root.id)!;
    daemon.holdDelivery('eng', delivery.id, 'test hold');
    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T00:11:00.000Z');

    daemon.releaseHold('eng', delivery.id);

    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(fake.deliveries).toHaveLength(0);
  });

  it('settles a recovered delivering target before restart can re-run it', async () => {
    const worktree = registerQualifiedFixture('stale-recovered', 'stale-recovered');
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'stale-recovered-agent', cwd: testCwd('stale-recovered-agent'),
    });
    const owner = daemon.ownerOf('eng');
    const trigger = daemon.store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '~stale-recovered:@stale-recovered-agent recover once',
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: trigger.id, recipient: target.id,
      target: {
        worktree_id: worktree.id, conversation_id: worktree.conversation_id,
        member_id: target.id, alias: 'stale-recovered', handle: target.handle,
      },
    });
    const run = daemon.store.postMessage('eng', {
      author: target.id,
      author_target: delivery.target,
      kind: 'run', body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:12:00.000Z',
        tool_calls: 0, events_ref: `runs/${String(trigger.id)}.jsonl`,
      },
    });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: 'delivering', run_msg_id: run.id, attempt_count: 1,
    });
    daemon.store.updateMember(worktree.conversation_id, target.id, { state: 'running' });
    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T00:13:00.000Z');

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.listMessages('eng').some((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toBe(true);
  });

  it('closes a group atomically when one result contains invalid qualified intent', async () => {
    const alpha = spawnAgent('atomic-invalid-alpha');
    const beta = spawnAgent('atomic-invalid-beta');
    const gamma = spawnAgent('atomic-invalid-gamma');
    daemon.pauseMember('eng', gamma.id);
    fake.enqueue(
      { kind: 'complete', final_text: '~missing:@atomic-invalid-gamma and @atomic-invalid-gamma' },
      { kind: 'complete', final_text: '@atomic-invalid-gamma valid sibling intent' },
    );

    const root = daemon.postHumanMessage(
      'eng', '@atomic-invalid-alpha @atomic-invalid-beta compare atomically',
    );
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    expect(group.state).toBe('completed');
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('closed');
    expect(daemon.store.listCollaborationParticipants('eng', group.id, 1)
      .every((participant) => participant.terminal_status !== undefined)).toBe(true);
    expect(daemon.store.listDeliveries('eng', { recipient: gamma.id })).toEqual([]);
    expect(daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(1);
  });

  it('persists exactly one barrier refusal across repeated advancement and restart', async () => {
    const alpha = spawnAgent('barrier-refusal-alpha');
    const beta = spawnAgent('barrier-refusal-beta');
    const gamma = spawnAgent('barrier-refusal-gamma');
    daemon.pauseMember('eng', gamma.id);
    fake.enqueue(
      { kind: 'complete', final_text: '~missing:@barrier-refusal-gamma invalid scoped intent' },
      { kind: 'complete', final_text: 'beta clean result' },
    );

    const root = daemon.postHumanMessage(
      'eng',
      '@barrier-refusal-alpha @barrier-refusal-beta compare refusal durability',
    );
    await daemon.settle();

    const group = daemon.store.getCollaborationGroupByRoot('eng', root.id)!;
    const refusals = () =>
      daemon.store.listMessages('eng').filter((message) =>
        message.kind === 'system' && message.body.includes('qualified target refused'));
    expect(group.state).toBe('completed');
    expect(refusals()).toHaveLength(1);
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('closed');
    expect(daemon.store.listDeliveries('eng', { recipient: gamma.id })).toEqual([]);
    expect(fake.deliveries).toHaveLength(2);

    // A restart repeats the barrier advancement over durable state: the
    // refusal can neither be lost nor duplicated, and no next round appears.
    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(refusals()).toHaveLength(1);
    expect(daemon.store.listCollaborationRounds('eng', group.id)).toHaveLength(1);
    expect(daemon.store.getCollaborationRound('eng', group.id, 1)?.state).toBe('closed');
    expect(daemon.store.getCollaborationGroup('eng', group.id)?.state).toBe('completed');
    expect(daemon.store.listDeliveries('eng', { recipient: gamma.id })).toEqual([]);
    expect(fake.deliveries).toHaveLength(2);
  });

  it('drains a legacy foreign-repository row before the valid same-target batch', async () => {
    const worktree = registerQualifiedFixture('fifo-target', 'fifo-target');
    const targetRoom = worktree.conversation_id;
    const target = daemon.spawnMember(targetRoom, {
      harness: 'fake', handle: 'fifo-agent', cwd: testCwd('fifo-agent'),
    });
    // A second repository tree: a queued row living there can never validate
    // an eng target against itself.
    daemon.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const opsMain = {
      path: join(dir, 'ops-repo'), git_admin_id: join(dir, 'ops-repo', '.git'),
      primary: true, availability: 'available' as const, locked: false, branch: 'main',
    };
    const opsSecondary = {
      path: join(dir, 'ops-child'), git_admin_id: join(dir, 'ops-repo', '.git', 'worktrees', 'ops-child'),
      primary: false, availability: 'available' as const, locked: false, branch: 'feature/ops-child',
    };
    daemon.store.registerWorktree('ops', {
      common_path: join(dir, 'ops-repo', '.git'), primary_path: opsMain.path,
      primary_git_admin_id: opsMain.git_admin_id,
    }, opsMain, opsSecondary, 'ops-child', 'adopted');
    const engTarget = {
      worktree_id: worktree.id, conversation_id: targetRoom,
      member_id: target.id, alias: 'fifo-target', handle: target.handle,
    } as const;
    // The legacy row sits AHEAD of the valid row in the target FIFO.
    const legacyMessage = daemon.store.postMessage('ops', {
      author: daemon.store.getMemberByHandle('ops', 'ops-owner')!.id,
      kind: 'chat',
      body: 'legacy foreign queued row',
    });
    const foreignId = `legacy-${legacyMessage.id}`;
    const legacy = new Database(join(dir, 'switchboard.sqlite'));
    legacy
      .prepare(
        `INSERT INTO deliveries (id, room, message_id, recipient, target_worktree_id,
           target_conversation_id, target_alias, target_handle, state, attempt_count,
           batch_id, run_msg_id, read_ts, interaction_resolved_ts, payload_snapshot,
           process_id, process_group_id, hop_count, queue_seq, group_id, group_round, ts)
         VALUES (?, 'ops', ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM deliveries), NULL, NULL, ?)`,
      )
      .run(
        foreignId,
        legacyMessage.id,
        target.id,
        engTarget.worktree_id,
        engTarget.conversation_id,
        engTarget.alias,
        engTarget.handle,
        new Date().toISOString(),
      );
    legacy.close();

    fake.enqueue({ kind: 'complete', final_text: 'valid target work' });
    daemon.postHumanMessage('eng', '~fifo-target:@fifo-agent valid request');
    await daemon.settle();

    // The foreign row settled in ITS origin — consumed with one visible
    // refusal — without spinning the pump or invoking an adapter, and the
    // later valid row still ran on the target's own session.
    expect(daemon.store.getDelivery('ops', foreignId)?.state).toBe('consumed');
    expect(daemon.store.listMessages('ops').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(1);
    expect(daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(0);
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]?.cwd).toBe(testCwd('fifo-agent'));
    expect(fake.deliveries[0]?.payload).toContain('channel=eng');
    expect(daemon.store.listMessages('eng').map((message) => message.body))
      .toContain('valid target work');
  });
});
// harn:end target-member-turns-serialize-across-origins
// harn:end cross-worktree-runtime-stays-target-local
// harn:end cross-worktree-output-stays-in-origin

// harn:assume delivery-attempt-wal-reconcile ref=scoped-boot-reconcile-regression
describe('scoped boot reconcile settlement', () => {
  const seedStaleDeliveringAttempt = (alias: string) => {
    const worktree = registerQualifiedFixture(alias, alias);
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: `${alias}-agent`, cwd: testCwd(`${alias}-agent`),
    });
    const owner = daemon.ownerOf('eng');
    const trigger = daemon.store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: `~${alias}:@${alias}-agent recover once`,
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: trigger.id,
      recipient: target.id,
      target: {
        worktree_id: worktree.id,
        conversation_id: worktree.conversation_id,
        member_id: target.id,
        alias,
        handle: target.handle,
      },
    });
    const run = daemon.store.postMessage('eng', {
      author: target.id,
      author_target: delivery.target,
      kind: 'run',
      body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:12:00.000Z',
        tool_calls: 0, events_ref: `runs/${String(trigger.id)}.jsonl`,
      },
    });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: 'delivering', run_msg_id: run.id, attempt_count: 1,
    });
    daemon.store.updateMember(worktree.conversation_id, target.id, { state: 'running' });
    return { worktree, target, delivery, run };
  };

  it('settles a stale delivering attempt exactly once across repeated restarts', async () => {
    const { worktree, delivery, run } = seedStaleDeliveringAttempt('stale-restart');
    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T00:13:00.000Z');

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const refusals = () =>
      daemon.store.listMessages('eng').filter((message) =>
        message.kind === 'system' && message.body.includes('qualified target refused'));
    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(refusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);

    // A second crash repeats the reconcile: nothing left to transition, so
    // no duplicated refusal, no resurrected run, no adapter retry.
    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(refusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);
  });

  it('settles a cross-repository delivering row in its origin without a retry', async () => {
    const worktree = registerQualifiedFixture('foreign-boot', 'foreign-boot');
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'foreign-boot-agent', cwd: testCwd('foreign-boot-agent'),
    });
    daemon.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const opsMain = {
      path: join(dir, 'ops-repo'), git_admin_id: join(dir, 'ops-repo', '.git'),
      primary: true, availability: 'available' as const, locked: false, branch: 'main',
    };
    const opsSecondary = {
      path: join(dir, 'ops-child'), git_admin_id: join(dir, 'ops-repo', '.git', 'worktrees', 'ops-child'),
      primary: false, availability: 'available' as const, locked: false, branch: 'feature/ops-child',
    };
    daemon.store.registerWorktree('ops', {
      common_path: join(dir, 'ops-repo', '.git'), primary_path: opsMain.path,
      primary_git_admin_id: opsMain.git_admin_id,
    }, opsMain, opsSecondary, 'ops-child', 'adopted');
    const engTarget = {
      worktree_id: worktree.id, conversation_id: worktree.conversation_id,
      member_id: target.id, alias: 'foreign-boot', handle: target.handle,
    } as const;
    // The legacy attempt lives in ops but is bound to the eng target.
    const trigger = daemon.store.postMessage('ops', {
      author: daemon.store.getMemberByHandle('ops', 'ops-owner')!.id,
      kind: 'chat',
      body: 'legacy foreign attempt',
    });
    const run = daemon.store.postMessage('ops', {
      author: target.id,
      author_target: engTarget,
      kind: 'run',
      body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:14:00.000Z',
        tool_calls: 0, events_ref: `runs/${String(trigger.id)}.jsonl`,
      },
    });
    const foreignId = `legacy-${trigger.id}`;
    const legacy = new Database(join(dir, 'switchboard.sqlite'));
    legacy
      .prepare(
        `INSERT INTO deliveries (id, room, message_id, recipient, target_worktree_id,
           target_conversation_id, target_alias, target_handle, state, attempt_count,
           batch_id, run_msg_id, read_ts, interaction_resolved_ts, payload_snapshot,
           process_id, process_group_id, hop_count, queue_seq, group_id, group_round, ts)
         VALUES (?, 'ops', ?, ?, ?, ?, ?, ?, 'delivering', 1, ?, ?, NULL, NULL, NULL, NULL, NULL, 0,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM deliveries), NULL, NULL, ?)`,
      )
      .run(
        foreignId,
        trigger.id,
        target.id,
        engTarget.worktree_id,
        engTarget.conversation_id,
        engTarget.alias,
        engTarget.handle,
        `batch-${run.id}`,
        run.id,
        new Date().toISOString(),
      );
    legacy.close();

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const opsRefusals = () =>
      daemon.store.listMessages('ops').filter((message) =>
        message.kind === 'system' && message.body.includes('qualified target refused'));
    expect(daemon.store.getDelivery('ops', foreignId)?.state).toBe('consumed');
    expect(daemon.store.getMessage('ops', run.id)?.run?.status).toBe('interrupted');
    expect(opsRefusals()).toHaveLength(1);
    expect(daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(0);
    expect(fake.deliveries).toHaveLength(0);

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('ops', foreignId)?.state).toBe('consumed');
    expect(daemon.store.getMessage('ops', run.id)?.run?.status).toBe('interrupted');
    expect(opsRefusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);
  });
});
// harn:end delivery-attempt-wal-reconcile

// harn:assume invalid-qualified-targets-never-fallback ref=qualified-routing-refusal-regression
// harn:assume invalid-qualified-targets-never-fallback ref=qualified-post-error-regression
describe('qualified refusal boundary', () => {
  it('refuses an unknown target before allocating an origin message or starting a local fallback', () => {
    const local = spawnAgent('local-fallback');
    const messagesBefore = daemon.store.listMessages('eng').length;
    const deliveriesBefore = daemon.store.listDeliveries('eng').length;
    expect(() => daemon.postHumanMessage('eng', '~missing:@local-fallback do not reroute'))
      .toThrow(/qualified target refused/);
    expect(daemon.store.listMessages('eng')).toHaveLength(messagesBefore);
    expect(daemon.store.listDeliveries('eng')).toHaveLength(deliveriesBefore);
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.getMember('eng', local.id)?.state).toBe('idle');
  });

  it.each([
    '~:@local-fallback',
    '~ :@local-fallback',
    '~missing::@local-fallback',
    '~missing: :@local-fallback',
    '~missing:\n@local-fallback',
    '~\nmissing:@local-fallback',
    '~missing:\r\n@local-fallback',
    '~missing:',
    '~missing:@',
    '~:',
    '~ :',
    '~::',
    '~ ::',
  ])('allocates no message or delivery for an attempted incomplete token (%s)', (token) => {
    const local = spawnAgent('local-fallback');
    const messagesBefore = daemon.store.listMessages('eng').length;
    const deliveriesBefore = daemon.store.listDeliveries('eng').length;
    expect(() => daemon.postHumanMessage('eng', token)).toThrow(/qualified target refused/);
    expect(daemon.store.listMessages('eng')).toHaveLength(messagesBefore);
    expect(daemon.store.listDeliveries('eng')).toHaveLength(deliveriesBefore);
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.getMember('eng', local.id)?.state).toBe('idle');
  });

  // Two rows of one stale run-bound attempt: every operator recovery seam
  // settles the whole attempt once, preserving bindings as evidence.
  const seedStaleBoundAttempt = (alias: string, runStatus: 'running' | 'failed', rowState: 'held' | 'consumed') => {
    const worktree = registerQualifiedFixture(alias, alias);
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: `${alias}-agent`, cwd: testCwd(`${alias}-agent`),
    });
    const staleTarget = {
      worktree_id: worktree.id, conversation_id: worktree.conversation_id,
      member_id: target.id, alias, handle: target.handle,
    } as const;
    const owner = daemon.store.getMemberByHandle('eng', 'richard')!;
    const first = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'batch one' });
    const second = daemon.store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'batch two' });
    const run = daemon.store.postMessage('eng', {
      author: target.id,
      author_target: staleTarget,
      kind: 'run',
      body: '',
      run: {
        status: runStatus, started_ts: '2026-08-06T00:00:00.000Z',
        ...(runStatus === 'failed'
          ? { ended_ts: '2026-08-06T00:01:00.000Z', error: 'boom' }
          : {}),
        tool_calls: 0, events_ref: `runs/${first.id}.jsonl`,
      },
    });
    const d1 = daemon.store.createDelivery('eng', { message_id: first.id, recipient: target.id, target: staleTarget });
    const d2 = daemon.store.createDelivery('eng', { message_id: second.id, recipient: target.id, target: staleTarget });
    for (const d of [d1, d2]) {
      daemon.store.updateDelivery('eng', d.id, { state: rowState, run_msg_id: run.id, attempt_count: 1 });
    }
    daemon.store.unregisterWorktree('eng', worktree.id, '2026-08-06T01:00:00.000Z');
    return { worktree, target, run, d1, d2 };
  };
  const qualifiedRefusals = () =>
    daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'));

  it('settles every stale held row of a run-bound attempt once on release_hold', async () => {
    const { run, d1, d2 } = seedStaleBoundAttempt('stale-release', 'running', 'held');

    daemon.releaseHold('eng', d1.id);

    expect(daemon.store.getDelivery('eng', d1.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(daemon.store.getDelivery('eng', d2.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(qualifiedRefusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);

    // A second release finds truthful consumed evidence, not a duplicate refusal.
    expect(() => daemon.releaseHold('eng', d2.id)).toThrow(/not held/);
    expect(qualifiedRefusals()).toHaveLength(1);

    // ... and a restart reconciles nothing further.
    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(daemon.store.getDelivery('eng', d2.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(qualifiedRefusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);
  });

  it('settles every stale held row of a run-bound attempt once on direct redelivery', () => {
    const { run, d1, d2 } = seedStaleBoundAttempt('stale-redeliver', 'running', 'held');

    daemon.redeliver('eng', d1.id);

    expect(daemon.store.getDelivery('eng', d1.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(daemon.store.getDelivery('eng', d2.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(qualifiedRefusals()).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(0);

    // The settled sibling is terminal evidence: redelivering it refuses
    // without mutation instead of requeueing or duplicating the refusal.
    expect(() => daemon.redeliver('eng', d2.id)).toThrow(/qualified target refused/);
    expect(daemon.store.getDelivery('eng', d2.id)).toMatchObject({ state: 'consumed', run_msg_id: run.id });
    expect(qualifiedRefusals()).toHaveLength(1);
  });

  it('refuses a stale scoped retry before reviving, clearing, queuing, or creating a run', () => {
    const { worktree, target, run, d1, d2 } = seedStaleBoundAttempt('stale-retry', 'failed', 'consumed');
    daemon.store.updateMember(worktree.conversation_id, target.id, { state: 'dead' });
    const owner = daemon.store.getMemberByHandle('eng', 'richard')!;
    const messagesBefore = daemon.store.listMessages('eng').length;

    expect(() => daemon.retryRun('eng', run.id, owner.id)).toThrow(/qualified target refused/);

    // Zero mutation: no refusal row, no new run, no revival, bindings preserved.
    expect(daemon.store.listMessages('eng')).toHaveLength(messagesBefore);
    expect(daemon.store.getMember(worktree.conversation_id, target.id)?.state).toBe('dead');
    for (const d of [d1, d2]) {
      expect(daemon.store.getDelivery('eng', d.id))
        .toMatchObject({ state: 'consumed', run_msg_id: run.id, attempt_count: 1 });
    }
    expect(fake.deliveries).toHaveLength(0);
  });

  it('refuses direct redelivery of a stale consumed terminal row without mutation', () => {
    const { d1 } = seedStaleBoundAttempt('stale-consumed', 'failed', 'consumed');
    const before = daemon.store.getDelivery('eng', d1.id);
    const messagesBefore = daemon.store.listMessages('eng').length;

    expect(() => daemon.redeliver('eng', d1.id)).toThrow(/qualified target refused/);

    expect(daemon.store.getDelivery('eng', d1.id)).toEqual(before);
    expect(daemon.store.listMessages('eng')).toHaveLength(messagesBefore);
    expect(qualifiedRefusals()).toHaveLength(0);
    expect(fake.deliveries).toHaveLength(0);
  });
});
// harn:end invalid-qualified-targets-never-fallback
// harn:end invalid-qualified-targets-never-fallback

// harn:assume worktree-child-default-roster-is-an-explicit-snapshot ref=child-default-roster-daemon-regression
describe('worktree child default roster', () => {
  const fixtureGit = (cwd: string, args: readonly string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const fixtureRepo = (name: string): string => {
    const primary = join(dir, name);
    mkdirSync(primary, { recursive: true });
    fixtureGit(primary, ['init', '-q', '-b', 'main']);
    fixtureGit(primary, ['config', 'user.email', 'fixture@example.test']);
    fixtureGit(primary, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    fixtureGit(primary, ['add', 'README.md']);
    fixtureGit(primary, ['commit', '-qm', 'fixture']);
    return primary;
  };
  const rosterRoom = (id: string, primary: string) => daemon.createRoom({
    id,
    name: id,
    owner: { handle: `${id}-owner`, display_name: id },
    cwd: primary,
  });

  it('seeds only the new child with detached ordered snapshots at its canonical cwd', async () => {
    const primary = fixtureRepo('roster-daemon-repo');
    rosterRoom('wtroster', primary);
    const first = daemon.createAgentPreset({ label: 'Kid One', handle: 'kid-one', harness: 'fake' });
    const second = daemon.createAgentPreset({ label: 'Kid Two', handle: 'kid-two', harness: 'fake' });
    daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });
    const target = join(dir, 'roster-daemon-child');
    const result = await daemon.createWorktree('wtroster', {
      alias: 'kid', branch: 'feature/kid', path: target, default_roster: true,
    });
    const child = result.worktree.conversation_id;
    const agents = daemon.store.listMembers(child).filter((member) => member.kind === 'agent');
    expect(agents.map((member) => member.handle).sort()).toEqual(['kid-one', 'kid-two']);
    expect(agents.every((member) => member.cwd === result.worktree.path && member.state === 'idle'))
      .toBe(true);
    expect(result.worktree.path).toBe(target);
    expect(daemon.store.getRoom(child)?.config.cwd).toBe(target);
    // No main clone and no root roster mutation.
    expect(daemon.store.listMembers('wtroster').filter((member) => member.kind === 'agent'))
      .toEqual([]);
    expect(fixtureGit(primary, ['show-ref', '--verify', 'refs/heads/feature/kid']))
      .toContain('feature/kid');
  });

  it('preflights the complete roster and inherited handles before any Git mutation', async () => {
    const primary = fixtureRepo('roster-preflight-repo');
    rosterRoom('wtpreflight', primary);
    const spawn = vi.spyOn(fake, 'spawn');

    // A dangling preset reference fails before Git, registration, or spawn.
    const dangling = new Database(join(dir, 'switchboard.sqlite'));
    dangling.pragma('foreign_keys = OFF');
    dangling.prepare(
      `INSERT INTO default_roster_items (roster_id, preset_id, ordinal) VALUES ('default', '01J00000000000000000000000', 0)`,
    ).run();
    dangling.close();
    const missingTarget = join(dir, 'preflight-missing');
    await expect(daemon.createWorktree('wtpreflight', {
      alias: 'miss', branch: 'feature/miss', path: missingTarget, default_roster: true,
    })).rejects.toThrow('missing agent preset');
    expect(existsSync(missingTarget)).toBe(false);
    expect(daemon.store.getRepository('wtpreflight')).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();

    // An inherited-human handle collision fails the same way.
    daemon.replaceDefaultRoster({ preset_ids: [] });
    const collide = daemon.createAgentPreset({ label: 'Owner Clone', handle: 'wtpreflight-owner', harness: 'fake' });
    daemon.replaceDefaultRoster({ preset_ids: [collide.id] });
    const collideTarget = join(dir, 'preflight-collide');
    await expect(daemon.createWorktree('wtpreflight', {
      alias: 'collide', branch: 'feature/collide', path: collideTarget, default_roster: true,
    })).rejects.toThrow('inherited channel member');
    expect(existsSync(collideTarget)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();

    // Duplicate handles inside the roster fail the same way.
    const dupA = daemon.createAgentPreset({ label: 'Dup A', handle: 'dup-handle', harness: 'fake' });
    const dupB = daemon.createAgentPreset({ label: 'Dup B', handle: 'dup-handle', harness: 'fake' });
    daemon.replaceDefaultRoster({ preset_ids: [dupA.id, dupB.id] });
    await expect(daemon.createWorktree('wtpreflight', {
      alias: 'dup', branch: 'feature/dup', path: join(dir, 'preflight-dup'), default_roster: true,
    })).rejects.toThrow('duplicate member handle');
    expect(spawn).not.toHaveBeenCalled();
    spawn.mockRestore();
  });

  it('creates an agent-empty child on omission or an empty roster', async () => {
    const primary = fixtureRepo('roster-empty-repo');
    rosterRoom('wtempty', primary);
    daemon.replaceDefaultRoster({ preset_ids: [] });
    const omitted = await daemon.createWorktree('wtempty', {
      alias: 'plain', branch: 'feature/plain', path: join(dir, 'empty-plain'),
    });
    expect(omitted.seeded).toEqual([]);
    expect(
      daemon.store.listMembers(omitted.worktree.conversation_id)
        .filter((member) => member.kind === 'agent'),
    ).toEqual([]);
    const empty = await daemon.createWorktree('wtempty', {
      alias: 'empty-roster', branch: 'feature/empty-roster',
      path: join(dir, 'empty-roster'), default_roster: true,
    });
    expect(empty.seeded).toEqual([]);
    expect(
      daemon.store.listMembers(empty.worktree.conversation_id)
        .filter((member) => member.kind === 'agent'),
    ).toEqual([]);
  });

  it('keeps an external spawn failure local to one durable dead member', async () => {
    const primary = fixtureRepo('roster-failure-repo');
    rosterRoom('wtfailure', primary);
    const first = daemon.createAgentPreset({ label: 'Fragile', handle: 'fragile-kid', harness: 'fake' });
    const second = daemon.createAgentPreset({ label: 'Sturdy', handle: 'sturdy-kid', harness: 'fake' });
    daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });
    const spawn = vi.spyOn(fake, 'spawn').mockImplementationOnce(() => {
      throw new Error('spawn exploded');
    });
    const result = await daemon.createWorktree('wtfailure', {
      alias: 'fragile', branch: 'feature/fragile', path: join(dir, 'failure-child'), default_roster: true,
    });
    spawn.mockRestore();
    const child = result.worktree.conversation_id;
    const byHandle = new Map(
      daemon.store.listMembers(child)
        .filter((member) => member.kind === 'agent')
        .map((member) => [member.handle, member]),
    );
    expect(byHandle.get('fragile-kid')?.state).toBe('dead');
    expect(byHandle.get('sturdy-kid')?.state).toBe('idle');
    expect(daemon.store.getWorktree('wtfailure', result.worktree.id)?.lifecycle).toBe('active');
    expect(
      daemon.store.listMessages(child)
        .filter((message) => message.kind === 'system')
        .some((message) => message.body.includes('spawn exploded')),
    ).toBe(true);
  });
});
// harn:end worktree-child-default-roster-is-an-explicit-snapshot

// harn:assume qualified-member-target-identity-is-durable ref=phase5-qualified-integration-regression
// harn:assume worktree-alias-and-child-metadata-follow-stable-identity ref=phase5-qualified-integration-regression
// harn:assume child-members-own-isolated-runtime ref=phase5-qualified-integration-regression
// harn:assume cross-worktree-runtime-stays-target-local ref=phase5-qualified-integration-regression
// harn:assume cross-worktree-output-stays-in-origin ref=phase5-qualified-integration-regression
// harn:assume target-member-turns-serialize-across-origins ref=phase5-qualified-integration-regression
// harn:assume agent-authority-follows-one-active-invocation ref=phase5-qualified-integration-regression
// harn:assume invalid-qualified-targets-never-fallback ref=phase5-qualified-integration-regression
// harn:assume delivery-attempt-wal-reconcile ref=phase5-qualified-integration-regression
describe('Phase 5 qualified integration hardening', () => {
  it('keeps an accepted target on stable identity across alias/path/branch changes and restart', async () => {
    const worktree = registerQualifiedFixture('old-scope', 'old-scope');
    const child = worktree.conversation_id;
    const target = daemon.spawnMember(child, {
      harness: 'fake', handle: 'stable-target', cwd: testCwd('stable-target'),
    });
    daemon.pauseMember(child, target.id);
    const accepted = daemon.postHumanMessage('eng', '~old-scope:@stable-target accepted before rename');
    const delivery = daemon.store.listDeliveries('eng', { recipient: target.id })
      .find((candidate) => candidate.message_id === accepted.id)!;
    expect(delivery.target?.alias).toBe('old-scope');

    daemon.updateWorktreeAlias('eng', worktree.id, 'new-scope');
    daemon.store.refreshWorktreeObservation('eng', worktree.id, {
      path: join(dir, 'moved-stable-target'),
      git_admin_id: join(dir, 'qualified-repository', '.git', 'worktrees', 'old-scope'),
      primary: false,
      availability: 'available',
      locked: false,
      branch: 'feature/moved-stable-target',
    });

    await daemon.close({ force: true });
    daemon = newDaemon();
    fake.enqueue({ kind: 'complete', final_text: 'accepted after metadata change' });
    daemon.unpauseMember(child, target.id);
    await daemon.settle();

    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]?.cwd).toBe(testCwd('stable-target'));
    expect(daemon.store.listMessages('eng').map((message) => message.body))
      .toContain('accepted after metadata change');
    expect(daemon.store.listMessages(child).map((message) => message.body))
      .not.toContain('accepted after metadata change');

    // The historical alias is not a second selector after the edit; only the
    // current alias can create a new delivery.
    expect(() => daemon.postHumanMessage('eng', '~old-scope:@stable-target must refuse old alias'))
      .toThrow(/qualified target refused/);
    fake.enqueue({ kind: 'complete', final_text: 'new alias accepted' });
    daemon.postHumanMessage('eng', '~new-scope:@stable-target use current alias');
    await daemon.settle();
    expect(daemon.store.listMessages('eng').map((message) => message.body))
      .toContain('new alias accepted');
  });

  it('runs equal main and child handles concurrently with target-local runtime authority', async () => {
    const worktree = registerQualifiedFixture('equal-child', 'equal-child');
    const sessions: Session[] = [];
    const originalSpawn = fake.spawn.bind(fake);
    const spawnSpy = vi.spyOn(fake, 'spawn').mockImplementation((opts: SpawnOpts) => {
      const session = originalSpawn(opts);
      sessions.push(session);
      return session;
    });
    const main = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'equal-handle', cwd: testCwd('equal-main'),
    });
    const child = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'equal-handle', cwd: testCwd('equal-child'),
    });
    spawnSpy.mockRestore();
    fake.enqueue(
      { kind: 'complete', final_text: 'main concurrent result', delay_ms: 50 },
      { kind: 'complete', final_text: 'child concurrent result', delay_ms: 50 },
    );

    daemon.postHumanMessage('eng', '@equal-handle main concurrent request');
    daemon.postHumanMessage('eng', '~equal-child:@equal-handle child concurrent request');
    await until(() => fake.deliveries.length === 2 ? true : undefined);

    expect(daemon.store.getMember('eng', main.id)?.state).toBe('running');
    expect(daemon.store.getMember(worktree.conversation_id, child.id)?.state).toBe('running');
    expect(new Set(fake.deliveries.map((delivery) => delivery.cwd))).toEqual(new Set([
      testCwd('equal-main'), testCwd('equal-child'),
    ]));
    expect(new Set(fake.deliveries.map((delivery) => delivery.session_ref)).size).toBe(2);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.env?.CODOR_MEMBER_TOKEN).not.toBe(sessions[1]?.env?.CODOR_MEMBER_TOKEN);
    expect(fake.deliveries.every((delivery) => delivery.payload.includes('channel=eng'))).toBe(true);
    const childToken = sessions.find((session) => session.env?.CODOR_MEMBER_ID === child.id)
      ?.env?.CODOR_MEMBER_TOKEN;
    expect(childToken).toBeDefined();
    expect(daemon.authenticateAgentToken(childToken!)).toMatchObject({
      room: 'eng', homeRoom: worktree.conversation_id,
      member: { id: child.id }, invocation: { targetRoom: worktree.conversation_id },
    });

    await daemon.settle();
    expect(daemon.store.listMessages('eng').map((message) => message.body))
      .toEqual(expect.arrayContaining(['main concurrent result', 'child concurrent result']));
    expect(daemon.store.listMessages(worktree.conversation_id).map((message) => message.body))
      .not.toEqual(expect.arrayContaining(['main concurrent result', 'child concurrent result']));
  });
});
// harn:end delivery-attempt-wal-reconcile
// harn:end invalid-qualified-targets-never-fallback
// harn:end agent-authority-follows-one-active-invocation
// harn:end target-member-turns-serialize-across-origins
// harn:end cross-worktree-output-stays-in-origin
// harn:end cross-worktree-runtime-stays-target-local
// harn:end child-members-own-isolated-runtime
// harn:end worktree-alias-and-child-metadata-follow-stable-identity
// harn:end qualified-member-target-identity-is-durable

// harn:assume qualified-execution-requires-usable-checkout ref=qualified-target-usability-daemon-regression
describe('qualified checkout usability at daemon admission and recovery', () => {
  it.each(['missing', 'prunable'] as const)('refuses a %s checkout without fallback or execution', async (availability) => {
    const worktree = registerQualifiedFixture(`unusable-${availability}`, `unusable-${availability}`);
    const child = worktree.conversation_id;
    const local = spawnAgent(`unusable-${availability}-agent`);
    const target = daemon.spawnMember(child, {
      harness: 'fake', handle: local.handle, cwd: testCwd(`unusable-${availability}`),
    });
    daemon.pauseMember(child, target.id);
    const root = daemon.postHumanMessage(
      'eng', `~${worktree.alias}:@${target.handle} refuse ${availability}`,
    );
    const delivery = daemon.store.listDeliveries('eng', { recipient: target.id })
      .find((candidate) => candidate.message_id === root.id)!;
    daemon.store.refreshWorktreeObservation('eng', worktree.id, {
      path: worktree.path,
      git_admin_id: worktree.git_admin_id,
      primary: false,
      availability,
      locked: false,
      branch: worktree.branch,
    });

    await daemon.maybeStartTurn(child, target.id);
    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(fake.deliveries).toHaveLength(0);
    expect(daemon.store.getMember('eng', local.id)?.state).toBe('idle');
    expect(daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(1);
  });

  it('settles a recovered delivering attempt against an unavailable checkout exactly once', async () => {
    const worktree = registerQualifiedFixture('unavailable-recovery', 'unavailable-recovery');
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'unavailable-recovery-agent', cwd: testCwd('unavailable-recovery'),
    });
    const owner = daemon.ownerOf('eng');
    const trigger = daemon.store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '~unavailable-recovery:@unavailable-recovery-agent recover',
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: trigger.id,
      recipient: target.id,
      target: {
        worktree_id: worktree.id, conversation_id: worktree.conversation_id,
        member_id: target.id, alias: worktree.alias, handle: target.handle,
      },
    });
    const run = daemon.store.postMessage('eng', {
      author: target.id, author_target: delivery.target, kind: 'run', body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:15:00.000Z',
        tool_calls: 0, events_ref: `runs/${String(trigger.id)}.jsonl`,
      },
    });
    daemon.store.updateDelivery('eng', delivery.id, {
      state: 'delivering', run_msg_id: run.id, attempt_count: 1,
    });
    daemon.store.updateMember(worktree.conversation_id, target.id, { state: 'running' });
    daemon.store.refreshWorktreeObservation('eng', worktree.id, {
      path: worktree.path,
      git_admin_id: worktree.git_admin_id,
      primary: false,
      availability: 'missing',
      locked: false,
      branch: worktree.branch,
    });

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();

    const refusalCount = () => daemon.store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused')).length;
    expect(daemon.store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(daemon.store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(refusalCount()).toBe(1);
    expect(fake.deliveries).toHaveLength(0);

    await daemon.close({ force: true });
    daemon = newDaemon();
    await daemon.reconcile();
    await daemon.settle();
    expect(refusalCount()).toBe(1);
    expect(fake.deliveries).toHaveLength(0);
  });
});
// harn:end qualified-execution-requires-usable-checkout

// harn:assume child-members-own-isolated-runtime ref=worktree-runtime-removal-regression
describe('worktree removal refuses live child runtime before Git', () => {
  const registerRuntimeChild = () => {
    const root = join(dir, 'removal-root');
    const childPath = join(dir, 'removal-child');
    mkdirSync(root, { recursive: true });
    mkdirSync(childPath, { recursive: true });
    daemon.store.updateRoomConfig('eng', { cwd: root });
    const result = daemon.store.registerWorktree(
      'eng',
      {
        common_path: join(root, '.git'),
        primary_path: root,
        primary_git_admin_id: join(root, '.git'),
      },
      {
        path: root, git_admin_id: join(root, '.git'), primary: true,
        availability: 'available', locked: false, branch: 'main',
      },
      {
        path: childPath, git_admin_id: join(root, '.git', 'worktrees', 'removal-child'),
        primary: false, availability: 'available', locked: false, branch: 'feature/removal-child',
      },
      'removal-child', 'adopted',
    );
    return { ...result.worktree, root, childPath };
  };

  const expectPreGitRefusal = async (worktreeId: string, setup: () => void) => {
    const remove = vi.spyOn(daemon.worktrees, 'remove').mockImplementation(async () => {
      throw new Error('Git removal reached');
    });
    const before = JSON.stringify(daemon.store.listRegisteredWorktrees('eng'));
    setup();
    await expect(daemon.removeWorktree('eng', worktreeId)).rejects.toThrow(/live child runtime/);
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(daemon.store.listRegisteredWorktrees('eng'))).toBe(before);
    remove.mockRestore();
  };

  it('refuses an idle cached session and keeps DB-only unregister available', async () => {
    const worktree = registerRuntimeChild();
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'idle-session', cwd: worktree.childPath,
    });
    await expectPreGitRefusal(worktree.id, () => undefined);
    expect(daemon.store.getMember(worktree.conversation_id, target.id)).toBeDefined();
    expect(daemon.unregisterWorktree('eng', worktree.id).lifecycle).toBe('unregistered');
  });

  it.each(['queued', 'held', 'delivering'] as const)('refuses unresolved %s work before Git', async (state) => {
    const worktree = registerRuntimeChild();
    const target = daemon.store.addMember(worktree.conversation_id, {
      kind: 'agent', handle: `unresolved-${state}`, display_name: `Unresolved ${state}`,
      harness: 'fake', cwd: worktree.childPath, state: 'idle', custody: 'owned',
    });
    const owner = daemon.ownerOf('eng');
    const message = daemon.store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: `unresolved ${state}`,
    });
    const delivery = daemon.store.createDelivery('eng', {
      message_id: message.id,
      recipient: target.id,
      target: {
        worktree_id: worktree.id, conversation_id: worktree.conversation_id,
        member_id: target.id, alias: worktree.alias, handle: target.handle,
      },
    });
    daemon.store.updateDelivery('eng', delivery.id, { state });
    await expectPreGitRefusal(worktree.id, () => undefined);
  });

  it('refuses an active in-flight invocation before Git', async () => {
    const worktree = registerRuntimeChild();
    const target = daemon.spawnMember(worktree.conversation_id, {
      harness: 'fake', handle: 'inflight-child', cwd: worktree.childPath,
    });
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Keep the child turn live?', options: [{ label: 'continue' }] },
      reply: () => 'finished',
    });
    const remove = vi.spyOn(daemon.worktrees, 'remove').mockImplementation(async () => {
      throw new Error('Git removal reached');
    });
    daemon.postHumanMessage('eng', '~removal-child:@inflight-child keep running');
    await until(() => fake.deliveries.length === 1 &&
      daemon.store.getMember(worktree.conversation_id, target.id)?.state === 'running'
      ? true : undefined);
    await expect(daemon.removeWorktree('eng', worktree.id)).rejects.toThrow(/live child runtime/);
    expect(remove).not.toHaveBeenCalled();
    daemon.interruptMember(worktree.conversation_id, target.id);
    await daemon.settle();
    remove.mockRestore();
  });
});
// harn:end child-members-own-isolated-runtime
