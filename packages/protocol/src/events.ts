import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, TimestampSchema } from './ids.js';
import { AgentLimitSchema, AgentUsageSchema, MemberStateSchema } from './member.js';
import { AskCardSchema, RunStatusSchema, UsageSchema } from './message.js';

/**
 * Normalized harness events (PROTOCOL §4). Adapters translate native streams
 * into these; the switchboard journals them into the run blob and fans them
 * out live to surfaces.
 */
export const RunItemTypeSchema = z.enum([
  'tool_call',
  'tool_result',
  'reasoning_summary',
  'text_delta',
  'commit',
  'file_change',
]);
export type RunItemType = z.infer<typeof RunItemTypeSchema>;

// harn:assume normalized-run-item-payload-contract ref=standalone-run-item-payload-schemas
export const RunItemDiffSchema = z.object({
  path: z.string().min(1),
  unified: z.string(),
}).loose();
export type RunItemDiff = z.infer<typeof RunItemDiffSchema>;

export const RunItemImageSchema = z.object({
  media_type: z.string().min(1),
  data_b64: z.string(),
}).loose();
export type RunItemImage = z.infer<typeof RunItemImageSchema>;

export const ToolCallPayloadSchema = z.object({
  call_id: z.string().min(1),
  tool: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().optional(),
  input: z.unknown().optional(),
}).loose();
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

export const ToolResultPayloadSchema = z.object({
  call_id: z.string().min(1),
  status: z.enum(['ok', 'error']),
  output_text: z.string().optional(),
  diff: RunItemDiffSchema.optional(),
  image: RunItemImageSchema.optional(),
  duration_ms: z.number().nonnegative().optional(),
  raw: z.unknown().optional(),
}).loose();
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;

export const TextDeltaPayloadSchema = z.object({ text: z.string() }).loose();
export type TextDeltaPayload = z.infer<typeof TextDeltaPayloadSchema>;

export const ReasoningSummaryPayloadSchema = z.object({ text: z.string() }).loose();
export type ReasoningSummaryPayload = z.infer<typeof ReasoningSummaryPayloadSchema>;

export const FileChangePayloadSchema = z.object({
  path: z.string().min(1),
  change: z.enum(['created', 'modified', 'deleted']),
  diff: RunItemDiffSchema.optional(),
}).loose();
export type FileChangePayload = z.infer<typeof FileChangePayloadSchema>;

export const CommitPayloadSchema = z.object({
  sha: z.string().optional(),
  message: z.string().optional(),
}).loose();
export type CommitPayload = z.infer<typeof CommitPayloadSchema>;

export const RunItemPayloadSchemas = {
  tool_call: ToolCallPayloadSchema,
  tool_result: ToolResultPayloadSchema,
  reasoning_summary: ReasoningSummaryPayloadSchema,
  text_delta: TextDeltaPayloadSchema,
  commit: CommitPayloadSchema,
  file_change: FileChangePayloadSchema,
} as const satisfies Record<RunItemType, z.ZodType>;

export type RunItemPayloadByType = {
  [Type in RunItemType]: z.infer<(typeof RunItemPayloadSchemas)[Type]>;
};
export type RunItemPayload = RunItemPayloadByType[RunItemType];

export function parseRunItemPayload<Type extends RunItemType>(
  itemType: Type,
  payload: unknown,
) {
  const schema = RunItemPayloadSchemas[itemType] as unknown as z.ZodType<
    RunItemPayloadByType[Type]
  >;
  return schema.safeParse(payload);
}
// harn:end normalized-run-item-payload-contract

/** Opaque id reported by a harness before it is mapped to a Codor member. */
export const HarnessNativeIdSchema = z.string().min(1);

// harn:assume compaction-timeline-items-are-durable-run-evidence ref=compaction-timeline-item-schema
export const CompactionTimelineItemSchema = z.object({
  type: z.literal('compaction'),
  status: z.enum(['loading', 'completed']),
  trigger: z.enum(['auto', 'manual']).optional(),
  preTokens: z.number().nonnegative().optional(),
}).loose();
export type CompactionTimelineItem = z.infer<typeof CompactionTimelineItemSchema>;

export const WireEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    member: MemberIdSchema,
    trigger_msg: MessageIdSchema,
  }),
  z.object({
    type: z.literal('run.item'),
    item_type: RunItemTypeSchema,
    payload: z.unknown(),
    // harn:assume member-status-is-bounded-and-identity-safe ref=run-item-journal-timestamp-contract
    ts: TimestampSchema.optional(),
    // harn:end member-status-is-bounded-and-identity-safe
  }),
  z.object({ type: z.literal('ask.raised'), card: AskCardSchema }),
  z.object({ type: z.literal('approval.raised'), card: AskCardSchema }),
  z.object({
    type: z.literal('timeline'),
    item: CompactionTimelineItemSchema,
  }),
  // harn:end compaction-timeline-items-are-durable-run-evidence
  // harn:assume normalized-agent-usage-and-context-telemetry ref=agent-usage-telemetry-schema
  z.object({
    type: z.literal('usage_updated'),
    usage: AgentUsageSchema,
  }),
  z.object({
    type: z.literal('run.completed'),
    status: RunStatusSchema.exclude(['running']),
    final_text: z.string().optional(),
    // harn:assume failed-run-details-never-route-as-replies ref=failed-run-error-schema
    error: z.string().min(1).optional(),
    // harn:end failed-run-details-never-route-as-replies
    // Durable accounting compatibility; normalized telemetry is agent_usage.
    usage: UsageSchema.optional(),
    agent_usage: AgentUsageSchema.optional(),
  }),
  // harn:end normalized-agent-usage-and-context-telemetry
  z.object({
    type: z.literal('run.limits'),
    limits: z.array(AgentLimitSchema).min(1),
  }),
  z.object({
    type: z.literal('member.state'),
    member: MemberIdSchema,
    state: MemberStateSchema,
  }),
  // harn:assume extension-events-use-native-identifiers ref=extension-native-event-schema
  z.object({
    type: z.literal('extension.started'),
    parent: HarnessNativeIdSchema,
    ext_member: HarnessNativeIdSchema,
    description: z.string().min(1).optional(),
    agent_type: z.string().min(1).optional(),
    transcript_path: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('extension.ended'),
    ext_member: HarnessNativeIdSchema,
    summary: z.string().optional(),
    transcript_path: z.string().min(1).optional(),
  }),
  // harn:end extension-events-use-native-identifiers
]);
export type WireEvent = z.infer<typeof WireEventSchema>;
