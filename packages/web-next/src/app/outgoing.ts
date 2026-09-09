import { useSyncExternalStore } from 'react';
import type { Attachment, Message, PostFrame, Schedule } from '@codor/protocol';
import type { Connection } from '../runtime/ws.js';
import type { SubmissionResult } from './pending-submission.js';

export interface Outgoing {
  id: string;
  origin: string;
  room: string;
  frame: PostFrame;
  rawBody: string;
  attachments: Attachment[];
  status: 'sending' | 'accepted' | 'failed' | 'uncertain';
  error?: string;
  messageId?: number;
  scheduleId?: string;
}

// harn:assume sender-receipt-correlation-is-indexed-and-private ref=optimistic-outgoing-state
/** One page-memory owner per authenticated computer, shared across its views. */
export class OutgoingState {
  private rows: readonly Outgoing[] = [];
  private listeners = new Set<() => void>();
  snapshot = (): readonly Outgoing[] => this.rows;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(rows: readonly Outgoing[]): void {
    this.rows = rows; for (const listener of this.listeners) listener();
  }
  add(row: Outgoing): void { this.publish([...this.rows, row]); }
  update(id: string, patch: Partial<Outgoing>): void {
    if (!this.rows.some(row => row.id === id)) return;
    this.publish(this.rows.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  remove(id: string): void { this.publish(this.rows.filter(row => row.id !== id)); }
  result = (id: string, result: SubmissionResult): void => {
    if (result.submission_id !== id) return;
    if (result.type === 'error') this.update(id, { status: 'failed', error: result.message });
    else if (result.type === 'post_wait_stopped') this.update(id, { status: 'uncertain', error: 'Delivery unconfirmed. Check before sending again.' });
    else this.update(id, { status: 'accepted', room: result.outcome.room,
      ...(result.outcome.kind === 'message' ? { messageId: result.outcome.message_id } : { scheduleId: result.outcome.schedule_id }) });
  };
  reconcile(room: string, messages: Readonly<Record<number, Message>>, schedules: Readonly<Record<string, Schedule>>): string[] {
    const correlated = new Set([
      ...Object.values(messages).filter(message=>message.room===room).map(message=>message.submission_id),
      ...Object.values(schedules).filter(schedule=>schedule.room===room).map(schedule=>schedule.submission_id),
    ]);
    const done = this.rows.filter(row => row.room === room && (
      correlated.has(row.id)
      || (row.messageId !== undefined && messages[row.messageId]?.room === room)
      || (row.scheduleId !== undefined && schedules[row.scheduleId]?.room === room)
    )).map(row => row.id);
    if (done.length) this.publish(this.rows.filter(row => !done.includes(row.id)));
    return done;
  }
  uncertain(): void {
    if (this.rows.some(row => row.status === 'sending')) this.publish(this.rows.map(row => row.status === 'sending'
      ? { ...row, status: 'uncertain' as const, error: 'Delivery unconfirmed; waiting for the original connection.' } : row));
  }
}
const owners = new WeakMap<object, OutgoingState>();
export function outgoingFor(connection: Pick<Connection, 'compositionOwner'>): OutgoingState {
  const owner = connection.compositionOwner ?? connection;
  let state = owners.get(owner);
  if (!state) { state = new OutgoingState(); owners.set(owner, state); }
  return state;
}
export function useOutgoing(connection: Connection): readonly Outgoing[] {
  const state = outgoingFor(connection);
  return useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
}
export function sendOutgoing(connection: Connection, origin: string, room: string, body: string,
  attachments: Attachment[], replyTo?: number, voice?: PostFrame['voice'], rawBody = body): string {
  const id = crypto.randomUUID();
  const frame: PostFrame = { type: 'post', room: origin, body, submission_id: id,
    ...(replyTo !== undefined && { reply_to: replyTo }),
    ...(attachments.length > 0 && { attachments: attachments.map(file => file.id) }), ...(voice && { voice }) };
  const state = outgoingFor(connection);
  const frozen = structuredClone(frame);
  if (frozen.attachments) Object.freeze(frozen.attachments);
  if (frozen.voice) { Object.freeze(frozen.voice.levels); Object.freeze(frozen.voice); }
  Object.freeze(frozen);
  state.add({ id, origin, room, rawBody, frame: frozen, attachments: structuredClone(attachments), status: 'sending' });
  dispatchOutgoing(connection, state.snapshot().find(row => row.id === id)!);
  return id;
}
export function dispatchOutgoing(connection: Connection, row: Outgoing): void {
  const state = outgoingFor(connection);
  const accepted = connection.post(row.frame.body, { room: row.origin, submissionId: row.id,
    retrySubmission: row.status === 'failed' || row.status === 'uncertain',
    replyTo: row.frame.reply_to, attachments: row.frame.attachments, voice: row.frame.voice,
    onResult: result => state.result(row.id, result) });
  if (!accepted) state.update(row.id, row.status === 'uncertain'
    ? { status: 'uncertain', error: 'Retry was not dispatched. Original delivery remains unconfirmed.' }
    : { status: 'failed', error: 'Not sent. Reconnect, then resend.' });
}
// harn:end sender-receipt-correlation-is-indexed-and-private
