import type {
  HookCallback,
  HookJSONOutput,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Session, WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_THINKING_LEVELS,
  ClaudeCodeAdapter,
  claudePermissionMode,
} from './adapter.js';
import type { ClaudeQueryFactory, ClaudeQueryInput } from './query.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const message = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;
const init = () => message({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  model: 'claude-sonnet-4-6',
  permissionMode: 'default',
});
const result = (text: string) => message({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  session_id: SESSION_ID,
  usage: { input_tokens: 1, output_tokens: 1 },
});

interface MockQueryRecord {
  input: ClaudeQueryInput;
  query: Query;
  interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

function queryFactory(
  script: (input: ClaudeQueryInput, call: number) => AsyncGenerator<SDKMessage, void>,
  records: MockQueryRecord[],
  onInterrupt?: (call: number) => Promise<void>,
): ClaudeQueryFactory {
  return ((input: ClaudeQueryInput) => {
    const call = records.length;
    const generator = script(input, call);
    const interrupt = vi.fn(async () => await onInterrupt?.(call));
    const close = vi.fn(() => undefined);
    const query = Object.assign(generator, { interrupt, close }) as unknown as Query;
    records.push({ input, query, interrupt, close });
    return query;
  }) as ClaudeQueryFactory;
}

async function collect(iterable: AsyncIterable<WireEvent>): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const cleanups: Array<() => void> = [];

function tracked(adapter: ClaudeCodeAdapter, session: Session): Session {
  cleanups.push(() => adapter.interrupt(session));
  return session;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// harn:assume claude-agent-sdk-query-is-the-session-runtime ref=claude-sdk-session-regression
describe('Claude Agent SDK query lifecycle', () => {
  it('serves multiple turns through one streaming query and maps native options', async () => {
    const records: MockQueryRecord[] = [];
    const users: SDKUserMessage[] = [];
    const factory = queryFactory(async function* (input) {
      let turn = 0;
      for await (const user of input.prompt) {
        users.push(user);
        if (turn++ === 0) yield init();
        yield message({
          type: 'assistant',
          session_id: SESSION_ID,
          message: {
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: `reply ${String(turn)}` }],
            usage: { input_tokens: turn, cache_read_input_tokens: 10, output_tokens: 1 },
          },
        });
        yield result(`done ${String(turn)}`);
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({
      cwd: process.cwd(),
      model: 'sonnet',
      policy: 'full-access',
      thinking: 'ultracode',
    }));
    session.env = { CODOR_MEMBER_ID: 'member-1', CODOR_TEST_SESSION_ENV: 'member-value' };
    const lifecycle: string[] = [];

    const first = await collect(adapter.deliver(session, 'first', {
      onStarted: () => lifecycle.push('started'),
      onSessionRef: (ref) => lifecycle.push(`session:${ref}`),
    }));
    const second = await collect(adapter.deliver(session, 'second', {
      onStarted: () => lifecycle.push('started'),
    }));

    expect(records).toHaveLength(1);
    expect(users.map((user) => user.message.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ]);
    expect(first.at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', final_text: 'done 1',
    });
    expect(second.at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', final_text: 'done 2',
    });
    expect(lifecycle).toEqual(['started', `session:${SESSION_ID}`, 'started']);
    expect(records[0]!.input.options).toMatchObject({
      cwd: process.cwd(),
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      thinking: { type: 'adaptive' },
      effort: 'xhigh',
      settings: { ultracode: true },
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: { CODOR_TEST_SESSION_ENV: 'member-value' },
    });
    expect(records[0]!.input.options).not.toHaveProperty('resume');
  });

  it('recreates a crashed query and resumes the captured native session', async () => {
    const records: MockQueryRecord[] = [];
    const factory = queryFactory(async function* (input, call) {
      for await (const _user of input.prompt) {
        if (call === 0) {
          yield init();
          throw new Error('mock SDK process crashed');
        }
        yield result('recovered');
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));

    const failed = await collect(adapter.deliver(session, 'crash'));
    const recovered = await collect(adapter.deliver(session, 'retry'));

    expect(failed.at(-1)).toEqual({
      type: 'run.completed',
      status: 'failed',
      error: 'mock SDK process crashed',
    });
    expect(recovered.at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', final_text: 'recovered',
    });
    expect(records).toHaveLength(2);
    expect(records[1]!.input.options.resume).toBe(SESSION_ID);
  });

  it('recreates a query that exits between turns and resumes instead of hanging', async () => {
    const records: MockQueryRecord[] = [];
    const factory = queryFactory(async function* (input, call) {
      for await (const _user of input.prompt) {
        if (call === 0) yield init();
        yield result(call === 0 ? 'first' : 'second');
        return;
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));

    expect((await collect(adapter.deliver(session, 'one'))).at(-1)).toMatchObject({
      final_text: 'first',
    });
    await vi.waitFor(() => expect(records[0]!.query.next).toBeDefined());
    expect((await collect(adapter.deliver(session, 'two'))).at(-1)).toMatchObject({
      final_text: 'second',
    });

    expect(records).toHaveLength(2);
    expect(records[1]!.input.options.resume).toBe(SESSION_ID);
  });

  it('restarts the runtime on member option changes without losing the conversation', async () => {
    const records: MockQueryRecord[] = [];
    const factory = queryFactory(async function* (input, call) {
      for await (const _user of input.prompt) {
        if (call === 0) yield init();
        yield result(call === 0 ? 'old options' : 'new options');
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const firstSession = tracked(adapter, adapter.spawn({
      cwd: process.cwd(), model: 'haiku', policy: 'read-only', thinking: 'low',
    }));
    firstSession.env = { CODOR_MEMBER_ID: 'stable-member', CODOR_MEMBER_TOKEN: 'old' };
    await collect(adapter.deliver(firstSession, 'one'));

    const nextSession = tracked(adapter, adapter.attach(SESSION_ID));
    nextSession.cwd = process.cwd();
    nextSession.model = 'opus';
    nextSession.policy = 'workspace-write';
    nextSession.thinking = 'high';
    nextSession.env = { CODOR_MEMBER_ID: 'stable-member', CODOR_MEMBER_TOKEN: 'new' };
    const events = await collect(adapter.deliver(nextSession, 'two'));

    expect(events.at(-1)).toMatchObject({ final_text: 'new options' });
    expect(records).toHaveLength(2);
    expect(records[0]!.interrupt).toHaveBeenCalledOnce();
    expect(records[1]!.input.options).toMatchObject({
      resume: SESSION_ID,
      model: 'opus',
      permissionMode: 'acceptEdits',
      effort: 'high',
      env: { CODOR_MEMBER_TOKEN: 'new' },
    });
  });

  it('routes interrupt through query.interrupt and completes the active turn', async () => {
    const records: MockQueryRecord[] = [];
    let release: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = queryFactory(async function* (input) {
      for await (const _user of input.prompt) {
        await stopped;
        return;
      }
    }, records, async () => release?.());
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));
    const delivery = collect(adapter.deliver(session, 'wait'));
    await vi.waitFor(() => expect(records).toHaveLength(1));

    adapter.interrupt(session);

    expect((await delivery).at(-1)).toEqual({
      type: 'run.completed', status: 'interrupted',
    });
    await vi.waitFor(() => expect(records[0]!.interrupt).toHaveBeenCalledOnce());
    expect(records[0]!.close).toHaveBeenCalledOnce();
  });

  it('retires a query when turn-start journaling fails before the pump starts', async () => {
    const records: MockQueryRecord[] = [];
    const factory = queryFactory(async function* (input, call) {
      for await (const _user of input.prompt) {
        yield result(call === 0 ? 'must not run' : 'recovered');
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.attach(SESSION_ID));
    session.cwd = process.cwd();

    const failed = await collect(adapter.deliver(session, 'first', {
      onStarted: () => {
        throw new Error('could not journal run start');
      },
    }));
    const recovered = await collect(adapter.deliver(session, 'second'));

    expect(failed.at(-1)).toEqual({
      type: 'run.completed', status: 'failed', error: 'could not journal run start',
    });
    expect(records[0]!.interrupt).toHaveBeenCalledOnce();
    expect(records[0]!.close).toHaveBeenCalledOnce();
    expect(records).toHaveLength(2);
    expect(records[1]!.input.options.resume).toBe(SESSION_ID);
    expect(recovered.at(-1)).toMatchObject({ final_text: 'recovered' });
  });

  it('maps every canonical policy and declared thinking level before query creation', () => {
    expect(claudePermissionMode('read-only')).toBe('plan');
    expect(claudePermissionMode('workspace-write')).toBe('acceptEdits');
    expect(claudePermissionMode('full-access')).toBe('bypassPermissions');
    expect(CLAUDE_THINKING_LEVELS).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultracode',
    ]);
    const adapter = new ClaudeCodeAdapter({
      queryFactory: (() => {
        throw new Error('must not launch');
      }) as ClaudeQueryFactory,
    });
    expect(() => adapter.spawn({ cwd: '/work', policy: 'yolo' }))
      .toThrow('valid policies: read-only, workspace-write, full-access');
    expect(() => adapter.spawn({ cwd: '/work', thinking: 'ultra' }))
      .toThrow("does not support thinking level 'ultra'");
  });
});
// harn:end claude-agent-sdk-query-is-the-session-runtime

// harn:assume claude-sdk-permissions-back-codor-interactions ref=claude-sdk-permission-regression
describe('Agent SDK permission callbacks', () => {
  it('backs ask/allow/deny cards with the pending canUseTool resolver', async () => {
    const records: MockQueryRecord[] = [];
    const resolutions: PermissionResult[] = [];
    const factory = queryFactory(async function* (queryInput) {
      for await (const _user of queryInput.prompt) {
        const canUseTool = queryInput.options.canUseTool!;
        const signal = new AbortController().signal;
        if (resolutions.length === 0) {
          resolutions.push(await canUseTool('AskUserQuestion', {
            questions: [{
              question: 'Which codeword?',
              options: [{ label: 'ALPHA', description: 'first' }],
              multiSelect: false,
            }],
          }, { signal, toolUseID: 'ask-1' }));
        } else if (resolutions.length === 1) {
          resolutions.push(await canUseTool('Bash', { command: 'pnpm test' }, {
            signal,
            toolUseID: 'bash-1',
            title: 'Run tests?',
            suggestions: [{
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
              behavior: 'allow',
              destination: 'session',
            }],
          }));
        } else {
          resolutions.push(await canUseTool('Write', { file_path: 'secret' }, {
            signal,
            toolUseID: 'write-1',
          }));
        }
        yield result(`permission ${String(resolutions.length)}`);
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));

    const answer = async (payload: string, choice: unknown): Promise<WireEvent[]> => {
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(session, payload)) {
        events.push(event);
        if (event.type === 'ask.raised' || event.type === 'approval.raised') {
          await adapter.respondInteraction(session, event.card.interaction_id, choice);
        }
      }
      return events;
    };

    const asked = await answer('ask', 'ALPHA');
    const allowed = await answer('allow', 'allow always');
    const denied = await answer('deny', 'deny');

    expect(asked).toContainEqual(expect.objectContaining({
      type: 'ask.raised',
      card: expect.objectContaining({ prompt: 'Which codeword?', kind: 'ask' }),
    }));
    expect(allowed).toContainEqual(expect.objectContaining({
      type: 'approval.raised',
      card: expect.objectContaining({ prompt: 'Run tests?', tool: 'Bash' }),
    }));
    expect(denied).toContainEqual(expect.objectContaining({
      type: 'approval.raised',
      card: expect.objectContaining({ tool: 'Write' }),
    }));
    expect(resolutions).toEqual([
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: expect.objectContaining({ answers: { 'Which codeword?': 'ALPHA' } }),
      }),
      expect.objectContaining({
        behavior: 'allow',
        updatedPermissions: [expect.objectContaining({ type: 'addRules' })],
      }),
      { behavior: 'deny', message: 'denied by codor operator' },
    ]);
    expect(records).toHaveLength(1);
  });

  it('rejects a pending SDK permission when the query crashes', async () => {
    const records: MockQueryRecord[] = [];
    let permission: Promise<PermissionResult> | undefined;
    const factory = queryFactory(async function* (input) {
      for await (const _user of input.prompt) {
        permission = input.options.canUseTool!('Bash', { command: 'false' }, {
          signal: new AbortController().signal,
          toolUseID: 'bash-crash',
        });
        void permission.catch(() => undefined);
        throw new Error('query vanished');
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));

    const events = await collect(adapter.deliver(session, 'crash during approval'));

    expect(events).toContainEqual(expect.objectContaining({ type: 'approval.raised' }));
    await expect(permission).rejects.toThrow('query vanished');
    expect(events.at(-1)).toEqual({
      type: 'run.completed', status: 'failed', error: 'query vanished',
    });
  });
});
// harn:end claude-sdk-permissions-back-codor-interactions

// harn:assume claude-sdk-hooks-are-authoritative ref=claude-sdk-hook-regression
// harn:assume live-inbox-capability-is-evidence-backed ref=claude-live-inbox-regression
describe('Agent SDK hooks', () => {
  it('emits extension lifecycle and returns PostToolUse inbox context', async () => {
    const records: MockQueryRecord[] = [];
    const inbox = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse' as const,
        additionalContext: 'Codor inbox:\n#2 from @beta\nanswer',
      },
    }));
    let postToolOutput: HookJSONOutput | undefined;
    const factory = queryFactory(async function* (input) {
      for await (const _user of input.prompt) {
        const hooks = input.options.hooks!;
        const invoke = async (name: 'SubagentStart' | 'SubagentStop', value: object) => {
          const callback = hooks[name]![0]!.hooks[0] as HookCallback;
          await callback(value as never, undefined, { signal: new AbortController().signal });
        };
        await invoke('SubagentStart', {
          hook_event_name: 'SubagentStart',
          agent_id: 'agent-7',
          agent_type: 'Explore',
          session_id: SESSION_ID,
        });
        const postToolUse = hooks.PostToolUse![0]!.hooks[0] as HookCallback;
        postToolOutput = await postToolUse({
          hook_event_name: 'PostToolUse',
          session_id: SESSION_ID,
          transcript_path: '/tmp/transcript',
          cwd: process.cwd(),
          tool_name: 'Read',
          tool_input: {},
          tool_response: {},
          tool_use_id: 'read-1',
        }, 'read-1', { signal: new AbortController().signal });
        await invoke('SubagentStop', {
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-7',
          agent_type: 'Explore',
          session_id: SESSION_ID,
          agent_transcript_path: '/tmp/agent',
          stop_hook_active: false,
        });
        yield result('hooked');
      }
    }, records);
    const adapter = new ClaudeCodeAdapter({ queryFactory: factory, inboxHookRunner: inbox });
    const session = tracked(adapter, adapter.spawn({ cwd: process.cwd() }));
    session.env = { CODOR_MEMBER_ID: 'member-hooks', CODOR_TEST_SESSION_ENV: 'member-value' };

    const events = await collect(adapter.deliver(session, 'hooks'));

    expect(events).toContainEqual({
      type: 'extension.started',
      parent: SESSION_ID,
      ext_member: 'agent-7',
      agent_type: 'Explore',
      transcript_path: undefined,
    });
    expect(events).toContainEqual({
      type: 'extension.ended',
      ext_member: 'agent-7',
      summary: undefined,
      transcript_path: '/tmp/agent',
    });
    expect(inbox).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      env: expect.objectContaining({ CODOR_TEST_SESSION_ENV: 'member-value' }),
    }));
    expect(postToolOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Codor inbox:\n#2 from @beta\nanswer',
      },
    });
    expect(records[0]!.input.options).not.toHaveProperty('settingsPath');
  });
});
// harn:end live-inbox-capability-is-evidence-backed
// harn:end claude-sdk-hooks-are-authoritative
