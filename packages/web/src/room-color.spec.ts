// @vitest-environment node
import { CHANNEL_ACCENTS, deriveRoomColor } from '@codor/protocol';
import { wcagContrast } from 'culori';
import { describe, expect, it } from 'vitest';

import { MIN_ACCENT_CONTRAST, projectAccent } from './room-color.js';

// harn:assume channel-accent-projects-accessibly-across-themes ref=room-color-projection-regression
// The real --cd-* surface, raised, muted and canvas token values in each theme. The three
// surfaces the accent renders on each sit on a subset of these: the rail dot on the surface,
// muted list and raised rail; the header chip on the surface; the selected picker swatch on the
// dialog surface, ringed by the canvas. The projection is fed the ORDERED UNION of them all, so
// one opaque colour clears every surface at once.
const SURFACE = { light: '#ffffff', dark: '#1c1917' } as const;
const RAISED = { light: '#fbfbfa', dark: '#262220' } as const;
const MUTED = { light: '#f2f2f0', dark: '#171310' } as const;
const CANVAS = { light: '#e9e9e6', dark: '#0c0a09' } as const;
const AGENT = { light: '#3a5bd9', dark: '#8fa6ff' } as const;

type Theme = 'light' | 'dark';

// The ONE ordered union of every adjacent background across all three surfaces and their states.
const union = (theme: Theme): readonly string[] =>
  [SURFACE[theme], MUTED[theme], RAISED[theme], CANVAS[theme]];

// The subset each surface actually presents, used to prove the single union colour clears each.
const railBackgrounds = (theme: Theme): readonly string[] => [SURFACE[theme], MUTED[theme], RAISED[theme]];
const headerBackgrounds = (theme: Theme): readonly string[] => [SURFACE[theme]];
const swatchBackgrounds = (theme: Theme): readonly string[] => [SURFACE[theme], CANVAS[theme]];

// Legacy representative backgrounds kept for the behavioural cases below.
const LIGHT = union('light');
const DARK = union('dark');
const AGENT_LIGHT = AGENT.light;
const AGENT_DARK = AGENT.dark;

const clears = (hex: string, backgrounds: readonly string[]): boolean =>
  backgrounds.every((bg) => wcagContrast(hex, bg) >= MIN_ACCENT_CONTRAST);

const project = (
  raw: string,
  backgrounds: readonly string[],
  fallback: string,
  roomId = 'room-x',
): string => projectAccent({ raw, roomId, backgrounds, fallback });

describe('accessible accent projection', () => {
  it('projects all six protocol accents to at least 3:1 in both themes', () => {
    for (const accent of CHANNEL_ACCENTS) {
      expect(clears(project(accent, LIGHT, AGENT_LIGHT, 'room-x'), LIGHT), `${accent} on light`).toBe(true);
      expect(clears(project(accent, DARK, AGENT_DARK, 'room-x'), DARK), `${accent} on dark`).toBe(true);
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
    expect(clears(project(nearBlack, DARK, AGENT_DARK, 'room-x'), DARK)).toBe(true);
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

  it('is render-only: it returns a projection distinct from the raw value and never mutates input', () => {
    const input = { raw: '#f2eeb0', roomId: 'room-x', backgrounds: LIGHT, fallback: AGENT_LIGHT };
    const projected = projectAccent(input);
    expect(projected.toLowerCase()).not.toBe(input.raw.toLowerCase());
    expect(input.raw).toBe('#f2eeb0'); // the stored value is untouched; persistence is separate
  });

  it('returns the fallback when no background is supplied', () => {
    expect(project('#80c56d', [], AGENT_LIGHT)).toBe(AGENT_LIGHT);
  });

  // The heart of the contract: one union colour that renders byte-identically on the rail dot,
  // the header chip and the selected picker swatch, and that re-projects on a theme change.
  it('renders ONE identical colour on the rail, header and swatch, per theme, and clears each surface', () => {
    for (const theme of ['light', 'dark'] as const) {
      const fallback = AGENT[theme];
      for (const accent of CHANNEL_ACCENTS) {
        // All three surfaces are fed the SAME union, so the projection is identical across them.
        const rail = project(accent, union(theme), fallback, 'room-x');
        const header = project(accent, union(theme), fallback, 'room-x');
        const swatch = project(accent, union(theme), fallback, 'room-x');
        expect(rail, `${accent}/${theme}: rail vs header`).toBe(header);
        expect(header, `${accent}/${theme}: header vs swatch`).toBe(swatch);
        // And that one colour clears every surface's own backgrounds.
        expect(clears(rail, railBackgrounds(theme)), `${accent}/${theme} rail`).toBe(true);
        expect(clears(rail, headerBackgrounds(theme)), `${accent}/${theme} header`).toBe(true);
        expect(clears(rail, swatchBackgrounds(theme)), `${accent}/${theme} swatch`).toBe(true);
      }
    }
  });

  it('re-projects across an explicit theme change, so the light and dark colours differ and neither is stale', () => {
    // An explicit data-theme flip hands the projection the dark union and theme; the same channel
    // must land on a different, still-accessible colour rather than keep the light one.
    const raw = '#67b7c7';
    const light = project(raw, union('light'), AGENT.light, 'room-7');
    const dark = project(raw, union('dark'), AGENT.dark, 'room-7');
    expect(light).not.toBe(dark);
    expect(clears(light, union('light'))).toBe(true);
    expect(clears(dark, union('dark'))).toBe(true);
  });

  it('re-projects across a system theme change the same way an explicit one does', () => {
    // No data-theme is set; the system preference flips from light to dark. The surfaces re-read
    // the union for the new theme, so the projection tracks the flip on all three surfaces alike.
    const raw = deriveRoomColor('room-system');
    const systemLight = project(raw, union('light'), AGENT.light, 'room-system');
    const systemDark = project(raw, union('dark'), AGENT.dark, 'room-system');
    expect(systemLight).not.toBe(systemDark);
    for (const surface of [railBackgrounds, headerBackgrounds, swatchBackgrounds]) {
      expect(clears(systemLight, surface('light'))).toBe(true);
      expect(clears(systemDark, surface('dark'))).toBe(true);
    }
  });

  it('is deterministic within a theme, so a re-render yields the same projected colour', () => {
    const a = project('#8c86d7', union('light'), AGENT.light, 'room-7');
    const b = project('#8c86d7', union('light'), AGENT.light, 'room-7');
    expect(a).toBe(b);
  });
});
// harn:end channel-accent-projects-accessibly-across-themes
