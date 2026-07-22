import { z } from 'zod';

import { DeliverySchema } from './delivery.js';
import { MemberIdSchema, RoomIdSchema, TimestampSchema } from './ids.js';
import { AssignableHandleSchema, MemberKindSchema } from './member.js';
import { MessageKindSchema, MessageSchema } from './message.js';
import { AcpLaunchConfigSchema, PolicySchema, ThinkingLevelSchema } from './adapter.js';

// harn:assume brakes-default-off ref=room-config-brakes
/**
 * Visibility is always-on; brakes are OPT-IN (PROTOCOL §3). Defaults:
 * both brakes null (off) — agent→agent chains run until the work is done.
 * `stall_minutes` is an always-on informational flag (never kills anything);
 * `redaction_enabled` is the per-room opt-OUT for the redaction projection.
 */
export const RoomConfigSchema = z.object({
  turn_brake: z.number().int().positive().nullable().default(null), // max agent→agent hops
  spend_brake_usd: z.number().positive().nullable().default(null), // daily cost hold threshold
  stall_minutes: z.number().int().positive().default(30),
  redaction_enabled: z.boolean().default(true),
  // harn:assume channel-create-request-contract ref=channel-room-metadata
  color: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  // harn:assume channel-starting-agent-handle-persisted ref=starting-agent-config-field
  starting_agent_handle: AssignableHandleSchema.optional(),
  // harn:end channel-starting-agent-handle-persisted
  // harn:end channel-create-request-contract
  // harn:assume bridged-room-wears-banner-v5 ref=bridged-room-config
  bridged: z.boolean().default(false),
  // harn:end bridged-room-wears-banner-v5
});
export type RoomConfig = z.infer<typeof RoomConfigSchema>;
// harn:end brakes-default-off

export const RoomSchema = z.object({
  id: RoomIdSchema,
  name: z.string().min(1),
  created_ts: TimestampSchema,
  config: RoomConfigSchema.prefault({}),
});
export type Room = z.infer<typeof RoomSchema>;

// harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-protocol
// harn:assume durable-room-summaries-stream-and-fallback ref=durable-room-summary
export const RoomSummaryLatestSchema = z.object({
  id: z.number().int().positive(),
  ts: TimestampSchema,
  kind: MessageKindSchema,
  author_handle: z.string(),
  author_kind: MemberKindSchema,
  preview: z.string().max(140),
});
export type RoomSummaryLatest = z.infer<typeof RoomSummaryLatestSchema>;

export const RoomSummarySchema = z.object({
  id: RoomIdSchema,
  name: z.string().min(1),
  created_ts: TimestampSchema,
  color: z.string().min(1).optional(),
  working: z.boolean(),
  attention: z.boolean(),
  latest: RoomSummaryLatestSchema.optional(),
  unread: z.number().int().nonnegative(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

// harn:assume actionable-inbox-clears-on-read-or-reply ref=actionable-inbox-projection
export const RoomInboxItemSchema = z.object({
  delivery: DeliverySchema,
  author_id: MemberIdSchema,
  author_handle: z.string(),
  author_kind: MemberKindSchema,
  message_kind: MessageKindSchema,
  preview: z.string().max(140),
  ts: TimestampSchema,
});
export type RoomInboxItem = z.infer<typeof RoomInboxItemSchema>;
// harn:end actionable-inbox-clears-on-read-or-reply

export const RoomSupportSchema = z.object({
  room: RoomIdSchema,
  summary: RoomSummarySchema,
  latest_finalized_agent_id: MemberIdSchema.optional(),
  active_runs: z.array(MessageSchema),
  interactions: z.array(MessageSchema),
  inbox: z.array(RoomInboxItemSchema),
});
export type RoomSupport = z.infer<typeof RoomSupportSchema>;
// harn:end durable-room-summaries-stream-and-fallback
// harn:end room-support-is-bounded-recipient-scoped-state

// harn:assume channel-create-request-contract ref=channel-create-request-schema
export const StartingAgentSchema = z.object({
  harness: z.string().min(1),
  handle: AssignableHandleSchema,
  // harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=starting-agent-identity-contract
  display_name: z.string().min(1).optional(),
  // harn:end starting-agent-name-derives-one-valid-identity-v6
  model: z.string().optional(),
  thinking: ThinkingLevelSchema.optional(),
  // harn:assume one-control-chooses-an-agent-everywhere ref=starting-agent-policy
  // Without this, every channel-seeded agent spawned with NO policy at all — the
  // create-channel dialog could not express one because the contract had nowhere to
  // put it. The spawn dialog could. Same agent, same question, two different answers.
  policy: PolicySchema.optional(),
  acp_launch: AcpLaunchConfigSchema.optional(),
  // harn:end one-control-chooses-an-agent-everywhere
}).superRefine((agent, ctx) => {
  if ((agent.harness === 'acp') !== (agent.acp_launch !== undefined)) {
    ctx.addIssue({
      code: 'custom', path: ['acp_launch'],
      message: 'ACP launch configuration is required only for the acp harness',
    });
  }
});
export type StartingAgent = z.infer<typeof StartingAgentSchema>;

export const CreateRoomRequestSchema = z.object({
  id: RoomIdSchema.optional(),
  name: z.string().min(1),
  owner: z.object({
    handle: AssignableHandleSchema,
    display_name: z.string(),
  }),
  color: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  starting_agent: StartingAgentSchema.optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
// harn:end channel-create-request-contract

/** Daily per-room spend meter (always on, never blocking). */
// harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=room-meter-cost-provenance-schema
export const RoomMeterSchema = z.object({
  room: RoomIdSchema,
  day: z.iso.date(), // YYYY-MM-DD, switchboard clock
  turns: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(), // sums only cost-reporting members
  estimated_cost_usd: z.number().nonnegative().optional(), // immutable advisory estimates
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  uncosted_tokens: z.number().int().nonnegative().optional(),
});
export type RoomMeter = z.infer<typeof RoomMeterSchema>;
// harn:end estimated-cost-is-advisory-not-spend-brake-input


// harn:assume every-channel-has-a-visible-accent ref=channel-accent-derivation
/**
 * The palette a channel's accent is drawn from. F3's root cause was that colour
 * was a creation-dialog concept: the CLI (and the systemd unit that boot-seeds a
 * channel through it) created channels with no colour at all, so the rail had
 * nothing to show. A channel that nobody chose a colour for still gets one.
 */
export const CHANNEL_ACCENTS = [
  '#80c56d',
  '#67b7c7',
  '#8c86d7',
  '#d8b34d',
  '#d86a64',
  '#5f8fd3',
] as const;

/** Stable in both directions: the same channel always gets the same accent. */
export function deriveRoomColor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.codePointAt(0)!) % 1_000_003;
  return CHANNEL_ACCENTS[hash % CHANNEL_ACCENTS.length]!;
}
// harn:end every-channel-has-a-visible-accent
