import { describe, expect, it, vi } from 'vitest';
import { MessageSchema } from '@codor/protocol';
import { dispatchOutgoing, outgoingFor, prepareOutgoing, sendOutgoing } from './outgoing.js';
import type { WorktreeRoutingCatalog } from '@codor/protocol';
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
  it('re-resolves an edited qualified destination and refuses an invalid target', () => {
    const catalog: WorktreeRoutingCatalog = {room:'eng',tombstones:[],targets:['review','plan'].map((alias,index)=>({
      worktree_id:`01J0000000000000000000000${index}`,conversation_id:`wt-${alias}`,alias,primary:false,lifecycle:'active',
      members:[{member_id:'01ARZ3NDEKTSV4RRFFQ69G5FAV',handle:'coder',kind:'agent'}],
    }))};
    expect(prepareOutgoing('~review:@coder original','eng',[],catalog).room).toBe('wt-review');
    expect(prepareOutgoing('~plan:@coder edited','eng',[],catalog).room).toBe('wt-plan');
    expect(()=>prepareOutgoing('~missing:@coder edited','eng',[],catalog)).toThrow();
  });
  it('an unchanged Resend retains its original explicit clock and ID', () => {
    const {connection,calls,state}=setup();
    const body='[send_at=2026-09-10T23:59:00-07:00] @coder original';
    const id=sendOutgoing(connection,'eng','eng',body,[],undefined,undefined,'[send_at=11:59PM] @coder original');
    state.result(id,{type:'error',submission_id:id,origin_room:'eng',message:'refused'});
    dispatchOutgoing(connection,state.snapshot()[0]!);
    expect(calls[1]!.submissionId).toBe(id);
    expect(state.snapshot()[0]!.frame.body).toBe(body);
    expect(state.snapshot()[0]!.rawBody).toBe('[send_at=11:59PM] @coder original');
  });
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
