import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  ThinkingLevel,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema, ThinkingLevelSchema } from '@codor/protocol';

import {
  CodexAppServerClient,
  type CodexAppServerFactory,
  spawnCodexAppServer,
} from './app-server-transport.js';
import { probeCodexLimits } from './limits-probe.js';
import { peekCodexContextUsage } from './peek.js';
import {
  agentUsageFromTokenUsage,
  createTurnTranslator,
  type CodexTranslatorContext,
} from './translate.js';

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// harn:assume harness-declares-supported-thinking-levels ref=codex-thinking-level-declaration
export const CODEX_THINKING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ThinkingLevel[];

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}

function assertThinkingLevel(thinking: ThinkingLevel | undefined): void {
  if (thinking === undefined) return;
  if (!(CODEX_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(
      `adapter 'codex' does not support thinking level '${thinking}'; ` +
      `valid levels: ${CODEX_THINKING_LEVELS.join(', ')}`,
    );
  }
}
// harn:end harness-declares-supported-thinking-levels

export interface CodexPolicyOptions {
  approvalPolicy: 'never' | 'on-request';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandboxPolicy:
    | { type: 'readOnly' }
    | { type: 'workspaceWrite'; networkAccess: false }
    | { type: 'dangerFullAccess' };
}

// harn:assume canonical-spawn-controls-enforced ref=codex-spawn-control-mapping
export function codexPolicyOptions(policy: string | undefined): CodexPolicyOptions {
  const selected = policy ?? 'read-only';
  if (!PolicySchema.safeParse(selected).success) throw invalidPolicy(selected);
  // Non-yolo policies use 'on-request' so Codex can ASK the operator before an
  // action its sandbox forbids (bridged to a Codor approval card). Full-access
  // stays 'never' with danger-full-access — --yolo runs unattended by design.
  if (selected === 'read-only') {
    return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
  }
  if (selected === 'workspace-write') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    };
  }
  return {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function validateThinking(thinking: ThinkingLevel | undefined): void {
  if (thinking === undefined) return;
  ThinkingLevelSchema.parse(thinking);
  assertThinkingLevel(thinking);
}
// harn:end canonical-spawn-controls-enforced

interface RuntimeIdentity {
  cwd: string;
  model?: string;
  policy?: string;
  thinking?: ThinkingLevel;
  env: string;
}

interface TurnState {
  translator: ReturnType<typeof createTurnTranslator>;
  hooks: AdapterTurnHooks;
  queue: WireEvent[];
  wake: (() => void) | null;
  terminal: boolean;
  done: boolean;
  interrupted: boolean;
  turnId?: string;
}

/**
 * A native server request parked awaiting the operator's answer. `respond`
 * maps the operator's card answer to the method's pinned response; `cancel`
 * resolves the method's teardown response. Both resolve the transport promise.
 */
interface PendingRequest {
  respond: (answer: unknown) => void;
  cancel: () => void;
}

interface CodexRuntime {
  session: Session;
  memberKey?: string;
  identity?: RuntimeIdentity;
  client: CodexAppServerClient | null;
  child: ChildProcessWithoutNullStreams | null;
  /** Disposed child retained for supervision until its exit is confirmed. */
  retiringChild: ChildProcessWithoutNullStreams | null;
  connecting: Promise<void> | null;
  active: TurnState | null;
  /** Native server requests parked by native id awaiting a Codor answer. */
  pendingRequests: Map<string, PendingRequest>;
  /** Bumped on every connect; namespaces new-method parking keys across reconnects. */
  generation: number;
  threadId?: string;
  /** Effective thread baseline reported by app-server start/resume/settings. */
  threadModel?: string;
  context: CodexTranslatorContext;
  /** An operator-requested compaction awaiting its native compact turn. */
  pendingCompaction: PendingCompaction | null;
}

const RETIREMENT_GRACE_MS = 5_000;
const RETIREMENT_CONFIRM_MS = 5_000;

function waitForRuntimeExit(
  child: ChildProcessWithoutNullStreams,
  label: string,
  timeoutMs = RETIREMENT_CONFIRM_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${label} did not exit after retirement`));
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

interface PendingCompaction {
  settle: (usage: AgentUsage | undefined) => void;
  fail: (error: Error) => void;
  /** Turn ids seen started while pending; identity is not claimed from these. */
  startedTurnIds: Set<string>;
  /** The compact turn, bound when a canonical contextCompaction item opens. */
  turnId?: string;
  /** The canonical contextCompaction item that turn opened. */
  itemId?: string;
  /** Whether that item reached completed — a turn alone does not prove work. */
  itemCompleted: boolean;
  /** The newest usage correlated to THIS compact turn. */
  usage?: AgentUsage;
  timer: NodeJS.Timeout;
}

/**
 * Manual compaction runs as a STANDALONE native turn that can legitimately take
 * minutes on a long thread; bound it so an engine that accepts the command and
 * then goes quiet surfaces as an error instead of a spinner that never stops.
 */
const COMPACTION_TIMEOUT_MS = 180_000;

export interface CodexAdapterOptions {
  command?: string;
  appServerFactory?: CodexAppServerFactory;
}

function sortedEnvironment(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function runtimeIdentity(session: Session): RuntimeIdentity {
  return {
    cwd: session.cwd,
    model: session.model,
    policy: session.policy,
    thinking: session.thinking,
    env: sortedEnvironment({ ...process.env, ...session.env }),
  };
}

function sameIdentity(left: RuntimeIdentity | undefined, right: RuntimeIdentity): boolean {
  return left !== undefined &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.policy === right.policy &&
    left.thinking === right.thinking &&
    left.env === right.env;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseId(response: unknown, key: 'thread' | 'turn'): string | undefined {
  const container = record(response)?.[key];
  const id = record(container)?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function responseModel(response: unknown): string | undefined {
  const model = record(response)?.model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

function notificationThreadId(params: unknown): string | undefined {
  const id = record(params)?.threadId;
  return typeof id === 'string' ? id : undefined;
}

/** Pinned 0.144.5 v2 approval decisions (the string variants Codor answers with). */
type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

const APPROVE_ONCE = 'allow once';
const APPROVE_SESSION = 'allow for this session';
const DENY = 'deny';

/**
 * Native correlation id for a parked approval: the request's approvalId when
 * present (zsh-exec-bridge subcommands share one itemId and disambiguate by a
 * UUID approvalId), else itemId, else a generated id so a malformed request can
 * still be answered rather than stranded.
 */
function approvalNativeId(kind: 'command' | 'file', rec: Record<string, unknown>): string {
  const approvalId = typeof rec.approvalId === 'string' && rec.approvalId !== '' ? rec.approvalId : undefined;
  const itemId = typeof rec.itemId === 'string' && rec.itemId !== '' ? rec.itemId : undefined;
  return approvalId ?? itemId ?? `codex-approval-${kind}-${randomUUID()}`;
}

function clip(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function approvalOptions(allowSession: boolean): { label: string; description?: string }[] {
  const options: { label: string; description?: string }[] = [{ label: APPROVE_ONCE }];
  if (allowSession) {
    // Honest scope: acceptForSession is cached within one live Codex thread and
    // is NOT persisted across app-server/thread recreation or resume.
    options.push({ label: APPROVE_SESSION, description: 'cached for this Codex session only, not persisted' });
  }
  options.push({ label: DENY });
  return options;
}

function approvalCard(nativeId: string, kind: 'command' | 'file', rec: Record<string, unknown>): AskCard {
  const reason = typeof rec.reason === 'string' && rec.reason !== '' ? rec.reason : undefined;
  if (kind === 'command') {
    const command = typeof rec.command === 'string' && rec.command !== '' ? rec.command : undefined;
    const available = Array.isArray(rec.availableDecisions) ? rec.availableDecisions : undefined;
    // acceptForSession is offered only when the command request advertises it.
    const allowSession = available === undefined || available.includes('acceptForSession');
    return {
      interaction_id: nativeId,
      kind: 'approval',
      prompt: command !== undefined ? `Allow Codex to run: ${clip(command)}` : 'Allow Codex to run a command?',
      options: approvalOptions(allowSession),
      tool: 'shell',
      detail: command ?? reason ?? '(command)',
    };
  }
  // File-change requests carry no availableDecisions; the fixed enum supports
  // acceptForSession, so it is always offered.
  const grantRoot = typeof rec.grantRoot === 'string' && rec.grantRoot !== '' ? rec.grantRoot : undefined;
  return {
    interaction_id: nativeId,
    kind: 'approval',
    prompt: 'Allow Codex to edit files?',
    options: approvalOptions(true),
    tool: 'apply_patch',
    detail: reason ?? (grantRoot !== undefined ? `grant write under ${grantRoot}` : '(file changes)'),
  };
}

function decisionForAnswer(answer: unknown): CodexApprovalDecision {
  if (answer === APPROVE_ONCE) return 'accept';
  if (answer === APPROVE_SESSION) return 'acceptForSession';
  return 'decline';
}

// ── permissions/requestApproval ─────────────────────────────────────────────
/** Pinned 0.144.5 permission-grant response. Empty profile = safe deny. */
type CodexPermissionResponse = {
  permissions: Record<string, unknown>;
  scope: 'turn' | 'session';
  strictAutoReview?: boolean;
};

/** Deny/no-turn/teardown: grant nothing for this turn. strictAutoReview never with session. */
function emptyGrant(): CodexPermissionResponse {
  return { permissions: {}, scope: 'turn', strictAutoReview: false };
}

/** allow-once → requested profile scope:turn; allow-for-session → scope:session; else empty. */
function permissionGrant(answer: unknown, requested: Record<string, unknown>): CodexPermissionResponse {
  if (answer === APPROVE_ONCE) return { permissions: requested, scope: 'turn', strictAutoReview: false };
  if (answer === APPROVE_SESSION) return { permissions: requested, scope: 'session' };
  return emptyGrant();
}

/** Disclose the FULL requested profile: network + every fileSystem representation. */
function permissionSummary(requested: Record<string, unknown>): string {
  const parts: string[] = [];
  const net = record(requested.network);
  if (net?.enabled === true) parts.push('network access');
  const fs = record(requested.fileSystem);
  if (fs !== undefined) {
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const read = list(fs.read);
    const write = list(fs.write);
    if (read.length > 0) parts.push(`read: ${read.join(', ')}`);
    if (write.length > 0) parts.push(`write: ${write.join(', ')}`);
    if (Array.isArray(fs.entries) && fs.entries.length > 0) {
      parts.push(`entries: ${JSON.stringify(fs.entries)}`);
    }
    if (typeof fs.globScanMaxDepth === 'number') parts.push(`globScanMaxDepth: ${fs.globScanMaxDepth}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '(no additional access requested)';
}

function permissionCard(nativeId: string, requested: Record<string, unknown>, reason: string | undefined): AskCard {
  return {
    interaction_id: nativeId,
    kind: 'approval',
    prompt: 'Allow Codex elevated permissions?',
    options: approvalOptions(true),
    tool: 'permissions',
    detail: reason !== undefined
      ? `${reason} — requests ${permissionSummary(requested)}`
      : `requests ${permissionSummary(requested)}`,
  };
}

// ── mcpServer/elicitation/request (url mode only) ────────────────────────────
type CodexElicitationResponse = { action: 'accept' | 'decline' | 'cancel'; content: null; _meta: null };

const ELICIT_ACCEPT = 'mark completed';
const ELICIT_DENY = 'decline';

function elicitationResponse(action: 'accept' | 'decline' | 'cancel'): CodexElicitationResponse {
  return { action, content: null, _meta: null };
}

/** Codex's own security boundary: HTTPS + host + no embedded credentials, else null. */
function safeElicitationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.toString();
}

function elicitationCard(nativeId: string, serverName: string, elicitationId: string, url: string, message: string | undefined): AskCard {
  return {
    interaction_id: nativeId,
    kind: 'approval',
    prompt: `MCP server “${serverName}” asks you to open a link`,
    // Untrusted, inert: Codor never fetches or previews it; acceptance only means
    // the operator has completed the link flow themselves.
    options: [
      { label: ELICIT_ACCEPT, description: 'you have opened this link yourself; Codor did not fetch or validate it' },
      { label: ELICIT_DENY },
    ],
    tool: 'mcp_elicitation',
    detail: `${serverName} · ${url}${message !== undefined ? ` · ${message}` : ''} · ${elicitationId}`,
  };
}

/**
 * Codex adapter backed by one long-lived 0.144.5 app-server per member.
 * Codor owns the turn boundary and spawn-time sandbox policy; app-server owns
 * the persistent native thread and context compaction.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    // ask stays false: Codex has no requestUserInput bridge (only approvals).
    ask: false,
    approvals: 'runtime',
    extensions: false,
    thinking: true,
    thinking_levels: CODEX_THINKING_LEVELS,
    // harn:assume live-inbox-capability-is-evidence-backed-v2 ref=codex-live-inbox-capability
    live_inbox: true,
    // harn:end live-inbox-capability-is-evidence-backed-v2
    // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-declarations
    // Full access uses Codex's no-approval, no-sandbox mode; all three are distinct.
    policies: {
      'read-only': 'read-only',
      'workspace-write': 'workspace-write',
      'full-access': '--yolo',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;

  private readonly runtimes = new WeakMap<Session, CodexRuntime>();
  private readonly memberRuntimes = new Map<string, CodexRuntime>();
  private readonly command: string;
  private readonly appServerFactory: CodexAppServerFactory;

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? 'codex';
    this.appServerFactory = options.appServerFactory ?? spawnCodexAppServer;
  }

  spawn(opts: SpawnOpts): Session {
    codexPolicyOptions(opts.policy);
    validateThinking(opts.thinking);
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      thinking: opts.thinking,
    };
  }

  // harn:assume adapters-own-their-model-catalog ref=codex-model-catalog
  /** Curated: `codex` has no listing command. Cited in NOTES.md. */
  listModels(): Promise<ModelCatalog> {
    return Promise.resolve({
      models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5'],
      source: 'curated',
    });
  }
  // harn:end adapters-own-their-model-catalog

  probeLimits(): Promise<AgentLimit[] | undefined> {
    return probeCodexLimits();
  }

  // harn:assume context-peek-reads-session-artifacts ref=codex-context-peek
  peekContextUsage(session_ref: SessionRef): Promise<AgentUsage | undefined> {
    return Promise.resolve(peekCodexContextUsage(session_ref));
  }
  // harn:end context-peek-reads-session-artifacts

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume codex-app-server-is-the-member-runtime ref=codex-app-server-session-lifecycle
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const runtime = this.runtimeFor(session);
    if (runtime.active !== null) throw new Error('a Codex turn is already in flight for this member');
    await this.prepareRuntime(runtime, session);

    runtime.context.latestResolvedModel = runtime.threadModel;

    const turn: TurnState = {
      translator: createTurnTranslator(runtime.context),
      hooks,
      queue: [],
      wake: null,
      terminal: false,
      done: false,
      interrupted: false,
    };
    runtime.active = turn;

    try {
      try {
        await this.ensureClient(runtime);
        hooks.onStarted?.({
          pid: runtime.child?.pid,
        });
        await this.ensureThread(runtime, turn);
        const response = await runtime.client!.request('turn/start', {
          threadId: runtime.threadId,
          input: [{ type: 'text', text: payload, text_elements: [] }],
          cwd: session.cwd,
          ...this.turnOptions(session),
        });
        turn.turnId ??= responseId(response, 'turn');
      } catch (error) {
        if (!turn.terminal) {
          const detail = error instanceof Error ? error.message : String(error);
          this.completeTurn(turn, {
            type: 'run.completed',
            status: turn.interrupted ? 'interrupted' : 'failed',
            ...(turn.interrupted ? {} : { error: detail }),
          });
        }
        this.retireRuntime(runtime);
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
        turn.interrupted = true;
        this.completeTurn(turn, { type: 'run.completed', status: 'interrupted' });
        this.retireRuntime(runtime);
      }
    }
  }

  private runtimeFor(session: Session): CodexRuntime {
    const direct = this.runtimes.get(session);
    if (direct !== undefined) {
      direct.session = session;
      return direct;
    }
    const memberKey = session.env?.CODOR_MEMBER_ID;
    const existing = memberKey === undefined ? undefined : this.memberRuntimes.get(memberKey);
    const runtime: CodexRuntime = existing ?? {
      session,
      pendingCompaction: null,
      pendingRequests: new Map(),
      generation: 0,
      ...(memberKey !== undefined && { memberKey }),
      client: null,
      child: null,
      retiringChild: null,
      connecting: null,
      active: null,
      ...(session.session_ref !== undefined && { threadId: session.session_ref }),
      context: {},
    };
    runtime.session = session;
    if (session.session_ref !== undefined) runtime.threadId = session.session_ref;
    this.runtimes.set(session, runtime);
    if (memberKey !== undefined) this.memberRuntimes.set(memberKey, runtime);
    return runtime;
  }

  private async prepareRuntime(runtime: CodexRuntime, session: Session): Promise<void> {
    const identity = runtimeIdentity(session);
    if (runtime.client !== null && !sameIdentity(runtime.identity, identity)) {
      this.retireRuntime(runtime);
    }
    runtime.session = session;
    if (session.session_ref !== undefined) runtime.threadId = session.session_ref;
    if (runtime.client === null) runtime.identity = identity;
  }

  private async ensureClient(runtime: CodexRuntime): Promise<void> {
    if (runtime.client !== null) return;
    if (runtime.retiringChild !== null) {
      if (runtime.retiringChild.exitCode === null && runtime.retiringChild.signalCode === null) {
        throw new Error('previous Codex app-server retirement is still pending');
      }
      runtime.retiringChild = null;
    }
    if (runtime.connecting !== null) return await runtime.connecting;
    const connecting = this.connect(runtime);
    runtime.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (runtime.connecting === connecting) runtime.connecting = null;
    }
  }

  private async connect(runtime: CodexRuntime): Promise<void> {
    const session = runtime.session;
    // harn:assume adapter-children-inherit-session-env ref=codex-child-environment
    const child = await this.appServerFactory({
      command: this.command,
      cwd: session.cwd,
      env: { ...process.env, ...session.env },
    });
    // harn:end adapter-children-inherit-session-env
    let client!: CodexAppServerClient;
    client = new CodexAppServerClient(child, (error) => this.handleClientClose(runtime, client, error));
    runtime.child = child;
    runtime.client = client;
    runtime.generation += 1;
    runtime.identity = runtimeIdentity(session);
    client.setNotificationHandler((method, params) => this.routeNotification(runtime, client, method, params));
    // Bridge the runtime request types to Codor approval cards and park the answer
    // until the operator responds (see bridge* / respondInteraction).
    client.setRequestHandler('item/commandExecution/requestApproval',
      (params) => this.bridgeApproval(runtime, client, 'command', params));
    client.setRequestHandler('item/fileChange/requestApproval',
      (params) => this.bridgeApproval(runtime, client, 'file', params));
    client.setRequestHandler('item/permissions/requestApproval',
      (params, requestId) => this.bridgePermissions(runtime, client, params, requestId));
    client.setRequestHandler('mcpServer/elicitation/request',
      (params, requestId) => this.bridgeElicitation(runtime, client, params, requestId));
    // item/tool/requestUserInput stays UNREGISTERED: the transport answers it with
    // an immediate JSON-RPC error (0.144.5 converts that to empty answers rather
    // than blocking). Bridging it needs capabilities.ask + a text-input card
    // (follow-up: codex-requestuserinput-support). form/openai-form elicitation
    // modes are declined below (no typed-form card yet).

    try {
      await client.request('initialize', {
        clientInfo: { name: 'codor', title: 'Codor', version: '0.1.0' },
      });
      client.notify('initialized');
      if (runtime.threadId !== undefined) {
        const response = await client.request('thread/resume', {
          threadId: runtime.threadId,
          ...this.threadOptions(session),
        });
        runtime.threadModel = responseModel(response);
        runtime.context.latestResolvedModel = runtime.threadModel;
      }
    } catch (error) {
      if (runtime.client === client) {
        runtime.client = null;
        runtime.child = null;
      }
      client.dispose();
      throw error;
    }
  }

  private async ensureThread(runtime: CodexRuntime, turn: TurnState): Promise<void> {
    if (runtime.threadId !== undefined) return;
    const response = await runtime.client!.request('thread/start', this.threadOptions(runtime.session));
    const threadId = responseId(response, 'thread');
    if (threadId === undefined) throw new Error('Codex app-server did not return a thread id');
    runtime.threadId = threadId;
    runtime.threadModel = responseModel(response);
    runtime.context.latestResolvedModel = runtime.threadModel;
    runtime.session.session_ref = threadId;
    turn.hooks.onSessionRef?.(threadId);
  }

  private threadOptions(session: Session): Record<string, unknown> {
    const policy = codexPolicyOptions(session.policy);
    return {
      cwd: session.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(session.model !== undefined && { model: session.model }),
    };
  }

  private turnOptions(session: Session): Record<string, unknown> {
    const policy = codexPolicyOptions(session.policy);
    return {
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(session.model !== undefined && { model: session.model }),
      ...(session.thinking !== undefined && { effort: session.thinking }),
    };
  }

  private routeNotification(
    runtime: CodexRuntime,
    client: CodexAppServerClient,
    method: string,
    params: unknown,
  ): void {
    if (runtime.client !== client) return;
    const threadId = notificationThreadId(params);
    if (threadId !== undefined && runtime.threadId !== undefined && threadId !== runtime.threadId) {
      return;
    }
    // harn:assume normalized-agent-task-updates-are-bounded-and-authoritative ref=codex-plan-task-routing
    // The pinned task-checklist notification must carry a nonempty threadId that
    // exactly matches the retained runtime thread — a threadless plan must not slip
    // through on turnId alone, which the general check above would otherwise allow.
    if (method === 'turn/plan/updated' &&
        (runtime.threadId === undefined || threadId === undefined || threadId !== runtime.threadId)) {
      return;
    }
    // harn:end normalized-agent-task-updates-are-bounded-and-authoritative
    // harn:assume codex-app-server-usage-preserves-cache-and-resolved-model ref=codex-resolved-model-runtime
    const notification = record(params);
    if (method === 'thread/settings/updated') {
      const model = record(notification?.threadSettings)?.model;
      if (typeof model === 'string' && model !== '') {
        runtime.threadModel = model;
        runtime.context.latestResolvedModel = model;
      }
    } else if (method === 'model/rerouted') {
      const turn = runtime.active;
      const notificationTurnId = notification?.turnId;
      const toModel = notification?.toModel;
      if (
        turn !== null &&
        !turn.done &&
        typeof notificationTurnId === 'string' &&
        turn.turnId === notificationTurnId &&
        typeof toModel === 'string' &&
        toModel !== ''
      ) {
        runtime.context.latestResolvedModel = toModel;
      }
    }
    // harn:end codex-app-server-usage-preserves-cache-and-resolved-model
    // A manual compaction runs with no turn open, and the branch below drops
    // every notification in that state — so observe its turn before that.
    this.observeCompaction(runtime, method, params);
    const turn = runtime.active;
    if (turn === null || turn.done) return;
    const events = turn.translator.push(method, params);
    turn.turnId ??= turn.translator.turnId();
    this.push(turn, events);
    if (events.some((event) => event.type === 'run.completed')) {
      turn.terminal = true;
      turn.done = true;
      this.cancelRequests(runtime);
      turn.wake?.();
    }
  }

  private handleClientClose(
    runtime: CodexRuntime,
    client: CodexAppServerClient,
    error: Error,
  ): void {
    if (runtime.client !== client) return;
    this.failCompaction(runtime, error);
    this.cancelRequests(runtime);
    runtime.client = null;
    runtime.child = null;
    const turn = runtime.active;
    if (turn !== null && !turn.terminal) {
      this.completeTurn(turn, turn.interrupted
        ? { type: 'run.completed', status: 'interrupted' }
        : { type: 'run.completed', status: 'failed', error: error.message });
    }
  }

  private push(turn: TurnState, events: WireEvent[]): void {
    if (events.length === 0) return;
    turn.queue.push(...events);
    turn.wake?.();
  }

  private completeTurn(turn: TurnState, event: WireEvent): void {
    if (turn.terminal) return;
    this.push(turn, [event]);
    turn.terminal = true;
    turn.done = true;
    turn.wake?.();
  }

  private retireRuntime(runtime: CodexRuntime, removeRuntime = false): void {
    this.failCompaction(runtime, new Error('Codex session retired before compaction completed'));
    this.cancelRequests(runtime);
    const client = runtime.client;
    runtime.client = null;
    runtime.child = null;
    runtime.identity = undefined;
    runtime.threadModel = undefined;
    runtime.context.latestResolvedModel = undefined;
    client?.dispose();
    if (removeRuntime) {
      this.runtimes.delete(runtime.session);
      if (runtime.memberKey !== undefined) this.memberRuntimes.delete(runtime.memberKey);
    }
  }

  /**
   * Compact this thread using the app server's own compaction RPC. Only ever
   * called for an idle session: compacting mid-turn races the engine rewriting
   * the same history. The RPC returns {} at once and the work runs as a
   * standalone native turn, so the result comes from observing that turn (see
   * observeCompaction) — resolving with the usage correlated to it, so the ring
   * updates without waiting for a next turn.
   */
  async compactSession(session: Session): Promise<AgentUsage | undefined> {
    const runtime = this.liveRuntime(session);
    if (runtime === undefined) throw new Error('no live Codex session to compact');
    if (runtime.active !== null && !runtime.active.terminal) {
      throw new Error('cannot compact while a turn is in flight');
    }
    if (runtime.pendingCompaction !== null) throw new Error('a compaction is already in flight');
    await this.ensureClient(runtime);
    const threadId = runtime.threadId;
    if (threadId === undefined) throw new Error('no Codex thread to compact');

    const settled = new Promise<AgentUsage | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => this.failCompaction(runtime, new Error('Codex compaction timed out')),
        COMPACTION_TIMEOUT_MS,
      );
      timer.unref?.();
      runtime.pendingCompaction = {
        settle: resolve, fail: reject,
        startedTurnIds: new Set<string>(), itemCompleted: false, timer,
      };
    });
    try {
      await runtime.client!.request('thread/compact/start', { threadId });
    } catch (error) {
      // The RPC itself failed (a dead client rejects it). Fail the observer's
      // promise too and consume it here: the caller learns about this through
      // the throw below, and an unconsumed rejection would surface as an
      // unhandled rejection instead of an error the operator sees.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failCompaction(runtime, failure);
      void settled.catch(() => undefined);
      throw failure;
    }
    return await settled;
  }

  /**
   * Watch the standalone turn `thread/compact/start` kicks off. The RPC returns
   * {} immediately and the work happens as a native turn, so the authority on
   * whether compaction happened is that turn's `turn/completed` — not
   * `thread/compacted`, which is exactly {threadId, turnId} and never carries a
   * usage payload.
   *
   * Everything is CORRELATED to the compact turn. A thread can be carrying other
   * traffic, and an uncorrelated observer would happily adopt a stranger's token
   * usage as the re-baseline or settle on a stranger's completion — and turn
   * ORDER proves nothing, so the first turn/started is not it either. Identity
   * comes from the canonical item: bind to whichever started turn opens a
   * contextCompaction item, then accept item and usage notifications only for
   * that turn and settle only on its terminal. A terminal without a completed
   * canonical item did not compact anything, and is reported as a failure
   * rather than a success with nothing behind it.
   */
  private observeCompaction(runtime: CodexRuntime, method: string, params: unknown): void {
    const pending = runtime.pendingCompaction;
    if (pending === null) return;
    const record = typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)
      : undefined;
    if (record === undefined) return;
    const turnId = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined;

    if (method === 'turn/started') {
      // Merely noted, never adopted: a thread can start turns that have nothing
      // to do with this compaction, and adopting one would let a stranger's
      // usage become the re-baseline and a stranger's terminal settle us.
      const turn = record.turn as { id?: unknown } | undefined;
      const started = turnId(turn?.id);
      if (started !== undefined) pending.startedTurnIds.add(started);
      return;
    }

    // Identity is established by the canonical item, not by turn order: the
    // compact turn is the started turn that opens a contextCompaction item.
    if (method === 'item/started') {
      const item = record.item as { id?: unknown; type?: unknown } | undefined;
      if (item?.type !== 'contextCompaction' || pending.turnId !== undefined) return;
      const owner = turnId(record.turnId);
      if (owner === undefined || !pending.startedTurnIds.has(owner)) return;
      pending.turnId = owner;
      pending.itemId = turnId(item.id);
      return;
    }
    // Until bound, nothing on this thread belongs to us. Item and usage
    // notifications name their turn at the top level; turn/completed names it
    // inside `turn`, so read both rather than silently dropping the terminal.
    const owner = turnId(record.turnId)
      ?? turnId((record.turn as { id?: unknown } | undefined)?.id);
    if (pending.turnId === undefined || owner !== pending.turnId) return;

    if (method === 'item/completed') {
      const item = record.item as { id?: unknown; type?: unknown } | undefined;
      if (item?.type !== 'contextCompaction') return;
      const id = turnId(item.id);
      if (id !== undefined && id === pending.itemId) pending.itemCompleted = true;
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = agentUsageFromTokenUsage(record.tokenUsage);
      if (usage !== undefined) pending.usage = usage;
      return;
    }
    if (method !== 'turn/completed') return;

    const turn = record.turn as
      { status?: unknown; error?: { message?: unknown } } | undefined;
    const status = turn?.status;
    if (status !== 'completed') {
      const detail = typeof turn?.error?.message === 'string' ? turn.error.message : undefined;
      this.failCompaction(runtime, new Error(
        `Codex compaction ${status === 'interrupted' ? 'was interrupted' : 'failed'}` +
        `${detail === undefined ? '' : `: ${detail}`}`,
      ));
      return;
    }
    if (!pending.itemCompleted) {
      this.failCompaction(runtime, new Error(
        'Codex compaction turn completed without compacting anything',
      ));
      return;
    }
    const usage = pending.usage;
    this.clearCompaction(runtime);
    if (usage !== undefined) runtime.context.latestUsage = usage;
    pending.settle(usage);
  }

  /** Every terminal path clears the pending state; none may leak a promise. */
  private clearCompaction(runtime: CodexRuntime): PendingCompaction | null {
    const pending = runtime.pendingCompaction;
    if (pending === null) return null;
    clearTimeout(pending.timer);
    runtime.pendingCompaction = null;
    return pending;
  }

  private failCompaction(runtime: CodexRuntime, error: Error): void {
    this.clearCompaction(runtime)?.fail(error);
  }

  // harn:assume active-turn-steering-is-ordered-and-durable ref=codex-active-turn-steering
  async steer(session: Session, payload: string): Promise<boolean> {
    const runtime = this.liveRuntime(session);
    if (runtime === undefined) return false;
    const turn = runtime.active;
    if (
      runtime.client === null ||
      runtime.threadId === undefined ||
      turn === null ||
      turn.terminal ||
      turn.turnId === undefined
    ) {
      return false;
    }
    const expectedTurnId = turn.turnId;
    const response = await runtime.client.request('turn/steer', {
      threadId: runtime.threadId,
      input: [{ type: 'text', text: payload, text_elements: [] }],
      expectedTurnId,
    });
    const acceptedTurnId = record(response)?.turnId;
    if (acceptedTurnId !== expectedTurnId) {
      throw new Error(
        `Codex app-server steered unexpected turn ${String(acceptedTurnId)}; expected ${expectedTurnId}`,
      );
    }
    return true;
  }
  // harn:end active-turn-steering-is-ordered-and-durable

  /** Find-only: the runtime this session already has, never creating one. */
  private liveRuntime(session: Session): CodexRuntime | undefined {
    return this.runtimes.get(session)
      ?? (session.env?.CODOR_MEMBER_ID === undefined
        ? undefined
        : this.memberRuntimes.get(session.env.CODOR_MEMBER_ID));
  }

  interrupt(session: Session): void {
    const runtime = this.liveRuntime(session);
    if (runtime === undefined) return;
    const turn = runtime.active;
    if (turn === null || turn.terminal) {
      this.retireRuntime(runtime, true);
      return;
    }
    turn.interrupted = true;
    const client = runtime.client;
    if (client === null || runtime.threadId === undefined || turn.turnId === undefined) {
      this.completeTurn(turn, { type: 'run.completed', status: 'interrupted' });
      this.retireRuntime(runtime, true);
      return;
    }
    this.completeTurn(turn, { type: 'run.completed', status: 'interrupted' });
    // Cancel parked approvals while the client is still alive so the decision
    // reaches Codex before retireRuntime disposes the transport.
    this.cancelRequests(runtime);
    void client.request('turn/interrupt', {
      threadId: runtime.threadId,
      turnId: turn.turnId,
    }, 5_000).catch(() => undefined).finally(() => this.retireRuntime(runtime, true));
  }

  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=codex-session-reset
  async resetSession(session: Session | undefined): Promise<void> {
    if (session === undefined) return; // restart: no retained app-server exists
    const runtime = this.liveRuntime(session);
    if (runtime === undefined) return;
    if (runtime.active !== null && !runtime.active.terminal) {
      throw new Error('cannot clear Codex context while a turn is in flight');
    }
    if (runtime.pendingCompaction !== null) {
      throw new Error('cannot clear Codex context while compaction is in flight');
    }
    const child = runtime.child ?? runtime.retiringChild;
    runtime.retiringChild = child;
    this.retireRuntime(runtime);
    if (child !== null) {
      try {
        await waitForRuntimeExit(child, 'Codex app-server', RETIREMENT_GRACE_MS);
      } catch {
        // dispose() already requested graceful stdin shutdown/SIGTERM. Escalate
        // only this adapter-created child, then require a second finite exit
        // confirmation before forgetting its runtime lookup.
        try { child.kill('SIGKILL'); } catch { /* the child may have exited meanwhile */ }
        await waitForRuntimeExit(child, 'Codex app-server', RETIREMENT_CONFIRM_MS);
      }
    }
    runtime.retiringChild = null;
    this.runtimes.delete(runtime.session);
    this.runtimes.delete(session);
    if (runtime.memberKey !== undefined) this.memberRuntimes.delete(runtime.memberKey);
  }
  // harn:end member-context-reset-is-authorized-atomic-and-lazy
  // harn:end codex-app-server-is-the-member-runtime

  // harn:assume codex-bridges-command-and-file-approvals ref=codex-cmdfile-bridge
  /**
   * The deliverable active turn for a server request, or null. A request that
   * carries a turnId must EXACTLY match the established active turn id — a
   * request bearing a turnId while the id is still the pre-turn placeholder
   * (undefined) is rejected. A request with no turnId (nullable elicitation)
   * parks on the active turn while one is non-terminal.
   */
  private deliverableTurn(runtime: CodexRuntime, rec: Record<string, unknown>): TurnState | null {
    const turn = runtime.active;
    if (turn === null || turn.terminal || turn.done) return null;
    const turnId = typeof rec.turnId === 'string' && rec.turnId !== '' ? rec.turnId : undefined;
    if (turnId !== undefined && (turn.turnId === undefined || turn.turnId !== turnId)) return null;
    return turn;
  }

  /** Push the card, park the answer/cancel builders by native id, return the response promise. */
  private park(
    runtime: CodexRuntime,
    turn: TurnState,
    card: AskCard,
    respond: (answer: unknown) => unknown,
    cancel: () => unknown,
  ): Promise<unknown> {
    const key = card.interaction_id;
    // A repeat for the same native id supersedes the prior park; cancel the old.
    runtime.pendingRequests.get(key)?.cancel();
    this.push(turn, [{ type: 'approval.raised', card }]);
    return new Promise<unknown>((resolve) => {
      runtime.pendingRequests.set(key, {
        respond: (answer) => resolve(respond(answer)),
        cancel: () => resolve(cancel()),
      });
    });
  }

  private bridgeApproval(
    runtime: CodexRuntime,
    client: CodexAppServerClient,
    kind: 'command' | 'file',
    params: unknown,
  ): Promise<{ decision: CodexApprovalDecision }> {
    if (runtime.client !== client) return Promise.resolve({ decision: 'decline' });
    const rec = record(params) ?? {};
    const turn = this.deliverableTurn(runtime, rec);
    // No deliverable turn (or a stale/placeholder turnId) → decline immediately.
    if (turn === null) return Promise.resolve({ decision: 'decline' });
    const nativeId = approvalNativeId(kind, rec);
    return this.park(runtime, turn, approvalCard(nativeId, kind, rec),
      (answer) => ({ decision: decisionForAnswer(answer) }),
      () => ({ decision: 'cancel' })) as Promise<{ decision: CodexApprovalDecision }>;
  }

  /** Resolve every parked request with its teardown answer (turn end / client loss). */
  private cancelRequests(runtime: CodexRuntime): void {
    if (runtime.pendingRequests.size === 0) return;
    const pendings = [...runtime.pendingRequests.values()];
    runtime.pendingRequests.clear();
    for (const pending of pendings) pending.cancel();
  }
  // harn:end codex-bridges-command-and-file-approvals

  // harn:assume codex-bridges-permissions-and-url-elicitation ref=codex-permelic-bridge
  private bridgePermissions(
    runtime: CodexRuntime,
    client: CodexAppServerClient,
    params: unknown,
    requestId: number,
  ): Promise<CodexPermissionResponse> {
    if (runtime.client !== client) return Promise.resolve(emptyGrant());
    const rec = record(params) ?? {};
    const turn = this.deliverableTurn(runtime, rec);
    // No deliverable turn / stale → empty grant (safe deny).
    if (turn === null) return Promise.resolve(emptyGrant());
    const requested = record(rec.permissions) ?? {};
    const reason = typeof rec.reason === 'string' && rec.reason !== '' ? rec.reason : undefined;
    const key = `perm-${runtime.generation}-${requestId}`;
    return this.park(runtime, turn, permissionCard(key, requested, reason),
      (answer) => permissionGrant(answer, requested),
      () => emptyGrant()) as Promise<CodexPermissionResponse>;
  }

  private bridgeElicitation(
    runtime: CodexRuntime,
    client: CodexAppServerClient,
    params: unknown,
    requestId: number,
  ): Promise<CodexElicitationResponse> {
    if (runtime.client !== client) return Promise.resolve(elicitationResponse('cancel'));
    const rec = record(params) ?? {};
    // Only url mode is bridgeable; form/openai-form need a typed-form card → decline.
    if (rec.mode !== 'url') return Promise.resolve(elicitationResponse('decline'));
    const url = safeElicitationUrl(rec.url);
    // Untrusted URL that fails Codex's own boundary (non-HTTPS/hostless/credentialed) → decline.
    if (url === null) return Promise.resolve(elicitationResponse('decline'));
    // turnId is nullable for elicitation; deliverableTurn parks on the active turn
    // when absent and requires an exact match when present. No deliverable turn
    // (e.g. a standalone between-turn elicitation) → cancel.
    const turn = this.deliverableTurn(runtime, rec);
    if (turn === null) return Promise.resolve(elicitationResponse('cancel'));
    const serverName = typeof rec.serverName === 'string' ? rec.serverName : 'unknown';
    const elicitationId = typeof rec.elicitationId === 'string' && rec.elicitationId !== ''
      ? rec.elicitationId : `req-${runtime.generation}-${requestId}`;
    const message = typeof rec.message === 'string' && rec.message !== '' ? rec.message : undefined;
    const key = `elic-${runtime.generation}-${requestId}`;
    return this.park(runtime, turn, elicitationCard(key, serverName, elicitationId, url, message),
      (answer) => elicitationResponse(answer === ELICIT_ACCEPT ? 'accept' : 'decline'),
      () => elicitationResponse('cancel')) as Promise<CodexElicitationResponse>;
  }
  // harn:end codex-bridges-permissions-and-url-elicitation

  // harn:assume codex-bridges-command-and-file-approvals ref=codex-cmdfile-respond
  respondInteraction(session: Session, interaction_id: string, answer: unknown): Promise<void> {
    const runtime = this.liveRuntime(session);
    const pending = runtime?.pendingRequests.get(interaction_id);
    if (runtime === undefined || pending === undefined) {
      return Promise.reject(new Error(`no pending Codex request ${interaction_id}`));
    }
    runtime.pendingRequests.delete(interaction_id);
    pending.respond(answer);
    return Promise.resolve();
  }
  // harn:end codex-bridges-command-and-file-approvals

  /** Thread ids from the rollout store (~/.codex/sessions/YYYY/MM/DD/). */
  discoverSessions(): SessionRef[] {
    const refs: SessionRef[] = [];
    const root = join(codexHome(), 'sessions');
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else {
          const match = ROLLOUT_RE.exec(entry.name);
          if (match) refs.push(match[1]!);
        }
      }
    };
    walk(root);
    return refs;
  }
}
