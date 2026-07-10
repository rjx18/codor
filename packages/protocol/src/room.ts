import { z } from 'zod';

import { RoomIdSchema, TimestampSchema } from './ids.js';

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

/** Daily per-room spend meter (always on, never blocking). */
export const RoomMeterSchema = z.object({
  room: RoomIdSchema,
  day: z.iso.date(), // YYYY-MM-DD, switchboard clock
  turns: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(), // sums only cost-reporting members
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type RoomMeter = z.infer<typeof RoomMeterSchema>;
