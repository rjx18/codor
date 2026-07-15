// harn:assume channel-accent-projects-accessibly-across-themes ref=room-color-projection
// The accessible accent projection. A channel's stored room.config.color may be any non-empty
// string - invalid CSS and alpha-bearing values included - and it is what persists. This module
// is render-only: it derives ONE opaque sRGB colour per channel per theme that clears at least
// 3:1 against every background the accent meets, and that single colour is reused on the rail
// dot, the header chip and the selected picker candidate. Contrast is never measured on an
// OKLCH intermediate or an alpha-bearing value; the emitted opaque colour is always re-measured.
import { deriveRoomColor } from '@codor/protocol';
import { clampChroma, converter, formatHex, parse, wcagContrast } from 'culori';

const toOklch = converter('oklch');
const toRgb = converter('rgb');

/** The sole graphical accent signal must clear 3:1, per the accessibility contract. */
export const MIN_ACCENT_CONTRAST = 3;
const LIGHTNESS_STEP = 0.01;

export interface ProjectAccentInput {
  /** The raw stored value; may be unparseable or alpha-bearing. */
  raw: string;
  /** Channel id, for the unparseable fallback through deriveRoomColor. */
  roomId: string;
  /**
   * The ONE ordered union of every opaque background the accent meets across all three
   * surfaces - the rail dot, the header chip and the selected picker candidate - together with
   * their hover, selected and ring states, resolved for the active theme. Because a single
   * union governs the projection, the one colour it yields clears every surface at once, so a
   * channel renders byte-identically on the rail, the header and the picker.
   */
  backgrounds: readonly string[];
  /** The opaque --cd-agent token value, the final fallback when the lightness bounds exhaust. */
  fallback: string;
}

type Rgb = { mode: 'rgb'; r: number; g: number; b: number; alpha?: number };

/** Composite a possibly-transparent foreground over an opaque background, returning an opaque colour. */
function compositeOver(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.alpha ?? 1;
  return {
    mode: 'rgb',
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/**
 * Project a raw accent to one opaque sRGB hex that clears MIN_ACCENT_CONTRAST against every
 * background in the set, staying as close as possible to the source hue and chroma.
 */
export function projectAccent(input: ProjectAccentInput): string {
  const bgs = input.backgrounds.map((b) => toRgb(parse(b))).filter((c): c is Rgb => Boolean(c));
  if (bgs.length === 0) return input.fallback;

  // Seed: the parsed value, or deriveRoomColor(roomId) when unparseable.
  const parsed = parse(input.raw);
  const seedRgb = (parsed ? toRgb(parsed) : toRgb(parse(deriveRoomColor(input.roomId)))) as Rgb;

  // When the seed carries alpha, composite it over the worst-contrast background so the seed
  // foreground is well defined; the source alpha is retained only for that composite.
  let seed = seedRgb;
  if ((seedRgb.alpha ?? 1) < 1) {
    let worst = bgs[0]!;
    let worstContrast = Number.POSITIVE_INFINITY;
    for (const bg of bgs) {
      const ratio = wcagContrast(compositeOver(seedRgb, bg), bg);
      if (ratio < worstContrast) {
        worstContrast = ratio;
        worst = bg;
      }
    }
    seed = compositeOver(seedRgb, worst);
  }

  const seedOklch = toOklch(seed)!;
  const hue = seedOklch.h ?? 0;
  const chroma = seedOklch.c;
  const l0 = seedOklch.l;

  const clearsEveryBackground = (candidate: string): boolean =>
    bgs.every((bg) => wcagContrast(candidate, bg) >= MIN_ACCENT_CONTRAST);

  // Walk lightness outward from the seed lightness: at each step distance the darker candidate
  // is tried before the lighter one, so the search is deterministic and tie-breaks toward darker.
  const lightnesses: number[] = [l0];
  for (let d = LIGHTNESS_STEP; d <= 1 + 1e-9; d += LIGHTNESS_STEP) {
    if (l0 - d >= 0) lightnesses.push(l0 - d);
    if (l0 + d <= 1) lightnesses.push(l0 + d);
  }
  for (const l of lightnesses) {
    const clamped = clampChroma({ mode: 'oklch', l, c: chroma, h: hue }, 'oklch');
    const hex = formatHex(clamped);
    if (hex && clearsEveryBackground(hex)) return hex;
  }
  return input.fallback;
}
// harn:end channel-accent-projects-accessibly-across-themes
