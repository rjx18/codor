import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectInstalledRuntime,
  installDurableRuntime,
  isEphemeralRuntime,
  type InstallIo,
} from './runtime-install.js';
import { type RuntimePaths } from './runtime-paths.js';

const HOME = '/home/u';
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

const checkoutRoot = join(HOME, 'git/codor');
const checkout: RuntimePaths = {
  root: checkoutRoot,
  layout: 'source-checkout',
  cliEntrypoint: join(checkoutRoot, 'packages/cli/dist/index.js'),
  staticRoot: join(checkoutRoot, 'packages/web-next/dist'),
  serviceTemplate: join(checkoutRoot, 'packaging/systemd/codor.service'),
};

const stableCli = '/opt/codor/node_modules/@richhardry/codor/node_modules/@codor/cli';
const stable: RuntimePaths = {
  root: stableCli,
  layout: 'installed-package',
  cliEntrypoint: join(stableCli, 'dist/index.js'),
  staticRoot: join(stableCli, 'runtime/web'),
  serviceTemplate: join(stableCli, 'packaging/systemd/codor.service'),
};

function fakeIo(options: { existing?: string; present?: string[] } = {}): {
  io: InstallIo; copies: Array<[string, string]>; removed: string[];
} {
  const copies: Array<[string, string]> = [];
  const removed: string[] = [];
  const present = new Set(options.present ?? []);
  const io: InstallIo = {
    exists: (path) => present.has(path),
    copyTree: (from, to) => { copies.push([from, to]); },
    remove: (path) => { removed.push(path); },
    readVersion: () => options.existing,
  };
  return { io, copies, removed };
}

// harn:assume setup-installs-durable-per-user-runtime ref=durable-runtime-install-regression
describe('isEphemeralRuntime', () => {
  it('flags npx cache and temp paths, not stable locations', () => {
    expect(isEphemeralRuntime(join(HOME, '.npm/_npx/abcd1234'))).toBe(true);
    expect(isEphemeralRuntime(join(tmpdir(), 'x'))).toBe(true);
    expect(isEphemeralRuntime('/opt/codor')).toBe(false);
    expect(isEphemeralRuntime(checkoutRoot)).toBe(false);
  });
});

describe('installDurableRuntime', () => {
  it('copies an ephemeral npx runtime into ~/.codor/runtime and points the service there', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('installed');
    expect(result.location).toBe(LOCATION);
    expect(copies).toEqual([[join(HOME, '.npm/_npx/abcd1234/node_modules'), join(LOCATION, 'node_modules')]]);
    expect(result.runtime.cliEntrypoint)
      .toBe(join(LOCATION, 'node_modules/@richhardry/codor/node_modules/@codor/cli/dist/index.js'));
    expect(result.runtime.cliEntrypoint).not.toContain('_npx');
    expect(result.runtime.staticRoot).not.toContain('_npx');
  });

  it('uses a source checkout in place without copying', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: checkout, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('in-place');
    expect(result.runtime).toBe(checkout);
    expect(copies).toEqual([]);
  });

  it('uses an already-stable installed package in place without copying', () => {
    const { io, copies } = fakeIo();
    const result = installDurableRuntime({ runtime: stable, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('in-place');
    expect(copies).toEqual([]);
  });

  it('reuses an existing install of the same version', () => {
    const { io, copies } = fakeIo({ existing: '0.10.0', present: [LOCATION] });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('reused');
    expect(copies).toEqual([]);
  });

  it('updates an existing install of a different version by re-copying', () => {
    const { io, copies, removed } = fakeIo({ existing: '0.9.0', present: [LOCATION] });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', io });
    expect(result.action).toBe('updated');
    expect(removed).toEqual([LOCATION]);
    expect(copies).toHaveLength(1);
  });

  it('forces a re-copy on the same version when forceReinstall is set', () => {
    const { io, copies } = fakeIo({ existing: '0.10.0', present: [LOCATION] });
    const result = installDurableRuntime({ runtime: ephemeral, dataDir: DATA, version: '0.10.0', forceReinstall: true, io });
    expect(result.action).toBe('updated');
    expect(copies).toHaveLength(1);
  });
});

describe('detectInstalledRuntime', () => {
  it('reports an existing install with its version, else undefined', () => {
    const { io } = fakeIo({ existing: '0.10.0', present: [LOCATION] });
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
// harn:end setup-installs-durable-per-user-runtime
