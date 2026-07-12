import { z } from 'zod';

import { PolicySchema, ThinkingLevelSchema } from './adapter.js';
import { DeliverySchema } from './delivery.js';
import { WireEventSchema } from './events.js';
import { MemberIdSchema, MessageIdSchema, RoomIdSchema, SeqSchema } from './ids.js';
import { AssignableHandleSchema } from './member.js';
import { MemberSchema } from './member.js';
import { MessageSchema } from './message.js';
import { RoomMeterSchema, RoomSchema } from './room.js';

// ── client → server ────────────────────────────────────────────────────────

// harn:assume changelog-is-sync-cursor ref=ws-subscribe-cursor
/** Reconnect/delta-sync always cursors on `since_seq` — never message ids. */
export const SubscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  room: RoomIdSchema,
  since_seq: SeqSchema, // 0 = full hydrate
});
// harn:end changelog-is-sync-cursor
export type SubscribeFrame = z.infer<typeof SubscribeFrameSchema>;

export const PostFrameSchema = z.object({
  type: z.literal('post'),
  room: RoomIdSchema,
  body: z.string().min(1),
  reply_to: MessageIdSchema.optional(),
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
]);
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
  z.object({ type: z.literal('rooms'), rooms: z.array(RoomSchema) }),
  z.object({ type: z.literal('self'), member_id: MemberIdSchema }),
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
  z.object({ type: z.literal('member'), seq: SeqSchema, member: MemberSchema }),
  z.object({ type: z.literal('inbox'), seq: SeqSchema, delivery: DeliverySchema }),
  z.object({ type: z.literal('meter'), seq: SeqSchema, meter: RoomMeterSchema }),
  z.object({ type: z.literal('room'), seq: SeqSchema, room: RoomSchema }),
  // harn:assume sync-cursor-commits-after-hydration ref=sync-complete-frame
  z.object({ type: z.literal('sync_complete'), seq: SeqSchema }),
  // harn:end sync-cursor-commits-after-hydration
  z.object({
    type: z.literal('run_event'),
    room: RoomIdSchema,
    message_id: MessageIdSchema,
    event: WireEventSchema,
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    ref: z.string().optional(), // offending frame/act identifier when known
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
