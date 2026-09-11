import { execFileSync } from 'node:child_process';
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
  /** Present only when the caller keeps the pre-swap runtime until a later
   * service-readiness decision. */
  transaction?: { backup: string; previousVersion?: string };
}

/** Outcome of proving a runtime can open a SQLite database under a Node binary. */
export interface NativeProbeResult {
  ok: boolean;
  /** Trimmed child output and error message when `ok` is false. */
  detail?: string;
}

/** Injectable filesystem surface so the copy logic is unit-testable. */
export interface InstallIo {
  exists(path: string): boolean;
  copyTree(from: string, to: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  readVersion(packageJsonPath: string): string | undefined;
  /** Prove the CLI root can open a `better-sqlite3` database under `nodePath`.
   *  Optional so callers that inject a partial filesystem skip the check; the
   *  default IO always supplies it. */
  probeNative?(cliRoot: string, nodePath: string): NativeProbeResult;
}

/** Opening a database (not an import) is what resolves the native binding;
 *  `better-sqlite3` defers that to the first `Database` construction. Resolve
 *  from `@codor/switchboard`, the package that declares the dependency, so an
 *  isolated pnpm layout works; a CLI-root cwd only finds a hoisted npm layout. */
const NATIVE_PROBE_SCRIPT = [
  "import { createRequire } from 'node:module';",
  'try {',
  '  const cliRequire = createRequire(process.argv[1]);',
  "  const switchboard = cliRequire.resolve('@codor/switchboard');",
  "  const Database = createRequire(switchboard)('better-sqlite3');",
  "  new Database(':memory:').close();",
  '} catch (error) {',
  '  const message = error && error.message ? error.message : String(error);',
  '  console.error(`better-sqlite3 could not open a database under Node ABI ${process.versions.modules} (${process.platform}-${process.arch}): ${message}`);',
  '  process.exit(1);',
  '}',
].join('\n');

function nativeProbeDetail(error: unknown): string {
  const details = error as { message?: string; stdout?: unknown; stderr?: unknown };
  const render = (value: unknown): string => Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string' ? value : '';
  // Prefer the child's own output. `message` repeats the full command, including
  // the multi-line probe script, and buries the useful diagnostic.
  const streams = [render(details.stderr), render(details.stdout)]
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (streams.length > 0) return streams.join('\n');
  return details.message?.trim() ?? '';
}

/** A child environment without NODE_PATH. `createRequire` honors NODE_PATH as a
 *  CommonJS global path, so an inherited hoist directory (set by pnpm, and
 *  written into the service environment) could satisfy the probe from the wrong
 *  tree. */
function probeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'NODE_PATH') env[key] = value;
  }
  return env;
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
  probeNative: (cliRoot, nodePath) => {
    try {
      execFileSync(nodePath, [
        '--input-type=module',
        '-e',
        NATIVE_PROBE_SCRIPT,
        join(cliRoot, 'dist', 'index.js'),
      ], {
        cwd: cliRoot,
        encoding: 'utf8',
        env: probeEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: nativeProbeDetail(error) };
    }
  },
};

/** Run the injected native probe, or return undefined when no probe applies
 *  (a partial IO or a caller that did not name a service Node binary). */
function probeRuntimeNatives(
  io: InstallIo,
  cliRoot: string,
  nodePath: string | undefined,
): NativeProbeResult | undefined {
  if (io.probeNative === undefined || nodePath === undefined) return undefined;
  return io.probeNative(cliRoot, nodePath);
}

/** ~/.codor/runtime — the durable per-user runtime location under the data dir. */
export function durableRuntimeLocation(dataDir: string): string {
  return join(dataDir, 'runtime');
}

// harn:assume setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs ref=pnpm-dlx-runtime-classifier
/** A path is ephemeral when it lives in an npx cache, a pnpm dlx cache, or the OS temp directory. */
export function isEphemeralRuntime(path: string): boolean {
  const temp = tmpdir();
  return (
    path.includes(`${sep}_npx${sep}`) ||
    path.includes(`${sep}dlx${sep}`) ||
    path === temp ||
    path.startsWith(temp + sep)
  );
}
// harn:end setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs

function installedWrapperPackageJson(location: string): string {
  return join(location, 'node_modules', '@richhardry', 'codor', 'package.json');
}

// harn:assume setup-installs-durable-per-user-runtime-atomically ref=durable-runtime-install
/** The self-contained module tree the running CLI resolves against, and whether
 *  it is already durable (a source checkout or a stable install) or ephemeral
 *  (an npx cache, a pnpm dlx cache, or a temp dir that must be copied before a
 *  service points at it). */
export function resolveInstallSource(runtime: RuntimePaths): { installRoot: string; nodeModules: string; durable: boolean } {
  // harn:assume setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs ref=pnpm-dlx-source-checkout-boundary
  if (runtime.layout === 'source-checkout') {
    return { installRoot: runtime.root, nodeModules: join(runtime.root, 'node_modules'), durable: true };
  }
  // harn:end setup-treats-pnpm-dlx-runtimes-as-ephemeral-durable-copy-inputs
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
 * working install. A staged copy must also open a SQLite database under the
 * supplied service Node binary; a tree whose native binding is absent is
 * discarded before the swap, and a matching installed runtime that fails the
 * check is not reused.
 */
export function installDurableRuntime(options: {
  runtime: RuntimePaths;
  dataDir: string;
  version: string;
  intent?: InstallIntent;
  io?: InstallIo;
  /** Node binary the service will run. Named so the staged tree can prove its
   *  native modules load under that exact ABI before the atomic swap. */
  nodePath?: string;
  /** Called immediately before the swap moves any existing runtime. A Windows
   *  service must be quiesced here, because a swap may follow a native-probe
   *  rejection rather than only an explicit update. */
  beforeSwap?: () => void;
  retainBackup?: boolean;
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
  // Reuse a matching install unless an explicit update was requested or the
  // installed runtime no longer loads its native modules under the service Node.
  if (intent !== 'update' && existing === options.version) {
    const installedProbe = probeRuntimeNatives(io, installedCliRoot(location), options.nodePath);
    if (installedProbe === undefined || installedProbe.ok) {
      return { runtime: installed, location, action: 'reused', version: options.version };
    }
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
  const stagedProbe = probeRuntimeNatives(io, stagedCli, options.nodePath);
  if (stagedProbe !== undefined && !stagedProbe.ok) {
    io.remove(staging);
    throw new Error(
      `the staged Codor runtime at ${staging} cannot load its better-sqlite3 native binding under ${options.nodePath}: ${stagedProbe.detail ?? 'the database probe failed'}`,
    );
  }
  try {
    options.beforeSwap?.();
  } catch (error) {
    io.remove(staging);
    throw error;
  }
  if (io.exists(backup)) io.remove(backup);
  if (io.exists(location)) io.move(location, backup);
  try {
    io.move(staging, location);
  } catch (error) {
    if (io.exists(backup)) io.move(backup, location); // roll back to the previous install
    throw error;
  }
  if (!options.retainBackup && io.exists(backup)) io.remove(backup);
  return {
    runtime: installed,
    location,
    action: existing === undefined ? 'installed' : 'updated',
    version: options.version,
    ...(options.retainBackup
      ? { transaction: { backup, ...(existing === undefined ? {} : { previousVersion: existing }) } }
      : {}),
  };
}

// harn:assume runtime-update-restores-every-mutated-runtime-service-and-launcher-surface ref=durable-runtime-transaction
/** Commit a retained runtime swap after the selected service generation has
 * proved healthy. Safe to call repeatedly. */
export function finalizeDurableRuntimeInstall(
  result: DurableInstallResult,
  io: InstallIo = defaultInstallIo,
): void {
  if (result.transaction && io.exists(result.transaction.backup)) io.remove(result.transaction.backup);
}

/** Restore the exact pre-swap runtime after service convergence fails. */
export function rollbackDurableRuntimeInstall(
  result: DurableInstallResult,
  io: InstallIo = defaultInstallIo,
): void {
  if (!result.transaction) return;
  if (io.exists(result.location)) io.remove(result.location);
  if (io.exists(result.transaction.backup)) io.move(result.transaction.backup, result.location);
}
// harn:end runtime-update-restores-every-mutated-runtime-service-and-launcher-surface
// harn:end setup-installs-durable-per-user-runtime-atomically
