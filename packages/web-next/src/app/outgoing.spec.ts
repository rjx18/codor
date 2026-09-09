import { describe, expect, it, vi } from 'vitest';
import { MessageSchema } from '@codor/protocol';
import { outgoingFor, sendOutgoing } from './outgoing.js';
import type { Connection, PostOptions } from '../runtime/ws.js';

function setup() {
  const calls: PostOptions[] = [];
  const connection: Connection = { compositionOwner: {}, postAcknowledgements: true, postCorrelations: true,
    post: (_body, opts) => { calls.push(opts!); return true; }, act: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn() };
  return { connection, calls, state: outgoingFor(connection) };
}
const message = (id: number, submission_id?: string) => MessageSchema.parse({ id, room: 'child', author: '01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'chat',
  body: 'identical', mentions: [], refs: [], ledger_refs: [], ts: '2026-09-09T00:00:00Z', seq: id, submission_id });
describe('authoritative optimistic identity', () => {
  it.each(['echo-first', 'ack-first', 'lost-ack'])('%s reconciles identical consecutive sends independently', (order) => {
    const { connection, calls, state } = setup();
    const a = sendOutgoing(connection, 'origin', 'child', 'identical', []);
    const b = sendOutgoing(connection, 'origin', 'child', 'identical', []);
    expect(calls).toHaveLength(2); expect(a).not.toBe(b);
    state.reconcile('child', { 99: message(99) }, {});
    expect(state.snapshot()).toHaveLength(2); // identical prose is not identity
    const ack = () => calls[0]!.onResult!({ type: 'post_accepted', submission_id: a, origin_room: 'origin',
      outcome: { kind: 'message', room: 'child', message_id: 1, seq: 1, delivery_ids: [] } });
    if (order === 'ack-first') ack();
    state.reconcile('child', { 1: message(1, a) }, {});
    if (order === 'echo-first') ack();
    expect(state.snapshot().map(row => row.id)).toEqual([b]);
    state.reconcile('child', { 2: message(2, b) }, {});
    expect(state.snapshot()).toEqual([]);
  });
  it('separates computers, preserves captured attachments and retains refusal content', () => {
    const a = setup(), b = setup();
    const id = sendOutgoing(a.connection, 'origin', 'child', 'mine', [], 42);
    expect(b.state.snapshot()).toEqual([]);
    a.calls[0]!.onResult!({ type: 'error', submission_id: id, origin_room: 'origin', message: 'refused' });
    expect(a.state.snapshot()[0]).toMatchObject({ status: 'failed', frame: { body: 'mine', reply_to: 42 } });
    a.state.reconcile('other', { 1: message(1, id) }, {});
    expect(a.state.snapshot()).toHaveLength(1);
  });
});
