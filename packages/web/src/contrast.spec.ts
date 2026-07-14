import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = fileURLToPath(new URL('./styles.css', import.meta.url));

/** Reads the --cd-* declarations out of a theme's selector block. */
function tokensFor(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  postcss.parse(readFileSync(STYLESHEET, 'utf8')).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(/^--cd-/, (decl) => {
      found.set(decl.prop, decl.value.trim());
    });
  });
  return found;
}

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
