import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  SetupCancelled,
  SetupSession,
  isInteractiveSetup,
  type SetupSessionStreams,
  type SetupStepDefinition,
} from './setup-session.js';
import { SETUP_CURSOR_HIDE, SETUP_CURSOR_SHOW } from './setup-ui.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  resumed = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
  resume(): this { this.resumed = true; return this; }
  pause(): this { this.resumed = false; return this; }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  rows = 24;
  columns = 80;
  chunks: string[] = [];
  write(value: string): boolean { this.chunks.push(value); return true; }
}

function harness() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const signals = new EventEmitter();
  const raised: NodeJS.Signals[] = [];
  const session = new SetupSession({
    version: '0.10.0',
    streams: { input, output } as unknown as SetupSessionStreams,
    signalTarget: signals,
    raiseSignal: (signal) => raised.push(signal),
  });
  return { input, output, signals, raised, session };
}

/** Let pending step work resolve and the next input listener register. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

// harn:assume setup-restores-terminal-on-every-exit ref=setup-terminal-session-regression
describe('setup terminal ownership', () => {
  it('requires both streams to be TTYs', () => {
    const { input, output } = harness();
    expect(isInteractiveSetup({ input, output } as unknown as SetupSessionStreams)).toBe(true);
    output.isTTY = false;
    expect(isInteractiveSetup({ input, output } as unknown as SetupSessionStreams)).toBe(false);
  });

  it('restores raw mode, cursor, timers, and every listener on normal exit', () => {
    vi.useFakeTimers();
    const { input, output, signals, session } = harness();
    const initial = {
      data: input.listenerCount('data'),
      resize: output.listenerCount('resize'),
      int: signals.listenerCount('SIGINT'),
      term: signals.listenerCount('SIGTERM'),
    };
    session.start();
    expect(input.isRaw).toBe(true);
    expect(output.chunks.join('')).toContain(SETUP_CURSOR_HIDE);
    session.stop();
    expect(input.isRaw).toBe(false);
    expect(input.resumed).toBe(false);
    expect(output.chunks.at(-1)).toBe(SETUP_CURSOR_SHOW);
    expect(input.listenerCount('data')).toBe(initial.data);
    expect(output.listenerCount('resize')).toBe(initial.resize);
    expect(signals.listenerCount('SIGINT')).toBe(initial.int);
    expect(signals.listenerCount('SIGTERM')).toBe(initial.term);
    expect(vi.getTimerCount()).toBe(0);
    expect(output.chunks.join('')).not.toContain('[?1049h');
    vi.useRealTimers();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cleans up before re-raising %s', (signal) => {
    const { input, output, signals, raised, session } = harness();
    session.start();
    signals.emit(signal);
    expect(input.isRaw).toBe(false);
    expect(output.chunks.at(-1)).toBe(SETUP_CURSOR_SHOW);
    expect(raised).toEqual([signal]);
    expect(signals.listenerCount(signal)).toBe(0);
  });
});

describe('setup wizard navigation', () => {
  it('runs each step once, advances on Next, and finishes', async () => {
    const { input, session } = harness();
    const runs: string[] = [];
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async ({ log }) => { runs.push('one'); log('did one'); return 'one done'; } },
      { title: 'Two', run: async () => { runs.push('two'); return 'two done'; } },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> step Two
    await settle();
    input.emit('data', Buffer.from('\r')); // Next on the last, completed step -> finish
    await done;
    expect(runs).toEqual(['one', 'two']);
    session.stop();
  });

  it('offers a visible Finish action on the completed final step', async () => {
    const { input, output, session } = harness();
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async () => 'a' },
      { title: 'Two', run: async () => 'b' },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> the last, completed step
    await settle();
    // While parked on the completed last step the frame advertises Finish, not Next.
    expect(output.chunks.join('')).toContain('Enter/→ Finish');
    input.emit('data', Buffer.from('\r')); // Finish
    await done;
    session.stop();
  });

  it('does not re-run a completed step when navigating Back then Next', async () => {
    const { input, session } = harness();
    const runs: string[] = [];
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async () => { runs.push('one'); return 'a'; } },
      { title: 'Two', run: async () => { runs.push('two'); return 'b'; } },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('\r')); // -> Two (runs)
    await settle();
    input.emit('data', Buffer.from('[D')); // Back -> One (no re-run)
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> Two (already done, no re-run)
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> finish
    await done;
    expect(runs).toEqual(['one', 'two']);
    session.stop();
  });

  it('keeps a recoverable failure inside its step and re-runs only on Retry, without rethrowing', async () => {
    const { input, output, session } = harness();
    let attempts = 0;
    const steps: SetupStepDefinition[] = [
      { title: 'Flaky', run: async () => { attempts += 1; if (attempts === 1) throw new Error('bootstrap failed'); return 'ok'; } },
    ];
    const done = session.run(steps);
    await settle();
    // The failure is rendered in-step; run() has not rejected.
    expect(output.chunks.join('')).toContain('bootstrap failed');
    input.emit('data', Buffer.from('r')); // Retry -> re-run
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> finish
    await expect(done).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    session.stop();
  });

  it('presents a choice menu and passes the selection to the step work', async () => {
    const { input, session } = harness();
    let chosen: string | undefined;
    const steps: SetupStepDefinition[] = [
      {
        title: 'Choose',
        menu: {
          message: 'Choose.',
          options: [
            { id: 'localhost', label: 'Localhost', description: 'Local.', available: true },
            { id: 'tailscale', label: 'Tailscale', description: 'Remote.', available: true },
          ],
        },
        run: async ({ choice }) => { chosen = choice; return String(choice); },
      },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('[B')); // focus Tailscale
    input.emit('data', Buffer.from(' ')); // select it
    input.emit('data', Buffer.from('\r')); // confirm -> run work
    await settle();
    input.emit('data', Buffer.from('\r')); // Next -> finish
    await done;
    expect(chosen).toBe('tailscale');
    session.stop();
  });

  it('cancels on q, restoring the terminal', async () => {
    const { input, output, session } = harness();
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async () => 'a' },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('q'));
    await expect(done).rejects.toBeInstanceOf(SetupCancelled);
    expect(output.chunks.at(-1)).toBe(SETUP_CURSOR_SHOW);
    expect(input.isRaw).toBe(false);
  });
});
// harn:end setup-restores-terminal-on-every-exit
