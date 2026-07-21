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

const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const ENTER = '\r';

/** Let pending step work resolve and the next input listener register. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

const consentMenu = (message: string, affirm: string, decline: string) => ({
  message,
  options: [
    { id: 'affirm', label: affirm, description: '', available: true },
    { id: 'decline', label: decline, description: '', available: true },
  ],
});

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
    expect(output.chunks.join('')).not.toContain('[?1049h');
    vi.useRealTimers();
  });

  it('threads a step description into the rendered frame', async () => {
    const { input, output, session } = harness();
    const steps: SetupStepDefinition[] = [
      { title: 'One', description: 'a short muted explanation', run: async () => 'a' },
    ];
    const done = session.run(steps);
    await settle();
    expect(output.chunks.join('')).toContain('a short muted explanation');
    input.emit('data', Buffer.from(ENTER));
    await done;
    session.stop();
  });

  it('lets a running step ask a mid-step vertical choice via choose()', async () => {
    const { input, session } = harness();
    let picked: string | undefined;
    const steps: SetupStepDefinition[] = [
      {
        title: 'Access',
        run: async ({ choose }) => {
          picked = await choose(consentMenu('Configure remote access?', 'Configure', 'Just this computer'));
          return String(picked);
        },
      },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from(DOWN)); // focus "Just this computer" (decline)
    input.emit('data', Buffer.from(ENTER)); // select it mid-step
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await done;
    expect(picked).toBe('decline');
    session.stop();
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
// harn:end setup-restores-terminal-on-every-exit

// harn:assume setup-auto-advances-and-gates-mutation-on-consent ref=setup-consent-navigation-regression
describe('setup wizard auto-advance', () => {
  it('runs automatic steps and advances without asking for Next', async () => {
    const { input, session } = harness();
    const runs: string[] = [];
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async ({ log }) => { runs.push('one'); log('did one'); return 'one done'; } },
      { title: 'Two', run: async () => { runs.push('two'); return 'two done'; } },
    ];
    const done = session.run(steps);
    await settle();
    // Both automatic steps ran with no key press between them.
    expect(runs).toEqual(['one', 'two']);
    input.emit('data', Buffer.from(ENTER)); // Finish on the completed last step
    await done;
    session.stop();
  });

  it('advertises Finish on the completed final step, not Next', async () => {
    const { input, output, session } = harness();
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async () => 'a' },
      { title: 'Two', run: async () => 'b' },
    ];
    const done = session.run(steps);
    await settle();
    const frame = output.chunks.join('');
    expect(frame).toContain('Enter Finish');
    expect(frame).not.toContain('Enter/→ Next');
    input.emit('data', Buffer.from(ENTER));
    await done;
    session.stop();
  });

  it('does not re-run a completed step when navigating Back then Forward', async () => {
    const { input, session } = harness();
    const runs: string[] = [];
    const steps: SetupStepDefinition[] = [
      { title: 'One', run: async () => { runs.push('one'); return 'a'; } },
      { title: 'Two', run: async () => { runs.push('two'); return 'b'; } },
    ];
    const done = session.run(steps);
    await settle();
    expect(runs).toEqual(['one', 'two']); // both auto-advanced
    input.emit('data', Buffer.from(LEFT)); // Back to step One (no re-run)
    await settle();
    input.emit('data', Buffer.from(RIGHT)); // Forward to step Two (already done)
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await done;
    expect(runs).toEqual(['one', 'two']);
    session.stop();
  });

  it('keeps a recoverable failure inside its step and re-runs only on Retry', async () => {
    const { input, output, session } = harness();
    let attempts = 0;
    const steps: SetupStepDefinition[] = [
      { title: 'Flaky', run: async () => { attempts += 1; if (attempts === 1) throw new Error('bootstrap failed'); return 'ok'; } },
    ];
    const done = session.run(steps);
    await settle();
    expect(output.chunks.join('')).toContain('bootstrap failed');
    input.emit('data', Buffer.from('r')); // Retry -> re-run
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await expect(done).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    session.stop();
  });

  it('cancels on q, restoring the terminal', async () => {
    const { input, output, session } = harness();
    const steps: SetupStepDefinition[] = [
      { title: 'Choose', menu: consentMenu('Pick?', 'A', 'B'), run: async () => 'a' },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from('q'));
    await expect(done).rejects.toBeInstanceOf(SetupCancelled);
    expect(output.chunks.at(-1)).toBe(SETUP_CURSOR_SHOW);
    expect(input.isRaw).toBe(false);
  });
});

describe('setup consent gates', () => {
  it('presents a vertical choice and passes the focused selection to the step', async () => {
    const { input, session } = harness();
    let chosen: string | undefined;
    const steps: SetupStepDefinition[] = [
      {
        title: 'Choose',
        menu: {
          message: 'How will you reach Codor?',
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
    input.emit('data', Buffer.from(DOWN)); // focus Tailscale
    input.emit('data', Buffer.from(ENTER)); // Enter selects the focused option directly
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await done;
    expect(chosen).toBe('tailscale');
    session.stop();
  });

  it('mutates only on the affirmative and skips both stages when Start is declined', async () => {
    const { input, session } = harness();
    const ran = { start: false, pair: false };
    const steps: SetupStepDefinition[] = [
      {
        title: 'Start Codor',
        menu: consentMenu('Run Codor in the background?', 'Start Codor', 'Not now'),
        run: async ({ choice }) => (choice === 'affirm'
          ? ((ran.start = true), 'started')
          : { skip: true, summary: '(run codor install when ready)', skipFollowing: true }),
      },
      {
        title: 'Create pairing code',
        menu: consentMenu('Pair a browser now?', 'Create a pairing code', 'Set this up later'),
        run: async ({ choice }) => (choice === 'affirm' ? ((ran.pair = true), 'paired') : { skip: true }),
      },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from(DOWN)); // focus "Not now"
    input.emit('data', Buffer.from(ENTER)); // decline -> skip start and cascade-skip pairing
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish (both skipped)
    await done;
    expect(ran).toEqual({ start: false, pair: false });
    session.stop();
  });

  it('keeps the running service and skips only pairing when pairing is declined', async () => {
    const { input, session } = harness();
    const ran = { start: false, pair: false };
    const steps: SetupStepDefinition[] = [
      {
        title: 'Start Codor',
        menu: consentMenu('Run Codor in the background?', 'Start Codor', 'Not now'),
        run: async ({ choice }) => (choice === 'affirm'
          ? ((ran.start = true), 'started')
          : { skip: true, skipFollowing: true }),
      },
      {
        title: 'Create pairing code',
        menu: consentMenu('Pair a browser now?', 'Create a pairing code', 'Set this up later'),
        run: async ({ choice }) => (choice === 'affirm' ? ((ran.pair = true), 'paired') : { skip: true }),
      },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from(ENTER)); // accept Start (focused affirmative)
    await settle();
    input.emit('data', Buffer.from(DOWN)); // focus "Set this up later"
    input.emit('data', Buffer.from(ENTER)); // decline pairing
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await done;
    expect(ran).toEqual({ start: true, pair: false });
    session.stop();
  });

  it('returns to the previous step with Back from a choice menu without re-running it', async () => {
    const { input, session } = harness();
    const runs: string[] = [];
    const steps: SetupStepDefinition[] = [
      {
        title: 'Choose access',
        menu: consentMenu('How will you reach Codor?', 'Localhost', 'Tailscale'),
        run: async () => { runs.push('access'); return 'localhost'; },
      },
      {
        title: 'Start Codor',
        menu: consentMenu('Run Codor in the background?', 'Start Codor', 'Not now'),
        run: async ({ choice }) => (choice === 'affirm' ? 'started' : { skip: true, skipFollowing: true }),
      },
    ];
    const done = session.run(steps);
    await settle();
    input.emit('data', Buffer.from(ENTER)); // select access (runs once) -> advance to Start menu
    await settle();
    input.emit('data', Buffer.from(LEFT)); // Back off the Start menu -> reviewing the done access step
    await settle();
    input.emit('data', Buffer.from(RIGHT)); // Forward -> Start menu again
    await settle();
    input.emit('data', Buffer.from(ENTER)); // accept Start
    await settle();
    input.emit('data', Buffer.from(ENTER)); // Finish
    await done;
    expect(runs).toEqual(['access']); // access ran exactly once despite Back/Forward
    session.stop();
  });
});
// harn:end setup-auto-advances-and-gates-mutation-on-consent
