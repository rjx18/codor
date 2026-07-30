import { describe, expect, it } from 'vitest';

import {
  QUEUE_WARNING_DELAY_MS,
  queueWarningDelay,
  queueWarningDue,
} from './queue-warning.js';

describe('unattempted queue warning', () => {
  const queuedAt = '2026-07-30T12:00:00.000Z';
  const queuedAtMs = Date.parse(queuedAt);

  it('appears only after a full minute without an attempt', () => {
    expect(queueWarningDue(queuedAt, queuedAtMs + QUEUE_WARNING_DELAY_MS - 1)).toBe(false);
    expect(queueWarningDue(queuedAt, queuedAtMs + QUEUE_WARNING_DELAY_MS)).toBe(true);
  });

  it('provides the exact remaining delay and rejects missing or invalid timestamps', () => {
    expect(queueWarningDelay(queuedAt, queuedAtMs + 15_000)).toBe(45_000);
    expect(queueWarningDelay(undefined, queuedAtMs)).toBeUndefined();
    expect(queueWarningDelay('not-a-date', queuedAtMs)).toBeUndefined();
    expect(queueWarningDue('not-a-date', queuedAtMs + QUEUE_WARNING_DELAY_MS)).toBe(false);
  });
});
