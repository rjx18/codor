import { memo } from 'react';

import type { AgentUsage } from '@codor/protocol';

interface ContextWindowMeterProps {
  usage: AgentUsage | undefined;
  pending?: boolean;
  testId?: string;
}

type MeterTone = 'normal' | 'amber' | 'red';

function usagePercentage(usage: AgentUsage | undefined): number | undefined {
  const maxTokens = usage?.contextWindowMaxTokens;
  const usedTokens = usage?.contextWindowUsedTokens;
  if (
    maxTokens === undefined ||
    usedTokens === undefined ||
    !Number.isFinite(maxTokens) ||
    !Number.isFinite(usedTokens) ||
    maxTokens <= 0 ||
    usedTokens < 0
  ) {
    return undefined;
  }
  return (usedTokens / maxTokens) * 100;
}

function meterTone(percentage: number): MeterTone {
  if (percentage > 90) return 'red';
  if (percentage >= 70) return 'amber';
  return 'normal';
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}

function formatSessionCost(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function ring(trackOnly: boolean, percentage = 0) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="nx-context-meter-track" cx="7" cy="7" r="6" fill="none" />
      {!trackOnly && (
        <circle
          className="nx-context-meter-progress"
          cx="7"
          cy="7"
          r="6"
          fill="none"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - percentage}
        />
      )}
    </svg>
  );
}

// harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-component
/** Compact member-card context pressure derived entirely from transient usage. */
/**
 * Memoized: usage frames for ONE member must not re-render and re-animate
 * every sibling card's ring (the members map is replaced per frame).
 */
export const ContextWindowMeter = memo(function ContextWindowMeter(
  { usage, pending = false, testId }: ContextWindowMeterProps,
) {
  const percentage = usagePercentage(usage);
  if (percentage === undefined) {
    if (!pending) return null;
    return (
      <span
        className="nx-context-meter is-pending"
        data-testid={testId}
        aria-hidden="true"
      >
        {ring(true)}
      </span>
    );
  }

  const clampedPercentage = Math.max(0, Math.min(100, percentage));
  const roundedPercentage = Math.round(percentage);
  const usedTokens = usage?.contextWindowUsedTokens ?? 0;
  const maxTokens = usage?.contextWindowMaxTokens ?? 0;
  const cost = formatSessionCost(usage?.totalCostUsd);
  const tooltip = [
    `Context window · ${roundedPercentage}% used`,
    `${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens`,
    ...(cost === undefined ? [] : [`Session cost: ${cost}`]),
  ].join(' · ');

  return (
    <span
      className={`nx-context-meter is-${meterTone(clampedPercentage)}`}
      role="img"
      aria-label={tooltip}
      title={tooltip}
      data-testid={testId}
      data-percentage={roundedPercentage}
    >
      {ring(false, clampedPercentage)}
    </span>
  );
});
// harn:end member-context-window-meter-derived-from-last-usage
