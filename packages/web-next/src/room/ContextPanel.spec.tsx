import type { TranscriptHistoryIndexedEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { previewImagesFromEvidence } from './ContextPanel.js';

describe('combined-history preview evidence', () => {
  it('projects embedded images from indexed excerpts onto their permanent output row', () => {
    const events: TranscriptHistoryIndexedEvent[] = [{
      index: 7,
      event: {
        type: 'run.item',
        item_type: 'tool_result',
        output_message_id: 12,
        payload: {
          call_id: 'image-result',
          status: 'ok',
          image: { media_type: 'image/svg+xml', data_b64: 'PHN2Zy8+' },
        },
      },
    }];

    expect(previewImagesFromEvidence([{ rootId: 10, events }])).toEqual([{
      msgId: 12,
      media_type: 'image/svg+xml',
      data_b64: 'PHN2Zy8+',
    }]);
  });
});
