import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { InstallIo } from './runtime-install.js';
import type { RuntimePaths } from './runtime-paths.js';
import { runCli } from './program.js';
import { runCandidateUpdate, runOfficialUpdate, type UpdateCommandResult } from './update.js';

const DATA = '/home/test/.codor';
const RUNTIME: RuntimePaths = {
  layout: 'installed-package',
  root: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli',
  cliEntrypoint: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/dist/index.js',
  staticRoot: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/runtime/web',
  serviceTemplate: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/packaging/systemd/codor.service',
};

function installed(version = '0.10.11', dataDir = DATA): InstallIo {
  return {
    exists: (path) => path === join(dataDir, 'runtime'),
    readVersion: () => version,
    copyTree: vi.fn(), move: vi.fn(), remove: vi.fn(),
  };
}

function missing(): InstallIo {
  return {
    exists: () => false,
    readVersion: () => undefined,
    copyTree: vi.fn(), move: vi.fn(), remove: vi.fn(),
  };
}

const ok = (stdout = ''): UpdateCommandResult => ({ status: 0, stdout, stderr: '' });

// harn:assume official-codor-update-is-bounded-cross-platform-and-durable-rooted ref=stable-update-regression
describe('runOfficialUpdate', () => {
  it('is a true no-op when the durable runtime is already latest', async () => {
    const run = vi.fn(() => ok('"0.10.11"'));
    const out = vi.fn();
    await runOfficialUpdate({
      dataDir: DATA, env: {}, out,
      overrides: { runtime: RUNTIME, installIo: installed(), run },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toEqual([
      'view', '@richhardry/codor@latest', 'version', '--json',
      '--registry', 'https://registry.npmjs.org/',
      '--@richhardry:registry=https://registry.npmjs.org/',
    ]);
    expect(run.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 15_000 });
    expect(out).toHaveBeenCalledWith('Codor 0.10.11 is already current');
  });

  it('acquires one exact release without a shell and invokes only its candidate updater', async () => {
    const prefix = '/tmp/codor-candidate';
    const candidate = join(prefix, 'node_modules/@richhardry/codor/bin/codor.mjs');
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn((command: string, args: string[]) => {
      calls.push([command, args]);
      if (args[0] === 'view') return ok('"0.10.12"');
      if (command === '/usr/bin/node') return ok('candidate applied');
      return ok();
    });
    const removeTemp = vi.fn();
    const out = vi.fn();
    await runOfficialUpdate({
      dataDir: DATA, env: { PATH: '/usr/bin' }, out,
      overrides: {
        runtime: RUNTIME,
        installIo: installed(),
        makeTemp: () => prefix,
        removeTemp,
        exists: (path) => path === candidate,
        nodePath: '/usr/bin/node',
        run,
      },
    });

    expect(calls).toEqual([
      ['npm', ['view', '@richhardry/codor@latest', 'version', '--json', '--registry', 'https://registry.npmjs.org/', '--@richhardry:registry=https://registry.npmjs.org/']],
      ['npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--no-save', '--registry', 'https://registry.npmjs.org/', '--@richhardry:registry=https://registry.npmjs.org/', '@richhardry/codor@0.10.12']],
      ['/usr/bin/node', [candidate, '--data-dir', DATA, '__apply-update', '--expected-version', '0.10.12']],
    ]);
    expect(removeTemp).toHaveBeenCalledWith(prefix);
    expect(out).toHaveBeenCalledWith('candidate applied');
  });

  it('allows a source-linked launcher to update an existing durable installation', async () => {
    const run = vi.fn(() => ok('"0.10.11"'));
    await runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: { runtime: { ...RUNTIME, layout: 'source-checkout' }, installIo: installed(), run },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps source-checkout guidance when there is no durable installation', async () => {
    const run = vi.fn();
    await expect(runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: { runtime: { ...RUNTIME, layout: 'source-checkout' }, installIo: missing(), run },
    })).rejects.toThrow(/update this source checkout with Git/);
    expect(run).not.toHaveBeenCalled();
  });

  it('never downgrades a durable runtime newer than official stable', async () => {
    const makeTemp = vi.fn();
    const out = vi.fn();
    await runOfficialUpdate({
      dataDir: DATA, env: {}, out,
      overrides: { runtime: RUNTIME, installIo: installed('0.11.0'), makeTemp, run: () => ok('"0.10.12"') },
    });
    expect(makeTemp).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledWith('Codor 0.11.0 is newer than official stable 0.10.12; no downgrade was applied');
  });

  it('executes npm through Node and its JavaScript entrypoint on Windows', async () => {
    const run = vi.fn(() => ok('"0.10.11"'));
    await runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: {
        runtime: RUNTIME, installIo: installed(), platform: 'win32',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        npmCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        exists: (path) => path.endsWith('npm-cli.js'), run,
      },
    });
    expect(run.mock.calls[0]?.[0]).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(run.mock.calls[0]?.[1]?.[0]).toMatch(/npm-cli\.js$/);
  });

  it.each([
    { phase: 'lookup', timeout: '11', timeouts: { lookupMs: 11 } },
    { phase: 'acquisition', timeout: '22', timeouts: { acquisitionMs: 22 } },
    { phase: 'candidate', timeout: '33', timeouts: { candidateMs: 33 } },
  ])('bounds $phase execution with an actionable timeout', async ({ phase, timeout, timeouts }) => {
    const prefix = '/tmp/codor-timeout-candidate';
    const candidate = join(prefix, 'node_modules/@richhardry/codor/bin/codor.mjs');
    const run = vi.fn((command: string, args: string[]) => {
      const current = args[0] === 'view' ? 'lookup' : command === '/usr/bin/node' ? 'candidate' : 'acquisition';
      if (current === phase) return { status: 1, stdout: '', stderr: '', timedOut: true };
      return args[0] === 'view' ? ok('"0.10.12"') : ok();
    });
    await expect(runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: {
        runtime: RUNTIME, installIo: installed(), makeTemp: () => prefix,
        removeTemp: vi.fn(), exists: (path) => path === candidate,
        nodePath: '/usr/bin/node', run, timeouts,
      },
    })).rejects.toThrow(new RegExp(`timed out after ${timeout} ms`));
  });

  it('rejects prerelease or malformed latest values and cleans failed acquisition staging', async () => {
    await expect(runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: { runtime: RUNTIME, installIo: installed(), run: () => ok('"0.11.0-alpha.1"') },
    })).rejects.toThrow(/exact stable/);

    const removeTemp = vi.fn();
    await expect(runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: {
        runtime: RUNTIME, installIo: installed(), makeTemp: () => '/tmp/failed', removeTemp,
        run: (_command, args) => args[0] === 'view' ? ok('"0.10.12"') : { status: 1, stdout: '', stderr: 'offline' },
      },
    })).rejects.toThrow(/offline/);
    expect(removeTemp).toHaveBeenCalledWith('/tmp/failed');
  });
});
// harn:end official-codor-update-is-bounded-cross-platform-and-durable-rooted

// harn:assume runtime-update-transacts-runtime-service-and-selected-data-root ref=update-rollback-regression
it('hands candidate application to the acquired package implementation', async () => {
  const applyCandidate = vi.fn(async () => undefined);
  await runCandidateUpdate({
    dataDir: DATA,
    expectedVersion: '0.10.12', env: { HOME: '/home/test' }, out: vi.fn(),
    overrides: { applyCandidate },
  });
  expect(applyCandidate).toHaveBeenCalledWith(expect.objectContaining({ dataDir: DATA, expectedVersion: '0.10.12' }));
});

it('threads the public data root through the private CLI handoff', async () => {
  const applyCandidate = vi.fn(async () => undefined);
  await runCli([
    'node', 'codor', '--data-dir', '/selected/codor-data',
    '__apply-update', '--expected-version', '0.10.12',
  ], { env: {}, update: { applyCandidate } });
  expect(applyCandidate).toHaveBeenCalledWith(expect.objectContaining({
    dataDir: '/selected/codor-data',
    expectedVersion: '0.10.12',
  }));
});

function updateFixture(): {
  root: string;
  home: string;
  dataDir: string;
  defaultDataDir: string;
  candidate: RuntimePaths;
  commands: string[];
  envPath: string;
  unitPath: string;
  sentinel: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'codor-update-journey-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'selected-data');
  const defaultDataDir = join(home, '.codor');
  const candidateInstall = join(root, 'candidate');
  const wrapper = join(candidateInstall, 'node_modules/@richhardry/codor');
  const candidateRoot = join(wrapper, 'node_modules/@codor/cli');
  const makeRuntime = (location: string, version: string): void => {
    const installedWrapper = join(location, 'node_modules/@richhardry/codor');
    const cli = join(installedWrapper, 'node_modules/@codor/cli');
    mkdirSync(join(cli, 'dist'), { recursive: true });
    mkdirSync(join(cli, 'runtime/web'), { recursive: true });
    mkdirSync(join(cli, 'packaging/systemd'), { recursive: true });
    writeFileSync(join(installedWrapper, 'package.json'), JSON.stringify({ name: '@richhardry/codor', version }));
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@codor/cli', version }));
    writeFileSync(join(cli, 'dist/index.js'), '// cli');
    writeFileSync(join(cli, 'runtime/web/index.html'), '<!doctype html>');
    writeFileSync(join(cli, 'packaging/systemd/codor.service'), '[Service]\nWorkingDirectory=/old\nEnvironmentFile=/old\nExecStart=/old\n');
  };
  makeRuntime(candidateInstall, '0.10.12');
  makeRuntime(join(dataDir, 'runtime'), '0.10.11');
  mkdirSync(join(home, '.config/codor'), { recursive: true });
  writeFileSync(join(home, '.config/codor/token'), 'operator-token\n', { mode: 0o600 });
  const envPath = join(home, '.config/codor/env');
  const unitPath = join(home, '.config/systemd/user/codor.service');
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
  writeFileSync(envPath, 'EXACT=prior-env\n', { mode: 0o640 });
  writeFileSync(unitPath, '[Service]\nExecStart=/exact/prior\n', { mode: 0o640 });
  chmodSync(envPath, 0o640);
  chmodSync(unitPath, 0o640);
  const sentinel = join(dataDir, 'switchboard.sqlite');
  writeFileSync(sentinel, 'durable user state');
  const commands: string[] = [];
  return {
    root,
    home,
    dataDir,
    defaultDataDir,
    candidate: {
      layout: 'installed-package', root: candidateRoot,
      cliEntrypoint: join(candidateRoot, 'dist/index.js'),
      staticRoot: join(candidateRoot, 'runtime/web'),
      serviceTemplate: join(candidateRoot, 'packaging/systemd/codor.service'),
    },
    commands,
    envPath,
    unitPath,
    sentinel,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it('updates a previous durable runtime, preserves state, and proves one replacement generation', async () => {
  const fixture = updateFixture();
  try {
    await runCandidateUpdate({
      dataDir: fixture.dataDir,
      expectedVersion: '0.10.12',
      env: { HOME: fixture.home, USER: 'tester', PATH: '/usr/bin' },
      out: vi.fn(),
      overrides: { setup: {
        runtime: fixture.candidate,
        home: fixture.home,
        nodePath: '/usr/bin/node',
        platform: 'linux',
        generation: () => 'candidate-generation',
        exec: (command, args) => { fixture.commands.push([command, ...args].join(' ')); return command === 'loginctl' ? 'yes' : ''; },
        which: () => undefined,
        probe: async () => true,
        runtimeStatus: async () => ({ version: '0.10.12', generation: 'candidate-generation' }),
        sleep: async () => undefined,
      } },
    });

    expect(JSON.parse(readFileSync(join(fixture.dataDir, 'runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.12' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(existsSync(join(fixture.dataDir, 'runtime.backup'))).toBe(false);
    expect(existsSync(fixture.defaultDataDir)).toBe(false);
    expect(fixture.commands.filter((command) => command === 'systemctl --user restart codor.service')).toHaveLength(1);
    expect(fixture.commands).toContain('systemctl --user enable codor.service');
  } finally {
    fixture.cleanup();
  }
});

it('rolls back a candidate whose live service identity does not match', async () => {
  const fixture = updateFixture();
  const generations = ['candidate-generation', 'rollback-generation'];
  try {
    await expect(runCandidateUpdate({
      dataDir: fixture.dataDir,
      expectedVersion: '0.10.12',
      env: { HOME: fixture.home, USER: 'tester', PATH: '/usr/bin' },
      out: vi.fn(),
      overrides: { setup: {
        runtime: fixture.candidate,
        home: fixture.home,
        nodePath: '/usr/bin/node',
        platform: 'linux',
        generation: () => generations.shift()!,
        exec: (command, args) => { fixture.commands.push([command, ...args].join(' ')); return command === 'loginctl' ? 'yes' : ''; },
        which: () => undefined,
        probe: async () => true,
        runtimeStatus: async (_endpoint, _token) => fixture.commands.filter((command) => command === 'systemctl --user restart codor.service').length === 1
          ? { version: '0.10.11', generation: 'stale-generation' }
          : { version: '0.10.11', generation: 'rollback-generation' },
        sleep: async () => undefined,
      } },
    })).rejects.toThrow(/Codor 0\.10\.11 was restored and version-verified/);

    expect(JSON.parse(readFileSync(join(fixture.dataDir, 'runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.11' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(fixture.commands.filter((command) => command === 'systemctl --user restart codor.service')).toHaveLength(2);
    expect(readFileSync(fixture.envPath, 'utf8')).toBe('EXACT=prior-env\n');
    expect(readFileSync(fixture.unitPath, 'utf8')).toBe('[Service]\nExecStart=/exact/prior\n');
    expect(statSync(fixture.envPath).mode & 0o777).toBe(0o640);
    expect(statSync(fixture.unitPath).mode & 0o777).toBe(0o640);
  } finally {
    fixture.cleanup();
  }
});

it('rolls back and reconverges the previous runtime when the candidate restart fails', async () => {
  const fixture = updateFixture();
  const generations = ['candidate-generation', 'rollback-generation'];
  let restartAttempts = 0;
  try {
    await expect(runCandidateUpdate({
      dataDir: fixture.dataDir,
      expectedVersion: '0.10.12',
      env: { HOME: fixture.home, USER: 'tester', PATH: '/usr/bin' },
      out: vi.fn(),
      overrides: { setup: {
        runtime: fixture.candidate,
        home: fixture.home,
        nodePath: '/usr/bin/node',
        platform: 'linux',
        generation: () => generations.shift()!,
        exec: (command, args) => {
          const rendered = [command, ...args].join(' ');
          fixture.commands.push(rendered);
          if (rendered === 'systemctl --user restart codor.service') {
            restartAttempts += 1;
            if (restartAttempts === 1) throw new Error('candidate restart failed');
          }
          return command === 'loginctl' ? 'yes' : '';
        },
        which: () => undefined,
        probe: async () => true,
        runtimeStatus: async () => ({ version: '0.10.11', generation: 'rollback-generation' }),
        sleep: async () => undefined,
      } },
    })).rejects.toThrow(/candidate restart failed.*Codor 0\.10\.11 was restored and version-verified/);

    expect(JSON.parse(readFileSync(join(fixture.dataDir, 'runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.11' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(restartAttempts).toBe(2);
  } finally {
    fixture.cleanup();
  }
});

it('reports a restored legacy daemon as healthy but identity-unverified', async () => {
  const fixture = updateFixture();
  try {
    await expect(runCandidateUpdate({
      dataDir: fixture.dataDir,
      expectedVersion: '0.10.12',
      env: { HOME: fixture.home, USER: 'tester', PATH: '/usr/bin' },
      out: vi.fn(),
      overrides: { setup: {
        runtime: fixture.candidate,
        home: fixture.home,
        nodePath: '/usr/bin/node',
        platform: 'linux',
        generation: () => 'candidate-generation',
        exec: (command, args) => { fixture.commands.push([command, ...args].join(' ')); return command === 'loginctl' ? 'yes' : ''; },
        which: () => undefined,
        probe: async () => true,
        runtimeStatus: async () => undefined,
        sleep: async () => undefined,
      } },
    })).rejects.toThrow(/generically healthy, but its legacy identity is unverified/);
    expect(readFileSync(fixture.envPath, 'utf8')).toBe('EXACT=prior-env\n');
    expect(readFileSync(fixture.unitPath, 'utf8')).toBe('[Service]\nExecStart=/exact/prior\n');
  } finally {
    fixture.cleanup();
  }
});

it.each([
  { platform: 'darwin' as const, existing: 'Library/LaunchAgents/app.codor.switchboard.plist', absent: undefined },
  { platform: 'win32' as const, existing: '.config/codor/codor-service.ps1', absent: '.config/codor/codor-task.xml' },
])('restores exact $platform service files and prior existence', async ({ platform, existing, absent }) => {
  const fixture = updateFixture();
  const existingPath = join(fixture.home, existing);
  mkdirSync(dirname(existingPath), { recursive: true });
  const prior = Buffer.from(`exact prior ${platform} service bytes\n`);
  writeFileSync(existingPath, prior);
  if (absent !== undefined) rmSync(join(fixture.home, absent), { force: true });
  try {
    await expect(runCandidateUpdate({
      dataDir: fixture.dataDir,
      expectedVersion: '0.10.12',
      env: {
        HOME: fixture.home, USER: 'tester', USERNAME: 'tester',
        PATH: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
      },
      out: vi.fn(),
      overrides: { setup: {
        runtime: fixture.candidate,
        home: fixture.home,
        nodePath: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
        platform,
        uid: 501,
        generation: () => 'candidate-generation',
        exec: (command, args) => {
          fixture.commands.push([command, ...args].join(' '));
          if (platform === 'darwin' && command === 'launchctl' && args[0] === 'print') throw new Error('not loaded');
          return '';
        },
        exists: () => true,
        which: () => undefined,
        probe: async () => true,
        runtimeStatus: async () => ({ version: '0.10.11', generation: 'prior-generation' }),
        sleep: async () => undefined,
      } },
    })).rejects.toThrow(/Codor 0\.10\.11 was restored and version-verified/);
    expect(readFileSync(existingPath)).toEqual(prior);
    if (absent !== undefined) expect(existsSync(join(fixture.home, absent))).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
// harn:end runtime-update-transacts-runtime-service-and-selected-data-root
