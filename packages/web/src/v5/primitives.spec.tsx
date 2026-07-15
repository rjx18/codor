// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  Avatar,
  IconButton,
  Input,
  SegmentedTabs,
  TypingIndicator,
} from './primitives.js';

// happy-dom does not expose a file: import.meta.url, so resolve from the package root
// vitest runs in rather than from the module URL.
const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const CSS = read('src/v5/primitives.css');
const TSX = read('src/v5/primitives.tsx');
const LAYER = read('src/styles.css');

// The declared --cd-* tokens the layer provides.
const DECLARED_TOKENS = new Set(
  [...LAYER.matchAll(/(--cd-[\w-]+)\s*:/g)].map((m) => m[1]!),
);

// Property-scoped geometry: a literal px is legal only for the property it belongs to.
const GEOMETRY = {
  size: new Set([6, 7, 9, 12, 14, 15, 17, 18, 32, 34, 38, 40]),
  borderWidth: new Set([1, 2]),
  minTarget: 44,
};
const COLOUR_KEYWORDS = new Set(['transparent', 'currentcolor', 'none', 'inherit', 'initial', 'unset']);
const NAMED_COLOURS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'orange', 'yellow',
  'purple', 'pink', 'brown', 'cyan', 'magenta', 'teal', 'navy', 'gold',
]);

// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-token-discipline
describe('primitive stylesheet discipline', () => {
  it('draws colour, radius, shadow and font only from declared --cd-* tokens', () => {
    const offenders: string[] = [];
    postcss.parse(CSS).walkDecls((decl) => {
      valueParser(decl.value).walk((node) => {
        if (node.type === 'function' && /^(rgb|rgba|hsl|hsla)$/i.test(node.value)) {
          offenders.push(`${decl.prop}: ${decl.value} (literal colour function)`);
        }
        if (node.type === 'word') {
          if (/^#[0-9a-f]{3,8}$/i.test(node.value)) {
            offenders.push(`${decl.prop}: ${decl.value} (hex literal)`);
          } else if (NAMED_COLOURS.has(node.value.toLowerCase())) {
            offenders.push(`${decl.prop}: ${decl.value} (named colour)`);
          }
        }
      });
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('permits a literal px only for the property that geometry belongs to', () => {
    const offenders: string[] = [];
    postcss.parse(CSS).walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      valueParser(decl.value).walk((node) => {
        if (node.type !== 'word') return;
        const px = /^(\d+)px$/.exec(node.value);
        if (!px) return;
        const value = Number(px[1]);
        const ok =
          (prop === 'width' || prop === 'height') && GEOMETRY.size.has(value)
            ? true
            : (prop === 'min-width' || prop === 'min-height') && value >= GEOMETRY.minTarget
              ? true
              : (prop.startsWith('border') || prop.startsWith('outline')) &&
                  GEOMETRY.borderWidth.has(value);
        if (!ok) offenders.push(`${decl.prop}: ${decl.value} (${String(value)}px not allowed here)`);
      });
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('references only --cd-* tokens the layer declares, and invents none of its own', () => {
    const referenced = new Set<string>();
    let localDeclared = 0;
    postcss.parse(CSS).walkDecls((decl) => {
      if (decl.prop.startsWith('--cd-')) localDeclared += 1;
      for (const [, name] of decl.value.matchAll(/var\(\s*(--cd-[\w-]+)/g)) referenced.add(name!);
    });
    expect(localDeclared, 'primitives.css must not declare its own --cd-* tokens').toBe(0);
    const undeclared = [...referenced].filter((name) => !DECLARED_TOKENS.has(name)).sort();
    expect(undeclared, `undeclared: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('gives every interactive primitive at least a 44px target', () => {
    const interactive = ['.cd-button', '.cd-button-icon', '.cd-tab', '.cd-input'];
    const minHeights = new Map<string, number>();
    postcss.parse(CSS).walkRules((rule) => {
      rule.walkDecls('min-height', (decl) => {
        const px = /^(\d+)px$/.exec(decl.value.trim());
        if (px) minHeights.set(rule.selector, Number(px[1]));
      });
    });
    for (const selector of interactive) {
      expect(minHeights.get(selector) ?? 0, `${selector} min-height`).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('primitive component discipline', () => {
  it('carries no inline style, no palette utility, no hand-authored svg, and only allowlisted icon sizes', () => {
    const source = ts.createSourceFile('primitives.tsx', TSX, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const offenders: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style') {
        offenders.push('an inline style prop');
      }
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === 'svg'
      ) {
        offenders.push('a hand-authored <svg>');
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'size') {
        const init = node.initializer;
        if (init && ts.isJsxExpression(init) && init.expression && ts.isNumericLiteral(init.expression)) {
          const size = Number(init.expression.text);
          if (![14, 15, 17, 18].includes(size)) offenders.push(`icon size ${String(size)}`);
        }
      }
      if (ts.isStringLiteralLike(node) && /\b(zinc|sky|emerald|red|slate|gray|neutral|stone|blue|green)-\d{2,3}\b/.test(node.text)) {
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
  it('names an icon button so a screen reader can announce it', () => {
    const { Search } = require('lucide-react') as { Search: never };
    const { container, cleanup } = mount(<IconButton icon={Search} label="Search channels" />);
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Search channels');
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
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
    const tablist = container.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('aria-label')).toBe('Context');
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(3);
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

  it('gives an avatar status dot text a screen reader can read', () => {
    const { container, cleanup } = mount(<Avatar initials="rv" status="live" />);
    expect(container.querySelector('.cd-status-dot')?.textContent).toBe('Live');
    cleanup();
  });
});
// harn:end web-v5-primitives-consume-only-tokens
