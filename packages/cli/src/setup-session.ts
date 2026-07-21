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

/** What a wizard step does when the flow enters it. `run` performs the step's
 *  effectful work and returns a one-line summary; throwing marks the step failed
 *  and keeps the operator inside it with Retry. A `menu` makes the step a choice
 *  whose selected option id is passed to `run` as `context.choice`. */
export interface SetupStepContext {
  log(message: string): void;
  choice?: string;
}

export interface SetupStepDefinition {
  title: string;
  menu?: { message: string; options: SetupAccessOption[] };
  run(context: SetupStepContext): Promise<string>;
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
    }));
    const controls: SetupControls | undefined = this.awaitingNav
      ? { back: flow.canBack, next: flow.canNext, retry: flow.canRetry }
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

  /**
   * Drive the wizard over the given steps. Each step's work runs at most once;
   * navigation moves the cursor without re-running committed steps; Retry
   * re-runs a failed step. A recoverable failure stays inside its step (Retry /
   * Back) and is never rethrown out of the session.
   */
  async run(steps: readonly SetupStepDefinition[]): Promise<void> {
    const flow = new SetupFlow(steps.map((step) => ({
      title: step.title,
      kind: step.menu !== undefined ? 'choice' : 'auto',
    })));
    this.flow = flow;
    this.summaries.length = 0;
    this.start();

    for (;;) {
      const index = flow.cursor;
      const definition = steps[index]!;

      if (flow.activeNeedsRun) {
        let choice: string | undefined;
        if (definition.menu !== undefined) {
          // A choice step waits for a selection before its work commits.
          const decision = await this.selectFromMenu(definition.menu);
          if (decision.type === 'cancel') { this.stop(); throw new SetupCancelled(); }
          if (decision.type === 'back') { flow.back(); continue; }
          choice = decision.id;
        }

        flow.markRunning(index);
        this.render();
        try {
          const summary = await definition.run({ log: (message) => { flow.log(index, message); this.render(); }, choice });
          this.summaries[index] = summary;
          flow.markDone(index, { choice, summary });
        } catch (error) {
          // The failure renders once inside the step. It is not rethrown.
          flow.markFailed(index, error instanceof Error ? error.message : String(error));
        }
        this.render();
      }

      // The step has settled; wait for a navigation action.
      const action = await this.awaitNavigation();
      if (action === 'cancel') { this.stop(); throw new SetupCancelled(); }
      if (action === 'retry') { flow.retry(); continue; }
      if (action === 'back') { flow.back(); continue; }
      if (action === 'next') {
        if (flow.canNext) { flow.next(); continue; }
        if (flow.complete) return; // Next on the last, completed step finishes.
      }
    }
  }

  private awaitNavigation(): Promise<'next' | 'back' | 'retry' | 'cancel'> {
    this.awaitingNav = true;
    this.render();
    return this.readKeys<'next' | 'back' | 'retry' | 'cancel'>((key, settle) => {
      if (key.type === 'cancel') return settle('cancel');
      if (key.type === 'left' && this.flow!.canBack) return settle('back');
      if ((key.type === 'char' && key.value.toLowerCase() === 'r') && this.flow!.canRetry) return settle('retry');
      if (key.type === 'enter' || key.type === 'right') {
        if (this.flow!.canNext || this.flow!.complete) return settle('next');
        if (this.flow!.canRetry) return settle('retry');
      }
      return false;
    }).finally(() => { this.awaitingNav = false; });
  }

  private selectFromMenu(menu: { message: string; options: SetupAccessOption[] }):
  Promise<{ type: 'select'; id: string } | { type: 'back' } | { type: 'cancel' }> {
    const firstAvailable = menu.options.findIndex((option) => option.available);
    let focused = firstAvailable < 0 ? 0 : firstAvailable;
    let selected = firstAvailable < 0 ? undefined : menu.options[firstAvailable]!.id;
    this.menu = { message: menu.message, options: menu.options, focused, selected };
    this.render();

    return this.readKeys<{ type: 'select'; id: string } | { type: 'back' } | { type: 'cancel' }>((key, settle) => {
      if (key.type === 'cancel') { this.menu = undefined; return settle({ type: 'cancel' }); }
      if (key.type === 'left' && this.flow!.canBack) { this.menu = undefined; return settle({ type: 'back' }); }
      if (key.type === 'up') focused = (focused - 1 + menu.options.length) % menu.options.length;
      if (key.type === 'down') focused = (focused + 1) % menu.options.length;
      if (key.type === 'space') {
        const option = menu.options[focused];
        if (option?.available === true) selected = option.id;
      }
      if ((key.type === 'enter' || key.type === 'right') && selected !== undefined) {
        this.menu = undefined;
        return settle({ type: 'select', id: selected });
      }
      this.menu = { message: menu.message, options: menu.options, focused, selected };
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
