import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema, ThinkingLevelSchema } from '@codor/protocol';

import {
  type ControlRequest,
  createTurnTranslator,
  type HookPayload,
  wireEventFromHook,
} from './translate.js';

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}

// harn:assume canonical-spawn-controls-enforced ref=claude-spawn-control-mapping
export function claudePermissionMode(policy: string | undefined): string | undefined {
  if (policy === undefined) return undefined;
  if (!PolicySchema.safeParse(policy).success) throw invalidPolicy(policy);
  return {
    'read-only': 'plan',
    'workspace-write': 'acceptEdits',
    'full-access': 'bypassPermissions',
  }[policy];
}

export function claudeArgs(session: Session, settingsPath: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    '--settings',
    settingsPath,
  ];
  if (session.model !== undefined) args.push('--model', session.model);
  const permissionMode = claudePermissionMode(session.policy);
  if (permissionMode !== undefined) args.push('--permission-mode', permissionMode);
  if (session.thinking !== undefined) {
    ThinkingLevelSchema.parse(session.thinking);
    args.push('--effort', session.thinking);
  }
  if (session.session_ref !== undefined) args.push('--resume', session.session_ref);
  return args;
}

interface TurnState {
  child: ChildProcess;
  translator: ReturnType<typeof createTurnTranslator>;
  queue: WireEvent[];
  wake: (() => void) | null;
  /** Output sequence boundaries waiting for demonstrable later progress. */
  ackWaiters: {
    after: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }[];
  outputSeq: number;
  terminal: boolean;
  done: boolean;
}

/**
 * Claude Code adapter — drives `claude -p` stream-json in/out per the P0.2
 * fixtures/NOTES.md. Runtime approvals + AskUserQuestion via the control
 * protocol (`--permission-prompt-tool stdio` is the enabler, not a
 * fallback); extensions via SubagentStart/Stop hooks.
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
  } as const;

  private readonly turns = new WeakMap<Session, TurnState>();

  constructor(private readonly command = 'claude') {}

  spawn(opts: SpawnOpts): Session {
    claudePermissionMode(opts.policy);
    if (opts.thinking !== undefined) ThinkingLevelSchema.parse(opts.thinking);
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      thinking: opts.thinking,
    };
  }
  // harn:end canonical-spawn-controls-enforced

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume extensions-hooks-authoritative ref=hooks-endpoint-settings
  /**
   * Hooks are the authoritative extensions source: a generated settings file
   * wires SubagentStart/Stop to POST their JSON to an ephemeral loopback
   * endpoint owned by this deliver() call; Task/Agent tool_use stream events
   * only enrich. The settings file lives in the OS temp dir and is passed
   * with an ABSOLUTE path (claude resolves --settings relative to its cwd).
   */
  private async startHookEndpoint(
    onHook: (payload: HookPayload) => void,
  ): Promise<{ server: Server; settingsPath: string }> {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        try {
          onHook(JSON.parse(body) as HookPayload);
        } catch {
          // unparseable hook payloads are dropped
        }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const command = `curl -sf -X POST --data-binary @- -H 'Content-Type: application/json' http://127.0.0.1:${port}/hook`;
    const settings = {
      hooks: {
        SubagentStart: [{ hooks: [{ type: 'command', command }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command }] }],
      },
    };
    const settingsPath = join(
      tmpdir(),
      `wireroom-claude-hooks-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
    );
    writeFileSync(settingsPath, JSON.stringify(settings));
    return { server, settingsPath };
  }
  // harn:end extensions-hooks-authoritative

  /** One deliver() = one `claude -p` subprocess = one turn. */
  // harn:assume adapter-process-lifecycle-supervised ref=cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const state: TurnState = {
      child: undefined as unknown as ChildProcess,
      translator: createTurnTranslator(),
      queue: [],
      wake: null,
      ackWaiters: [],
      outputSeq: 0,
      terminal: false,
      done: false,
    };

    const push = (events: WireEvent[]): void => {
      if (events.length === 0) return;
      state.queue.push(...events);
      state.wake?.();
    };

    const { server, settingsPath } = await this.startHookEndpoint((hook) => {
      const event = wireEventFromHook(hook);
      if (event) push([event]);
    });

    const args = claudeArgs(session, settingsPath);

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group — signal the group
    });
    state.child = child;
    this.turns.set(session, state);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    let childError: Error | undefined;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        childError = error;
        reject(error);
      });
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
    );

    const rejectAcks = (error: Error): void => {
      for (const waiter of state.ackWaiters.splice(0)) waiter.reject(error);
    };
    const advance = (): void => {
      state.outputSeq++;
      for (let index = state.ackWaiters.length - 1; index >= 0; index--) {
        const waiter = state.ackWaiters[index]!;
        if (state.outputSeq > waiter.after) {
          state.ackWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
    };
    let reportedSessionRef: string | undefined;
    const reportSessionRef = (): void => {
      const discovered = state.translator.sessionId();
      if (discovered === undefined || discovered === reportedSessionRef) return;
      session.session_ref = discovered;
      reportedSessionRef = discovered;
      hooks.onSessionRef?.(discovered);
    };

    try {
      await spawned;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      push([{ type: 'run.completed', status: 'failed', final_text: detail }]);
      state.done = true;
    }

    if (!state.done) {
      try {
        hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });
      } catch (error) {
        childError = error instanceof Error ? error : new Error(String(error));
        push([{ type: 'run.completed', status: 'failed', final_text: childError.message }]);
        state.done = true;
        this.signal(child, 'SIGKILL');
      }
    }

    const pump = (async () => {
      if (state.done) return;
      try {
        const lines = createInterface({ input: child.stdout! });
        for await (const line of lines) {
          advance();
          const events = state.translator.push(line);
          push(events);
          reportSessionRef();
          if (events.some((event) => event.type === 'run.completed')) {
            state.terminal = true;
            child.stdin!.end();
          }
        }
        const exit = await closed;
        if (!state.terminal) {
          const failed = childError !== undefined || (exit.code !== null && exit.code !== 0);
          const detail = stderr.trim() || childError?.message;
          push([
            {
              type: 'run.completed',
              status: failed ? 'failed' : 'interrupted',
              ...(detail !== undefined && detail !== '' && { final_text: detail }),
            },
          ]);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!state.terminal) {
          push([{ type: 'run.completed', status: 'failed', final_text: detail }]);
        }
      } finally {
        rejectAcks(new Error('claude stream ended before interaction acknowledgement'));
        state.done = true;
        state.wake?.();
      }
    })();

    try {
      if (!state.done) {
        await new Promise<void>((resolve, reject) => {
          child.stdin!.write(
            `${JSON.stringify({
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: payload }] },
            })}\n`,
            (error) => (error ? reject(error) : resolve()),
          );
        });
      }
      while (true) {
        if (state.queue.length > 0) {
          yield state.queue.shift()!;
          continue;
        }
        if (state.done) break;
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
        state.wake = null;
      }
      await pump;
    } finally {
      this.turns.delete(session);
      rejectAcks(new Error('claude turn closed before interaction acknowledgement'));
      if (child.exitCode === null && child.signalCode === null) {
        this.signal(child, 'SIGKILL');
      }
      await pump.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(settingsPath);
      } catch {
        // already removed
      }
    }
  }
  // harn:end adapter-process-lifecycle-supervised

  // harn:assume interactions-answered-via-stdin-control ref=respond-interaction-stdin
  /**
   * Answers a pending interaction on the SAME child's stdin and resolves
   * once the write flushed AND the stream produced another event (the turn
   * demonstrably proceeded — the fixtures show un-flushed answers do not
   * survive a crash, and the daemon marks `acked` on this resolve).
   */
  async respondInteraction(session: Session, interaction_id: string, answer: unknown): Promise<void> {
    const state = this.turns.get(session);
    if (!state) throw new Error('no turn in flight for this session');
    const request = state.translator.pendingRequest(interaction_id);
    if (!request) throw new Error(`no pending interaction ${interaction_id}`);

    const response = composeControlResponse(request, answer);
    // harn:assume interaction-ack-requires-stream-progress ref=interaction-progress-ack
    const after = state.outputSeq;
    let removeWaiter = (): void => undefined;
    const acknowledged = new Promise<void>((resolve, reject) => {
      const waiter = { after, resolve, reject };
      state.ackWaiters.push(waiter);
      removeWaiter = () => {
        const index = state.ackWaiters.indexOf(waiter);
        if (index >= 0) state.ackWaiters.splice(index, 1);
      };
    });
    void acknowledged.catch(() => undefined); // observed below after the stdin flush
    try {
      await new Promise<void>((resolve, reject) => {
        state.child.stdin!.write(`${JSON.stringify(response)}\n`, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      await acknowledged;
    } catch (error) {
      removeWaiter();
      throw error;
    }
    // harn:end interaction-ack-requires-stream-progress
  }
  // harn:end interactions-answered-via-stdin-control

  interrupt(session: Session): void {
    const state = this.turns.get(session);
    if (state) this.signal(state.child, 'SIGINT');
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
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

/**
 * Composes the control_response for an interaction answer (shapes pinned by
 * the P0.2 stdin fixtures):
 * - AskUserQuestion: `updatedInput.answers` map keyed by QUESTION TEXT
 *   (string answers auto-map onto a single question; multi-select joins with
 *   commas per the CLI's own schema).
 * - approvals: 'deny' → behavior deny + message; 'allow once' → behavior
 *   allow with the original input; 'allow always' → additionally carries
 *   updatedPermissions from the addRules permission suggestion.
 */
export function composeControlResponse(
  request: ControlRequest,
  answer: unknown,
): Record<string, unknown> {
  const input = request.request.input ?? {};
  let body: Record<string, unknown>;

  if (request.request.tool_name === 'AskUserQuestion') {
    let answers: Record<string, string>;
    if (typeof answer === 'string') {
      const question = input.questions?.[0]?.question ?? '';
      answers = { [question]: answer };
    } else if (Array.isArray(answer)) {
      const question = input.questions?.[0]?.question ?? '';
      answers = { [question]: answer.join(', ') };
    } else {
      answers = (answer ?? {}) as Record<string, string>;
    }
    body = { behavior: 'allow', updatedInput: { ...input, answers } };
  } else {
    const choice = typeof answer === 'string' ? answer : 'deny';
    if (choice === 'deny') {
      body = { behavior: 'deny', message: 'denied by wireroom operator' };
    } else if (choice === 'allow always') {
      const addRules = (request.request.permission_suggestions ?? []).filter(
        (s) => typeof s === 'object' && s !== null && (s as { type?: string }).type === 'addRules',
      );
      body = { behavior: 'allow', updatedInput: input, updatedPermissions: addRules };
    } else {
      body = { behavior: 'allow', updatedInput: input };
    }
  }

  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: request.request_id, response: body },
  };
}
