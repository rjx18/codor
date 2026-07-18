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
  final_text: z.string().optional(), // the closing message — becomes the visible body
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
