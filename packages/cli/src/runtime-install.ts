import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { packageRuntimePaths, type RuntimePaths } from './runtime-paths.js';

const WRAPPER_SEGMENT = `${sep}node_modules${sep}@richhardry${sep}codor${sep}`;
const CLI_SEGMENT = `${sep}node_modules${sep}@codor${sep}cli`;

export type InstallAction = 'installed' | 'updated' | 'reused' | 'in-place';

export interface DurableInstallResult {
  /** RuntimePaths the platform service must reference (the durable copy). */
  runtime: RuntimePaths;
  /** The stable install location (or the in-place root when already durable). */
  location: string;
  action: InstallAction;
  version: string;
}

/** Injectable filesystem surface so the copy logic is unit-testable. */
export interface InstallIo {
  exists(path: string): boolean;
  copyTree(from: string, to: string): void;
  remove(path: string): void;
  readVersion(packageJsonPath: string): string | undefined;
}

export const defaultInstallIo: InstallIo = {
  exists: (path) => existsSync(path),
  copyTree: (from, to) => cpSync(from, to, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  readVersion: (packageJsonPath) => {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  },
};

/** ~/.codor/runtime — the durable per-user runtime location under the data dir. */
export function durableRuntimeLocation(dataDir: string): string {
  return join(dataDir, 'runtime');
}

/** A path is ephemeral when it lives in an npx cache or the OS temp directory. */
export function isEphemeralRuntime(path: string): boolean {
  const temp = tmpdir();
  return path.includes(`${sep}_npx${sep}`) || path === temp || path.startsWith(temp + sep);
}

function installedWrapperPackageJson(location: string): string {
  return join(location, 'node_modules', '@richhardry', 'codor', 'package.json');
}

// harn:assume setup-installs-durable-per-user-runtime ref=durable-runtime-install
/** The self-contained module tree the running CLI resolves against, and whether
 *  it is already durable (a source checkout or a stable install) or ephemeral
 *  (an npx cache / temp dir that must be copied before a service points at it). */
export function resolveInstallSource(runtime: RuntimePaths): { installRoot: string; nodeModules: string; durable: boolean } {
  if (runtime.layout === 'source-checkout') {
    return { installRoot: runtime.root, nodeModules: join(runtime.root, 'node_modules'), durable: true };
  }
  // The install root is the directory whose node_modules holds the full,
  // self-contained dependency tree (the @richhardry/codor wrapper plus its
  // third-party and native siblings).
  const root = runtime.root;
  const wrapperAt = root.indexOf(WRAPPER_SEGMENT);
  const installRoot = wrapperAt >= 0
    ? root.slice(0, wrapperAt)
    : root.slice(0, Math.max(0, root.indexOf(CLI_SEGMENT)));
  return { installRoot, nodeModules: join(installRoot, 'node_modules'), durable: !isEphemeralRuntime(installRoot) };
}

/** The `@codor/cli` package root inside a durable install location. */
export function installedCliRoot(location: string): string {
  return join(location, 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli');
}

/** An existing durable install at ~/.codor/runtime, if present and readable. */
export function detectInstalledRuntime(dataDir: string, io: InstallIo = defaultInstallIo): { location: string; version: string } | undefined {
  const location = durableRuntimeLocation(dataDir);
  if (!io.exists(location)) return undefined;
  const version = io.readVersion(installedWrapperPackageJson(location));
  return version === undefined ? undefined : { location, version };
}

/**
 * Make the invoking runtime durable so a per-user service can safely reference
 * it. A source checkout or an already-stable install is used in place. An
 * ephemeral (npx / temp) runtime is copied whole into ~/.codor/runtime,
 * preserving prebuilt native binaries; an existing install of the same version
 * is reused unless `forceReinstall`, and a different version is updated by
 * re-copying.
 */
export function installDurableRuntime(options: {
  runtime: RuntimePaths;
  dataDir: string;
  version: string;
  forceReinstall?: boolean;
  io?: InstallIo;
}): DurableInstallResult {
  const io = options.io ?? defaultInstallIo;
  const source = resolveInstallSource(options.runtime);
  if (source.durable) {
    return { runtime: options.runtime, location: source.installRoot, action: 'in-place', version: options.version };
  }

  const location = durableRuntimeLocation(options.dataDir);
  const existing = io.exists(location) ? io.readVersion(installedWrapperPackageJson(location)) : undefined;
  if (existing === options.version && options.forceReinstall !== true) {
    return { runtime: packageRuntimePaths(installedCliRoot(location)), location, action: 'reused', version: options.version };
  }

  if (io.exists(location)) io.remove(location);
  io.copyTree(source.nodeModules, join(location, 'node_modules'));
  return {
    runtime: packageRuntimePaths(installedCliRoot(location)),
    location,
    action: existing === undefined ? 'installed' : 'updated',
    version: options.version,
  };
}
// harn:end setup-installs-durable-per-user-runtime
