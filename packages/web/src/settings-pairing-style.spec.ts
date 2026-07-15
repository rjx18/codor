// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// harn:assume web-settings-pairing-match-soft-editorial-reference ref=soft-editorial-settings-pairing-token-discipline
// A closed guard over every stylesheet rule that references a class owned by the exact Phase 4
// CSS anchors, plus both migrated TSX sources. It rejects duplicates anywhere in the cascade,
// legacy variables, Tailwind utilities, raw paint/type/spacing/radius/shadow/motion, inline style,
// nonliteral class bypasses, and hand-authored SVG. The QR image paper is the sole fixed-white
// exception globally for these surfaces, keyed to its exact selector, property, and value.

const read = (path: string): string => readFileSync(path, 'utf8');

function region(source: string, assume: string, ref: string, comment: 'css' | 'tsx'): string {
  const open = comment === 'css'
    ? `/* harn:assume ${assume} ref=${ref} */`
    : `// harn:assume ${assume} ref=${ref}`;
  const close = comment === 'css'
    ? `/* harn:end ${assume} */`
    : `// harn:end ${assume}`;
  const start = source.indexOf(open);
  const end = source.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error(`missing anchored region ${assume}:${ref}`);
  return source.slice(start + open.length, end);
}

const VISUAL_ASSUME = 'web-settings-pairing-match-soft-editorial-reference';
const CODE_ASSUME = 'pairing-code-enrollment-surfaces';
const SAFE_PAINT = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none']);
const RAW_COLOR_FN = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
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
  'align-items', 'justify-content', 'justify-self',
  'grid-area', 'grid-template-columns', 'grid-template-rows',
  'cursor', 'content', 'appearance', 'opacity', 'transform',
  'text-align', 'text-transform', 'text-overflow', 'white-space', 'overflow-wrap',
  'text-decoration', 'list-style', 'object-fit', 'scroll-margin-top',
  'backdrop-filter', '-webkit-backdrop-filter',
]);

function varsOutsideV5(value: string): string[] {
  const out: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'var') return;
    const first = node.nodes[0];
    if (!(first && first.type === 'word' && first.value.startsWith('--cd-'))) {
      out.push(`non-v5 variable in ${value}`);
    }
  });
  return out;
}

function paintOffenders(value: string): string[] {
  const out: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (RAW_COLOR_FN.has(name)) out.push(`raw color function ${name}()`);
      return;
    }
    if (node.type !== 'word') return;
    const word = node.value.toLowerCase();
    if (word.startsWith('#')) out.push(`raw color ${node.value}`);
    else if (!valueParser.unit(word) && !SAFE_PAINT.has(word)
      && !['in', 'srgb', 'to', 'top', 'right', 'bottom', 'left', 'center'].includes(word)
      && !word.startsWith('--cd-')) out.push(`raw named color ${node.value}`);
  });
  return out;
}

function rawMetric(value: string): string[] {
  const out: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'word') return;
    const unit = valueParser.unit(node.value);
    if (!unit || Number(unit.number) === 0 || unit.unit === '') return;
    out.push(`raw metric ${node.value}`);
  });
  return out;
}

function cssOffenders(
  css: string,
  includeRule: (selector: string) => boolean = () => true,
): { offenders: string[]; whiteExceptions: string[] } {
  const offenders: string[] = [];
  const whiteExceptions: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!includeRule(rule.selector)) return;
    const selectors = rule.selector.split(',').map((selector) => selector.trim());
    rule.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      const label = `${rule.selector} { ${prop}: ${value} }`;
      if (prop.startsWith('--wr-') || value.includes('--wr-')) offenders.push(`${label}: legacy variable`);
      offenders.push(...varsOutsideV5(value).map((why) => `${label}: ${why}`));

      if (value.toLowerCase() === '#fff') {
        if (selectors.length === 1 && selectors[0] === '.wr-qr-paper' && prop === 'background') {
          whiteExceptions.push('.wr-qr-paper||background||#fff');
        } else {
          offenders.push(`${label}: fixed white outside QR paper exception`);
        }
        return;
      }

      if (PAINT_PROPS.test(prop)) {
        offenders.push(...paintOffenders(value).map((why) => `${label}: ${why}`));
      } else if (BORDER_PROPS.test(prop)) {
        const paint = value.replace(/\b(?:[12]px|0|solid|none)\b/g, ' ');
        offenders.push(...paintOffenders(paint).map((why) => `${label}: ${why}`));
        const widths = rawMetric(value).filter((why) => !/\b[12]px\b/.test(why));
        offenders.push(...widths.map((why) => `${label}: ${why}`));
      } else if (METRIC_PROPS.test(prop) || prop === 'border-radius') {
        offenders.push(...rawMetric(value).map((why) => `${label}: ${why}`));
      } else if (TYPE_PROPS.test(prop)) {
        const safe = value === '0' || value === 'inherit' || value === 'normal'
          || value === 'italic' || /^var\(--cd-(?:text|font)-[\w-]+\)$/.test(value);
        if (!safe) offenders.push(`${label}: raw type value`);
      } else if (prop === 'box-shadow') {
        if (value !== 'none' && !/^var\(--cd-[\w-]+\)$/.test(value)) offenders.push(`${label}: raw shadow`);
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
  return { offenders, whiteExceptions };
}

function ownedSurfaceClasses(css: string): Set<string> {
  const owned = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.((?:wr)-[a-z0-9-]+)/g)) owned.add(match[1]);
  });
  return owned;
}

function referencesOwnedSurfaceClass(selector: string, owned: ReadonlySet<string>): boolean {
  return [...selector.matchAll(/\.((?:wr)-[a-z0-9-]+)/g)]
    .some((match) => owned.has(match[1]));
}

const ALLOWED_CLASS = /^(?:wr-[a-z0-9-]*|cd-[a-z0-9-]*|is-[a-z0-9-]*|sr-only)$/;
const TAILWIND = /^(?:p[xytblr]?-[\w-]+|m[xytblr]?-[\w-]+|gap-[\w-]+|min-[wh]-[\w-]+|max-[wh]-[\w-]+|w-full|h-full|flex(?:-[\w-]+)?|grid|items-[\w-]+|justify-[\w-]+|text-(?:xs|sm|base|lg|white|black|zinc-[\w-]+)|bg-[\w-]+|border-[\w-]+|disabled:[\w-]+)$/;

function tsxOffenders(sourceText: string): string[] {
  const source = ts.createSourceFile('surface.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'style') offenders.push('inline style prop');
      if (name === 'className' && node.initializer) {
        if (!ts.isStringLiteral(node.initializer)) {
          offenders.push(`nonliteral className ${node.initializer.getText(source)}`);
        } else {
          for (const token of node.initializer.text.split(/\s+/).filter(Boolean)) {
            if (TAILWIND.test(token)) offenders.push(`Tailwind utility ${token}`);
            else if (!ALLOWED_CLASS.test(token)) offenders.push(`unapproved class ${token}`);
          }
        }
      }
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(source).toLowerCase() === 'svg') offenders.push('hand-authored svg');
    ts.forEachChild(node, walk);
  };
  walk(source);
  return offenders;
}

describe('Settings and Pairing Phase 4 token discipline', () => {
  const stylesheet = read('src/styles.css');
  const anchoredCss = [
    region(stylesheet, VISUAL_ASSUME, 'soft-editorial-settings-pairing-style', 'css'),
    region(stylesheet, CODE_ASSUME, 'pairing-code-surface-style', 'css'),
  ].join('\n');
  const owned = ownedSurfaceClasses(anchoredCss);
  const includesSurfaceRule = (selector: string): boolean => referencesOwnedSurfaceClass(selector, owned);

  it('keeps every contributing surface rule on v5 tokens with one global QR paper exception', () => {
    expect(owned.size).toBeGreaterThan(50);
    const result = cssOffenders(stylesheet, includesSurfaceRule);
    expect(result.offenders, result.offenders.join('\n')).toEqual([]);
    expect(result.whiteExceptions).toEqual(['.wr-qr-paper||background||#fff']);
  });

  it('keeps both migrated TSX files literal, utility-free, style-free, and Lucide-only', () => {
    for (const path of ['src/SettingsPage.tsx', 'src/pairing.tsx']) {
      const offenders = tsxOffenders(read(path));
      expect(offenders, `${path}:\n${offenders.join('\n')}`).toEqual([]);
    }
  });

  it('proves the CSS guard rejects each prohibited bypass', () => {
    const fixtures = [
      '.x { color: var(--wr-text); }',
      '.x { padding: 17px; }',
      '.x { border-radius: 9px; }',
      '.x { color: #abcdef; }',
      '.x { background: rgb(0 0 0); }',
      '.x { font-size: 14px; }',
      '.x { box-shadow: 0 1px 2px #000; }',
      '.x { transition: color 180ms ease; }',
      '.not-qr { background: #fff; }',
    ];
    for (const fixture of fixtures) expect(cssOffenders(fixture).offenders.length, fixture).toBeGreaterThan(0);
  });

  it('proves duplicate surface rules cannot evade the guard outside the anchored regions', () => {
    const fixtures = [
      '.wr-settings-nav { color: var(--wr-text); }',
      '.wr-settings-section { animation: legacy-enter 220ms ease both; }',
      '.wr-qr-pane img { background: #fff; }',
      'body .wr-qr-paper { background: #fff; }',
    ];
    for (const fixture of fixtures) {
      const result = cssOffenders(`${stylesheet}\n${fixture}`, includesSurfaceRule);
      expect(result.offenders.length, fixture).toBeGreaterThan(0);
    }
  });

  it('proves the TSX guard rejects utilities, inline style, nonliteral classes, and raw svg', () => {
    const fixtures = [
      'const A = () => <div className="px-4" />;',
      'const A = () => <div style={{ color: "red" }} />;',
      'const A = () => <div className={classes.root} />;',
      'const A = () => <svg><path /></svg>;',
    ];
    for (const fixture of fixtures) expect(tsxOffenders(fixture).length, fixture).toBeGreaterThan(0);
  });
});
// harn:end web-settings-pairing-match-soft-editorial-reference
