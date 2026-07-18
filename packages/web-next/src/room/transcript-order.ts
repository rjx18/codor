import type { Message } from '@codor/protocol';

export function transcriptTime(message: Message): number {
  if (message.kind === 'run' && message.run?.status === 'running') {
    return Number.POSITIVE_INFINITY;
  }
  if (message.kind === 'run' && message.run?.status !== 'running') {
    return Date.parse(message.run?.ended_ts ?? message.ts);
  }
  return Date.parse(message.ts);
}

/** The first message id governed by durable continuation ordering. A page can
 * contain a continuation without its root, so the parent link also carries the
 * boundary forward without injecting the old root as a hydration outlier. */
export function continuationFloor(messages: readonly Message[]): number | undefined {
  const floors = messages.flatMap((message) => [
    ...(message.run?.output_mode === 'messages' ? [message.id] : []),
    ...(message.run_parent_id !== undefined ? [message.run_parent_id] : []),
  ]);
  return floors.length > 0 ? Math.min(...floors) : undefined;
}

function sortLegacyMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort((left, right) => {
    const leftRunning = left.kind === 'run' && left.run?.status === 'running';
    const rightRunning = right.kind === 'run' && right.run?.status === 'running';
    if (leftRunning !== rightRunning) return leftRunning ? 1 : -1;
    const byTime = leftRunning && rightRunning
      ? Date.parse(left.ts) - Date.parse(right.ts)
      : transcriptTime(left) - transcriptTime(right);
    return byTime === 0 ? left.id - right.id : byTime;
  });
}

export function transcriptMessages(messages: Record<number, Message>): Message[] {
  const all = Object.values(messages);
  const floor = continuationFloor(all);
  if (floor === undefined) return sortLegacyMessages(all);
  return [
    ...sortLegacyMessages(all.filter((message) => message.id < floor)),
    ...all.filter((message) => message.id >= floor).sort((left, right) => left.id - right.id),
  ];
}
