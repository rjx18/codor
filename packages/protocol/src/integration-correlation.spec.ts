import { describe, expect, it } from 'vitest';

import { ActFrameSchema } from './index.js';

// harn:assume merged-schedule-and-context-actions-correlate-without-cross-talk ref=combined-action-ref-protocol-regression
describe('integrated action correlation', () => {
  it('keeps schedule-default and context-reset-explicit ref requirements distinct', () => {
    const cancel = { act: 'cancel_schedule' as const, schedule_id: 'schedule-1' };
    const reset = {
      act: 'clear_member_context' as const,
      member_id: '01J00000000000000000000000',
    };

    expect(ActFrameSchema.safeParse({ type: 'act', room: 'eng', act: cancel }).success).toBe(false);
    expect(ActFrameSchema.parse({ type: 'act', room: 'eng', ref: 'schedule-1', act: cancel }))
      .toMatchObject({ ref: 'schedule-1', act: cancel });
    expect(ActFrameSchema.safeParse({ type: 'act', room: 'eng', act: reset }).success).toBe(false);
    expect(ActFrameSchema.parse({ type: 'act', room: 'eng', ref: 'reset-1', act: reset }))
      .toMatchObject({ ref: 'reset-1', act: reset });
  });
});
// harn:end merged-schedule-and-context-actions-correlate-without-cross-talk
