import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}

// harn:assume canonical-spawn-controls-enforced ref=codex-spawn-control-mapping
export function codexArgs(session: Session, payload: string): string[] {
  const policy = session.policy ?? 'read-only';
  if (!PolicySchema.safeParse(policy).success) throw invalidPolicy(policy);
  const sandbox = policy === 'full-access' ? 'danger-full-access' : policy;
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', session.cwd, '--sandbox', sandbox];
  if (session.model !== undefined) args.push('-m', session.model);
  if (session.thinking !== undefined) {
    ThinkingLevelSchema.parse(session.thinking);
    args.push('-c', `model_reasoning_effort=${session.thinking}`);
  }
  if (session.session_ref !== undefined) args.push('resume', session.session_ref);
  args.push(payload);
  return args;
}

/**
 * Codex adapter — drives `codex exec --json` per the P0.2 fixtures/NOTES.md.
 * Approvals are spawn-time sandbox policy (the member's policy chip); there
 * is no ask/approval control protocol in exec mode.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: true,
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(private readonly command = 'codex') {}

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

  // harn:assume adapters-own-their-model-catalog ref=codex-model-catalog
  /** Curated: `codex` has no listing command. Cited in NOTES.md. */
  listModels(): Promise<ModelCatalog> {
    return Promise.resolve({
      models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5'],
      source: 'curated',
    });
  }
  // harn:end adapters-own-their-model-catalog

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume adapters-cli-only-no-sdk ref=cli-subprocess-driver
  /**
   * One deliver() = one `codex exec --json` subprocess = one turn.
   * Contract pinned by fixtures: flags BEFORE the `resume` subcommand;
   * stdin closed (codex reads a piped stdin as extra prompt); the child gets
   * its own process group because the npm shim cannot forward SIGKILL — the
   * orphaned engine keeps running and writing, so signals must target the
   * GROUP and EOF (not child-exit) ends the stream.
   */
  // harn:assume adapter-process-lifecycle-supervised ref=cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const args = codexArgs(session, payload);

    const child = spawn(this.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group — signal the group, not the shim
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
      const discovered = translator.threadId();
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
      if (child.exitCode === null && child.signalCode === null) {
        this.signal(child, 'SIGKILL');
      }
    }
  }
  // harn:end adapter-process-lifecycle-supervised

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (child) this.signal(child, 'SIGINT');
  }

  /** Signal the child's whole process group (see NOTES.md kill findings). */
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal); // group already gone — try the direct pid
    }
  }
  // harn:end adapters-cli-only-no-sdk

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('codex raises no interactions (capabilities.ask=false, approvals=spawn-time)'),
    );
  }

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
