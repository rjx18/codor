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
import { MessageSchema } from './message.js';
import { RoomMeterSchema, RoomSchema, RoomSupportSchema } from './room.js';

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
  hydrate_limit: z.number().int().positive().optional(),
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
  // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-post-contract
  awaiting_reply: z.boolean().optional(),
  // harn:end awaiting-reply-marker-is-delivery-context
});
export type PostFrame = z.infer<typeof PostFrameSchema>;

export const ListRoomsFrameSchema = z.object({ type: z.literal('list_rooms') });
export type ListRoomsFrame = z.infer<typeof ListRoomsFrameSchema>;

export const ActSchema = z.discriminatedUnion('act', [
  z.object({
    act: z.literal('answer_interaction'),
    interaction_id: z.string().min(1),
    answer: z.unknown(),
  }),
  z.object({ act: z.literal('redeliver'), delivery_id: z.string().min(1) }),
  z.object({ act: z.literal('release_hold'), delivery_id: z.string().min(1) }),
  z.object({ act: z.literal('mark_read'), delivery_id: z.string().min(1) }),
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
  z.object({ type: z.literal('rooms'), rooms: z.array(RoomSchema) }),
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
  // harn:assume multiplexed-subscriptions-identify-their-room ref=room-addressed-frame-contract
  z.object({ type: z.literal('member'), seq: SeqSchema, member: MemberSchema, room: RoomIdSchema.optional() }),
  // harn:end multiplexed-subscriptions-identify-their-room
  z.object({ type: z.literal('inbox'), seq: SeqSchema, delivery: DeliverySchema }),
  // harn:assume live-delivery-consumption-is-idempotent ref=consume-result-frame
  z.object({
    type: z.literal('consume_result'),
    delivery: DeliverySchema,
    message: MessageSchema,
  }),
  // harn:end live-delivery-consumption-is-idempotent
  z.object({ type: z.literal('meter'), seq: SeqSchema, meter: RoomMeterSchema }),
  z.object({ type: z.literal('room'), seq: SeqSchema, room: RoomSchema }),
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
    ref: z.string().optional(), // offending frame/act identifier when known
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
