import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema } from './ids.js';
import { MemberStateSchema } from './member.js';
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
  }),
  z.object({ type: z.literal('ask.raised'), card: AskCardSchema }),
  z.object({ type: z.literal('approval.raised'), card: AskCardSchema }),
  z.object({
    type: z.literal('run.completed'),
    status: RunStatusSchema.exclude(['running']),
    final_text: z.string().optional(),
    usage: UsageSchema.optional(),
  }),
  z.object({
    type: z.literal('member.state'),
    member: MemberIdSchema,
    state: MemberStateSchema,
  }),
  z.object({
    type: z.literal('extension.started'),
    parent: MemberIdSchema,
    ext_member: MemberIdSchema,
  }),
  z.object({
    type: z.literal('extension.ended'),
    ext_member: MemberIdSchema,
    summary: z.string().optional(),
  }),
]);
export type WireEvent = z.infer<typeof WireEventSchema>;
