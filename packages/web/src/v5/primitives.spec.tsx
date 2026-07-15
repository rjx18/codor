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

const AVATAR_SIZES = new Set([32, 34, 38, 40]);
const DOT_SIZES = new Set([6, 7, 9, 12]);
const BORDER_WIDTHS = new Set([1, 2]);
const NAMED_COLOURS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'orange', 'yellow',
  'purple', 'pink', 'brown', 'cyan', 'magenta', 'teal', 'navy', 'gold', 'rebeccapurple',
  'aqua', 'lime', 'maroon', 'olive', 'fuchsia', 'coral', 'salmon', 'khaki', 'indigo',
]);
const COLOUR_FNS = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)$/i;
const COLOUR_PROPS = new Set(['color', 'background', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke']);

/** Every discipline violation in a stylesheet, given the tokens the layer declares. */
export function cssOffenders(css: string, declared: Set<string>): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    // Which literal width/height sizes this selector may use.
    const sel = rule.selector;
    const sizeSet = sel.includes('.cd-avatar')
      ? AVATAR_SIZES
      : sel.includes('.cd-status-dot') || sel.includes('.cd-typing-dot')
        ? DOT_SIZES
        : null;

    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--cd-')) out.push(`${sel}: declares local token ${decl.prop}`);
      const prop = decl.prop.toLowerCase();
      const parsed = valueParser(decl.value);

      // Colour: no functional or named colour anywhere; colour props must be a token or keyword.
      parsed.walk((node) => {
        if (node.type === 'function' && COLOUR_FNS.test(node.value)) {
          out.push(`${prop}: ${decl.value} (colour function ${node.value})`);
        }
        if (node.type === 'word') {
          if (/^#[0-9a-f]{3,8}$/i.test(node.value)) out.push(`${prop}: ${decl.value} (hex)`);
          else if (NAMED_COLOURS.has(node.value.toLowerCase())) out.push(`${prop}: ${decl.value} (named colour)`);
        }
      });

      // Token references must be declared by the layer.
      for (const [, name] of decl.value.matchAll(/var\(\s*(--cd-[\w-]+)/g)) {
        if (!declared.has(name!)) out.push(`${prop}: consumes undeclared ${name!}`);
      }

      // border-radius must be a token: any px or % literal is a raw radius.
      if (prop === 'border-radius' && !/^var\(--cd-radius-[\w-]+\)$/.test(decl.value.trim())) {
        out.push(`${prop}: ${decl.value} (raw radius)`);
      }
      // line-height must be a token when set standalone.
      if (prop === 'line-height' && !/^var\(--cd-/.test(decl.value.trim())) {
        out.push(`${prop}: ${decl.value} (raw line-height)`);
      }

      // Geometry literals, property- and selector-scoped.
      parsed.walk((node) => {
        if (node.type !== 'word') return;
        const px = /^(\d+)px$/.exec(node.value);
        if (!px) return;
        const v = Number(px[1]);
        const ok =
          (prop === 'width' || prop === 'height')
            ? sizeSet !== null && sizeSet.has(v)
            : (prop === 'min-width' || prop === 'min-height')
              ? v >= 44
              : (prop === 'border-width' || prop === 'outline-width' || prop === 'border' || prop === 'outline' || prop === 'outline-offset')
                ? BORDER_WIDTHS.has(v)
                : false;
        if (!ok) out.push(`${prop}: ${decl.value} (${String(v)}px not allowed here)`);
      });
    });
  });
  return out;
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

  it('rejects each former bypass — proven with synthetic fixtures', () => {
    const cases: [string, string][] = [
      ['oklch', '.x { color: oklch(0.7 0.1 200); }'],
      ['named colour', '.x { color: rebeccapurple; }'],
      ['border-radius percent', '.x { border-radius: 50%; }'],
      ['border-radius px', '.x { border-radius: 1px; }'],
      ['raw line-height', '.x { line-height: 1.5; }'],
      ['avatar using a dot size', '.cd-avatar { width: 6px; }'],
      ['padding literal', '.x { padding: 14px; }'],
      ['gap literal', '.x { gap: 44px; }'],
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
    const dotToken: Record<string, string> = {
      live: '--cd-live',
      idle: '--cd-text-muted',
      error: '--cd-error',
    };
    for (const [theme, selector] of [
      ['light', ':root'],
      ['dark', ":root[data-theme='dark']"],
    ] as const) {
      const t = themeTokens(selector);
      const bg = t.get('--cd-agent-tint')!;
      for (const [state, token] of Object.entries(dotToken)) {
        const dot = t.get(token)!;
        const ratio = contrast(dot, bg);
        expect(ratio, `${state} dot on avatar in ${theme} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('primitive component discipline', () => {
  it('carries no inline style, no palette utility, no hand-authored svg, and only allowlisted icon sizes', () => {
    const source = ts.createSourceFile('primitives.tsx', TSX, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const offenders: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style') offenders.push('inline style prop');
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === 'svg'
      ) {
        offenders.push('hand-authored <svg>');
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'size') {
        const init = node.initializer;
        if (init && ts.isJsxExpression(init) && init.expression && ts.isNumericLiteral(init.expression)) {
          const size = Number(init.expression.text);
          if (![14, 15, 17, 18].includes(size)) offenders.push(`icon size ${String(size)}`);
        }
      }
      if (ts.isStringLiteralLike(node) && /\b(zinc|sky|emerald|red|slate|gray|grey|neutral|stone|blue|green|amber|yellow|orange|rose|pink|purple|violet|indigo|cyan|teal|lime|fuchsia)-\d{2,3}\b/.test(node.text)) {
        offenders.push(`palette utility "${node.text}"`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    expect(offenders, offenders.join('\n')).toEqual([]);
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
