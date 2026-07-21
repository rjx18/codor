import { EventEmitter } from 'node:events';

import { SetupFlow } from './setup-flow.js';
import {
  SETUP_CURSOR_HIDE,
  SETUP_CURSOR_SHOW,
  renderSetupFrame,
  type SetupAccessOption,
  type SetupControls,
  type SetupStage,
  type SetupSummary,
} from './setup-ui.js';
import { TerminalKeyDecoder, type SetupKey } from './terminal-keys.js';

const ESCAPE_FLUSH_MS = 40;
const SPINNER_INTERVAL_MS = 90;

export interface SetupSessionStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

interface SetupSignalTarget extends EventEmitter {
  once(event: NodeJS.Signals, listener: () => void): this;
  off(event: NodeJS.Signals, listener: () => void): this;
}

export interface SetupSessionOptions {
  version: string;
  byline?: string;
  streams?: SetupSessionStreams;
  signalTarget?: SetupSignalTarget;
  raiseSignal?: (signal: NodeJS.Signals) => void;
}

export function isInteractiveSetup(streams?: Partial<SetupSessionStreams>): boolean {
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;
  return Boolean(input.isTTY) && Boolean(output.isTTY);
}

export class SetupCancelled extends Error {
  constructor() {
    super('Setup cancelled.');
    this.name = 'SetupCancelled';
  }
}

/** A step's outcome: a one-line summary when its work ran, or a skip decision.
 *  `skipFollowing` cascades the skip to every later step (declining Start also
 *  skips pairing) so the wizard can finish honestly without mutating. */
export type SetupStepOutcome =
  | string
  | { skip: true; summary?: string; skipFollowing?: boolean };

/** What a wizard step does when the flow enters it. `run` performs the step's
 *  effectful work and returns a summary; throwing marks the step failed and
 *  keeps the operator inside it with Retry. A `menu` makes the step a vertical
 *  choice whose selected option id is passed to `run` as `context.choice`; a
 *  consent step returns a skip outcome when the operator declines, and no
 *  mutation happens because the effectful work is never called. */
export interface SetupStepContext {
  log(message: string): void;
  choice?: string;
  /** Present a vertical choice while the step is running and resolve to the
   *  selected option id. Cancel (q / Ctrl-C) aborts setup. */
  choose(menu: { message: string; options: SetupAccessOption[] }): Promise<string>;
}

export interface SetupStepDefinition {
  title: string;
  /** Short muted line shown under the heading while the step is active. */
  description?: string;
  menu?: { message: string; options: SetupAccessOption[] };
  run(context: SetupStepContext): Promise<SetupStepOutcome>;
}

// harn:assume setup-restores-terminal-on-every-exit ref=setup-terminal-session
export class SetupSession {
  private flow: SetupFlow | undefined;
  private readonly summaries: (string | undefined)[] = [];

  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly signalTarget: SetupSignalTarget;
  private readonly raiseSignal: (signal: NodeJS.Signals) => void;
  private readonly version: string;
  private readonly byline: string;
  private readonly detachers: Array<() => void> = [];
  private spinner: NodeJS.Timeout | undefined;
  private frame = 0;
  private summary: SetupSummary | undefined;
  private menu: Parameters<typeof renderSetupFrame>[0]['menu'];
  private awaitingNav = false;
  private priorRawMode = false;
  private started = false;

  constructor(options: SetupSessionOptions) {
    this.input = options.streams?.input ?? process.stdin;
    this.output = options.streams?.output ?? process.stdout;
    this.signalTarget = options.signalTarget ?? process;
    this.raiseSignal = options.raiseSignal ?? ((signal) => process.kill(process.pid, signal));
    this.version = options.version;
    this.byline = options.byline ?? 'created by richhardry';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.priorRawMode = this.input.isRaw === true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.output.write(SETUP_CURSOR_HIDE);

    const onResize = (): void => this.render();
    this.output.on('resize', onResize);
    this.detachers.push(() => this.output.off('resize', onResize));

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = (): void => {
        this.stop();
        this.raiseSignal(signal);
      };
      this.signalTarget.once(signal, onSignal);
      this.detachers.push(() => this.signalTarget.off(signal, onSignal));
    }

    this.spinner = setInterval(() => {
      this.frame += 1;
      this.render();
    }, SPINNER_INTERVAL_MS);
    this.render();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.spinner !== undefined) clearInterval(this.spinner);
    this.spinner = undefined;
    while (this.detachers.length > 0) this.detachers.pop()?.();
    if (this.input.isTTY) this.input.setRawMode(this.priorRawMode);
    this.input.pause();
    this.output.write(SETUP_CURSOR_SHOW);
  }

  finish(summary: SetupSummary): void {
    this.summary = summary;
    this.stop();
    this.render();
  }

  render(): void {
    const flow = this.flow;
    if (flow === undefined) return;
    const steps: SetupStage[] = flow.steps.map((step, index) => ({
      title: step.title,
      state: step.state,
      logs: step.logs,
      summary: this.summaries[index],
      error: step.error,
      description: step.description,
    }));
    // Controls are supplied only while awaiting a settled action; a live menu
    // renders its own navigation hint. Forward appears when a later step can be
    // reviewed, Finish only on the completed final step.
    const controls: SetupControls | undefined = this.awaitingNav
      ? { back: flow.canBack, forward: flow.canNext, retry: flow.canRetry, finish: flow.complete }
      : undefined;
    this.output.write(renderSetupFrame({
      version: this.version,
      byline: this.byline,
      steps,
      cursor: flow.cursor,
      spinnerFrame: this.frame,
      viewport: { rows: this.output.rows ?? 24, columns: this.output.columns ?? 80 },
      menu: this.menu,
      controls,
      summary: this.summary,
    }));
  }

  // harn:assume setup-auto-advances-and-gates-mutation-on-consent ref=setup-consent-navigation
  /**
   * Drive the wizard over the given steps. Automatic steps run and advance
   * without asking for Next; a choice step waits at its vertical menu; a consent
   * decline skips honestly (cascading to later steps when asked) without
   * mutating; a failure stays inside its step with Retry; Back only moves the
   * cursor and never re-runs committed work; the completed final step waits for
   * Finish. A recoverable failure is never rethrown out of the session.
   */
  async run(steps: readonly SetupStepDefinition[]): Promise<void> {
    const flow = new SetupFlow(steps.map((step) => ({
      title: step.title,
      kind: step.menu !== undefined ? 'choice' : 'auto',
      description: step.description,
    })));
    this.flow = flow;
    this.summaries.length = 0;
    this.start();

    // Forward momentum: a step that just settled advances automatically; landing
    // on a step via Back clears it so the reviewed step pauses for navigation.
    let advance = true;

    for (;;) {
      const index = flow.cursor;
      const definition = steps[index]!;

      if (flow.activeNeedsRun) {
        let choice: string | undefined;
        if (definition.menu !== undefined) {
          const decision = await this.selectFromMenu(definition.menu, flow.canBack);
          if (decision.type === 'cancel') { this.stop(); throw new SetupCancelled(); }
          if (decision.type === 'back') { flow.back(); advance = false; continue; }
          choice = decision.id;
        }

        flow.markRunning(index);
        this.render();
        // A running step may ask further vertical choices (e.g. remote access
        // consent) through choose(); cancel aborts the whole session.
        const choose = async (menu: { message: string; options: SetupAccessOption[] }): Promise<string> => {
          const decision = await this.selectFromMenu(menu, false);
          if (decision.type !== 'select') { this.stop(); throw new SetupCancelled(); }
          return decision.id;
        };
        try {
          const outcome = await definition.run({ log: (message) => { flow.log(index, message); this.render(); }, choice, choose });
          if (typeof outcome === 'object') {
            this.summaries[index] = outcome.summary;
            flow.markSkipped(index);
            if (outcome.skipFollowing === true) {
              for (let later = index + 1; later < steps.length; later += 1) {
                this.summaries[later] = undefined;
                flow.markSkipped(later);
              }
            }
          } else {
            this.summaries[index] = outcome;
            flow.markDone(index, { choice, summary: outcome });
          }
        } catch (error) {
          // The failure renders once inside the step. It is not rethrown.
          flow.markFailed(index, error instanceof Error ? error.message : String(error));
        }
        this.render();
        advance = true;
      }

      if (flow.active.state === 'failed') {
        const action = await this.awaitSettledAction();
        if (action === 'cancel') { this.stop(); throw new SetupCancelled(); }
        if (action === 'retry') { flow.retry(); advance = true; continue; }
        if (action === 'back') { flow.back(); advance = false; continue; }
        continue;
      }

      // A step that just settled advances automatically; automatic steps never
      // wait for Next. Only a genuine stop — the completed final step or a step
      // reviewed via Back — pauses for a navigation action.
      if (advance && flow.canNext) { flow.next(); continue; }

      const action = await this.awaitSettledAction();
      if (action === 'cancel') { this.stop(); throw new SetupCancelled(); }
      if (action === 'back') { flow.back(); advance = false; continue; }
      if (action === 'forward' && flow.canNext) { flow.next(); advance = false; continue; }
      if (action === 'finish' && flow.complete) return;
    }
  }
  // harn:end setup-auto-advances-and-gates-mutation-on-consent

  /** Await a settled step's navigation. Left is Back, r retries a failed step,
   *  Enter/Right retries a failed step, finishes the completed last step, or
   *  moves forward over a reviewed step. */
  private awaitSettledAction(): Promise<'back' | 'forward' | 'retry' | 'finish' | 'cancel'> {
    this.awaitingNav = true;
    this.render();
    return this.readKeys<'back' | 'forward' | 'retry' | 'finish' | 'cancel'>((key, settle) => {
      const flow = this.flow!;
      if (key.type === 'cancel') return settle('cancel');
      if (key.type === 'left' && flow.canBack) return settle('back');
      if (key.type === 'char' && key.value.toLowerCase() === 'r' && flow.canRetry) return settle('retry');
      if (key.type === 'enter' || key.type === 'right') {
        if (flow.canRetry) return settle('retry');
        if (flow.complete) return settle('finish');
        if (flow.canNext) return settle('forward');
      }
      return false;
    }).finally(() => { this.awaitingNav = false; });
  }

  /** A vertical single-select menu. Up/Down move focus, Enter selects the
   *  focused option when it is available, Left goes Back, q cancels. */
  private selectFromMenu(menu: { message: string; options: SetupAccessOption[] }, canBack: boolean):
  Promise<{ type: 'select'; id: string } | { type: 'back' } | { type: 'cancel' }> {
    const firstAvailable = menu.options.findIndex((option) => option.available);
    let focused = firstAvailable < 0 ? 0 : firstAvailable;
    this.menu = { message: menu.message, options: menu.options, focused, canBack };
    this.render();

    return this.readKeys<{ type: 'select'; id: string } | { type: 'back' } | { type: 'cancel' }>((key, settle) => {
      if (key.type === 'cancel') { this.menu = undefined; return settle({ type: 'cancel' }); }
      if (key.type === 'left' && canBack) { this.menu = undefined; return settle({ type: 'back' }); }
      if (key.type === 'up') focused = (focused - 1 + menu.options.length) % menu.options.length;
      if (key.type === 'down') focused = (focused + 1) % menu.options.length;
      if (key.type === 'enter' || key.type === 'right') {
        const option = menu.options[focused];
        if (option?.available === true) {
          this.menu = undefined;
          return settle({ type: 'select', id: option.id });
        }
      }
      this.menu = { message: menu.message, options: menu.options, focused, canBack };
      this.render();
      return false;
    });
  }

  /** Shared raw-input reader. `handle` returns a settle() call to resolve, or
   *  false to keep listening. Registers its teardown so stop() detaches it. */
  private readKeys<T>(handle: (key: SetupKey, settle: (value: T) => true) => boolean | true): Promise<T> {
    return new Promise<T>((resolve) => {
      const decoder = new TerminalKeyDecoder();
      let flushTimer: NodeJS.Timeout | undefined;
      const detach = (): void => {
        this.input.off('data', onData);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
      };
      this.detachers.push(detach);
      const settle = (value: T): true => { detach(); resolve(value); return true; };
      const apply = (key: SetupKey): boolean => handle(key, settle) === true;
      const onData = (chunk: Buffer): void => {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        for (const key of decoder.decode(chunk.toString('utf8'))) {
          if (apply(key)) return;
        }
        if (decoder.hasPending) {
          flushTimer = setTimeout(() => {
            for (const key of decoder.flush()) {
              if (apply(key)) return;
            }
          }, ESCAPE_FLUSH_MS);
        }
      };
      this.input.on('data', onData);
    });
  }
}
// harn:end setup-restores-terminal-on-every-exit
