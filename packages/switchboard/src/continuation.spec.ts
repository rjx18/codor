import type { WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { ContinuationWriter, projectContinuationOutputs } from './continuation.js';

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-segmentation-regression
describe('continuation output assignment', () => {
  it('allocates only after an interleaving message and preserves tool and compaction batches', () => {
    const writer = new ContinuationWriter(1);
    let next = 3;
    const assigned: WireEvent[] = [];
    const land = (event: WireEvent, latest: number): WireEvent => {
      const result = writer.assign(event, latest, () => next++);
      assigned.push(result.event);
      return result.event;
    };

    expect(land({
      type: 'run.item', item_type: 'text_delta', payload: { text: 'first' },
    }, 1)).toHaveProperty('output_message_id', 1);
    expect(land({
      type: 'run.item', item_type: 'tool_call',
      payload: { call_id: 'call-1', tool: 'shell', title: 'Run' },
    }, 2)).toHaveProperty('output_message_id', 3);
    expect(land({
      type: 'run.item', item_type: 'reasoning_summary', payload: { text: 'thinking' },
    }, 3)).toHaveProperty('output_message_id', 3);
    expect(land({
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'call-1', status: 'ok', output_text: 'done' },
    }, 4)).toHaveProperty('output_message_id', 3);
    expect(land({
      type: 'timeline', item: { type: 'compaction', status: 'loading' },
    }, 4)).toHaveProperty('output_message_id', 4);
    expect(land({
      type: 'timeline', item: { type: 'compaction', status: 'completed' },
    }, 5)).toHaveProperty('output_message_id', 4);
    expect(land({
      type: 'run.completed', status: 'completed', final_text: 'firstlast' },
    5)).toHaveProperty('output_message_id', 5);
    expect(next).toBe(6);

    const projection = projectContinuationOutputs(1, assigned);
    expect([...projection.bodies]).toEqual([[1, 'first'], [3, ''], [4, ''], [5, 'last']]);
    expect(projection.resultMessageId).toBe(5);
    expect([...projection.substantiveMessageIds]).toEqual([1, 3, 4, 5]);
  });

  it('replays assigned ids exactly and never turns failed final_text diagnostics into prose', () => {
    const journal: WireEvent[] = [
      {
        type: 'run.item', item_type: 'text_delta', payload: { text: 'partial' },
        output_message_id: 1,
      },
      {
        type: 'run.completed', status: 'failed',
        final_text: 'Prompt is too long', output_message_id: 1,
      },
    ];
    const writer = new ContinuationWriter(1, journal);
    let allocations = 0;
    const replayed = writer.assign(journal[1]!, 99, () => {
      allocations++;
      return 100;
    });
    expect(replayed.event).toEqual(journal[1]);
    expect(allocations).toBe(0);
    expect(projectContinuationOutputs(1, journal)).toMatchObject({
      resultMessageId: 1,
      bodies: new Map([[1, 'partial']]),
    });
  });

  it('does not duplicate a final_text suffix already streamed after interim narration', () => {
    const writer = new ContinuationWriter(1);
    let allocations = 0;
    const events = [
      writer.assign({
        type: 'run.item', item_type: 'text_delta', payload: { text: 'checking first. ' },
      }, 1, () => ++allocations).event,
      writer.assign({
        type: 'run.item', item_type: 'text_delta', payload: { text: 'final answer' },
      }, 1, () => ++allocations).event,
      writer.assign({
        type: 'run.completed', status: 'completed', final_text: 'final answer',
      }, 2, () => ++allocations).event,
    ];

    expect(allocations).toBe(0);
    expect(projectContinuationOutputs(1, events)).toMatchObject({
      resultMessageId: 1,
      bodies: new Map([[1, 'checking first. final answer']]),
    });
  });

  // harn:assume explicit-prose-boundaries-survive-transcript-lifecycle ref=continuation-prose-boundary-regression
  it('projects mixed deltas and complete blocks without losing ownership or final text', () => {
    const writer = new ContinuationWriter(1);
    const journal: WireEvent[] = [
      writer.assign({
        type: 'run.item', item_type: 'text_delta', payload: { text: 'A' },
      }, 1, () => 99).event,
      writer.assign({
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'other', tool: 'Read', title: 'other output' },
      }, 2, () => 2).event,
      writer.assign({
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: 'other', status: 'ok', output_text: 'done' },
      }, 2, () => 99).event,
      writer.assign({
        type: 'run.item', item_type: 'text_delta', output_message_id: 1,
        payload: { text: 'B' },
      }, 2, () => 99).event,
      writer.assign({
        type: 'run.item', item_type: 'text_block', output_message_id: 1,
        payload: { text: 'Block one' },
      }, 2, () => 99).event,
      writer.assign({
        type: 'run.item', item_type: 'text_delta', output_message_id: 1,
        payload: { text: 'C' },
      }, 2, () => 99).event,
      writer.assign({
        type: 'run.item', item_type: 'text_block', output_message_id: 1,
        payload: { text: 'Block two' },
      }, 2, () => 99).event,
      writer.assign({
        type: 'run.completed', status: 'completed',
        final_text: 'AB\n\nBlock one\n\nC\n\nBlock two', output_message_id: 1,
      }, 2, () => 99).event,
    ];

    expect(journal.map((event) => event.output_message_id)).toEqual([
      1, 2, 2, 1, 1, 1, 1, 1,
    ]);
    expect(projectContinuationOutputs(1, journal).bodies).toEqual(new Map([
      [1, 'AB\n\nBlock one\n\nC\n\nBlock two'],
      [2, ''],
    ]));
  });

  it('counts a complete block as streamed prose for terminal allocation and residuals', () => {
    const writer = new ContinuationWriter(1);
    const block = writer.assign({
      type: 'run.item', item_type: 'text_block', payload: { text: 'Block' },
    }, 1, () => 2);
    expect(block.event.output_message_id).toBe(1);
    const completed = writer.assign({
      type: 'run.completed', status: 'completed', final_text: 'Block',
    }, 2, () => 3);
    expect(completed.allocation).toBeUndefined();
    expect(completed.event.output_message_id).toBe(1);
    const residual = projectContinuationOutputs(1, [
      block.event,
      { ...completed.event, final_text: 'Block\n\nTail', output_message_id: 1 },
    ]);
    expect(residual.bodies).toEqual(new Map([[1, 'Block\n\nTail']]));
  });
  // harn:end explicit-prose-boundaries-survive-transcript-lifecycle
});
// harn:end continuation-writer-follows-journaled-output-ownership
