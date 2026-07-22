import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities as NativeAgentCapabilities,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  AcpLaunchConfigSchema,
  type AdapterTurnHooks,
  type HarnessAdapter,
  type Session,
  type SessionLifecycleSupport,
  type SessionRef,
  type SpawnOpts,
  type WireEvent,
} from '@codor/protocol';

import { createAcpTurnTranslator } from './translate.js';

interface ActiveTurn {
  translator: ReturnType<typeof createAcpTurnTranslator>;
  queue: WireEvent[];
  wake: (() => void) | null;
  done: boolean;
  terminal: boolean;
}

interface PendingPermission {
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
}

interface AcpRuntime {
  child: ChildProcess;
  connection: ClientSideConnection;
  sessionId: string;
  active: ActiveTurn | null;
  pending: Map<string, PendingPermission>;
  retiring: boolean;
}

const safeFailure = (message: string): Error => new Error(`ACP agent ${message}`);

function executableCandidates(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(executable)) return [executable];
  if (executable.includes('/') || executable.includes('\\')) return [];
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.COM').split(';')
    : [''];
  return (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((directory) =>
    extensions.map((extension) => resolve(directory, `${executable}${extension}`)));
}

// harn:assume acp-launch-is-structured-authorized-and-bounded ref=acp-launch-validation
export function resolveAcpExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const candidate of executableCandidates(executable, env)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Keep checking fixed PATH candidates; nothing is invoked during validation.
    }
  }
  throw safeFailure('executable is unavailable');
}
// harn:end acp-launch-is-structured-authorized-and-bounded

function lifecycle(capabilities: NativeAgentCapabilities | undefined): SessionLifecycleSupport {
  return {
    load: capabilities?.loadSession === true,
    resume: capabilities?.sessionCapabilities?.resume !== undefined &&
      capabilities.sessionCapabilities.resume !== null,
  };
}

function interactionCard(id: string, request: RequestPermissionRequest) {
  return {
    interaction_id: id,
    kind: 'approval' as const,
    prompt: request.toolCall.title ?? 'ACP agent requests permission',
    options: request.options.map((option) => ({
      label: option.name,
      description: option.kind.replaceAll('_', ' '),
    })),
    tool: request.toolCall.kind ?? 'other',
    ...(request.toolCall.rawInput !== undefined && {
      detail: (() => {
        try { return JSON.stringify(request.toolCall.rawInput).slice(0, 4096); }
        catch { return String(request.toolCall.rawInput).slice(0, 4096); }
      })(),
    }),
  };
}

/** Generic ACP v1 compatibility runtime. Native Claude/Codex adapters remain richer. */
// harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-adapter-runtime
export class AcpAdapter implements HarnessAdapter {
  readonly id = 'acp';
  readonly capabilities = {
    resume: false,
    discover: false,
    interactiveAttach: false,
    ask: false,
    approvals: 'runtime',
    extensions: false,
    thinking: false,
    live_inbox: false,
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': null,
    },
  } as const;

  private readonly runtimes = new WeakMap<Session, AcpRuntime>();

  spawn(opts: SpawnOpts): Session {
    if (opts.acp_launch === undefined) throw safeFailure('launch configuration is required');
    if (opts.model !== undefined) throw safeFailure('does not standardize model selection');
    const launch = AcpLaunchConfigSchema.parse(opts.acp_launch);
    resolveAcpExecutable(launch.executable);
    return {
      harness: this.id,
      cwd: opts.cwd,
      policy: opts.policy,
      model: opts.model,
      acp_launch: launch,
    };
  }

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  private push(runtime: AcpRuntime, events: WireEvent[]): void {
    if (events.length === 0 || runtime.active === null) return;
    runtime.active.queue.push(...events);
    runtime.active.wake?.();
  }

  private requestPermission(
    getRuntime: () => AcpRuntime | undefined,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const runtime = getRuntime();
    if (runtime?.active === null || runtime === undefined || runtime.sessionId !== request.sessionId) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const interactionId = `acp-permission-${randomUUID()}`;
    this.push(runtime, [{
      type: 'approval.raised',
      card: interactionCard(interactionId, request),
    }]);
    return new Promise((resolve) => runtime.pending.set(interactionId, {
      options: request.options,
      resolve,
    }));
  }

  private sessionUpdate(getRuntime: () => AcpRuntime | undefined, note: SessionNotification): void {
    const runtime = getRuntime();
    if (runtime === undefined || runtime.active === null || note.sessionId !== runtime.sessionId) return;
    this.push(runtime, runtime.active.translator.push(note.update));
  }

  private async startRuntime(
    session: Session,
    hooks: AdapterTurnHooks,
  ): Promise<AcpRuntime> {
    const launch = AcpLaunchConfigSchema.parse(session.acp_launch);
    const executable = resolveAcpExecutable(launch.executable);
    const child = spawn(executable, [...launch.argv], {
      cwd: session.cwd,
      env: { ...process.env, ...session.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
      windowsHide: true,
    });
    child.stderr?.resume();
    const abortStart = (message: string): never => {
      child.kill('SIGTERM');
      throw safeFailure(message);
    };
    let runtime: AcpRuntime | undefined;
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => ({
      requestPermission: (request) => this.requestPermission(() => runtime, request),
      sessionUpdate: (note) => this.sessionUpdate(() => runtime, note),
    }), stream);

    await new Promise<void>((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn);
      child.once('error', () => reject(safeFailure('could not start')));
    });
    hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });

    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'Codor', version: '0.10.3' },
    }).catch(() => abortStart('initialization failed'));
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      abortStart(`negotiated unsupported protocol version ${String(initialized.protocolVersion)}`);
    }
    const negotiated = lifecycle(initialized.agentCapabilities);
    const expected = session.lifecycle;
    let sessionId: string;
    if (session.session_ref === undefined) {
      const created = await connection.newSession({ cwd: session.cwd, mcpServers: [] })
        .catch(() => abortStart('could not create a session'));
      sessionId = created.sessionId;
      session.session_ref = sessionId;
      session.lifecycle = negotiated;
      if (hooks.onSessionRuntime !== undefined) {
        hooks.onSessionRuntime({ session_ref: sessionId, lifecycle: negotiated });
      } else {
        hooks.onSessionRef?.(sessionId);
        hooks.onSessionLifecycle?.(negotiated);
      }
    } else {
      const required = expected ?? abortStart('has no persisted restoration capability');
      sessionId = session.session_ref;
      if (required.resume && negotiated.resume) {
        await connection.resumeSession({ sessionId, cwd: session.cwd })
          .catch(() => abortStart('could not resume the existing session'));
      } else if (required.load && negotiated.load) {
        await connection.loadSession({ sessionId, cwd: session.cwd, mcpServers: [] })
          .catch(() => abortStart('could not load the existing session'));
      } else {
        abortStart('no longer supports a persisted restoration mechanism');
      }
      session.lifecycle = negotiated;
      hooks.onSessionLifecycle?.(negotiated);
    }

    runtime = { child, connection, sessionId, active: null, pending: new Map(), retiring: false };
    connection.closed.then(() => {
      if (runtime?.active !== null && runtime?.active !== undefined && !runtime.active.terminal) {
        runtime.active.terminal = true;
        this.push(runtime, [{
          type: 'run.completed', status: 'failed', error: 'ACP agent connection closed during turn',
        }]);
        runtime.active.done = true;
        runtime.active.wake?.();
      }
    }).catch(() => undefined);
    this.runtimes.set(session, runtime);
    return runtime;
  }

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    let runtime = this.runtimes.get(session);
    try {
      runtime ??= await this.startRuntime(session, hooks);
    } catch (error) {
      yield {
        type: 'run.completed',
        status: 'failed',
        error: error instanceof Error ? error.message : 'ACP agent initialization failed',
      };
      return;
    }
    if (runtime.active !== null) {
      yield { type: 'run.completed', status: 'failed', error: 'ACP agent already has an active turn' };
      return;
    }

    const turn: ActiveTurn = {
      translator: createAcpTurnTranslator(), queue: [], wake: null, done: false, terminal: false,
    };
    runtime.active = turn;
    const prompt = runtime.connection.prompt({
      sessionId: runtime.sessionId,
      prompt: [{ type: 'text', text: payload }],
    }).then((response) => {
      if (!turn.terminal) {
        turn.terminal = true;
        const completed = turn.translator.complete(response, session.acp_usage_baseline);
        if (completed.baseline !== undefined) session.acp_usage_baseline = completed.baseline;
        this.push(runtime!, completed.events);
      }
    }).catch(() => {
      if (!turn.terminal) {
        turn.terminal = true;
        this.push(runtime!, [{ type: 'run.completed', status: 'failed', error: 'ACP agent turn failed' }]);
      }
    }).finally(() => {
      turn.done = true;
      turn.wake?.();
    });

    try {
      while (!turn.done || turn.queue.length > 0) {
        const event = turn.queue.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        await new Promise<void>((resolveWake) => { turn.wake = resolveWake; });
        turn.wake = null;
      }
      await prompt;
    } finally {
      runtime.active = null;
      for (const pending of runtime.pending.values()) {
        pending.resolve({ outcome: { outcome: 'cancelled' } });
      }
      runtime.pending.clear();
      if (runtime.retiring) this.terminate(runtime);
    }
  }

  async respondInteraction(session: Session, interactionId: string, answer: unknown): Promise<void> {
    const runtime = this.runtimes.get(session);
    const pending = runtime?.pending.get(interactionId);
    if (runtime === undefined || pending === undefined) {
      throw new Error(`no pending interaction ${interactionId}`);
    }
    runtime.pending.delete(interactionId);
    const selected = typeof answer === 'string'
      ? pending.options.find((option) => option.name === answer || option.optionId === answer)
      : undefined;
    pending.resolve(selected === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: selected.optionId } });
  }

  interrupt(session: Session): void {
    const runtime = this.runtimes.get(session);
    if (runtime === undefined) return;
    runtime.retiring = true;
    for (const pending of runtime.pending.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    runtime.pending.clear();
    if (runtime.active === null) {
      this.terminate(runtime);
      return;
    }
    void runtime.connection.cancel({ sessionId: runtime.sessionId }).catch(() => this.terminate(runtime));
  }

  private terminate(runtime: AcpRuntime): void {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
    if (process.platform === 'win32') runtime.child.kill('SIGTERM');
    else {
      try { process.kill(-(runtime.child.pid!), 'SIGTERM'); }
      catch { runtime.child.kill('SIGTERM'); }
    }
  }

  discoverSessions(): SessionRef[] {
    return [];
  }
}
// harn:end acp-v1-events-and-capabilities-are-negotiated
