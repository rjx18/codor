import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { describe, expect, it } from 'vitest';

const STYLESHEET = fileURLToPath(new URL('./styles.css', import.meta.url));
const CSS = readFileSync(STYLESHEET, 'utf8');

/** Reads the --cd-* declarations out of a theme's selector block. */
function tokensFor(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  postcss.parse(CSS).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(/^--cd-/, (decl) => {
      found.set(decl.prop, decl.value.trim());
    });
  });
  return found;
}

/** The custom-property names a value references through var(). */
function varRefs(value: string): string[] {
  const names: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'function' || node.value !== 'var') return;
    const first = node.nodes[0];
    if (first?.type === 'word' && first.value.startsWith('--')) names.push(first.value);
  });
  return names;
}

/** Every declaration in the stylesheet a text colour can legally reach. */
const TEXT_COLOR_PROPS = new Set([
  'color',
  'caret-color',
  'text-decoration-color',
  '-webkit-text-fill-color',
]);

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const NEUTRAL_SURFACES = ['--cd-surface', '--cd-surface-raised', '--cd-surface-muted', '--cd-canvas'];
const TEXT_ROLES = ['--cd-text-strong', '--cd-text-body-color', '--cd-text-secondary', '--cd-text-muted'];
/** Each status role is legal on the neutrals *and* on its own tint. */
const STATUS_ROLES: Record<string, string> = {
  '--cd-live': '--cd-live-tint',
  '--cd-error': '--cd-error-tint',
  '--cd-warn': '--cd-warn-tint',
  '--cd-agent': '--cd-agent-tint',
};

// harn:assume web-theme-accessible-modes ref=theme-contrast-matrix
describe.each([
  ['light', ':root'],
  ['dark', ":root[data-theme='dark']"],
])('the v5 %s theme', (theme, selector) => {
  const token = tokensFor(selector);
  const value = (name: string): string => {
    const hex = token.get(name);
    if (hex === undefined) throw new Error(`${name} is not declared in the ${theme} theme`);
    return hex;
  };

  // The contract is not "these hexes"; it is "these ratios". Pinning the hexes would let
  // a future surface change silently break the promise the token exists to make.
  it.each(TEXT_ROLES)('%s holds AA on every neutral surface', (role) => {
    for (const surface of NEUTRAL_SURFACES) {
      const ratio = contrast(value(role), value(surface));
      expect(ratio, `${role} on ${surface} in ${theme} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.entries(STATUS_ROLES))(
    '%s holds AA as text on every neutral surface and on its own tint',
    (role, tint) => {
      for (const surface of [...NEUTRAL_SURFACES, tint]) {
        const ratio = contrast(value(role), value(surface));
        expect(ratio, `${role} on ${surface} in ${theme} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(Object.keys(STATUS_ROLES))('%s therefore also clears 3:1 as a sole-signal mark', (role) => {
    // 4.5 implies 3, which is exactly why there is no separate mark token.
    for (const surface of NEUTRAL_SURFACES) {
      expect(contrast(value(role), value(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps mark-faint out of the text ramp — it cannot hold AA at any size', () => {
    const worst = Math.min(...NEUTRAL_SURFACES.map((s) => contrast(value('--cd-mark-faint'), value(s))));
    // This is the v4 mistake the axe scan caught, made structurally impossible: the role
    // exists, it is decorative, and it is measurably not a text colour.
    expect(worst).toBeLessThan(4.5);
    expect(TEXT_ROLES).not.toContain('--cd-mark-faint');
  });
});

describe('the v5 token layer, structurally', () => {
  it('never lets a text colour reach mark-faint, directly or through an alias', () => {
    // Build the alias graph: every custom property, and the custom properties its value
    // references. A direct search for `color: var(--cd-mark-faint)` would miss
    // `--x: var(--cd-mark-faint); color: var(--x)`, so resolve transitively.
    const refs = new Map<string, string[]>();
    const textColorUses: { prop: string; value: string; root: string }[] = [];
    postcss.parse(CSS).walkDecls((decl) => {
      if (decl.prop.startsWith('--')) {
        refs.set(decl.prop, [...(refs.get(decl.prop) ?? []), ...varRefs(decl.value)]);
      }
      if (TEXT_COLOR_PROPS.has(decl.prop)) {
        for (const name of varRefs(decl.value)) {
          textColorUses.push({ prop: decl.prop, value: decl.value.trim(), root: name });
        }
      }
    });

    const reachesMarkFaint = (name: string, seen = new Set<string>()): boolean => {
      if (name === '--cd-mark-faint') return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return (refs.get(name) ?? []).some((next) => reachesMarkFaint(next, seen));
    };

    const offenders = textColorUses.filter((use) => reachesMarkFaint(use.root));
    expect(offenders, offenders.map((o) => `${o.prop}: ${o.value}`).join('\n')).toEqual([]);
  });

  it('declares identical dark maps for the media query and the explicit choice', () => {
    // Dark is authored twice - @media (prefers-color-scheme: dark) and [data-theme='dark'].
    // If they drift, a system-dark browser and an explicitly-dark one disagree.
    const explicitDark = tokensFor(":root[data-theme='dark']");
    const mediaDark = new Map<string, string>();
    postcss.parse(CSS).walkAtRules('media', (atRule) => {
      if (!atRule.params.includes('prefers-color-scheme: dark')) return;
      atRule.walkDecls(/^--cd-/, (decl) => {
        mediaDark.set(decl.prop, decl.value.trim());
      });
    });

    expect(mediaDark.size).toBeGreaterThan(0);
    expect(Object.fromEntries([...mediaDark].sort())).toEqual(
      Object.fromEntries([...explicitDark].sort()),
    );
  });
});
// harn:end web-theme-accessible-modes
