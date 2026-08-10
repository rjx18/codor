import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectInstalledRuntime,
  finalizeDurableRuntimeInstall,
  installDurableRuntime,
  isEphemeralRuntime,
  rollbackDurableRuntimeInstall,
  type InstallIo,
} from './runtime-install.js';
import { type RuntimePaths } from './runtime-paths.js';

// Built through `resolve()`, the same call the code under test makes on a
// durable install root, so this fixture already carries a Windows drive
// prefix where the implementation's own normalization would add one.
const HOME = resolve(sep, 'home', 'u');
const DATA = join(HOME, '.codor');
const LOCATION = join(DATA, 'runtime');

const npxCli = join(HOME, '.npm/_npx/abcd1234/node_modules/@richhardry/codor/node_modules/@codor/cli');
const ephemeral: RuntimePaths = {
  root: npxCli,
  layout: 'installed-package',
  cliEntrypoint: join(npxCli, 'dist/index.js'),
  staticRoot: join(npxCli, 'runtime/web'),
  serviceTemplate: join(npxCli, 'packaging/systemd/codor.service'),
};

const dlxCli = join(
  HOME,
  '.local/share/pnpm/pnpm-cache/dlx/abcd1234ef567890/1706000000000/node_modules/@richhardry/codor/node_modules/@codor/cli',
);
const dlxEphemeral: RuntimePaths = {
  root: dlxCli,
  layout: 'installed-package',
  cliEntrypoint: join(dlxCli, 'dist/index.js'),
  staticRoot: join(dlxCli, 'runtime/web'),
  serviceTemplate: join(dlxCli, 'packaging/systemd/codor.service'),
};

const checkoutRoot = join(HOME, 'git/codor');
const checkout: RuntimePaths = {
  root: checkoutRoot,
  layout: 'source-checkout',
  cliEntrypoint: join(checkoutRoot, 'packages/cli/dist/index.js'),
  staticRoot: join(checkoutRoot, 'packages/web-next/dist'),
  serviceTemplate: join(checkoutRoot, 'packaging/systemd/codor.service'),
};

const dlxCheckoutRoot = join(HOME, 'git/dlx/codor');
const dlxCheckout: RuntimePaths = {
  root: dlxCheckoutRoot,
  layout: 'source-checkout',
  cliEntrypoint: join(dlxCheckoutRoot, 'packages/cli/dist/index.js'),
  staticRoot: join(dlxCheckoutRoot, 'packages/web-next/dist'),
  serviceTemplate: join(dlxCheckoutRoot, 'packaging/systemd/codor.service'),
};

const stableCli = '/opt/codor/node_modules/@richhardry/codor/node_modules/@codor/cli';
const stable: RuntimePaths = {
  root: stableCli,
  layout: 'installed-package',
  cliEntrypoint: join(stableCli, 'dist/index.js'),
  staticRoot: join(stableCli, 'runtime/web'),
  serviceTemplate: join(stableCli, 'packaging/systemd/codor.service'),
};

const WRAPPER_PKG = (loc: string): string => join(loc, 'node_modules', '@richhardry', 'codor', 'package.json');
const STAGED_CLI = (loc: string): string => join(loc, 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli');

/** A tiny virtual filesystem so the staged copy + atomic swap is testable. */
function fakeIo(options: { existing?: string; failCopy?: boolean; incompleteCopy?: boolean } = {}): {
  io: InstallIo; present: Set<string>; copies: Array<[string, string]>; moves: Array<[string, string]>; removed: string[];
} {
  const copies: Array<[string, string]> = [];
  const moves: Array<[string, string]> = [];
  const removed: string[] = [];
  const present = new Set<string>();
  const versions = new Map<string, string>();
  if (options.existing !== undefined) {
    present.add(LOCATION);
    versions.set(WRAPPER_PKG(LOCATION), options.existing);
  }
  const rename = (from: string, to: string): void => {
    for (const path of [...present]) {
      if (path === from || path.startsWith(`${from}/`)) { present.delete(path); present.add(to + path.slice(from.length)); }
    }
    for (const [key, value] of [...versions]) {
      if (key.startsWith(`${from}/`)) { versions.delete(key); versions.set(to + key.slice(from.length), value); }
    }
  };
  const io: InstallIo = {
    exists: (path) => present.has(path),
    copyTree: (from, to) => {
      copies.push([from, to]);
      if (options.failCopy) throw new Error('copy failed');
      const stage = to.slice(0, to.length - `${sep}node_modules`.length);
      present.add(stage);
      if (options.incompleteCopy !== true) {
        present.add(join(STAGED_CLI(stage), 'dist', 'index.js'));
        present.add(join(STAGED_CLI(stage), 'runtime', 'web'));
      }
    },
    move: (from, to) => {
      moves.push([from, to]);
      if (!present.has(from)) throw new Error(`cannot move missing ${from}`);
      rename(from, to);
    },
    remove: (path) => {
      removed.push(path);
      for (const existing of [...present]) if (existing === path || existing.startsWith(`${path}/`)) present.delete(existing);
    },
    readVersion: (path) => versions.get(path),
  };
  return { io, present, copies, moves, removed };
}

// harn:assume setup-installs-durable-per-user-runtime-atomically ref=durable-runtime-install-regression
// harn:assume setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs ref=pnpm-dlx-classifier-regression
describe('isEphemeralRuntime', () => {
  it('flags npx cache, pnpm dlx cache, and temp paths, not stable locations', () => {
    expect(isEphemeralRuntime(join(HOME, '.npm/_npx/abcd1234'))).toBe(true);
    expect(isEphemeralRuntime(join(HOME, '.local/share/pnpm/pnpm-cache/dlx/abcd1234ef567890/1706000000000'))).toBe(true);
    expect(isEphemeralRuntime(join(tmpdir(), 'x'))).toBe(true);
    expect(isEphemeralRuntime('/opt/codor')).toBe(false);
    expect(isEphemeralRuntime(checkoutRoot)).toBe(false);
  });
});
// harn:end setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs

describe('installDurableRuntime', () => {
  it('stages, validates, and swaps an ephemeral npx runtime into ~/.codor/runtime', () => {
    const { io, copies, moves } = fakeIo();
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('installed');
    expect(result.location).toBe(LOCATION);
    // Copy lands in a sibling staging dir, then is moved into place.
    expect(copies).toEqual([[join(HOME, '.npm/_npx/abcd1234/node_modules'), join(`${LOCATION}.staging`, 'node_modules')]]);
    expect(moves).toContainEqual([`${LOCATION}.staging`, LOCATION]);
    expect(result.runtime.cliEntrypoint)
      .toBe(join(LOCATION, 'node_modules/@richhardry/codor/node_modules/@codor/cli/dist/index.js'));
    expect(result.runtime.cliEntrypoint).not.toContain('_npx');
  });

  // harn:assume setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs ref=pnpm-dlx-durable-copy-regression
  it('stages, validates, and swaps an ephemeral pnpm dlx runtime into ~/.codor/runtime', () => {
    const { io, moves } = fakeIo();
    const result = installDurableRuntime({ runtime: dlxEphemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('installed');
    expect(result.location).toBe(LOCATION);
    expect(moves).toContainEqual([`${LOCATION}.staging`, LOCATION]);
    // Rooted at the durable location, not the dlx cache the source runtime lived in.
    expect(result.runtime.cliEntrypoint).toContain(LOCATION);
    expect(result.runtime.cliEntrypoint).not.toContain('dlx');
  });
  // harn:end setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs

  it('uses a source checkout in place without copying', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: checkout, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('in-place');
    expect(result.runtime).toBe(checkout);
    expect(copies).toEqual([]);
  });

  // harn:assume setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs ref=pnpm-dlx-source-checkout-regression
  it('keeps a source checkout in place when its path contains a dlx segment', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: dlxCheckout, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('in-place');
    expect(result.runtime).toBe(dlxCheckout);
    expect(copies).toEqual([]);
  });
  // harn:end setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs

  it('uses an already-stable installed package in place without copying', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: stable, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('in-place');
    expect(copies).toEqual([]);
  });

  it('reuses an existing install of the same version with the ensure intent', () => {
    const { io, copies } = fakeIo({ existing: '0.10.0' });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('reused');
    expect(copies).toEqual([]);
  });

  it('keeps the installed version when the intent is keep, even at a different version', () => {
    const { io, copies } = fakeIo({ existing: '0.9.0' });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', intent: 'keep', io });
    expect(result.action).toBe('reused');
    expect(result.version).toBe('0.9.0'); // the installed version is retained, not replaced
    expect(copies).toEqual([]);
  });

  it('re-copies on the update intent and swaps via a backup', () => {
    const { io, copies, moves } = fakeIo({ existing: '0.9.0' });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', intent: 'update', io });
    expect(result.action).toBe('updated');
    expect(copies).toHaveLength(1);
    expect(moves).toContainEqual([LOCATION, `${LOCATION}.backup`]); // previous install moved aside first
    expect(moves).toContainEqual([`${LOCATION}.staging`, LOCATION]);
  });

  // harn:assume runtime-update-transacts-runtime-service-and-selected-data-root ref=durable-runtime-transaction-regression
  it('retains the prior runtime until a successful update is finalized', () => {
    const { io, present, removed } = fakeIo({ existing: '0.9.0' });
    const result = installDurableRuntime({
      runtime: ephemeral,
      dataDir: DATA,
      version: '0.10.0',
      intent: 'update',
      retainBackup: true,
      io,
    });
    expect(result.transaction).toEqual({ backup: `${LOCATION}.backup`, previousVersion: '0.9.0' });
    expect(present.has(`${LOCATION}.backup`)).toBe(true);

    finalizeDurableRuntimeInstall(result, io);
    expect(present.has(`${LOCATION}.backup`)).toBe(false);
    expect(removed).toContain(`${LOCATION}.backup`);
  });

  it('restores the prior runtime from a retained update transaction', () => {
    const { io, present, moves } = fakeIo({ existing: '0.9.0' });
    const result = installDurableRuntime({
      runtime: ephemeral,
      dataDir: DATA,
      version: '0.10.0',
      intent: 'update',
      retainBackup: true,
      io,
    });

    rollbackDurableRuntimeInstall(result, io);
    expect(present.has(LOCATION)).toBe(true);
    expect(present.has(`${LOCATION}.backup`)).toBe(false);
    expect(moves.at(-1)).toEqual([`${LOCATION}.backup`, LOCATION]);
    expect(detectInstalledRuntime(DATA, io)?.version).toBe('0.9.0');
  });
  // harn:end runtime-update-transacts-runtime-service-and-selected-data-root

  it('leaves the previous runtime intact when the copy fails', () => {
    const { io, present, moves } = fakeIo({ existing: '0.9.0', failCopy: true });
    expect(() => installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', intent: 'update', io }))
      .toThrow(/copy failed/);
    // The existing install was never moved or removed.
    expect(present.has(LOCATION)).toBe(true);
    expect(moves).toEqual([]);
  });

  it('aborts and cleans up staging when the staged runtime is incomplete', () => {
    const { io, present, removed, moves } = fakeIo({ existing: '0.9.0', incompleteCopy: true });
    expect(() => installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', intent: 'update', io }))
      .toThrow(/missing its CLI entrypoint/);
    expect(removed).toContain(`${LOCATION}.staging`);
    expect(present.has(LOCATION)).toBe(true);
    expect(moves).toEqual([]);
  });
});

describe('detectInstalledRuntime', () => {
  it('reports an existing install with its version, else undefined', () => {
    const { io } = fakeIo({ existing: '0.10.0' });
    expect(detectInstalledRuntime(DATA, io)).toEqual({ location: LOCATION, version: '0.10.0' });
    const missing = fakeIo();
    expect(detectInstalledRuntime(DATA, missing.io)).toBeUndefined();
  });
});

describe('installDurableRuntime with the real filesystem', () => {
  const temps: string[] = [];
  const mkTemp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  afterEach(() => { while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true }); });

  it('copies the whole tree, preserving a prebuilt native binary', () => {
    const base = mkTemp('codor-install-src-'); // under tmpdir -> ephemeral source
    const cliDir = join(base, 'node_modules/@richhardry/codor/node_modules/@codor/cli');
    mkdirSync(join(cliDir, 'dist'), { recursive: true });
    writeFileSync(join(cliDir, 'dist/index.js'), '// cli entry');
    mkdirSync(join(cliDir, 'runtime', 'web'), { recursive: true }); // validated before the swap
    writeFileSync(join(cliDir, 'runtime', 'web', 'index.html'), '<!doctype html>');
    const nativeDir = join(base, 'node_modules/better-sqlite3/build/Release');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'better_sqlite3.node'), Buffer.from([0, 1, 2, 3]));

    const dataDir = mkTemp('codor-install-data-');
    const runtime: RuntimePaths = {
      root: cliDir,
      layout: 'installed-package',
      cliEntrypoint: join(cliDir, 'dist/index.js'),
      staticRoot: join(cliDir, 'runtime/web'),
      serviceTemplate: join(cliDir, 'packaging/systemd/codor.service'),
    };
    const result = installDurableRuntime({ runtime, dataDir, version: '0.10.0' });

    expect(result.action).toBe('installed');
    expect(existsSync(join(dataDir, 'runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node'))).toBe(true);
    expect(existsSync(result.runtime.cliEntrypoint)).toBe(true);
    expect(result.runtime.cliEntrypoint.startsWith(dataDir)).toBe(true);
  });
});
// harn:end setup-installs-durable-per-user-runtime-atomically
