// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-token-discipline
// A CLOSED structural guard over the migrated room. It is parsed, never grepped: the CSS through
// PostCSS + postcss-value-parser (so a token named in a comment or string cannot satisfy a
// reference), the TSX through the TypeScript AST (so a className is judged as a JSX attribute, not
// as any string that happens to look like one). The CSS guard names the exact migrated room
// regions, asserts each marker exists exactly once, parses ONLY those regions, and rejects every
// raw colour / type / spacing / line-height / letter-spacing / radius / shadow - the v4 pairing
// region is explicitly excluded. The TSX guard is a closed allowed-class policy: a className token
// may be ONLY wr-*, cd-*, sr-only or a semantic state class (is-*, has-*) - never a Tailwind
// utility - and a style prop must be an object literal that sets only the projected accent and a
// closed geometry set, never a raw colour and never a non-literal expression.

const read = (path: string): string => readFileSync(path, 'utf8');

// --- Region extraction -------------------------------------------------------
// The exact migrated room CSS regions, by (assumption, ref). The first is the primary migrated
// region and itself nests the create/spawn/action-error style regions, so parsing it covers them.
const MIGRATED_REGIONS = [
  ['web-room-visual-hierarchy-matches-soft-editorial-reference', 'soft-editorial-room-style'],
  ['controls-fit-the-surface-they-sit-on', 'control-fits-narrow-surface'],
  ['every-channel-has-a-visible-accent', 'channel-accent-rail'],
] as const;

// Nested markers that must each still exist exactly once inside the migrated CSS.
const NESTED_MARKERS = [
  ['room-action-errors-are-visible', 'room-action-error-style'],
  ['channel-create-dialog-renders-an-accessible-accent', 'channel-create-style'],
  ['web-spawn-dialog-exposes-canonical-agent-controls', 'spawn-dialog-style'],
] as const;

// The v4 pairing region stays on the legacy --wr-* layer and is explicitly NOT a migrated region.
const EXCLUDED_REGION = ['pairing-code-enrollment-surfaces', 'pairing-code-surface-style'] as const;

// Every migrated room region carries SEMANTIC type: the composite ramp (font: var(--cd-text-*)) is
// the whole type system, so a standalone font-size / font-weight / font-family / line-height /
// letter-spacing in one of these regions is drift. This is the full named set from the fix plan;
// the primary soft-editorial-room-style region nests the action-error / create / spawn style
// regions, which are listed again so the intent is legible even though the nesting already covers
// them. Only these regions are scanned - the excluded / non-room / future-phase CSS keeps its raw
// --wr-* type and is never parsed here.
const TYPE_REGIONS = [
  ['web-room-visual-hierarchy-matches-soft-editorial-reference', 'soft-editorial-room-style'],
  ['room-action-errors-are-visible', 'room-action-error-style'],
  ['channel-create-dialog-renders-an-accessible-accent', 'channel-create-style'],
  ['web-spawn-dialog-exposes-canonical-agent-controls', 'spawn-dialog-style'],
  ['normalized-run-items-presented-live', 'run-stream-responsive-style'],
  ['normalized-run-evidence-inspector', 'inspector-contained-scroll'],
  ['literal-draft-effective-recipient-visible', 'composer-popup-style'],
  ['web-motion-is-purposeful-and-reduced-motion-safe-v5', 'motion-token-style'],
  ['interaction-cards-stay-readable-on-phone', 'phone-ask-card-style'],
  ['compact-one-line-tool-rows', 'compact-run-row-style'],
  ['empty-and-offline-are-shown-not-blank', 'timeline-empty-and-offline-states'],
  ['the-inbox-opens-what-needs-you', 'inbox-panel'],
  ['every-channel-has-a-visible-accent', 'channel-accent-rail'],
  ['one-control-chooses-an-agent-everywhere', 'shared-policy-control'],
  ['member-config-is-changed-not-respawned', 'member-card-settings'],
  ['removing-an-agent-is-one-deliberate-step', 'remove-member-control'],
  ['controls-fit-the-surface-they-sit-on', 'control-fits-narrow-surface'],
  ['web-waits-are-visible-across-live-surfaces-v5', 'live-collaboration-style'],
  ['posted-message-mentions-alone-look-effective', 'effective-mention-style'],
] as const;

function markerCount(css: string, assume: string, ref: string): { start: number; end: number } {
  const start = css.split(`/* harn:assume ${assume} ref=${ref} */`).length - 1;
  const end = css.split(`/* harn:end ${assume} */`).length - 1;
  return { start, end };
}

/** The CSS between a region's start marker and the next matching end marker. */
function regionText(css: string, assume: string, ref: string): string {
  const startMarker = `/* harn:assume ${assume} ref=${ref} */`;
  const endMarker = `/* harn:end ${assume} */`;
  const startIndex = css.indexOf(startMarker);
  const endIndex = css.indexOf(endMarker, startIndex + startMarker.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`region not found: ${assume} ref=${ref}`);
  return css.slice(startIndex + startMarker.length, endIndex);
}

// --- CSS discipline ----------------------------------------------------------
// Colour: any hex, any colour function other than color-mix (which composites --cd-* tokens), or a
// bare white/black keyword, is a raw colour. var(--cd-*) and transparent/currentColor/none are not.
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
const RAW_COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;
// Named CSS colours that would be raw drift. Safe keywords (transparent, currentColor, inherit,
// none, unset, initial) and non-colour words (srgb, solid, inset ...) are deliberately absent.
const NAMED_COLORS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'orange', 'yellow', 'purple', 'pink', 'brown',
  'gray', 'grey', 'cyan', 'magenta', 'lime', 'navy', 'teal', 'olive', 'maroon', 'silver',
  'gold', 'coral', 'salmon', 'crimson', 'indigo', 'violet', 'turquoise', 'aliceblue',
  'rebeccapurple', 'canvastext', 'canvas',
]);
function hasRawNamedColour(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((word) => NAMED_COLORS.has(word));
}

const GEOMETRY_SPACING = new Set(['0', 'auto', '10px', '18px', '48px', '50px', '52px', '64px']);
const GEOMETRY_RADIUS = new Set(['0', '50%', '2px']);

function collapseFns(value: string): string {
  let prev = '';
  let out = value;
  while (out !== prev) {
    prev = out;
    out = out.replace(/(?:var|env|max|min|calc|clamp)\([^()]*\)/g, ' ');
  }
  return out;
}

/** Every discipline violation in a migrated CSS region. */
export function cssOffenders(css: string): string[] {
  const out: string[] = [];
  const root = postcss.parse(css);
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const value = decl.value.trim();
    const flag = (why: string): void => void out.push(`${prop}: ${value} (${why})`);

    // Colour: reject a raw colour anywhere in the value, allowing only tokens and colour keywords.
    const withoutVars = value.replace(/var\(\s*--cd-[\w-]+\s*\)/g, ' ');
    if (RAW_HEX.test(withoutVars) || RAW_COLOR_FN.test(withoutVars) || hasRawNamedColour(withoutVars)) {
      flag('raw colour');
    }

    // Type: the ramp bakes size/weight/line-height/family together, so a standalone one is drift.
    if (prop === 'font-size' || prop === 'font-weight' || prop === 'font-family') {
      flag(`raw ${prop}`);
    } else if (prop === 'font') {
      if (value !== 'inherit' && !/^var\(--cd-text-[\w-]+\)$/.test(value)) flag('raw font shorthand');
    } else if (prop === 'line-height') {
      if (value !== 'normal' && !/^var\(--cd-[\w-]+\)$/.test(value)) flag('raw line-height');
    } else if (prop === 'letter-spacing') {
      if (value !== '0' && value !== 'normal' && !/^var\(--cd-[\w-]+\)$/.test(value)) flag('raw letter-spacing');
    }

    // Spacing: every margin / padding / gap part is a --cd-space-* token, 0/auto, or a closed dim.
    if (/^(?:margin|padding|gap)(?:-(?:top|right|bottom|left))?$/.test(prop)) {
      for (const part of collapseFns(value).trim().split(/\s+/).filter(Boolean)) {
        if (GEOMETRY_SPACING.has(part)) continue;
        flag(`raw spacing ${part}`);
      }
    }

    // Radius: a --cd-radius-* token or a closed geometry value.
    if (prop === 'border-radius') {
      for (const part of collapseFns(value).trim().split(/\s+/).filter(Boolean)) {
        if (GEOMETRY_RADIUS.has(part)) continue;
        flag(`raw radius ${part}`);
      }
    }

    // Shadow: a --cd-* token or none; a raw offset/blur/colour shadow is drift.
    if (prop === 'box-shadow' || prop === 'text-shadow') {
      if (value !== 'none' && !value.includes('var(--cd-')) flag('raw shadow');
    }

    // Motion: no raw millisecond duration and no raw easing curve.
    if (/\b\d+ms\b/.test(value) || /cubic-bezier\(/.test(value)) flag('raw motion');
  });
  return out;
}

/** Every raw-typography violation in a migrated CSS region. The composite ramp bakes
 *  size/weight/line-height/family together, so only a `font: var(--cd-text-*)` composite, a
 *  `font-family: var(--cd-font-*)` family-only override, letter-spacing 0, and inherit/normal
 *  pass; a standalone size / weight / family / line-height / non-zero letter-spacing is drift. */
export function typeOffenders(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const value = decl.value.trim();
    const flag = (why: string): void => void out.push(`${prop}: ${value} (${why})`);
    if (prop === 'font-size' || prop === 'font-weight') {
      flag(`raw ${prop}`);
    } else if (prop === 'font-family') {
      if (value !== 'inherit' && !/^var\(--cd-font-[\w-]+\)$/.test(value)) flag('raw font-family');
    } else if (prop === 'font') {
      if (value !== 'inherit' && !/^var\(--cd-text-[\w-]+\)$/.test(value)) flag('raw font shorthand');
    } else if (prop === 'line-height') {
      if (value !== 'normal' && !/^var\(--cd-[\w-]+\)$/.test(value)) flag('raw line-height');
    } else if (prop === 'letter-spacing') {
      if (value !== '0' && value !== 'normal' && !/^var\(--cd-[\w-]+\)$/.test(value)) flag('raw letter-spacing');
    }
  });
  return out;
}

// --- TSX discipline (AST, closed allowed-class policy) ------------------------
const ROOM_TSX = ['src/App.tsx', 'src/shell.tsx', 'src/components.tsx'] as const;

// A className token may be ONLY these. wr-*/cd-* are the room and primitive namespaces; sr-only is
// the screen-reader utility; is-*/has-* are the semantic state classes (some carry a dynamic
// suffix, e.g. is-${status}, so the suffix may be empty). Nothing else - no Tailwind utility.
const ALLOWED_CLASS = /^(?:wr-[a-z0-9-]*|cd-[a-z0-9-]*|is-[a-z0-9-]*|has-[a-z0-9-]*|sr-only)$/;
// A defence-in-depth blocklist so a rejected Tailwind utility names itself in the failure.
const TAILWIND =
  /^(?:(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|divide|placeholder|caret|accent|shadow|outline)-(?:white|black|(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})|p[xytblr]?-\d|m[xytblr]?-\d|gap-\d|min-[wh]-\d+|max-w-\w+|w-full|h-full|flex(?:-\w+)?|grid|items-\w+|justify-\w+|inset-\d|z-\d+|relative|absolute|fixed|sticky|overflow-\w+|truncate|resize-\w+|scroll-mt-\d+|space-[xy]-\d|shrink-\d|ml-auto|text-(?:xs|sm|base|lg)|whitespace-\w+|font-(?:mono|sans|serif)|sm:\w+|disabled:\w+)$/;

const STYLE_ALLOWED_PROPS = new Set([
  'backgroundColor', 'color', 'borderColor',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
]);

/** Collect every className string fragment reachable from a className attribute initializer. */
function classFragments(node: ts.Node, source: ts.SourceFile): string[] {
  const fragments: string[] = [];
  const visit = (expr: ts.Node): void => {
    if (ts.isStringLiteralLike(expr)) {
      fragments.push(expr.text);
    } else if (ts.isTemplateExpression(expr)) {
      fragments.push(expr.head.text);
      for (const span of expr.templateSpans) {
        visit(span.expression);
        fragments.push(span.literal.text);
      }
    } else if (ts.isConditionalExpression(expr)) {
      visit(expr.whenTrue);
      visit(expr.whenFalse);
    } else if (ts.isBinaryExpression(expr)) {
      visit(expr.left);
      visit(expr.right);
    } else if (ts.isParenthesizedExpression(expr)) {
      visit(expr.expression);
    }
    // Identifiers / member access (props.className, a runtime map) carry no literal here.
  };
  if (ts.isJsxExpression(node) && node.expression) visit(node.expression);
  else visit(node);
  return fragments;
}

/** Every TSX discipline violation in a room source file. */
export function tsxOffenders(tsx: string): string[] {
  const source = ts.createSourceFile('room.tsx', tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'className' && node.initializer) {
        for (const fragment of classFragments(node.initializer, source)) {
          for (const token of fragment.split(/\s+/).filter(Boolean)) {
            if (TAILWIND.test(token)) offenders.push(`Tailwind utility "${token}"`);
            else if (!ALLOWED_CLASS.test(token)) offenders.push(`disallowed class "${token}"`);
          }
        }
      }
      if (name === 'style' && node.initializer) {
        const init = node.initializer;
        const object = ts.isJsxExpression(init) && init.expression && ts.isObjectLiteralExpression(init.expression)
          ? init.expression
          : undefined;
        if (!object) {
          offenders.push('non-literal style prop');
        } else {
          for (const prop of object.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
              offenders.push('non-literal style property');
              continue;
            }
            if (!STYLE_ALLOWED_PROPS.has(prop.name.text)) offenders.push(`style sets ${prop.name.text}`);
            // The value must not be a raw colour literal; the projected accent is a variable.
            if (ts.isStringLiteralLike(prop.initializer)
              && (RAW_HEX.test(prop.initializer.text) || RAW_COLOR_FN.test(prop.initializer.text))) {
              offenders.push(`raw colour in style ${prop.name.text}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return offenders;
}

describe('room token discipline: the migrated CSS regions are structurally closed', () => {
  const css = read('src/styles.css');

  it('declares each migrated region marker exactly once, and keeps the v4 pairing region excluded', () => {
    for (const [assume, ref] of [...MIGRATED_REGIONS, ...NESTED_MARKERS]) {
      const { start } = markerCount(css, assume, ref);
      expect(start, `${assume} ref=${ref} start marker`).toBe(1);
    }
    // The pairing region still exists (on the legacy layer) but is not a migrated region.
    expect(markerCount(css, EXCLUDED_REGION[0], EXCLUDED_REGION[1]).start).toBe(1);
  });

  it('has zero raw colour / type / spacing / radius / shadow / motion in any migrated region', () => {
    for (const [assume, ref] of MIGRATED_REGIONS) {
      const offenders = cssOffenders(regionText(css, assume, ref));
      expect(offenders, `${ref}:\n${offenders.join('\n')}`).toEqual([]);
    }
  });

  it('does NOT parse the excluded v4 pairing region as migrated', () => {
    // Proof the exclusion is real: the pairing region carries legacy --wr-* values that WOULD fail
    // the migrated guard, yet it is never one of the parsed regions.
    const pairing = regionText(css, EXCLUDED_REGION[0], EXCLUDED_REGION[1]);
    const migrated = new Set(MIGRATED_REGIONS.map(([a, r]) => `${a}:${r}`));
    expect(migrated.has(`${EXCLUDED_REGION[0]}:${EXCLUDED_REGION[1]}`)).toBe(false);
    expect(pairing.length).toBeGreaterThan(0);
  });

  it('has zero raw typography in any migrated room region - the composite ramp is the type system', () => {
    for (const [assume, ref] of TYPE_REGIONS) {
      const offenders = typeOffenders(regionText(css, assume, ref));
      expect(offenders, `${ref}:\n${offenders.join('\n')}`).toEqual([]);
    }
  });

  it('flags raw typography inside a migrated region - proven with a synthetic fixture', () => {
    const cases: [string, string][] = [
      ['raw font-size', '.x { font-size: 13px; }'],
      ['raw font-weight', '.x { font-weight: 600; }'],
      ['raw font-family', '.x { font-family: ui-monospace, monospace; }'],
      ['raw font shorthand', '.x { font: 14px/1.5 sans-serif; }'],
      ['raw line-height', '.x { line-height: 20px; }'],
      ['raw letter-spacing', '.x { letter-spacing: 0.08em; }'],
    ];
    for (const [name, fixture] of cases) {
      expect(typeOffenders(fixture).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // The token forms pass: a composite role, a family-only override, and inherit/zero/normal.
    expect(typeOffenders('.a { font: var(--cd-text-body); } .b { font-family: var(--cd-font-mono); } .c { font: inherit; letter-spacing: 0; line-height: normal; }')).toEqual([]);
  });

  it('rejects each raw-value bypass in a migrated region - proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['hex colour', '.x { color: #abcdef; }'],
      ['rgb colour', '.x { background: rgb(0 0 0 / 0.2); }'],
      ['named colour', '.x { color: black; }'],
      ['color-mix with a raw colour', '.x { background: color-mix(in srgb, red, blue); }'],
      ['raw font-size', '.x { font-size: 13px; }'],
      ['raw font-weight', '.x { font-weight: 600; }'],
      ['raw font-family', '.x { font-family: ui-monospace, monospace; }'],
      ['raw font shorthand', '.x { font: 14px/1.5 sans-serif; }'],
      ['raw line-height', '.x { line-height: 20px; }'],
      ['raw letter-spacing', '.x { letter-spacing: 0.08em; }'],
      ['raw padding', '.x { padding: 17px; }'],
      ['raw gap', '.x { gap: 7px; }'],
      ['raw radius', '.x { border-radius: 9px; }'],
      ['raw shadow', '.x { box-shadow: 0 1px 2px #000; }'],
      ['raw ms duration', '.x { transition: color 200ms; }'],
      ['raw easing', '.x { transition: color var(--cd-motion-fast) cubic-bezier(0, 0, 1, 1); }'],
    ];
    for (const [name, fixture] of cases) {
      expect(cssOffenders(fixture).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // And the token forms are accepted: a color-mix over --cd-* tokens is not a raw colour.
    expect(cssOffenders('.x { background: color-mix(in srgb, var(--cd-surface) 96%, transparent); font: var(--cd-text-ui); padding: var(--cd-space-2); border-radius: var(--cd-radius-control); box-shadow: var(--cd-elevate-raised); }')).toEqual([]);
  });
});

describe('room token discipline: the migrated TSX carries only allowed classes', () => {
  for (const path of ROOM_TSX) {
    it(`${path} carries no disallowed className and no non-literal style prop`, () => {
      const offenders = tsxOffenders(read(path));
      expect(offenders, `${path}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('rejects each TSX bypass - proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['palette utility', 'const A = () => <span className="text-zinc-500" />;'],
      ['text-white', 'const A = () => <span className="text-white" />;'],
      ['spacing utility', 'const A = () => <span className="px-3" />;'],
      ['size utility', 'const A = () => <span className="min-h-11" />;'],
      ['flex utility', 'const A = () => <span className="flex items-center" />;'],
      ['truncate utility', 'const A = () => <span className="wr-x truncate" />;'],
      ['scroll-mt utility', 'const A = () => <span className="wr-x scroll-mt-16" />;'],
      ['bare disallowed class', 'const A = () => <span className="fancybox" />;'],
      ['utility inside a template', 'const A = () => <span className={`wr-x ${on ? "px-2" : ""}`} />;'],
      ['non-literal style prop', 'const A = () => <span style={styleObject} />;'],
      ['style sets a forbidden property', 'const A = () => <span style={{ display: "flex" }} />;'],
      ['raw colour in a style prop', 'const A = () => <span style={{ backgroundColor: "#fff" }} />;'],
    ];
    for (const [name, fixture] of cases) {
      expect(tsxOffenders(fixture).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // And the accent projection and the allowed class forms pass.
    expect(tsxOffenders('const A = () => <span className="wr-room-dot is-live" style={{ backgroundColor: dotColor }} />;')).toEqual([]);
    expect(tsxOffenders('const A = () => <span className={`wr-message ${mine ? "is-mine" : ""} sr-only`} />;')).toEqual([]);
  });
});
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
