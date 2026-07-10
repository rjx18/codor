import type {
  AskCard,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  WireEvent,
} from '@wireroom/protocol';

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
      status?: 'completed' | 'failed';
    }
  | {
      kind: 'ask';
      card: Omit<AskCard, 'interaction_id'>;
      /** Final text once answered (receives the answer). */
      reply: (answer: unknown) => string;
    }
  | { kind: 'die-silently' }; // stream ends with no run.completed

export interface DeliverRecord {
  payload: string;
  session_ref: string | undefined;
  cwd: string;
  policy: string | undefined;
  attached: boolean;
}

export class FakeAdapter implements HarnessAdapter {
  readonly id: string;
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: false,
    ask: true,
    approvals: 'runtime',
    extensions: false,
  } as const;

  private script: FakeTurn[] = [];
  readonly deliveries: DeliverRecord[] = [];
  readonly respondCalls: { interaction_id: string; answer: unknown }[] = [];
  private readonly pendingAnswers = new Map<string, (answer: unknown) => void>();
  private readonly attachedRefs = new Set<string>();
  private nextSession = 0;
  private nextRequest = 0;
  private concurrent = new Map<string, number>();
  maxConcurrent = 0;

  constructor(id = 'fake') {
    this.id = id;
  }

  enqueue(...turns: FakeTurn[]): void {
    this.script.push(...turns);
  }

  spawn(opts: SpawnOpts): Session {
    return { harness: this.id, cwd: opts.cwd, policy: opts.policy, model: opts.model };
  }

  attach(session_ref: SessionRef): Session {
    this.attachedRefs.add(session_ref);
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  wasAttached(ref: string): boolean {
    return this.attachedRefs.has(ref);
  }

  async *deliver(session: Session, payload: string): AsyncIterable<WireEvent> {
    if (session.session_ref === undefined) {
      session.session_ref = `fake-session-${++this.nextSession}`;
    }
    this.deliveries.push({
      payload,
      session_ref: session.session_ref,
      cwd: session.cwd,
      policy: session.policy,
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
      if (turn.kind === 'ask') {
        const nativeId = `fake-req-${++this.nextRequest}`;
        const answer = new Promise<unknown>((resolve) => this.pendingAnswers.set(nativeId, resolve));
        yield {
          type: turn.card.kind === 'ask' ? 'ask.raised' : 'approval.raised',
          card: { ...turn.card, interaction_id: nativeId },
        };
        const value = await answer; // the run is BLOCKED until answered
        yield {
          type: 'run.completed',
          status: 'completed',
          final_text: turn.reply(value),
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        return;
      }
      for (const item of turn.items ?? []) yield item;
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
    const resolve = this.pendingAnswers.get(interaction_id);
    if (!resolve) throw new Error(`no pending interaction ${interaction_id}`);
    this.pendingAnswers.delete(interaction_id);
    resolve(answer);
    await new Promise((r) => setImmediate(r)); // ack after the turn resumed
  }

  interrupt(): void {
    // no-op: scripted turns end themselves
  }

  discoverSessions(): SessionRef[] {
    return [];
  }
}
