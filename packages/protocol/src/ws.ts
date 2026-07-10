import { z } from 'zod';

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
    act: z.literal('spawn'),
    harness: z.string().min(1),
    handle: AssignableHandleSchema,
    cwd: z.string().min(1),
    model: z.string().optional(),
    policy: z.string().optional(),
  }),
  z.object({
    act: z.literal('rename'),
    member_id: MemberIdSchema,
    handle: AssignableHandleSchema,
    display_name: z.string().optional(),
  }),
  z.object({ act: z.literal('revive'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('kill'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('pause'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('unpause'), member_id: MemberIdSchema }),
  z.object({ act: z.literal('interrupt'), member_id: MemberIdSchema }),
]);
export type Act = z.infer<typeof ActSchema>;

export const ActFrameSchema = z.object({
  type: z.literal('act'),
  room: RoomIdSchema,
  act: ActSchema,
});
export type ActFrame = z.infer<typeof ActFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion('type', [
  SubscribeFrameSchema,
  PostFrameSchema,
  ActFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ── server → client ────────────────────────────────────────────────────────

/**
 * Live entity frames carry the change-log `seq` that produced them. Hydration
 * entity frames retain the requested cursor until a final `sync_complete`
 * commits the consistent snapshot cursor. `run_event` frames are ephemeral.
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
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
