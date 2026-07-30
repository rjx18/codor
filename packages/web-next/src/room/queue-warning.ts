export const QUEUE_WARNING_DELAY_MS = 60_000;

export function queueWarningDue(
  unattemptedQueuedSince: string | undefined,
  nowMs: number,
): boolean {
  if (unattemptedQueuedSince === undefined) return false;
  const queuedAt = Date.parse(unattemptedQueuedSince);
  return Number.isFinite(queuedAt) && nowMs - queuedAt >= QUEUE_WARNING_DELAY_MS;
}

export function queueWarningDelay(
  unattemptedQueuedSince: string | undefined,
  nowMs: number,
): number | undefined {
  if (unattemptedQueuedSince === undefined) return undefined;
  const queuedAt = Date.parse(unattemptedQueuedSince);
  if (!Number.isFinite(queuedAt)) return undefined;
  return Math.max(0, queuedAt + QUEUE_WARNING_DELAY_MS - nowMs);
}
