import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_TRANSCRIPT_CACHE_SIZE,
  HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  newestTranscriptHistoryUnits,
  transcriptHistoryTextSlotCount,
  TranscriptHistoryCacheWindowSchema,
  TranscriptHistoryPageSchema,
} from './index.js';

const message = (id: number) => ({
  id,
  room: 'eng',
  author: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  kind: 'run' as const,
  body: '',
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: '2026-08-08T00:00:00.000Z',
  seq: id,
});

const validPage = () => ({
  messages: [message(7)],
  journals: [{
    root_message_id: 7,
    events: [
      {
        index: 3,
        event: {
          type: 'run.item',
          item_type: 'text_delta',
          payload: { text: 'hello' },
          output_message_id: 7,
          ts: '2026-08-08T00:00:01.000Z',
        },
      },
      {
        index: 4,
        event: {
          type: 'run.completed',
          status: 'completed',
          output_message_id: 7,
        },
      },
    ],
  }],
  units: [
    {
      kind: 'prose',
      root_message_id: 7,
      output_message_id: 7,
      event_indices: [3],
    },
    {
      kind: 'settled_tail',
      root_message_id: 7,
      output_message_id: 7,
      event_indices: [4],
    },
  ],
  before_cursor: 'opaque-cursor',
  has_more: true,
});

// harn:assume historical-transcript-pages-budget-text-slots ref=transcript-history-text-slot-regression
describe('TranscriptHistoryPageSchema', () => {
  it('exports a complete indexed transcript page contract', () => {
    expect(HISTORICAL_TRANSCRIPT_PAGE_SIZE).toBe(20);
    expect(HISTORICAL_TRANSCRIPT_CACHE_SIZE).toBe(40);
    expect(TranscriptHistoryPageSchema.parse(validPage())).toEqual(validPage());
  });

  it('validates the same complete projection at a forty-slot cache bound', () => {
    const messages = Array.from({ length: 40 }, (_, index) => message(index + 1));
    const projection = {
      messages,
      journals: [],
      units: messages.map((entry) => ({ kind: 'message' as const, message_id: entry.id })),
      before_cursor: 'older',
      has_more: true,
    };
    expect(TranscriptHistoryPageSchema.safeParse(projection).success).toBe(false);
    expect(TranscriptHistoryCacheWindowSchema.safeParse(projection).success).toBe(true);
  });

  it('rejects partial message records and more than twenty text slots', () => {
    const page = validPage();
    expect(TranscriptHistoryPageSchema.safeParse({
      ...page,
      messages: [{ id: 7, room: 'eng' }],
    }).success).toBe(false);

    expect(TranscriptHistoryPageSchema.safeParse({
      ...page,
      messages: Array.from({ length: 21 }, (_, index) => message(index + 1)),
      journals: [],
      units: Array.from({ length: 21 }, (_, index) => ({
        kind: 'message',
        message_id: index + 1,
      })),
    }).success).toBe(false);
  });

  it('admits more than twenty raw units when only twenty text slots are charged', () => {
    const page = validPage();
    const tools = Array.from({ length: 50 }, (_, index) => ({
      kind: 'tool' as const,
      root_message_id: 7,
      output_message_id: 7,
      event_indices: [index + 10],
    }));
    const events = tools.map((unit) => ({
      index: unit.event_indices[0]!,
      event: {
        type: 'run.item' as const,
        item_type: 'tool_call' as const,
        output_message_id: 7,
        payload: { call_id: `call-${String(unit.event_indices[0])}`, tool: 'Read', title: 'read' },
      },
    }));
    const candidate = {
      ...page,
      journals: [{ root_message_id: 7, events: [...events, ...page.journals[0]!.events] }],
      units: [...tools, ...page.units],
    };
    expect(transcriptHistoryTextSlotCount(candidate.units)).toBe(2);
    expect(TranscriptHistoryPageSchema.safeParse(candidate).success).toBe(true);
    expect(TranscriptHistoryCacheWindowSchema.safeParse(candidate).success).toBe(true);
  });

  it('trims by text slots while retaining evidence leading into the oldest slot', () => {
    const units = [
      { kind: 'message' as const, message_id: 1 },
      { kind: 'tool' as const, root_message_id: 7, output_message_id: 7, event_indices: [1] },
      { kind: 'prose' as const, root_message_id: 7, output_message_id: 7, event_indices: [2] },
      { kind: 'message' as const, message_id: 2 },
    ];
    expect(newestTranscriptHistoryUnits(units, 2)).toEqual(units.slice(1));
  });

  it('rejects invalid or unreferenced journal indices and unknown unit kinds', () => {
    const page = validPage();
    expect(TranscriptHistoryPageSchema.safeParse({
      ...page,
      journals: [{
        ...page.journals[0],
        events: [{ ...page.journals[0]!.events[0], index: -1 }],
      }],
    }).success).toBe(false);

    expect(TranscriptHistoryPageSchema.safeParse({
      ...page,
      units: [{ ...page.units[0], event_indices: [99] }],
    }).success).toBe(false);

    expect(TranscriptHistoryPageSchema.safeParse({
      ...page,
      units: [{ kind: 'video', message_id: 7 }],
    }).success).toBe(false);
  });
});
// harn:end historical-transcript-pages-budget-text-slots
