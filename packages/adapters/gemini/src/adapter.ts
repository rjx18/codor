import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { PolicySchema } from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

export function geminiApprovalMode(policy: string | undefined): string | undefined {
  if (policy === undefined) return undefined;
  if (!PolicySchema.safeParse(policy).success) {
    throw new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
  }
  return { 'read-only': 'plan', 'workspace-write': 'auto_edit', 'full-access': 'yolo' }[policy];
}

// harn:assume canonical-spawn-controls-enforced ref=gemini-spawn-control-mapping
export function geminiArgs(session: Session, payload: string): string[] {
  if (session.thinking !== undefined) {
    throw new Error("adapter 'gemini' does not support thinking levels");
  }
  const args = ['--output-format', 'stream-json'];
  if (session.model !== undefined) args.push('--model', session.model);
  const approvalMode = geminiApprovalMode(session.policy);
  if (approvalMode !== undefined) args.push('--approval-mode', approvalMode);
  if (session.session_ref !== undefined) args.push('--resume', session.session_ref);
  args.push('--prompt', payload);
  return args;
}

function sessionIdFromFile(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as {
        sessionId?: unknown;
        $set?: { sessionId?: unknown; kind?: unknown };
        kind?: unknown;
      };
      const kind = record.$set?.kind ?? record.kind;
      if (kind === 'subagent') return undefined;
      const value = record.$set?.sessionId ?? record.sessionId;
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Direct `gemini` headless CLI driver. See NOTES.md for the behavioral sources. */
export class GeminiAdapter implements HarnessAdapter {
  readonly id = 'gemini';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: false,
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(
    private readonly command = 'gemini',
    private readonly home = join(homedir(), '.gemini'),
  ) {}

  spawn(opts: SpawnOpts): Session {
    geminiApprovalMode(opts.policy);
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'gemini' does not support thinking levels");
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

  // harn:assume adapters-cli-only-no-sdk ref=gemini-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=gemini-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const args = geminiArgs(session, payload);

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
  // harn:end adapter-process-lifecycle-supervised
  // harn:end adapters-cli-only-no-sdk

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('gemini headless stream-json exposes no interaction response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    const refs = new Set<SessionRef>();
    const tmp = join(this.home, 'tmp');
    let projects;
    try {
      projects = readdirSync(tmp, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chats = join(tmp, project.name, 'chats');
      let entries;
      try {
        entries = readdirSync(chats, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/\.jsonl?$/.test(entry.name)) continue;
        const ref = sessionIdFromFile(join(chats, entry.name));
        if (ref !== undefined) refs.add(ref);
      }
    }
    return [...refs];
  }
}
// harn:assume gemini-capability-truth ref=gemini-capability-conformance
// Capability declarations above are exercised by index.spec.ts, adapter.spec.ts,
// fixtures.spec.ts, translate.spec.ts, and the authenticated MANUAL-VERIFY.md probe.
// harn:end gemini-capability-truth
