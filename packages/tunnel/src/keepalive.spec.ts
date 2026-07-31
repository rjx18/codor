import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Keepalive, RELAY_KEEPALIVE_INTERVAL_MS } from './keepalive.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Keepalive (§4.1 half-open detector)', () => {
  it('defaults to the §4.1 30-second interval', () => {
    expect(RELAY_KEEPALIVE_INTERVAL_MS).toBe(30_000);
  });

  it('probes immediately and declares death after two intervals of silence', () => {
    let pings = 0;
    let dead = false;
    new Keepalive({ intervalMs: 30_000, send: () => (pings += 1), onDead: () => (dead = true) });
    expect(pings).toBe(1); // immediate probe on arming
    vi.advanceTimersByTime(29_999);
    expect(pings).toBe(1); // no probe before the interval elapses
    vi.advanceTimersByTime(1);
    expect(pings).toBe(2); // second probe at 30s
    expect(dead).toBe(false);
    vi.advanceTimersByTime(29_999);
    expect(dead).toBe(false);
    vi.advanceTimersByTime(1);
    expect(dead).toBe(true); // dead at exactly 60s — two intervals, not three
  });

  it('stays alive while traffic keeps the link warm', () => {
    let dead = false;
    const keepalive = new Keepalive({ intervalMs: 30_000, send: () => undefined, onDead: () => (dead = true) });
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(30_000);
      keepalive.noteActivity(); // a pong (or any frame) resets the probe count each interval
    }
    expect(dead).toBe(false);
  });

  it('fires onDead once and probes no further after death', () => {
    let pings = 0;
    let deaths = 0;
    new Keepalive({ intervalMs: 30_000, send: () => (pings += 1), onDead: () => (deaths += 1) });
    vi.advanceTimersByTime(30_000 * 5);
    expect(deaths).toBe(1);
    const pingsAtDeath = pings; // immediate + one interval probe = 2
    expect(pingsAtDeath).toBe(2);
    vi.advanceTimersByTime(30_000 * 5);
    expect(pings).toBe(pingsAtDeath); // timer cleared: no probes after death
    expect(deaths).toBe(1);
  });

  it('stop() halts probing', () => {
    let pings = 0;
    const keepalive = new Keepalive({ intervalMs: 30_000, send: () => (pings += 1), onDead: () => undefined });
    expect(pings).toBe(1);
    keepalive.stop();
    vi.advanceTimersByTime(30_000 * 5);
    expect(pings).toBe(1);
  });
});
