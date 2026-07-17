import { spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentLimit, HarnessAdapter, ServerFrame, Session, SpawnOpts } from '@codor/protocol';
import { createTurnTranslator, wireEventFromHook } from '@codor/adapter-claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';

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
  daemon.store.listMessages('eng', { limit: 100 }).filter((m) => m.kind === 'run');

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
      CODOR_SOCKET: join(dir, 'codor.sock'),
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
    expect(runMessages()[0]!.body).toBe('@richard first turn done');
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
    expect(daemon.store.listRunMessages('eng', { author: alpha.id, limit: 1 })[0])
      .toMatchObject({ id: running.id, run: { status: 'completed' }, body: '@richard alpha final' });
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
    expect(daemon.store.getMessage('eng', running.id)).toMatchObject({
      id: running.id,
      body: '@richard adapter final only',
      run: { status: 'completed', final_text: '@richard adapter final only' },
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
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.id })[0]!.state).toBe('consumed');
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
    expect(run.body).toBe('chose ALPHA');
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

    const failed = daemon.createRoom({
      name: 'Still Useful',
      owner: { handle: 'owner-c', display_name: 'Owner C' },
      cwd: project,
      starting_agent: { harness: 'missing', handle: 'codor' },
    });
    expect(failed.room.id).toBe('still-useful');
    expect(failed.room.config.starting_agent_handle).toBe('codor');
    expect(daemon.store.listMembers('still-useful').map((member) => member.kind).sort())
      .toEqual(['human', 'system']);
    expect(daemon.store.listMessages('still-useful', { limit: 10 }).at(-1)?.body)
      .toContain("no adapter registered for harness 'missing'");
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
});
// harn:end adapters-own-their-model-catalog

// harn:assume agent-model-and-thinking-are-durable ref=durable-agent-config-regression
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
});
// harn:end agent-model-and-thinking-are-durable

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
});
// harn:end run-events-merge-by-journal-index

// harn:assume last-agent-usage-is-transient ref=last-usage-daemon-regression
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
// harn:end last-agent-usage-is-transient
