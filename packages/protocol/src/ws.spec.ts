import { describe, expect, it } from 'vitest';
import { BROWSER_PROTOCOL_EPOCH, ClientFrameSchema, ServerFrameSchema } from './ws.js';

describe('optional acknowledged post protocol', () => {
  it('retains legacy posts and the existing epoch', () => {
    const legacy = { type: 'post', room: 'eng', body: 'hello' };
    expect(ClientFrameSchema.parse(legacy)).toEqual(legacy);
    expect(BROWSER_PROTOCOL_EPOCH).toBe(2);
  });
  it('bounds submission correlation and distinguishes schedule from message acceptance', () => {
    for (const id of ['', 'x'.repeat(129), 9]) {
      expect(() => ClientFrameSchema.parse({ type: 'post', room: 'eng', body: 'hello', submission_id: id })).toThrow();
    }
    const outcome = { kind: 'schedule', room: 'child', schedule_id: 'schedule-1', seq: 3, due_ts: '2026-09-09T00:00:00.000Z' };
    expect(ServerFrameSchema.parse({ type: 'post_accepted', origin_room: 'eng', submission_id: 'one', outcome }))
      .toEqual({ type: 'post_accepted', origin_room: 'eng', submission_id: 'one', outcome });
    expect(() => ServerFrameSchema.parse({ type: 'post_accepted', origin_room: 'eng', submission_id: 'one', outcome: { kind: 'message', room: 'child', seq: 3 } })).toThrow();
  });
});
