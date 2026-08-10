import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { detectInstalledRuntime, type InstallIo } from './runtime-install.js';
import { resolveRuntimePaths, type RuntimePaths } from './runtime-paths.js';
import { runSetup, type SetupOverrides } from './setup.js';

const PUBLIC_PACKAGE = '@richhardry/codor';
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const EXACT_STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEFAULT_TIMEOUTS = {
  lookupMs: 15_000,
  acquisitionMs: 120_000,
  candidateMs: 300_000,
} as const;

export interface UpdateCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface UpdateOverrides {
  runtime?: RuntimePaths;
  installIo?: InstallIo;
  npmCommand?: string;
  npmCliPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
  exists?(path: string): boolean;
  makeTemp?(): string;
  removeTemp?(path: string): void;
  run?(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): UpdateCommandResult;
  setup?: SetupOverrides;
  applyCandidate?(options: {
    dataDir: string;
    expectedVersion: string;
    env: NodeJS.ProcessEnv;
    out(line: string): void;
    setup?: SetupOverrides;
  }): Promise<void>;
}

export interface UpdateOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: UpdateOverrides;
}

const defaultRun = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): UpdateCommandResult => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code !== 'ETIMEDOUT') throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { timedOut: true }),
  };
};

function commandFailure(label: string, result: UpdateCommandResult, timeoutMs: number): Error {
  if (result.timedOut) return new Error(`${label} timed out after ${String(timeoutMs)} ms`);
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  return new Error(`${label}: ${detail}`);
}

function stableVersion(stdout: string): string {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { value = stdout.trim(); }
  const version = typeof value === 'string' ? value.trim() : '';
  if (!EXACT_STABLE.test(version)) {
    throw new Error(`npm latest did not resolve to an exact stable Codor version: ${version || '<empty>'}`);
  }
  return version;
}

function compareStable(left: string, right: string): number {
  const parse = (value: string): bigint[] => {
    const matched = EXACT_STABLE.exec(value);
    if (!matched) throw new Error(`installed Codor version is not an exact stable version: ${value}`);
    return matched.slice(1).map((part) => BigInt(part));
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

function npmInvocation(options: {
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  nodePath: string;
  npmCliPath?: string;
  npmCommand?: string;
  platform: NodeJS.Platform;
}): { command: string; prefix: string[] } {
  if (options.platform !== 'win32') return { command: options.npmCommand ?? 'npm', prefix: [] };
  const candidates = [
    options.npmCliPath,
    options.env.npm_execpath,
    join(dirname(options.nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(options.nodePath)), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((value): value is string => typeof value === 'string' && /(?:npm-cli|npm)\.(?:c?js)$/i.test(value));
  const cli = candidates.find((value) => options.exists(value));
  if (!cli) {
    throw new Error('codor update could not locate npm\'s JavaScript entrypoint for shell-free Windows execution');
  }
  return { command: options.nodePath, prefix: [cli] };
}

function boundedRun(
  run: NonNullable<UpdateOverrides['run']>,
  label: string,
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): UpdateCommandResult {
  let result: UpdateCommandResult;
  try {
    result = run(command, args, { env, timeoutMs });
  } catch (error) {
    throw new Error(`${label}: ${String(error)}`);
  }
  if (result.status !== 0 || result.timedOut) throw commandFailure(label, result, timeoutMs);
  return result;
}

// harn:assume official-codor-update-is-bounded-cross-platform-and-durable-rooted ref=stable-update-acquisition
export async function runOfficialUpdate(options: UpdateOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const runtime = overrides.runtime ?? resolveRuntimePaths();
  const installed = detectInstalledRuntime(options.dataDir, overrides.installIo);
  if (!installed) {
    if (runtime.layout === 'source-checkout') {
      throw new Error('no durable Codor installation was found; update this source checkout with Git and rebuild, or run `codor install` first');
    }
    throw new Error('no durable Codor installation was found; run `codor install` first');
  }

  const run = overrides.run ?? defaultRun;
  const exists = overrides.exists ?? existsSync;
  const nodePath = overrides.nodePath ?? process.execPath;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...overrides.timeouts };
  const npm = npmInvocation({
    env: options.env,
    exists,
    nodePath,
    npmCliPath: overrides.npmCliPath,
    npmCommand: overrides.npmCommand,
    platform: overrides.platform ?? process.platform,
  });
  const resolved = boundedRun(
    run,
    'could not resolve the official Codor stable release',
    npm.command,
    [...npm.prefix, 'view', `${PUBLIC_PACKAGE}@latest`, 'version', '--json',
      '--registry', OFFICIAL_REGISTRY,
      `--@richhardry:registry=${OFFICIAL_REGISTRY}`,
    ],
    timeouts.lookupMs,
    options.env,
  );
  const version = stableVersion(resolved.stdout);
  const direction = compareStable(installed.version, version);
  if (direction === 0) {
    options.out(`Codor ${version} is already current`);
    return;
  }
  if (direction > 0) {
    options.out(`Codor ${installed.version} is newer than official stable ${version}; no downgrade was applied`);
    return;
  }

  const prefix = overrides.makeTemp?.() ?? mkdtempSync(join(tmpdir(), 'codor-update-'));
  try {
    boundedRun(run, `could not acquire ${PUBLIC_PACKAGE}@${version}`, npm.command, [...npm.prefix,
      'install',
      '--prefix', prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      '--registry', OFFICIAL_REGISTRY,
      `--@richhardry:registry=${OFFICIAL_REGISTRY}`,
      `${PUBLIC_PACKAGE}@${version}`,
    ], timeouts.acquisitionMs, options.env);

    const candidate = join(prefix, 'node_modules', '@richhardry', 'codor', 'bin', 'codor.mjs');
    if (!exists(candidate)) {
      throw new Error(`the acquired Codor ${version} package is missing its private updater entrypoint`);
    }
    const applied = boundedRun(run, `Codor ${version} could not be applied`, nodePath, [
      candidate,
      '--data-dir', options.dataDir,
      '__apply-update',
      '--expected-version', version,
    ], timeouts.candidateMs, options.env);
    for (const line of applied.stdout.trim().split(/\r?\n/).filter(Boolean)) options.out(line);
  } finally {
    (overrides.removeTemp ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(prefix);
  }
}
// harn:end official-codor-update-is-bounded-cross-platform-and-durable-rooted

// harn:assume runtime-update-transacts-runtime-service-and-selected-data-root ref=private-update-application
export async function runCandidateUpdate(options: {
  dataDir: string;
  expectedVersion: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: UpdateOverrides;
}): Promise<void> {
  const apply = options.overrides?.applyCandidate;
  if (apply) {
    await apply({
      dataDir: options.dataDir,
      expectedVersion: options.expectedVersion,
      env: options.env,
      out: options.out,
      setup: options.overrides?.setup,
    });
    return;
  }
  await runSetup({
    dataDir: options.dataDir,
    dryRun: false,
    env: options.env,
    out: options.out,
    overrides: options.overrides?.setup,
    updateOnly: { expectedVersion: options.expectedVersion },
  });
}
// harn:end runtime-update-transacts-runtime-service-and-selected-data-root
