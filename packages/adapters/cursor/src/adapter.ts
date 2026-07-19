import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema } from '@codor/protocol';

/**
 * What each canonical policy becomes for `cursor-agent` in headless mode.
 * read-only -> plan mode (no edits); workspace-write -> auto-run with the OS
 * sandbox confining shell/filesystem to the workspace; full-access -> auto-run
 * with the sandbox off. All three are distinct here.
 */
const POLICY_NATIVE = {
  'read-only': 'plan',
  'workspace-write': 'force+sandbox',
  'full-access': 'yolo',
} as const;

function assertPolicy(policy: string | undefined): void {
  if (policy === undefined) return;
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
}

function policyArgs(policy: string | undefined): string[] {
  if (policy === undefined) return [];
  assertPolicy(policy);
  switch (policy) {
    case 'read-only':
      return ['--mode', 'plan'];
    case 'workspace-write':
      return ['--force', '--sandbox', 'enabled'];
    case 'full-access':
      return ['--force', '--sandbox', 'disabled'];
    default:
      return [];
  }
}

// harn:assume canonical-spawn-controls-enforced ref=cursor-spawn-control-mapping
export function cursorArgs(session: Session, payload: string): string[] {
  if (session.thinking !== undefined) {
    throw new Error("adapter 'cursor' does not support thinking levels");
  }
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
  if (session.model !== undefined) args.push('--model', session.model);
  args.push(...policyArgs(session.policy));
  if (session.session_ref !== undefined) args.push('--resume', session.session_ref);
  // `--` guards payloads that begin with a dash from being parsed as flags.
  args.push('--', payload);
  return args;
}

/** Direct `cursor-agent` headless CLI driver. Mirrors the gemini adapter. */
export class CursorAdapter implements HarnessAdapter {
  readonly id = 'cursor';
  readonly capabilities = {
    resume: true,
    // `cursor-agent ls` requires a TTY (Ink raw mode), so sessions cannot be
    // enumerated headlessly. Codor still resumes via the session_ref it persists.
    discover: false,
    interactiveAttach: false,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: false,
    live_inbox: false,
    policies: POLICY_NATIVE,
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(private readonly command = 'cursor-agent') {}

  spawn(opts: SpawnOpts): Session {
    assertPolicy(opts.policy);
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'cursor' does not support thinking levels");
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
    };
  }
  // harn:end canonical-spawn-controls-enforced

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const { createTurnTranslator } = await import('./translate.js');
    const args = cursorArgs(session, payload);

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...session.env },
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
        yield* translator.end({ status: 'failed', final_text: detail });
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });

      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        for (const event of translator.push(line)) {
          reportSessionRef();
          yield event;
        }
        reportSessionRef();
      }
      const exit = await closed;
      const failed = childError !== undefined || (exit.code !== null && exit.code !== 0);
      const detail = stderr.trim() || childError?.message;
      yield* translator.end({
        status: failed ? 'failed' : 'interrupted',
        ...(detail !== undefined && detail !== '' && { final_text: detail }),
      });
    } finally {
      this.children.delete(session);
      if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    }
  }

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (child) this.signal(child, 'SIGINT');
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('cursor headless stream-json exposes no interaction response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    return [];
  }
}
