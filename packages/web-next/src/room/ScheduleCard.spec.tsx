// @vitest-environment happy-dom
import type { Member, Schedule } from '@codor/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ScheduleCard,
  canCancelSchedule,
  formatScheduleLocalTime,
  schedulePreview,
  scheduleTargetLabel,
} from './ScheduleCard.js';

const viewer = (role: Member['role'], kind: Member['kind'] = 'human', id = 'human'): Member => ({
  id, kind, handle: 'richard', display_name: 'Richard', role,
} as Member);

const schedule = (state: Schedule['state'] = 'pending'): Schedule => ({
  id: state, room: 'eng', author_id: 'human', author_handle: 'richard',
  target: { member_id: 'agent', conversation_id: 'eng', handle: 'reviewer' },
  body: 'A scheduled message preview', mentions: [{ member_id: 'agent', start: 0, end: 9 }],
  due_ts: '2026-08-12T20:30:00.000Z', host_offset_minutes: 480, state,
  created_ts: '2026-08-12T12:00:00.000Z', updated_ts: '2026-08-12T12:00:00.000Z',
});

// harn:assume scheduled-cards-are-accessible-authoritative-and-nonduplicating ref=authoritative-schedule-card-regression
describe('authoritative scheduled cards', () => {
  it('shows deterministic target, local time, bounded preview, state, and one cancel target', () => {
    const markup = renderToStaticMarkup(<ScheduleCard schedule={schedule()} viewer={viewer('owner')} timeZone="Asia/Singapore" />);
    expect(markup).toContain('data-testid="schedule-card-pending"');
    expect(markup).toContain('Target @reviewer');
    expect(markup).toContain('>Pending<');
    expect(markup).toContain('data-testid="schedule-cancel-pending"');
  });

  it('hides sent schedules and applies author/role authorization to pending cards', () => {
    expect(renderToStaticMarkup(<ScheduleCard schedule={schedule('sent')} viewer={viewer('owner')} />)).toBe('');
    expect(renderToStaticMarkup(<ScheduleCard schedule={schedule()} viewer={viewer('member', 'human', 'other')} />)).not.toContain('schedule-cancel-pending');
    expect(renderToStaticMarkup(<ScheduleCard schedule={schedule()} viewer={viewer('observer', 'human', 'observer')} />)).not.toContain('schedule-cancel-pending');
    expect(renderToStaticMarkup(<ScheduleCard schedule={schedule()} viewer={viewer('admin')} />)).toContain('schedule-cancel-pending');
    expect(renderToStaticMarkup(<ScheduleCard schedule={{ ...schedule(), author_id: 'agent' }} viewer={viewer(undefined, 'agent', 'agent')} />)).toContain('schedule-cancel-pending');
  });

  it.each(['pending', 'sending', 'failed', 'cancelled'] as const)('renders the authoritative %s state and error', (state) => {
    const markup = renderToStaticMarkup(
      <ScheduleCard schedule={{ ...schedule(state), error: state === 'failed' ? 'delivery refused' : undefined }} viewer={viewer('owner')} />,
    );
    expect(markup).toContain(`data-testid="schedule-card-${state}"`);
    expect(markup).toContain(`>${state[0]!.toUpperCase()}${state.slice(1)}<`);
    if (state === 'failed') expect(markup).toContain('delivery refused');
  });

  it('disables the one cancel target while awaiting its authoritative result', () => {
    const markup = renderToStaticMarkup(
      <ScheduleCard schedule={schedule()} viewer={viewer('owner')} cancelPending />,
    );
    expect(markup).toContain('data-testid="schedule-cancel-pending"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Cancelling…');
  });

  it('supports qualified labels, bounded prose, and named local zones', () => {
    const qualified = { ...schedule(), target: { ...schedule().target, alias: 'review' } };
    expect(scheduleTargetLabel(qualified)).toBe('~review:@reviewer');
    expect(schedulePreview('x '.repeat(200)).length).toBeLessThanOrEqual(140);
    expect(formatScheduleLocalTime(schedule().due_ts, 'Asia/Singapore')).toContain('GMT+8');
  });
});
// harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
