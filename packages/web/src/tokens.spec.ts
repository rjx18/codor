import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { describe, expect, it } from 'vitest';

const STYLESHEET = fileURLToPath(new URL('./styles.css', import.meta.url));

type Reference = { name: string; hasFallback: boolean };

/** Every var() in a value, and whether it carries its own fallback. */
function referencesIn(value: string): Reference[] {
  const found: Reference[] = [];
  valueParser(value).walk((node) => {
    // postcss-value-parser puts a function's name in `value`, not `name`.
    if (node.type !== 'function' || node.value !== 'var') return;
    const name = node.nodes[0];
    if (name?.type !== 'word' || !name.value.startsWith('--')) return;
    found.push({ name: name.value, hasFallback: node.nodes.some((n) => n.type === 'div' && n.value === ',') });
  });
  return found;
}

/**
 * A custom property reference only produces a value if it resolves through the
 * declaration graph or carries a fallback. An alias onto an undefined name, or a cycle,
 * produces nothing at computed-value time - which is how fourteen names came to be
 * referenced in this stylesheet while ten of them painted nothing at all.
 *
 * Parsed structurally rather than with a regex: a declaration inside a comment or a
 * string is not a declaration, and a regex scan cannot tell the difference. That would
 * let a dead token satisfy the very test written to catch dead tokens.
 */
export function unresolvedReferences(css: string): string[] {
  const declarations = new Map<string, string[]>();
  const references: Reference[] = [];

  postcss.parse(css).walkDecls((decl) => {
    if (decl.prop.startsWith('--')) {
      declarations.set(decl.prop, [...(declarations.get(decl.prop) ?? []), decl.value]);
    }
    references.push(...referencesIn(decl.value));
  });

  const resolves = (name: string, seen: Set<string>): boolean => {
    if (seen.has(name)) return false; // a cycle never terminates
    const values = declarations.get(name);
    if (!values?.length) return false; // declared nowhere
    const chain = new Set(seen).add(name);
    return values.every((value) =>
      referencesIn(value).every((ref) => ref.hasFallback || resolves(ref.name, chain)),
    );
  };

  const unresolved = new Set<string>();
  for (const ref of references) {
    if (!ref.hasFallback && !resolves(ref.name, new Set())) unresolved.add(ref.name);
  }
  return [...unresolved].sort();
}

// harn:assume web-theme-accessible-modes ref=token-resolution-regression
describe('custom property references', () => {
  it('every reference in the stylesheet either resolves or carries a fallback', () => {
    expect(unresolvedReferences(readFileSync(STYLESHEET, 'utf8'))).toEqual([]);
  });

  it('reports an alias pointing at a name nobody declared, and the dead name itself', () => {
    expect(unresolvedReferences(':root { --a: var(--nowhere); } .x { color: var(--a); }')).toEqual([
      '--a',
      '--nowhere',
    ]);
  });

  it('reports an alias cycle rather than recursing forever', () => {
    expect(
      unresolvedReferences(':root { --a: var(--b); --b: var(--a); } .x { color: var(--a); }'),
    ).toEqual(['--a', '--b']);
  });

  it('accepts a reference that carries its own fallback even when undeclared', () => {
    expect(unresolvedReferences('.x { font-family: var(--wr-mono, monospace); }')).toEqual([]);
  });

  it('does not accept a declaration that only exists inside a comment', () => {
    // The regex scan this replaces would have called --a defined and passed.
    expect(unresolvedReferences(':root { /* --a: red; */ } .x { color: var(--a); }')).toEqual([
      '--a',
    ]);
  });

  it('does not accept a declaration that only exists inside a string', () => {
    expect(unresolvedReferences(':root { content: "--a: red;"; } .x { color: var(--a); }')).toEqual(
      ['--a'],
    );
  });
});

describe('the v5 token layer', () => {
  const css = readFileSync(STYLESHEET, 'utf8');

  it('declares no legacy pseudo-colour name anywhere', () => {
    // --wr-cyan and --wr-violet were both #a0a2a9 — the same neutral, never a hue.
    // Renaming them now, while nothing else moves, is what keeps the Phase 3 diff readable.
    expect(css).not.toMatch(/--wr-(cyan|violet)\b/);
  });

  it('resolves every --cd-* it declares', () => {
    const unresolved = unresolvedReferences(css).filter((name) => name.startsWith('--cd-'));
    expect(unresolved).toEqual([]);
  });
});
// harn:end web-theme-accessible-modes
