import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, RoomIdSchema, TimestampSchema } from './ids.js';

// harn:assume interaction-state-machine-persisted ref=pending-interaction-schema
/**
 * Crash-safe ask/approval lifecycle (PROTOCOL §2):
 *
 *   pending  — raised by the adapter, card posted, member awaiting_input
 *   answered — a human answered; the answer is persisted BEFORE delivery
 *   acked    — respondInteraction resolved on adapter acknowledgement; run resumes
 *   orphaned — reconcile could not re-correlate after a crash (expired card)
 *
 * Probed reality (P0.2 fixtures): a re-raised request after a crash carries
 * FRESH native ids, so reconcile re-correlates on (member, kind, content) —
 * `native_id` is only valid within one process lifetime. An `answered`
 * interaction whose ack was lost is replayed against the re-raised request
 * (idempotent); approvals are NEVER auto-resent — they orphan instead.
 */
export const InteractionStateSchema = z.enum(['pending', 'answered', 'acked', 'orphaned']);
export type InteractionState = z.infer<typeof InteractionStateSchema>;

export const PendingInteractionSchema = z.object({
  id: z.string().min(1),
  room: RoomIdSchema,
  member_id: MemberIdSchema, // the blocked agent
  message_id: MessageIdSchema, // the ask/approval card message
  native_id: z.string().min(1), // harness-native request id (fresh per raise)
  kind: z.enum(['ask', 'approval']),
  targets: z.array(MemberIdSchema), // humans whose inbox gets it; first answer wins
  state: InteractionStateSchema,
  answer: z.unknown().optional(),
  answered_by: MemberIdSchema.optional(),
  answered_ts: TimestampSchema.optional(),
});
export type PendingInteraction = z.infer<typeof PendingInteractionSchema>;
// harn:end interaction-state-machine-persisted
