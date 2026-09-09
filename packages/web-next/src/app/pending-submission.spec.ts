import { describe, expect, it, vi } from 'vitest';
import type { PostFrame, ServerFrame } from '@codor/protocol';
import { PendingSubmission } from './pending-submission.js';

describe('independently correlated immutable submissions', () => {
  const ack = (id = 'one', room = 'eng'): ServerFrame => ({ type: 'post_accepted',
    submission_id: id, origin_room: room,
    outcome: { kind: 'message', room: 'actual-child', message_id: 1, seq: 9, delivery_ids: ['delivery'] } });
  it('freezes every payload field, admits a second send, and retries once per origin generation', () => {
    const slot = new PendingSubmission(); const sent: PostFrame[] = [];
    const send = (frame: PostFrame) => { sent.push(frame); return true; };
    const frame: PostFrame = { type: 'post', room: 'eng', submission_id: 'one', body: '[send_in=1h] original',
      attachments: ['uploaded'], voice: { duration_seconds: 2, levels: [4, 8] }, reply_to: 4 };
    const first = JSON.stringify(frame);
    expect(slot.post(frame, 1, send)).toBe(true);
    frame.body = 'edited'; frame.attachments![0] = 'new'; frame.voice!.levels[0] = 99;
    expect(slot.post({ ...frame, submission_id: 'two' }, 1, send)).toBe(true);
    const second = JSON.stringify(sent[1]);
    slot.ready('other', 2, send); slot.ready('eng', 1, send);
    expect(sent).toHaveLength(2);
    slot.ready('eng', 2, send); slot.ready('eng', 2, send);
    expect(sent.map((value) => JSON.stringify(value))).toEqual([first, second, first, second]);
  });
  it('ignores unrelated echoes/errors/rooms and settles only its own correlated result', () => {
    const slot = new PendingSubmission(); const result = vi.fn();
    slot.post({ type: 'post', room: 'eng', submission_id: 'one', body: 'text' }, 1, () => true, result);
    slot.receive({ type: 'error', message: 'other failure', ref: 'post' });
    slot.receive(ack('two')); slot.receive(ack('one', 'other'));
    expect(result).not.toHaveBeenCalled(); expect(slot.active).toBe(true);
    expect(slot.receive(ack())).toBe('eng'); expect(slot.active).toBe(false);
    slot.receive(ack()); expect(result).toHaveBeenCalledExactlyOnceWith(ack());
  });
  it('local send refusal creates no outbox and a correlated rejection permits an edited resend', () => {
    const slot = new PendingSubmission();
    const frame: PostFrame = { type: 'post', room: 'eng', submission_id: 'one', body: 'text' };
    expect(slot.post(frame, 1, () => false)).toBe(false); expect(slot.active).toBe(false);
    const result = vi.fn(); slot.post(frame, 1, () => true, result);
    slot.receive({ type: 'error', submission_id: 'one', origin_room: 'eng', message: 'refused' });
    expect(result).toHaveBeenCalledOnce(); expect(slot.post({ ...frame, submission_id: 'two' }, 1, () => true)).toBe(true);
  });
});
