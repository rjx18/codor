import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLESHEET = fileURLToPath(new URL('./styles.css', import.meta.url));

type Reference = { name: string; hasFallback: boolean };

/**
 * A custom property reference is only honoured if it can actually produce a value:
 * either it resolves through the declaration graph, or it carries its own fallback.
 * An alias onto an undefined name, or a cycle, produces nothing at computed-value
 * time - which is exactly how fourteen names came to be referenced here while ten of
 * them painted nothing at all.
 */
export function unresolvedReferences(css: string): string[] {
  const declarations = new Map<string, string[]>();
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    declarations.set(name, [...(declarations.get(name) ?? []), value]);
  }

  const referencesIn = (value: string): Reference[] =>
    [...value.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)].map(([, name, comma]) => ({
      name,
      hasFallback: comma === ',',
    }));

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
  for (const ref of referencesIn(css)) {
    if (!ref.hasFallback && !resolves(ref.name, new Set())) unresolved.add(ref.name);
  }
  return [...unresolved].sort();
}

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
});
