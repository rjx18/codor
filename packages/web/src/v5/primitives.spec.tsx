// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Avatar, Button, IconButton, Input, SegmentedTabs, TypingIndicator } from './primitives.js';

// React reads this global to decide whether act() is supported; set it around this file's
// run and restore it, so the flag stays quiet here without leaking into sibling specs.
const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let priorActEnv: boolean | undefined;
beforeAll(() => {
  priorActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = priorActEnv;
});

const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const CSS = read('src/v5/primitives.css');
const TSX = read('src/v5/primitives.tsx');
const LAYER = read('src/styles.css');

// --- Structural CSS discipline ------------------------------------------------
// Both stylesheets are parsed with PostCSS, not regex, so a declaration inside a comment or
// a string cannot satisfy a reference.

/** Every --cd-* token a stylesheet actually declares (parsed, so comments never count). */
function declaredTokens(css: string): Set<string> {
  const names = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    if (decl.prop.startsWith('--cd-')) names.add(decl.prop);
  });
  return names;
}

/** The --cd-* values a theme block declares, for computing dot/background contrast. */
function themeTokens(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  postcss.parse(LAYER).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(/^--cd-/, (decl) => {
      found.set(decl.prop, decl.value.trim());
    });
  });
  return found;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Property-scoped geometry allowlist the token layer cannot express.
const AVATAR_SIZES = new Set([32, 34, 38, 40]);
const DOT_SIZES = new Set([6, 7, 9, 12]);
const BORDER_WIDTHS = new Set([1, 2]);
const ICON_SIZES = [14, 15, 17, 18];

// Any colour-producing function is forbidden as a literal paint.
const COLOUR_FNS = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)$/i;

// Paint-bearing properties: their colour component must be a --cd-* token or a safe keyword,
// so a named colour, a CSS system colour, a hex or a colour function is rejected without
// enumerating a colour list. The border and outline shorthands (and their side longhands) are
// included, since they carry a colour alongside a width and a style.
const PAINT_PROPS = new Set([
  'color', 'background', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke',
  'border', 'outline',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
]);
// Words allowed in a paint value besides a var() token: the paint keywords and the border
// styles that ride in a border/outline shorthand. A width literal is judged by the geometry pass.
const PAINT_KEYWORDS = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none',
  'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden',
]);

// Any raw length or percentage literal — px is only sometimes allowed, every other unit never.
const LENGTH = /^-?\d*\.?\d+(px|rem|em|ex|ch|vh|vw|vmin|vmax|pt|pc|cm|mm|in|q|%)$/i;

/** Every discipline violation in a stylesheet, given the tokens the layer declares. */
export function cssOffenders(css: string, declared: Set<string>): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    const sel = rule.selector;
    // Exact class membership, not substring: `.cd-avatar-x` yields class `cd-avatar-x`, so it
    // cannot borrow the avatar size set.
    const classes = new Set([...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!));
    const sizeSet = classes.has('cd-avatar')
      ? AVATAR_SIZES
      : classes.has('cd-status-dot') || classes.has('cd-typing-dot')
        ? DOT_SIZES
        : null;

    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--cd-')) out.push(`${sel}: declares local token ${decl.prop}`);
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      const parsed = valueParser(value);

      // Token references must be declared by the layer.
      for (const [, name] of value.matchAll(/var\(\s*(--cd-[\w-]+)/g)) {
        if (!declared.has(name!)) out.push(`${prop}: consumes undeclared ${name!}`);
      }

      // No colour function or hex literal on any property.
      parsed.walk((node) => {
        if (node.type === 'function' && COLOUR_FNS.test(node.value)) {
          out.push(`${prop}: ${value} (colour function ${node.value})`);
        }
        if (node.type === 'word' && /^#[0-9a-f]{3,8}$/i.test(node.value)) {
          out.push(`${prop}: ${value} (hex)`);
        }
      });

      // Paint-bearing properties: every bare word must be a safe keyword or a length (the width
      // component); the colour itself must arrive through a var() token. A stray identifier —
      // aliceblue, CanvasText — is a raw colour.
      if (PAINT_PROPS.has(prop)) {
        parsed.walk((node) => {
          if (node.type === 'function') return false; // var()/colour-fn already judged; skip its args
          if (node.type !== 'word') return undefined;
          const w = node.value.toLowerCase();
          if (PAINT_KEYWORDS.has(w) || LENGTH.test(node.value) || /^-?\d*\.?\d+$/.test(node.value)) {
            return undefined;
          }
          out.push(`${prop}: ${value} (raw paint "${node.value}")`);
          return undefined;
        });
      }

      // font and every font-* longhand, and both shadows, must be a single --cd-* token.
      if (prop === 'font' || prop.startsWith('font-')) {
        if (!/^var\(--cd-[\w-]+\)$/.test(value)) out.push(`${prop}: ${value} (raw font)`);
      }
      if (prop === 'box-shadow' || prop === 'text-shadow') {
        if (!/^var\(--cd-[\w-]+\)$/.test(value)) out.push(`${prop}: ${value} (raw shadow)`);
      }
      // border-radius must be a token: any px or % literal is a raw radius.
      if (prop === 'border-radius' && !/^var\(--cd-radius-[\w-]+\)$/.test(value)) {
        out.push(`${prop}: ${value} (raw radius)`);
      }
      // line-height must be a token when set standalone.
      if (prop === 'line-height' && !/^var\(--cd-/.test(value)) {
        out.push(`${prop}: ${value} (raw line-height)`);
      }

      // Geometry: any raw length literal must be an allowlisted px for this exact property.
      parsed.walk((node) => {
        if (node.type !== 'word' || !LENGTH.test(node.value)) return;
        const px = /^(\d+)px$/.exec(node.value);
        const v = px ? Number(px[1]) : Number.NaN;
        const ok =
          prop === 'width' || prop === 'height'
            ? sizeSet !== null && sizeSet.has(v)
            : prop === 'min-width' || prop === 'min-height'
              ? Number.isFinite(v) && v >= 44
              : prop === 'border-width' || prop === 'outline-width' || prop === 'border' || prop === 'outline'
                ? BORDER_WIDTHS.has(v)
                : false;
        if (!ok) out.push(`${prop}: ${value} (${node.value} not allowed here)`);
      });
    });
  });
  return out;
}

/** Every component-discipline violation in the primitives TSX source. */
export function tsxOffenders(tsx: string): string[] {
  const source = ts.createSourceFile('primitives.tsx', tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  // Tailwind palette utilities: a numbered colour ramp, or the suffixless white/black.
  const PALETTE =
    /\b(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|divide|placeholder|caret|accent|shadow|outline)-(?:white|black|(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/;
  const literalSize = (attr: ts.JsxAttribute): number | null => {
    const init = attr.initializer;
    return init && ts.isJsxExpression(init) && init.expression && ts.isNumericLiteral(init.expression)
      ? Number(init.expression.text)
      : null;
  };
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style') offenders.push('inline style prop');
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === 'svg'
    ) {
      offenders.push('hand-authored <svg>');
    }
    // Every Lucide icon render — aliased to <Icon> in this module — must carry an allowlisted
    // numeric-literal size; a missing size silently restores Lucide's 24px default.
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === 'Icon'
    ) {
      const sizeAttr = node.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === 'size',
      );
      if (!sizeAttr) offenders.push('<Icon> without a size');
      else {
        const size = literalSize(sizeAttr);
        if (size === null) offenders.push('<Icon> with a non-literal size');
        else if (!ICON_SIZES.includes(size)) offenders.push(`icon size ${String(size)}`);
      }
    }
    if (ts.isStringLiteralLike(node) && PALETTE.test(node.text)) {
      offenders.push(`palette utility "${node.text}"`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return offenders;
}

// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-token-discipline
describe('primitive stylesheet discipline', () => {
  const declared = declaredTokens(LAYER);

  it('has zero discipline violations', () => {
    const offenders = cssOffenders(CSS, declared);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('gives every interactive selector both a 44px min-width and min-height', () => {
    const dims = new Map<string, { w?: number; h?: number }>();
    postcss.parse(CSS).walkRules((rule) => {
      rule.walkDecls('min-width', (d) => {
        const px = /^(\d+)px$/.exec(d.value.trim());
        if (px) dims.set(rule.selector, { ...dims.get(rule.selector), w: Number(px[1]) });
      });
      rule.walkDecls('min-height', (d) => {
        const px = /^(\d+)px$/.exec(d.value.trim());
        if (px) dims.set(rule.selector, { ...dims.get(rule.selector), h: Number(px[1]) });
      });
    });
    for (const selector of ['.cd-button', '.cd-button-icon', '.cd-input', '.cd-tab']) {
      const d = dims.get(selector) ?? {};
      expect(d.w ?? 0, `${selector} min-width`).toBeGreaterThanOrEqual(44);
      expect(d.h ?? 0, `${selector} min-height`).toBeGreaterThanOrEqual(44);
    }
  });

  it('rejects each former CSS bypass — proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['oklch', '.x { color: oklch(0.7 0.1 200); }'],
      ['color-mix', '.x { background: color-mix(in srgb, red, blue); }'],
      ['named colour', '.x { color: rebeccapurple; }'],
      ['aliceblue (off-blacklist named colour)', '.x { color: aliceblue; }'],
      ['system colour', '.x { color: CanvasText; }'],
      ['hex', '.x { color: #abcdef; }'],
      ['border shorthand with a named colour', '.x { border: 1px solid aliceblue; }'],
      ['outline shorthand with a system colour', '.x { outline: 2px solid CanvasText; }'],
      ['border-color longhand named colour', '.x { border-color: aliceblue; }'],
      ['raw font shorthand', '.x { font: 14px/1.5 sans-serif; }'],
      ['raw font-family', '.x { font-family: Arial; }'],
      ['raw font-weight', '.x { font-weight: 700; }'],
      ['raw box-shadow', '.x { box-shadow: 0 1px 2px #000; }'],
      ['raw text-shadow', '.x { text-shadow: 0 1px 2px black; }'],
      ['border-radius percent', '.x { border-radius: 50%; }'],
      ['border-radius px', '.x { border-radius: 1px; }'],
      ['raw line-height', '.x { line-height: 1.5; }'],
      ['rem spacing', '.x { padding: 1rem; }'],
      ['em spacing', '.x { gap: 2em; }'],
      ['avatar using a dot size', '.cd-avatar { width: 6px; }'],
      ['near-miss avatar class cannot borrow an avatar size', '.cd-avatar-x { width: 38px; }'],
      ['padding literal', '.x { padding: 14px; }'],
      ['gap literal', '.x { gap: 44px; }'],
      ['outline-offset literal', '.x { outline-offset: 2px; }'],
      ['undeclared token', '.x { color: var(--cd-nonexistent); }'],
    ];
    for (const [name, css] of cases) {
      expect(cssOffenders(css, declared).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // A token declared only inside a comment must not satisfy a reference.
    const commentOnly = declaredTokens(':root { /* --cd-ghost: red; */ }');
    expect(commentOnly.has('--cd-ghost')).toBe(false);
  });

  it('keeps every status dot at least 3:1 against the avatar background, in both themes', () => {
    // Read the status → token mapping straight from the stylesheet, so a regression there — say
    // reverting .cd-status-idle to a decorative token — fails here rather than a hardcoded map.
    const statusBg = new Map<string, string>();
    postcss.parse(CSS).walkRules((rule) => {
      const m = /^\.cd-status-(live|idle|error)$/.exec(rule.selector.trim());
      if (!m) return;
      rule.walkDecls('background', (d) => {
        const ref = /^var\(\s*(--cd-[\w-]+)\s*\)$/.exec(d.value.trim());
        if (ref) statusBg.set(m[1]!, ref[1]!);
      });
    });
    expect([...statusBg.keys()].sort()).toEqual(['error', 'idle', 'live']);

    for (const [theme, selector] of [
      ['light', ':root'],
      ['dark', ":root[data-theme='dark']"],
    ] as const) {
      const t = themeTokens(selector);
      const bg = t.get('--cd-agent-tint')!;
      for (const [state, token] of statusBg) {
        const ratio = contrast(t.get(token)!, bg);
        expect(ratio, `${state} dot (${token}) on avatar in ${theme} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('primitive component discipline', () => {
  it('carries no inline style, no palette utility, no hand-authored svg, and gives every icon an allowlisted size', () => {
    const offenders = tsxOffenders(TSX);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('rejects each former TSX bypass — proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['inline style', 'const A = () => <button style={{ color: "red" }} />;'],
      ['hand-authored svg', 'const A = () => <svg viewBox="0 0 1 1" />;'],
      ['text-white utility', 'const A = () => <span className="text-white" />;'],
      ['bg-black utility', 'const A = () => <span className="bg-black" />;'],
      ['numbered palette utility', 'const A = () => <span className="text-zinc-500" />;'],
      ['missing icon size', 'const A = () => <Icon aria-hidden />;'],
      ['non-literal icon size', 'const A = () => <Icon size={n} />;'],
      ['off-allowlist icon size', 'const A = () => <Icon size={24} />;'],
    ];
    for (const [name, tsx] of cases) {
      expect(tsxOffenders(tsx).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
  });
});
// harn:end web-v5-primitives-consume-only-tokens

// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-render-regression
function mount(node: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('primitive semantics', () => {
  it('names an icon button and hides its icon from the accessibility tree', () => {
    const { Search } = require('lucide-react') as { Search: never };
    const { container, cleanup } = mount(<IconButton icon={Search} label="Search channels" />);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Search channels');
    expect(button.classList.contains('cd-button')).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
  });

  it('programmatically labels its input', () => {
    const { container, cleanup } = mount(<Input label="Message the channel" />);
    const input = container.querySelector('input')!;
    const label = container.querySelector('label')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.textContent).toBe('Message the channel');
    cleanup();
  });

  it('exposes a tablist whose selected tab is marked and moves under arrow keys', () => {
    function Harness(): JSX.Element {
      const tabs = [
        { id: 'diff', label: 'Diff' },
        { id: 'preview', label: 'Preview' },
        { id: 'members', label: 'Members' },
      ] as const;
      const [selected, setSelected] = useState<(typeof tabs)[number]['id']>('diff');
      return <SegmentedTabs label="Context" tabs={tabs} selected={selected} onSelect={setSelected} />;
    }
    const { container, cleanup } = mount(<Harness />);
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Context');
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    act(() => {
      tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const after = [...container.querySelectorAll('[role="tab"]')];
    expect(after[0]!.getAttribute('aria-selected')).toBe('false');
    expect(after[1]!.getAttribute('aria-selected')).toBe('true');
    cleanup();
  });

  it('announces the typing indicator through a status role', () => {
    const { container, cleanup } = mount(<TypingIndicator who="@reviewer" />);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('@reviewer is typing');
    cleanup();
  });

  it('gives each avatar status dot text a screen reader can read', () => {
    for (const [status, text] of [['live', 'Live'], ['idle', 'Idle'], ['error', 'Error']] as const) {
      const { container, cleanup } = mount(<Avatar initials="rv" status={status} />);
      expect(container.querySelector('.cd-status-dot')?.textContent).toBe(text);
      cleanup();
    }
  });

  it('forwards safe native props on button, icon button and input, and drops style', () => {
    const { Search } = require('lucide-react') as { Search: never };
    for (const element of [
      createElement(
        Button,
        { variant: 'primary', 'data-testid': 'b', disabled: true, style: { color: 'red' }, children: 'Go' } as never,
      ),
      createElement(
        IconButton,
        { icon: Search, label: 'x', 'data-testid': 'b', disabled: true, 'aria-expanded': true, style: { color: 'red' } } as never,
      ),
      createElement(Input, { label: 'x', 'data-testid': 'b', disabled: true, style: { color: 'red' } } as never),
    ]) {
      const { container, cleanup } = mount(element);
      const el = container.querySelector('[data-testid="b"]')!;
      expect(el).not.toBeNull();
      expect((el as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
      // The controlled style prop is stripped: no inline style reaches the DOM.
      expect(el.getAttribute('style')).toBeNull();
      cleanup();
    }
  });

  it('forwards aria-expanded on the icon button for a disclosure control', () => {
    const { Search } = require('lucide-react') as { Search: never };
    const { container, cleanup } = mount(
      createElement(IconButton, { icon: Search, label: 'Open', 'aria-expanded': true } as never),
    );
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    cleanup();
  });
});
// harn:end web-v5-primitives-consume-only-tokens
