import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';

import type {
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema } from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

const ABORT_GRACE_MS = 5_000;

function missingBinary(): Error {
  return new Error('Tura adapter needs CODOR_TURA_BIN set to the pinned source-built tura binary');
}

function commandFor(command: string | undefined): string {
  if (!command) throw missingBinary();
  return command;
}

function turaEnv(sessionEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...sessionEnv };
  delete env.TURA_PROJECT_ROOT;
  return env;
}

export function turaArgs(session: Session, payload: string): string[] {
  const args = [
    '--cwd', session.cwd,
    'run',
    // Tura's plain run surface can complete the model turn then return a
    // non-zero runtime status. The gateway-owned command-run surface is the
    // proven headless contract used by Wheel's source wrappers.
    '--zsh',
    '--output', 'ndjson',
    '--agent-id', process.env.CODOR_TURA_AGENT_ID ?? 'balanced',
    '--session-type', 'coding',
  ];
  if (session.model !== undefined) args.push('--model', session.model);
  if (session.session_ref !== undefined) args.push('--session', session.session_ref);
  args.push(payload);
  return args;
}

/** A CLI adapter for the source-built Tura release, configured through CODOR_TURA_BIN. */
export class TuraAdapter implements HarnessAdapter {
  readonly id = 'tura';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'runtime',
    extensions: false,
    thinking: false,
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': null,
    },
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(private readonly command = process.env.CODOR_TURA_BIN) {}

  spawn(opts: SpawnOpts): Session {
    if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
      throw new Error(`unknown policy '${opts.policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
    }
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'tura' does not support thinking levels");
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
    };
  }

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    let command: string;
    try {
      command = commandFor(this.command);
    } catch (error) {
      yield { type: 'run.completed', status: 'failed', error: String(error), final_text: String(error) };
      return;
    }
    const child = spawn(command, turaArgs(session, payload), {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: turaEnv(session.env),
    });
    this.children.set(session, child);

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

    const translator = createTurnTranslator();
    let reportedSessionRef: string | undefined;
    const reportSessionRef = (): void => {
      const discovered = translator.sessionId();
      if (discovered === undefined || discovered === reportedSessionRef) return;
      session.session_ref = discovered;
      reportedSessionRef = discovered;
      hooks.onSessionRef?.(discovered);
    };

    try {
      try {
        await spawned;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield* translator.end({ status: 'failed', error: detail });
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });
      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        for (const event of translator.push(line)) {
          reportSessionRef();
          yield event;
          if (event.type === 'run.completed') return;
        }
        reportSessionRef();
      }
      const exit = await closed;
      const detail = stderr.trim() || childError?.message;
      const status = childError !== undefined || (exit.code !== null && exit.code !== 0)
        ? 'failed'
        : exit.code === 0
          ? 'completed'
          : 'interrupted';
      yield* translator.end({ status, ...(detail && { error: detail }) });
    } finally {
      this.children.delete(session);
      if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    }
  }

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (session.session_ref === undefined || !this.command) {
      if (child) this.signal(child, 'SIGINT');
      return;
    }
    const abort = spawn(this.command, [
      '--cwd', session.cwd, '--json', 'session', 'abort', session.session_ref,
    ], {
      cwd: session.cwd,
      stdio: 'ignore',
      env: turaEnv(session.env),
    });
    const forceStop = (): void => {
      if (child && child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    };
    if (!child) return;
    const timer = setTimeout(forceStop, ABORT_GRACE_MS);
    child.once('close', () => clearTimeout(timer));
    abort.once('error', forceStop);
  }

  respondInteraction(): Promise<void> {
    return Promise.reject(new Error('Tura run exposes no response channel to Codor'));
  }

  discoverSessions(): SessionRef[] {
    if (!this.command) return [];
    const result = spawn.sync(this.command, ['--json', 'session', 'list', '--all'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: turaEnv(),
    });
    if (result.error || result.status !== 0) return [];
    try {
      const sessions = JSON.parse(result.stdout) as { id?: unknown }[];
      if (!Array.isArray(sessions)) return [];
      return sessions.flatMap((session) =>
        typeof session.id === 'string' && session.id !== '' ? [session.id] : [],
      );
    } catch {
      return [];
    }
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}
