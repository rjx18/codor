import { z } from 'zod';

import { WireEventSchema } from './events.js';
import { MessageIdSchema } from './ids.js';
import { MessageSchema } from './message.js';

// harn:assume historical-transcript-pages-are-unit-bounded-and-room-bound ref=transcript-history-protocol
export const HISTORICAL_TRANSCRIPT_PAGE_SIZE = 20;

export const TranscriptHistoryCursorSchema = z.string().min(1).max(4096);

export const TranscriptHistoryIndexedEventSchema = z.object({
  index: z.number().int().nonnegative(),
  event: WireEventSchema,
});
export type TranscriptHistoryIndexedEvent = z.infer<typeof TranscriptHistoryIndexedEventSchema>;

export const TranscriptHistoryJournalSchema = z.object({
  root_message_id: MessageIdSchema,
  events: z.array(TranscriptHistoryIndexedEventSchema),
});
export type TranscriptHistoryJournal = z.infer<typeof TranscriptHistoryJournalSchema>;

const journalUnitFields = {
  root_message_id: MessageIdSchema,
  output_message_id: MessageIdSchema,
  event_indices: z.array(z.number().int().nonnegative()).min(1),
};

export const TranscriptHistoryUnitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    message_id: MessageIdSchema,
  }),
  z.object({ kind: z.literal('prose'), ...journalUnitFields }),
  z.object({
    kind: z.literal('tool'),
    ...journalUnitFields,
    event_indices: journalUnitFields.event_indices.max(2),
  }),
  z.object({ kind: z.literal('timeline'), ...journalUnitFields }),
  z.object({
    kind: z.literal('terminal'),
    root_message_id: MessageIdSchema,
    output_message_id: MessageIdSchema,
    /** Empty only when synthesized from the finalized root summary. */
    event_indices: z.array(z.number().int().nonnegative()).max(1),
  }),
]);
export type TranscriptHistoryUnit = z.infer<typeof TranscriptHistoryUnitSchema>;

export const TranscriptHistoryPageSchema = z.object({
  messages: z.array(MessageSchema),
  journals: z.array(TranscriptHistoryJournalSchema),
  units: z.array(TranscriptHistoryUnitSchema).max(HISTORICAL_TRANSCRIPT_PAGE_SIZE),
  before_cursor: TranscriptHistoryCursorSchema.nullable(),
  has_more: z.boolean(),
}).superRefine((page, context) => {
  const messageIds = new Set(page.messages.map((message) => message.id));
  const journalIndices = new Map<number, Set<number>>();
  const usedIndices = new Map<number, Set<number>>();

  for (const journal of page.journals) {
    if (journalIndices.has(journal.root_message_id)) {
      context.addIssue({
        code: 'custom',
        path: ['journals'],
        message: `duplicate journal ${String(journal.root_message_id)}`,
      });
      continue;
    }
    const indices = new Set<number>();
    for (const indexed of journal.events) {
      if (indices.has(indexed.index)) {
        context.addIssue({
          code: 'custom',
          path: ['journals'],
          message: `duplicate journal index ${String(indexed.index)}`,
        });
      }
      indices.add(indexed.index);
    }
    journalIndices.set(journal.root_message_id, indices);
    usedIndices.set(journal.root_message_id, new Set());
  }

  page.units.forEach((unit, unitIndex) => {
    if (unit.kind === 'message') {
      if (!messageIds.has(unit.message_id)) {
        context.addIssue({
          code: 'custom',
          path: ['units', unitIndex, 'message_id'],
          message: 'unit message is absent from complete message records',
        });
      }
      return;
    }
    if (!messageIds.has(unit.root_message_id) || !messageIds.has(unit.output_message_id)) {
      context.addIssue({
        code: 'custom',
        path: ['units', unitIndex],
        message: 'journal unit message is absent from complete message records',
      });
    }
    const available = journalIndices.get(unit.root_message_id);
    const used = usedIndices.get(unit.root_message_id);
    for (const eventIndex of unit.event_indices) {
      if (available?.has(eventIndex) !== true) {
        context.addIssue({
          code: 'custom',
          path: ['units', unitIndex, 'event_indices'],
          message: `journal index ${String(eventIndex)} is absent from the excerpt`,
        });
      } else {
        used?.add(eventIndex);
      }
    }
  });

  for (const [rootMessageId, indices] of journalIndices) {
    const used = usedIndices.get(rootMessageId)!;
    for (const eventIndex of indices) {
      if (!used.has(eventIndex)) {
        context.addIssue({
          code: 'custom',
          path: ['journals'],
          message: `journal index ${String(eventIndex)} is not selected by a unit`,
        });
      }
    }
  }
});
export type TranscriptHistoryPage = z.infer<typeof TranscriptHistoryPageSchema>;
// harn:end historical-transcript-pages-are-unit-bounded-and-room-bound
