import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, RoomIdSchema, SeqSchema, TimestampSchema } from './ids.js';

export const MessageKindSchema = z.enum(['chat', 'run', 'ask', 'approval', 'system']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

// harn:assume mention-spans-survive-renames ref=mention-span-schema
/**
 * A mention resolved at post/finalize time to a STABLE member id plus the
 * body span it occupies. Handles are never stored: renames change handles,
 * but old messages keep resolving because spans point at `member_id`.
 */
export const MentionSpanSchema = z
  .object({
    member_id: MemberIdSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((span) => span.start < span.end, { message: 'span end must be after start' });
export type MentionSpan = z.infer<typeof MentionSpanSchema>;
// harn:end mention-spans-survive-renames

export const BridgeOriginSchema = z.object({
  platform: z.string().min(1), // 'slack' | 'telegram' | open set
  external_id: z.string().min(1), // unique per (bridge member, platform) — dedup key
  sender_name: z.string().min(1),
});
export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;

export const AskCardSchema = z.object({
  interaction_id: z.string().min(1), // correlates with the pending native request
  kind: z.enum(['ask', 'approval']),
  prompt: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).optional(),
  multi: z.boolean().optional(),
  tool: z.string().optional(), // approvals: the tool/command being requested
  detail: z.string().optional(), // approvals: command text / input summary
});
export type AskCard = z.infer<typeof AskCardSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  /** Subset of input_tokens served from the provider cache. */
  cached_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().optional(), // absent for tokens-only harnesses (codex)
});
export type Usage = z.infer<typeof UsageSchema>;

export const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'interrupted']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSummarySchema = z.object({
  status: RunStatusSchema,
  started_ts: TimestampSchema,
  ended_ts: TimestampSchema.optional(),
  stalled_since: TimestampSchema.optional(), // watchdog flag — informational only
  tool_calls: z.number().int().nonnegative(),
  usage: UsageSchema.optional(),
  events_ref: z.string().min(1), // pointer to the JSONL event blob
  final_text: z.string().optional(), // authoritative aggregate across all output rows
  // harn:assume resolved-run-cost-estimates-are-finalization-snapshots ref=resolved-run-estimate-schema
  /** Runtime-resolved model when available, otherwise the admitted model snapshot. */
  model: z.string().min(1).optional(),
  /** Immutable advisory list-price estimate, stored only when exact cost is absent. */
  estimated_cost_usd: z.number().nonnegative().optional(),
  // harn:end resolved-run-cost-estimates-are-finalization-snapshots
  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-message-schema
  /** New turns opt into permanent per-stretch output rows; absent is stored legacy history. */
  output_mode: z.literal('messages').optional(),
  /** Permanent message id containing the terminal visible stretch/result. */
  result_message_id: MessageIdSchema.optional(),
  // harn:end continuation-writer-follows-journaled-output-ownership
  // harn:assume failed-run-details-never-route-as-replies ref=failed-run-error-schema
  error: z.string().min(1).optional(), // failed-run detail — evidence, never reply text
  // harn:end failed-run-details-never-route-as-replies
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1), // server-issued handle; also the on-disk file name
  name: z.string().min(1), // original filename — metadata only, never a path
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageSchema = z.object({
  id: MessageIdSchema,
  room: RoomIdSchema,
  author: MemberIdSchema,
  kind: MessageKindSchema,
  body: z.string(),
  mentions: z.array(MentionSpanSchema),
  refs: z.array(MessageIdSchema), // #ids referenced anywhere in body
  ledger_refs: z.array(z.string()), // [[note]] names referenced
  reply_to: MessageIdSchema.optional(), // threading hint; never affects routing
  run: RunSummarySchema.optional(), // kind='run' only
  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-message-schema
  /** A continuation's lifecycle root. Root run messages omit this and carry `run`. */
  run_parent_id: MessageIdSchema.optional(),
  // harn:end continuation-writer-follows-journaled-output-ownership
  ask: AskCardSchema.optional(), // kind='ask'|'approval' only
  origin: BridgeOriginSchema.optional(), // bridge-authored only
  // harn:assume acknowledgement-marker-protocol ref=message-ack-field
  ack: z.boolean().optional(), // absent is the additive false/default state
  // harn:end acknowledgement-marker-protocol
  pinned: z.boolean().optional(), // durable owner/admin marker; absent is the additive default
  deleted: z.boolean().optional(), // purged tombstone marker; absent is the additive live default
  attachments: z.array(AttachmentSchema).optional(), // uploaded files; absent is the additive default
  ts: TimestampSchema,
  seq: SeqSchema, // room change-sequence at last insert/update
});
export type Message = z.infer<typeof MessageSchema>;

// harn:assume durable-inert-snapshots-of-successfully-produced-files ref=produced-artifact-schema
/** Metadata for a durable snapshot of a file an agent produced. The bytes live
 *  under the daemon data tree keyed by `id`; `name` and `source_message_id` are
 *  provenance only — never a local path — and `media_type` is the sniffed,
 *  allowlisted safe type used to serve the bytes inertly. */
export const ProducedArtifactSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/), // opaque server-issued handle; the on-disk file name
  name: z.string().min(1), // display basename — metadata only, never a path
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  source_message_id: MessageIdSchema, // the run message that produced it
  produced_at: TimestampSchema,
});
export type ProducedArtifact = z.infer<typeof ProducedArtifactSchema>;

/** One durable, path-free failure state per run whose produced-artifact snapshot
 *  could not be stored (a storage failure, not a policy refusal). Carries no path
 *  or detail — the UI shows a generic notice; provenance is the run id only. */
export const ProducedArtifactErrorSchema = z.object({
  source_message_id: MessageIdSchema, // the run whose snapshot could not be retained
  produced_at: TimestampSchema,
});
export type ProducedArtifactError = z.infer<typeof ProducedArtifactErrorSchema>;
// harn:end durable-inert-snapshots-of-successfully-produced-files
