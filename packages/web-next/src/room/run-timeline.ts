import type { CompactionTimelineItem } from '@codor/protocol';

import {
  presentRunEvents,
  type IndexedRunEvent,
  type RunRow,
} from '@legacy/run-presenter.js';

export interface CompactionRunTimelineItem extends CompactionTimelineItem {
  kind: 'compaction';
  id: string;
  eventIndex: number;
}

export type RunTimelineItem =
  | { kind: 'row'; row: RunRow }
  | CompactionRunTimelineItem;

// harn:assume web-compaction-markers-upgrade-in-place ref=web-compaction-timeline-reducer
/** Paseo-compatible compaction reducer: completion replaces the first pending
 * marker without moving it, so one native boundary renders as one divider. */
export function reduceTimelineCompaction(
  state: RunTimelineItem[],
  item: CompactionTimelineItem,
  eventIndex: number,
): RunTimelineItem[] {
  if (item.status === 'completed') {
    const loadingIndex = state.findIndex(
      (entry) => entry.kind === 'compaction' && entry.status === 'loading',
    );
    const existing = loadingIndex >= 0 ? state[loadingIndex] : undefined;
    if (existing?.kind === 'compaction') {
      const updated: CompactionRunTimelineItem = {
        ...existing,
        status: 'completed',
        trigger: item.trigger ?? existing.trigger,
        preTokens: item.preTokens ?? existing.preTokens,
      };
      return [
        ...state.slice(0, loadingIndex),
        updated,
        ...state.slice(loadingIndex + 1),
      ];
    }
  }

  return [
    ...state,
    {
      kind: 'compaction',
      id: `compaction-${String(eventIndex)}`,
      eventIndex,
      ...item,
    },
  ];
}

/** Interleave compaction boundaries with the existing prose/tool presenter.
 * Flushing evidence at each boundary keeps its journal order while allowing a
 * later completed item to upgrade an earlier loading marker in place. */
export function presentRunTimeline(events: readonly IndexedRunEvent[]): RunTimelineItem[] {
  let timeline: RunTimelineItem[] = [];
  let evidence: IndexedRunEvent[] = [];
  const flushEvidence = (): void => {
    if (evidence.length === 0) return;
    timeline = [
      ...timeline,
      ...presentRunEvents(evidence).map((row): RunTimelineItem => ({ kind: 'row', row })),
    ];
    evidence = [];
  };

  for (const indexed of events) {
    if (indexed.event.type === 'timeline' && indexed.event.item.type === 'compaction') {
      flushEvidence();
      timeline = reduceTimelineCompaction(timeline, indexed.event.item, indexed.index);
    } else if (indexed.event.type === 'run.item') {
      evidence.push(indexed);
    }
  }
  flushEvidence();
  return timeline;
}
// harn:end web-compaction-markers-upgrade-in-place
