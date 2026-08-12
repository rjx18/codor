import { z } from 'zod';

import {
  AcpLaunchConfigSchema,
  AcpProviderIdSchema,
  PolicySchema,
  ThinkingLevelSchema,
} from './adapter.js';
import { DeliverySchema } from './delivery.js';
import { WireEventSchema } from './events.js';
import { MemberIdSchema, MessageIdSchema, RoomIdSchema, SeqSchema, TimestampSchema } from './ids.js';
import { AssignableHandleSchema } from './member.js';
import { MemberSchema } from './member.js';
import { MessageSchema, VoiceNoteSchema } from './message.js';
import { ScheduleIdSchema, ScheduleSchema } from './schedule.js';
import {
  CreateRoomRequestSchema,
  RoomMeterSchema,
  RoomSchema,
  RoomSupportSchema,
} from './room.js';
import {
  AgentPresetIdSchema,
  AgentPresetInputSchema,
  AgentPresetPublicSchema,
  DefaultRosterInputSchema,
  DefaultRosterSchema,
} from './agent-presets.js';

// ── client → server ────────────────────────────────────────────────────────

// harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=browser-protocol-epoch-contract
/** Increment only when a browser/server cutover cannot be read compatibly. */
export const BROWSER_PROTOCOL_EPOCH = 2;
// harn:end browser-protocol-epoch-blocks-only-stale-browser-ui

// harn:assume changelog-is-sync-cursor ref=ws-subscribe-cursor
/** Reconnect/delta-sync always cursors on `since_seq` — never message ids. */
export const SubscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  room: RoomIdSchema,
  since_seq: SeqSchema, // 0 = full hydrate
  /**
   * Cold-hydration bound: how many trailing messages a viewer wants on a
   * since_seq 0 subscribe. Additive and optional — a subscriber that omits it
   * (agents, the CLI) gets the full replay byte-identically, and it is ignored
   * on a warm subscribe so a reconnect can never miss an in-place change.
   */
  // harn:assume hosted-background-rooms-hydrate-metadata-until-promoted ref=zero-history-subscribe-protocol
  hydrate_limit: z.number().int().nonnegative().optional(),
  // harn:end hosted-background-rooms-hydrate-metadata-until-promoted
  // harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-frame-contract
  /**
   * Opt into outer room ids on the otherwise ambiguous self, member, and
   * sync_complete frames. Omission is the legacy wire contract.
   */
  room_addressed: z.literal(true).optional(),
  // harn:end multiplexed-subscriptions-identify-their-room
  // harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=browser-protocol-epoch-contract
  /** Browser-only compatibility epoch. Agents and CLI subscribers omit it. */
  browser_protocol: z.number().int().positive().optional(),
  /** Stable declaration for owner-token development browsers. */
  client_kind: z.literal('browser').optional(),
  // harn:end browser-protocol-epoch-blocks-only-stale-browser-ui
});
// harn:end changelog-is-sync-cursor
export type SubscribeFrame = z.infer<typeof SubscribeFrameSchema>;

export const PostFrameSchema = z.object({
  type: z.literal('post'),
  room: RoomIdSchema,
  body: z.string(), // may be empty when attachments carry the message (server refuses truly empty)
  reply_to: MessageIdSchema.optional(),
  // ids of files uploaded to this room beforehand; capped at 8 per message
  attachments: z.array(z.string().min(1)).max(8).optional(),
  // harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-post-frame
  voice: VoiceNoteSchema.optional(), // bounded recording metadata for a dictated post
  // harn:end voice-message-metadata-is-bounded-and-additive
  // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-post-contract
  awaiting_reply: z.boolean().optional(),
  // harn:end awaiting-reply-marker-is-delivery-context
});
export type PostFrame = z.infer<typeof PostFrameSchema>;

// harn:assume management-frames-correlate-one-result ref=management-correlation-protocol
/** Opaque request ids are echoed only on the authoritative management result. */
export const ManagementRefSchema = z.string().min(1).max(128);

export const ListRoomsFrameSchema = z.object({
  type: z.literal('list_rooms'),
  /** Optional for legacy callers; structured management callers always set it. */
  ref: ManagementRefSchema.optional(),
  /** Include soft-archived channels in discovery. */
  all: z.boolean().optional(),
});
export type ListRoomsFrame = z.infer<typeof ListRoomsFrameSchema>;

export const CreateRoomFrameSchema = z.object({
  type: z.literal('create_room'),
  ref: ManagementRefSchema,
  request: CreateRoomRequestSchema,
});
export type CreateRoomFrame = z.infer<typeof CreateRoomFrameSchema>;

// harn:assume agent-preset-management-is-authorized-across-rest-and-cli ref=agent-preset-management-protocol
/** Global preset and roster management stays on the same authenticated socket
 * as room management. Every request carries an opaque correlation ref. */
export const ListAgentPresetsFrameSchema = z.object({
  type: z.literal('list_agent_presets'),
  ref: ManagementRefSchema,
}).strict();
export type ListAgentPresetsFrame = z.infer<typeof ListAgentPresetsFrameSchema>;

export const CreateAgentPresetFrameSchema = z.object({
  type: z.literal('create_agent_preset'),
  ref: ManagementRefSchema,
  input: AgentPresetInputSchema,
}).strict();
export type CreateAgentPresetFrame = z.infer<typeof CreateAgentPresetFrameSchema>;

export const UpdateAgentPresetFrameSchema = z.object({
  type: z.literal('update_agent_preset'),
  ref: ManagementRefSchema,
  preset_id: AgentPresetIdSchema,
  input: AgentPresetInputSchema,
}).strict();
export type UpdateAgentPresetFrame = z.infer<typeof UpdateAgentPresetFrameSchema>;

export const DeleteAgentPresetFrameSchema = z.object({
  type: z.literal('delete_agent_preset'),
  ref: ManagementRefSchema,
  preset_id: AgentPresetIdSchema,
}).strict();
export type DeleteAgentPresetFrame = z.infer<typeof DeleteAgentPresetFrameSchema>;

export const GetDefaultRosterFrameSchema = z.object({
  type: z.literal('get_default_roster'),
  ref: ManagementRefSchema,
}).strict();
export type GetDefaultRosterFrame = z.infer<typeof GetDefaultRosterFrameSchema>;

export const SetDefaultRosterFrameSchema = z.object({
  type: z.literal('set_default_roster'),
  ref: ManagementRefSchema,
  input: DefaultRosterInputSchema,
}).strict();
export type SetDefaultRosterFrame = z.infer<typeof SetDefaultRosterFrameSchema>;
// harn:end agent-preset-management-is-authorized-across-rest-and-cli

// harn:assume agent-management-correlates-safe-member-results ref=agent-management-correlation-protocol
/** Room-scoped structured agent discovery. The ref is required so the CLI can
 * distinguish the authoritative snapshot from ordinary member fanout. */
export const ListAgentsFrameSchema = z.object({
  type: z.literal('list_agents'),
  room: RoomIdSchema,
  ref: ManagementRefSchema,
}).strict();
export type ListAgentsFrame = z.infer<typeof ListAgentsFrameSchema>;

/** Public structured agent creation. The daemon resolves either `adapter` or a
 * durable `preset_id` through its installed catalog; private ACP launch material
 * is intentionally not a wire field. */
export const AddAgentFrameSchema = z.object({
  type: z.literal('add_agent'),
  room: RoomIdSchema,
  ref: ManagementRefSchema,
  adapter: z.string().trim().min(1).max(128).optional(),
  preset_id: AgentPresetIdSchema.optional(),
  handle: AssignableHandleSchema.optional(),
  cwd: z.string().min(1),
  policy: PolicySchema.optional(),
  model: z.string().min(1).optional(),
  thinking: ThinkingLevelSchema.optional(),
  display_name: z.string().optional(),
  purpose: z.string().optional(),
}).strict().superRefine((frame, ctx) => {
  const hasAdapter = frame.adapter !== undefined;
  const hasPreset = frame.preset_id !== undefined;
  if (hasAdapter === hasPreset) {
    ctx.addIssue({
      code: 'custom', path: ['adapter'],
      message: 'agent add requires exactly one of adapter or preset_id',
    });
  }
  if (!hasPreset && frame.handle === undefined) {
    ctx.addIssue({
      code: 'custom', path: ['handle'],
      message: 'manual agent add requires a handle',
    });
  }
});
export type AddAgentFrame = z.infer<typeof AddAgentFrameSchema>;
// harn:end agent-management-correlates-safe-member-results

export const ActSchema = z.discriminatedUnion('act', [
  z.object({
    act: z.literal('answer_interaction'),
    interaction_id: z.string().min(1),
    answer: z.unknown(),
  }),
  z.object({ act: z.literal('redeliver'), delivery_id: z.string().min(1) }),
  z.object({ act: z.literal('release_hold'), delivery_id: z.string().min(1) }),
  z.object({ act: z.literal('mark_read'), delivery_id: z.string().min(1) }),
  // harn:assume scheduled-cancellation-is-authorized-before-claim ref=cancel-schedule-protocol
  z.object({ act: z.literal('cancel_schedule'), schedule_id: ScheduleIdSchema }),
  // harn:end scheduled-cancellation-is-authorized-before-claim
  // harn:assume human-room-read-cursors-are-durable-and-monotonic ref=mark-room-read-contract
  z.object({ act: z.literal('mark_room_read'), through_seq: SeqSchema }),
  // harn:end human-room-read-cursors-are-durable-and-monotonic
  z.object({
    act: z.literal('join'),
    harness: z.string().min(1),
    handle: AssignableHandleSchema,
    session_ref: z.string().min(1),
    cwd: z.string().min(1),
    policy: z.string().optional(),
    purpose: z.string().optional(),
  }),
  z.object({ act: z.literal('adopt'), member_id: MemberIdSchema }),
  z.object({
    act: z.literal('attach_acquire'),
    member_id: MemberIdSchema,
    cli_pid: z.number().int().positive(),
  }),
  z.object({
    act: z.literal('attach_child'),
    lease_id: z.string().min(1),
    child_pid: z.number().int().positive(),
    process_group_id: z.number().int().positive(),
  }),
  z.object({ act: z.literal('attach_heartbeat'), lease_id: z.string().min(1) }),
  z.object({ act: z.literal('attach_complete'), lease_id: z.string().min(1) }),
  z.object({
    act: z.literal('configure_room'),
    turn_brake: z.number().int().positive().nullable().optional(),
    spend_brake_usd: z.number().positive().nullable().optional(),
    stall_minutes: z.number().int().positive().optional(),
  }),
  z.object({
    act: z.literal('spawn'),
    harness: z.string().min(1),
    handle: AssignableHandleSchema,
    // harn:assume individual-agent-preset-selection-snapshots-one-ordinary-spawn-v2 ref=agent-preset-spawn-display-name-contract
    // A reusable preset may carry a display name. Keep it bounded and optional so
    // older/manual clients retain the handle-derived default.
    display_name: z.string().trim().min(1).max(120).optional(),
    // harn:end individual-agent-preset-selection-snapshots-one-ordinary-spawn-v2
    cwd: z.string().min(1),
    model: z.string().optional(),
    policy: z.string().optional(),
    thinking: ThinkingLevelSchema.optional(),
    purpose: z.string().optional(),
    acp_launch: AcpLaunchConfigSchema.optional(),
    // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-spawn-act-schema
    // A curated named ACP provider id — mutually exclusive with acp_launch and valid only
    // for the acp harness. The daemon compiles it privately; the one-of invariant is
    // enforced where this act is consumed (server WS spawn handler).
    acp_provider: AcpProviderIdSchema.optional(),
    // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
  }),
  z.object({
    act: z.literal('rename'),
    member_id: MemberIdSchema,
    handle: AssignableHandleSchema,
    display_name: z.string().optional(),
  }),
  z.object({ act: z.literal('revive'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('kill'), member_id: MemberIdSchema }),
  // harn:assume removed-members-remain-attribution-tombstones ref=remove-act-contract
  z.object({ act: z.literal('remove'), member_id: MemberIdSchema }),
  // harn:end removed-members-remain-attribution-tombstones
  z.object({ act: z.literal('pause'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('unpause'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('interrupt'), member_id: MemberIdSchema }),
  // Manual engine compaction: the daemon gates it (idle agent, owner/admin).
  z.object({ act: z.literal('compact_member'), member_id: MemberIdSchema }),
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-act-schema
  // Destructive native-memory reset: the daemon applies the full idle/runtime
  // retirement boundary; the browser supplies only the target member.
  z.object({ act: z.literal('clear_member_context'), member_id: MemberIdSchema }),
  // harn:end member-context-reset-is-authorized-atomic-and-lazy
  // harn:assume live-delivery-consumption-is-idempotent ref=consume-act-contract
  z.object({ act: z.literal('consume_delivery'), delivery_id: z.string().uuid() }),
  // harn:end live-delivery-consumption-is-idempotent
  // harn:assume live-agent-waits-are-transient ref=wait-act-contract
  z.object({
    act: z.literal('wait_begin'),
    reason: z.enum(['reply', 'mention', 'any']),
    peers: z.array(MemberIdSchema).min(1),
    until_ts: TimestampSchema,
  }),
  z.object({ act: z.literal('wait_end') }),
  // harn:end live-agent-waits-are-transient
  // harn:assume member-config-is-changed-not-respawned ref=configure-act-contract
  // The settings a live agent can be given AFTER it exists. Not the harness and not
  // the cwd: those are fixed when the agent is created, and offering a control that
  // cannot work is worse than saying so.
  z.object({
    act: z.literal('configure'),
    member_id: MemberIdSchema,
    // Absent leaves a setting alone; NULL clears it back to the harness default. Without
    // the distinction there is no way to say "stop pinning a model" — only a way to pin a
    // different one.
    model: z.string().min(1).nullable().optional(),
    thinking: ThinkingLevelSchema.nullable().optional(),
    policy: PolicySchema.optional(),
  }),
  // harn:end member-config-is-changed-not-respawned
  z.object({
    act: z.literal('set_role'),
    member_id: MemberIdSchema,
    role: z.enum(['owner', 'admin', 'member', 'observer']),
  }),
  z.object({
    act: z.literal('pin_message'),
    message_id: MessageIdSchema,
    pinned: z.boolean(),
  }),
  z.object({
    act: z.literal('delete_message'),
    message_id: MessageIdSchema,
  }),
  z.object({
    act: z.literal('retry_run'),
    message_id: MessageIdSchema,
  }),
  // harn:assume channel-archive-is-durable-soft-state ref=channel-archive-protocol
  z.object({ act: z.literal('rename_room'), name: z.string().min(1) }),
  z.object({ act: z.literal('archive_room') }),
  // harn:end channel-archive-is-durable-soft-state
])
  // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-spawn-act-schema
  // A discriminated union cannot refine a single member, so the ACP spawn one-of is
  // enforced on the whole union: an acp spawn carries exactly one of a named provider id
  // or a custom launch, and a non-acp spawn carries neither.
  .superRefine((act, ctx) => {
    if (act.act !== 'spawn') return;
    const hasProvider = act.acp_provider !== undefined;
    const hasLaunch = act.acp_launch !== undefined;
    if (act.harness === 'acp') {
      if (hasProvider === hasLaunch) {
        ctx.addIssue({
          code: 'custom', path: ['acp_provider'],
          message: 'an acp spawn requires exactly one of a named provider id or a custom launch',
        });
      }
    } else if (hasProvider || hasLaunch) {
      ctx.addIssue({
        code: 'custom', path: ['acp_launch'],
        message: 'only an acp spawn may carry a provider id or custom launch',
      });
    }
  });
// harn:end named-acp-provider-selection-resolves-to-private-structured-launch
export type Act = z.infer<typeof ActSchema>;

export const ActFrameSchema = z.object({
  type: z.literal('act'),
  room: RoomIdSchema,
  act: ActSchema,
  // harn:assume management-frames-correlate-one-result ref=management-correlation-protocol
  ref: ManagementRefSchema.optional(),
  // harn:end management-frames-correlate-one-result
});
export type ActFrame = z.infer<typeof ActFrameSchema>;

export const MirrorTurnFrameSchema = z.object({
  type: z.literal('mirror_turn'),
  harness: z.string().min(1),
  session_ref: z.string().min(1),
  native_turn_id: z.string().min(1),
  body: z.string(),
  transcript_path: z.string().optional(),
});
export type MirrorTurnFrame = z.infer<typeof MirrorTurnFrameSchema>;

export const MirrorSessionEndFrameSchema = z.object({
  type: z.literal('mirror_session_end'),
  harness: z.string().min(1),
  session_ref: z.string().min(1),
});
export type MirrorSessionEndFrame = z.infer<typeof MirrorSessionEndFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion('type', [
  ListRoomsFrameSchema,
  CreateRoomFrameSchema,
  ListAgentPresetsFrameSchema,
  CreateAgentPresetFrameSchema,
  UpdateAgentPresetFrameSchema,
  DeleteAgentPresetFrameSchema,
  GetDefaultRosterFrameSchema,
  SetDefaultRosterFrameSchema,
  ListAgentsFrameSchema,
  AddAgentFrameSchema,
  SubscribeFrameSchema,
  PostFrameSchema,
  ActFrameSchema,
  MirrorTurnFrameSchema,
  MirrorSessionEndFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ── server → client ────────────────────────────────────────────────────────

export const AttachLeaseSchema = z.object({
  id: z.string().min(1),
  room: RoomIdSchema,
  member_id: MemberIdSchema,
  cli_pid: z.number().int().positive(),
  child_pid: z.number().int().positive().optional(),
  process_group_id: z.number().int().positive().optional(),
  heartbeat_ts: z.number().int().nonnegative(),
});
export type AttachLease = z.infer<typeof AttachLeaseSchema>;

/**
 * Live entity frames carry the change-log `seq` that produced them. Hydration
 * entity frames retain the requested cursor until a final `sync_complete`
 * commits the consistent snapshot cursor. `run_event` frames are ephemeral.
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
  // harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=browser-protocol-epoch-contract
  z.object({
    type: z.literal('upgrade_required'),
    minimum_browser_protocol: z.number().int().positive(),
    current_browser_protocol: z.number().int().positive(),
  }),
  // harn:end browser-protocol-epoch-blocks-only-stale-browser-ui
  // harn:assume list-rooms-reply-carries-per-room-seq ref=rooms-reply-seq-schema
  z.object({
    type: z.literal('rooms'),
    rooms: z.array(RoomSchema),
    // harn:assume management-frames-correlate-one-result ref=management-correlation-protocol
    ref: ManagementRefSchema.optional(),
    // harn:end management-frames-correlate-one-result
    // Optional per-room committed seq, keyed by room id, so a client multiplexing
    // many rooms on one socket can detect a subscribed room that fell behind and
    // warm-resync only it. Absent from older servers → client skips
    // reconciliation (graceful no-op).
    room_seqs: z.record(RoomIdSchema, SeqSchema).optional(),
  }),
  // harn:end list-rooms-reply-carries-per-room-seq
  // harn:assume agent-preset-management-is-authorized-across-rest-and-cli ref=agent-preset-management-protocol
  z.object({
    type: z.literal('agent_presets'),
    presets: z.array(AgentPresetPublicSchema),
    ref: ManagementRefSchema,
  }).strict(),
  z.object({
    type: z.literal('agent_preset'),
    preset: AgentPresetPublicSchema,
    ref: ManagementRefSchema,
  }).strict(),
  z.object({
    type: z.literal('agent_preset_deleted'),
    id: AgentPresetIdSchema,
    deleted: z.literal(true),
    ref: ManagementRefSchema,
  }).strict(),
  z.object({
    type: z.literal('default_roster'),
    roster: DefaultRosterSchema,
    ref: ManagementRefSchema,
  }).strict(),
  // harn:end agent-preset-management-is-authorized-across-rest-and-cli
  // harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-frame-contract
  z.object({ type: z.literal('self'), member_id: MemberIdSchema, room: RoomIdSchema.optional() }),
  // harn:end multiplexed-subscriptions-identify-their-room
  z.object({
    type: z.literal('attach_lease'),
    status: z.enum(['acquired', 'child_recorded', 'completed', 'uncertain']),
    lease: AttachLeaseSchema.optional(),
    member: MemberSchema,
  }),
  z.object({
    type: z.literal('mirror_ack'),
    native_turn_id: z.string().optional(),
    message_id: MessageIdSchema.optional(),
    deduped: z.boolean().optional(),
    adopted: z.boolean().optional(),
  }),
  z.object({ type: z.literal('message'), seq: SeqSchema, message: MessageSchema }),
  // harn:assume scheduled-state-streams-through-room-seq ref=schedule-protocol-schema
  z.object({ type: z.literal('schedule'), seq: SeqSchema, schedule: ScheduleSchema }),
  z.object({
    type: z.literal('cancel_schedule_result'),
    ref: ManagementRefSchema,
    schedule: ScheduleSchema,
  }),
  // harn:end scheduled-state-streams-through-room-seq
  // harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-frame-contract
  z.object({
    type: z.literal('member'),
    seq: SeqSchema,
    member: MemberSchema,
    room: RoomIdSchema.optional(),
    // harn:assume agent-management-correlates-safe-member-results ref=agent-management-correlation-protocol
    ref: ManagementRefSchema.optional(),
    // harn:end agent-management-correlates-safe-member-results
  }),
  // harn:end multiplexed-subscriptions-identify-their-room
  // harn:assume agent-management-correlates-safe-member-results ref=agent-management-correlation-protocol
  z.object({
    type: z.literal('agents'),
    room: RoomIdSchema,
    agents: z.array(MemberSchema),
    ref: ManagementRefSchema,
  }),
  // harn:end agent-management-correlates-safe-member-results
  z.object({ type: z.literal('inbox'), seq: SeqSchema, delivery: DeliverySchema }),
  // harn:assume live-delivery-consumption-is-idempotent ref=consume-result-frame
  z.object({
    type: z.literal('consume_result'),
    delivery: DeliverySchema,
    message: MessageSchema,
  }),
  // harn:end live-delivery-consumption-is-idempotent
  z.object({ type: z.literal('meter'), seq: SeqSchema, meter: RoomMeterSchema }),
  z.object({
    type: z.literal('room'),
    seq: SeqSchema,
    room: RoomSchema,
    // harn:assume management-frames-correlate-one-result ref=management-correlation-protocol
    ref: ManagementRefSchema.optional(),
    // harn:end management-frames-correlate-one-result
  }),
  // harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-protocol
  z.object({ type: z.literal('room_support'), seq: SeqSchema, support: RoomSupportSchema }),
  // harn:end room-support-is-bounded-recipient-scoped-state
  // harn:assume sync-cursor-commits-after-hydration ref=sync-complete-frame
  z.object({
    type: z.literal('sync_complete'),
    seq: SeqSchema,
    // harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-frame-contract
    room: RoomIdSchema.optional(),
    // harn:end multiplexed-subscriptions-identify-their-room
    /**
     * Earliest id of the CONTIGUOUS tail this hydration served (correctness
     * outliers excluded), so the client's history cursor is the server's floor
     * rather than a guess from whatever arrived. Absent on an unbounded replay.
     */
    history_floor: MessageIdSchema.optional(),
  }),
  // harn:end sync-cursor-commits-after-hydration
  // harn:assume run-events-merge-by-journal-index ref=indexed-run-event-frame
  z.object({
    type: z.literal('run_event'),
    room: RoomIdSchema,
    message_id: MessageIdSchema,
    event: WireEventSchema,
    // The event's position in the run journal. Absent only from daemons that
    // predate index stamping; clients then fall back to local arithmetic.
    index: z.number().int().nonnegative().optional(),
  }),
  // harn:end run-events-merge-by-journal-index
  z.object({
    type: z.literal('error'),
    message: z.string(),
    // harn:assume management-frames-correlate-one-result ref=management-correlation-protocol
    ref: ManagementRefSchema.optional(), // offending frame/act identifier when known
    // harn:end management-frames-correlate-one-result
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
