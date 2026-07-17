import type { WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  presentRunTimeline,
  reduceTimelineCompaction,
  type RunTimelineItem,
} from './run-timeline.js';

const indexed = (events: WireEvent[]) => events.map((event, index) => ({ event, index }));

// harn:assume web-compaction-markers-upgrade-in-place ref=web-compaction-timeline-regression
describe('compaction timeline reducer', () => {
  it('upgrades loading to completed in place without disturbing surrounding prose', () => {
    const timeline = presentRunTimeline(indexed([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'Before.' } },
      { type: 'timeline', item: { type: 'compaction', status: 'loading' } },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'During ' } },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'compaction.' } },
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'completed', trigger: 'manual', preTokens: 149_900 },
      },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'After.' } },
    ]));

    expect(timeline).toHaveLength(4);
    expect(timeline[0]).toMatchObject({ kind: 'row', row: { text: 'Before.' } });
    expect(timeline[1]).toEqual({
      kind: 'compaction',
      id: 'compaction-1',
      eventIndex: 1,
      type: 'compaction',
      status: 'completed',
      trigger: 'manual',
      preTokens: 149_900,
    });
    expect(timeline[2]).toMatchObject({ kind: 'row', row: { text: 'During compaction.' } });
    expect(timeline[3]).toMatchObject({ kind: 'row', row: { text: 'After.' } });
  });

  it('pairs a tool result with its call across a compaction boundary', () => {
    const timeline = presentRunTimeline(indexed([
      {
        type: 'run.item',
        item_type: 'tool_call',
        payload: { call_id: 'call-1', tool: 'Bash', title: 'run tests', input: {} },
      },
      { type: 'timeline', item: { type: 'compaction', status: 'loading' } },
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 150_000 },
      },
      {
        type: 'run.item',
        item_type: 'tool_result',
        payload: { call_id: 'call-1', status: 'ok', output_text: '42 passed' },
      },
    ]));

    const rows = timeline.filter((entry) => entry.kind === 'row');
    expect(rows).toHaveLength(1); // the orphan merged into its call row
    expect(rows[0]).toMatchObject({
      row: { kind: 'tool', title: 'Bash', status: 'ok', output_text: '42 passed' },
    });
    expect(timeline.filter((entry) => entry.kind === 'compaction')).toHaveLength(1);
  });

  it('appends a completed marker when no loading item exists', () => {
    expect(presentRunTimeline(indexed([{
      type: 'timeline',
      item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 80_000 },
    }]))).toEqual([{
      kind: 'compaction',
      id: 'compaction-0',
      eventIndex: 0,
      type: 'compaction',
      status: 'completed',
      trigger: 'auto',
      preTokens: 80_000,
    }]);
  });

  it('preserves loading metadata when completion omits it', () => {
    const loading: RunTimelineItem[] = [{
      kind: 'compaction',
      id: 'compaction-4',
      eventIndex: 4,
      type: 'compaction',
      status: 'loading',
      trigger: 'manual',
      preTokens: 12_000,
    }];
    expect(reduceTimelineCompaction(
      loading,
      { type: 'compaction', status: 'completed' },
      8,
    )).toEqual([{
      ...loading[0],
      status: 'completed',
    }]);
  });
});
// harn:end web-compaction-markers-upgrade-in-place
