// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ComputerSessionView } from '../app/computer-sessions.js';

import { computerActionableCount, computerStatus, ComputerChoice } from './ComputerChoice.js';

const computer = (overrides: Partial<ComputerSessionView> = {}): ComputerSessionView => ({
  id: 'A',
  label: 'Desk',
  active: false,
  ready: true,
  connected: false,
  authRefused: false,
  unread: 0,
  attention: false,
  working: 0,
  ...overrides,
});

describe('ComputerChoice status and activity presentation', () => {
  it('prioritizes an explicit auth refusal over the transport flag', () => {
    expect(computerStatus(computer({ connected: true, authRefused: true }))).toEqual({
      label: 'Repair required',
      tone: 'repair',
    });
    expect(computerStatus(computer({ connected: true }))).toEqual({ label: 'Connected', tone: 'connected' });
    expect(computerStatus(computer({ connected: false }))).toEqual({ label: 'Reconnecting', tone: 'reconnecting' });
  });

  it('aggregates only actionable activity on inactive computers', () => {
    expect(computerActionableCount([
      computer({ active: true, unread: 9, attention: true, working: 4 }),
      computer({ id: 'B', unread: 2, attention: true, working: 3 }),
      computer({ id: 'C', unread: 0, attention: false, working: 0 }),
    ])).toBe(6);
  });

  it('renders honest state and all available activity details in one accessible choice', () => {
    const html = renderToStaticMarkup(
      <ComputerChoice
        computer={computer({ authRefused: true, unread: 3, attention: true, working: 2 })}
        testid="choice"
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('Repair required');
    expect(html).toContain('3 unread');
    expect(html).toContain('Needs attention');
    expect(html).toContain('2 working');
    expect(html).toContain('aria-label="Desk, Repair required, 3 unread, Needs attention, 2 working"');
    expect(html).toContain('data-testid="computer-connection-A"');
  });

  // harn:assume hosted-computer-avatar-badges-are-actionable ref=avatar-badge-regression
  // harn:assume hosted-computer-hostname-tooltip-is-focus-visible ref=hostname-tooltip-regression
  it('renders avatar activity as independent badges without a generic connection dot', () => {
    const html = renderToStaticMarkup(
      <ComputerChoice
        computer={computer({ id: 'B', label: 'Laptop', connected: true, unread: 2, working: 1, attention: true })}
        variant="avatar"
        testid="avatar"
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="computer-avatar-unread-B"');
    expect(html).toContain('data-testid="computer-avatar-working-B"');
    expect(html).toContain('data-testid="computer-avatar-attention-B"');
    expect(html).not.toContain('nx-computer-avatar-status');
    expect(html).toContain('class="nx-computer-avatar-tooltip" role="tooltip">Laptop</span>');

    const idle = renderToStaticMarkup(
      <ComputerChoice computer={computer({ id: 'C', label: 'Idle', connected: true })} variant="avatar" onSelect={() => undefined} />,
    );
    expect(idle).not.toContain('computer-avatar-unread-C');
    expect(idle).not.toContain('computer-avatar-working-C');
    expect(idle).not.toContain('computer-avatar-attention-C');
  });
  // harn:end hosted-computer-hostname-tooltip-is-focus-visible
  // harn:end hosted-computer-avatar-badges-are-actionable
});
