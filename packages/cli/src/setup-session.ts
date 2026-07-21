import { EventEmitter } from 'node:events';

import {
  SETUP_CURSOR_HIDE,
  SETUP_CURSOR_SHOW,
  createSetupStages,
  renderSetupFrame,
  type SetupAccessOption,
  type SetupStage,
  type SetupStageState,
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

// harn:assume setup-restores-terminal-on-every-exit ref=setup-terminal-session
export class SetupSession {
  readonly stages: SetupStage[] = createSetupStages();

  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly signalTarget: SetupSignalTarget;
  private readonly raiseSignal: (signal: NodeJS.Signals) => void;
  private readonly version: string;
  private readonly byline: string;
  private readonly detachers: Array<() => void> = [];
  private spinner: NodeJS.Timeout | undefined;
  private frame = 0;
  private title = 'Setup';
  private summary: SetupSummary | undefined;
  private failure: string | undefined;
  private menu: Parameters<typeof renderSetupFrame>[0]['menu'];
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

  setStage(index: number, state: SetupStageState): void {
    if (this.stages[index] !== undefined) this.stages[index]!.state = state;
    this.render();
  }

  log(index: number, message: string): void {
    this.stages[index]?.logs.push(message);
    this.render();
  }

  finish(summary: SetupSummary): void {
    this.summary = summary;
    this.title = 'Setup complete';
    this.stop();
    this.render();
  }

  fail(message: string): void {
    this.failure = message;
    this.title = 'Setup failed';
    this.stop();
    this.render();
  }

  render(): void {
    this.output.write(renderSetupFrame({
      version: this.version,
      byline: this.byline,
      title: this.title,
      stages: this.stages,
      spinnerFrame: this.frame,
      viewport: { rows: this.output.rows ?? 24, columns: this.output.columns ?? 80 },
      menu: this.menu,
      summary: this.summary,
      failure: this.failure,
    }));
  }

  async chooseAccess(message: string, options: SetupAccessOption[]): Promise<string> {
    const firstAvailable = options.findIndex((option) => option.available);
    if (firstAvailable < 0) throw new Error('setup has no available access method');
    let focused = firstAvailable;
    let selected = options[firstAvailable]!.id;
    this.menu = { message, options, focused, selected };
    this.render();

    return new Promise<string>((resolve, reject) => {
      const decoder = new TerminalKeyDecoder();
      let flushTimer: NodeJS.Timeout | undefined;

      const detachInput = (): void => {
        this.input.off('data', onData);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
      };
      this.detachers.push(detachInput);

      const settle = (finish: () => void): void => {
        detachInput();
        this.menu = undefined;
        finish();
      };

      const apply = (key: SetupKey): boolean => {
        if (key.type === 'cancel') {
          settle(() => reject(new SetupCancelled()));
          return true;
        }
        if (key.type === 'up') focused = (focused - 1 + options.length) % options.length;
        if (key.type === 'down') focused = (focused + 1) % options.length;
        if (key.type === 'space') {
          const option = options[focused];
          if (option?.available === true) selected = option.id;
          else this.stages[2]?.logs.push(`${option?.label ?? 'That option'} is unavailable`);
        }
        if (key.type === 'enter' && selected !== undefined) {
          settle(() => resolve(selected!));
          return true;
        }
        return false;
      };

      const renderOnce = (): void => {
        this.menu = { message, options, focused, selected };
        this.render();
      };

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
            renderOnce();
          }, ESCAPE_FLUSH_MS);
        }
        renderOnce();
      };

      this.input.on('data', onData);
    });
  }
}
// harn:end setup-restores-terminal-on-every-exit
