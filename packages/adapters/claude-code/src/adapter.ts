import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentLimit,
  AgentUsage,
  AdapterTurnHooks,
  AskCard,
  HarnessAdapter,
  ModelCatalog,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema, ThinkingLevelSchema } from '@codor/protocol';

import { probeClaudeLimits } from './limits-probe.js';
import { peekClaudeContextUsage } from './peek.js';
import {
  claudeQuery,
  type ClaudeOptions,
  type ClaudeQueryFactory,
} from './query.js';
import {
  claudeContextWindow,
  createTurnTranslator,
  type ClaudeTranslatorContext,
  type HookPayload,
  wireEventFromHook,
} from './translate.js';

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const CLAUDE_SETTING_SOURCES: NonNullable<ClaudeOptions['settingSources']> = [
  'user',
  'project',
  'local',
];

// harn:assume harness-declares-supported-thinking-levels ref=claude-thinking-level-declaration
export const CLAUDE_THINKING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
] as const satisfies readonly import('@codor/protocol').ThinkingLevel[];

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}

function assertThinkingLevel(
  thinking: import('@codor/protocol').ThinkingLevel | undefined,
): void {
  if (thinking === undefined) return;
  if (!(CLAUDE_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(
      `adapter 'claude-code' does not support thinking level '${thinking}'; ` +
      `valid levels: ${CLAUDE_THINKING_LEVELS.join(', ')}`,
    );
  }
}
// harn:end harness-declares-supported-thinking-levels

// harn:assume canonical-spawn-controls-enforced ref=claude-spawn-control-mapping
export function claudePermissionMode(
  policy: string | undefined,
): ClaudeOptions['permissionMode'] {
  if (policy === undefined) return undefined;
  if (!PolicySchema.safeParse(policy).success) throw invalidPolicy(policy);
  return {
    'read-only': 'plan',
    'workspace-write': 'acceptEdits',
    'full-access': 'bypassPermissions',
  }[policy] as ClaudeOptions['permissionMode'];
}

function claudeThinkingOptions(
  thinking: Session['thinking'],
): Pick<ClaudeOptions, 'thinking' | 'effort' | 'settings'> {
  if (thinking === undefined) return {};
  ThinkingLevelSchema.parse(thinking);
  assertThinkingLevel(thinking);
  if (thinking === 'ultracode') {
    return {
      thinking: { type: 'adaptive' },
      effort: 'xhigh',
      settings: { ultracode: true },
    };
  }
  return {
    thinking: { type: 'adaptive' },
    effort: thinking as Exclude<Session['thinking'], 'ultra' | 'ultracode' | undefined>,
  };
}
// harn:end canonical-spawn-controls-enforced

interface AsyncMessageInput<T> {
  push(item: T): void;
  end(): void;
  readonly iterable: AsyncIterable<T>;
}

function createAsyncMessageInput<T>(): AsyncMessageInput<T> {
  const queue: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let closed = false;

  return {
    push(item) {
      if (closed) throw new Error('Claude SDK input is closed');
      const resolve = resolvers.shift();
      if (resolve) resolve({ value: item, done: false });
      else queue.push(item);
    },
    end() {
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T, void> {
        return {
          next: () => {
            const value = queue.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<T, void>>((resolve) => resolvers.push(resolve));
          },
        };
      },
    },
  };
}

interface TurnState {
  translator: ReturnType<typeof createTurnTranslator>;
  hooks: AdapterTurnHooks;
  queue: WireEvent[];
  wake: (() => void) | null;
  terminal: boolean;
  done: boolean;
  interrupted: boolean;
  reportedSessionRef?: string;
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve(result: PermissionResult): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface QueryIdentity {
  cwd: string;
  model?: string;
  policy?: string;
  thinking?: Session['thinking'];
  env: string;
}

interface ClaudeRuntime {
  session: Session;
  memberKey?: string;
  identity?: QueryIdentity;
  query: Query | null;
  input: AsyncMessageInput<SDKUserMessage> | null;
  pump: Promise<void> | null;
  retiring: Promise<void> | null;
  active: TurnState | null;
  context: ClaudeTranslatorContext;
  pendingPermissions: Map<string, PendingPermission>;
}

export interface InboxHookContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type InboxHookRunner = (
  context: InboxHookContext,
) => Promise<HookJSONOutput | undefined>;

export interface ClaudeCodeAdapterOptions {
  queryFactory?: ClaudeQueryFactory;
  inboxHookRunner?: InboxHookRunner;
}

function sortedEnvironment(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function queryIdentity(session: Session): QueryIdentity {
  return {
    cwd: session.cwd,
    model: session.model,
    policy: session.policy,
    thinking: session.thinking,
    env: sortedEnvironment({ ...process.env, ...session.env }),
  };
}

function sameIdentity(left: QueryIdentity | undefined, right: QueryIdentity): boolean {
  return left !== undefined &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.policy === right.policy &&
    left.thinking === right.thinking &&
    left.env === right.env;
}

function asQuestion(input: Record<string, unknown>): {
  question?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
} | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const first = input.questions[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const source = first as Record<string, unknown>;
  const options = Array.isArray(source.options)
    ? source.options.flatMap((value) => {
      if (typeof value !== 'object' || value === null) return [];
      const option = value as Record<string, unknown>;
      return typeof option.label === 'string'
        ? [{
          label: option.label,
          ...(typeof option.description === 'string' && { description: option.description }),
        }]
        : [];
    })
    : undefined;
  return {
    ...(typeof source.question === 'string' && { question: source.question }),
    ...(options !== undefined && { options }),
    ...(typeof source.multiSelect === 'boolean' && { multiSelect: source.multiSelect }),
  };
}

interface PermissionPromptOptions {
  title?: string;
  description?: string;
}

export function cardFromSdkPermission(
  interactionId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionPromptOptions = {},
): AskCard {
  if (toolName === 'AskUserQuestion') {
    const question = asQuestion(input);
    return {
      interaction_id: interactionId,
      kind: 'ask',
      prompt: question?.question ?? options.title ?? '',
      options: question?.options,
      multi: question?.multiSelect ?? false,
    };
  }
  const command = typeof input.command === 'string' ? input.command : undefined;
  return {
    interaction_id: interactionId,
    kind: 'approval',
    prompt: options.title ?? `Allow ${toolName}?`,
    options: [
      { label: 'allow once' },
      { label: 'allow always' },
      { label: 'deny' },
    ],
    tool: toolName,
    detail: command ?? options.description ?? JSON.stringify(input),
  };
}

function questionAnswers(
  input: Record<string, unknown>,
  answer: unknown,
): Record<string, string> {
  if (typeof answer === 'object' && answer !== null && !Array.isArray(answer)) {
    return answer as Record<string, string>;
  }
  const question = asQuestion(input)?.question ?? '';
  return {
    [question]: Array.isArray(answer) ? answer.join(', ') : String(answer ?? ''),
  };
}

function defaultInboxHookRunner(context: InboxHookContext): Promise<HookJSONOutput | undefined> {
  return new Promise((resolve, reject) => {
    // harn:assume codor-runtime-identity-is-a-clean-break ref=adapter-runtime-identity
    execFile(
      'codor',
      ['inbox', '--new', '--consume', '--format', 'hook'],
      { cwd: context.cwd, env: context.env, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const output = stdout.trim();
        if (output === '') {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(output) as HookJSONOutput);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    // harn:end codor-runtime-identity-is-a-clean-break
  });
}

/**
 * Claude Code adapter backed by one long-lived Agent SDK query per member.
 * query() owns the Claude runtime/control transport; Codor owns turn
 * normalization, durable interaction cards, and session recovery.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = 'claude-code';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: true,
    approvals: 'runtime',
    extensions: true,
    thinking: true,
    thinking_levels: CLAUDE_THINKING_LEVELS,
    // harn:assume live-inbox-capability-is-evidence-backed ref=claude-live-inbox-capability
    live_inbox: true,
    // harn:end live-inbox-capability-is-evidence-backed
    // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-declarations
    policies: {
      'read-only': 'plan',
      'workspace-write': 'acceptEdits',
      'full-access': 'bypassPermissions',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;

  private readonly runtimes = new WeakMap<Session, ClaudeRuntime>();
  private readonly memberRuntimes = new Map<string, ClaudeRuntime>();
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly inboxHookRunner: InboxHookRunner;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.queryFactory = options.queryFactory ?? ((input) => claudeQuery(input));
    this.inboxHookRunner = options.inboxHookRunner ?? defaultInboxHookRunner;
  }

  spawn(opts: SpawnOpts): Session {
    claudePermissionMode(opts.policy);
    if (opts.thinking !== undefined) {
      ThinkingLevelSchema.parse(opts.thinking);
      assertThinkingLevel(opts.thinking);
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      thinking: opts.thinking,
    };
  }

  // harn:assume adapters-own-their-model-catalog ref=claude-code-model-catalog
  listModels(): Promise<ModelCatalog> {
    return Promise.resolve({
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      source: 'curated',
    });
  }
  // harn:end adapters-own-their-model-catalog

  // harn:assume context-peek-reads-session-artifacts ref=claude-context-peek
  peekContextUsage(session_ref: SessionRef): Promise<AgentUsage | undefined> {
    return Promise.resolve(peekClaudeContextUsage(session_ref, claudeContextWindow));
  }
  // harn:end context-peek-reads-session-artifacts

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume claude-agent-sdk-query-is-the-session-runtime ref=claude-sdk-session-lifecycle
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const runtime = this.runtimeFor(session);
    await this.prepareRuntime(runtime, session);
    if (runtime.active !== null) {
      throw new Error('a Claude turn is already in flight for this member');
    }

    const turn: TurnState = {
      translator: createTurnTranslator(runtime.context),
      hooks,
      queue: [],
      wake: null,
      terminal: false,
      done: false,
      interrupted: false,
      reportedSessionRef: session.session_ref,
    };
    runtime.active = turn;

    try {
      try {
        await this.ensureQuery(runtime);
        hooks.onStarted?.({});
        this.startQueryPump(runtime);
        runtime.input!.push({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: payload }],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: session.session_ref ?? '',
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.push(turn, [{ type: 'run.completed', status: 'failed', error: detail }]);
        turn.terminal = true;
        turn.done = true;
        await this.retireQuery(runtime);
      }

      while (true) {
        if (turn.queue.length > 0) {
          yield turn.queue.shift()!;
          continue;
        }
        if (turn.done) break;
        await new Promise<void>((resolve) => {
          turn.wake = resolve;
        });
        turn.wake = null;
      }
    } finally {
      if (runtime.active === turn) runtime.active = null;
      if (!turn.terminal) {
        this.completeTurn(runtime, turn, {
          type: 'run.completed',
          status: 'interrupted',
        });
        void this.retireQuery(runtime);
      }
    }
  }

  private runtimeFor(session: Session): ClaudeRuntime {
    const existing = this.runtimes.get(session);
    if (existing !== undefined) {
      existing.session = session;
      return existing;
    }
    const memberKey = session.env?.CODOR_MEMBER_ID;
    const memberRuntime = memberKey === undefined
      ? undefined
      : this.memberRuntimes.get(memberKey);
    const runtime = memberRuntime ?? {
      session,
      ...(memberKey !== undefined && { memberKey }),
      query: null,
      input: null,
      pump: null,
      retiring: null,
      active: null,
      context: {
        ...(session.session_ref !== undefined && { sessionId: session.session_ref }),
      },
      pendingPermissions: new Map<string, PendingPermission>(),
    };
    runtime.session = session;
    this.runtimes.set(session, runtime);
    if (memberKey !== undefined) this.memberRuntimes.set(memberKey, runtime);
    return runtime;
  }

  private async prepareRuntime(runtime: ClaudeRuntime, session: Session): Promise<void> {
    if (runtime.retiring !== null) await runtime.retiring;
    const nextIdentity = queryIdentity(session);
    if (runtime.query !== null && !sameIdentity(runtime.identity, nextIdentity)) {
      await this.retireQuery(runtime);
    }
    runtime.session = session;
    runtime.context.sessionId = session.session_ref ?? runtime.context.sessionId;
    if (runtime.query === null) runtime.identity = nextIdentity;
  }

  private async ensureQuery(runtime: ClaudeRuntime): Promise<void> {
    if (runtime.retiring !== null) await runtime.retiring;
    if (runtime.query !== null) return;
    // A query that just exited clears runtime.query from inside its pump before
    // the pump's completion callback clears runtime.pump. Do not install the
    // replacement in that narrow window or startQueryPump would mistake the
    // settled, previous pump for the replacement's pump.
    if (runtime.pump !== null) await runtime.pump;
    if (runtime.query !== null) return;
    const input = createAsyncMessageInput<SDKUserMessage>();
    const query = claudeQuery(
      { prompt: input.iterable, options: this.queryOptions(runtime) },
      this.queryFactory,
    );
    runtime.input = input;
    runtime.query = query;
    runtime.identity = queryIdentity(runtime.session);
  }

  private startQueryPump(runtime: ClaudeRuntime): void {
    if (runtime.query === null || runtime.pump !== null) return;
    const pump = this.runQueryPump(runtime, runtime.query);
    runtime.pump = pump;
    void pump.finally(() => {
      if (runtime.pump === pump) runtime.pump = null;
    });
  }

  private queryOptions(runtime: ClaudeRuntime): ClaudeOptions {
    const session = runtime.session;
    const permissionMode = claudePermissionMode(session.policy);
    const extensionHook: HookCallback = async (input) => {
      const event = wireEventFromHook(input as HookPayload);
      if (event !== undefined && runtime.active !== null) this.push(runtime.active, [event]);
      return {};
    };
    // harn:assume claude-sdk-hooks-are-authoritative ref=claude-sdk-hook-callbacks
    const postToolUseHook: HookCallback = async () => {
      const current = runtime.session;
      // harn:assume live-inbox-capability-is-evidence-backed ref=claude-post-tool-use-hook
      return await this.inboxHookRunner({
        cwd: current.cwd,
        env: { ...process.env, ...current.env },
      }) ?? {};
      // harn:end live-inbox-capability-is-evidence-backed
    };
    // harn:end claude-sdk-hooks-are-authoritative

    return {
      cwd: session.cwd,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: CLAUDE_SETTING_SOURCES,
      canUseTool: this.permissionCallback(runtime),
      hooks: {
        SubagentStart: [{ hooks: [extensionHook] }],
        SubagentStop: [{ hooks: [extensionHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
      allowDangerouslySkipPermissions: true,
      ...(permissionMode !== undefined && { permissionMode }),
      ...(session.model !== undefined && { model: session.model }),
      ...(session.session_ref !== undefined && { resume: session.session_ref }),
      ...claudeThinkingOptions(session.thinking),
      // harn:assume adapter-children-inherit-session-env ref=claude-child-environment
      env: { ...process.env, ...session.env },
      // harn:end adapter-children-inherit-session-env
    };
  }

  private permissionCallback(runtime: ClaudeRuntime): CanUseTool {
    // harn:assume claude-sdk-permissions-back-codor-interactions ref=claude-sdk-permission-callback
    return async (toolName, input, options) => {
      const turn = runtime.active;
      if (turn === null || turn.done) {
        throw new Error('Claude requested permission without an active turn');
      }
      const interactionId = `permission-${randomUUID()}`;
      const card = cardFromSdkPermission(interactionId, toolName, input, options);
      this.push(turn, [
        card.kind === 'ask'
          ? { type: 'ask.raised', card }
          : { type: 'approval.raised', card },
      ]);

      return await new Promise<PermissionResult>((resolve, reject) => {
        const abort = () => {
          runtime.pendingPermissions.delete(interactionId);
          reject(new Error('Claude permission request aborted'));
        };
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener('abort', abort, { once: true });
        runtime.pendingPermissions.set(interactionId, {
          toolName,
          input,
          suggestions: options.suggestions,
          resolve,
          reject,
          cleanup: () => options.signal.removeEventListener('abort', abort),
        });
      });
    };
    // harn:end claude-sdk-permissions-back-codor-interactions
  }

  private async runQueryPump(runtime: ClaudeRuntime, query: Query): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const message of query) {
        if (runtime.query !== query) return;
        this.routeMessage(runtime, message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (runtime.query === query) {
        runtime.query = null;
        runtime.input?.end();
        runtime.input = null;
        this.rejectPendingPermissions(
          runtime,
          failure ?? new Error('Claude SDK query ended before permission resolution'),
        );
        const turn = runtime.active;
        if (turn !== null && !turn.terminal) {
          this.completeTurn(runtime, turn, turn.interrupted
            ? { type: 'run.completed', status: 'interrupted' }
            : {
              type: 'run.completed',
              status: 'failed',
              error: failure?.message ?? 'Claude SDK query ended before terminal result',
            });
        }
      }
    }
  }

  private routeMessage(runtime: ClaudeRuntime, message: SDKMessage): void {
    const turn = runtime.active;
    if (turn === null || turn.done) return;
    const events = turn.translator.push(message);
    this.push(turn, events);
    const discovered = turn.translator.sessionId();
    if (discovered !== undefined && discovered !== turn.reportedSessionRef) {
      runtime.context.sessionId = discovered;
      runtime.session.session_ref = discovered;
      turn.reportedSessionRef = discovered;
      turn.hooks.onSessionRef?.(discovered);
    }
    if (events.some((event) => event.type === 'run.completed')) {
      turn.terminal = true;
      turn.done = true;
      turn.wake?.();
    }
  }

  private push(turn: TurnState, events: WireEvent[]): void {
    if (events.length === 0) return;
    turn.queue.push(...events);
    turn.wake?.();
  }

  private completeTurn(runtime: ClaudeRuntime, turn: TurnState, event: WireEvent): void {
    if (turn.terminal) return;
    this.rejectPendingPermissions(runtime, new Error('Claude turn ended before permission resolution'));
    this.push(turn, [event]);
    turn.terminal = true;
    turn.done = true;
    turn.wake?.();
  }

  private rejectPendingPermissions(runtime: ClaudeRuntime, error: Error): void {
    for (const [id, pending] of runtime.pendingPermissions) {
      pending.cleanup();
      pending.reject(error);
      runtime.pendingPermissions.delete(id);
    }
  }

  private async retireQuery(runtime: ClaudeRuntime, removeRuntime = false): Promise<void> {
    if (runtime.retiring !== null) return await runtime.retiring;
    const query = runtime.query;
    const input = runtime.input;
    const pump = runtime.pump;
    runtime.query = null;
    runtime.input = null;
    this.rejectPendingPermissions(runtime, new Error('Claude SDK query retired'));
    const retiring = (async () => {
      if (query !== null) {
        try {
          await query.interrupt();
        } catch {
          // A crashed query is already unavailable; close/return still release it.
        }
        input?.end();
        query.close();
        try {
          await query.return?.();
        } catch {
          // The iterator may already have failed.
        }
      }
      await pump?.catch(() => undefined);
      if (removeRuntime && runtime.memberKey !== undefined) {
        this.memberRuntimes.delete(runtime.memberKey);
      }
    })();
    runtime.retiring = retiring;
    try {
      await retiring;
    } finally {
      if (runtime.retiring === retiring) runtime.retiring = null;
    }
  }
  // harn:end claude-agent-sdk-query-is-the-session-runtime

  probeLimits(): Promise<AgentLimit[] | undefined> {
    return probeClaudeLimits();
  }

  // harn:assume claude-sdk-permissions-back-codor-interactions ref=claude-sdk-permission-callback
  async respondInteraction(
    session: Session,
    interaction_id: string,
    answer: unknown,
  ): Promise<void> {
    const runtime = this.runtimes.get(session)
      ?? (session.env?.CODOR_MEMBER_ID === undefined
        ? undefined
        : this.memberRuntimes.get(session.env.CODOR_MEMBER_ID));
    const pending = runtime?.pendingPermissions.get(interaction_id);
    if (runtime === undefined || pending === undefined) {
      throw new Error(`no pending interaction ${interaction_id}`);
    }
    runtime.pendingPermissions.delete(interaction_id);
    pending.cleanup();

    if (pending.toolName === 'AskUserQuestion') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: {
          ...pending.input,
          answers: questionAnswers(pending.input, answer),
        },
      });
      return;
    }

    const choice = typeof answer === 'string' ? answer : 'deny';
    if (choice === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'denied by codor operator' });
      return;
    }
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input,
      ...(choice === 'allow always' &&
        pending.suggestions !== undefined &&
        pending.suggestions.length > 0 && {
        updatedPermissions: pending.suggestions,
      }),
    });
  }
  // harn:end claude-sdk-permissions-back-codor-interactions

  interrupt(session: Session): void {
    const runtime = this.runtimes.get(session)
      ?? (session.env?.CODOR_MEMBER_ID === undefined
        ? undefined
        : this.memberRuntimes.get(session.env.CODOR_MEMBER_ID));
    if (runtime === undefined) return;
    const turn = runtime.active;
    if (turn !== null && !turn.terminal) {
      turn.interrupted = true;
      this.completeTurn(runtime, turn, { type: 'run.completed', status: 'interrupted' });
    }
    void this.retireQuery(runtime, true);
  }

  /** Session ids from the transcript store (~/.claude/projects/<cwd-slug>/). */
  discoverSessions(): SessionRef[] {
    const refs: SessionRef[] = [];
    const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
    let projects;
    try {
      projects = readdirSync(root, { withFileTypes: true });
    } catch {
      return refs;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let files;
      try {
        files = readdirSync(join(root, project.name));
      } catch {
        continue;
      }
      for (const file of files) {
        const match = SESSION_FILE_RE.exec(file);
        if (match) refs.push(match[1]!);
      }
    }
    return refs;
  }
}
