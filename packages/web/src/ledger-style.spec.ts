// @vitest-environment node
import { readFileSync } from 'node:fs';

import { wcagContrast } from 'culori';
import postcss, { type Root } from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// harn:assume graph-derived-from-vault-links-readonly-v5 ref=soft-editorial-ledger-token-discipline
// The Ledger guard owns every selector introduced by the exact v5 graph-style anchor, then
// follows those classes through the full cascade. It is deliberately closed: presentation
// needs a classified policy, SVG is limited to the functional graph vocabulary, and the
// semantic strokes are measured against the surfaces they actually meet in both themes.

const ASSUME = 'graph-derived-from-vault-links-readonly-v5';
const STYLE_REF = 'soft-editorial-ledger-style';
const SAFE_PAINT = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none']);
const METRIC_PROPS = /^(?:margin|padding)(?:-(?:top|right|bottom|left))?$|^(?:gap|row-gap|column-gap|outline-offset)$/;
const PAINT_PROPS = /^(?:color|fill|stroke|background|background-color|border-color|border-(?:top|right|bottom|left)-color)$/;
const BORDER_PROPS = /^(?:border|border-(?:top|right|bottom|left)|outline)$/;
const TYPE_PROPS = /^(?:font|font-family|font-size|font-weight|font-style|line-height|letter-spacing)$/;
const MOTION_PROPS = /^(?:animation|transition)(?:-.+)?$/;
const GEOMETRY_PROPS = new Set([
  'display', 'position', 'isolation', 'overflow', 'overflow-x', 'overflow-y',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'top', 'right', 'bottom', 'left', 'inset', 'z-index',
  'flex', 'flex-basis', 'flex-direction', 'flex-wrap', 'flex-shrink',
  'align-items', 'justify-content', 'justify-self', 'place-items',
  'grid-area', 'grid-row', 'grid-column', 'grid-template-columns', 'grid-template-rows',
  'cursor', 'content', 'appearance', 'opacity', 'transform', 'transform-origin',
  'text-align', 'text-transform', 'text-overflow', 'white-space', 'overflow-wrap',
  'text-decoration', 'list-style', 'object-fit', 'scroll-margin-top',
  'pointer-events', 'touch-action', 'paint-order', 'stroke-linejoin', 'stroke-width',
  'vector-effect', '-webkit-tap-highlight-color',
]);

const read = (path: string): string => readFileSync(path, 'utf8');

function region(source: string, assumption: string, ref: string): string {
  const open = `/* harn:assume ${assumption} ref=${ref} */`;
  const close = `/* harn:end ${assumption} */`;
  const start = source.indexOf(open);
  const end = source.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error(`missing anchored region ${assumption}:${ref}`);
  if (source.indexOf(open, start + open.length) !== -1) throw new Error(`duplicate anchor ${assumption}:${ref}`);
  return source.slice(start + open.length, end);
}

function ownedClasses(css: string): Set<string> {
  const out = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.(wr-ledger-[a-z0-9-]+)/g)) out.add(match[1]);
  });
  return out;
}

function referencesOwned(selector: string, owned: ReadonlySet<string>): boolean {
  return [...selector.matchAll(/\.(wr-ledger-[a-z0-9-]+)/g)].some((match) => owned.has(match[1]));
}

function declaredTokens(root: Root): Set<string> {
  const out = new Set<string>();
  root.walkDecls(/^--cd-/, (decl) => { out.add(decl.prop); });
  return out;
}

function tokenReferences(value: string): string[] {
  const out: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'var') return;
    const first = node.nodes[0];
    if (first?.type === 'word') out.push(first.value);
  });
  return out;
}

function rawMetrics(value: string): string[] {
  const out: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'word') return;
    const unit = valueParser.unit(node.value);
    if (!unit || Number(unit.number) === 0 || unit.unit === '') return;
    out.push(node.value);
  });
  return out;
}

function paintSafe(value: string): boolean {
  const parsed = valueParser(value);
  let safe = true;
  parsed.walk((node) => {
    if (!safe) return false;
    if (node.type === 'function') {
      if (node.value.toLowerCase() !== 'var') safe = false;
      else {
        const first = node.nodes[0];
        if (first?.type !== 'word' || !first.value.startsWith('--cd-')) safe = false;
      }
      return false;
    }
    if (node.type !== 'word') return undefined;
    const word = node.value.toLowerCase();
    if (!SAFE_PAINT.has(word)) safe = false;
    return undefined;
  });
  return safe;
}

function borderSafe(value: string): boolean {
  const stripped = value
    .replace(/var\(--cd-[\w-]+\)/g, '')
    .replace(/\b(?:0|1px|2px|solid|none|transparent|currentColor|inherit)\b/gi, '')
    .trim();
  return stripped === '';
}

function cssOffenders(stylesheet: string, owned: ReadonlySet<string>): string[] {
  const root = postcss.parse(stylesheet);
  const tokens = declaredTokens(root);
  const offenders: string[] = [];
  root.walkRules((rule) => {
    if (!referencesOwned(rule.selector, owned)) return;
    rule.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      const label = `${rule.selector} { ${prop}: ${value} }`;
      if (prop.startsWith('--wr-') || value.includes('--wr-')) offenders.push(`${label}: legacy token`);
      for (const token of tokenReferences(value)) {
        if (!token.startsWith('--cd-')) offenders.push(`${label}: non-v5 token ${token}`);
        else if (!tokens.has(token)) offenders.push(`${label}: undeclared token ${token}`);
      }

      if (PAINT_PROPS.test(prop)) {
        if (!paintSafe(value)) offenders.push(`${label}: paint must be a v5 token or safe keyword`);
      } else if (BORDER_PROPS.test(prop)) {
        if (!borderSafe(value)) offenders.push(`${label}: border must use a token and a 1-2px hairline`);
      } else if (METRIC_PROPS.test(prop)) {
        const raw = rawMetrics(value);
        const panelGeometry = rule.selector === '.wr-ledger-grid'
          && (prop === 'gap' || prop === 'padding') && raw.every((metric) => metric === '10px');
        if (raw.length > 0 && !panelGeometry) offenders.push(`${label}: raw spacing ${raw.join(', ')}`);
      } else if (prop === 'border-radius') {
        if (value !== '0' && !/^var\(--cd-radius-[\w-]+\)(?: var\(--cd-radius-[\w-]+\)| 0)*$/.test(value)) {
          offenders.push(`${label}: radius must use the v5 scale`);
        }
      } else if (TYPE_PROPS.test(prop)) {
        const safe = value === '0' || value === 'normal' || value === 'inherit'
          || /^var\(--cd-(?:text|font)-[\w-]+\)$/.test(value);
        if (!safe) offenders.push(`${label}: raw type`);
      } else if (prop === 'box-shadow') {
        if (value !== 'none' && !/^var\(--cd-elevate-[\w-]+\)$/.test(value)) offenders.push(`${label}: raw shadow`);
      } else if (MOTION_PROPS.test(prop)) {
        const withoutTokens = value.replace(/var\(--cd-[\w-]+\)/g, '');
        if (/\b\d*\.?\d+(?:ms|s)\b|\b(?:ease|ease-in|ease-out|ease-in-out|linear)\b|cubic-bezier\(/.test(withoutTokens)) {
          offenders.push(`${label}: raw motion`);
        }
      } else if (!GEOMETRY_PROPS.has(prop) && !prop.startsWith('--')) {
        offenders.push(`${label}: unclassified presentation property`);
      }
    });
  });
  return offenders;
}

const ALLOWED_CLASS = /^(?:wr-[a-z0-9-]*|cd-[a-z0-9-]*|sr-only)$/;
const SVG_TAGS: Record<string, ReadonlySet<string>> = {
  svg: new Set(['viewBox', 'role', 'aria-label']),
  g: new Set([
    'key', 'transform', 'data-testid', 'className', 'data-node-type', 'data-selected',
    'role', 'tabIndex', 'aria-label', 'aria-describedby', 'onClick', 'onKeyDown',
  ]),
  line: new Set(['key', 'className', 'x1', 'y1', 'x2', 'y2', 'strokeWidth', 'vectorEffect']),
  circle: new Set(['aria-hidden', 'className', 'r', 'strokeWidth', 'vectorEffect']),
  text: new Set(['x', 'y', 'paintOrder', 'strokeWidth', 'strokeLinejoin']),
};

function tsxOffenders(sourceText: string): string[] {
  const source = ts.createSourceFile('LedgerGraph.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'style') offenders.push('inline style prop');
      if (name === 'className' && node.initializer) {
        if (!ts.isStringLiteral(node.initializer)) offenders.push(`nonliteral className ${node.initializer.getText(source)}`);
        else for (const token of node.initializer.text.split(/\s+/).filter(Boolean)) {
          if (!ALLOWED_CLASS.test(token)) offenders.push(`unapproved class ${token}`);
        }
      }
      if (['color', 'fill', 'stroke'].includes(name)) {
        const text = node.initializer?.getText(source) ?? '';
        if (!/["'](?:currentColor|none)["']/.test(text)) offenders.push(`literal SVG paint ${name}=${text}`);
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (/^[a-z]/.test(tag) && ['svg', 'g', 'line', 'circle', 'text'].includes(tag)) {
        const allowed = SVG_TAGS[tag]!;
        for (const prop of node.attributes.properties) {
          if (!ts.isJsxAttribute(prop)) {
            offenders.push(`spread attribute on <${tag}>`);
            continue;
          }
          const name = prop.name.getText(source);
          if (!allowed.has(name)) offenders.push(`unapproved <${tag}> attribute ${name}`);
        }
      } else if (/^[a-z]/.test(tag) && ['path', 'polygon', 'polyline', 'ellipse'].includes(tag)) {
        offenders.push(`unapproved SVG element <${tag}>`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return offenders;
}

function themeMaps(stylesheet: string): { light: Map<string, string>; dark: Map<string, string> } {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  postcss.parse(stylesheet).walkRules((rule) => {
    const target = rule.selector === ':root' ? light
      : rule.selector === ":root[data-theme='dark']" ? dark
        : undefined;
    if (!target) return;
    rule.walkDecls(/^--cd-/, (decl) => { target.set(decl.prop, decl.value.trim()); });
  });
  return { light, dark };
}

function resolveToken(map: ReadonlyMap<string, string>, token: string): string {
  let value = map.get(token);
  const seen = new Set<string>();
  while (value?.startsWith('var(')) {
    const next = value.match(/var\((--cd-[\w-]+)\)/)?.[1];
    if (!next || seen.has(next)) throw new Error(`dead token chain from ${token}`);
    seen.add(next);
    value = map.get(next);
  }
  if (!value) throw new Error(`missing token ${token}`);
  return value;
}

describe('Ledger Phase 5 structural discipline', () => {
  const stylesheet = read('src/styles.css');
  const ledgerRegion = region(stylesheet, ASSUME, STYLE_REF);
  const owned = ownedClasses(ledgerRegion);

  it('keeps every Ledger-owned rule on the v5 token layer across the whole cascade', () => {
    expect(owned.size).toBeGreaterThan(20);
    const offenders = cssOffenders(stylesheet, owned);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps LedgerGraph literal-class, utility-free, style-free, and functional-SVG-only', () => {
    const offenders = tsxOffenders(read('src/LedgerGraph.tsx'));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps every semantic graph stroke at 3:1 or better on its adjacent surface', () => {
    const maps = themeMaps(stylesheet);
    const pairs = [
      ['--cd-text-muted', '--cd-surface-muted'],
      ['--cd-agent', '--cd-surface-muted'],
      ['--cd-warn', '--cd-surface-muted'],
      ['--cd-live', '--cd-surface-muted'],
      ['--cd-text-strong', '--cd-surface-muted'],
      ['--cd-agent', '--cd-agent-tint'],
      ['--cd-warn', '--cd-warn-tint'],
      ['--cd-live', '--cd-live-tint'],
    ] as const;
    for (const [theme, map] of Object.entries(maps)) {
      for (const [foreground, background] of pairs) {
        const ratio = wcagContrast(resolveToken(map, foreground), resolveToken(map, background));
        expect(ratio, `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('proves the CSS guard rejects every prohibited bypass', () => {
    const fixtures = [
      '.wr-ledger-x { color: var(--wr-text); }',
      '.wr-ledger-x { padding: 1rem; }',
      '.wr-ledger-x { border-radius: 9px; }',
      '.wr-ledger-x { color: aliceblue; }',
      '.wr-ledger-x { background: linear-gradient(red, blue); }',
      '.wr-ledger-x { font-size: 14px; }',
      '.wr-ledger-x { box-shadow: 0 1px 2px #000; }',
      '.wr-ledger-x { transition: color 180ms ease; }',
      '.wr-ledger-x { scrollbar-color: red blue; }',
    ];
    for (const fixture of fixtures) {
      const fixtureOwned = new Set(['wr-ledger-x']);
      expect(cssOffenders(`${stylesheet}\n${fixture}`, fixtureOwned).length, fixture).toBeGreaterThan(0);
    }
  });

  it('proves the TSX guard rejects its class, style, paint, and SVG bypasses', () => {
    const fixtures = [
      'const A = () => <div className="px-4" />;',
      'const A = () => <div className={classes.root} />;',
      'const A = () => <div style={{ color: "red" }} />;',
      'const A = () => <svg fill="red" />;',
      'const A = () => <svg><path /></svg>;',
      'const A = () => <svg><circle cx={1} r={6} /></svg>;',
    ];
    for (const fixture of fixtures) expect(tsxOffenders(fixture).length, fixture).toBeGreaterThan(0);
  });
});
// harn:end graph-derived-from-vault-links-readonly-v5
