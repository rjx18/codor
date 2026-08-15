// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

import { connect } from './ws.js';

class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  throwOnSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  send(payload: string): void {
    if (this.throwOnSend) throw new Error('socket closed during send');
    this.sent.push(payload);
  }
  close(): void { this.readyState = 3; }
  accept(): void { this.onopen?.(); }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// harn:assume merged-schedule-and-context-actions-correlate-without-cross-talk ref=combined-direct-action-ref-regression
it('keeps schedule-default and caller-owned reset refs distinct on the direct socket', () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  const socket = new FakeSocket();
  const connection = connect({
    room: 'eng',
    token: 'token',
    socketFactory: () => socket as unknown as WebSocket,
  });
  socket.accept();

  // harn:assume reconnect-safe-post-dispatch-preserves-draft ref=post-dispatch-unit-regression
  expect(connection.post('accepted before close')).toBe(true);
  socket.readyState = 3;
  expect(connection.post('rejected while closed')).toBe(false);
  socket.readyState = FakeSocket.OPEN;
  socket.throwOnSend = true;
  expect(connection.post('rejected during send')).toBe(false);
  socket.throwOnSend = false;
  // harn:end reconnect-safe-post-dispatch-preserves-draft

  connection.act({ act: 'cancel_schedule', schedule_id: 'schedule-1' });
  connection.act({
    act: 'clear_member_context',
    member_id: '01J00000000000000000000000',
  }, 'reset-1');

  expect(socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'act'))
    .toEqual([
      {
        type: 'act', room: 'eng', ref: 'schedule-1',
        act: { act: 'cancel_schedule', schedule_id: 'schedule-1' },
      },
      {
        type: 'act', room: 'eng', ref: 'reset-1',
        act: { act: 'clear_member_context', member_id: '01J00000000000000000000000' },
      },
    ]);
  connection.disconnect();
});
// harn:end merged-schedule-and-context-actions-correlate-without-cross-talk
