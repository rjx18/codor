import { describe, expect, it } from 'vitest';

import {
  CONTENT_BREAKPOINT,
  resolvePresentation,
  type Surface,
} from './presentation.js';

// harn:assume web-presentation-model-defaults-to-v4-until-adopted ref=v5-presentation-default-regression
const ALL_SURFACES: Surface[] = [
  'message',
  'run',
  'tool',
  'ask',
  'hold',
  'composer',
  'member',
  'channel-row',
];
const UNFRAMES = new Set<Surface>(['message', 'run', 'tool']);
const WIDTHS = [320, 390, 719, 720, 1024, 1440];

describe('resolvePresentation', () => {
  it('resolves every unadopted surface to framed-v4 at every width — the inert default', () => {
    for (const surface of ALL_SURFACES) {
      for (const width of WIDTHS) {
        expect(resolvePresentation(surface, width, false), `${surface}@${String(width)}`).toBe(
          'framed-v4',
        );
      }
    }
  });

  it('unframes only message, run and tool below the content breakpoint once adopted', () => {
    for (const surface of ALL_SURFACES) {
      const below = resolvePresentation(surface, CONTENT_BREAKPOINT - 1, true);
      expect(below, `${surface} below ${String(CONTENT_BREAKPOINT)}`).toBe(
        UNFRAMES.has(surface) ? 'unframed-mobile' : 'framed-desktop',
      );
    }
  });

  it('frames every adopted surface at and above the content breakpoint', () => {
    for (const surface of ALL_SURFACES) {
      expect(resolvePresentation(surface, CONTENT_BREAKPOINT, true), `${surface}@720`).toBe(
        'framed-desktop',
      );
      expect(resolvePresentation(surface, 1440, true), `${surface}@1440`).toBe('framed-desktop');
    }
  });

  it('switches message exactly at the 719/720 boundary, not before or after', () => {
    expect(resolvePresentation('message', 719, true)).toBe('unframed-mobile');
    expect(resolvePresentation('message', 720, true)).toBe('framed-desktop');
  });

  it('keeps ask and hold framed even at phone width — the binding mobile exception', () => {
    for (const surface of ['ask', 'hold'] as const) {
      expect(resolvePresentation(surface, 390, true), `${surface}@390`).toBe('framed-desktop');
    }
  });

  it('keeps the composer, member cards and channel rows framed at phone width', () => {
    for (const surface of ['composer', 'member', 'channel-row'] as const) {
      expect(resolvePresentation(surface, 390, true), `${surface}@390`).toBe('framed-desktop');
    }
  });
});
// harn:end web-presentation-model-defaults-to-v4-until-adopted
