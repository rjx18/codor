import { z } from 'zod';

/** Stable member identity — a ULID, never reused, never renamed. */
export const MemberIdSchema = z.ulid();
export type MemberId = z.infer<typeof MemberIdSchema>;

/** Room identity — an opaque non-empty string (slug by convention). */
export const RoomIdSchema = z.string().min(1);
export type RoomId = z.infer<typeof RoomIdSchema>;

/** Per-room dense monotonic message id — what `#N` refs point at. */
export const MessageIdSchema = z.number().int().positive();
export type MessageId = z.infer<typeof MessageIdSchema>;

/** Room change-sequence — the only delta-sync cursor (see changelog.ts). */
export const SeqSchema = z.number().int().nonnegative();
export type Seq = z.infer<typeof SeqSchema>;

/** ISO-8601 UTC timestamp, switchboard clock (display-only; ids order). */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;
