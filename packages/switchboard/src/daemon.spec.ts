import { spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@codor/protocol';
import { createTurnTranslator, wireEventFromHook } from '@codor/adapter-claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  fake = new FakeAdapter('fake', { interactiveAttach: true });
  claudeFake = new FakeAdapter('claude-code', { extensions: true });
  codexFake = new FakeAdapter('codex');
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

  it('tombstones only dead agents, preserves attribution, and frees the handle', () => {
    const alpha = spawnAgent('alpha');
    const historical = daemon.store.postMessage('eng', {
      author: alpha.id, kind: 'chat', body: 'historical alpha message',
    });
    expect(() => daemon.removeMember('eng', alpha.id)).toThrow('must be dead before removal');
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
