import type {
  AdapterCapabilities,
  AdapterTurnHooks,
  AgentUsage,
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
      // harn:assume failed-run-details-never-route-as-replies ref=fake-failed-turn-detail
      error?: string;
      // harn:end failed-run-details-never-route-as-replies
      usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
      agent_usage?: AgentUsage;
      items?: WireEvent[];
      item_delay_ms?: number;
      delay_ms?: number;
      status?: 'completed' | 'failed';
      steps?: FakeTurnStep[];
    }
  | {
      kind: 'ask';
      card: Omit<AskCard, 'interaction_id'>;
      /** Final text once answered (receives the answer). */
      reply: (answer: unknown) => string;
    }
  // harn:assume failed-run-details-never-route-as-replies ref=fake-failed-turn-detail
  | { kind: 'fail-on-interrupt'; final_text?: string; error?: string }
  // harn:end failed-run-details-never-route-as-replies
  | { kind: 'die-silently' }; // stream ends with no run.completed

export type FakeTurnStep =
  | { kind: 'interim_post'; body: string; awaiting_reply?: boolean }
  | {
      kind: 'wait';
      reason: 'reply' | 'mention' | 'any';
      peers: string[];
      duration_ms: number;
    };

export type FakeTurnStepHandler = (session: Session, step: FakeTurnStep) => void | Promise<void>;

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

export interface SteerRecord {
  payload: string;
  session_ref: string | undefined;
}

export class FakeAdapter implements HarnessAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  private script: FakeTurn[] = [];
  readonly deliveries: DeliverRecord[] = [];
  // harn:assume active-turn-steering-is-ordered-and-durable ref=fake-active-turn-steering
  readonly steers: SteerRecord[] = [];
  steerDelayMs = 0;
  maxConcurrentSteers = 0;
  private concurrentSteers = 0;
  private nextSteerError: Error | undefined;
  // harn:end active-turn-steering-is-ordered-and-durable
  // harn:assume context-peek-reads-session-artifacts ref=adapter-peek-contract
  /** Scriptable pre-turn context estimate; undefined = no artifact. */
  peekUsage: AgentUsage | undefined;
  peekContextUsage(): Promise<AgentUsage | undefined> {
    return Promise.resolve(this.peekUsage === undefined ? undefined : { ...this.peekUsage });
  }
  // harn:end context-peek-reads-session-artifacts
  readonly respondCalls: { interaction_id: string; answer: unknown }[] = [];
  private readonly pendingAnswers = new Map<string, (answer: unknown) => void>();
  private readonly pendingBySession = new WeakMap<Session, string>();
  private readonly attachedRefs = new Set<string>();
  private nextSession = 0;
  private nextRequest = 0;
  private nextResponseError: Error | undefined;
  private concurrent = new Map<string, number>();
  maxConcurrent = 0;

  constructor(
    id = 'fake',
    capabilities: Partial<AdapterCapabilities> = {},
    private readonly handleStep?: FakeTurnStepHandler,
  ) {
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

  failNextSteer(message: string): void {
    this.nextSteerError = new Error(message);
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
          ...(turn.error !== undefined
            ? { error: turn.error }
            : { final_text: turn.final_text ?? 'process exited 130 after SIGINT' }),
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
      // harn:assume fake-adapter-drives-live-collaboration ref=fake-live-step-vocabulary
      for (const step of turn.steps ?? []) {
        if (!this.handleStep) throw new Error(`fake step ${step.kind} has no handler`);
        await this.handleStep(session, step);
      }
      // harn:end fake-adapter-drives-live-collaboration
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
        // harn:assume failed-run-details-never-route-as-replies ref=fake-failed-turn-detail
        ...(turn.error !== undefined && { error: turn.error }),
        // harn:end failed-run-details-never-route-as-replies
        usage: turn.usage ?? { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
        ...(turn.agent_usage !== undefined && { agent_usage: turn.agent_usage }),
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

  // harn:assume active-turn-steering-is-ordered-and-durable ref=fake-active-turn-steering
  async steer(session: Session, payload: string): Promise<boolean> {
    this.steers.push({ payload, session_ref: session.session_ref });
    this.concurrentSteers += 1;
    this.maxConcurrentSteers = Math.max(this.maxConcurrentSteers, this.concurrentSteers);
    try {
      if (this.steerDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.steerDelayMs));
      }
      if (this.nextSteerError !== undefined) {
        const error = this.nextSteerError;
        this.nextSteerError = undefined;
        throw error;
      }
      return true;
    } finally {
      this.concurrentSteers -= 1;
    }
  }
  // harn:end active-turn-steering-is-ordered-and-durable

  /**
   * Observable stand-in for a harness's native compaction: records the call and
   * returns whatever re-baseline the test staged, so the daemon's gate and the
   * ring update can be proven without a real engine. It is an own property, so
   * a test can delete it to model a harness that cannot compact at all.
   */
  compactUsage: AgentUsage | undefined;
  readonly compactions: Session[] = [];
  /**
   * When held, compactSession parks until released. A UI test needs the
   * in-flight state to be a fact it controls, not a race it hopes to observe.
   */
  private compactionHold: (() => void) | null = null;
  private heldCompactions: Array<() => void> = [];

  holdCompactions(): void {
    this.compactionHold = () => undefined;
  }

  releaseCompactions(): void {
    this.compactionHold = null;
    const waiting = this.heldCompactions;
    this.heldCompactions = [];
    for (const release of waiting) release();
  }

  compactSession = async (session: Session): Promise<AgentUsage | undefined> => {
    this.compactions.push(session);
    if (this.compactionHold !== null) {
      await new Promise<void>((resolve) => this.heldCompactions.push(resolve));
    }
    return await Promise.resolve(this.compactUsage);
  };

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
