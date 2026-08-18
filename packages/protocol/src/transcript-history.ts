import { z } from 'zod';

import { WireEventSchema } from './events.js';
import { MessageIdSchema } from './ids.js';
import { MessageSchema } from './message.js';

// harn:assume historical-transcript-pages-budget-text-slots ref=transcript-history-text-slot-protocol
export const HISTORICAL_TRANSCRIPT_PAGE_SIZE = 20;
export const HISTORICAL_TRANSCRIPT_CACHE_SIZE = 40;

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
    kind: z.literal('settled_tail'),
    root_message_id: MessageIdSchema,
    output_message_id: MessageIdSchema,
    /** Empty only when synthesized from the finalized root summary. */
    event_indices: z.array(z.number().int().nonnegative()).max(1),
  }),
]);
export type TranscriptHistoryUnit = z.infer<typeof TranscriptHistoryUnitSchema>;

const evidenceFamilyKey = (
  unit: Exclude<TranscriptHistoryUnit, { kind: 'message' }>,
): string => `${String(unit.root_message_id)}:${String(unit.output_message_id)}`;

/** Indices that consume the user-facing history budget. Tool/timeline evidence
 * is free when its output family already has visible text; an otherwise
 * evidence-only family charges its final unit once so every cursor advances. */
export function transcriptHistoryTextSlotIndices(
  units: readonly TranscriptHistoryUnit[],
): number[] {
  const textFamilies = new Set<string>();
  for (const unit of units) {
    if (unit.kind === 'prose' || unit.kind === 'settled_tail') {
      textFamilies.add(evidenceFamilyKey(unit));
    }
  }
  const evidenceFallback = new Map<string, number>();
  const charged: number[] = [];
  units.forEach((unit, index) => {
    if (unit.kind === 'message' || unit.kind === 'prose' || unit.kind === 'settled_tail') {
      charged.push(index);
      return;
    }
    const family = evidenceFamilyKey(unit);
    if (!textFamilies.has(family)) evidenceFallback.set(family, index);
  });
  charged.push(...evidenceFallback.values());
  return charged.sort((left, right) => left - right);
}

export function transcriptHistoryTextSlotCount(
  units: readonly TranscriptHistoryUnit[],
): number {
  return transcriptHistoryTextSlotIndices(units).length;
}

/** Select the newest text-slot window and include the zero-cost evidence since
 * the immediately preceding charged boundary. This keeps the tools that lead
 * into the oldest selected text without pulling in the preceding text slot. */
export function newestTranscriptHistoryUnits(
  units: readonly TranscriptHistoryUnit[],
  limit: number,
): TranscriptHistoryUnit[] {
  if (limit <= 0 || units.length === 0) return [];
  const charged = transcriptHistoryTextSlotIndices(units);
  if (charged.length <= limit) return [...units];
  const chargedSet = new Set(charged);
  let start = charged[charged.length - limit]!;
  while (start > 0 && !chargedSet.has(start - 1)) start -= 1;
  return units.slice(start);
}

const TranscriptHistoryProjectionSchema = z.object({
  messages: z.array(MessageSchema),
  journals: z.array(TranscriptHistoryJournalSchema),
  units: z.array(TranscriptHistoryUnitSchema),
  before_cursor: TranscriptHistoryCursorSchema.nullable(),
  has_more: z.boolean(),
});

const validateTranscriptHistoryProjection = (
  page: z.infer<typeof TranscriptHistoryProjectionSchema>,
  context: z.RefinementCtx,
  maximumTextSlots: number,
): void => {
  if (transcriptHistoryTextSlotCount(page.units) > maximumTextSlots) {
    context.addIssue({
      code: 'custom',
      path: ['units'],
      message: `projection exceeds ${String(maximumTextSlots)} text slots`,
    });
  }
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
};

export const TranscriptHistoryPageSchema = TranscriptHistoryProjectionSchema.superRefine(
  (page, context) => validateTranscriptHistoryProjection(
    page,
    context,
    HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  ),
);
export type TranscriptHistoryPage = z.infer<typeof TranscriptHistoryPageSchema>;

/** Persisted browser cache projection. It uses the same complete-record and
 * journal-excerpt invariants as a network page, with a two-page text budget. */
export const TranscriptHistoryCacheWindowSchema = TranscriptHistoryProjectionSchema.superRefine(
  (page, context) => validateTranscriptHistoryProjection(
    page,
    context,
    HISTORICAL_TRANSCRIPT_CACHE_SIZE,
  ),
);
export type TranscriptHistoryCacheWindow = z.infer<typeof TranscriptHistoryCacheWindowSchema>;
// harn:end historical-transcript-pages-budget-text-slots
