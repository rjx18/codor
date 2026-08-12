import type { Session, WireEvent } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_THINKING_LEVELS,
  CodexAdapter,
  codexPolicyOptions,
} from './adapter.js';
import {
  createFakeCodexAppServer,
  createFakeCodexAppServerFactory,
  type FakeCodexAppServer,
} from './test-utils/fake-app-server.js';

function collect(
  adapter: CodexAdapter,
  session: Session,
  payload: string,
  hooks: Parameters<CodexAdapter['deliver']>[2] = {},
): Promise<WireEvent[]> {
  return (async () => {
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, payload, hooks)) events.push(event);
    return events;
  })();
}

function completeTurn(
  server: FakeCodexAppServer,
  turnId: string,
  text = 'DONE',
): void {
  server.notify('turn/started', {
    threadId: 'thread-1',
    turn: { id: turnId, status: 'inProgress', items: [], error: null },
  });
  server.notify('item/completed', {
    threadId: 'thread-1',
    turnId,
    item: { type: 'agentMessage', id: `message-${turnId}`, text },
  });
  server.notify('turn/completed', {
    threadId: 'thread-1',
    turn: { id: turnId, status: 'completed', items: [], error: null },
  });
}

function fixtureAdapter(...servers: FakeCodexAppServer[]): {
  adapter: CodexAdapter;
  factory: ReturnType<typeof createFakeCodexAppServerFactory>;
} {
  const factory = createFakeCodexAppServerFactory();
  for (const server of servers) factory.enqueue(server);
  return {
    adapter: new CodexAdapter({ appServerFactory: factory.factory }),
    factory,
  };
}

// Historical argv oracle retained only for the immutable exec-capture
// regression below. The production adapter never calls this helper.
function codexArgs(session: Session, payload: string): string[] {
  const policy = session.policy ?? 'read-only';
  codexPolicyOptions(policy);
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', session.cwd];
  if (policy === 'full-access') args.push('--yolo');
  else args.push('--sandbox', policy);
  if (session.model !== undefined) args.push('-m', session.model);
  if (session.thinking !== undefined) {
    if (!(CODEX_THINKING_LEVELS as readonly string[]).includes(session.thinking)) {
      throw new Error(
        `adapter 'codex' does not support thinking level '${session.thinking}'; ` +
        `valid levels: ${CODEX_THINKING_LEVELS.join(', ')}`,
      );
    }
    args.push('-c', `model_reasoning_effort=${session.thinking}`);
  }
  if (session.session_ref !== undefined) args.push('resume', session.session_ref);
  args.push(payload);
  return args;
}

describe('Codex app-server controls', () => {
  // harn:assume harness-declares-supported-thinking-levels ref=codex-thinking-level-regression
  it('maps every canonical policy and thinking level to documented argv', () => {
    const base = { harness: 'codex', cwd: '/work' };
    expect(codexArgs({ ...base, policy: 'read-only' }, 'go')).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only']),
    );
    expect(codexArgs({ ...base, policy: 'workspace-write' }, 'go')).toEqual(
      expect.arrayContaining(['--sandbox', 'workspace-write']),
    );
    const fullAccess = codexArgs({ ...base, policy: 'full-access' }, 'go');
    expect(fullAccess).toContain('--yolo');
    expect(fullAccess).not.toContain('--sandbox');
    for (const thinking of CODEX_THINKING_LEVELS) {
      expect(codexArgs({ ...base, thinking }, 'go')).toEqual(
        expect.arrayContaining(['-c', `model_reasoning_effort=${thinking}`]),
      );
    }
    expect(() => codexArgs({ ...base, thinking: 'ultracode' }, 'go')).toThrow(
      "adapter 'codex' does not support thinking level 'ultracode'",
    );
    expect(() => codexArgs({ ...base, policy: 'danger-full-access' }, 'go')).toThrow(
      'valid policies: read-only, workspace-write, full-access',
    );
  });
  // harn:end harness-declares-supported-thinking-levels

  // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-regression
  it('maps non-yolo policies to on-request approvals and exact 0.144.5 sandbox shapes', () => {
    expect(codexPolicyOptions('read-only')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly' },
    });
    expect(codexPolicyOptions('workspace-write')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    // full-access alone runs unattended: never ask, no sandbox.
    expect(codexPolicyOptions('full-access')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    expect(() => codexPolicyOptions('danger-full-access')).toThrow(
      'valid policies: read-only, workspace-write, full-access',
    );
  });
  // harn:end harness-declares-what-a-policy-becomes
});

// harn:assume codex-app-server-is-the-member-runtime ref=codex-app-server-session-regression
describe('persistent Codex app-server lifecycle', () => {
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=codex-session-reset
  it('disposes and forgets the app-server so the next delivery starts a fresh thread', async () => {
    const firstServer = createFakeCodexAppServer();
    const secondServer = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(firstServer, secondServer);
    const session = adapter.spawn({ cwd: '/work' });
    session.env = { CODOR_MEMBER_ID: 'reset-member' };

    const first = collect(adapter, session, 'old context');
    await firstServer.waitForRequest('turn/start');
    completeTurn(firstServer, 'turn-1');
    await first;
    expect(session.session_ref).toBe('thread-1');

    await adapter.resetSession(session);
    expect(firstServer.child.killed).toBe(true);
    session.session_ref = undefined;

    const fresh = collect(adapter, session, 'fresh context');
    await secondServer.waitForRequest('thread/start');
    expect(secondServer.messages.some((message) => message.method === 'thread/resume')).toBe(false);
    completeTurn(secondServer, 'turn-1');
    await fresh;
    expect(factory.servers).toEqual([firstServer, secondServer]);
    await adapter.resetSession(session);
    await expect(adapter.resetSession(undefined)).resolves.toBeUndefined();
  });

  it('keeps the disposed runtime supervised and un-reusable until delayed child exit', async () => {
    const firstServer = createFakeCodexAppServer();
    const secondServer = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(firstServer, secondServer);
    const session = adapter.spawn({ cwd: '/work' });
    session.env = { CODOR_MEMBER_ID: 'delayed-reset-member' };
    const first = collect(adapter, session, 'old context');
    await firstServer.waitForRequest('turn/start');
    completeTurn(firstServer, 'turn-1');
    await first;

    const mutable = firstServer.child as unknown as { killed: boolean };
    firstServer.child.kill = vi.fn(() => {
      mutable.killed = true;
      return true; // retirement requested, but exit remains deliberately delayed
    });
    const reset = adapter.resetSession(session);
    expect(firstServer.child.kill).toHaveBeenCalled();

    const raced = await collect(adapter, session, 'must not spawn while retiring');
    expect(raced).toContainEqual(expect.objectContaining({
      type: 'run.completed', status: 'failed',
      error: 'previous Codex app-server retirement is still pending',
    }));
    expect(factory.servers).toEqual([firstServer]);

    firstServer.exit(0);
    await reset;
    session.session_ref = undefined;
    const fresh = collect(adapter, session, 'fresh after confirmed exit');
    await secondServer.waitForRequest('thread/start');
    completeTurn(secondServer, 'turn-1');
    await fresh;
    expect(factory.servers).toEqual([firstServer, secondServer]);
    await adapter.resetSession(session);
  });

  it('retains supervision after retirement timeout instead of forgetting a live child', async () => {
    const server = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    session.env = { CODOR_MEMBER_ID: 'failed-reset-member' };
    const first = collect(adapter, session, 'old context');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1');
    await first;

    const mutable = server.child as unknown as { killed: boolean };
    server.child.kill = vi.fn(() => {
      mutable.killed = true;
      return true;
    });
    vi.useFakeTimers();
    try {
      const reset = adapter.resetSession(session);
      const rejected = expect(reset).rejects.toThrow('did not exit after retirement');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }

    const raced = await collect(adapter, session, 'still supervised');
    expect(raced).toContainEqual(expect.objectContaining({
      type: 'run.completed', status: 'failed',
      error: 'previous Codex app-server retirement is still pending',
    }));
    expect(factory.servers).toEqual([server]);
    server.exit(0);
    await adapter.resetSession(session);
  });

  // harn:assume context-reset-retirement-is-bounded-owned-and-confirmed ref=reset-retirement-regression
  it('escalates only its owned app-server child after grace and confirms forced exit', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    session.env = { CODOR_MEMBER_ID: 'escalated-reset-member' };
    const first = collect(adapter, session, 'old context');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1');
    await first;

    const signals: Array<NodeJS.Signals | number | undefined> = [];
    server.child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      if (signal === 'SIGKILL') server.exit(null, 'SIGKILL');
      return true;
    });
    vi.useFakeTimers();
    try {
      const reset = adapter.resetSession(session);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(reset).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
  // harn:end context-reset-retirement-is-bounded-owned-and-confirmed
  // harn:end member-context-reset-is-authorized-atomic-and-lazy

  // harn:assume active-turn-steering-is-ordered-and-durable ref=codex-active-turn-steering-regression
  it('steers only the active expected turn and returns idle fallback after completion', async () => {
    const server = createFakeCodexAppServer({
      'turn/steer': (params) => ({ turnId: (params as { expectedTurnId: string }).expectedTurnId }),
    });
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'start');
    await server.waitForRequest('turn/start');
    server.notify('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    });

    await expect(adapter.steer(session, 'focus on the failing test')).resolves.toBe(true);
    expect((await server.waitForRequest('turn/steer')).params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'focus on the failing test', text_elements: [] }],
      expectedTurnId: 'turn-1',
    });

    server.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null },
    });
    await run;
    await expect(adapter.steer(session, 'too late')).resolves.toBe(false);
    expect(server.messages.filter((message) => message.method === 'turn/steer')).toHaveLength(1);
  });

  it('rejects a mismatched acknowledgement without ending the active turn', async () => {
    const server = createFakeCodexAppServer({
      'turn/steer': () => ({ turnId: 'some-other-turn' }),
    });
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'start');
    await server.waitForRequest('turn/start');
    server.notify('turn/started', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    });

    await expect(adapter.steer(session, 'mismatch')).rejects.toThrow(
      'steered unexpected turn some-other-turn; expected turn-1',
    );
    completeTurn(server, 'turn-1');
    await expect(run).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.completed', status: 'completed' }),
    ]));
  });

  it('surfaces an app-server steering failure while preserving the active turn', async () => {
    const server = createFakeCodexAppServer({
      'turn/steer': async () => { throw new Error('active turn closed'); },
    });
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'start');
    await server.waitForRequest('turn/start');
    server.notify('turn/started', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    });

    await expect(adapter.steer(session, 'recover me')).rejects.toThrow('active turn closed');
    completeTurn(server, 'turn-1');
    await expect(run).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.completed', status: 'completed' }),
    ]));
  });
  // harn:end active-turn-steering-is-ordered-and-durable

  it('serves multiple turns through one initialized child and one native thread', async () => {
    let turn = 0;
    const server = createFakeCodexAppServer({
      'turn/start': () => ({ turn: { id: `turn-${++turn}`, status: 'inProgress' } }),
    });
    const { adapter, factory } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write', thinking: 'high' });
    const refs: string[] = [];

    const first = collect(adapter, session, 'one', { onSessionRef: (ref) => refs.push(ref) });
    await server.waitForRequest('turn/start', 1);
    completeTurn(server, 'turn-1', 'ONE');
    expect((await first).at(-1)).toMatchObject({ status: 'completed', final_text: 'ONE' });

    const second = collect(adapter, session, 'two', { onSessionRef: (ref) => refs.push(ref) });
    await server.waitForRequest('turn/start', 2);
    completeTurn(server, 'turn-2', 'TWO');
    expect((await second).at(-1)).toMatchObject({ status: 'completed', final_text: 'TWO' });

    expect(factory.servers).toHaveLength(1);
    expect(server.messages.filter((message) => message.method === 'initialize')).toHaveLength(1);
    expect(server.messages.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(server.messages.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(server.messages.filter((message) => message.method === 'turn/start')).toHaveLength(2);
    expect(server.messages.slice(0, 3).map((message) => message.method)).toEqual([
      'initialize', 'initialized', 'thread/start',
    ]);
    expect(server.messages.every((message) => message.jsonrpc === undefined)).toBe(true);
    expect(refs).toEqual(['thread-1']);
    expect(session.session_ref).toBe('thread-1');
    server.assertNoErrors();
  });

  it('reuses the member process when the daemon rebuilds the Session object', async () => {
    const server = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(server);
    const firstSession = adapter.spawn({ cwd: '/work', model: 'gpt-model' });
    firstSession.env = { CODOR_MEMBER_ID: 'member-codex' };
    const first = collect(adapter, firstSession, 'first');
    await server.waitForRequest('turn/start', 1);
    completeTurn(server, 'turn-1');
    await first;

    const rebuilt: Session = {
      ...firstSession,
      env: { CODOR_MEMBER_ID: 'member-codex' },
    };
    const second = collect(adapter, rebuilt, 'second');
    await server.waitForRequest('turn/start', 2);
    completeTurn(server, 'turn-2');
    await second;

    expect(factory.servers).toHaveLength(1);
    expect(server.messages.filter((message) => message.method === 'initialize')).toHaveLength(1);
  });

  it('routes token notifications live and snapshots both context fields at completion', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'usage');
    await server.waitForRequest('turn/start');
    server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 4000,
          outputTokens: 1000, reasoningOutputTokens: 100,
        },
        last: {
          totalTokens: 7000, inputTokens: 6000, cachedInputTokens: 3000,
          outputTokens: 1000, reasoningOutputTokens: 100,
        },
        modelContextWindow: 200000,
      },
    });
    completeTurn(server, 'turn-1');
    const events = await run;
    const usage = {
      inputTokens: 6000,
      cachedInputTokens: 3000,
      outputTokens: 1000,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 7000,
    };
    expect(events).toContainEqual({ type: 'usage_updated', usage });
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'completed',
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 6000, cached_input_tokens: 3000, output_tokens: 1000 },
      agent_usage: usage,
    });
  });

  // harn:assume codex-app-server-usage-preserves-cache-and-resolved-model ref=codex-resolved-model-regression
  it('snapshots start/settings/reroute model truth only for the retained active turn', async () => {
    const server = createFakeCodexAppServer({
      'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-5.6-terra' }),
    });
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', model: 'gpt-5.6-luna' });
    const run = collect(adapter, session, 'models');
    await server.waitForRequest('turn/start');
    server.notify('thread/settings/updated', {
      threadId: 'thread-1',
      threadSettings: { model: 'gpt-5.6-sol' },
    });
    server.notify('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    });
    server.notify('model/rerouted', {
      threadId: 'thread-1', turnId: 'other-turn', toModel: 'ignored-model',
    });
    server.notify('model/rerouted', {
      threadId: 'thread-1', turnId: 'turn-1', toModel: 'gpt-5.5',
    });
    completeTurn(server, 'turn-1');
    expect((await run).at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', model: 'gpt-5.5',
    });
  });
  // harn:end codex-app-server-usage-preserves-cache-and-resolved-model

  it('resumes the persisted rollout id when attaching on a fresh process', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.attach('rollout-existing');
    session.cwd = '/work';
    const run = collect(adapter, session, 'resume');
    const resume = await server.waitForRequest('thread/resume');
    expect(resume.params).toMatchObject({
      threadId: 'rollout-existing',
      cwd: '/work',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
    await server.waitForRequest('turn/start');
    server.notify('turn/completed', {
      threadId: 'rollout-existing',
      turn: { id: 'turn-1', status: 'completed', items: [], error: null },
    });
    expect((await run).at(-1)).toMatchObject({
      status: 'completed', model: 'gpt-5.6-sol',
    });
    expect(session.session_ref).toBe('rollout-existing');
  });

  it('recovers from a crash mid-turn by resuming the thread on the next delivery', async () => {
    const firstServer = createFakeCodexAppServer();
    const secondServer = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(firstServer, secondServer);
    const session = adapter.spawn({ cwd: '/work' });

    const crashed = collect(adapter, session, 'crash');
    await firstServer.waitForRequest('turn/start');
    firstServer.exit(7, null, 'engine crashed');
    expect((await crashed).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      error: expect.stringContaining('engine crashed'),
    });

    const recovered = collect(adapter, session, 'recover');
    expect((await secondServer.waitForRequest('thread/resume')).params).toMatchObject({
      threadId: 'thread-1',
    });
    await secondServer.waitForRequest('turn/start');
    completeTurn(secondServer, 'turn-1', 'RECOVERED');
    expect((await recovered).at(-1)).toMatchObject({
      status: 'completed',
      final_text: 'RECOVERED',
    });
    expect(factory.servers).toHaveLength(2);
  });

  it('recovers from a process exit between turns', async () => {
    const firstServer = createFakeCodexAppServer();
    const secondServer = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(firstServer, secondServer);
    const session = adapter.spawn({ cwd: '/work' });

    const first = collect(adapter, session, 'first');
    await firstServer.waitForRequest('turn/start');
    completeTurn(firstServer, 'turn-1');
    await first;
    firstServer.exit(0);

    const second = collect(adapter, session, 'second');
    expect((await secondServer.waitForRequest('thread/resume')).params).toMatchObject({
      threadId: 'thread-1',
    });
    await secondServer.waitForRequest('turn/start');
    completeTurn(secondServer, 'turn-2');
    expect((await second).at(-1)).toMatchObject({ status: 'completed' });
  });

  it('replaces an identity-mismatched process and maps model, effort, and policy', async () => {
    const firstServer = createFakeCodexAppServer();
    const secondServer = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(firstServer, secondServer);
    const session = adapter.spawn({ cwd: '/work', model: 'gpt-old', policy: 'read-only' });

    const first = collect(adapter, session, 'first');
    await firstServer.waitForRequest('turn/start');
    completeTurn(firstServer, 'turn-1');
    await first;

    session.model = 'gpt-new';
    session.policy = 'full-access';
    session.thinking = 'ultra';
    const second = collect(adapter, session, 'second');
    const resume = await secondServer.waitForRequest('thread/resume');
    expect(resume.params).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-new',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    const start = await secondServer.waitForRequest('turn/start');
    expect(start.params).toMatchObject({
      model: 'gpt-new',
      effort: 'ultra',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    completeTurn(secondServer, 'turn-1');
    await second;
    expect(firstServer.child.killed).toBe(true);
  });

  it('routes interrupt through turn/interrupt and rejects an unknown approval id', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'wait');
    await server.waitForRequest('turn/start');
    server.notify('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-live', status: 'inProgress', items: [], error: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.interrupt(session);
    expect((await server.waitForRequest('turn/interrupt')).params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-live',
    });
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-live', status: 'interrupted', items: [], error: null },
    });
    expect((await run).at(-1)).toEqual({ type: 'run.completed', status: 'interrupted' });
    await expect(adapter.respondInteraction(session, 'nope', {})).rejects.toThrow(
      'no pending Codex request nope',
    );
  });

  it('closes an idle persistent process when the member lifecycle interrupts it', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'done');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1');
    await run;

    adapter.interrupt(session);
    expect(server.child.killed).toBe(true);
  });

  it('turns factory startup failure into a failed run', async () => {
    const adapter = new CodexAdapter({
      appServerFactory: async () => { throw new Error('codex missing'); },
    });
    const events = await collect(adapter, adapter.spawn({ cwd: '/work' }), 'hello');
    expect(events.at(-1)).toEqual({
      type: 'run.completed',
      status: 'failed',
      error: 'codex missing',
    });
  });
});
// harn:end codex-app-server-is-the-member-runtime

// harn:assume adapter-children-inherit-session-env ref=codex-env-regression
describe('member environment inheritance', () => {
  it('merges session values over inherited environment in every process factory context', async () => {
    const firstServer = createFakeCodexAppServer();
    const { adapter, factory } = fixtureAdapter(firstServer);
    const session = adapter.spawn({ cwd: '/work' });
    session.env = { HOME: '/codor/session-home', CODOR_TEST_SESSION_ENV: 'member-value' };
    const run = collect(adapter, session, 'hello');
    await firstServer.waitForRequest('turn/start');
    completeTurn(firstServer, 'turn-1');
    await run;

    expect(factory.contexts[0]).toMatchObject({ command: 'codex', cwd: '/work' });
    expect(factory.contexts[0]!.env).toMatchObject({
      HOME: '/codor/session-home',
      PATH: process.env.PATH,
      CODOR_TEST_SESSION_ENV: 'member-value',
    });
  });
});
// harn:end adapter-children-inherit-session-env

describe('manual compaction', () => {
  /**
   * thread/compact/start returns {} immediately and the real work happens as a
   * STANDALONE native turn, so turn/completed is the authority. Shapes here are
   * the installed 0.144.5 ones: item notifications carry threadId and turnId,
   * with top-level startedAtMs and completedAtMs respectively; token usage
   * carries turnId. thread/compacted is
   * exactly {threadId, turnId} — compatibility evidence, never a usage carrier.
   */
  const COMPACT_TURN = 'compact-turn';

  const startCompactTurn = (server: FakeCodexAppServer, turnId = COMPACT_TURN): void => {
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: turnId } });
    server.notify('item/started', {
      threadId: 'thread-1',
      turnId,
      startedAtMs: 1_000,
      item: { type: 'contextCompaction', id: `${turnId}-item` },
    });
  };

  const finishCompactItem = (server: FakeCodexAppServer, turnId = COMPACT_TURN): void => {
    server.notify('item/completed', {
      threadId: 'thread-1',
      turnId,
      completedAtMs: 2_000,
      item: { type: 'contextCompaction', id: `${turnId}-item` },
    });
  };

  const reportUsage = (
    server: FakeCodexAppServer, usedTokens: number, turnId = COMPACT_TURN,
  ): void => {
    server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId,
      tokenUsage: {
        modelContextWindow: 200_000,
        last: { inputTokens: 10, outputTokens: 1, totalTokens: usedTokens },
      },
    });
  };

  const endTurn = (
    server: FakeCodexAppServer,
    status: 'completed' | 'failed' | 'interrupted' = 'completed',
    turnId = COMPACT_TURN,
  ): void => {
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: turnId, status, items: [],
        error: status === 'failed' ? { message: 'compaction blew up' } : null,
      },
    });
  };

  const ranOneTurn = async (server: FakeCodexAppServer): Promise<{
    adapter: CodexAdapter; session: Session;
  }> => {
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: process.cwd(), policy: 'read-only' });
    const events = collect(adapter, session, 'first');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1', 'first turn done');
    await events;
    return { adapter, session };
  };

  const compactServer = () =>
    createFakeCodexAppServer({ 'thread/compact/start': () => ({}) });

  it('runs the native compact turn and returns its correlated re-baseline', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    await server.waitForRequest('thread/compact/start');
    startCompactTurn(server);
    reportUsage(server, 8_000);
    finishCompactItem(server);
    server.notify('thread/compacted', { threadId: 'thread-1', turnId: COMPACT_TURN });
    endTurn(server);

    await expect(pending).resolves.toEqual(
      expect.objectContaining({ contextWindowUsedTokens: 8_000, contextWindowMaxTokens: 200_000 }),
    );
  });

  it('ignores another turn\u2019s usage and completion while a compact is pending', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    await server.waitForRequest('thread/compact/start');

    // The unrelated turn starts FIRST, so binding to the earliest turn/started
    // would adopt it — identity has to come from the canonical item instead.
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'unrelated-turn' } });
    startCompactTurn(server);

    // Unrelated traffic on the same thread must neither poison the re-baseline
    // nor settle this compaction.
    reportUsage(server, 199_000, 'unrelated-turn');
    server.notify('item/completed', {
      threadId: 'thread-1', turnId: 'unrelated-turn', completedAtMs: 1_500,
      item: { type: 'agentMessage', id: 'unrelated-item' },
    });
    endTurn(server, 'completed', 'unrelated-turn');

    reportUsage(server, 8_000);
    finishCompactItem(server);
    endTurn(server);

    await expect(pending).resolves.toEqual(
      expect.objectContaining({ contextWindowUsedTokens: 8_000 }),
    );
  });

  it('resolves undefined when the compact turn reports no usage', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    await server.waitForRequest('thread/compact/start');
    startCompactTurn(server);
    finishCompactItem(server);
    server.notify('thread/compacted', { threadId: 'thread-1', turnId: COMPACT_TURN });
    endTurn(server);

    await expect(pending).resolves.toBeUndefined();
  });

  it('refuses to call a turn that compacted nothing a success', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    const assertion = expect(pending).rejects
      .toThrow(/completed without compacting anything/);
    await server.waitForRequest('thread/compact/start');
    startCompactTurn(server);
    reportUsage(server, 8_000);
    endTurn(server); // terminal, but the canonical item never completed
    await assertion;
  });

  it('rejects when the compact turn ends failed, reporting no re-baseline', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    const assertion = expect(pending).rejects.toThrow(/Codex compaction failed: compaction blew up/);
    await server.waitForRequest('thread/compact/start');
    startCompactTurn(server);
    reportUsage(server, 8_000);
    finishCompactItem(server);
    endTurn(server, 'failed');
    await assertion;
  });

  it('rejects on timeout, and leaves the session able to compact again', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);
    vi.useFakeTimers();
    try {
      const timedOut = adapter.compactSession(session);
      const assertion = expect(timedOut).rejects.toThrow(/Codex compaction timed out/);
      await vi.advanceTimersByTimeAsync(180_000);
      await assertion;

      // Cleanup is proven by the NEXT compaction succeeding, not by the first
      // rejection: a leaked pending would refuse this outright.
      const second = adapter.compactSession(session);
      await server.waitForRequest('thread/compact/start', 2);
      startCompactTurn(server, 'second-compact');
      reportUsage(server, 5_000, 'second-compact');
      finishCompactItem(server, 'second-compact');
      endTurn(server, 'completed', 'second-compact');
      await expect(second).resolves.toEqual(
        expect.objectContaining({ contextWindowUsedTokens: 5_000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the pending compaction when the app-server client closes', async () => {
    const server = compactServer();
    const { adapter, session } = await ranOneTurn(server);

    const pending = adapter.compactSession(session);
    const assertion = expect(pending).rejects.toThrow(/exited/);
    await server.waitForRequest('thread/compact/start');
    server.exit(0, null);
    await assertion;
  });
});

// harn:assume normalized-agent-task-updates-are-bounded-and-authoritative ref=codex-plan-task-routing-regression
describe('Codex turn/plan/updated thread routing', () => {
  it('routes an active-turn plan only for the retained thread', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work' });
    const run = collect(adapter, session, 'start');
    await server.waitForRequest('turn/start');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } });
    // A foreign-thread plan notification is dropped before reaching the translator.
    server.notify('turn/plan/updated', { threadId: 'thread-OTHER', turnId: 'turn-1', plan: [{ step: 'Leaked', status: 'pending' }] });
    // A threadless plan must not slip through on turnId alone.
    server.notify('turn/plan/updated', { turnId: 'turn-1', plan: [{ step: 'Threadless', status: 'pending' }] });
    // The retained-thread active-turn plan is projected.
    server.notify('turn/plan/updated', { threadId: 'thread-1', turnId: 'turn-1', plan: [{ step: 'Design', status: 'inProgress' }] });
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } });
    const events = await run;
    const tasks = events.filter((event) => event.type === 'run.tasks');
    expect(tasks).toHaveLength(1);
    expect((tasks[0] as { update: unknown }).update).toEqual({ op: 'replace', items: [{ id: 'plan-0', content: 'Design', status: 'in_progress' }] });
  });
});
// harn:end normalized-agent-task-updates-are-bounded-and-authoritative

function drive(
  adapter: CodexAdapter,
  session: Session,
  payload: string,
  hooks: Parameters<CodexAdapter['deliver']>[2] = {},
): { events: WireEvent[]; done: Promise<WireEvent[]> } {
  const events: WireEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.deliver(session, payload, hooks)) events.push(event);
    return events;
  })();
  return { events, done };
}

async function until<T>(fn: () => T | undefined, tries = 200): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('until: condition never became truthy');
}

function approvalCards(events: WireEvent[]): Extract<WireEvent, { type: 'approval.raised' }>['card'][] {
  return events
    .filter((event): event is Extract<WireEvent, { type: 'approval.raised' }> => event.type === 'approval.raised')
    .map((event) => event.card);
}

// Establish the active turn id so the stricter guard (a non-null turnId must
// exactly match the established id) accepts approvals for turn-1.
async function establishTurn(server: FakeCodexAppServer, events: WireEvent[], turnId = 'turn-1'): Promise<void> {
  server.notify('turn/started', {
    threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [], error: null },
  });
  server.notify('item/completed', {
    threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `est-${turnId}`, text: 'working' },
  });
  await until(() => (events.length > 0 ? true : undefined));
}

// harn:assume codex-bridges-command-and-file-approvals ref=codex-cmdfile-regression
describe('Codex runtime approval bridging', () => {
  it('bridges a command approval to a card and returns accept on allow-once', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const decision = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', approvalId: 'appr-1',
      command: 'curl https://example.com', availableDecisions: ['accept', 'acceptForSession', 'decline'],
    });
    const card = await until(() => approvalCards(events)[0]);
    expect(card.interaction_id).toBe('appr-1');
    expect(card.kind).toBe('approval');
    expect(card.detail).toBe('curl https://example.com');
    expect(card.options?.map((o) => o.label)).toEqual(['allow once', 'allow for this session', 'deny']);
    await adapter.respondInteraction(session, 'appr-1', 'allow once');
    expect(await decision).toEqual({ decision: 'accept' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('bridges a file-change approval and returns acceptForSession on allow-for-session', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const decision = server.request('item/fileChange/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', reason: 'write outside workspace',
    });
    const card = await until(() => approvalCards(events).find((c) => c.interaction_id === 'file-1'));
    expect(card.tool).toBe('apply_patch');
    expect(card.options?.map((o) => o.label)).toContain('allow for this session');
    await adapter.respondInteraction(session, 'file-1', 'allow for this session');
    expect(await decision).toEqual({ decision: 'acceptForSession' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('omits allow-for-session when the command does not advertise it, and denies map to decline', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const decision = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'ls',
      availableDecisions: ['accept', 'decline'],
    });
    const card = await until(() => approvalCards(events).find((c) => c.interaction_id === 'item-1'));
    expect(card.options?.map((o) => o.label)).toEqual(['allow once', 'deny']);
    await adapter.respondInteraction(session, 'item-1', 'deny');
    expect(await decision).toEqual({ decision: 'decline' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('resolves two concurrent approvals independently by native id', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const first = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', approvalId: 'a1', command: 'one',
    });
    const second = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', approvalId: 'a2', command: 'two',
    });
    await until(() => (approvalCards(events).length === 2 ? true : undefined));
    await adapter.respondInteraction(session, 'a2', 'deny');
    await adapter.respondInteraction(session, 'a1', 'allow once');
    expect(await first).toEqual({ decision: 'accept' });
    expect(await second).toEqual({ decision: 'decline' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('declines a stale approval whose turnId does not match the active turn', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    // A stale approval names an OLD turn; the active turn is turn-1.
    await expect(server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-OLD', itemId: 'item-1', command: 'stale',
    })).resolves.toEqual({ decision: 'decline' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('declines an approval bearing a turnId while the turn id is still the placeholder', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    // No turn/started yet: turn.turnId is the pre-turn placeholder (undefined). A
    // request that names a turnId cannot match it and must be declined, not parked.
    await expect(server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'early',
    })).resolves.toEqual({ decision: 'decline' });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('declines an approval that arrives with no active turn', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1', 'DONE');
    await done; // turn is over; runtime.active is null but the client persists
    await expect(server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'late',
    })).resolves.toEqual({ decision: 'decline' });
  });

  it('cancels a pending approval when the turn is interrupted', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const decision = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'blocking',
    });
    await until(() => approvalCards(events).find((c) => c.interaction_id === 'item-1'));
    adapter.interrupt(session);
    expect(await decision).toEqual({ decision: 'cancel' });
    await done;
  });

  it('cancels a pending approval when the app-server dies', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const decision = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'blocking',
    });
    await until(() => approvalCards(events).find((c) => c.interaction_id === 'item-1'));
    server.exit(1, null, 'boom');
    expect(await decision).toEqual({ decision: 'cancel' });
    await done;
  });

  it('answers the still-unbridged requestUserInput with an immediate error', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await expect(server.request('item/tool/requestUserInput', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'q-1', questions: [], autoResolutionMs: null,
    })).rejects.toThrow(/Unsupported server request/);
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });
});
// harn:end codex-bridges-command-and-file-approvals

// harn:assume codex-bridges-permissions-and-url-elicitation ref=codex-permelic-regression
describe('Codex permissions bridging', () => {
  const requested = {
    network: { enabled: true },
    fileSystem: { read: ['/etc'], write: ['/tmp/out'], entries: [{ path: '/srv', mode: 'rw' }], globScanMaxDepth: 3 },
  };
  async function firePermissions(answer: string): Promise<unknown> {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const response = server.request('item/permissions/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'perm-1', cwd: '/work',
      reason: 'needs network + write', permissions: requested,
    });
    const card = await until(() => approvalCards(events).find((c) => c.tool === 'permissions'));
    // The card discloses the FULL requested profile.
    expect(card.detail).toContain('network access');
    expect(card.detail).toContain('read: /etc');
    expect(card.detail).toContain('write: /tmp/out');
    expect(card.detail).toContain('entries');
    expect(card.detail).toContain('globScanMaxDepth: 3');
    await adapter.respondInteraction(session, card.interaction_id, answer);
    const value = await response;
    completeTurn(server, 'turn-1', 'DONE');
    await done;
    return value;
  }

  it('allow-once grants the requested profile with turn scope', async () => {
    expect(await firePermissions('allow once')).toEqual({
      permissions: requested, scope: 'turn', strictAutoReview: false,
    });
  });

  it('allow-for-session grants the requested profile with session scope and no strictAutoReview', async () => {
    expect(await firePermissions('allow for this session')).toEqual({
      permissions: requested, scope: 'session',
    });
  });

  it('deny grants an empty turn profile', async () => {
    expect(await firePermissions('deny')).toEqual({ permissions: {}, scope: 'turn', strictAutoReview: false });
  });

  it('grants an empty profile when no turn is active', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1', 'DONE');
    await done;
    await expect(server.request('item/permissions/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'perm-1', cwd: '/work', permissions: requested,
    })).resolves.toEqual({ permissions: {}, scope: 'turn', strictAutoReview: false });
  });

  it('grants an empty profile when the turn is interrupted', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const response = server.request('item/permissions/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'perm-1', cwd: '/work', permissions: requested,
    });
    await until(() => approvalCards(events).find((c) => c.tool === 'permissions'));
    adapter.interrupt(session);
    expect(await response).toEqual({ permissions: {}, scope: 'turn', strictAutoReview: false });
    await done;
  });
});

describe('Codex url-elicitation bridging', () => {
  async function fireUrlElicitation(url: string, answer: string): Promise<{ card?: AskCard; value: unknown }> {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const response = server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'acme-mcp', mode: 'url',
      message: 'Authorize the connector', url, elicitationId: 'elic-xyz',
    });
    const card = await until(() => approvalCards(events).find((c) => c.tool === 'mcp_elicitation'), 60);
    await adapter.respondInteraction(session, card.interaction_id, answer);
    const value = await response;
    completeTurn(server, 'turn-1', 'DONE');
    await done;
    return { card, value };
  }

  it('accepts an https url and returns action:accept with the pinned shape', async () => {
    const { card, value } = await fireUrlElicitation('https://acme.example.com/oauth', 'mark completed');
    expect(card?.detail).toContain('acme-mcp');
    expect(card?.detail).toContain('https://acme.example.com/oauth');
    expect(card?.detail).toContain('elic-xyz'); // stable id keeps two elicitations distinct
    expect(card?.prompt).toContain('acme-mcp');
    expect(value).toEqual({ action: 'accept', content: null, _meta: null });
  });

  it('declines an https url when the operator denies', async () => {
    const { value } = await fireUrlElicitation('https://acme.example.com/oauth', 'decline');
    expect(value).toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('cancels a pending url elicitation on interrupt', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const response = server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'acme-mcp', mode: 'url',
      message: 'Authorize', url: 'https://acme.example.com/x', elicitationId: 'e1',
    });
    await until(() => approvalCards(events).find((c) => c.tool === 'mcp_elicitation'));
    adapter.interrupt(session);
    expect(await response).toEqual({ action: 'cancel', content: null, _meta: null });
    await done;
  });

  it('parks a null-turnId elicitation on the active turn', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    const response = server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: null, serverName: 'acme-mcp', mode: 'url',
      message: 'Authorize', url: 'https://acme.example.com/y', elicitationId: 'e2',
    });
    const card = await until(() => approvalCards(events).find((c) => c.tool === 'mcp_elicitation'));
    await adapter.respondInteraction(session, card.interaction_id, 'mark completed');
    expect(await response).toEqual({ action: 'accept', content: null, _meta: null });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('cancels a null-turnId elicitation that arrives with no active turn', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    completeTurn(server, 'turn-1', 'DONE');
    await done;
    await expect(server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: null, serverName: 'acme-mcp', mode: 'url',
      url: 'https://acme.example.com/z', elicitationId: 'e3',
    })).resolves.toEqual({ action: 'cancel', content: null, _meta: null });
  });

  it('declines form and openai/form modes immediately', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    await expect(server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'acme-mcp', mode: 'form',
      message: 'Fill', requestedSchema: { type: 'object', properties: {} },
    })).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    await expect(server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'acme-mcp', mode: 'openai/form',
      message: 'Fill', requestedSchema: {},
    })).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });

  it('declines unsafe urls (non-https, hostless, or credentialed)', async () => {
    const server = createFakeCodexAppServer();
    const { adapter } = fixtureAdapter(server);
    const session = adapter.spawn({ cwd: '/work', policy: 'workspace-write' });
    const { events, done } = drive(adapter, session, 'go');
    await server.waitForRequest('turn/start');
    await establishTurn(server, events);
    for (const url of ['http://acme.example.com/x', 'https://user:pass@acme.example.com/x', 'not a url', 'ftp://acme.example.com']) {
      await expect(server.request('mcpServer/elicitation/request', {
        threadId: 'thread-1', turnId: 'turn-1', serverName: 'acme-mcp', mode: 'url', url, elicitationId: 'bad',
      })).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    }
    completeTurn(server, 'turn-1', 'DONE');
    await done;
  });
});
// harn:end codex-bridges-permissions-and-url-elicitation
