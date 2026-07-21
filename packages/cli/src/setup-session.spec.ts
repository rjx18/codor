import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  SetupCancelled,
  SetupSession,
  isInteractiveSetup,
  type SetupSessionStreams,
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
    expect(output.chunks.join('')).not.toContain('\u001B[?1049h');
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

  it('moves focus, makes Space selection visible, and confirms with Enter', async () => {
    const { input, output, session } = harness();
    session.start();
    const selected = session.chooseAccess('Choose.', [
      { id: 'localhost', label: 'Localhost', description: 'Local.', available: true },
      { id: 'tailscale', label: 'Tailscale', description: 'Remote.', available: true },
    ]);
    input.emit('data', Buffer.from('\u001B[B'));
    input.emit('data', Buffer.from(' '));
    expect(output.chunks.join('')).toContain('Tailscale');
    input.emit('data', Buffer.from('\r'));
    await expect(selected).resolves.toBe('tailscale');
    session.stop();
  });

  it('flushes a bare Escape into cancellation and removes the data listener', async () => {
    vi.useFakeTimers();
    const { input, session } = harness();
    session.start();
    const selected = session.chooseAccess('Choose.', [
      { id: 'localhost', label: 'Localhost', description: 'Local.', available: true },
    ]);
    const cancelled = expect(selected).rejects.toBeInstanceOf(SetupCancelled);
    input.emit('data', Buffer.from('\u001B'));
    await vi.advanceTimersByTimeAsync(50);
    await cancelled;
    expect(input.listenerCount('data')).toBe(0);
    session.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
// harn:end setup-restores-terminal-on-every-exit
