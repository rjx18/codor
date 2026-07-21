/**
 * The setup wizard's pure navigation state machine.
 *
 * It holds the steps, their states, the view cursor, and each step's memoized
 * result. It performs no I/O, owns no terminal, and starts no timer — every
 * method returns synchronously after mutating in-memory state, so the whole
 * machine is asserted as values in tests.
 *
 * The one rule that matters: a step's work runs at most once. The machine never
 * runs work itself; it only records the outcome the caller reports. Navigation
 * moves the cursor over already-decided steps and cannot re-run them. The single
 * way to re-run a step is retry(), and only on a failed step — which resets it
 * to pending so the caller runs it again. That is how "Back must not repeat or
 * undo a completed side effect" holds structurally rather than by luck.
 */

export type SetupStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

/** An automatic step runs its work on entry; a choice step waits for the
 *  operator to select and confirm before its work commits. */
export type SetupStepKind = 'auto' | 'choice';

export interface SetupFlowStep {
  readonly title: string;
  readonly kind: SetupStepKind;
  state: SetupStepState;
  logs: string[];
  /** Memoized result of a completed step; undefined until done. */
  result?: unknown;
  /** One-line failure text while the step is failed. */
  error?: string;
}

export interface SetupStepDescriptor {
  title: string;
  kind?: SetupStepKind;
}

export class SetupFlow {
  readonly steps: SetupFlowStep[];
  private cursorIndex = 0;

  constructor(descriptors: readonly SetupStepDescriptor[]) {
    this.steps = descriptors.map((descriptor) => ({
      title: descriptor.title,
      kind: descriptor.kind ?? 'auto',
      state: 'pending' as SetupStepState,
      logs: [],
    }));
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get active(): SetupFlowStep {
    return this.steps[this.cursorIndex]!;
  }

  /** True once every step is done and the cursor rests on the last one. */
  get complete(): boolean {
    return this.steps.every((step) => step.state === 'done' || step.state === 'skipped')
      && this.cursorIndex === this.steps.length - 1;
  }

  /** The active step still needs its work run. Callers use this to decide
   *  whether entering the cursor should execute; a done step returns false so
   *  navigation past it never re-runs it. */
  get activeNeedsRun(): boolean {
    return this.active.state === 'pending';
  }

  get canBack(): boolean {
    return this.cursorIndex > 0;
  }

  /** Next is available once the active step has settled successfully. */
  get canNext(): boolean {
    const state = this.active.state;
    return (state === 'done' || state === 'skipped') && this.cursorIndex < this.steps.length - 1;
  }

  get canRetry(): boolean {
    return this.active.state === 'failed';
  }

  markRunning(index = this.cursorIndex): void {
    const step = this.steps[index];
    if (step !== undefined) {
      step.state = 'running';
      step.error = undefined;
    }
  }

  markDone(index: number, result?: unknown): void {
    const step = this.steps[index];
    if (step === undefined) return;
    step.state = 'done';
    step.result = result;
    step.error = undefined;
  }

  markSkipped(index: number): void {
    const step = this.steps[index];
    if (step !== undefined) step.state = 'skipped';
  }

  markFailed(index: number, error: string): void {
    const step = this.steps[index];
    if (step !== undefined) {
      step.state = 'failed';
      step.error = error;
    }
  }

  log(index: number, message: string): void {
    this.steps[index]?.logs.push(message);
  }

  /** Advance the cursor. Only legal when the active step has settled; it never
   *  mutates the step it leaves, so the step it lands on keeps whatever state it
   *  already had — a previously completed step is not reset. */
  next(): void {
    if (this.canNext) this.cursorIndex += 1;
  }

  /** Move the view cursor back. Purely a cursor move: the step left behind and
   *  the step returned to are both untouched. */
  back(): void {
    if (this.canBack) this.cursorIndex -= 1;
  }

  /** Reset a failed active step to pending so the caller runs its work again.
   *  The only operation that re-runs a step. */
  retry(): void {
    if (!this.canRetry) return;
    const step = this.active;
    step.state = 'pending';
    step.error = undefined;
    step.logs = [];
  }
}
