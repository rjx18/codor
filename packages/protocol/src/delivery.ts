import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, RoomIdSchema, TimestampSchema } from './ids.js';

/**
 * Per-member FIFO inbox record. Exactly-once-or-held (PROTOCOL §3):
 *
 *   queued     — waiting for the recipient to go idle (or be revived)
 *   delivering — attempt WAL: bound to `run_msg_id` BEFORE the turn spawns
 *   consumed   — run.completed landed (agents) / inbox record created (humans)
 *   held       — ambiguous crash reconcile or brake breach; operator releases
 *
 * Human recipients never get turns: their delivery is an inbox record whose
 * read lifecycle is `read_ts` (+ the `mark_read` act).
 */
export const DeliveryStateSchema = z.enum(['queued', 'delivering', 'consumed', 'held']);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliverySchema = z.object({
  id: z.string().min(1),
  room: RoomIdSchema,
  message_id: MessageIdSchema, // the routed message
  recipient: MemberIdSchema,
  state: DeliveryStateSchema,
  hop_count: z.number().int().nonnegative().optional(),
  attempt_count: z.number().int().nonnegative().default(0),
  batch_id: z.string().min(1).optional(), // set when drained as part of a batched turn
  run_msg_id: MessageIdSchema.optional(), // attempt WAL: the run message this attempt feeds
  read_ts: TimestampSchema.optional(), // human inbox read lifecycle
  // harn:assume agent-delivery-lifecycle-streams-v2 ref=steered-delivery-protocol
  /** Native active-turn acknowledgement time; absent means ordinary queued/turn delivery. */
  steered_ts: TimestampSchema.optional(),
  // harn:end agent-delivery-lifecycle-streams-v2
  // harn:assume approval-deliveries-project-resolution-separately ref=approval-delivery-resolution-schema
  // Approval resolution is lifecycle state, not evidence that a notification was read.
  interaction_resolved_ts: TimestampSchema.optional(),
  // harn:end approval-deliveries-project-resolution-separately
  // harn:assume collaboration-groups-are-durable-state ref=collaboration-delivery-association-schema
  group_id: z.string().min(1).optional(),
  group_round: z.number().int().positive().optional(),
  // harn:end collaboration-groups-are-durable-state
  ts: TimestampSchema,
}).superRefine((delivery, ctx) => {
  if ((delivery.group_id === undefined) !== (delivery.group_round === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [delivery.group_id === undefined ? 'group_id' : 'group_round'],
      message: 'group_id and group_round must be provided together',
    });
  }
});
export type Delivery = z.infer<typeof DeliverySchema>;
