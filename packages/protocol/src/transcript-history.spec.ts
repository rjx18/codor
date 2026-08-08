import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_TRANSCRIPT_PAGE_SIZE,
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

// harn:assume historical-transcript-pages-match-output-scoped-rendering ref=transcript-history-protocol
describe('TranscriptHistoryPageSchema', () => {
  it('exports a complete indexed transcript page contract', () => {
    expect(HISTORICAL_TRANSCRIPT_PAGE_SIZE).toBe(20);
    expect(TranscriptHistoryPageSchema.parse(validPage())).toEqual(validPage());
  });

  it('rejects partial message records and more than twenty visible units', () => {
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
// harn:end historical-transcript-pages-match-output-scoped-rendering
