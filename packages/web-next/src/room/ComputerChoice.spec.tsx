// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ComputerSessionView } from '../app/computer-sessions.js';

import {
  COMPUTER_COLORS,
  COMPUTER_GLYPHS,
  computerActionableCount,
  computerStatus,
  ComputerChoice,
} from './ComputerChoice.js';

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

  // harn:assume hosted-avatar-activity-badges-form-bottom-cluster ref=bottom-activity-cluster-regression
  // harn:assume hosted-computer-avatar-badges-are-actionable ref=avatar-badge-regression
  // harn:assume hosted-computer-avatar-uses-monochrome-icon-palette ref=computer-avatar-appearance-regression
  // harn:assume hosted-computer-status-outline-is-independent-from-selection ref=computer-avatar-status-regression
  // harn:assume hosted-computer-hostname-tooltip-is-focus-visible ref=hostname-tooltip-regression
  it('renders avatar activity as independent badges without a generic connection dot', () => {
    const html = renderToStaticMarkup(
      <ComputerChoice
        computer={computer({ id: 'B', label: 'Laptop', connected: true, unread: 2, working: 1, attention: true })}
        variant="avatar"
        appearance={{ glyph: 'laptop', color: '#0f766e' }}
        testid="avatar"
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="computer-avatar-unread-B"');
    expect(html).toContain('data-testid="computer-avatar-working-B"');
    expect(html).toContain('data-testid="computer-avatar-attention-B"');
    expect(html).toContain('data-testid="computer-avatar-activity-B"');
    expect(html.indexOf('computer-avatar-working-B')).toBeLessThan(html.indexOf('computer-avatar-attention-B'));
    expect(html).not.toContain('nx-computer-avatar-status');
    expect(html).toContain('lucide-laptop');
    expect(html).toContain('--nx-computer-avatar-color:#0f766e');
    expect(html).toContain('class="nx-computer-avatar is-connected"');
    expect(html).toContain('class="nx-computer-avatar-tooltip" role="tooltip">Laptop</span>');

    const idle = renderToStaticMarkup(
      <ComputerChoice computer={computer({ id: 'C', label: 'Idle', connected: true })} variant="avatar" onSelect={() => undefined} />,
    );
    expect(idle).not.toContain('computer-avatar-unread-C');
    expect(idle).not.toContain('computer-avatar-working-C');
    expect(idle).not.toContain('computer-avatar-attention-C');
  });

  it('keeps the status outline independent from active selection and exposes the full palette', () => {
    expect(COMPUTER_GLYPHS).toHaveLength(18);
    expect(COMPUTER_COLORS).toHaveLength(16);
    expect(COMPUTER_GLYPHS).toEqual(expect.arrayContaining(['cat', 'ghost', 'coffee', 'leaf', 'star', 'orbit', 'package', 'zap']));
    const html = renderToStaticMarkup(
      <ComputerChoice
        computer={computer({ id: 'C', active: true, connected: false })}
        variant="avatar"
        appearance={{ glyph: 'server', color: '#334155' }}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('class="nx-computer-avatar is-active is-reconnecting"');
    expect(html).toContain('--nx-computer-avatar-color:#334155');
  });

  it('renders a playful Lucide choice and leaves an unavailable status ring visible when disabled', () => {
    const html = renderToStaticMarkup(
      <ComputerChoice
        computer={computer({ id: 'C', authRefused: true })}
        variant="avatar"
        appearance={{ glyph: 'cat', color: '#3730a3' }}
        disabled
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('class="nx-computer-avatar is-repair"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('lucide-cat');
    expect(html).toContain('--nx-computer-avatar-color:#3730a3');
  });
  // harn:end hosted-computer-hostname-tooltip-is-focus-visible
  // harn:end hosted-computer-status-outline-is-independent-from-selection
  // harn:end hosted-computer-avatar-uses-monochrome-icon-palette
  // harn:end hosted-computer-avatar-badges-are-actionable
  // harn:end hosted-avatar-activity-badges-form-bottom-cluster
});
