import { z } from 'zod';

/** Stable member identity — a ULID, never reused, never renamed. */
export const MemberIdSchema = z.ulid();
export type MemberId = z.infer<typeof MemberIdSchema>;

// harn:assume blob-path-contained ref=room-id-schema
/** Room identity — a lowercase slug safe to use as one filesystem segment. */
export const ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RoomIdSchema = z.string().regex(ROOM_ID_REGEX);
export type RoomId = z.infer<typeof RoomIdSchema>;
// harn:end blob-path-contained

/** Per-room dense monotonic message id — what `#N` refs point at. */
export const MessageIdSchema = z.number().int().positive();
export type MessageId = z.infer<typeof MessageIdSchema>;

/** Room change-sequence — the only delta-sync cursor (see changelog.ts). */
export const SeqSchema = z.number().int().nonnegative();
export type Seq = z.infer<typeof SeqSchema>;

/** ISO-8601 UTC timestamp, switchboard clock (display-only; ids order). */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;
