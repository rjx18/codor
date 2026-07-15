// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-token-discipline
// A CLOSED structural guard over the migrated room regions. It fails if any room surface
// regresses to a Tailwind palette utility, an off-token presentation utility (text-white,
// bg-black, or any arbitrary bracket utility), a legacy --wr-* token in the v5 room CSS, a raw
// colour / radius / elevation / motion value in that CSS, or an inline runtime style that is
// anything other than the projected accent. Colour, radius, elevation and motion must be
// tokenised; only the projected accent and a closed geometry set survive as runtime data.

const read = (path: string): string => readFileSync(path, 'utf8');

// Every Tailwind colour-scale family. A number-suffixed member of any of them is a palette
// utility and is forbidden on every migrated room surface.
const PALETTE_FAMILIES =
  'zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const PALETTE_UTILITY = new RegExp(`\\b(?:${PALETTE_FAMILIES})-\\d{2,3}\\b`, 'g');
const WHITE_BLACK_UTILITY = /\b(?:text|bg|border|fill|stroke|ring|decoration|from|via|to)-(?:white|black)\b/g;
// A closed list of Tailwind prefixes immediately followed by an arbitrary-value bracket. This
// cannot match ordinary TS (array types are `T[]`, optional access is `?.[`) because it requires
// a Tailwind prefix and a hyphen before the bracket.
const BRACKET_UTILITY =
  /\b(?:text|bg|w|h|min-w|min-h|max-w|max-h|p[xytblr]?|m[xytblr]?|gap|leading|tracking|inset|top|left|right|bottom|z|rounded|border|shadow|translate|scale|basis|size|opacity|duration|delay|grid-cols|grid-rows|col|row|space-[xy]|from|via|to)-\[/g;

const ROOM_TSX = ['src/App.tsx', 'src/shell.tsx', 'src/components.tsx'] as const;

// The room's type ramp, spacing scale and line-height must all resolve through the --cd-*
// token layer. The ONLY raw lengths a spacing property may still carry are the closed
// geometry dims the token scale cannot express: the 10px panel inset/gap and the 18px panel
// inset the plan names, and the 48/50/52px avatar-alignment indents (a 38px avatar plus its
// gap) that a run/ask/member body hangs under. Everything else - every font, every
// margin/padding/gap, every line-height - is a token.
const GEOMETRY_SPACING_PX = new Set(['10px', '18px', '48px', '50px', '52px']);

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

// Collapse every var()/env()/max()/min()/calc()/clamp() expression to whitespace so a bare raw
// length that survives is a genuine hard-coded value, not a token or a safe-area fallback.
const stripFunctions = (value: string): string => {
  let prev = '';
  let out = value;
  while (out !== prev) {
    prev = out;
    out = out.replace(/(?:var|env|max|min|calc|clamp)\([^()]*\)/g, ' ');
  }
  return out;
};

const rawTypeDeclarations = (css: string): string[] =>
  css.match(/(?:font-size|font-weight|font-family|line-height)\s*:/g) ?? [];

const untokenisedFontShorthands = (css: string): string[] =>
  [...css.matchAll(/(?:^|[\s;{])font\s*:\s*([^;}]+)[;}]/g)]
    .map((match) => match[1]!.trim())
    .filter((value) => value !== 'inherit' && !value.includes('var(--cd-text-'));

const untokenisedSpacing = (css: string): string[] => {
  const offenders: string[] = [];
  for (const match of css.matchAll(
    /(?:^|[\s;{])((?:margin|padding|gap)(?:-(?:top|right|bottom|left))?)\s*:\s*([^;}]+)[;}]/g,
  )) {
    const prop = match[1]!;
    const value = match[2]!.trim();
    for (const part of stripFunctions(value).trim().split(/\s+/).filter(Boolean)) {
      if (part === '0' || part === 'auto') continue;
      if (part.includes('var(--cd-space-')) continue;
      if (GEOMETRY_SPACING_PX.has(part)) continue;
      offenders.push(`${prop}: ${value} (raw: ${part})`);
    }
  }
  return offenders;
};

describe('soft-editorial room token discipline: migrated TSX surfaces', () => {
  for (const path of ROOM_TSX) {
    it(`${path} carries no Tailwind palette utility`, () => {
      expect(read(path).match(PALETTE_UTILITY) ?? []).toEqual([]);
    });

    it(`${path} carries no text-white / bg-black off-token utility`, () => {
      expect(read(path).match(WHITE_BLACK_UTILITY) ?? []).toEqual([]);
    });

    it(`${path} carries no arbitrary bracket utility`, () => {
      expect(read(path).match(BRACKET_UTILITY) ?? []).toEqual([]);
    });

    it(`${path} references no legacy --wr-* token`, () => {
      expect(read(path).includes('--wr-')).toBe(false);
    });
  }

  it('components.tsx has zero palette utilities of the retired families (the named F-gate)', () => {
    // The plan's necessary-but-not-sufficient count, asserted here so a regression is caught in
    // the unit run rather than only by a manual grep.
    const count = (read('src/components.tsx').match(/\b(?:zinc|sky|emerald|red)-\d{2,3}\b/g) ?? []).length;
    expect(count).toBe(0);
  });

  it('every inline runtime style is the projected accent or a closed geometry property only', () => {
    // The only runtime data styles the room is allowed to carry are the accessible accent
    // projection (a variable, never a literal colour) applied to a background/colour/border, and
    // a closed set of geometry properties. Any inline hex, rgb() or palette name is a violation.
    const ALLOWED_PROPS = new Set([
      'backgroundColor',
      'color',
      'borderColor',
      'width',
      'height',
      'minWidth',
      'minHeight',
      'maxWidth',
      'maxHeight',
    ]);
    for (const path of ROOM_TSX) {
      const source = read(path);
      for (const match of source.matchAll(/style=\{\{([^}]*)\}\}/g)) {
        const body = match[1]!;
        // No raw colour literal may appear in a runtime style.
        expect(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(body), `${path}: raw colour in inline style`).toBe(false);
        expect(PALETTE_UTILITY.test(body), `${path}: palette name in inline style`).toBe(false);
        // Every property set must be in the closed allowlist.
        for (const prop of body.matchAll(/([A-Za-z]+)\s*:/g)) {
          expect(ALLOWED_PROPS.has(prop[1]!), `${path}: inline style sets ${prop[1]!}`).toBe(true);
        }
      }
    }
  });
});

describe('soft-editorial room token discipline: migrated stylesheet region', () => {
  const css = read('src/styles.css');
  const START = '/* harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-style */';
  const END = '/* harn:end web-room-visual-hierarchy-matches-soft-editorial-reference */';
  const startIndex = css.indexOf(START);
  const endIndex = css.indexOf(END);
  const region = css.slice(startIndex + START.length, endIndex);

  it('the v5 room stylesheet region is present and non-empty', () => {
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(region.length).toBeGreaterThan(1000);
  });

  it('the region consumes the --cd-* token layer', () => {
    expect(region.includes('var(--cd-')).toBe(true);
  });

  it('the region declares no legacy --wr-* token', () => {
    expect(region.match(/--wr-[a-z-]+/g) ?? []).toEqual([]);
  });

  it('the region has no raw colour (hex, rgb, hsl) or named white/black', () => {
    expect(region.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(region.match(/\brgba?\(|\bhsla?\(/g) ?? []).toEqual([]);
    expect(region.match(/:\s*(?:white|black)\b/g) ?? []).toEqual([]);
  });

  it('every box-shadow is elevation- or ring-tokenised (a --cd-* token) or none', () => {
    // Elevation uses --cd-elevate-*; decorative rings and accent bars use other --cd-* tokens.
    // Either way a shadow must carry NO raw colour - it must reference the token layer.
    const offenders = [...region.matchAll(/box-shadow:\s*([^;]+);/g)]
      .map((match) => match[1]!.trim())
      .filter((value) => value !== 'none' && !value.includes('var(--cd-'));
    expect(offenders).toEqual([]);
  });

  it('every border-radius is a --cd-radius-* token or a closed geometry value', () => {
    const GEOMETRY = /^(?:0|50%|2px)$/;
    const offenders = [...region.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((match) => match[1]!.trim())
      .filter((value) => !value.includes('var(--cd-radius') && !GEOMETRY.test(value));
    expect(offenders).toEqual([]);
  });

  it('motion is tokenised: no raw millisecond duration and no raw easing curve', () => {
    expect(region.match(/\b\d+ms\b/g) ?? []).toEqual([]);
    expect(region.match(/cubic-bezier\(/g) ?? []).toEqual([]);
  });

  const cleanRegion = stripComments(region);

  it('type is tokenised: no raw font-size, font-weight, font-family or line-height', () => {
    // Every text style flows through the --cd-text-* ramp, which bakes size, weight, line-height
    // and family together; a bare font-size / font-weight / font-family / line-height is drift.
    expect(rawTypeDeclarations(cleanRegion)).toEqual([]);
  });

  it('every font shorthand resolves through the --cd-text-* ramp (or inherit)', () => {
    expect(untokenisedFontShorthands(cleanRegion)).toEqual([]);
  });

  it('spacing is tokenised: every margin, padding and gap is a --cd-space-* token or a closed geometry dim', () => {
    expect(untokenisedSpacing(cleanRegion)).toEqual([]);
  });
});

describe('soft-editorial room token discipline: the guard rejects raw type and spacing', () => {
  // A synthetic surface that regresses to raw type and raw spacing. Each checker MUST flag it,
  // proving the guard above is load-bearing rather than vacuously green.
  const RAW_FIXTURE = `
    .regressed {
      font: 15px/1.4 Arial, sans-serif;
      font-size: 13px;
      font-weight: 600;
      line-height: 27px;
      padding: 17px 9px;
      margin: 5px 0 0 3px;
      gap: 7px;
    }`;

  it('flags the raw font-size, font-weight and line-height declarations', () => {
    expect(rawTypeDeclarations(RAW_FIXTURE).length).toBeGreaterThan(0);
  });

  it('flags the non-token font shorthand', () => {
    expect(untokenisedFontShorthands(RAW_FIXTURE)).toContain('15px/1.4 Arial, sans-serif');
  });

  it('flags the raw padding, margin and gap lengths', () => {
    const offenders = untokenisedSpacing(RAW_FIXTURE).join('\n');
    expect(offenders).toContain('17px');
    expect(offenders).toContain('9px');
    expect(offenders).toContain('gap: 7px');
  });
});
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
