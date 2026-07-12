import { execFile, type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  ModelCatalog,
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema, ThinkingLevelSchema } from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

const DISCOVER_QUERY =
  'SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC';

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}

export function openCodeAutoApprove(policy: string | undefined): boolean {
  if (policy === undefined) return false;
  if (!PolicySchema.safeParse(policy).success) throw invalidPolicy(policy);
  return policy === 'full-access';
}

// harn:assume canonical-spawn-controls-enforced ref=opencode-spawn-control-mapping
export function openCodeArgs(session: Session, payload: string): string[] {
  const autoApprove = openCodeAutoApprove(session.policy);
  const args = ['run', '--format', 'json'];
  if (session.model !== undefined) args.push('--model', session.model);
  if (autoApprove) args.push('--auto');
  if (session.thinking !== undefined) {
    ThinkingLevelSchema.parse(session.thinking);
    args.push('--variant', session.thinking);
  }
  if (session.session_ref !== undefined) args.push('--session', session.session_ref);
  args.push(payload);
  return args;
}

/** Direct `opencode run` CLI driver. See NOTES.md for the behavioral sources. */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = 'opencode';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: true,
    // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-declarations
    // Only full-access emits a flag. read-only and workspace-write build IDENTICAL
    // arguments, so neither is enforced by us: both defer to opencode's own rules.
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': '--auto',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(private readonly command = 'opencode') {}

  spawn(opts: SpawnOpts): Session {
    if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
      throw invalidPolicy(opts.policy);
    }
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

  // harn:assume adapters-own-their-model-catalog ref=opencode-model-discovery
  /**
   * opencode's models come from the operator's OWN configured providers, so no
   * fixed list can be right for every install — ask the CLI. Fixed argv (no
   * shell), hard timeout, capped output; a failure throws and the daemon
   * silently degrades this harness to the custom escape.
   */
  async listModels(): Promise<ModelCatalog> {
    const listed = await new Promise<string>((resolve, reject) => {
      execFile(
        this.command,
        ['models'],
        { timeout: 5_000, maxBuffer: 1_000_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const models = listed.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (models.length === 0) throw new Error('opencode listed no models');
    return { models, source: 'discovered' };
  }
  // harn:end adapters-own-their-model-catalog

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume adapters-cli-only-no-sdk ref=opencode-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=opencode-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const args = openCodeArgs(session, payload);

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
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
      const detail = stderr.trim() || childError?.message;
      const status = childError !== undefined || (exit.code !== null && exit.code !== 0)
        ? 'failed'
        : exit.code === 0
          ? 'completed'
          : 'interrupted';
      yield* translator.end({
        status,
        ...(status !== 'completed' && detail !== undefined && detail !== '' && { final_text: detail }),
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
  // harn:end adapter-process-lifecycle-supervised
  // harn:end adapters-cli-only-no-sdk

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('opencode run owns headless permissions and exposes no response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    const result = spawnSync(this.command, ['db', '--format', 'json', DISCOVER_QUERY], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
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
}
// harn:assume opencode-capability-truth ref=opencode-capability-conformance
// Capability declarations above are exercised by fixture, translator, subprocess,
// CLI attach, and the recorded single-shot live PONG conformance tests.
// harn:end opencode-capability-truth
