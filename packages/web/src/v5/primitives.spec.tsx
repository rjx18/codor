// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { act, createElement, createRef, useState } from 'react';
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

// A closed classification of every property the primitive stylesheet may declare. A property
// with no policy is itself a violation, so a raw colour cannot ride in on a property the guard
// never considered — background-image, caret-color, border-inline-color and the like.
type Policy = 'keyword' | 'space' | 'geometry' | 'paint' | 'paint-shorthand' | 'font' | 'shadow' | 'radius' | 'line-height';
function classify(prop: string): Policy | null {
  switch (prop) {
    case 'display':
    case 'align-items':
    case 'justify-content':
    case 'cursor':
      return 'keyword';
    case 'gap':
    case 'padding':
    case 'margin':
    case 'outline-offset':
      return 'space';
    case 'width':
    case 'height':
    case 'min-width':
    case 'min-height':
      return 'geometry';
    case 'color':
    case 'background':
    case 'background-color':
    case 'border-color':
    case 'outline-color':
    case 'fill':
    case 'stroke':
      return 'paint';
    case 'border':
    case 'outline':
      return 'paint-shorthand';
    case 'box-shadow':
    case 'text-shadow':
      return 'shadow';
    case 'border-radius':
      return 'radius';
    case 'line-height':
      return 'line-height';
    default:
      return prop === 'font' || prop.startsWith('font-') ? 'font' : null;
  }
}

// The single-token-family policies: the whole value must be one declared token of the right family.
const TOKEN_FAMILY: Partial<Record<Policy, RegExp>> = {
  font: /^var\(--cd-[\w-]+\)$/,
  shadow: /^var\(--cd-[\w-]+\)$/,
  radius: /^var\(--cd-radius-[\w-]+\)$/,
  'line-height': /^var\(--cd-[\w-]+\)$/,
};
// Paint keywords admissible without a token; the border styles ride alongside in a shorthand.
const PAINT_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none']);
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden', 'none']);

/** True when a value node is a var(--cd-*) reference — the only token form a paint may consume. */
function isVarToken(node: valueParser.Node): boolean {
  if (node.type !== 'function' || node.value !== 'var') return false;
  const first = (node as valueParser.FunctionNode).nodes[0];
  return first?.type === 'word' && first.value.startsWith('--cd-');
}

/** Every discipline violation in a stylesheet, given the tokens the layer declares. */
export function cssOffenders(css: string, declared: Set<string>): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    // Each comma-separated selector must independently justify a geometry literal, keyed on its
    // rightmost compound, so a descendant or grouped selector cannot borrow the avatar allowance.
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    const sizeSetFor = (selector: string): Set<number> | null => {
      const key = selector.split(/[\s>+~]+/).filter(Boolean).at(-1) ?? '';
      const cls = new Set([...key.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!));
      return cls.has('cd-avatar') ? AVATAR_SIZES : cls.has('cd-status-dot') || cls.has('cd-typing-dot') ? DOT_SIZES : null;
    };
    // A width/height literal is legal only if every listed selector's target class permits it.
    const geometryOk = (v: number): boolean => selectors.every((s) => sizeSetFor(s)?.has(v) ?? false);

    rule.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      const flag = (why: string): void => void out.push(`${prop}: ${value} (${why})`);

      // A primitive consumes tokens; it never declares its own custom property.
      if (prop.startsWith('--')) {
        out.push(`${rule.selector}: declares local property ${decl.prop}`);
        return;
      }
      // Every --cd-* reference must be a token the layer declares.
      for (const [, name] of value.matchAll(/var\(\s*(--cd-[\w-]+)/g)) {
        if (!declared.has(name!)) out.push(`${prop}: consumes undeclared ${name!}`);
      }

      const policy = classify(prop);
      if (policy === null) {
        out.push(`${prop}: unclassified property`);
        return;
      }
      // Single-token-family policies: the entire value is one token of the right family.
      const family = TOKEN_FAMILY[policy];
      if (family) {
        if (!family.test(value)) flag(`raw ${policy}`);
        return;
      }

      // Node-by-node policies. A declared --cd-* token is universally allowed; everything else is
      // judged against the property's policy.
      for (const node of valueParser(value).nodes) {
        if (node.type === 'space' || node.type === 'div') continue;
        if (isVarToken(node)) continue;
        const word = node.type === 'word' ? node.value : '';
        const dim = node.type === 'word' ? valueParser.unit(word) : false;
        switch (policy) {
          case 'keyword':
            if (node.type === 'function') flag(`function ${node.value}`);
            else if (/^#/.test(word) || dim) flag(`raw value ${node.value}`);
            break;
          case 'space':
            flag(`raw spacing ${node.value}`);
            break;
          case 'geometry': {
            const ok =
              dim && dim.unit === 'px'
                ? prop === 'min-width' || prop === 'min-height'
                  ? Number(dim.number) >= 44
                  : geometryOk(Number(dim.number))
                : false;
            if (!ok) flag(`${node.value} not allowed here`);
            break;
          }
          case 'paint':
            if (node.type === 'function') flag(`function ${node.value}`);
            else if (!PAINT_KEYWORDS.has(word.toLowerCase())) flag(`raw paint ${node.value}`);
            break;
          case 'paint-shorthand': {
            if (node.type === 'function') {
              flag(`function ${node.value}`);
              break;
            }
            const w = word.toLowerCase();
            const okWidth = dim && dim.unit === 'px' && BORDER_WIDTHS.has(Number(dim.number));
            if (!BORDER_STYLES.has(w) && !PAINT_KEYWORDS.has(w) && !okWidth) flag(`raw ${node.value}`);
            break;
          }
        }
      }
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
    // Icon paint must be currentColor: a literal color/fill/stroke attribute — whether color="red"
    // or color={"red"} — is a raw paint unless it is currentColor or none.
    if (ts.isJsxAttribute(node) && ['color', 'fill', 'stroke'].includes(node.name.getText(source))) {
      const init = node.initializer;
      const literal = init && ts.isStringLiteral(init)
        ? init.text
        : init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
          ? init.expression.text
          : null;
      if (literal !== null && !['currentcolor', 'none'].includes(literal.toLowerCase())) {
        offenders.push(`literal ${node.name.getText(source)} "${literal}"`);
      }
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
      ['descendant selector cannot borrow an avatar size', '.cd-avatar .cd-status-dot { width: 38px; }'],
      ['grouped selector cannot borrow an avatar size', '.cd-avatar, .x { width: 38px; }'],
      ['gradient paint', '.x { background: linear-gradient(red, blue); }'],
      ['unclassified paint property', '.x { background-image: url(x); }'],
      ['caret-color', '.x { caret-color: red; }'],
      ['border-inline-color', '.x { border-inline-color: red; }'],
      ['1dvh dimension', '.x { padding: 1dvh; }'],
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

    // Parse the avatar's own background token too, so a change there is measured, not assumed.
    let avatarBgToken = '';
    postcss.parse(CSS).walkRules((rule) => {
      if (rule.selector.trim() !== '.cd-avatar') return;
      rule.walkDecls('background', (d) => {
        const ref = /^var\(\s*(--cd-[\w-]+)\s*\)$/.exec(d.value.trim());
        if (ref) avatarBgToken = ref[1]!;
      });
    });
    expect(avatarBgToken, 'avatar background must be a --cd-* token').not.toBe('');

    for (const [theme, selector] of [
      ['light', ':root'],
      ['dark', ":root[data-theme='dark']"],
    ] as const) {
      const t = themeTokens(selector);
      const bg = t.get(avatarBgToken)!;
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
      ['coloured icon attribute (string)', 'const A = () => <Icon size={17} color="red" />;'],
      ['coloured icon attribute (expression)', 'const A = () => <Icon size={17} color={"red"} />;'],
      ['literal fill', 'const A = () => <Icon size={17} fill="#fff" />;'],
    ];
    for (const [name, tsx] of cases) {
      expect(tsxOffenders(tsx).length, `${name} should be rejected`).toBeGreaterThan(0);
    }
    // currentColor and none are the permitted icon paints.
    expect(tsxOffenders('const A = () => <Icon size={17} color="currentColor" />;')).toEqual([]);
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

  it('keeps a caller-supplied id on the input and binds its label to it', () => {
    // The room search field must keep the fixed `room-search` id the toggle's aria-controls
    // and the Escape-focus target reference; a generated id would break those links.
    const { container, cleanup } = mount(<Input label="Search messages" id="room-search" />);
    const input = container.querySelector('input')!;
    expect(input.id).toBe('room-search');
    expect(container.querySelector('label')!.getAttribute('for')).toBe('room-search');
    cleanup();
  });

  it('forwards a ref to the underlying input element', () => {
    const ref = createRef<HTMLInputElement>();
    const { cleanup } = mount(<Input label="Search messages" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current?.tagName).toBe('INPUT');
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

  it('carries per-tab id and aria-controls, and a disabled tab that cannot be selected', () => {
    // The context tablist gives each tab a caller id so the panel can be labelled by it, an
    // aria-controls to its panel, and disables the Run tab until a run is selected.
    function Harness(): JSX.Element {
      const tabs = [
        { id: 'members', label: 'Members', tabId: 'ctx-members-tab', controls: 'ctx-members-panel' },
        { id: 'run', label: 'Run', tabId: 'ctx-run-tab', controls: 'ctx-run-panel', disabled: true },
      ] as const;
      const [selected, setSelected] = useState<(typeof tabs)[number]['id']>('members');
      return <SegmentedTabs label="Channel context" tabs={tabs} selected={selected} onSelect={setSelected} />;
    }
    const { container, cleanup } = mount(<Harness />);
    const members = container.querySelector('#ctx-members-tab')!;
    const run = container.querySelector('#ctx-run-tab')! as HTMLButtonElement;
    expect(members.getAttribute('aria-controls')).toBe('ctx-members-panel');
    expect(run.getAttribute('aria-controls')).toBe('ctx-run-panel');
    expect(run.disabled).toBe(true);
    // Arrow-right from the only enabled tab stays on it: the disabled Run tab is skipped.
    act(() => {
      members.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.querySelector('#ctx-members-tab')!.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#ctx-run-tab')!.getAttribute('aria-selected')).toBe('false');
    cleanup();
  });

  it('announces the active member working state through a status role', () => {
    // Not a typing protocol: the room passes the handle of a member whose turn is running, and
    // the indicator reads the truthful "@alpha is working".
    const { container, cleanup } = mount(<TypingIndicator who="@alpha" />);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('@alpha is working');
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
