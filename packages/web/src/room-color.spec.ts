// @vitest-environment node
import { CHANNEL_ACCENTS, deriveRoomColor } from '@codor/protocol';
import { wcagContrast } from 'culori';
import { describe, expect, it } from 'vitest';

import { MIN_ACCENT_CONTRAST, projectAccent } from './room-color.js';

// harn:assume channel-create-dialog-renders-an-accessible-accent ref=room-color-projection-regression
// Representative opaque backgrounds the accent meets on each surface and their hover/selected
// states; the live surfaces resolve the real --cd-* token values so the projection tracks theme.
const LIGHT = ['#e9e9e6', '#ffffff', '#f2f2ef', '#e2e2de'] as const;
const DARK = ['#1a1a18', '#232320', '#2a2a27', '#33332f'] as const;
const AGENT_LIGHT = '#3a5bd9';
const AGENT_DARK = '#8fa6ff';

const clears = (hex: string, backgrounds: readonly string[]): boolean =>
  backgrounds.every((bg) => wcagContrast(hex, bg) >= MIN_ACCENT_CONTRAST);

const project = (raw: string, backgrounds: readonly string[], fallback: string, roomId = 'room-x'): string =>
  projectAccent({ raw, roomId, backgrounds, fallback });

describe('accessible accent projection', () => {
  it('projects all six protocol accents to at least 3:1 in both themes', () => {
    for (const accent of CHANNEL_ACCENTS) {
      expect(clears(project(accent, LIGHT, AGENT_LIGHT), LIGHT), `${accent} on light`).toBe(true);
      expect(clears(project(accent, DARK, AGENT_DARK), DARK), `${accent} on dark`).toBe(true);
    }
  });

  it('rescues a colour that fails on the light backgrounds', () => {
    const pale = '#f2eeb0'; // pale yellow, well under 3:1 on white
    expect(clears(pale, LIGHT)).toBe(false);
    expect(clears(project(pale, LIGHT, AGENT_LIGHT), LIGHT)).toBe(true);
  });

  it('rescues a colour that fails on the dark backgrounds', () => {
    const nearBlack = '#101820'; // near-black navy, well under 3:1 on the dark canvas
    expect(clears(nearBlack, DARK)).toBe(false);
    expect(clears(project(nearBlack, DARK, AGENT_DARK), DARK)).toBe(true);
  });

  it('handles an alpha-bearing value by projecting an opaque colour that clears', () => {
    const projected = project('rgba(95, 143, 211, 0.15)', LIGHT, AGENT_LIGHT);
    expect(projected.startsWith('#')).toBe(true);
    expect(clears(projected, LIGHT)).toBe(true);
  });

  it('handles transparent without measuring contrast on an alpha value', () => {
    const projected = project('transparent', LIGHT, AGENT_LIGHT);
    expect(clears(projected, LIGHT)).toBe(true);
  });

  it('falls back through deriveRoomColor for an unparseable value and still clears', () => {
    const projected = project('not-a-real-colour', LIGHT, AGENT_LIGHT, 'channel-42');
    // The seed is the deterministic protocol accent for this room, then projected for contrast.
    expect(CHANNEL_ACCENTS).toContain(deriveRoomColor('channel-42'));
    expect(clears(projected, LIGHT)).toBe(true);
  });

  it('reprojects per theme, so a light and a dark projection differ and neither is stale', () => {
    const raw = '#67b7c7';
    const light = project(raw, LIGHT, AGENT_LIGHT);
    const dark = project(raw, DARK, AGENT_DARK);
    expect(clears(light, LIGHT)).toBe(true);
    expect(clears(dark, DARK)).toBe(true);
    expect(light).not.toBe(dark);
  });

  it('is deterministic, so one channel renders the same projected colour on every surface', () => {
    const a = project('#8c86d7', LIGHT, AGENT_LIGHT, 'room-7');
    const b = project('#8c86d7', LIGHT, AGENT_LIGHT, 'room-7');
    expect(a).toBe(b);
  });

  it('is render-only: it returns a projection distinct from the raw value and never mutates input', () => {
    const input = { raw: '#f2eeb0', roomId: 'room-x', backgrounds: LIGHT, fallback: AGENT_LIGHT };
    const projected = projectAccent(input);
    expect(projected.toLowerCase()).not.toBe(input.raw.toLowerCase());
    expect(input.raw).toBe('#f2eeb0'); // the stored value is untouched; persistence is separate
  });

  it('returns the fallback when no background is supplied', () => {
    expect(project('#80c56d', [], AGENT_LIGHT)).toBe(AGENT_LIGHT);
  });
});
// harn:end channel-create-dialog-renders-an-accessible-accent
