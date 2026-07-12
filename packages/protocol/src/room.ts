import { z } from 'zod';

import { RoomIdSchema, TimestampSchema } from './ids.js';
import { AssignableHandleSchema } from './member.js';

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
  // harn:assume bridged-room-wears-banner ref=bridged-room-config
  bridged: z.boolean().default(false),
  // harn:end bridged-room-wears-banner
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

// harn:assume channel-create-request-contract ref=channel-create-request-schema
export const StartingAgentSchema = z.object({
  harness: z.string().min(1),
  handle: AssignableHandleSchema,
  model: z.string().optional(),
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
// harn:assume uncosted-usage-visible-not-guessed ref=room-meter-uncosted-schema
export const RoomMeterSchema = z.object({
  room: RoomIdSchema,
  day: z.iso.date(), // YYYY-MM-DD, switchboard clock
  turns: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(), // sums only cost-reporting members
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  uncosted_tokens: z.number().int().nonnegative().optional(),
});
export type RoomMeter = z.infer<typeof RoomMeterSchema>;
// harn:end uncosted-usage-visible-not-guessed
