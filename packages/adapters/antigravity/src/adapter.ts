import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PolicySchema,
  type AdapterTurnHooks,
  type HarnessAdapter,
  type ModelCatalog,
  type Session,
  type SessionRef,
  type SpawnOpts,
  type WireEvent,
} from '@codor/protocol';
import spawn from 'cross-spawn';

const CONVERSATION_RE = /\bfor ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TRUNCATED = '\n[output truncated]';

export function parseConversationId(log: string): string | undefined {
  return [...log.matchAll(CONVERSATION_RE)].at(-1)?.[1]?.toLowerCase();
}

export function antigravitySlug(display: string): string {
  return display.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let prefix = '';
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (bytes + pointBytes > maxBytes) break;
    prefix += point;
    bytes += pointBytes;
  }
  return prefix;
}

function finalOutput(output: string, truncated: boolean): string {
  if (!truncated) return output;
  const markerBytes = Buffer.byteLength(TRUNCATED, 'utf8');
  return `${utf8Prefix(output, MAX_OUTPUT_BYTES - markerBytes)}${TRUNCATED}`;
}

export interface AntigravityInvocation {
  mode: 'plan' | 'accept-edits';
  skipPermissions: boolean;
}

// harn:assume canonical-spawn-controls-enforced ref=antigravity-spawn-control-mapping
export function antigravityMode(policy: string | undefined): AntigravityInvocation {
  if (policy === undefined) return { mode: 'accept-edits', skipPermissions: false };
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
  if (policy === 'read-only') return { mode: 'plan', skipPermissions: false };
  if (policy === 'workspace-write') return { mode: 'accept-edits', skipPermissions: false };
  return { mode: 'accept-edits', skipPermissions: true };
}

export function antigravityArgs(
  session: Session,
  payload: string,
  logFile: string,
  model = session.model,
): string[] {
  if (session.thinking !== undefined) {
    throw new Error("adapter 'antigravity' does not support thinking levels");
  }
  const { mode, skipPermissions } = antigravityMode(session.policy);
  const args = [
    '--mode', mode,
    '--add-dir', session.cwd,
    '--log-file', logFile,
    '--print-timeout', '30m',
  ];
  if (model !== undefined) args.push('--model', model);
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  if (session.session_ref !== undefined) args.push('--conversation', session.session_ref);
  args.push('--print', payload);
  return args;
}
// harn:end canonical-spawn-controls-enforced

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
    policies: {
      'read-only': '--mode plan',
      'workspace-write': '--mode accept-edits',
      'full-access': '--mode accept-edits --dangerously-skip-permissions',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;
  // harn:end canonical-spawn-controls-enforced

  private readonly children = new WeakMap<Session, ChildProcess>();
  private readonly displayNames = new Map<string, string>();

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
    const displays = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (displays.length === 0) return Promise.reject(new Error('agy listed no models'));

    const next = new Map<string, string>();
    for (const display of displays) {
      const slug = antigravitySlug(display);
      if (slug === '') return Promise.reject(new Error(`agy model '${display}' has no safe slug`));
      const existing = next.get(slug);
      if (existing !== undefined && existing !== display) {
        return Promise.reject(new Error(`agy model names collide at slug '${slug}'`));
      }
      next.set(slug, display);
    }
    this.displayNames.clear();
    for (const [slug, display] of next) this.displayNames.set(slug, display);
    return Promise.resolve({ models: [...next.keys()], source: 'discovered' });
  }
  // harn:end adapters-own-their-model-catalog

  attach(sessionRef: SessionRef): Session {
    return { harness: this.id, session_ref: sessionRef, cwd: process.cwd() };
  }

  // harn:assume adapter-process-lifecycle-supervised ref=antigravity-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const logFile = join(tmpdir(), `codor-antigravity-${randomUUID()}.log`);
    const model = session.model === undefined
      ? undefined
      : this.displayNames.get(session.model) ?? session.model;
    const child = spawn(this.command, antigravityArgs(session, payload, logFile, model), {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // harn:assume adapter-children-inherit-session-env ref=antigravity-child-environment
      env: { ...process.env, ...session.env },
      // harn:end adapter-children-inherit-session-env
    });
    this.children.set(session, child);

    let output = '';
    let truncated = false;
    let stderr = '';
    let terminal = false;
    let childError: Error | undefined;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
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

    try {
      try {
        await spawned;
      } catch (error) {
        terminal = true;
        yield {
          type: 'run.completed',
          status: 'failed',
          final_text: error instanceof Error ? error.message : String(error),
        };
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });

      // harn:assume antigravity-plain-output-is-bounded ref=antigravity-output-bound
      for await (const chunk of child.stdout!) {
        const text = chunk as string;
        const accepted = utf8Prefix(text, MAX_OUTPUT_BYTES - Buffer.byteLength(output, 'utf8'));
        if (accepted !== text) truncated = true;
        if (accepted !== '') {
          output += accepted;
          yield { type: 'run.item', item_type: 'text_delta', payload: { text: accepted } };
        }
      }
      // harn:end antigravity-plain-output-is-bounded
      const exit = await closed;

      // harn:assume antigravity-session-resume-is-log-derived ref=antigravity-log-resume
      const sessionRef = this.recoverSessionRef(logFile);
      if (sessionRef !== undefined && sessionRef !== session.session_ref) {
        session.session_ref = sessionRef;
        hooks.onSessionRef?.(sessionRef);
      }
      // harn:end antigravity-session-resume-is-log-derived

      const detail = stderr.trim() || childError?.message;
      const status = childError !== undefined || (exit.code !== null && exit.code !== 0)
        ? 'failed'
        : exit.signal !== null ? 'interrupted' : 'completed';
      const evidence = status === 'completed' ? output.trim() : output.trim() || detail || '';
      const finalText = finalOutput(evidence, truncated);
      terminal = true;
      yield {
        type: 'run.completed',
        status,
        ...(finalText !== '' && { final_text: finalText }),
      };
    } finally {
      if (!terminal) {
        const finalText = finalOutput(output.trim(), truncated);
        yield {
          type: 'run.completed',
          status: 'interrupted',
          ...(finalText !== '' && { final_text: finalText }),
        };
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

  respondInteraction(): Promise<void> {
    return Promise.reject(new Error('agy print mode has no interaction response channel'));
  }

  discoverSessions(): SessionRef[] {
    return [];
  }
}
