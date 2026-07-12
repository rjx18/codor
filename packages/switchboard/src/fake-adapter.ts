import type {
  AdapterCapabilities,
  AdapterTurnHooks,
  AskCard,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@codor/protocol';

/**
 * Scriptable in-memory adapter for integration tests. Each deliver() call
 * consumes the next scripted turn. Native interaction ids are freshly minted
 * per raise — exactly like the real harness after a crash.
 */
export type FakeTurn =
  | {
      kind: 'complete';
      final_text: string;
      usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
      items?: WireEvent[];
      item_delay_ms?: number;
      delay_ms?: number;
      status?: 'completed' | 'failed';
    }
  | {
      kind: 'ask';
      card: Omit<AskCard, 'interaction_id'>;
      /** Final text once answered (receives the answer). */
      reply: (answer: unknown) => string;
    }
  | { kind: 'fail-on-interrupt'; final_text?: string }
  | { kind: 'die-silently' }; // stream ends with no run.completed

export interface DeliverRecord {
  payload: string;
  session_ref: string | undefined;
  cwd: string;
  policy: string | undefined;
  // harn:assume canonical-spawn-controls-enforced ref=fake-adapter-delivery-record
  // What the harness was ACTUALLY handed for this turn. A real harness holds no state:
  // these are argv, re-derived from the session every turn, so this record is the only
  // honest witness to what the operator's agent was actually run as.
  model: Session['model'];
  thinking: Session['thinking'];
  // harn:end canonical-spawn-controls-enforced
  attached: boolean;
}

export class FakeAdapter implements HarnessAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  private script: FakeTurn[] = [];
  readonly deliveries: DeliverRecord[] = [];
  readonly respondCalls: { interaction_id: string; answer: unknown }[] = [];
  private readonly pendingAnswers = new Map<string, (answer: unknown) => void>();
  private readonly pendingBySession = new WeakMap<Session, string>();
  private readonly attachedRefs = new Set<string>();
  private nextSession = 0;
  private nextRequest = 0;
  private nextResponseError: Error | undefined;
  private concurrent = new Map<string, number>();
  maxConcurrent = 0;

  constructor(id = 'fake', capabilities: Partial<AdapterCapabilities> = {}) {
    this.id = id;
    this.capabilities = {
      resume: true,
      discover: true,
      interactiveAttach: false,
      ask: true,
      approvals: 'runtime',
      extensions: false,
      // harn:assume canonical-spawn-controls-enforced ref=fake-thinking-capability
      thinking: false,
      // The fake harness declares its mapping like any other; tests that need a
      // deferring harness pass their own.
      policies: {
        'read-only': 'read-only',
        'workspace-write': 'workspace-write',
        'full-access': 'full-access',
      },
      // harn:end canonical-spawn-controls-enforced
      ...capabilities,
    };
  }

  enqueue(...turns: FakeTurn[]): void {
    this.script.push(...turns);
  }

  failNextResponse(message: string): void {
    this.nextResponseError = new Error(message);
  }

  spawn(opts: SpawnOpts): Session {
    return {
      harness: this.id,
      cwd: opts.cwd,
      policy: opts.policy,
      model: opts.model,
      thinking: opts.thinking,
    };
  }

  attach(session_ref: SessionRef): Session {
    this.attachedRefs.add(session_ref);
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  wasAttached(ref: string): boolean {
    return this.attachedRefs.has(ref);
  }

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    hooks.onStarted?.({});
    if (session.session_ref === undefined) {
      session.session_ref = `fake-session-${++this.nextSession}`;
      hooks.onSessionRef?.(session.session_ref);
    }
    this.deliveries.push({
      payload,
      session_ref: session.session_ref,
      cwd: session.cwd,
      policy: session.policy,
      model: session.model,
      thinking: session.thinking,
      attached: this.attachedRefs.has(session.session_ref),
    });

    const key = session.session_ref;
    const running = (this.concurrent.get(key) ?? 0) + 1;
    this.concurrent.set(key, running);
    this.maxConcurrent = Math.max(this.maxConcurrent, running);
    try {
      const turn = this.script.shift();
      if (!turn) {
        // Fail loudly: completing with routable text here would let default
        // routing ping-pong two agents forever (a failed turn kills the
        // member and stops the chain — tests must script every turn).
        yield { type: 'run.completed', status: 'failed', final_text: '(unscripted turn)' };
        return;
      }
      if (turn.kind === 'die-silently') {
        return; // EOF with no completion — daemon sees 'interrupted'
      }
      if (turn.kind === 'fail-on-interrupt') {
        const nativeId = `fake-interrupt-${++this.nextRequest}`;
        const interrupted = new Promise<unknown>((resolve) => this.pendingAnswers.set(nativeId, resolve));
        this.pendingBySession.set(session, nativeId);
        await interrupted;
        this.pendingBySession.delete(session);
        yield {
          type: 'run.completed',
          status: 'failed',
          final_text: turn.final_text ?? 'process exited 130 after SIGINT',
        };
        return;
      }
      if (turn.kind === 'ask') {
        const nativeId = `fake-req-${++this.nextRequest}`;
        const answer = new Promise<unknown>((resolve) => this.pendingAnswers.set(nativeId, resolve));
        this.pendingBySession.set(session, nativeId);
        yield {
          type: turn.card.kind === 'ask' ? 'ask.raised' : 'approval.raised',
          card: { ...turn.card, interaction_id: nativeId },
        };
        const value = await answer; // the run is BLOCKED until answered
        this.pendingBySession.delete(session);
        if (value === INTERRUPTED) {
          yield { type: 'run.completed', status: 'interrupted' };
          return;
        }
        yield {
          type: 'run.completed',
          status: 'completed',
          final_text: turn.reply(value),
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        return;
      }
      // harn:assume normalized-run-items-presented-live ref=delayed-fake-run-fixture
      for (const item of turn.items ?? []) {
        yield item;
        if (turn.item_delay_ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, turn.item_delay_ms));
        }
      }
      if (turn.delay_ms !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, turn.delay_ms));
      }
      // harn:end normalized-run-items-presented-live
      yield {
        type: 'run.completed',
        status: turn.status ?? 'completed',
        final_text: turn.final_text,
        usage: turn.usage ?? { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
      };
    } finally {
      this.concurrent.set(key, (this.concurrent.get(key) ?? 1) - 1);
    }
  }

  async respondInteraction(_session: Session, interaction_id: string, answer: unknown): Promise<void> {
    this.respondCalls.push({ interaction_id, answer });
    if (this.nextResponseError) {
      const error = this.nextResponseError;
      this.nextResponseError = undefined;
      throw error;
    }
    const resolve = this.pendingAnswers.get(interaction_id);
    if (!resolve) throw new Error(`no pending interaction ${interaction_id}`);
    this.pendingAnswers.delete(interaction_id);
    resolve(answer);
    await new Promise((r) => setImmediate(r)); // ack after the turn resumed
  }

  interrupt(session: Session): void {
    const nativeId = this.pendingBySession.get(session);
    if (!nativeId) return;
    const resolve = this.pendingAnswers.get(nativeId);
    this.pendingAnswers.delete(nativeId);
    this.pendingBySession.delete(session);
    resolve?.(INTERRUPTED);
  }

  discoverSessions(): SessionRef[] {
    return [];
  }
}

const INTERRUPTED = Symbol('fake turn interrupted');
