import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';

import type {
  ModelCatalog,
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema } from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function copilotAllowAll(policy: string | undefined): boolean {
  if (policy === undefined) return false;
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
  return policy === 'full-access';
}

// harn:assume canonical-spawn-controls-enforced ref=copilot-spawn-control-mapping
export function copilotArgs(session: Session, payload: string): string[] {
  if (session.thinking !== undefined) {
    throw new Error("adapter 'copilot' does not support thinking levels");
  }
  const args = ['--output-format=json', '--stream=on', '--no-ask-user', '--no-color'];
  if (session.model !== undefined) args.push('--model', session.model);
  if (copilotAllowAll(session.policy)) args.push('--allow-all');
  args.push('--session-id', session.session_ref!, '--prompt', payload);
  return args;
}

/** Direct `copilot --prompt` CLI driver. See NOTES.md for behavioral sources. */
export class CopilotAdapter implements HarnessAdapter {
  readonly id = 'copilot';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: true,
    thinking: false,
    // harn:assume live-inbox-capability-is-evidence-backed ref=copilot-live-inbox-capability
    live_inbox: false,
    // harn:end live-inbox-capability-is-evidence-backed
    // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-declarations
    // Only full-access emits a flag. read-only and workspace-write build IDENTICAL
    // arguments, so neither is enforced by us: both defer to copilot's own rules.
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': '--allow-all',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(
    private readonly command = 'copilot',
    private readonly home = process.env.COPILOT_HOME ?? join(homedir(), '.copilot'),
  ) {}

  spawn(opts: SpawnOpts): Session {
    copilotAllowAll(opts.policy);
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'copilot' does not support thinking levels");
    }
    return {
      harness: this.id,
      session_ref: randomUUID(),
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
    };
  }
  // harn:end canonical-spawn-controls-enforced

  // harn:assume adapters-own-their-model-catalog ref=copilot-model-catalog
  /**
   * Copilot's reachable models depend on the operator's subscription and their
   * org's policies, and its own CLI reference documents only `auto`. Offering a
   * fixed row would be a guess; `auto` plus the custom escape is the honest set.
   */
  listModels(): Promise<ModelCatalog> {
    return Promise.resolve({ models: ['auto'], source: 'curated' });
  }
  // harn:end adapters-own-their-model-catalog

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume remaining-cli-adapters-use-supervised-subprocesses ref=copilot-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=copilot-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    session.session_ref ??= randomUUID();
    const args = copilotArgs(session, payload);

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // harn:assume adapter-children-inherit-session-env ref=copilot-child-environment
      env: { ...process.env, ...session.env },
      // harn:end adapter-children-inherit-session-env
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

    try {
      try {
        await spawned;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield* translator.end({ status: 'failed', final_text: detail });
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });
      hooks.onSessionRef?.(session.session_ref);

      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        yield* translator.push(line);
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
  // harn:end remaining-cli-adapters-use-supervised-subprocesses

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('copilot programmatic mode disables ask_user and has no response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    let entries;
    try {
      entries = readdirSync(join(this.home, 'session-state'), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && UUID_RE.test(entry.name))
      .map((entry) => entry.name);
  }
}
// harn:assume copilot-capability-truth ref=copilot-capability-conformance
// Capability declarations above are exercised by synthetic fixture, translator,
// subprocess, local-store discovery, and CLI attach conformance tests.
// harn:end copilot-capability-truth
