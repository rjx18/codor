import type { Member, Schedule } from '@codor/protocol';
import { useMemo } from 'react';

export interface ScheduleCardProps {
  schedule: Schedule;
  viewer: Member | undefined;
  cancelPending?: boolean;
  /** Current selected-room socket generation has proved this room live. */
  cancelReady?: boolean;
  /** Exact correlated refusal for the most recent cancellation attempt. */
  cancelError?: string;
  onCancel?: (scheduleId: string) => void;
  /** Injected in tests; production uses the browser's local zone. */
  timeZone?: string;
}

const PREVIEW_LIMIT = 140;

export function scheduleTargetLabel(schedule: Schedule): string {
  return schedule.target.alias === undefined
    ? `@${schedule.target.handle}`
    : `~${schedule.target.alias}:@${schedule.target.handle}`;
}

export function scheduleStateLabel(state: Schedule['state']): string {
  return state[0]!.toUpperCase() + state.slice(1);
}

export function schedulePreview(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.length <= PREVIEW_LIMIT ? compact : `${compact.slice(0, PREVIEW_LIMIT - 1)}…`;
}

export function formatScheduleLocalTime(ts: string, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
    timeZoneName: undefined,
  });
  const dateTime = formatter.format(new Date(ts));
  const zone = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(ts))
    .find((part) => part.type === 'timeZoneName')?.value;
  return zone === undefined ? dateTime : `${dateTime} (${zone})`;
}

export function canCancelSchedule(
  schedule: Schedule,
  viewer: Member | undefined,
  cancelReady = true,
): boolean {
  if (!cancelReady || schedule.state !== 'pending' || viewer === undefined) return false;
  return viewer.id === schedule.author_id
    || (viewer.kind === 'human' && (viewer.role === 'owner' || viewer.role === 'admin'));
}

// harn:assume scheduled-cards-are-accessible-authoritative-and-nonduplicating ref=authoritative-schedule-card
export function ScheduleCard(props: ScheduleCardProps) {
  const { schedule, viewer } = props;
  const cancelReady = props.cancelReady !== false;
  const canCancel = canCancelSchedule(schedule, viewer, cancelReady);
  // Keep an authorized target visible while reconnecting so the operator can
  // understand the retained action; readiness disables it rather than hiding it.
  const canShowCancel = canCancelSchedule(schedule, viewer);
  const state = scheduleStateLabel(schedule.state);
  const localTime = useMemo(
    () => formatScheduleLocalTime(schedule.due_ts, props.timeZone),
    [props.timeZone, schedule.due_ts],
  );
  if (schedule.state === 'sent') return null;
  return (
    <article
      className={`nx-schedule-card is-${schedule.state}`}
      data-testid={`schedule-card-${schedule.id}`}
      aria-label={`Scheduled message ${state}`}
    >
      <div className="nx-schedule-card-head">
        <span className="nx-schedule-card-clock" aria-hidden="true">◷</span>
        <span className="nx-schedule-card-time">{localTime}</span>
        <span className="nx-schedule-card-state" role="status">{state}</span>
      </div>
      <div className="nx-schedule-card-target">Target {scheduleTargetLabel(schedule)}</div>
      <p className="nx-schedule-card-preview">{schedulePreview(schedule.body)}</p>
      {schedule.error !== undefined && <p className="nx-schedule-card-error" role="alert">{schedule.error}</p>}
      {props.cancelError !== undefined && props.cancelError !== schedule.error && (
        <p className="nx-schedule-card-error" role="alert" data-testid={`schedule-cancel-error-${schedule.id}`}>
          {props.cancelError}
        </p>
      )}
      {canShowCancel && (
        <button
          type="button"
          className="nx-btn nx-schedule-card-cancel"
          data-testid={`schedule-cancel-${schedule.id}`}
          aria-label={`Cancel scheduled message for ${scheduleTargetLabel(schedule)}`}
          disabled={!canCancel || props.cancelPending === true}
          onClick={() => props.onCancel?.(schedule.id)}
        >
          {props.cancelPending === true ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
    </article>
  );
}
// harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
