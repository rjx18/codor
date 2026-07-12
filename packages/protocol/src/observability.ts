import { z } from 'zod';

import { MessageIdSchema, TimestampSchema } from './ids.js';
import { HandleSchema, MemberStateSchema } from './member.js';

// harn:assume member-status-is-bounded-and-identity-safe ref=observability-status-contract
export const StatusWaitingSchema = z.object({
  peers: z.array(HandleSchema).min(1),
  reason: z.enum(['reply', 'mention', 'any']),
  since_ts: TimestampSchema,
  until_ts: TimestampSchema,
}).strict();

export const StatusRecentActionSchema = z.object({
  kind: z.enum(['tool', 'post']),
  title: z.string().max(500),
  status: z.enum(['ok', 'error']).optional(),
  duration_ms: z.number().nonnegative().optional(),
  ts: TimestampSchema,
}).strict();

export const MemberStatusResponseSchema = z.object({
  member: z.object({
    handle: HandleSchema,
    state: MemberStateSchema,
    waiting: StatusWaitingSchema.optional(),
  }).strict(),
  current_run: z.object({
    message_id: MessageIdSchema,
    started_ts: TimestampSchema,
    elapsed_ms: z.number().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }).strict().optional(),
  recent: z.array(StatusRecentActionSchema).max(5),
}).strict();
export type MemberStatusResponse = z.infer<typeof MemberStatusResponseSchema>;
// harn:end member-status-is-bounded-and-identity-safe

// harn:assume run-evidence-search-is-bounded-and-redacted ref=run-search-contract
export const RunSearchHitSchema = z.object({
  message_id: MessageIdSchema,
  item_index: z.number().int().nonnegative(),
  kind: z.enum(['tool_call', 'tool_result']),
  excerpt: z.string().max(240),
}).strict();
export type RunSearchHit = z.infer<typeof RunSearchHitSchema>;
// harn:end run-evidence-search-is-bounded-and-redacted
