import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectInstalledRuntime, type InstallIo } from './runtime-install.js';
import { resolveRuntimePaths, type RuntimePaths } from './runtime-paths.js';
import { runSetup, type SetupOverrides } from './setup.js';

const PUBLIC_PACKAGE = '@richhardry/codor';
const EXACT_STABLE = /^\d+\.\d+\.\d+$/;

export interface UpdateCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface UpdateOverrides {
  runtime?: RuntimePaths;
  installIo?: InstallIo;
  npmCommand?: string;
  nodePath?: string;
  exists?(path: string): boolean;
  makeTemp?(): string;
  removeTemp?(path: string): void;
  run?(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): UpdateCommandResult;
  setup?: SetupOverrides;
  applyCandidate?(options: { expectedVersion: string; env: NodeJS.ProcessEnv; out(line: string): void; setup?: SetupOverrides }): Promise<void>;
}

export interface UpdateOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: UpdateOverrides;
}

const defaultRun = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): UpdateCommandResult => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function commandFailure(label: string, result: UpdateCommandResult): Error {
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

// harn:assume official-codor-update-acquires-one-exact-stable-candidate ref=stable-update-acquisition
export async function runOfficialUpdate(options: UpdateOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const runtime = overrides.runtime ?? resolveRuntimePaths();
  if (runtime.layout === 'source-checkout') {
    throw new Error('codor update is for packaged installs; update this source checkout with Git and rebuild instead');
  }
  const installed = detectInstalledRuntime(options.dataDir, overrides.installIo);
  if (!installed) throw new Error('no durable Codor installation was found; run `codor install` first');

  const run = overrides.run ?? defaultRun;
  const npm = overrides.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const resolved = run(npm, ['view', `${PUBLIC_PACKAGE}@latest`, 'version', '--json'], { env: options.env });
  if (resolved.status !== 0) throw commandFailure('could not resolve the official Codor stable release', resolved);
  const version = stableVersion(resolved.stdout);
  if (version === installed.version) {
    options.out(`Codor ${version} is already current`);
    return;
  }

  const prefix = overrides.makeTemp?.() ?? mkdtempSync(join(tmpdir(), 'codor-update-'));
  try {
    const acquired = run(npm, [
      'install',
      '--prefix', prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      `${PUBLIC_PACKAGE}@${version}`,
    ], { env: options.env });
    if (acquired.status !== 0) throw commandFailure(`could not acquire ${PUBLIC_PACKAGE}@${version}`, acquired);

    const candidate = join(prefix, 'node_modules', '@richhardry', 'codor', 'bin', 'codor.mjs');
    if (!(overrides.exists ?? existsSync)(candidate)) {
      throw new Error(`the acquired Codor ${version} package is missing its private updater entrypoint`);
    }
    const applied = run(overrides.nodePath ?? process.execPath, [
      candidate,
      '--data-dir', options.dataDir,
      '__apply-update',
      '--expected-version', version,
    ], { env: options.env });
    if (applied.status !== 0) throw commandFailure(`Codor ${version} could not be applied`, applied);
    for (const line of applied.stdout.trim().split(/\r?\n/).filter(Boolean)) options.out(line);
  } finally {
    (overrides.removeTemp ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(prefix);
  }
}
// harn:end official-codor-update-acquires-one-exact-stable-candidate

// harn:assume runtime-update-is-transactional-through-service-readiness ref=private-update-application
export async function runCandidateUpdate(options: {
  expectedVersion: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: UpdateOverrides;
}): Promise<void> {
  const apply = options.overrides?.applyCandidate;
  if (apply) {
    await apply({ expectedVersion: options.expectedVersion, env: options.env, out: options.out, setup: options.overrides?.setup });
    return;
  }
  await runSetup({
    dryRun: false,
    env: options.env,
    out: options.out,
    overrides: options.overrides?.setup,
    updateOnly: { expectedVersion: options.expectedVersion },
  });
}
// harn:end runtime-update-is-transactional-through-service-readiness
