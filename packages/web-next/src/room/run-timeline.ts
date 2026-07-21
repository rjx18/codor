import type { CompactionTimelineItem, WireEvent } from '@codor/protocol';

import {
  presentRunEvents,
  type IndexedRunEvent,
  type RunRow,
} from '@runtime/run-presenter.js';

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

function runItemCallId(event: WireEvent): string | undefined {
  if (event.type !== 'run.item') return undefined;
  const payload = event.payload as { call_id?: unknown } | undefined;
  return typeof payload?.call_id === 'string' ? payload.call_id : undefined;
}

/** A tool_result presented as its own row is an orphan: matched results merge
 * into their call row and never surface separately. Segment-flushing at a
 * compaction boundary orphans a result whose call landed in an earlier
 * segment; this repairs the pair after the fact — the call row completes,
 * the orphan disappears — without giving up the boundary's prose split. */
function repairOrphanedToolResults(timeline: RunTimelineItem[]): RunTimelineItem[] {
  const callRows = new Map<string, number>();
  const repaired: RunTimelineItem[] = [];
  for (const entry of timeline) {
    if (entry.kind !== 'row') {
      repaired.push(entry);
      continue;
    }
    const { row } = entry;
    if (row.event.type === 'run.item' && row.event.item_type === 'tool_call') {
      const callId = runItemCallId(row.event);
      if (callId !== undefined) callRows.set(callId, repaired.length);
      repaired.push(entry);
      continue;
    }
    if (row.event.type === 'run.item' && row.event.item_type === 'tool_result') {
      const callId = runItemCallId(row.event);
      const callIndex = callId === undefined ? undefined : callRows.get(callId);
      const call = callIndex === undefined ? undefined : repaired[callIndex];
      if (call?.kind === 'row' && call.row.status === 'running') {
        repaired[callIndex!] = {
          kind: 'row',
          row: {
            ...call.row,
            resultEventIndex: row.eventIndex,
            status: row.status,
            duration_ms: row.duration_ms,
            output_text: row.output_text,
            diff: row.diff,
            image: row.image,
          },
        };
        continue; // orphan consumed by its call row
      }
    }
    repaired.push(entry);
  }
  return repaired;
}

/** Interleave compaction boundaries with the existing prose/tool presenter.
 * Flushing evidence at each boundary keeps journal order and splits prose
 * around the divider; the orphan-repair pass then restores tool call/result
 * pairing that the segment split would otherwise break. */
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
  return repairOrphanedToolResults(timeline);
}
// harn:end web-compaction-markers-upgrade-in-place
