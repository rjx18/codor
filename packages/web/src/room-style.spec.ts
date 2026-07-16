// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-token-discipline
// A genuinely CLOSED, property-scoped guard over the migrated room. Modeled on the hardened
// primitive guard (v5/primitives.spec): instead of blacklisting bad values, it CLASSIFIES every
// declared property into exactly one discipline and REJECTS any property it has no policy for — so
// a raw colour can never ride in on scrollbar-color, -webkit-tap-highlight-color, caret-color,
// background-image or any property the guard never considered. Both surfaces are parsed, never
// grepped: the CSS through PostCSS + postcss-value-parser (a token named in a comment or string
// cannot satisfy a reference, and calc/min/max/clamp/env are recursed so a raw length cannot hide
// inside them), the TSX through the TypeScript AST (a className is judged as a JSX attribute, and a
// non-literal className expression — bare identifier, map/object lookup, call, or non-literal
// template span — is an offender, while an undefined/null empty branch is permitted).

const read = (path: string): string => readFileSync(path, 'utf8');

// --- Region discovery --------------------------------------------------------
// One canonical region list: EVERY room region marked by `harn:assume … ref=…`/`harn:end` in
// styles.css EXCEPT the two exclusions. soft-editorial-token-layer is the token layer itself (it
// DECLARES the --cd-* tokens), and pairing-code-surface-style stays on the legacy --wr-* layer.
const EXCLUDED_REFS = new Set(['soft-editorial-token-layer', 'pairing-code-surface-style']);

interface Region {
  assume: string;
  ref: string;
}

/** Every (assume, ref) region the file marks, in document order. */
function allRegions(css: string): Region[] {
  const out: Region[] = [];
  const re = /\/\* harn:assume (\S+) ref=(\S+) \*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ assume: m[1]!, ref: m[2]! });
  return out;
}

/** The scanned regions: all regions minus the two exclusions. */
function scannedRegions(css: string): Region[] {
  return allRegions(css).filter((r) => !EXCLUDED_REFS.has(r.ref));
}

function markerCount(css: string, assume: string, ref: string): number {
  return css.split(`/* harn:assume ${assume} ref=${ref} */`).length - 1;
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

// --- CSS discipline: classify every property ---------------------------------
type Policy = 'paint' | 'background' | 'paint-shorthand' | 'shadow' | 'space' | 'radius' | 'type' | 'motion' | 'layout';

// The closed layout-neutral allowlist: geometry / flow / paintless structure the token layer cannot
// express. A value here is not token-checked, but the property must still be one the room uses — an
// unlisted property is `unclassified` and rejected, so no colour can ride in on an unconsidered one.
const LAYOUT_NEUTRAL = new Set([
  'display', 'align-items', 'justify-content', 'justify-self', 'place-items', 'box-sizing', 'isolation',
  'flex', 'flex-basis', 'flex-direction', 'flex-wrap', 'flex-shrink',
  'grid-area', 'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
  'overflow', 'overflow-x', 'overflow-y', 'overscroll-behavior',
  'transform', 'transform-origin',
  'opacity', 'cursor', 'content', 'pointer-events', 'resize', 'object-fit', 'appearance',
  'scrollbar-width', 'scroll-margin-top',
  'white-space', 'text-align', 'text-overflow', 'overflow-wrap', 'text-transform',
  'text-decoration', 'text-decoration-thickness', 'text-underline-offset',
  'list-style',
  'backdrop-filter', '-webkit-backdrop-filter',
]);

/** Exactly one discipline per property, or null for an unclassified (rejected) property. */
export function classify(prop: string): Policy | null {
  if (LAYOUT_NEUTRAL.has(prop)) return 'layout';
  if (prop === 'background') return 'background';
  if (prop === 'box-shadow' || prop === 'text-shadow') return 'shadow';
  if (prop === 'border-radius' || prop.endsWith('-radius')) return 'radius';
  if (/^(?:margin|padding)(?:-(?:top|right|bottom|left))?$/.test(prop)
    || prop === 'gap' || prop === 'row-gap' || prop === 'column-gap' || prop === 'outline-offset') {
    return 'space';
  }
  if (prop === 'color' || prop === 'fill' || prop === 'stroke' || prop.endsWith('-color')) return 'paint';
  if (prop === 'border' || /^border-(?:top|right|bottom|left)$/.test(prop) || prop === 'outline' || prop === 'column-rule') {
    return 'paint-shorthand';
  }
  if (prop === 'font' || prop.startsWith('font-') || prop === 'line-height' || prop === 'letter-spacing') return 'type';
  if (prop === 'transition' || prop.startsWith('transition-') || prop === 'animation' || prop.startsWith('animation-')) {
    return 'motion';
  }
  return null;
}

// --- Colour: a closed allowlist ----------------------------------------------
// Only var(--cd-*), the safe keywords, or a compositing function (color-mix, and — for `background`
// only — a gradient) whose colour arguments are themselves tokens/keywords. Any hex, any colour
// function (rgb/hsl/hwb/lab/lch/oklab/oklch/color), or any other bare word is raw. No named-colour
// blacklist: a bare word is raw unless it is an explicitly-allowed keyword.
const SAFE_COLOR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none']);
// Non-colour syntax words that legitimately appear inside color-mix()/gradients.
const COLOR_SYNTAX = new Set([
  'in', 'srgb', 'srgb-linear', 'hsl', 'hwb', 'lch', 'lab', 'oklch', 'oklab', 'display-p3', 'a98-rgb',
  'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65', 'to', 'top', 'bottom', 'left', 'right', 'center',
  'shorter', 'longer', 'hue', 'increasing', 'decreasing',
]);
const RAW_COLOR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
const GRADIENT_FNS = new Set([
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
]);

/** Every raw-colour violation among a set of value nodes. Gradients are permitted only when
 *  allowGradient (the `background` discipline); their colour stops are checked recursively. */
function colourOffenders(nodes: valueParser.Node[], allowGradient: boolean): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'space' || node.type === 'div') continue;
    if (node.type === 'function') {
      const fn = node.value.toLowerCase();
      if (fn === 'var') {
        const first = node.nodes[0];
        if (!(first && first.type === 'word' && first.value.startsWith('--cd-'))) out.push(`non-token var(${node.value})`);
        // A var() fallback is another colour; check it.
        out.push(...colourOffenders(node.nodes.slice(1), allowGradient));
      } else if (fn === 'color-mix') {
        out.push(...colourOffenders(node.nodes, allowGradient));
      } else if (GRADIENT_FNS.has(fn)) {
        if (!allowGradient) out.push(`gradient ${fn}()`);
        else out.push(...colourOffenders(node.nodes, allowGradient));
      } else if (RAW_COLOR_FNS.has(fn)) {
        out.push(`raw colour ${fn}()`);
      } else {
        out.push(`unexpected function ${fn}()`);
      }
      continue;
    }
    // word node
    const w = node.value;
    const lw = w.toLowerCase();
    if (w.startsWith('#')) out.push(`raw hex ${w}`);
    else if (valueParser.unit(w)) continue; // number / percentage / angle / dimension (stop, mix %, angle)
    else if (SAFE_COLOR_KEYWORDS.has(lw) || COLOR_SYNTAX.has(lw)) continue;
    else out.push(`raw colour ${w}`);
  }
  return out;
}

// --- Spacing / radius: recurse to every numeric leaf -------------------------
// The structural shell geometry the token scale cannot express: avatar-column indents keyed to a
// specific SELECTOR + PROPERTY + VALUE (never a blanket set, never merely per-property). Everything
// else off-scale aligns to the nearest --cd-space-* token.
const FIXED_GEOMETRY = new Set([
  '.wr-run-body||margin||52px',
  '.wr-run-summary||margin||52px',
  '.wr-run-events||margin||52px',
  '.wr-ask-prompt||margin||48px',
  '.wr-ask-detail||margin||48px',
  '.wr-member-detail||padding||50px',
  '.wr-run-event-list .wr-run-prose||padding||34px',
]);
// The closed radius literal set the scale does not name: a hairline corner and a full circle.
const RADIUS_LITERALS = new Set(['2px', '50%']);

/** Whether every listed selector permits this exact fixed-geometry leaf for this property. */
function fixedGeometryOk(selectors: string[], prop: string, leaf: string): boolean {
  return selectors.length > 0 && selectors.every((s) => FIXED_GEOMETRY.has(`${s}||${prop}||${leaf}`));
}

/** Every spacing/radius violation. Recurses into calc/min/max/clamp/env and checks each numeric
 *  leaf: a length must be the right --cd-* token family (or a keyed fixed-geometry exception, or
 *  {0, auto}); radius also admits the closed literal set. No generic percentage for spacing. */
function metricOffenders(nodes: valueParser.Node[], kind: 'space' | 'radius', selectors: string[], prop: string): string[] {
  const out: string[] = [];
  const family = kind === 'space' ? '--cd-space-' : '--cd-radius-';
  for (const node of nodes) {
    if (node.type === 'space' || node.type === 'div') continue;
    if (node.type === 'function') {
      const fn = node.value.toLowerCase();
      if (fn === 'var') {
        const first = node.nodes[0];
        if (!(first && first.type === 'word' && first.value.startsWith(family))) {
          out.push(`${prop}: token ${first && first.type === 'word' ? first.value : '?'} not ${family}*`);
        }
        out.push(...metricOffenders(node.nodes.slice(1), kind, selectors, prop)); // var() fallback
      } else {
        // calc / min / max / clamp / env / etc. — recurse to the numeric leaves.
        out.push(...metricOffenders(node.nodes, kind, selectors, prop));
      }
      continue;
    }
    // word node
    const parsed = valueParser.unit(node.value);
    if (parsed === false) {
      if (node.value.toLowerCase() === 'auto') continue; // margin auto
      continue; // an operator (+ - * /) or an env() inset name — not a numeric leaf
    }
    const num = Number(parsed.number);
    const unit = parsed.unit;
    if (num === 0) continue; // zero, any unit
    if (unit === '') continue; // a unitless multiplier inside calc()
    if (kind === 'radius' && RADIUS_LITERALS.has(node.value)) continue;
    if (unit === '%') {
      out.push(`${prop}: raw ${kind} ${node.value}`);
      continue;
    }
    if (fixedGeometryOk(selectors, prop, node.value)) continue;
    out.push(`${prop}: raw ${kind} ${node.value}`);
  }
  return out;
}

// --- Shadow: fully token-composed --------------------------------------------
// none, a whole --cd-* shadow token, or a composition where every offset/blur/spread is 0 or a
// token and the colour is a token/currentColor/none — a raw px ring width fails even beside a token.
function shadowOffenders(value: string): string[] {
  if (value === 'none' || /^var\(--cd-[\w-]+\)$/.test(value)) return [];
  const out: string[] = [];
  const walk = (nodes: valueParser.Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'space' || node.type === 'div') continue;
      if (node.type === 'function') {
        const fn = node.value.toLowerCase();
        if (fn === 'var') {
          const first = node.nodes[0];
          if (!(first && first.type === 'word' && first.value.startsWith('--cd-'))) out.push(`shadow non-token var(${node.value})`);
        } else if (fn === 'color-mix') {
          out.push(...colourOffenders(node.nodes, false));
        } else {
          out.push(`shadow function ${fn}()`);
        }
        continue;
      }
      const w = node.value;
      const lw = w.toLowerCase();
      if (lw === 'inset') continue;
      if (SAFE_COLOR_KEYWORDS.has(lw)) continue;
      if (w.startsWith('#')) {
        out.push(`shadow raw colour ${w}`);
        continue;
      }
      const parsed = valueParser.unit(w);
      if (parsed === false) {
        out.push(`shadow raw ${w}`);
        continue;
      }
      if (Number(parsed.number) === 0) continue;
      out.push(`shadow raw length ${w}`);
    }
  };
  walk(valueParser(value).nodes);
  return out;
}

// --- Motion ------------------------------------------------------------------
// Reject raw time in BOTH s and ms, the easing keywords, steps() and cubic-bezier() unless a
// --cd-ease-* token. Allow keyframe names, iteration counts, fill/direction keywords, property names.
const EASING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);
function motionOffenders(value: string): string[] {
  const out: string[] = [];
  const walk = (nodes: valueParser.Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'space' || node.type === 'div') continue;
      if (node.type === 'function') {
        const fn = node.value.toLowerCase();
        if (fn === 'var') {
          const first = node.nodes[0];
          if (!(first && first.type === 'word' && first.value.startsWith('--cd-'))) out.push(`motion non-token var(${node.value})`);
        } else if (fn === 'steps' || fn === 'cubic-bezier') {
          out.push(`raw easing ${fn}()`);
        } else {
          out.push(`motion function ${fn}()`);
        }
        continue;
      }
      const w = node.value;
      const lw = w.toLowerCase();
      const parsed = valueParser.unit(w);
      if (parsed && (parsed.unit === 's' || parsed.unit === 'ms')) out.push(`raw time ${w}`);
      else if (EASING_KEYWORDS.has(lw)) out.push(`easing keyword ${w}`);
      // else: property name / keyframe name / iteration count / fill / direction keyword — allowed.
    }
  };
  walk(valueParser(value).nodes);
  return out;
}

// --- Type --------------------------------------------------------------------
const FONT_STYLE_KEYWORDS = new Set(['normal', 'italic', 'oblique']);
function typeOffenders(prop: string, value: string): string[] {
  const flag = (why: string): string[] => [`${prop}: ${value} (${why})`];
  if (prop === 'font') {
    return value === 'inherit' || /^var\(--cd-text-[\w-]+\)$/.test(value) ? [] : flag('raw font shorthand');
  }
  if (prop === 'font-family') {
    return value === 'inherit' || /^var\(--cd-font-[\w-]+\)$/.test(value) ? [] : flag('raw font-family');
  }
  if (prop === 'font-style') return FONT_STYLE_KEYWORDS.has(value.toLowerCase()) ? [] : flag('raw font-style');
  if (prop === 'line-height') {
    return value === 'normal' || /^var\(--cd-[\w-]+\)$/.test(value) ? [] : flag('raw line-height');
  }
  if (prop === 'letter-spacing') {
    return value === '0' || value === 'normal' || /^var\(--cd-[\w-]+\)$/.test(value) ? [] : flag('raw letter-spacing');
  }
  return flag(`raw ${prop}`); // standalone font-size / font-weight / …
}

// --- Paint-shorthand ---------------------------------------------------------
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden', 'none']);
const BORDER_WIDTHS = new Set([1, 2]);
function paintShorthandOffenders(nodes: valueParser.Node[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'space' || node.type === 'div') continue;
    if (node.type === 'function') {
      out.push(...colourOffenders([node], false));
      continue;
    }
    const w = node.value;
    const lw = w.toLowerCase();
    const parsed = valueParser.unit(w);
    if (parsed && parsed.unit === 'px' && BORDER_WIDTHS.has(Number(parsed.number))) continue;
    if (parsed && Number(parsed.number) === 0) continue;
    if (BORDER_STYLES.has(lw) || SAFE_COLOR_KEYWORDS.has(lw)) continue;
    if (w.startsWith('#')) out.push(`raw ${w}`);
    else if (parsed) out.push(`raw width ${w}`);
    else out.push(`raw ${w}`);
  }
  return out;
}

// --- The closed CSS detector -------------------------------------------------
/** Every discipline violation in a CSS region. */
export function cssOffenders(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    rule.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      const flag = (why: string): void => void out.push(`${prop}: ${value} (${why})`);
      if (prop.startsWith('--')) return; // the room may declare a local custom property; not a value policy

      const policy = classify(prop);
      if (policy === null) {
        flag('unclassified property');
        return;
      }
      const nodes = valueParser(value).nodes;
      switch (policy) {
        case 'layout':
          break;
        case 'paint':
          for (const why of colourOffenders(nodes, false)) flag(why);
          break;
        case 'background':
          for (const why of colourOffenders(nodes, true)) flag(why);
          break;
        case 'paint-shorthand':
          for (const why of paintShorthandOffenders(nodes)) flag(why);
          break;
        case 'shadow':
          for (const why of shadowOffenders(value)) flag(why);
          break;
        case 'space':
          for (const why of metricOffenders(nodes, 'space', selectors, prop)) out.push(`${rule.selector} { ${why} }`);
          break;
        case 'radius':
          for (const why of metricOffenders(nodes, 'radius', selectors, prop)) out.push(`${rule.selector} { ${why} }`);
          break;
        case 'type':
          for (const why of typeOffenders(prop, value)) out.push(why);
          break;
        case 'motion':
          for (const why of motionOffenders(value)) flag(why);
          break;
      }
    });
  });
  return out;
}

// --- The effective cascade ----------------------------------------------------
// The region checks above prove the anchored declarations are token-clean, but a token-clean
// declaration can still be DEAD: an unanchored rule later in the file wins the cascade at equal
// specificity and ships something else. This layer inspects the whole stylesheet:
//
//  1. Same-key overrides: for every (media context, selector, property) that an anchored region
//     declares, no later declaration outside the scanned regions may redeclare it. The anchored
//     declaration must be the one the cascade actually applies.
//  2. Owned-class discipline: every rule ANYWHERE in the file whose selector references a class
//     owned by the anchored regions must obey the paint, radius, type, motion and letter-spacing
//     disciplines. (Spacing literals outside the regions are Phase 6 consolidation debt and are
//     not judged here.)
//  3. letter-spacing is absolute: any nonzero letter-spacing anywhere in the file fails, owned
//     class or not.

interface PlacedDecl {
  media: string;
  selector: string;
  prop: string;
  value: string;
  inRegion: boolean;
  order: number;
  line: number;
}

/** [start, end) offsets of a set of regions in the raw CSS text. */
function spansOf(css: string, regions: Region[]): [number, number][] {
  return regions.map(({ assume, ref }) => {
    const startMarker = `/* harn:assume ${assume} ref=${ref} */`;
    const start = css.indexOf(startMarker);
    const end = css.indexOf(`/* harn:end ${assume} */`, start + startMarker.length);
    if (start < 0 || end < 0) throw new Error(`region not found: ${assume} ref=${ref}`);
    return [start, end] as [number, number];
  });
}

/** [start, end) offsets of every scanned region in the raw CSS text. */
function regionSpans(css: string): [number, number][] {
  return spansOf(css, scannedRegions(css));
}

/** [start, end) offsets of the two excluded legacy-layer regions. */
function excludedSpans(css: string): [number, number][] {
  return spansOf(css, allRegions(css).filter((r) => EXCLUDED_REFS.has(r.ref)));
}

// The glass-era burn-down list: these EXACT unanchored declarations are the shipped, approved
// matte rendering neutralizing stale glass-era declarations that still sit INSIDE the anchored
// region (translucent panels, panel blur, chip meters, the glass-era brand mark, the base-hidden
// context trigger). Removing them would regress the approved look; correcting them properly means
// reauthoring the anchored region, which is Phase 6 consolidation work. The set is exact and
// count-pinned both ways: deleting one without updating this list fails, and adding ANY new
// override fails. Phase 6 burns this to zero by reconciling the anchored region itself.
const PINNED_GLASS_ERA_NEUTRALIZERS = new Set([
  '||.wr-room-main||background||var(--cd-surface)',
  '||.wr-room-header||background||var(--cd-surface)',
  '||.wr-room-rail||background||var(--cd-surface)',
  '||.wr-context-rail||-webkit-backdrop-filter||none',
  '||.wr-context-rail||backdrop-filter||none',
  '||.wr-room-header||-webkit-backdrop-filter||none',
  '||.wr-room-header||backdrop-filter||none',
  '||.wr-room-rail||-webkit-backdrop-filter||none',
  '||.wr-room-rail||backdrop-filter||none',
  '||.wr-brand||padding||0 22px',
  '||.wr-brand-mark||display||none',
  '||.wr-rail-footer||background||var(--cd-surface)',
  '||.wr-presence||box-shadow||none',
  '||.wr-presence.is-live||box-shadow||none',
  '||.wr-meter||border||0',
  '||.wr-meter||border-radius||0',
  '||.wr-meter||background||transparent',
  '||.wr-meter||-webkit-backdrop-filter||none',
  '||.wr-meter||backdrop-filter||none',
  '||.wr-context-trigger||display||inline-flex',
]);

/** Every class token owned by the scanned regions' selectors. */
export function ownedClasses(css: string): Set<string> {
  const owned = new Set<string>();
  const spans = regionSpans(css);
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes/i.test((rule.parent as postcss.AtRule).name)) return;
    const offset = rule.source?.start?.offset ?? -1;
    if (!spans.some(([s, e]) => offset >= s && offset < e)) return;
    for (const m of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) owned.add(m[1]!);
  });
  return owned;
}

/** The at-rule context of a node, e.g. "@media (width < 720px)"; '' at the top level. */
function mediaContext(node: postcss.Node): string {
  const parts: string[] = [];
  let parent = node.parent;
  while (parent && parent.type !== 'root') {
    if (parent.type === 'atrule') {
      const at = parent as postcss.AtRule;
      parts.unshift(`@${at.name} ${at.params}`.trim());
    }
    parent = parent.parent;
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Every effective-cascade violation in a whole stylesheet. Returns the violations plus the
 *  pinned glass-era neutralizers actually observed, so the pin list can be asserted exact. */
export function effectiveCascade(css: string): { offenders: string[]; pinned: Set<string> } {
  const out: string[] = [];
  const observedPinned = new Set<string>();
  const spans = regionSpans(css);
  const legacySpans = excludedSpans(css);
  const owned = ownedClasses(css);
  const placed: PlacedDecl[] = [];
  let order = 0;

  postcss.parse(css).walkDecls((decl) => {
    const rule = decl.parent;
    if (!rule || rule.type !== 'rule') return;
    let inKeyframes = false;
    for (let p: postcss.Node | undefined = rule; p; p = p.parent as postcss.Node | undefined) {
      if (p.type === 'atrule' && /keyframes/i.test((p as postcss.AtRule).name)) inKeyframes = true;
    }
    if (inKeyframes) return;
    const offset = decl.source?.start?.offset ?? -1;
    // The two excluded legacy-layer regions are policy-exempt by design: ignore them entirely.
    if (legacySpans.some(([s, e]) => offset >= s && offset < e)) return;
    const inRegion = spans.some(([s, e]) => offset >= s && offset < e);
    const media = mediaContext(decl);
    const line = decl.source?.start?.line ?? 0;
    const prop = decl.prop.toLowerCase();
    const value = decl.value.trim();

    for (const selector of (rule as postcss.Rule).selectors.map((s) => s.replace(/\s+/g, ' ').trim())) {
      placed.push({ media, selector, prop, value, inRegion, order, line });
    }
    order += 1;

    // 3. letter-spacing is absolute, everywhere in the file.
    if (prop === 'letter-spacing' && !(value === '0' || value === 'normal')) {
      out.push(`styles.css:${String(line)} letter-spacing ${value} (letter-spacing must be 0 everywhere)`);
    }

    // 2. Owned-class discipline outside the regions (regions are fully judged above).
    if (inRegion || prop.startsWith('--')) return;
    const selectorOwned = (rule as postcss.Rule).selector.match(/\.([a-zA-Z_][\w-]*)/g)
      ?.some((c) => owned.has(c.slice(1))) ?? false;
    if (!selectorOwned) return;
    const policy = classify(prop);
    const nodes = valueParser(value).nodes;
    const flag = (why: string): void =>
      void out.push(`styles.css:${String(line)} ${(rule as postcss.Rule).selector} { ${prop}: ${value} } (${why})`);
    switch (policy) {
      case 'paint':
        for (const why of colourOffenders(nodes, false)) flag(why);
        break;
      case 'background':
        for (const why of colourOffenders(nodes, true)) flag(why);
        break;
      case 'paint-shorthand':
        for (const why of paintShorthandOffenders(nodes)) flag(why);
        break;
      case 'shadow':
        for (const why of shadowOffenders(value)) flag(why);
        break;
      case 'radius':
        for (const why of metricOffenders(nodes, 'radius', (rule as postcss.Rule).selectors, prop)) flag(why);
        break;
      case 'type':
        for (const why of typeOffenders(prop, value)) flag(why);
        break;
      case 'motion':
        for (const why of motionOffenders(value)) flag(why);
        break;
      default:
        break; // layout / space / unclassified: Phase 6 consolidation debt outside the regions.
    }
  });

  // 1. Same-key overrides: an anchored declaration must not be beaten by a later unanchored one.
  const groups = new Map<string, PlacedDecl[]>();
  for (const p of placed) {
    const key = `${p.media}||${p.selector}||${p.prop}`;
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const lastInRegion = group.filter((p) => p.inRegion).at(-1);
    if (!lastInRegion) continue;
    for (const p of group) {
      if (!p.inRegion && p.order > lastInRegion.order) {
        const key = `${p.media}||${p.selector}||${p.prop}||${p.value}`;
        if (PINNED_GLASS_ERA_NEUTRALIZERS.has(key)) {
          observedPinned.add(key);
          continue;
        }
        out.push(`styles.css:${String(p.line)} ${p.selector} { ${p.prop}: ${p.value} } overrides the anchored declaration (${lastInRegion.prop}: ${lastInRegion.value})`);
      }
    }
  }
  return { offenders: out, pinned: observedPinned };
}

/** Back-compat convenience: just the violations. */
export function effectiveCascadeOffenders(css: string): string[] {
  return effectiveCascade(css).offenders;
}

// --- TSX discipline (AST, closed allowed-class policy) -----------------------
const ROOM_TSX = ['src/App.tsx', 'src/shell.tsx', 'src/components.tsx'] as const;

// A className token may be ONLY these. wr-*/cd-* are the room and primitive namespaces; sr-only is
// the screen-reader utility; is-*/has-* are the semantic state classes. Nothing else — no Tailwind.
const ALLOWED_CLASS = /^(?:wr-[a-z0-9-]*|cd-[a-z0-9-]*|is-[a-z0-9-]*|has-[a-z0-9-]*|sr-only)$/;
const TAILWIND =
  /^(?:(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|divide|placeholder|caret|accent|shadow|outline)-(?:white|black|(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})|p[xytblr]?-\d|m[xytblr]?-\d|gap-\d|min-[wh]-\d+|max-w-\w+|w-full|h-full|flex(?:-\w+)?|grid|items-\w+|justify-\w+|inset-\d|z-\d+|relative|absolute|fixed|sticky|overflow-\w+|truncate|resize-\w+|scroll-mt-\d+|space-[xy]-\d|shrink-\d|ml-auto|text-(?:xs|sm|base|lg)|whitespace-\w+|font-(?:mono|sans|serif)|sm:\w+|disabled:\w+)$/;

const STYLE_ALLOWED_PROPS = new Set([
  'backgroundColor', 'color', 'borderColor',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
]);
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
const RAW_COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;

/** Check the literal class tokens of a fragment against the allowed / Tailwind policy. */
function checkFragment(fragment: string, offenders: string[]): void {
  for (const token of fragment.split(/\s+/).filter(Boolean)) {
    if (TAILWIND.test(token)) offenders.push(`Tailwind utility "${token}"`);
    else if (!ALLOWED_CLASS.test(token)) offenders.push(`disallowed class "${token}"`);
  }
}

/** Judge a className initializer expression. Literals (directly, or through a template, a ternary,
 *  a binary or a parenthesis) are inspected token-by-token; an undefined/null empty branch is
 *  permitted; anything else — a bare identifier, a member/element (map/object) lookup, a call, or a
 *  non-literal template span — is a closed-inspection violation. */
function classNameOffenders(node: ts.Node, source: ts.SourceFile): string[] {
  const offenders: string[] = [];
  const visit = (expr: ts.Node): void => {
    if (ts.isStringLiteralLike(expr)) {
      checkFragment(expr.text, offenders);
    } else if (ts.isTemplateExpression(expr)) {
      checkFragment(expr.head.text, offenders);
      for (const span of expr.templateSpans) {
        visit(span.expression);
        checkFragment(span.literal.text, offenders);
      }
    } else if (ts.isConditionalExpression(expr)) {
      visit(expr.whenTrue);
      visit(expr.whenFalse);
    } else if (ts.isBinaryExpression(expr)) {
      visit(expr.left);
      visit(expr.right);
    } else if (ts.isParenthesizedExpression(expr)) {
      visit(expr.expression);
    } else if (ts.isIdentifier(expr) && expr.text === 'undefined') {
      // permitted empty branch (`cond ? 'wr-x' : undefined`)
    } else if (expr.kind === ts.SyntaxKind.NullKeyword) {
      // permitted empty branch (`cond ? 'wr-x' : null`)
    } else {
      offenders.push(`non-literal className expression "${expr.getText(source)}"`);
    }
  };
  if (ts.isJsxExpression(node)) {
    if (node.expression) visit(node.expression);
  } else {
    visit(node);
  }
  return offenders;
}

/** Every TSX discipline violation in a room source file. */
export function tsxOffenders(tsx: string): string[] {
  const source = ts.createSourceFile('room.tsx', tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'className' && node.initializer) {
        offenders.push(...classNameOffenders(node.initializer, source));
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

// --- Tests -------------------------------------------------------------------
describe('room token discipline: the migrated CSS regions are structurally closed', () => {
  const css = read('src/styles.css');
  const regions = scannedRegions(css);

  it('scans every room region marked by harn:assume except the two exclusions', () => {
    // The canonical set is discovered, not hardcoded: every region marker is scanned unless it is
    // one of the two exclusions, each of which must still exist (on its own layer).
    expect(regions.length).toBeGreaterThan(0);
    for (const ref of EXCLUDED_REFS) {
      expect(regions.some((r) => r.ref === ref), `${ref} must be excluded`).toBe(false);
    }
    for (const [assume, ref] of [
      ['web-theme-accessible-modes', 'soft-editorial-token-layer'],
      ['pairing-code-enrollment-surfaces', 'pairing-code-surface-style'],
    ] as const) {
      expect(markerCount(css, assume, ref), `${ref} still exists`).toBe(1);
    }
  });

  it('has zero discipline violations in any scanned region', () => {
    const all: string[] = [];
    for (const { assume, ref } of regions) {
      const offenders = cssOffenders(regionText(css, assume, ref));
      if (offenders.length) all.push(`# ${ref}\n${offenders.join('\n')}`);
    }
    expect(all, all.join('\n\n')).toEqual([]);
  });

  it('does NOT parse the excluded legacy pairing region as a scanned region', () => {
    const pairing = regionText(css, 'pairing-code-enrollment-surfaces', 'pairing-code-surface-style');
    expect(regions.some((r) => r.ref === 'pairing-code-surface-style')).toBe(false);
    expect(pairing.length).toBeGreaterThan(0);
  });

  it('rejects each former CSS bypass — proven with synthetic negative fixtures', () => {
    const cases: [string, string][] = [
      ['calc-hidden unit', '.x { padding: calc(16px - 2px); }'],
      ['max-hidden unit', '.x { padding: max(10px, env(safe-area-inset-top)); }'],
      ['token-bearing shadow ring', '.x { box-shadow: 0 0 0 3px var(--cd-live-tint); }'],
      ['two-ring shadow', '.x { box-shadow: 0 0 0 2px var(--cd-surface), 0 0 0 4px var(--cd-agent); }'],
      ['raw seconds', '.x { animation: fade 1.6s var(--cd-ease-standard) both; }'],
      ['raw milliseconds', '.x { transition: color 200ms; }'],
      ['easing keyword', '.x { transition: color var(--cd-motion-fast) linear; }'],
      ['steps()', '.x { animation: run var(--cd-motion-base) steps(4); }'],
      ['cubic-bezier()', '.x { transition: color var(--cd-motion-fast) cubic-bezier(0, 0, 1, 1); }'],
      ['blanket padding', '.x { padding: 64px; }'],
      ['outline-offset literal', '.x { outline-offset: 2px; }'],
      ['unclassified property', '.x { background-image: url(x); }'],
      ['unclassified colour prop caret-color', '.x { caret-color: red; }'],
      ['off-allowlist named colour', '.x { color: firebrick; }'],
      ['border shorthand named colour', '.x { border: 1px solid aliceblue; }'],
      ['scrollbar-color named colour', '.x { scrollbar-color: rebeccapurple transparent; }'],
      ['hex colour', '.x { color: #abcdef; }'],
      ['rgb colour', '.x { background: rgb(0 0 0 / 0.2); }'],
      ['gradient in a non-background paint', '.x { color: linear-gradient(red, blue); }'],
      ['raw font shorthand', '.x { font: 14px/1.5 sans-serif; }'],
      ['raw font-family', '.x { font-family: Arial; }'],
      ['raw font-weight', '.x { font-weight: 700; }'],
      ['raw padding', '.x { padding: 17px; }'],
      ['generic percent spacing', '.x { gap: 5%; }'],
      ['raw radius', '.x { border-radius: 9px; }'],
      ['undeclared-shape shadow', '.x { box-shadow: 0 1px 2px #000; }'],
    ];
    for (const [name, fixture] of cases) {
      expect(cssOffenders(fixture).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
  });

  it('accepts each token-composed form — proven with synthetic positive fixtures', () => {
    const cases: [string, string][] = [
      ['color-mix over tokens', '.x { background: color-mix(in srgb, var(--cd-surface) 96%, transparent); }'],
      ['max(token, env())', '.x { padding: max(var(--cd-space-3), env(safe-area-inset-bottom)); }'],
      ['whole shadow token', '.x { box-shadow: var(--cd-elevate-float); }'],
      ['tokenised animation', '.x { animation: fade var(--cd-motion-base) var(--cd-ease-standard) both; }'],
      ['token ring shadow', '.x { box-shadow: 0 0 0 var(--cd-space-1) var(--cd-live-tint); }'],
      ['composite type', '.x { font: var(--cd-text-body); font-family: var(--cd-font-mono); }'],
      ['spacing tokens and negatives', '.x { margin: calc(var(--cd-space-3) * -1) 0 var(--cd-space-2) auto; }'],
      ['radius token and literal', '.x { border-radius: var(--cd-radius-pill); }'],
      ['radius closed literals', '.x { border-radius: 50%; }'],
      ['scrollbar-width and colour classified', '.x { scrollbar-width: thin; scrollbar-color: var(--cd-line-strong) transparent; }'],
      ['tap highlight and font-style classified', '.x { -webkit-tap-highlight-color: transparent; font-style: italic; }'],
    ];
    for (const [name, fixture] of cases) {
      expect(cssOffenders(fixture), `${name} should be clean`).toEqual([]);
    }
  });
});


// Fixture markers are assembled at runtime so the Harn scanner never reads a test fixture as a
// real anchor in this file.
const fixtureAssume = (id: string, ref: string): string => `/* harn:${'assume'} ${id} ref=${ref} */`;
const fixtureEnd = (id: string): string => `/* harn:${'end'} ${id} */`;

describe('room token discipline: the effective cascade, not only the anchored islands', () => {
  const css = read('src/styles.css');

  it('no rule outside the anchored regions overrides or pollutes an owned surface', () => {
    const offenders = effectiveCascadeOffenders(css);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the glass-era burn-down list is exact: every pinned neutralizer exists, nothing extra', () => {
    // Both directions pinned: a pinned tuple that disappears must be struck from the list in the
    // same diff (Phase 6 burn-down), and any new override cannot hide behind the pin set.
    const { pinned } = effectiveCascade(css);
    const missing = [...PINNED_GLASS_ERA_NEUTRALIZERS].filter((k) => !pinned.has(k));
    expect(missing, `pinned neutralizers no longer observed:\n${missing.join('\n')}`).toEqual([]);
    expect(pinned.size).toBe(PINNED_GLASS_ERA_NEUTRALIZERS.size);
  });

  it('rejects a later out-of-region same-key override of an anchored declaration', () => {
    const fixture = [
      fixtureAssume('demo-assume', 'demo-ref'),
      '.wr-demo { border-radius: var(--cd-radius-card); }',
      fixtureEnd('demo-assume'),
      '.wr-demo { border-radius: var(--cd-radius-pill); }',
    ].join('\n');
    const offenders = effectiveCascadeOffenders(fixture);
    expect(offenders.some((o) => o.includes('overrides the anchored declaration')), offenders.join('\n')).toBe(true);
  });

  it('does not flag an EARLIER legacy declaration the anchored region already beats', () => {
    const fixture = [
      '.wr-demo { border-radius: var(--cd-radius-pill); }',
      fixtureAssume('demo-assume', 'demo-ref'),
      '.wr-demo { border-radius: var(--cd-radius-card); }',
      fixtureEnd('demo-assume'),
    ].join('\n');
    expect(effectiveCascadeOffenders(fixture)).toEqual([]);
  });

  it('rejects an out-of-region rule that re-declares an owned class with a raw literal', () => {
    const fixture = [
      fixtureAssume('demo-assume', 'demo-ref'),
      '.wr-demo { color: var(--cd-text-body-color); }',
      fixtureEnd('demo-assume'),
      '.wr-demo strong { color: #ff0000; font-size: 13px; }',
    ].join('\n');
    const offenders = effectiveCascadeOffenders(fixture);
    expect(offenders.some((o) => o.includes('raw hex #ff0000')), offenders.join('\n')).toBe(true);
    expect(offenders.some((o) => o.includes('raw font-size')), offenders.join('\n')).toBe(true);
  });

  it('rejects nonzero letter-spacing anywhere in the file, owned class or not', () => {
    const fixture = '.legacy-anything { letter-spacing: 0.04em; }';
    const offenders = effectiveCascadeOffenders(fixture);
    expect(offenders.some((o) => o.includes('letter-spacing must be 0 everywhere')), offenders.join('\n')).toBe(true);
    expect(effectiveCascadeOffenders('.x { letter-spacing: 0; }')).toEqual([]);
  });

  it('tolerates out-of-region spacing geometry as Phase 6 debt without weakening paint', () => {
    const fixture = [
      fixtureAssume('demo-assume', 'demo-ref'),
      '.wr-demo { color: var(--cd-text-body-color); }',
      fixtureEnd('demo-assume'),
      '.wr-demo { padding: 17px; margin: 3px; }',
    ].join('\n');
    expect(effectiveCascadeOffenders(fixture)).toEqual([]);
  });

  it('judges the same selector separately per media context', () => {
    const fixture = [
      fixtureAssume('demo-assume', 'demo-ref'),
      '.wr-demo { color: var(--cd-text-body-color); }',
      '@media (width < 720px) { .wr-demo { color: var(--cd-text-strong); } }',
      fixtureEnd('demo-assume'),
      '@media (width < 720px) { .wr-demo { color: var(--cd-text-muted); } }',
    ].join('\n');
    const offenders = effectiveCascadeOffenders(fixture);
    expect(offenders.some((o) => o.includes('overrides the anchored declaration')), offenders.join('\n')).toBe(true);
  });
});

describe('room token discipline: the migrated TSX carries only closed, literal classes', () => {
  for (const path of ROOM_TSX) {
    it(`${path} carries no non-literal className, disallowed class, or non-literal style prop`, () => {
      const offenders = tsxOffenders(read(path));
      expect(offenders, `${path}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('rejects each TSX bypass — proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['palette utility', 'const A = () => <span className="text-zinc-500" />;'],
      ['text-white', 'const A = () => <span className="text-white" />;'],
      ['spacing utility', 'const A = () => <span className="px-3" />;'],
      ['flex utility', 'const A = () => <span className="flex items-center" />;'],
      ['bare disallowed class', 'const A = () => <span className="fancybox" />;'],
      ['utility inside a template span', 'const A = () => <span className={`wr-x ${on ? "px-2" : ""}`} />;'],
      ['bare identifier className', 'const A = () => <span className={cls} />;'],
      ['member-access className', 'const A = () => <span className={styles.root} />;'],
      ['indexed map className', 'const A = () => <span className={MAP[variant]} />;'],
      ['call className', 'const A = () => <span className={cx("wr-x")} />;'],
      ['non-literal template span', 'const A = () => <span className={`wr-run-status is-${run.status}`} />;'],
      ['non-literal style prop', 'const A = () => <span style={styleObject} />;'],
      ['style sets a forbidden property', 'const A = () => <span style={{ display: "flex" }} />;'],
      ['raw colour in a style prop', 'const A = () => <span style={{ backgroundColor: "#fff" }} />;'],
    ];
    for (const [name, fixture] of cases) {
      expect(tsxOffenders(fixture).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // Permitted: literal branches, an undefined/null empty else, and the accent projection.
    expect(tsxOffenders('const A = () => <span className={on ? "wr-x" : undefined} />;')).toEqual([]);
    expect(tsxOffenders('const A = () => <span className={on ? "wr-x" : null} />;')).toEqual([]);
    expect(tsxOffenders('const A = () => <span className={`wr-message ${mine ? "is-mine" : ""} sr-only`} />;')).toEqual([]);
    expect(tsxOffenders('const A = () => <span className="wr-room-dot is-live" style={{ backgroundColor: dotColor }} />;')).toEqual([]);
  });
});
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
