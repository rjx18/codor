import {
  type Delivery,
  MemberIdSchema,
  MessageIdSchema,
  RoomIdSchema,
  TimestampSchema,
} from '@codor/protocol';
import { z } from 'zod';

export const CollaborationGroupStateSchema = z.enum(['open', 'completed', 'cancelled']);
export type CollaborationGroupState = z.infer<typeof CollaborationGroupStateSchema>;

export const CollaborationRoundStateSchema = z.enum(['collecting', 'released', 'closed']);
export type CollaborationRoundState = z.infer<typeof CollaborationRoundStateSchema>;

export const CollaborationTerminalStatusSchema = z.enum([
  'completed',
  'failed',
  'interrupted',
  'skipped',
]);
export type CollaborationTerminalStatus = z.infer<typeof CollaborationTerminalStatusSchema>;

export const CollaborationGroupSchema = z.object({
  id: z.string().min(1),
  room: RoomIdSchema,
  root_message_id: MessageIdSchema,
  state: CollaborationGroupStateSchema,
  created_ts: TimestampSchema,
  completed_ts: TimestampSchema.optional(),
});
export type CollaborationGroup = z.infer<typeof CollaborationGroupSchema>;

export const CollaborationRoundSchema = z.object({
  group_id: z.string().min(1),
  round_number: z.number().int().positive(),
  state: CollaborationRoundStateSchema,
  created_ts: TimestampSchema,
  released_ts: TimestampSchema.optional(),
});
export type CollaborationRound = z.infer<typeof CollaborationRoundSchema>;

export const CollaborationParticipantSchema = z.object({
  group_id: z.string().min(1),
  round_number: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  member_id: MemberIdSchema,
  delivery_id: z.string().min(1),
  terminal_status: CollaborationTerminalStatusSchema.optional(),
  result_message_id: MessageIdSchema.optional(),
  completed_ts: TimestampSchema.optional(),
});
export type CollaborationParticipant = z.infer<typeof CollaborationParticipantSchema>;

export interface CollaborationRoundParticipantInput {
  memberId: string;
  payloadSnapshot: string;
  state?: Delivery['state'];
  hopCount?: number;
}

export interface CollaborationRoundProjection {
  group: CollaborationGroup;
  round: CollaborationRound;
  participants: CollaborationParticipant[];
  deliveries: Delivery[];
}

export type GroupResultPresentationStatus = CollaborationTerminalStatus | 'acknowledged';

export interface GroupRoundPayloadContext {
  groupId: string;
  roundNumber: number;
  room: string;
  root: {
    messageId: number;
    authorHandle: string;
    body: string;
  };
  refs?: {
    id: number;
    authorHandle: string;
    ts: string;
    body: string;
  }[];
  ledgerRefs?: { name: string; body: string }[];
  priorRoundNumber?: number;
  results?: {
    ordinal: number;
    memberHandle: string;
    status: GroupResultPresentationStatus;
    messageId?: number;
    body?: string;
  }[];
}

const minuteUtc = (ts: string): string => `${ts.slice(0, 16)}Z`;

const statusBody = (
  handle: string,
  status: GroupResultPresentationStatus,
  body: string | undefined,
): string => {
  if (status === 'acknowledged') return `[@${handle} acknowledged; no substantive response.]`;
  if (body !== undefined && body !== '') return body;
  if (status === 'failed') return '[No final response. The run failed.]';
  if (status === 'interrupted') return '[No final response. The run was interrupted.]';
  if (status === 'skipped') return '[No turn started. The member was removed or unavailable.]';
  return '[No final response.]';
};

// harn:assume group-round-payloads-share-one-ordered-view ref=group-round-payload-composer
// harn:assume group-round-routing-instruction-is-always-on ref=group-routing-instruction
// harn:assume group-routing-briefing-names-cost-and-wait-outcome ref=group-routing-cost-wait-guidance
const GROUP_ROUTING_INSTRUCTION =
  '[group routing: all participants in this round run independently. Your normal final reply ' +
  'posts to the channel immediately; peer agents receive all terminal results together only as ' +
  'the next-round context after this round ends. Use codor post only for an immediate in-round ' +
  'update, question, or answer. An @mention in your final response starts another paid group ' +
  "round, so use one only when you genuinely intend to invoke that member; write the member's " +
  'plain name without @ when merely discussing them. If every peer you are waiting on finishes ' +
  'without an interim reply, Codor ends the wait automatically. If no substantive onward ' +
  'response is needed, respond with exactly <ACK_OK>.]';
// harn:end group-routing-briefing-names-cost-and-wait-outcome

export function composeGroupRoundPayload(ctx: GroupRoundPayloadContext, you: string): string {
  let payload =
    `[codor group=${ctx.groupId} round=${ctx.roundNumber} channel=${ctx.room}\n` +
    ` root=#${ctx.root.messageId} - you=@${you}]\n\n` +
    `--- group request #${ctx.root.messageId} - @${ctx.root.authorHandle} ---\n` +
    `${ctx.root.body}\n` +
    '--- end group request ---\n';

  for (const ref of ctx.refs ?? []) {
    payload +=
      `\n--- referenced #${ref.id} - @${ref.authorHandle} - ${minuteUtc(ref.ts)} ---\n` +
      `${ref.body}\n` +
      '--- end reference ---\n';
  }
  for (const ref of ctx.ledgerRefs ?? []) {
    payload +=
      `\n--- ledger [[${ref.name}]] ---\n` +
      `${ref.body}\n` +
      '--- end ledger note ---\n';
  }

  const results = [...(ctx.results ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  if (results.length > 0 && ctx.priorRoundNumber === undefined) {
    throw new Error('priorRoundNumber is required when group results are present');
  }
  for (const [index, result] of results.entries()) {
    const message = result.messageId === undefined ? '' : ` - #${result.messageId}`;
    payload +=
      `\n--- completed round ${ctx.priorRoundNumber} result ${index + 1}/${results.length}` +
      ` - @${result.memberHandle} - ${result.status}${message} ---\n` +
      `${statusBody(result.memberHandle, result.status, result.body)}\n` +
      '--- end result ---\n';
  }

  payload += `\n${GROUP_ROUTING_INSTRUCTION}\n`;
  return payload;
}
// harn:end group-round-routing-instruction-is-always-on
// harn:end group-round-payloads-share-one-ordered-view

export type DeliveryBatchClass =
  | { kind: 'ordinary' }
  | { kind: 'group'; groupId: string; roundNumber: number };

// harn:assume grouped-deliveries-have-an-isolated-batch-class ref=group-delivery-batch-classifier
export function deliveryBatchClass(delivery: Delivery): DeliveryBatchClass {
  return delivery.group_id === undefined
    ? { kind: 'ordinary' }
    : { kind: 'group', groupId: delivery.group_id, roundNumber: delivery.group_round! };
}

function sameBatchClass(left: DeliveryBatchClass, right: DeliveryBatchClass): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'ordinary' || (
    right.kind === 'group' &&
    left.groupId === right.groupId &&
    left.roundNumber === right.roundNumber
  );
}

/** The caller supplies deliveries in durable FIFO order. */
export function selectDeliveryBatchPrefix(deliveries: Delivery[]): Delivery[] {
  if (deliveries.length === 0) return [];
  const firstClass = deliveryBatchClass(deliveries[0]!);
  const selected: Delivery[] = [];
  for (const delivery of deliveries) {
    if (!sameBatchClass(firstClass, deliveryBatchClass(delivery))) break;
    selected.push(delivery);
  }
  return selected;
}
// harn:end grouped-deliveries-have-an-isolated-batch-class
