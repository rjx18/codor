// harn:assume relay-worker-stays-blind ref=blind-deps-regression
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// Standing guard for the blind-by-construction invariant (PLAN §4.1, §5): the
// relay Worker forwards opaque ciphertext and must never gain a runtime
// dependency that could add crypto or traffic inspection.
describe('relay worker stays blind', () => {
  it('declares zero runtime dependencies', () => {
    const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps)).toEqual([]);
  });
});
// harn:end relay-worker-stays-blind
