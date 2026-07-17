import { LoaderCircle, Scissors } from 'lucide-react';

export interface CompactionMarkerProps {
  status: 'loading' | 'completed';
  trigger?: 'auto' | 'manual';
  preTokens?: number;
}

export function compactionMarkerLabel({
  status,
  trigger,
  preTokens,
}: CompactionMarkerProps): string {
  if (status === 'loading') return 'Compacting…';
  if (trigger === 'auto') return 'Context automatically compacted';
  if (trigger === 'manual') return 'Context manually compacted';
  if (preTokens) return `Context compacted (${String(Math.round(preTokens / 1_000))}K tokens)`;
  return 'Context compacted';
}

// harn:assume web-compaction-markers-upgrade-in-place ref=web-compaction-marker-component
/** Quiet line-label-line context boundary, matching Paseo's CompactionMarker. */
export function CompactionMarker(props: CompactionMarkerProps) {
  const label = compactionMarkerLabel(props);
  return (
    <div
      className={`nx-compaction is-${props.status}`}
      role="separator"
      aria-label={label}
      title={label}
      data-testid="compaction-marker"
      data-status={props.status}
      data-trigger={props.trigger}
      data-pre-tokens={props.preTokens}
    >
      <span className="nx-compaction-line" aria-hidden="true" />
      <span className="nx-compaction-label" aria-hidden="true">
        {props.status === 'loading'
          ? <LoaderCircle className="nx-spin" size={13} />
          : <Scissors size={13} />}
        <span>{label}</span>
      </span>
      <span className="nx-compaction-line" aria-hidden="true" />
    </div>
  );
}
// harn:end web-compaction-markers-upgrade-in-place
