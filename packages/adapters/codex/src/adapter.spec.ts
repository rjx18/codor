import type { Session, WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

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
  it('maps canonical policy to no runtime approvals and exact 0.144.5 sandbox shapes', () => {
    expect(codexPolicyOptions('read-only')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly' },
    });
    expect(codexPolicyOptions('workspace-write')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
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
    await expect(server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'unexpected',
    })).resolves.toEqual({ decision: 'decline' });
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
      agent_usage: usage,
    });
  });

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
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    await server.waitForRequest('turn/start');
    server.notify('turn/completed', {
      threadId: 'rollout-existing',
      turn: { id: 'turn-1', status: 'completed', items: [], error: null },
    });
    expect((await run).at(-1)).toMatchObject({ status: 'completed' });
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

  it('routes interrupt through turn/interrupt without creating runtime approvals', async () => {
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
      'approvals=spawn-time',
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
