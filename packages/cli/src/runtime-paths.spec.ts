import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimePaths, tryResolveRuntimePaths } from './runtime-paths.js';

const roots: string[] = [];

function temp(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `codor-${label}-`));
  roots.push(root);
  return root;
}

function seedCheckout(root: string): void {
  for (const path of [
    join(root, 'packages', 'cli', 'dist', 'index.js'),
    join(root, 'packages', 'web-next', 'dist', 'index.html'),
    join(root, 'packaging', 'systemd', 'codor.service'),
  ]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, path.endsWith('.service') ? 'ExecStart=/usr/bin/node\n' : '', 'utf8');
  }
}

function seedPackage(root: string): void {
  for (const path of [
    join(root, 'dist', 'index.js'),
    join(root, 'runtime', 'web', 'index.html'),
    join(root, 'packaging', 'systemd', 'codor.service'),
  ]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, path.endsWith('.service') ? 'ExecStart=/usr/bin/node\n' : '', 'utf8');
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// harn:assume setup-resolves-complete-invoking-runtime ref=setup-runtime-resolution-regression
describe('runtime path resolution', () => {
  it('prefers an explicitly injected checkout', () => {
    const injected = temp('injected');
    const installed = temp('installed');
    seedCheckout(injected);
    seedPackage(installed);

    expect(resolveRuntimePaths({ repoRoot: injected, packageRoot: installed })).toEqual({
      cliEntrypoint: join(injected, 'packages', 'cli', 'dist', 'index.js'),
      layout: 'source-checkout',
      root: injected,
      serviceTemplate: join(injected, 'packaging', 'systemd', 'codor.service'),
      staticRoot: join(injected, 'packages', 'web-next', 'dist'),
    });
  });

  it('uses package-relative runtime assets when there is no complete checkout', () => {
    const incomplete = temp('incomplete');
    const installed = temp('installed');
    seedPackage(installed);

    const runtime = resolveRuntimePaths({
      repoRoot: incomplete,
      packageRoot: installed,
      checkoutRoot: incomplete,
    });

    expect(runtime.layout).toBe('installed-package');
    expect(runtime.cliEntrypoint).toBe(join(installed, 'dist', 'index.js'));
    expect(runtime.staticRoot).toBe(join(installed, 'runtime', 'web'));
  });

  it('rejects a partial layout rather than mixing assets from different roots', () => {
    const partialPackage = temp('partial-package');
    const partialCheckout = temp('partial-checkout');
    mkdirSync(join(partialPackage, 'dist'), { recursive: true });
    writeFileSync(join(partialPackage, 'dist', 'index.js'), '', 'utf8');
    mkdirSync(join(partialCheckout, 'packages', 'web-next', 'dist'), { recursive: true });

    expect(() => resolveRuntimePaths({
      packageRoot: partialPackage,
      checkoutRoot: partialCheckout,
    })).toThrow(/could not find a complete runtime.*installed package.*source checkout/);
    expect(tryResolveRuntimePaths({
      packageRoot: partialPackage,
      checkoutRoot: partialCheckout,
    })).toBeUndefined();
  });
});
// harn:end setup-resolves-complete-invoking-runtime
