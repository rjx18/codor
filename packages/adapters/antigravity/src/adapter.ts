import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';

import type {
  AdapterTurnHooks,
  HarnessAdapter,
  ModelCatalog,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema } from '@codor/protocol';

/**
 * agy prints only the final assistant text; the conversation id it would need
 * to resume never reaches stdout, but its verbose `--log-file` records it on
 * the stream lifecycle lines. This is the least-fragile anchor available.
 */
const CONVERSATION_RE = /\bfor ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

export function parseConversationId(log: string): string | undefined {
  const ids = [...log.matchAll(CONVERSATION_RE)].map((match) => match[1]!.toLowerCase());
  // The last id logged is this turn's conversation.
  return ids.at(-1);
}

export interface AntigravityInvocation {
  mode: 'plan' | 'accept-edits';
  skipPermissions: boolean;
}

// harn:assume canonical-spawn-controls-enforced ref=antigravity-spawn-control-mapping
/** Map a canonical Codor policy onto agy's execution mode and permission flag. */
export function antigravityMode(policy: string | undefined): AntigravityInvocation {
  if (policy === undefined) return { mode: 'accept-edits', skipPermissions: false };
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
  switch (policy) {
    case 'read-only':
      return { mode: 'plan', skipPermissions: false };
    case 'workspace-write':
      return { mode: 'accept-edits', skipPermissions: false };
    default:
      return { mode: 'accept-edits', skipPermissions: true };
  }
}

export function antigravityArgs(session: Session, payload: string, logFile: string): string[] {
  if (session.thinking !== undefined) {
    throw new Error("adapter 'antigravity' does not support thinking levels");
  }
  const { mode, skipPermissions } = antigravityMode(session.policy);
  const args = [
    '--mode', mode,
    '--add-dir', session.cwd,
    '--log-file', logFile,
    // agy print mode self-terminates at 5m by default; a turn may run longer, so
    // give it a generous ceiling and let the switchboard own real interruption.
    '--print-timeout', '30m',
  ];
  if (session.model !== undefined) args.push('--model', session.model);
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  if (session.session_ref !== undefined) args.push('--conversation', session.session_ref);
  args.push('--print', payload);
  return args;
}
// harn:end canonical-spawn-controls-enforced

const MAX_OUTPUT = 256 * 1024;

/** Direct `agy --print` CLI driver for the Antigravity harness. See NOTES.md. */
export class AntigravityAdapter implements HarnessAdapter {
  readonly id = 'antigravity';
  // harn:assume canonical-spawn-controls-enforced ref=antigravity-capability-map
  readonly capabilities = {
    resume: true,
    discover: false,
    interactiveAttach: false,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: false,
    live_inbox: false,
    // harn:assume harness-declares-what-a-policy-becomes ref=antigravity-policy-declarations
    // agy has two execution modes plus a skip-permissions flag; read-only becomes plan,
    // and full-access additionally auto-approves tool permissions.
    policies: {
      'read-only': '--mode plan',
      'workspace-write': '--mode accept-edits',
      'full-access': '--mode accept-edits --dangerously-skip-permissions',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;
  // harn:end canonical-spawn-controls-enforced

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(private readonly command = 'agy') {}

  spawn(opts: SpawnOpts): Session {
    antigravityMode(opts.policy);
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'antigravity' does not support thinking levels");
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
    };
  }

  // harn:assume adapters-own-their-model-catalog ref=antigravity-model-catalog
  /** agy lists its own models locally (zero spend); each is a display name. */
  listModels(): Promise<ModelCatalog> {
    const result = spawn.sync(this.command, ['models'], {
      timeout: 5_000,
      maxBuffer: 1_000_000,
      encoding: 'utf8',
    });
    if (result.error) return Promise.reject(result.error);
    if (result.status !== 0) {
      return Promise.reject(new Error(`Command failed: ${this.command} models`));
    }
    const models = String(result.stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (models.length === 0) return Promise.reject(new Error('agy listed no models'));
    return Promise.resolve({ models, source: 'discovered' });
  }
  // harn:end adapters-own-their-model-catalog

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume remaining-cli-adapters-use-supervised-subprocesses ref=antigravity-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=antigravity-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const logFile = join(tmpdir(), `codor-antigravity-${randomUUID()}.log`);
    const args = antigravityArgs(session, payload, logFile);

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // harn:assume adapter-children-inherit-session-env ref=antigravity-child-environment
      env: { ...process.env, ...session.env },
      // harn:end adapter-children-inherit-session-env
    });
    this.children.set(session, child);

    let output = '';
    child.stdout!.setEncoding('utf8');
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

    let terminal = false;
    try {
      try {
        await spawned;
      } catch (error) {
        terminal = true;
        yield { type: 'run.completed', status: 'failed', final_text: error instanceof Error ? error.message : String(error) };
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });

      for await (const chunk of child.stdout!) {
        const text = chunk as string;
        if (output.length < MAX_OUTPUT) yield { type: 'run.item', item_type: 'text_delta', payload: { text } };
        output = `${output}${text}`;
      }
      const exit = await closed;

      // The conversation id only appears in agy's log; recover it for resume.
      const sessionRef = this.recoverSessionRef(logFile);
      if (sessionRef !== undefined && sessionRef !== session.session_ref) {
        session.session_ref = sessionRef;
        hooks.onSessionRef?.(sessionRef);
      }

      const detail = stderr.trim() || childError?.message;
      const status = childError !== undefined || (exit.code !== null && exit.code !== 0)
        ? 'failed'
        : exit.signal !== null
          ? 'interrupted'
          : 'completed';
      const finalText = status === 'completed'
        ? output.trim()
        : (output.trim() || detail || '');
      terminal = true;
      yield {
        type: 'run.completed',
        status,
        ...(finalText !== '' && { final_text: finalText.slice(0, MAX_OUTPUT) }),
      };
    } finally {
      if (!terminal) {
        yield { type: 'run.completed', status: 'interrupted', ...(output.trim() !== '' && { final_text: output.trim() }) };
      }
      this.children.delete(session);
      rmSync(logFile, { force: true });
      if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    }
  }

  private recoverSessionRef(logFile: string): string | undefined {
    try {
      return parseConversationId(readFileSync(logFile, 'utf8'));
    } catch {
      return undefined;
    }
  }

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (child) this.signal(child, 'SIGINT');
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  // harn:end adapter-process-lifecycle-supervised
  // harn:end remaining-cli-adapters-use-supervised-subprocesses

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('agy print mode has no interaction response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    // agy exposes no local session-store listing; resume works only from a
    // session_ref captured on a prior turn, so nothing to enumerate here.
    return [];
  }
}
