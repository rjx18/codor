import { z } from 'zod';

import {
  AcpLaunchConfigSchema,
  AcpProviderIdSchema,
  PolicySchema,
  ThinkingLevelSchema,
} from './adapter.js';
import { AssignableHandleSchema } from './member.js';
import { MemberIdSchema, TimestampSchema } from './ids.js';

export const AGENT_PRESET_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ROSTER_ID = 'default' as const;
export const AGENT_PRESET_MAX_LABEL_LENGTH = 80;
export const AGENT_PRESET_MAX_DISPLAY_NAME_LENGTH = 120;
export const AGENT_PRESET_MAX_HARNESS_LENGTH = 64;
/** Public selectors also carry the `acp:` prefix for named ACP providers. */
export const AGENT_PRESET_MAX_PUBLIC_ADAPTER_LENGTH = AGENT_PRESET_MAX_HARNESS_LENGTH + 'acp:'.length;
export const AGENT_PRESET_MAX_MODEL_LENGTH = 256;
export const DEFAULT_ROSTER_MAX_PRESETS = 100;

/** The same bounded model-id grammar used by the daemon's adapter catalog. */
export const AGENT_PRESET_MODEL_ID_REGEX = /^\w[\w.:-]*(?:\/[\w.:-]+)*$/;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const presetIdSchema = MemberIdSchema;

const agentPresetConfigurationShape = {
  label: boundedText(AGENT_PRESET_MAX_LABEL_LENGTH),
  handle: AssignableHandleSchema,
  display_name: boundedText(AGENT_PRESET_MAX_DISPLAY_NAME_LENGTH).optional(),
  harness: z.string().trim().min(1).max(AGENT_PRESET_MAX_HARNESS_LENGTH),
  model: z.string().trim().min(1).max(AGENT_PRESET_MAX_MODEL_LENGTH)
    .regex(AGENT_PRESET_MODEL_ID_REGEX, 'model id has an invalid format')
    .optional(),
  thinking: ThinkingLevelSchema.optional(),
  policy: PolicySchema.optional(),
  acp_provider: AcpProviderIdSchema.optional(),
  acp_launch: AcpLaunchConfigSchema.optional(),
} as const;

function refineAgentPresetConfiguration(
  preset: {
    harness: string;
    model?: string;
    acp_provider?: string;
    acp_launch?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const hasProvider = preset.acp_provider !== undefined;
  const hasLaunch = preset.acp_launch !== undefined;
  if (preset.harness === 'acp') {
    if (hasProvider === hasLaunch) {
      ctx.addIssue({
        code: 'custom',
        path: ['acp_provider'],
        message: 'an acp preset requires exactly one of acp_provider or acp_launch',
      });
    }
    if (preset.model !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'acp presets do not carry a client-selected model',
      });
    }
    return;
  }
  if (hasProvider || hasLaunch) {
    ctx.addIssue({
      code: 'custom',
      path: ['acp_provider'],
      message: 'acp_provider or acp_launch is accepted only for the acp harness',
    });
  }
}

// harn:assume individual-agent-presets-are-bounded-catalog-validated-configurations ref=individual-agent-preset-schema
/** Server-owned, durable identity and timestamps wrapped around reusable configuration. */
export const AgentPresetSchema = z.object({
  id: presetIdSchema,
  schema_version: z.literal(AGENT_PRESET_SCHEMA_VERSION),
  created_ts: TimestampSchema,
  updated_ts: TimestampSchema,
  ...agentPresetConfigurationShape,
}).strict().superRefine(refineAgentPresetConfiguration);
export type AgentPreset = z.infer<typeof AgentPresetSchema>;

/** Client input for both create and full-replacement update. */
export const AgentPresetInputSchema = z.object(agentPresetConfigurationShape)
  .strict()
  .superRefine(refineAgentPresetConfiguration);
export type AgentPresetInput = z.infer<typeof AgentPresetInputSchema>;

// Readable aliases for callers that distinguish create/update at the type level.
export const AgentPresetCreateInputSchema = AgentPresetInputSchema;
export const AgentPresetUpdateInputSchema = AgentPresetInputSchema;
export type AgentPresetCreateInput = AgentPresetInput;
export type AgentPresetUpdateInput = AgentPresetInput;

// harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-safe-schema
/**
 * The launch-free projection used by the structured CLI.  Browser REST keeps
 * the full editing record for its existing contract; the CLI receives only
 * this public selector and bounded configuration projection.
 */
export const AgentPresetPublicSchema = z.object({
  id: presetIdSchema,
  schema_version: z.literal(AGENT_PRESET_SCHEMA_VERSION),
  created_ts: TimestampSchema,
  updated_ts: TimestampSchema,
  label: boundedText(AGENT_PRESET_MAX_LABEL_LENGTH),
  handle: AssignableHandleSchema,
  display_name: boundedText(AGENT_PRESET_MAX_DISPLAY_NAME_LENGTH).optional(),
  adapter: boundedText(AGENT_PRESET_MAX_PUBLIC_ADAPTER_LENGTH),
  model: z.string().trim().min(1).max(AGENT_PRESET_MAX_MODEL_LENGTH)
    .regex(AGENT_PRESET_MODEL_ID_REGEX, 'model id has an invalid format')
    .optional(),
  thinking: ThinkingLevelSchema.optional(),
  policy: PolicySchema.optional(),
  custom_acp: z.literal(true).optional(),
}).strict();
export type AgentPresetPublic = z.infer<typeof AgentPresetPublicSchema>;
// harn:end structured-preset-and-roster-cli-is-safe-and-ordered
// harn:end individual-agent-presets-are-bounded-catalog-validated-configurations

// harn:assume default-roster-is-one-versioned-ordered-preset-reference-group ref=default-roster-schema
export const DefaultRosterSchema = z.object({
  id: z.literal(DEFAULT_ROSTER_ID),
  schema_version: z.literal(AGENT_PRESET_SCHEMA_VERSION),
  updated_ts: TimestampSchema,
  preset_ids: z.array(presetIdSchema)
    .max(DEFAULT_ROSTER_MAX_PRESETS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'default roster preset ids must be unique',
    }),
}).strict();
export type DefaultRoster = z.infer<typeof DefaultRosterSchema>;

export const DefaultRosterInputSchema = z.object({
  preset_ids: z.array(presetIdSchema)
    .max(DEFAULT_ROSTER_MAX_PRESETS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'default roster preset ids must be unique',
    }),
}).strict();
export type DefaultRosterInput = z.infer<typeof DefaultRosterInputSchema>;
export const DefaultRosterUpdateSchema = DefaultRosterInputSchema;
export type DefaultRosterUpdate = DefaultRosterInput;
// harn:end default-roster-is-one-versioned-ordered-preset-reference-group

export const AgentPresetIdSchema = presetIdSchema;
export type AgentPresetId = z.infer<typeof AgentPresetIdSchema>;
