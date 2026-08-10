import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { InstallIo } from './runtime-install.js';
import type { RuntimePaths } from './runtime-paths.js';
import { runCandidateUpdate, runOfficialUpdate, type UpdateCommandResult } from './update.js';

const DATA = '/home/test/.codor';
const RUNTIME: RuntimePaths = {
  layout: 'installed-package',
  root: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli',
  cliEntrypoint: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/dist/index.js',
  staticRoot: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/runtime/web',
  serviceTemplate: '/home/test/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/packaging/systemd/codor.service',
};

function installed(version = '0.10.11'): InstallIo {
  return {
    exists: (path) => path === join(DATA, 'runtime'),
    readVersion: () => version,
    copyTree: vi.fn(), move: vi.fn(), remove: vi.fn(),
  };
}

const ok = (stdout = ''): UpdateCommandResult => ({ status: 0, stdout, stderr: '' });

// harn:assume official-codor-update-acquires-one-exact-stable-candidate ref=stable-update-regression
describe('runOfficialUpdate', () => {
  it('is a true no-op when the durable runtime is already latest', async () => {
    const run = vi.fn(() => ok('"0.10.11"'));
    const out = vi.fn();
    await runOfficialUpdate({
      dataDir: DATA, env: {}, out,
      overrides: { runtime: RUNTIME, installIo: installed(), run },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toEqual(['view', '@richhardry/codor@latest', 'version', '--json']);
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
      ['npm', ['view', '@richhardry/codor@latest', 'version', '--json']],
      ['npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--no-save', '@richhardry/codor@0.10.12']],
      ['/usr/bin/node', [candidate, '--data-dir', DATA, '__apply-update', '--expected-version', '0.10.12']],
    ]);
    expect(removeTemp).toHaveBeenCalledWith(prefix);
    expect(out).toHaveBeenCalledWith('candidate applied');
  });

  it('refuses source checkouts before touching npm', async () => {
    const run = vi.fn();
    await expect(runOfficialUpdate({
      dataDir: DATA, env: {}, out: vi.fn(),
      overrides: { runtime: { ...RUNTIME, layout: 'source-checkout' }, installIo: installed(), run },
    })).rejects.toThrow(/update this source checkout with Git/);
    expect(run).not.toHaveBeenCalled();
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
// harn:end official-codor-update-acquires-one-exact-stable-candidate

// harn:assume runtime-update-is-transactional-through-service-readiness ref=update-rollback-regression
it('hands candidate application to the acquired package implementation', async () => {
  const applyCandidate = vi.fn(async () => undefined);
  await runCandidateUpdate({
    expectedVersion: '0.10.12', env: { HOME: '/home/test' }, out: vi.fn(),
    overrides: { applyCandidate },
  });
  expect(applyCandidate).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: '0.10.12' }));
});

function updateFixture(): {
  root: string;
  home: string;
  candidate: RuntimePaths;
  commands: string[];
  sentinel: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'codor-update-journey-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.codor');
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
  const sentinel = join(dataDir, 'switchboard.sqlite');
  writeFileSync(sentinel, 'durable user state');
  const commands: string[] = [];
  return {
    root,
    home,
    candidate: {
      layout: 'installed-package', root: candidateRoot,
      cliEntrypoint: join(candidateRoot, 'dist/index.js'),
      staticRoot: join(candidateRoot, 'runtime/web'),
      serviceTemplate: join(candidateRoot, 'packaging/systemd/codor.service'),
    },
    commands,
    sentinel,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it('updates a previous durable runtime, preserves state, and proves one replacement generation', async () => {
  const fixture = updateFixture();
  try {
    await runCandidateUpdate({
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

    expect(JSON.parse(readFileSync(join(fixture.home, '.codor/runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.12' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(existsSync(join(fixture.home, '.codor/runtime.backup'))).toBe(false);
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
    })).rejects.toThrow(/Codor 0\.10\.11 was restored and is ready/);

    expect(JSON.parse(readFileSync(join(fixture.home, '.codor/runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.11' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(fixture.commands.filter((command) => command === 'systemctl --user restart codor.service')).toHaveLength(2);
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
    })).rejects.toThrow(/candidate restart failed.*Codor 0\.10\.11 was restored and is ready/);

    expect(JSON.parse(readFileSync(join(fixture.home, '.codor/runtime/node_modules/@richhardry/codor/package.json'), 'utf8')))
      .toMatchObject({ version: '0.10.11' });
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('durable user state');
    expect(restartAttempts).toBe(2);
  } finally {
    fixture.cleanup();
  }
});
// harn:end runtime-update-is-transactional-through-service-readiness
