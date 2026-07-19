import type { WireEvent } from '@codor/protocol';

type TargetableEvent = Extract<WireEvent,
  { type: 'run.item' | 'timeline' | 'run.completed' }>;

export interface ContinuationAllocation {
  id: number;
  created: boolean;
}

export interface ContinuationProjection {
  resultMessageId: number;
  bodies: Map<number, string>;
  referencedMessageIds: Set<number>;
  substantiveMessageIds: Set<number>;
}

function targetOf(event: WireEvent): number | undefined {
  return event.type === 'run.item'
    || event.type === 'timeline'
    || event.type === 'run.completed'
    ? event.output_message_id
    : undefined;
}

function callId(event: Extract<WireEvent, { type: 'run.item' }>): string | undefined {
  if (event.item_type !== 'tool_call' && event.item_type !== 'tool_result') return undefined;
  const payload = event.payload as { call_id?: unknown };
  return typeof payload.call_id === 'string' ? payload.call_id : undefined;
}

function textOf(event: Extract<WireEvent, { type: 'run.item' }>): string {
  if (event.item_type !== 'text_delta') return '';
  const payload = event.payload as { text?: unknown };
  return typeof payload.text === 'string' ? payload.text : '';
}

function completionResidual(finalText: string | undefined, streamed: string): string {
  if (finalText === undefined || finalText.length === 0) return '';
  if (streamed.length === 0) return finalText;
  if (finalText.startsWith(streamed)) return finalText.slice(streamed.length);
  // Several harnesses stream interim narration and then repeat only the final
  // answer as `final_text`. That suffix is already durable journal prose; adding
  // it again would create a third block and duplicate the visible reply.
  if (streamed.endsWith(finalText)) return '';
  return finalText;
}

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-segmentation-engine
/**
 * Assigns normalized run events to permanent output messages. The Store-owned
 * allocator is called only when a visible event follows a newer durable room
 * message. Its returned row therefore exists before the caller journals or
 * broadcasts the id.
 */
export class ContinuationWriter {
  private currentOutputId: number;
  private readonly toolOutputs = new Map<string, number>();
  private readonly pendingCompactions: number[] = [];
  private streamedText = '';

  constructor(
    readonly rootMessageId: number,
    journal: readonly WireEvent[] = [],
  ) {
    this.currentOutputId = rootMessageId;
    for (const event of journal) this.observe(event);
  }

  assign(
    event: WireEvent,
    latestMessageId: number,
    allocate: () => number,
  ): { event: WireEvent; allocation?: ContinuationAllocation } {
    if (event.type !== 'run.item' && event.type !== 'timeline' && event.type !== 'run.completed') {
      return { event };
    }
    if (event.output_message_id !== undefined) {
      this.observe(event);
      return { event };
    }

    let outputId = this.currentOutputId;
    let created = false;
    const allocateAfterInterleave = (): void => {
      if (latestMessageId <= this.currentOutputId) return;
      outputId = allocate();
      this.currentOutputId = outputId;
      created = true;
    };

    if (event.type === 'run.item') {
      const id = callId(event);
      if (event.item_type === 'tool_result') {
        outputId = id === undefined ? this.currentOutputId : (this.toolOutputs.get(id) ?? this.currentOutputId);
      } else if (event.item_type === 'reasoning_summary') {
        outputId = this.currentOutputId;
      } else {
        allocateAfterInterleave();
        outputId = this.currentOutputId;
      }
    } else if (event.type === 'timeline') {
      if (event.item.status === 'completed') {
        outputId = this.pendingCompactions.shift() ?? this.currentOutputId;
      } else {
        allocateAfterInterleave();
        outputId = this.currentOutputId;
      }
    } else {
      if (
        event.status !== 'failed'
        && completionResidual(event.final_text, this.streamedText).length > 0
      ) {
        allocateAfterInterleave();
      }
      outputId = this.currentOutputId;
    }

    const assigned = { ...event, output_message_id: outputId } as TargetableEvent;
    this.observe(assigned);
    return {
      event: assigned,
      ...(created ? { allocation: { id: outputId, created: true } } : {}),
    };
  }

  private observe(event: WireEvent): void {
    const target = targetOf(event) ?? this.rootMessageId;
    if (event.type === 'run.item') {
      const id = callId(event);
      if (event.item_type === 'tool_call' && id !== undefined) this.toolOutputs.set(id, target);
      if (event.item_type === 'text_delta') this.streamedText += textOf(event);
      if (event.item_type !== 'tool_result' && event.item_type !== 'reasoning_summary') {
        this.currentOutputId = target;
      }
      return;
    }
    if (event.type === 'timeline') {
      if (event.item.status === 'loading') {
        this.pendingCompactions.push(target);
        this.currentOutputId = target;
      } else {
        const index = this.pendingCompactions.indexOf(target);
        if (index >= 0) this.pendingCompactions.splice(index, 1);
      }
      return;
    }
    if (event.type === 'run.completed') this.currentOutputId = target;
  }
}

/** Rebuild the exact per-row prose and terminal identity from one root journal. */
export function projectContinuationOutputs(
  rootMessageId: number,
  events: readonly WireEvent[],
): ContinuationProjection {
  const bodies = new Map<number, string>([[rootMessageId, '']]);
  const referencedMessageIds = new Set<number>([rootMessageId]);
  const substantiveMessageIds = new Set<number>();
  let streamed = '';
  let resultMessageId = rootMessageId;

  for (const event of events) {
    if (event.type !== 'run.item' && event.type !== 'timeline' && event.type !== 'run.completed') continue;
    const target = event.output_message_id ?? rootMessageId;
    referencedMessageIds.add(target);
    if (!bodies.has(target)) bodies.set(target, '');
    resultMessageId = target;

    if (event.type === 'run.item') {
      const text = textOf(event);
      if (text.length > 0) {
        bodies.set(target, (bodies.get(target) ?? '') + text);
        streamed += text;
        substantiveMessageIds.add(target);
      } else if (event.item_type !== 'reasoning_summary') {
        substantiveMessageIds.add(target);
      }
      continue;
    }
    if (event.type === 'timeline') {
      substantiveMessageIds.add(target);
      continue;
    }

    const residual = event.status === 'failed'
      ? ''
      : completionResidual(event.final_text, streamed);
    if (residual.length > 0) {
      bodies.set(target, (bodies.get(target) ?? '') + residual);
      substantiveMessageIds.add(target);
    }
  }

  return { resultMessageId, bodies, referencedMessageIds, substantiveMessageIds };
}
// harn:end continuation-writer-follows-journaled-output-ownership
