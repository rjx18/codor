import { z } from 'zod';

import { RoomIdSchema, SeqSchema } from './ids.js';

// harn:assume changelog-is-sync-cursor ref=changelog-entry-schema
/**
 * The per-room change log records EVERY insert and in-place update of any
 * client-visible entity — messages (incl. run finalization), members, human
 * inbox records, meters, room config. `seq` is the ONLY delta-sync cursor:
 * clients reconnect with `since_seq` and hydrate changed rows from the log
 * (message-id cursors cannot express in-place run finalizations).
 */
export const ChangeEntitySchema = z.enum(['message', 'member', 'inbox', 'meter', 'room']);
export type ChangeEntity = z.infer<typeof ChangeEntitySchema>;

export const ChangeLogEntrySchema = z.object({
  room: RoomIdSchema,
  seq: SeqSchema,
  entity: ChangeEntitySchema,
  entity_id: z.string().min(1), // stringified: message id, member ulid, delivery id, …
});
export type ChangeLogEntry = z.infer<typeof ChangeLogEntrySchema>;
// harn:end changelog-is-sync-cursor
