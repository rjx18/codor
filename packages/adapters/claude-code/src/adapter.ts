import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@wireroom/protocol';

import {
  type ControlRequest,
  createTurnTranslator,
  type HookPayload,
  wireEventFromHook,
} from './translate.js';

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

interface TurnState {
  child: ChildProcess;
  translator: ReturnType<typeof createTurnTranslator>;
  queue: WireEvent[];
  wake: (() => void) | null;
  /** Resolvers waiting for "the stream proceeded" (ack proxies). */
  ackWaiters: (() => void)[];
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
  } as const;

  private readonly turns = new WeakMap<Session, TurnState>();

  spawn(opts: SpawnOpts): Session {
    return { harness: this.id, cwd: opts.cwd, model: opts.model, policy: opts.policy };
  }

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
  async *deliver(session: Session, payload: string): AsyncIterable<WireEvent> {
    const state: TurnState = {
      child: undefined as unknown as ChildProcess,
      translator: createTurnTranslator(),
      queue: [],
      wake: null,
      ackWaiters: [],
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
    if (session.policy !== undefined) args.push('--permission-mode', session.policy);
    if (session.session_ref !== undefined) args.push('--resume', session.session_ref);

    const child = spawn('claude', args, {
      cwd: session.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group — signal the group
    });
    state.child = child;
    this.turns.set(session, state);

    child.stdin!.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: payload }] },
      })}\n`,
    );

    const pump = (async () => {
      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        const events = state.translator.push(line);
        // any stream progress acknowledges in-flight answers
        for (const waiter of state.ackWaiters.splice(0)) waiter();
        push(events);
        if (session.session_ref === undefined && state.translator.sessionId() !== undefined) {
          session.session_ref = state.translator.sessionId();
        }
        if (events.some((e) => e.type === 'run.completed')) {
          child.stdin!.end();
        }
      }
      push(state.translator.end());
      state.done = true;
      state.wake?.();
    })();

    try {
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
      for (const waiter of state.ackWaiters.splice(0)) waiter();
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        this.signal(child, 'SIGKILL');
      }
    }
  }

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
    await new Promise<void>((resolve, reject) => {
      state.child.stdin!.write(`${JSON.stringify(response)}\n`, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    // ack = the stream moved after our write (tool result / next event)
    await new Promise<void>((resolve) => {
      if (state.done) return resolve();
      state.ackWaiters.push(resolve);
    });
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
