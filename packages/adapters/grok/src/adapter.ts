import { type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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

import { createTurnTranslator } from './translate.js';

export function grokApprovalArgs(policy: string | undefined): string[] {
  if (policy === undefined) return [];
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
  return policy === 'full-access' ? ['--always-approve'] : [];
}

// harn:assume canonical-spawn-controls-enforced ref=grok-spawn-control-mapping
export function grokArgs(session: Session, payload: string): string[] {
  const args = ['-p', payload, '--output-format', 'streaming-json', '--no-auto-update'];
  if (session.model !== undefined) args.push('--model', session.model);
  if (session.thinking !== undefined) args.push('--effort', session.thinking);
  args.push(...grokApprovalArgs(session.policy));
  if (session.session_ref !== undefined) args.push('--resume', session.session_ref);
  return args;
}

const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Direct `grok` headless CLI driver. See NOTES.md for the behavioral sources. */
export class GrokAdapter implements HarnessAdapter {
  readonly id = 'grok';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: true,
    thinking_levels: ['low', 'medium', 'high'] as const,
    // harn:assume live-inbox-capability-is-evidence-backed-v2 ref=grok-live-inbox-capability
    live_inbox: false,
    // Grok exposes --always-approve, but its CLI does not document a native
    // read-only/workspace-write mapping. Do not imply either tier is enforced.
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': '--always-approve',
    },
    // harn:end live-inbox-capability-is-evidence-backed-v2
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(
    private readonly command = 'grok',
    private readonly home = join(homedir(), '.grok'),
  ) {}

  spawn(opts: SpawnOpts): Session {
    grokApprovalArgs(opts.policy);
    if (opts.thinking !== undefined &&
      !(this.capabilities.thinking_levels as readonly string[]).includes(opts.thinking)) {
      throw new Error(
        `adapter 'grok' does not support thinking level '${opts.thinking}'; ` +
        `valid levels: ${this.capabilities.thinking_levels.join(', ')}`,
      );
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      thinking: opts.thinking,
    };
  }

  listModels(): Promise<ModelCatalog> {
    return Promise.resolve({ models: ['grok-4.5'], source: 'curated' });
  }

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume windows-cli-adapters-resolve-command-shims ref=windows-cli-spawn-provider
  // harn:assume remaining-cli-adapters-use-supervised-subprocesses ref=grok-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=grok-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const args = grokArgs(session, payload);
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

    const translator = createTurnTranslator(session.session_ref);
    const reportSessionRef = (): void => {
      const discovered = translator.sessionId();
      if (discovered === undefined || discovered === session.session_ref) return;
      session.session_ref = discovered;
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
      if (session.session_ref !== undefined) hooks.onSessionRef?.(session.session_ref);

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
      new Error('grok headless streaming-json exposes no interaction response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    let entries;
    try {
      entries = readdirSync(join(this.home, 'sessions'), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => SESSION_REF.test(entry.name))
      .map((entry) => entry.name);
  }
}
