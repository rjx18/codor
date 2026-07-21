import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { packageRuntimePaths, type RuntimePaths } from './runtime-paths.js';

const WRAPPER_SEGMENT = `${sep}node_modules${sep}@richhardry${sep}codor${sep}`;
const CLI_SEGMENT = `${sep}node_modules${sep}@codor${sep}cli`;

export type InstallAction = 'installed' | 'updated' | 'reused' | 'in-place';

/** How an existing install is treated: `ensure` installs when missing and reuses
 *  a matching version; `update` re-copies; `keep` retains the installed version
 *  even when it differs. */
export type InstallIntent = 'ensure' | 'update' | 'keep';

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
  move(from: string, to: string): void;
  remove(path: string): void;
  readVersion(packageJsonPath: string): string | undefined;
}

export const defaultInstallIo: InstallIo = {
  exists: (path) => existsSync(path),
  copyTree: (from, to) => cpSync(from, to, { recursive: true }),
  move: (from, to) => renameSync(from, to),
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

// harn:assume setup-installs-durable-per-user-runtime-atomically ref=durable-runtime-install
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
 * preserving prebuilt native binaries. The caller's `intent` decides an existing
 * install: `keep` retains the installed version even when it differs, `update`
 * re-copies, and `ensure` installs when missing and reuses a matching version. An
 * install or update stages the copy in a sibling directory, validates it, then
 * swaps it in with a backup and rollback, so an interrupted copy never destroys a
 * working install.
 */
export function installDurableRuntime(options: {
  runtime: RuntimePaths;
  dataDir: string;
  version: string;
  intent?: InstallIntent;
  io?: InstallIo;
}): DurableInstallResult {
  const io = options.io ?? defaultInstallIo;
  const intent = options.intent ?? 'ensure';
  const source = resolveInstallSource(options.runtime);
  if (source.durable) {
    return { runtime: options.runtime, location: source.installRoot, action: 'in-place', version: options.version };
  }

  const location = durableRuntimeLocation(options.dataDir);
  const installed = packageRuntimePaths(installedCliRoot(location));
  const existing = io.exists(location) ? io.readVersion(installedWrapperPackageJson(location)) : undefined;

  // Keep the installed runtime as-is (the operator declined the update).
  if (intent === 'keep' && existing !== undefined) {
    return { runtime: installed, location, action: 'reused', version: existing };
  }
  // Reuse a matching install unless an explicit update was requested.
  if (intent !== 'update' && existing === options.version) {
    return { runtime: installed, location, action: 'reused', version: options.version };
  }

  // Stage the copy in a sibling, validate it, then swap atomically. A failure at
  // any point before the swap leaves the existing install untouched.
  const staging = `${location}.staging`;
  const backup = `${location}.backup`;
  if (io.exists(staging)) io.remove(staging);
  io.copyTree(source.nodeModules, join(staging, 'node_modules'));
  const stagedCli = installedCliRoot(staging);
  if (!io.exists(join(stagedCli, 'dist', 'index.js')) || !io.exists(join(stagedCli, 'runtime', 'web'))) {
    io.remove(staging);
    throw new Error(`the staged Codor runtime at ${staging} is missing its CLI entrypoint or web assets`);
  }
  if (io.exists(backup)) io.remove(backup);
  if (io.exists(location)) io.move(location, backup);
  try {
    io.move(staging, location);
  } catch (error) {
    if (io.exists(backup)) io.move(backup, location); // roll back to the previous install
    throw error;
  }
  if (io.exists(backup)) io.remove(backup);
  return { runtime: installed, location, action: existing === undefined ? 'installed' : 'updated', version: options.version };
}
// harn:end setup-installs-durable-per-user-runtime-atomically
