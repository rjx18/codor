import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_PROTOCOL_EPOCH, type ServerFrame, worktreeSelectorFromBranch } from '@codor/protocol';
import {
  BUILTIN_ADAPTER_IDS,
  CryptoVault,
  Daemon,
  FakeAdapter,
  localSocketPath,
  startServer,
  type RunningServer,
} from '@codor/switchboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  createProgram,
  MANAGEMENT_EXIT_CODES,
  ManagementError,
  cliExitCode,
  detectSession,
  nativeResumeCommand,
  packageName,
  parseMirrorHook,
  renderTerminalQr,
  redactDiagnostic,
  runCli,
  startCodor,
} from './index.js';
import { parseLine, startOutpost } from './up.js';
import { parseAdapterModules } from './program.js';
import { operatorTokenPath, probeCodorStatus, waitForCodor } from './setup.js';

let dir: string;
let daemon: Daemon;
let crypto: CryptoVault;
let fake: FakeAdapter;
let codexFake: FakeAdapter;
let server: RunningServer;
let output: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codor-cli-'));
  fake = new FakeAdapter();
  codexFake = new FakeAdapter('codex', { interactiveAttach: true });
  daemon = new Daemon({
    dbPath: join(dir, 'switchboard.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake, codexFake],
  });
  daemon.createRoom({
    id: 'eng',
    name: 'Engineering',
    owner: { handle: 'richard', display_name: 'Richard' },
  });
  crypto = new CryptoVault(dir);
  crypto.roomKeys.ensureRoom('eng');
  server = await startServer({
    daemon,
    token: 'cli-token',
    socketPath: localSocketPath(dir),
    crypto,
  });
  output = [];
});

const posixHostIt = it.skipIf(process.platform === 'win32');

afterEach(async () => {
  await server.close();
  await daemon.close();
  crypto.close();
  rmSync(dir, { recursive: true, force: true });
});

const cli = (...args: string[]) =>
  runCli(['node', 'codor', '--data-dir', dir, ...args], {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

const memberCli = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  runCli(['node', 'codor', '--data-dir', dir, ...args], {
    env,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

const credentialedAgent = (handle: string) => {
  const originalSpawn = fake.spawn.bind(fake);
  let session: ReturnType<typeof fake.spawn> | undefined;
  const spy = vi.spyOn(fake, 'spawn').mockImplementation((options) => {
    session = originalSpawn(options);
    return session;
  });
  const cwd = join(dir, `${handle}-cwd`);
  mkdirSync(cwd);
  const member = daemon.spawnMember('eng', {
    harness: 'fake',
    handle,
    cwd,
  });
  spy.mockRestore();
  const memberToken = session?.env?.CODOR_MEMBER_TOKEN;
  if (!memberToken) throw new Error('test member credential was not issued');
  return {
    member,
    env: {
      CODOR_SOCKET: localSocketPath(dir),
      CODOR_CHANNEL: 'eng',
      CODOR_MEMBER_ID: member.id,
      CODOR_MEMBER_TOKEN: memberToken,
      CODOR_TOKEN: 'cli-token',
    },
  };
};

const until = async <T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('test wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const startLiveTurn = async (memberId: string) => {
  fake.enqueue({
    kind: 'complete',
    final_text: '@richard test turn complete',
    delay_ms: 300,
  });
  const member = daemon.store.getMember('eng', memberId)!;
  daemon.postHumanMessage('eng', `@${member.handle} start the live test turn`);
  await until(() => daemon.store.getMember('eng', memberId)?.state === 'running' ? true : undefined);
};

describe('@codor/cli', () => {
  it('registers the complete M1 command surface', () => {
    expect(packageName()).toBe('@codor/cli');
    expect(createProgram().commands.map((command) => command.name())).toEqual([
      'up',
      'channels',
      'agent-preset',
      'default-roster',
      'serve',
      'install', 'update', '__apply-update',
      'spawn',
      'post',
      'tail',
      'inbox',
      'status',
      'search',
      'members',
      'join',
      'adopt',
      'mirror-hook',
      'attach',
      'revive',
      'pair',
      'peers',
      'revoke',
      'ledger',
      'relay',
      'agent', 'worktree', 'channel',
    ]);
    const program = createProgram();
    const flatChannels = program.commands.find((command) => command.name() === 'channels');
    const structuredChannels = program.commands.find((command) => command.name() === 'channel');
    expect(flatChannels?.aliases()).toEqual([]);
    expect(flatChannels?.commands).toEqual([]);
    expect(structuredChannels?.aliases()).toEqual([]);
    expect(structuredChannels?.commands.map((command) => command.name())).toEqual([
      'list', 'create', 'show', 'rename', 'archive',
    ]);
    const structuredAgents = program.commands.find((command) => command.name() === 'agent');
    expect(structuredAgents?.aliases()).toEqual([]);
    expect(structuredAgents?.commands.map((command) => command.name())).toEqual([
      'list', 'add', 'configure', 'rename', 'pause', 'revive', 'remove',
    ]);
    expect(program.commands.find((command) => command.name() === 'agent-preset')?.commands.map((command) => command.name()))
      .toEqual(['list', 'create', 'update', 'delete']);
    expect(program.commands.find((command) => command.name() === 'default-roster')?.commands.map((command) => command.name()))
      .toEqual(['show', 'set']);
    expect(program.commands.find((command) => command.name() === 'agent')?.commands.find((command) => command.name() === 'add')?.options.map((option) => option.long))
      .toContain('--preset');
    expect(program.commands.find((command) => command.name() === 'spawn')?.options.map((option) => option.long))
      .toContain('--channel');
    expect(program.commands.flatMap((command) => command.options.map((option) => option.long)))
      .not.toContain('--room');
  });

  // harn:assume codor-runtime-identity-is-a-clean-break ref=runtime-identity-regression
  it('uses Codor runtime identity for the command, service, install target, and default paths', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const cliPackage = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    const program = createProgram({
      env: { CODOR_MEMBER_TOKEN: 'member-secret', CODOR_TOKEN: 'owner-secret' },
    });
    expect(program.name()).toBe('codor');
    expect(program.opts()).toMatchObject({ token: 'member-secret' });
    expect(program.opts().dataDir).toMatch(/\.codor$/);
    // harn:assume cli-help-never-renders-selected-bearer ref=token-help-redaction-regression
    const help = program.helpInformation();
    expect(help).toContain('<redacted>');
    expect(help).not.toContain('member-secret');
    expect(help).not.toContain('owner-secret');
    // harn:end cli-help-never-renders-selected-bearer
    expect(cliPackage.bin).toEqual({ codor: './dist/index.js' });
    for (const file of [
      join(repoRoot, 'packaging', 'systemd', 'codor.service'),
      join(repoRoot, 'scripts', 'install-cli.sh'),
    ]) {
      const legacyName = ['wire', 'room'].join('');
      expect(readFileSync(file, 'utf8').toLowerCase()).not.toContain(legacyName);
    }
  });
  // harn:end codor-runtime-identity-is-a-clean-break

  it('parses outpost lines without truncating secrets that contain colons', () => {
    expect(parseLine('studio:correct:horse')).toEqual({
      name: 'studio',
      secret: 'correct:horse',
    });
    expect(() => parseLine('missing-secret:')).toThrow('name:secret');
  });

  it('pairs, lists, and revokes a device while rotating room keys', async () => {
    await cli('pair', '--no-qr', '--endpoint', `http://127.0.0.1:${String(server.port)}`);
    const url = new URL(output[0]!);
    expect(url.pathname).toBe('/pair');
    const token = url.searchParams.get('pairing_token')!;
    const device = new CryptoVault(join(dir, 'browser-device'));
    const paired = await fetch(`http://127.0.0.1:${String(server.port)}/api/pairing/complete`, {
      method: 'POST',
      headers: { authorization: `Pairing ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...device.keys.publicIdentity(), kind: 'device', label: 'browser' }),
    });
    expect(paired.status).toBe(200);
    const generation = crypto.roomKeys.roomGeneration('eng');

    output = [];
    await cli('peers');
    expect(output).toContain(`${device.keys.identity.device_id}\tdevice\tbrowser`);
    output = [];
    await cli('revoke', 'browser');
    expect(output).toEqual([`revoked ${device.keys.identity.device_id}`]);
    expect(crypto.roomKeys.roomGeneration('eng')).toBe(generation + 1);
    expect(crypto.keys.getPeer(device.keys.identity.device_id)).toBeUndefined();
    device.close();
  });

  it('initializes, adds, shows, and pulls ledger notes', async () => {
    await cli('ledger', 'init', '--channel', 'eng');
    expect(output[0]).toBe(join(dir, 'rooms', 'eng', 'ledger'));
    output = [];
    await cli(
      'ledger', 'add', 'risk-limits', 'Keep exposure below 2%.',
      '--channel', 'eng', '--type', 'constraint', '--as', 'alpha',
    );
    expect(output).toEqual(['constraints/risk-limits.md\t[[risk-limits]]']);
    output = [];
    await cli('ledger', 'show', 'risk-limits', '--channel', 'eng');
    expect(output[0]).toContain('name: risk-limits');
    expect(output[0]).toContain('Keep exposure below 2%.');
    const destination = join(dir, 'snapshot');
    output = [];
    await cli('ledger', 'pull', '--channel', 'eng', '--destination', destination);
    expect(output).toEqual([join(destination, 'ledger')]);
    expect(readFileSync(join(destination, 'ledger', 'constraints', 'risk-limits.md'), 'utf8'))
      .toContain('Keep exposure below 2%.');
  });

  // harn:assume terminal-pairing-qr-matches-plain-url ref=pairing-qr-regression
  it('renders a pairing QR from the exact plain URL and supports explicit plain-only output', async () => {
    let qrPayload: string | undefined;
    await runCli(['node', 'codor', '--data-dir', dir, 'pair'], {
      stdout: (line) => output.push(line),
      renderQr: (payload) => {
        qrPayload = payload;
        return '<terminal-qr>';
      },
    });
    expect(output[0]).toBe('<terminal-qr>');
    expect(qrPayload).toBe(output[1]);
    expect(new URL(qrPayload!).pathname).toBe('/pair');
    expect(renderTerminalQr(qrPayload!)).toMatch(/[▀▄█]/);

    output = [];
    await cli('pair', '--no-qr');
    expect(output).toHaveLength(3);
    expect(output[0]).toMatch(/^http:\/\/127\.0\.0\.1:8137\/pair\?/);
  });
  // harn:end terminal-pairing-qr-matches-plain-url
  // harn:assume pairing-code-enrollment-surfaces ref=pair-code-cli-regression
  it('prints the generated short pairing code in display form', async () => {
    await cli('pair', '--no-qr');
    expect(output[1]).toMatch(/^code: [23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
  });
  // harn:end pairing-code-enrollment-surfaces

  // harn:assume setup-dry-run-reports-without-mutation-or-secret ref=setup-dry-run-regression
  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-systemd-regression
  posixHostIt('snapshots setup dry-run with the absolute Node path and every detected harness directory', async () => {
    const repoRoot = join(fileURLToPath(new URL('../../../', import.meta.url)), '.');
    const home = '/home/setup-test';
    const installed = new Map([
      ['claude', `${home}/.local/bin/claude`],
      ['codex', `${home}/.nvm/versions/node/v22.8.0/bin/codex`],
      ['opencode', `${home}/.opencode/bin/opencode`],
      ['tailscale', '/usr/bin/tailscale'],
    ]);
    await runCli(['node', 'codor', 'setup', '--dry-run'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/local/bin:/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        home,
        nodePath: `${home}/.nvm/versions/node/v22.8.0/bin/node`,
        platform: 'linux',
        repoRoot,
        which: (command) => installed.get(command),
      },
    });
    expect(output.join('\n').replaceAll(repoRoot, '<repo>')).toMatchInlineSnapshot(`
      "[dry-run] use the Codor runtime in place at <repo>
      [dry-run] create /home/setup-test/.config/codor and /home/setup-test/.codor mode 700; create /home/setup-test/.config/codor/token mode 600 if absent
      [dry-run] install codor launcher -> /home/setup-test/.local/bin/codor (exec /home/setup-test/.nvm/versions/node/v22.8.0/bin/node <repo>/packages/cli/dist/index.js)
      [dry-run] install <repo>/packaging/systemd/codor.service -> /home/setup-test/.config/systemd/user/codor.service mode 600
      [dry-run] unit content:
      [Unit]
      Description=Codor local-first agent switchboard
      [Service]
      Type=simple
      WorkingDirectory=<repo>
      EnvironmentFile=/home/setup-test/.config/codor/env
      UMask=0077
      # harn:assume codor-runtime-identity-is-a-clean-break ref=systemd-runtime-identity
      # harn:assume fresh-clone-install-proven-by-script ref=systemd-service
      # harn:assume operator-launches-serve-web-next ref=systemd-current-web-client
      ExecStart="/home/setup-test/.nvm/versions/node/v22.8.0/bin/node" "<repo>/packages/cli/dist/index.js" "--data-dir" "/home/setup-test/.codor" "up" "--static-root" "<repo>/packages/web-next/dist" "--channel" "desk" "--channel-name" "Desk"
      # harn:end operator-launches-serve-web-next
      # harn:end fresh-clone-install-proven-by-script
      # harn:end codor-runtime-identity-is-a-clean-break
      Restart=on-failure
      RestartSec=5s
      TimeoutStopSec=30s
      KillMode=mixed

      [Install]
      WantedBy=default.target
      [dry-run] write /home/setup-test/.config/codor/env mode 600
      CODOR_TOKEN=<redacted generated-or-existing token>
      CODOR_RUNTIME_VERSION=0.10.14-alpha.3
      CODOR_SERVICE_GENERATION=<new-generation>
      PATH=/home/setup-test/.local/bin:/home/setup-test/.nvm/versions/node/v22.8.0/bin:/home/setup-test/.opencode/bin:/usr/local/bin:/usr/bin
      NODE_PATH=<repo>/node_modules/.pnpm/node_modules
      [dry-run] systemctl --user daemon-reload
      [dry-run] systemctl --user enable codor.service
      [dry-run] systemctl --user restart codor.service
      [dry-run] access localhost; skip Tailscale Serve
      [dry-run] enable the relay; first code works at codor.app and on your network
      [dry-run] wait for Codor pairing status, then generate a ten-minute QR, URL, and pairing code"
    `);
    expect(existsSync(join(home, '.config', 'codor'))).toBe(false);
  });
  // harn:end platform-services-propagate-destination-pnpm-node-path

  posixHostIt('refuses to promise Tailscale Serve in a dry-run when the CLI cannot Serve', async () => {
    const home = '/home/setup-test';
    await expect(runCli(['node', 'codor', 'setup', '--dry-run', '--access', 'tailscale'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        home,
        nodePath: `${home}/.nvm/versions/node/v22.8.0/bin/node`,
        platform: 'linux',
        which: (command) => (command === 'tailscale' ? '/usr/bin/tailscale' : undefined),
        // The CLI is present but its `serve --help` probe fails: no Serve support.
        exec: (command, args) => {
          if (command === '/usr/bin/tailscale' && args[0] === 'serve') throw new Error("flag provided but not defined: 'serve'");
          return '';
        },
      },
    })).rejects.toThrow(/requires a Tailscale CLI that supports Serve/);
    expect(output.join('\n')).not.toContain('serve --bg');
  });

  // harn:end setup-dry-run-reports-without-mutation-or-secret

  // harn:assume setup-unattended-mutation-requires-explicit-intent ref=setup-unattended-regression
  posixHostIt('requires explicit approval and access for non-TTY mutation but not dry-run', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const context = {
      env: { HOME: '/home/unattended', USER: 'unattended', PATH: '/usr/bin' },
      stdout: (line: string) => output.push(line),
      setup: {
        home: '/home/unattended',
        nodePath: process.execPath,
        platform: 'linux' as const,
        repoRoot,
        which: () => undefined,
      },
    };
    await expect(runCli(['node', 'codor', 'setup'], context))
      .rejects.toThrow('requires --yes and --access');
    await expect(runCli(['node', 'codor', 'setup', '--yes'], context))
      .rejects.toThrow('also requires --access');
    await expect(runCli(['node', 'codor', 'setup', '--dry-run'], context)).resolves.toBeUndefined();
    expect(output.join('\n')).not.toMatch(/\u001B\[/);
  });
  // harn:end setup-unattended-mutation-requires-explicit-intent

  // harn:assume setup-preserves-private-platform-service ref=setup-platform-service-regression
  // harn:assume setup-resolves-complete-invoking-runtime ref=setup-runtime-resolution-regression
  posixHostIt('renders the Linux service from the checkout that invoked setup', async () => {
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const repoRoot = join(dir, 'repo checkout with spaces');
    const home = join(dir, 'home with spaces');
    mkdirSync(join(repoRoot, 'packaging', 'systemd'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'packaging', 'systemd', 'codor.service'),
      readFileSync(join(sourceRoot, 'packaging', 'systemd', 'codor.service'), 'utf8'),
    );
    mkdirSync(join(repoRoot, 'packages', 'cli', 'dist'), { recursive: true }); writeFileSync(join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), '', 'utf8');
    mkdirSync(join(repoRoot, 'packages', 'web-next', 'dist'), { recursive: true });

    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        exec: (command) => command === 'loginctl' ? 'yes' : '',
        home,
        nodePath: process.execPath,
        platform: 'linux',
        probe: async () => true,
        generation: () => 'setup-generation',
        runtimeStatus: async () => ({ version: 'dev', generation: 'setup-generation' }),
        randomToken: () => 'a'.repeat(64),
        repoRoot,
        sleep: async () => undefined,
        which: () => undefined,
      },
    });

    const unitPath = join(home, '.config', 'systemd', 'user', 'codor.service');
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).toContain(`WorkingDirectory=${repoRoot}`);
    expect(unit).toContain(`EnvironmentFile=${join(home, '.config', 'codor', 'env')}`);
    expect(unit).toContain([
      `ExecStart=\"${process.execPath}\"`,
      `\"${join(repoRoot, 'packages', 'cli', 'dist', 'index.js')}\"`,
      `\"--data-dir\" \"${join(home, '.codor')}\"`,
      '\"up\"',
      `\"--static-root\" \"${join(repoRoot, 'packages', 'web-next', 'dist')}\"`,
    ].join(' '));
    expect(unit).not.toContain('%h/codor');
    if (process.platform === 'linux' && existsSync('/usr/bin/systemd-analyze')) {
      expect(() => execFileSync('/usr/bin/systemd-analyze', ['--user', 'verify', unitPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })).not.toThrow();
    }
  });
  // harn:end setup-resolves-complete-invoking-runtime

  posixHostIt('installs a durable runtime and points the Linux service there when invoked from an npx cache', async () => {
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'npx home');
    const npxCli = join(dir, 'npx cache', '.npm', '_npx', 'deadbeef', 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli');
    const copies: Array<[string, string]> = [];
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        exec: () => '',
        home,
        nodePath: process.execPath,
        platform: 'linux',
        probe: async () => true,
        generation: () => 'setup-generation',
        runtimeStatus: async () => ({ version: 'dev', generation: 'setup-generation' }),
        randomToken: () => 'a'.repeat(64),
        sleep: async () => undefined,
        which: () => undefined,
        runtime: {
          root: npxCli,
          layout: 'installed-package',
          cliEntrypoint: join(npxCli, 'dist', 'index.js'),
          staticRoot: join(npxCli, 'runtime', 'web'),
          serviceTemplate: join(sourceRoot, 'packaging', 'systemd', 'codor.service'),
        },
        installIo: {
          exists: (path) => path.includes('.staging'), // staged assets validate; nothing pre-exists
          copyTree: (from, to) => { copies.push([from, to]); },
          move: () => undefined,
          remove: () => undefined,
          readVersion: () => undefined,
        },
      },
    });

    const durableCli = join(home, '.codor', 'runtime', 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli', 'dist', 'index.js');
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'codor.service'), 'utf8');
    // The service ExecStart references the durable ~/.codor/runtime copy, never the npx cache.
    expect(unit).toContain(`\"${durableCli}\"`);
    expect(unit).not.toContain('_npx');
    // The stubbed installIo reports no pnpm hoist dir at the source root, so no
    // NODE_PATH is derived — the negative case for the pnpm-linked detection.
    expect(readFileSync(join(home, '.config', 'codor', 'env'), 'utf8')).not.toContain('NODE_PATH');
    // The durable install stages the npx module tree beside ~/.codor/runtime.
    expect(copies).toEqual([[
      join(dir, 'npx cache', '.npm', '_npx', 'deadbeef', 'node_modules'),
      join(`${join(home, '.codor', 'runtime')}.staging`, 'node_modules'),
    ]]);
  });

  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-source-probe-regression
  it('derives NODE_PATH from the durable copy, not the ephemeral source, when the invoking runtime is ephemeral', async () => {
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'npx home nodepath');
    const npxCacheRoot = join(dir, 'npx cache nodepath', '.npm', '_npx', 'deadbeef');
    const npxCli = join(npxCacheRoot, 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli');
    const sourceHoistDir = join(npxCacheRoot, 'node_modules', '.pnpm', 'node_modules');
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        exec: () => '',
        home,
        nodePath: process.execPath,
        platform: 'linux',
        probe: async () => true,
        generation: () => 'setup-generation',
        runtimeStatus: async () => ({ version: 'dev', generation: 'setup-generation' }),
        randomToken: () => 'a'.repeat(64),
        sleep: async () => undefined,
        which: () => undefined,
        runtime: {
          root: npxCli,
          layout: 'installed-package',
          cliEntrypoint: join(npxCli, 'dist', 'index.js'),
          staticRoot: join(npxCli, 'runtime', 'web'),
          serviceTemplate: join(sourceRoot, 'packaging', 'systemd', 'codor.service'),
        },
        installIo: {
          // The ephemeral source is pnpm-linked (unlike the sibling npx case
          // above), so the positive derivation actually runs here.
          exists: (path) => path.includes('.staging') || path === sourceHoistDir,
          copyTree: () => undefined,
          move: () => undefined,
          remove: () => undefined,
          readVersion: () => undefined,
        },
      },
    });

    const durableHoistDir = join(home, '.codor', 'runtime', 'node_modules', '.pnpm', 'node_modules');
    const env = readFileSync(join(home, '.config', 'codor', 'env'), 'utf8');
    // This is the case that fails if the probe is pointed at the destination
    // instead of the source: NODE_PATH must be rooted at the durable copy the
    // service will actually run from, never at the ephemeral npx cache path.
    expect(env).toContain(`NODE_PATH=${durableHoistDir}`);
    expect(env).not.toContain(npxCacheRoot);
  });
  // harn:end platform-services-propagate-destination-pnpm-node-path

  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-reused-destination-regression
  it('retains NODE_PATH from a reused pnpm durable destination when the source is not pnpm-linked', async () => {
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'npx home reused');
    const npxCacheRoot = join(dir, 'npx cache reused', '.npm', '_npx', 'deadbeef');
    const npxCli = join(npxCacheRoot, 'node_modules', '@richhardry', 'codor', 'node_modules', '@codor', 'cli');
    const durableRoot = join(home, '.codor', 'runtime');
    const durableHoistDir = join(durableRoot, 'node_modules', '.pnpm', 'node_modules');
    const durablePackageJson = join(durableRoot, 'node_modules', '@richhardry', 'codor', 'package.json');
    const copies: Array<[string, string]> = [];
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        exec: () => '',
        home,
        nodePath: process.execPath,
        platform: 'linux',
        probe: async () => true,
        generation: () => 'setup-generation',
        runtimeStatus: async () => ({ version: 'dev', generation: 'setup-generation' }),
        randomToken: () => 'a'.repeat(64),
        sleep: async () => undefined,
        which: () => undefined,
        runtime: {
          root: npxCli,
          layout: 'installed-package',
          cliEntrypoint: join(npxCli, 'dist', 'index.js'),
          staticRoot: join(npxCli, 'runtime', 'web'),
          serviceTemplate: join(sourceRoot, 'packaging', 'systemd', 'codor.service'),
        },
        installIo: {
          exists: (path) => path === durableRoot || path === durableHoistDir,
          copyTree: (from, to) => { copies.push([from, to]); },
          move: () => { throw new Error('reused durable runtime must not move'); },
          remove: () => { throw new Error('reused durable runtime must not remove'); },
          readVersion: (path) => path === durablePackageJson ? 'dev' : undefined,
        },
      },
    });

    const env = readFileSync(join(home, '.config', 'codor', 'env'), 'utf8');
    expect(env).toContain(`NODE_PATH=${durableHoistDir}`);
    expect(env).not.toContain(npxCacheRoot);
    expect(copies).toEqual([]);
  });
  // harn:end platform-services-propagate-destination-pnpm-node-path

  // harn:assume wsl-setup-keeps-private-windows-loopback ref=wsl-bind-regression
  it.each([
    {
      name: 'ordinary Linux',
      env: {},
      hasWslinfo: false,
      kernelRelease: '6.8.0-generic',
      networkingMode: undefined,
      expectedHost: undefined,
    },
    {
      name: 'WSL1',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      hasWslinfo: true,
      kernelRelease: '4.4.0-19041-Microsoft',
      networkingMode: 'nat',
      expectedHost: undefined,
    },
    {
      name: 'WSL2 NAT with WSL package 2.7.10.0',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      hasWslinfo: true,
      kernelRelease: '5.15.153.1-microsoft-standard-WSL2',
      networkingMode: 'nat',
      expectedHost: '0.0.0.0',
    },
    {
      name: 'older WSL2 without wslinfo',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      hasWslinfo: false,
      kernelRelease: '5.10.102.1-microsoft-standard-WSL2',
      networkingMode: undefined,
      expectedHost: '0.0.0.0',
    },
    {
      name: 'WSL2 mirrored',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      hasWslinfo: true,
      kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      networkingMode: 'mirrored',
      expectedHost: undefined,
    },
  ])('selects the private working service bind for $name', async ({
    env,
    hasWslinfo,
    kernelRelease,
    networkingMode,
    expectedHost,
  }) => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const wslProbes: string[] = [];
    await runCli(['node', 'codor', 'setup', '--dry-run'], {
      env: { HOME: '/home/wsl-test', USER: 'wsl-test', PATH: '/usr/bin', ...env },
      stdout: (line) => output.push(line),
      setup: {
        home: '/home/wsl-test',
        kernelRelease,
        nodePath: '/usr/bin/node',
        platform: 'linux',
        repoRoot,
        exec: (command, args) => {
          if (command === 'wslinfo') {
            wslProbes.push(args[0]!);
            if (args[0] === '--wsl-version') return '2.7.10.0';
            if (args[0] === '--networking-mode') return networkingMode ?? '';
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        which: (command) => command === 'wslinfo' && hasWslinfo
          ? '/usr/bin/wslinfo'
          : undefined,
      },
    });

    const execStart = output.find((line) => line.startsWith('ExecStart='));
    expect(execStart).toBeDefined();
    if (expectedHost === undefined) {
      expect(execStart).not.toContain('"--host"');
    } else {
      expect(execStart).toContain(`"up" "--host" "${expectedHost}"`);
    }
    expect(wslProbes).toEqual(hasWslinfo && /wsl2/i.test(kernelRelease)
      ? ['--networking-mode']
      : []);
    expect(output.join('\n')).toContain('generate a ten-minute QR, URL, and pairing code');
    expect(output.join('\n')).not.toContain('http://0.0.0.0:8137');
  });
  // harn:end wsl-setup-keeps-private-windows-loopback

  // harn:assume setup-readiness-wait-is-wall-clock-bounded ref=readiness-wall-clock-regression
  // harn:assume setup-verifies-codor-before-creating-pairing-code ref=setup-readiness-and-pairing-regression
  it('rejects an arbitrary HTTP listener and bounds Codor readiness retries', async () => {
    let body: unknown = { ok: true };
    const listener = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    try {
      await expect(probeCodorStatus(endpoint)).resolves.toBe(false);
      body = { trusted_enrollment: false };
      await expect(probeCodorStatus(endpoint)).resolves.toBe(true);
    } finally {
      listener.close();
      await once(listener, 'close');
    }

    let elapsedMs = 0;
    const observedTimeouts: number[] = [];
    const sleeps: number[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const timeoutMs = observedTimeouts[observedTimeouts.length - 1];
      if (timeoutMs === undefined) throw new Error('expected a pairing-status timeout');
      // The fake fetch consumes the timeout supplied by production. It does
      // not independently clip its duration to the readiness deadline.
      elapsedMs += timeoutMs;
      return new Response(null, { status: 503 });
    });
    try {
      const failure = await waitForCodor(
        'http://127.0.0.1:65535',
        probeCodorStatus,
        async (milliseconds) => {
          sleeps.push(milliseconds);
          // Include work around the first sleep so the final probe has less
          // than the ordinary 1-second maximum left.
          elapsedMs += milliseconds + (sleeps.length === 1 ? 300 : 0);
        },
        () => elapsedMs,
      ).then(
        () => undefined,
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      if (failure === undefined) throw new Error('expected readiness to time out');
      expect(failure).toContain('Codor did not answer its pairing-status check within the 60-second readiness budget');
      expect(failure).toContain('codor channels');
      expect(failure).toContain('user-service logs');
      expect(failure).not.toContain('port is listening');
      expect(observedTimeouts.length).toBeGreaterThan(19);
      expect(observedTimeouts.slice(0, 3)).toEqual([1_000, 1_000, 1_000]);
      const finalTimeout = observedTimeouts[observedTimeouts.length - 1];
      if (finalTimeout === undefined) throw new Error('expected a final probe timeout');
      expect(finalTimeout).toBeGreaterThan(0);
      expect(finalTimeout).toBeLessThan(1_000);
      expect(sleeps.slice(0, 3)).toEqual([250, 500, 1_000]);
      expect(sleeps.slice(2).every((milliseconds) => milliseconds === 1_000)).toBe(true);
      expect(elapsedMs).toBe(60_000);
    } finally {
      fetch.mockRestore();
      timeout.mockRestore();
    }
  });
  // harn:end setup-verifies-codor-before-creating-pairing-code

  it('backs off progressively and resolves past the old 20-attempt limit', async () => {
    let elapsedMs = 0;
    let attempts = 0;
    await expect(waitForCodor(
      'http://127.0.0.1:65535',
      async () => {
        attempts += 1;
        elapsedMs += 10;
        return attempts >= 25;
      },
      async (milliseconds) => { elapsedMs += milliseconds; },
      () => elapsedMs,
    )).resolves.toBeUndefined();
    expect(attempts).toBe(25);
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it('caps readiness backoff at 1s after doubling from 250ms', async () => {
    let elapsedMs = 0;
    const sleeps: number[] = [];
    await expect(waitForCodor(
      'http://127.0.0.1:65535',
      async () => {
        elapsedMs += 100;
        return false;
      },
      async (milliseconds) => {
        sleeps.push(milliseconds);
        elapsedMs += milliseconds;
      },
      () => elapsedMs,
    )).rejects.toThrow('pairing-status check within the 60-second readiness budget');
    expect(sleeps.slice(0, 3)).toEqual([250, 500, 1_000]);
    expect(sleeps.slice(2, -1).every((ms) => ms === 1_000)).toBe(true);
  });

  it('floors fractional remaining probe time before creating an AbortSignal timeout', async () => {
    const observedTimeouts: number[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    try {
      await expect(probeCodorStatus('http://127.0.0.1:65535', 276.483)).resolves.toBe(false);
      const timeoutMs = observedTimeouts[0];
      if (timeoutMs === undefined) throw new Error('expected an AbortSignal timeout');
      expect(Number.isInteger(timeoutMs)).toBe(true);
      expect(timeoutMs).toBe(276);
      expect(timeoutMs).toBeLessThanOrEqual(276.483);
    } finally {
      fetch.mockRestore();
      timeout.mockRestore();
    }
  });
  // harn:end setup-readiness-wait-is-wall-clock-bounded

  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-systemd-regression
  posixHostIt('writes private setup files, runs confirmed host steps, and pairs against the Serve origin', async () => {
    const repoRoot = join(fileURLToPath(new URL('../../../', import.meta.url)), '.');
    const home = join(dir, 'setup-home');
    const commands: string[] = [];
    let qrPayload: string | undefined;
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'tailscale'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        exec: (command, args) => {
          commands.push([command, ...args].join(' '));
          if (command === 'loginctl') return 'no';
          // Serve is invoked through the resolved absolute path now, not the
          // bare command name; match on the arguments.
          if (args.join(' ') === 'serve status') {
            return 'https://setup-host.example.ts.net (tailnet only)';
          }
          return '';
        },
        home,
        nodePath: '/opt/node/bin/node',
        platform: 'linux', generation: () => 'setup-generation',
        probe: async () => true,
        runtimeStatus: async () => ({ version: '0.10.14-alpha.3', generation: 'setup-generation' }),
        randomToken: () => 'a'.repeat(64),
        renderQr: (payload) => {
          qrPayload = payload;
          return '<setup-qr>';
        },
        repoRoot,
        sleep: async () => undefined,
        which: (command) => new Map([
          ['claude', join(home, '.local', 'bin', 'claude')],
          ['codex', '/opt/node/bin/codex'],
          ['tailscale', '/usr/bin/tailscale'],
        ]).get(command),
      },
    });

    const configDir = join(home, '.config', 'codor');
    const tokenPath = join(configDir, 'token');
    const envPath = join(configDir, 'env');
    const unitPath = join(home, '.config', 'systemd', 'user', 'codor.service');
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.codor')).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).toContain('ExecStart=\"/opt/node/bin/node\" ');
    expect(unit).toContain(`WorkingDirectory=${repoRoot}`);
    expect(unit).toContain(`EnvironmentFile=${envPath}`);
    expect(unit).toContain(`\"${join(repoRoot, 'packages', 'web-next', 'dist')}\"`);
    expect(unit).not.toContain('%h/codor');
    expect(readFileSync(envPath, 'utf8')).toContain(
      `PATH=${join(home, '.local', 'bin')}:/opt/node/bin:/usr/bin`,
    );
    // repoRoot is this real checkout, which is pnpm-linked, so the hoisted
    // dependency dir the durable copy will carry over is present and durable
    // (repoRoot === serviceLocation for a source checkout).
    const serviceEnv = readFileSync(envPath, 'utf8');
    for (const expected of [
      `NODE_PATH=${join(repoRoot, 'node_modules', '.pnpm', 'node_modules')}`,
      'CODOR_RUNTIME_VERSION=0.10.14-alpha.3', 'CODOR_SERVICE_GENERATION=setup-generation',
    ]) expect(serviceEnv).toContain(expected);
    // Tailscale is resolved to an absolute path, capability-probed, and Serve is
    // published during Choose access — before the daemon is started.
    expect(commands).toEqual([
      '/usr/bin/tailscale serve --help',
      '/usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      '/usr/bin/tailscale serve status',
      'systemctl --user daemon-reload',
      'systemctl --user enable codor.service', 'systemctl --user restart codor.service',
      'loginctl show-user setup-test -p Linger --value',
    ]);
    expect(output.join('\n')).toContain('setup-host.example.ts.net');
    expect(new URL(qrPayload!).origin).toBe('https://setup-host.example.ts.net');
    expect(output.join('\n')).toMatch(/[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}/);
    expect(output.join('\n')).not.toContain('a'.repeat(64));
  });
  // harn:end platform-services-propagate-destination-pnpm-node-path

  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-launchd-regression
  posixHostIt('dry-runs and installs an equivalent private macOS LaunchAgent', async () => {
    const home = join(dir, 'setup & home');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const commands: string[] = [];
    const token = 'mac&<>-token';
    let qrPayload: string | undefined;
    const which = (command: string) => new Map([
      ['codex', '/opt/codor tools/bin/codex'],
      ['claude', '/Applications/Claude Code/bin/claude'],
    ]).get(command);
    const common = {
      home,
      nodePath: '/opt/homebrew/bin/node',
      platform: 'darwin' as const,
      repoRoot,
      uid: 501, generation: () => '<new-generation>',
      runtimeStatus: async () => ({ version: '0.10.14-alpha.3', generation: '<new-generation>' }),
      which,
    };

    await runCli(['node', 'codor', 'setup', '--dry-run'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/opt/homebrew/bin:/usr/bin' },
      stdout: (line) => output.push(line),
      setup: common,
    });

    const launchAgentPath = join(home, 'Library', 'LaunchAgents', 'app.codor.switchboard.plist');
    expect(existsSync(join(home, '.config', 'codor'))).toBe(false);
    expect(existsSync(launchAgentPath)).toBe(false);
    expect(output.join('\n')).not.toContain(token);
    expect(output).toContain(`[dry-run] create ${join(home, '.codor', 'logs')} mode 700`);
    expect(output).toContain(`[dry-run] launchctl bootout gui/501/app.codor.switchboard (ignore not-loaded)`);
    expect(output).toContain(`[dry-run] launchctl bootstrap gui/501 ${launchAgentPath}`);
    expect(output).toContain('[dry-run] launchctl enable gui/501/app.codor.switchboard');
    expect(output.join('\n')).not.toContain('kickstart');
    const plistStart = output.indexOf('[dry-run] launch agent content:') + 1;
    const plistEnd = output.findIndex((line, index) => index >= plistStart && line.startsWith('[dry-run] launchctl'));
    const dryRunPlist = output.slice(plistStart, plistEnd).join('\n') + '\n';
    expect(dryRunPlist).toContain('<string>app.codor.switchboard</string>');
    expect(dryRunPlist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(dryRunPlist).toContain(`${join(repoRoot, 'packages', 'web-next', 'dist').replace('&', '&amp;')}</string>`);
    expect(dryRunPlist).toContain('<string>&lt;redacted generated-or-existing token&gt;</string>');
    expect(dryRunPlist).toContain('<key>ProcessType</key>\n  <string>Background</string>');
    expect(dryRunPlist).toContain('<key>Umask</key>\n  <integer>63</integer>');
    // repoRoot is this real checkout, which is pnpm-linked (source checkout,
    // so repoRoot === serviceLocation), so NODE_PATH is emitted alongside PATH.
    expect(dryRunPlist).toContain(
      `<key>NODE_PATH</key>\n    <string>${join(repoRoot, 'node_modules', '.pnpm', 'node_modules')}</string>`,
    );

    output = [];
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/opt/homebrew/bin:/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        ...common,
        exec: (command, args) => {
          commands.push([command, ...args].join(' '));
          if (command === 'launchctl' && (args[0] === 'bootout' || args[0] === 'print')) throw new Error('not loaded');
          return '';
        },
        exists: () => true,
        randomToken: () => token,
        probe: async () => true,
        renderQr: (payload) => {
          qrPayload = payload;
          return '<mac-setup-qr>';
        },
        sleep: async () => undefined,
      },
    });

    const configDir = join(home, '.config', 'codor');
    const installedPlist = readFileSync(launchAgentPath, 'utf8');
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.codor')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.codor', 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(configDir, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(launchAgentPath).mode & 0o777).toBe(0o600);
    expect(installedPlist.replace('mac&amp;&lt;&gt;-token', '&lt;redacted generated-or-existing token&gt;'))
      .toBe(dryRunPlist);
    expect(installedPlist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(installedPlist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(installedPlist).toContain(`${join(home, '.codor', 'logs', 'codor.err.log').replace('&', '&amp;')}</string>`);
    expect(installedPlist).toContain(
      `<string>${join(home, '.local', 'bin').replace('&', '&amp;')}:/opt/homebrew/bin:/Applications/Claude Code/bin:/opt/codor tools/bin:/usr/bin</string>`,
    );
    expect(installedPlist).toContain(
      `<key>NODE_PATH</key>\n    <string>${join(repoRoot, 'node_modules', '.pnpm', 'node_modules')}</string>`,
    );
    expect(commands).toEqual([
      `plutil -lint ${launchAgentPath}`,
      'launchctl bootout gui/501/app.codor.switchboard',
      'launchctl print gui/501/app.codor.switchboard',
      `launchctl bootstrap gui/501 ${launchAgentPath}`,
      'launchctl enable gui/501/app.codor.switchboard',
    ]);
    expect(new URL(qrPayload!).origin).toBe('http://127.0.0.1:8137');
    expect(output.join('\n')).not.toContain(token);
  });
  // harn:end platform-services-propagate-destination-pnpm-node-path
  // harn:end setup-verifies-codor-before-creating-pairing-code
  // harn:end setup-preserves-private-platform-service

  it('resolves Gemini interactive resume through the supervised attach path', () => {
    expect(nativeResumeCommand({
      id: 'gemini-member',
      kind: 'agent',
      handle: 'gemini',
      display_name: 'Gemini',
      harness: 'gemini',
      session_ref: '11111111-1111-4111-8111-111111111111',
    }, { CODOR_GEMINI_COMMAND: '/opt/gemini' })).toEqual({
      command: '/opt/gemini',
      args: ['--resume', '11111111-1111-4111-8111-111111111111'],
    });
  });

  it('resolves OpenCode interactive resume through the supervised attach path', () => {
    expect(nativeResumeCommand({
      id: 'opencode-member',
      kind: 'agent',
      handle: 'opencode',
      display_name: 'OpenCode',
      harness: 'opencode',
      session_ref: 'ses_0b418b8aeffelyQqZS0JoBHFvF',
    }, { CODOR_OPENCODE_COMMAND: '/opt/opencode' })).toEqual({
      command: '/opt/opencode',
      args: ['--session', 'ses_0b418b8aeffelyQqZS0JoBHFvF'],
    });
  });

  it('resolves Copilot interactive resume through the supervised attach path', () => {
    expect(nativeResumeCommand({
      id: 'copilot-member',
      kind: 'agent',
      handle: 'copilot',
      display_name: 'Copilot',
      harness: 'copilot',
      session_ref: '33333333-3333-4333-8333-333333333333',
    }, { CODOR_COPILOT_COMMAND: '/opt/copilot' })).toEqual({
      command: '/opt/copilot',
      args: ['--resume', '33333333-3333-4333-8333-333333333333'],
    });
  });

  it('resolves Grok interactive resume through the supervised attach path', () => {
    expect(nativeResumeCommand({
      id: 'grok-member',
      kind: 'agent',
      handle: 'grok',
      display_name: 'Grok',
      harness: 'grok',
      session_ref: '44444444-4444-4444-8444-444444444444',
    }, { CODOR_GROK_COMMAND: '/opt/grok' })).toEqual({
      command: '/opt/grok',
      args: ['--resume', '44444444-4444-4444-8444-444444444444'],
    });
  });

  it('spawns, posts, and tails through the unix WebSocket protocol', async () => {
    await cli('channels');
    expect(output).toContain('eng\tEngineering');

    output = [];
    const reviewCwd = join(dir, 'review');
    mkdirSync(reviewCwd);
    await cli(
      'spawn',
      '-r',
      'eng',
      '--harness',
      'fake',
      '--as',
      'reviewer',
      '--cwd',
      reviewCwd,
      '--policy',
      'read-only',
    );
    expect(output[0]).toMatch(/^spawned @reviewer /);

    fake.enqueue({ kind: 'complete', final_text: '@richard PONG' });
    output = [];
    await cli('post', '-r', 'eng', '@reviewer reply with PONG');
    expect(output).toEqual(['posted #1']);
    await daemon.settle();

    output = [];
    await cli('tail', '-r', 'eng', '--once');
    expect(output).toContain('#1 @richard chat');
    expect(output).toContain('@reviewer reply with PONG');
    expect(output.some((line) => /^#2 @reviewer run completed 120tk \$0\.01$/.test(line))).toBe(true);
    expect(output).toContain('@richard PONG');

    output = [];
    await cli('members', '-r', 'eng');
    expect(output.some((line) => line.startsWith('@reviewer\tidle\tfake'))).toBe(true);
  });

  // harn:assume cli-post-acknowledges-messages-or-schedules ref=cli-scheduled-post-regression
  it('acknowledges one new self-authored schedule and refuses scheduled --wait', async () => {
    const reviewCwd = join(dir, 'scheduled-review');
    mkdirSync(reviewCwd);
    const reviewer = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'scheduled-reviewer', cwd: reviewCwd,
    });
    const body = '[send_in=1h] @scheduled-reviewer durable cli schedule';
    const preexisting = daemon.scheduleMessage('eng', body, daemon.ownerOf('eng').id);
    output = [];
    await cli('post', '-r', 'eng', body);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^scheduled [^ ]+ due \d{4}-\d{2}-\d{2}T/);
    const created = daemon.store.listSchedules('eng').find((row) =>
      row.id !== preexisting.id && row.body === '@scheduled-reviewer durable cli schedule');
    expect(created).toMatchObject({ author_id: daemon.ownerOf('eng').id, target: { member_id: reviewer.id } });

    output = [];
    const remoteBody = '[send_in=1h] @scheduled-reviewer remote cli schedule';
    await runCli([
      'node', 'codor', '--data-dir', dir,
      '--url', `http://127.0.0.1:${String(server.port)}`,
      '--token', 'cli-token', 'post', '-r', 'eng', remoteBody,
    ], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^scheduled [^ ]+ due \d{4}-\d{2}-\d{2}T/);
    expect(daemon.store.listSchedules('eng')).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: '@scheduled-reviewer remote cli schedule' })]),
    );

    output = [];
    await expect(cli('post', '--wait', '-r', 'eng', '[send_in=1h] @scheduled-reviewer refused wait'))
      .rejects.toThrow('post --wait is not supported for scheduled messages');
    expect(output).toEqual([]);
  });

  it('acknowledges a qualified schedule from the target-owned room frame', async () => {
    const fixture = join(dir, 'scheduled-qualified');
    const primary = join(fixture, 'primary');
    const child = join(fixture, 'child');
    mkdirSync(primary, { recursive: true });
    fixtureGit(primary, ['init', '-q', '-b', 'main']);
    fixtureGit(primary, ['config', 'user.email', 'fixture@example.test']);
    fixtureGit(primary, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    fixtureGit(primary, ['add', 'README.md']);
    fixtureGit(primary, ['commit', '-qm', 'fixture']);
    fixtureGit(primary, ['worktree', 'add', '-b', 'feature/scheduled', child, 'HEAD']);
    daemon.store.updateRoomConfig('eng', { cwd: primary });
    const target = await daemon.adoptWorktree('eng', { path: child });
    const reviewer = daemon.spawnMember(target.worktree.conversation_id, {
      harness: 'fake', handle: 'scoped-reviewer', cwd: child,
    });
    const alias = worktreeSelectorFromBranch('feature/scheduled');
    const body = `[send_in=1h] ~${alias}:@scoped-reviewer qualified cli schedule`;
    output = [];
    await cli('post', '-r', 'eng', body);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^scheduled [^ ]+ due \d{4}-\d{2}-\d{2}T/);
    const created = daemon.store.listSchedules(target.worktree.conversation_id)
      .find((row) => row.body === `~${alias}:@scoped-reviewer qualified cli schedule`);
    expect(created).toMatchObject({
      origin_room: 'eng', room: target.worktree.conversation_id,
      author_id: daemon.ownerOf('eng').id, target: { member_id: reviewer.id },
    });
  });
  // harn:end cli-post-acknowledges-messages-or-schedules

  // harn:assume structured-channel-cli-preserves-flat-listing ref=structured-channel-cli-regression
  // harn:assume management-output-is-json-pure-and-safe ref=management-output-regression
  // harn:assume management-failures-have-stable-redacted-exits ref=management-error-regression
  // harn:assume channel-archive-requires-explicit-confirmation ref=channel-archive-confirmation-regression
  it('manages channels with deterministic output, confirmation, safe failures, and URL transport', async () => {
    const invoke = async (
      args: string[],
      overrides: { isTTY?: boolean; confirm?: (prompt: string) => Promise<string | boolean> } = {},
    ) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli(['node', 'codor', '--data-dir', dir, ...args], {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          isTTY: overrides.isTTY ?? false,
          confirm: overrides.confirm,
        });
      } catch (caught) {
        error = caught;
      }
      return { stdout, stderr, error };
    };

    const listed = await invoke(['channel', 'list', '--json']);
    expect(listed.error).toBeUndefined();
    expect(listed.stderr).toEqual([]);
    expect(listed.stdout).toHaveLength(1);
    expect(JSON.parse(listed.stdout[0]!)).toEqual([expect.objectContaining({
      id: 'eng', name: 'Engineering', status: 'active',
    })]);

    for (const id of ['unauthorized', 'bearer', '401']) {
      const missing = await invoke(['channel', 'show', id]);
      expect(missing.error).toBeInstanceOf(ManagementError);
      expect(cliExitCode(missing.error)).toBe(5);
      expect(missing.stdout).toEqual([]);
      expect(missing.stderr).toEqual([]);
    }

    const invalidOwner = await invoke(['channel', 'create', 'Invalid Owner', '--owner', 'bad handle']);
    expect(invalidOwner.error).toBeInstanceOf(ManagementError);
    expect(cliExitCode(invalidOwner.error)).toBe(2);
    expect(invalidOwner.stdout).toEqual([]);
    expect(invalidOwner.stderr).toEqual([]);

    const cwd = join(dir, 'created-cwd');
    mkdirSync(cwd);
    const created = await invoke([
      'channel', 'create', 'Created Channel', '--owner', 'richard', '--owner-name', 'Richard',
      '--id', 'created-channel', '--cwd', cwd, '--json',
    ]);
    expect(created.error).toBeUndefined();
    const createdJson = JSON.parse(created.stdout[0]!);
    expect(createdJson).toMatchObject({
      id: 'created-channel', name: 'Created Channel', status: 'active', cwd,
    });
    expect(createdJson).not.toHaveProperty('members');
    expect(createdJson).not.toHaveProperty('session_ref');

    const renamed = await invoke(['channel', 'rename', 'created-channel', 'Renamed Channel', '--json']);
    expect(renamed.error).toBeUndefined();
    expect(JSON.parse(renamed.stdout[0]!)).toMatchObject({
      id: 'created-channel', name: 'Renamed Channel', status: 'active',
    });

    const declined = await invoke(['channel', 'archive', 'created-channel'], {
      isTTY: true,
      confirm: async () => false,
    });
    expect(declined.error).toBeInstanceOf(ManagementError);
    expect(cliExitCode(declined.error)).toBe(2);
    expect(declined.stdout).toEqual([]);
    expect(declined.stderr).toEqual(['Archive channel created-channel? [y/N]']);
    expect(daemon.store.getRoom('created-channel')?.config.archived_ts).toBeUndefined();

    const unattended = await invoke(['channel', 'archive', 'created-channel']);
    expect(unattended.error).toBeInstanceOf(ManagementError);
    expect(cliExitCode(unattended.error)).toBe(2);
    expect(unattended.stdout).toEqual([]);
    expect(daemon.store.getRoom('created-channel')?.config.archived_ts).toBeUndefined();

    const archived = await invoke(['channel', 'archive', 'created-channel', '--yes', '--json']);
    expect(archived.error).toBeUndefined();
    expect(archived.stderr).toEqual([]);
    expect(JSON.parse(archived.stdout[0]!)).toMatchObject({
      id: 'created-channel', status: 'archived', archived_ts: expect.any(String),
    });

    const activeAfterArchive = await invoke(['channel', 'list', '--json']);
    expect(JSON.parse(activeAfterArchive.stdout[0]!)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'created-channel' })]),
    );
    const allAfterArchive = await invoke(['channel', 'list', '--all', '--json']);
    expect(JSON.parse(allAfterArchive.stdout[0]!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'created-channel', status: 'archived' })]),
    );

    const shown = await invoke(['channel', 'show', 'created-channel']);
    expect(shown.stdout[0]).toMatch(/^id\tcreated-channel\nname\tRenamed Channel\nstatus\tarchived\n/);

    const flat = await invoke(['channels']);
    expect(flat.stdout).toEqual(['eng\tEngineering']);

    output = [];
    await runCli([
      'node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${String(server.port)}`,
      '--token', 'cli-token', 'channel', 'list', '--json',
    ], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      isTTY: false,
    });
    expect(JSON.parse(output.at(-1)!)).toEqual([expect.objectContaining({ id: 'eng' })]);

    const redacted = redactDiagnostic(
      new Error('Bearer secret-token https://host.test/ws?token=secret-token'),
      ['node', 'codor', '--token', 'secret-token'],
      { CODOR_TOKEN: 'secret-token' },
    );
    expect(redacted).not.toContain('secret-token');
    expect(redacted).toContain('<redacted>');
  });
  // harn:end channel-archive-requires-explicit-confirmation
  // harn:end management-failures-have-stable-redacted-exits
  // harn:end management-output-is-json-pure-and-safe
  // harn:end structured-channel-cli-preserves-flat-listing

  // harn:assume structured-agent-cli-preserves-flat-lifecycle-and-presets ref=structured-agent-cli-regression
  // harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-cli-regression
  // harn:assume preset-deletion-requires-explicit-confirmation ref=preset-delete-confirmation-regression
  // harn:assume channel-cli-selects-one-initial-agent-mode ref=channel-create-initial-agent-regression
  // harn:assume agent-add-selects-public-adapter-or-detached-preset ref=agent-add-cli-regression
  // harn:assume management-output-is-json-pure-and-safe ref=management-output-regression
  // harn:assume management-failures-have-stable-redacted-exits ref=management-error-regression
  // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-snapshot-regression
  it('manages presets, rosters, initial agents, and detached preset adds over both transports', async () => {
    const invoke = async (
      args: string[],
      overrides: { isTTY?: boolean; confirm?: (prompt: string) => Promise<string | boolean> } = {},
    ) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli(['node', 'codor', '--data-dir', dir, ...args], {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          isTTY: overrides.isTTY ?? false,
          confirm: overrides.confirm,
        });
      } catch (caught) {
        error = caught;
      }
      return { stdout, stderr, error };
    };

    const presetCwd = join(dir, 'preset-add');
    mkdirSync(presetCwd);
    const created = await invoke([
      'agent-preset', 'create', 'Helper\tOne', '--handle', 'preset-helper', '--adapter', 'fake',
      '--policy', 'workspace-write', '--json',
    ]);
    expect(created.error).toBeUndefined();
    const preset = JSON.parse(created.stdout[0]!) as Record<string, unknown>;
    expect(preset).toMatchObject({ label: 'Helper\tOne', handle: 'preset-helper', adapter: 'fake', policy: 'workspace-write' });
    expect(preset).not.toHaveProperty('acp_launch');

    const presetId = String(preset.id);
    const alphaCreated = await invoke([
      'agent-preset', 'create', 'Alpha helper', '--handle', 'alpha-preset', '--adapter', 'fake', '--json',
    ]);
    const alphaId = String((JSON.parse(alphaCreated.stdout[0]!) as Record<string, unknown>).id);
    const hostileCreated = await invoke([
      'agent-preset', 'create', 'Hostile\tlabel\r\n\u001b[31m\\tail',
      '--handle', 'hostile-preset', '--adapter', 'fake', '--json',
    ]);
    const hostileId = String((JSON.parse(hostileCreated.stdout[0]!) as Record<string, unknown>).id);
    const listed = await invoke(['agent-preset', 'list', '--json']);
    expect((JSON.parse(listed.stdout[0]!) as Array<{ label: string }>).map((entry) => entry.label))
      .toEqual(['Alpha helper', 'Helper\tOne', 'Hostile\tlabel\r\n\u001b[31m\\tail']);

    const updated = await invoke([
      'agent-preset', 'update', presetId, '--label', 'Helper Two', '--handle', 'preset-helper-2',
      '--adapter', 'fake', '--json',
    ]);
    expect(updated.error).toBeUndefined();
    expect(JSON.parse(updated.stdout[0]!)).toMatchObject({ id: presetId, label: 'Helper Two', handle: 'preset-helper-2' });
    expect(JSON.parse(updated.stdout[0]!)).not.toHaveProperty('policy');

    const roster = await invoke(['default-roster', 'set', presetId, '--json']);
    expect(JSON.parse(roster.stdout[0]!)).toMatchObject({ id: 'default', preset_ids: [presetId] });
    const shownRoster = await invoke(['default-roster', 'show']);
    expect(shownRoster.stdout).toEqual([`0\t${presetId}`]);

    const defaultRoomCwd = join(dir, 'default-room');
    mkdirSync(defaultRoomCwd);
    const defaultRoom = await invoke([
      'channel', 'create', 'Preset Channel', '--owner', 'richard', '--id', 'preset-channel',
      '--cwd', defaultRoomCwd, '--default-roster', '--json',
    ]);
    expect(defaultRoom.error).toBeUndefined();
    expect(JSON.parse(defaultRoom.stdout[0]!)).toMatchObject({ id: 'preset-channel' });
    expect(daemon.store.listMembers('preset-channel').map((member) => member.handle)).toContain('preset-helper-2');

    const manualCwd = join(dir, 'manual-start');
    mkdirSync(manualCwd);
    const manualRoom = await invoke([
      'channel', 'create', 'Manual Starting Agent', '--owner', 'richard', '--id', 'manual-start',
      '--cwd', manualCwd, '--starting-agent', 'manual-worker', '--adapter', 'fake', '--json',
    ]);
    expect(manualRoom.error).toBeUndefined();
    expect(daemon.store.getMemberByHandle('manual-start', 'manual-worker')).toMatchObject({ harness: 'fake' });

    const add = await invoke([
      'agent', 'add', '--channel', 'eng', '--preset', presetId, '--cwd', presetCwd, '--purpose', 'per-add', '--json',
    ]);
    expect(add.error).toBeUndefined();
    const added = JSON.parse(add.stdout[0]!) as Record<string, unknown>;
    expect(added).toMatchObject({ handle: 'preset-helper-2', cwd: presetCwd, purpose: 'per-add', policy: 'read-only' });
    expect(added).not.toHaveProperty('preset_id');
    expect(added).not.toHaveProperty('session_ref');

    const remoteList: string[] = [];
    await runCli([
      'node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${String(server.port)}`,
      '--token', 'cli-token', 'agent-preset', 'list', '--json',
    ], { stdout: (line) => remoteList.push(line), stderr: () => undefined });
    expect((JSON.parse(remoteList[0]!) as Array<{ label: string; id: string }>).map((entry) => entry.label))
      .toEqual(['Alpha helper', 'Helper Two', 'Hostile\tlabel\r\n\u001b[31m\\tail']);
    expect(JSON.parse(remoteList[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ id: presetId })]));

    const hostileDeclined = await invoke(['agent-preset', 'delete', hostileId], {
      isTTY: true,
      confirm: async () => false,
    });
    expect(hostileDeclined.error).toMatchObject({
      name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.invocation,
    });
    expect(hostileDeclined.stderr).toEqual([[
      'Delete agent preset Hostile\\tlabel\\r\\n\\x1b[31m\\\\tail',
      ` (${hostileId})? [y/N]`,
    ].join('')]);
    expect(hostileDeclined.stderr[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(hostileDeclined.stderr[0]!.split('\n')).toHaveLength(1);
    expect(daemon.getAgentPreset(hostileId)).toBeDefined();
    await invoke(['agent-preset', 'delete', hostileId, '--yes', '--json']);
    await invoke(['agent-preset', 'delete', alphaId, '--yes', '--json']);

    const declined = await invoke(['agent-preset', 'delete', presetId], {
      isTTY: true,
      confirm: async () => false,
    });
    expect(declined.error).toMatchObject({ name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.invocation });
    expect(declined.stdout).toEqual([]);
    expect(declined.stderr).toEqual([`Delete agent preset Helper Two (${presetId})? [y/N]`]);
    expect(daemon.getAgentPreset(presetId)).toBeDefined();

    const cleared = await invoke(['default-roster', 'set', '--json']);
    expect(JSON.parse(cleared.stdout[0]!)).toMatchObject({ preset_ids: [] });
    const deleted = await invoke(['agent-preset', 'delete', presetId, '--yes', '--json']);
    expect(JSON.parse(deleted.stdout[0]!)).toEqual({ id: presetId, deleted: true });

    const orphan = await invoke([
      'channel', 'create', 'Orphan Starting Option', '--owner', 'richard', '--adapter', 'fake', '--json',
    ]);
    expect(orphan.error).toMatchObject({ name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.invocation });
    expect(daemon.store.getRoom('orphan-starting-option')).toBeUndefined();
    const mixed = await invoke([
      'channel', 'create', 'Mixed Initial Modes', '--owner', 'richard', '--id', 'mixed-initial-modes',
      '--cwd', manualCwd, '--default-roster', '--starting-agent', 'mixed-worker', '--adapter', 'fake', '--json',
    ]);
    expect(mixed.error).toMatchObject({ name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.invocation });
    expect(daemon.store.getRoom('mixed-initial-modes')).toBeUndefined();
  });
  // harn:end default-roster-channel-members-are-detached-ordered-snapshots
  // harn:end management-failures-have-stable-redacted-exits
  // harn:end management-output-is-json-pure-and-safe
  // harn:end agent-add-selects-public-adapter-or-detached-preset
  // harn:end channel-cli-selects-one-initial-agent-mode
  // harn:end preset-deletion-requires-explicit-confirmation
  // harn:end structured-preset-and-roster-cli-is-safe-and-ordered
  // harn:end structured-agent-cli-preserves-flat-lifecycle-and-presets

  // harn:assume structured-agent-cli-preserves-flat-lifecycle-and-presets ref=structured-agent-cli-regression
  // harn:assume management-output-is-json-pure-and-safe ref=management-output-regression
  // harn:assume agent-remove-requires-explicit-confirmation ref=agent-remove-confirmation-regression
  it('manages agents through the correlated lifecycle family without changing flat commands', async () => {
    const invoke = async (args: string[], overrides: { isTTY?: boolean } = {}) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli(['node', 'codor', '--data-dir', dir, ...args], {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          isTTY: overrides.isTTY ?? false,
        });
      } catch (caught) {
        error = caught;
      }
      return { stdout, stderr, error };
    };

    const cwd = join(dir, 'managed-agent');
    mkdirSync(cwd);
    const added = await invoke([
      'agent', 'add', '@worker', '--channel', 'eng', '--adapter', 'fake', '--cwd', cwd, '--json',
    ]);
    expect(added.error).toBeUndefined();
    expect(JSON.parse(added.stdout[0]!)).toMatchObject({
      handle: 'worker', status: 'idle', adapter: 'fake', cwd, policy: 'read-only',
    });

    const configured = await invoke([
      'agent', 'configure', 'worker', '--channel', 'eng', '--model', 'safe-model', '--json',
    ]);
    expect(configured.error).toBeUndefined();
    expect(JSON.parse(configured.stdout[0]!)).toMatchObject({ model: 'safe-model' });

    const renamed = await invoke([
      'agent', 'rename', 'worker', 'worker-renamed', '--channel', 'eng', '--name', 'Worker', '--json',
    ]);
    expect(renamed.error).toBeUndefined();
    expect(JSON.parse(renamed.stdout[0]!)).toMatchObject({ handle: 'worker-renamed', display_name: 'Worker' });

    const paused = await invoke(['agent', 'pause', '@worker-renamed', '--channel', 'eng', '--json']);
    expect(paused.error).toBeUndefined();
    expect(JSON.parse(paused.stdout[0]!)).toMatchObject({ status: 'paused' });

    const revived = await invoke(['agent', 'revive', 'worker-renamed', '--channel', 'eng', '--json']);
    expect(revived.error).toBeUndefined();
    expect(JSON.parse(revived.stdout[0]!)).toMatchObject({ status: 'idle' });

    const declined = await invoke(['agent', 'remove', 'worker-renamed', '--channel', 'eng']);
    expect(declined.error).toMatchObject({ name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.invocation });
    expect(daemon.store.getMemberByHandle('eng', 'worker-renamed')?.removed_ts).toBeUndefined();

    const removed = await invoke(['agent', 'remove', 'worker-renamed', '--channel', 'eng', '--yes', '--json']);
    expect(removed.error).toBeUndefined();
    const removedJson = JSON.parse(removed.stdout[0]!);
    expect(removedJson).toMatchObject({ handle: 'worker-renamed', status: 'dead', removed_ts: expect.any(String) });
    expect(removedJson).not.toHaveProperty('session_ref');
    expect(removedJson).not.toHaveProperty('host');
    expect(removedJson).not.toHaveProperty('acp_launch');

    const listed = await invoke(['agent', 'list', '--channel', 'eng', '--json']);
    expect(JSON.parse(listed.stdout[0]!)).toEqual([]);
    expect((await invoke(['channels'])).stdout).toEqual(['eng\tEngineering']);
  });
  // harn:end agent-remove-requires-explicit-confirmation
  // harn:end management-output-is-json-pure-and-safe

  it('classifies mirrored configuration and non-resumable revive as conflicts', async () => {
    const invoke = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli(['node', 'codor', '--data-dir', dir, ...args], {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          isTTY: false,
        });
      } catch (caught) {
        error = caught;
      }
      return { stdout, stderr, error };
    };

    const mirroredCwd = join(dir, 'mirrored-agent');
    mkdirSync(mirroredCwd);
    const mirrored = daemon.joinMember('eng', {
      harness: 'fake', handle: 'mirrored-agent', session_ref: 'mirrored-session', cwd: mirroredCwd,
    });
    const mirroredConfigure = await invoke([
      'agent', 'configure', mirrored.handle, '--channel', 'eng', '--model', 'blocked-model', '--json',
    ]);
    expect(mirroredConfigure.error).toMatchObject({
      name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.conflict,
    });
    expect(mirroredConfigure.stdout).toEqual([]);
    expect(mirroredConfigure.stderr).toEqual([]);
    expect(daemon.store.getMember('eng', mirrored.id)?.model).toBeUndefined();

    const unrevivableCwd = join(dir, 'unrevivable-agent');
    mkdirSync(unrevivableCwd);
    const unrevivable = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'unrevivable', cwd: unrevivableCwd,
    });
    daemon.killMember('eng', unrevivable.id);
    const unresumableRevive = await invoke([
      'agent', 'revive', unrevivable.handle, '--channel', 'eng', '--json',
    ]);
    expect(unresumableRevive.error).toMatchObject({
      name: 'ManagementError', exitCode: MANAGEMENT_EXIT_CODES.conflict,
    });
    expect(unresumableRevive.stdout).toEqual([]);
    expect(unresumableRevive.stderr).toEqual([]);
  });

  // harn:end structured-agent-cli-preserves-flat-lifecycle-and-presets

  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-cli-regression
  it('tails a continuation row without a lifecycle summary, in id order', async () => {
    // The dormant writer will emit exactly this shape: a kind=run row carrying
    // run_parent_id and NO run summary. Today's renderer reaches for
    // `message.run!`, so the first continuation would throw inside every
    // tail --once and --follow subscriber. Seed the shape directly and drive a
    // real Unix tail over it.
    const writerCwd = join(dir, 'writer-cwd');
    mkdirSync(writerCwd);
    const agent = daemon.spawnMember('eng', {
      harness: 'fake', handle: 'writer', cwd: writerCwd,
    });
    const root = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'root turn body',
      run: {
        status: 'completed',
        started_ts: new Date().toISOString(),
        ended_ts: new Date().toISOString(),
        tool_calls: 0,
        events_ref: 'runs/root.jsonl',
        final_text: 'root turn body',
      },
    });
    daemon.store.postMessage('eng', {
      author: daemon.ownerOf('eng').id, kind: 'chat', body: 'human interjection',
    });
    const continuation = daemon.store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'continuation body',
      run_parent_id: root.id,
    });

    output = [];
    await cli('tail', '-r', 'eng', '--once');

    // Every permanent id prints, in order, with each row's own body.
    const rootLine = output.findIndex((line) => /^#1 @writer run completed/.test(line));
    const humanLine = output.indexOf('#2 @richard chat');
    const continuationLine = output.indexOf(`#3 @writer run continuation of #${root.id}`);
    expect(rootLine).toBeGreaterThanOrEqual(0);
    expect(humanLine).toBeGreaterThan(rootLine);
    expect(continuationLine).toBeGreaterThan(humanLine);
    expect(continuation.id).toBe(3);

    expect(output).toContain('root turn body');
    expect(output).toContain('human interjection');
    expect(output).toContain('continuation body');
    // The root's status and totals stay on the root: a continuation states only
    // what it is, and nothing about it is aggregated away or hidden.
    expect(output.filter((line) => line.includes('run completed'))).toHaveLength(1);
    expect(output.some((line) => line.startsWith('error:'))).toBe(false);
  });
  // harn:end continuation-writer-follows-journaled-output-ownership

  // harn:assume member-env-selects-narrow-cli-identity ref=member-identity-regression
  it('uses member identity over an inherited owner token on Unix and URL transports', async () => {
    const alpha = credentialedAgent('alpha');
    await memberCli(alpha.env, 'post', 'unix member attribution');
    expect(daemon.store.listMessages('eng', { limit: 10 }).at(-1)).toMatchObject({
      author: alpha.member.id,
      body: 'unix member attribution',
    });

    output = [];
    await memberCli(
      alpha.env,
      '--url',
      `http://127.0.0.1:${String(server.port)}`,
      'post',
      'remote member attribution',
    );
    expect(daemon.store.listMessages('eng', { limit: 10 }).at(-1)).toMatchObject({
      author: alpha.member.id,
      body: 'remote member attribution',
    });

    output = [];
    await runCli([
      'node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${String(server.port)}`,
      '--token', 'cli-token', 'agent', 'list', '--channel', 'eng', '--json',
    ], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      isTTY: false,
    });
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual([
      expect.objectContaining({ handle: 'alpha', adapter: 'fake', status: 'idle' }),
    ]);
  });
  // harn:end member-env-selects-narrow-cli-identity

  // harn:assume cli-waits-consume-only-matching-deliveries ref=wait-matrix-regression
  it('post --wait ignores untagged traffic and accepts a direct reply from any addressed peer', async () => {
    const alpha = credentialedAgent('alpha');
    const beta = credentialedAgent('beta');
    const gamma = credentialedAgent('gamma');
    daemon.pauseMember('eng', gamma.member.id);
    await startLiveTurn(alpha.member.id);
    fake.enqueue({ kind: 'complete', final_text: 'untagged progress' });
    setTimeout(() => daemon.postAgentMessage('eng', gamma.member.id, '@alpha direct answer'), 60);

    await memberCli(alpha.env, 'post', '--wait', '--timeout', '1', '@beta @gamma question');
    expect(output.at(-1)).toBe('@alpha direct answer');
    expect(output).not.toContain('untagged progress');
    const untagged = daemon.store.listMessages('eng', { limit: 20 })
      .find((message) => message.body === 'untagged progress')!;
    expect(untagged.mentions).toEqual([]);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.member.id }))
      .toContainEqual(expect.objectContaining({ message_id: untagged.id, state: 'queued' }));
    const reply = daemon.store.listMessages('eng', { limit: 20 })
      .find((message) => message.body === '@alpha direct answer')!;
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.member.id })
      .find((delivery) => delivery.message_id === reply.id)?.state).toBe('consumed');
    expect(daemon.sync('eng', 0).members.find((member) => member.id === alpha.member.id))
      .not.toHaveProperty('waiting');

    await daemon.settle();
  });

  it('post --wait reports timeout as control flow and ends the transient wait', async () => {
    const alpha = credentialedAgent('alpha');
    const beta = credentialedAgent('beta');
    daemon.pauseMember('eng', beta.member.id);
    await startLiveTurn(alpha.member.id);

    await memberCli(alpha.env, 'post', '--wait', '--timeout', '0.05', '@beta no reply');
    expect(output.at(-1)).toBe('TIMEOUT after 0.05s');
    expect(daemon.sync('eng', 0).members.find((member) => member.id === alpha.member.id))
      .not.toHaveProperty('waiting');

    await daemon.settle();
  });

  it('tail --follow --until-mention consumes a direct own delivery', async () => {
    const alpha = credentialedAgent('alpha');
    const beta = credentialedAgent('beta');
    await startLiveTurn(alpha.member.id);
    setTimeout(() => daemon.postAgentMessage('eng', beta.member.id, '@alpha tail answer'), 30);

    await memberCli(
      alpha.env,
      'tail',
      '--follow',
      '--until-mention',
      'alpha',
      '--timeout',
      '1',
    );
    expect(output).toEqual(['@alpha tail answer']);
    const reply = daemon.store.listMessages('eng', { limit: 20 })
      .find((message) => message.body === '@alpha tail answer')!;
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.member.id })
      .find((delivery) => delivery.message_id === reply.id)?.state).toBe('consumed');

    await daemon.settle();
  });

  it('tail --follow --until-any consumes an untagged default-routed delivery', async () => {
    const alpha = credentialedAgent('alpha');
    credentialedAgent('beta');
    fake.enqueue({ kind: 'complete', final_text: '@richard alpha is the default' });
    daemon.postHumanMessage('eng', '@alpha establish the finalized default');
    await daemon.settle();
    await startLiveTurn(alpha.member.id);
    setTimeout(() => daemon.postHumanMessage('eng', 'untagged tail answer'), 30);

    await memberCli(alpha.env, 'tail', '--follow', '--until-any', '--timeout', '1');
    expect(output).toEqual(['untagged tail answer']);
    const reply = daemon.store.listMessages('eng', { limit: 20 })
      .find((message) => message.body === 'untagged tail answer')!;
    expect(reply.mentions).toEqual([]);
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.member.id })
      .find((delivery) => delivery.message_id === reply.id)?.state).toBe('consumed');

    await daemon.settle();
  });
  // harn:end cli-waits-consume-only-matching-deliveries

  // harn:assume same-round-terminal-peers-end-live-waits ref=collaboration-cli-wait-exit-regression
  it('post --wait exits when its addressed peer finishes the same collaboration round', async () => {
    const alpha = credentialedAgent('group-wait-alpha');
    credentialedAgent('group-wait-beta');
    fake.enqueue(
      { kind: 'complete', final_text: 'alpha group result', delay_ms: 300 },
      { kind: 'complete', final_text: 'beta group result', delay_ms: 80 },
      { kind: 'complete', final_text: '<ACK_OK>' },
    );

    daemon.postHumanMessage(
      'eng',
      '@group-wait-alpha @group-wait-beta compare the approaches',
    );
    await until(() => daemon.store.getMember('eng', alpha.member.id)?.state === 'running'
      ? true
      : undefined);

    output = [];
    await memberCli(
      alpha.env,
      'post',
      '--wait',
      '--timeout',
      '1',
      '@group-wait-beta question during the round',
    );

    expect(output.at(-1)).toBe('peer finished; no direct reply');
    expect(output).not.toContain('TIMEOUT after 1s');
    expect(daemon.sync('eng', 0).members.find((member) => member.id === alpha.member.id))
      .not.toHaveProperty('waiting');
    await daemon.settle();
  });
  // harn:end same-round-terminal-peers-end-live-waits

  // harn:assume cli-hook-inbox-is-silent-when-empty ref=inbox-hook-regression
  it('lists, consumes, formats, and then emits no hook stdout for an empty inbox', async () => {
    const alpha = credentialedAgent('alpha');
    const beta = credentialedAgent('beta');
    daemon.pauseMember('eng', alpha.member.id);
    daemon.postSystemMessage('eng', 'inbox fixture setup');
    daemon.postAgentMessage('eng', beta.member.id, '@alpha direct answer');
    expect(daemon.store.listDeliveries('eng', { recipient: alpha.member.id })).toContainEqual(
      expect.objectContaining({ message_id: 2, state: 'queued' }),
    );

    await memberCli(alpha.env, 'inbox', '--new');
    expect(output).toEqual(['#2 from @beta\n@alpha direct answer']);
    output = [];
    await memberCli(alpha.env, 'inbox', '--new', '--consume', '--format', 'hook');
    expect(output).toEqual([
      readFileSync(join(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'live-inbox-hook.json'), 'utf8').trim(),
    ]);
    output = [];
    await memberCli(alpha.env, 'inbox', '--new', '--consume', '--format', 'hook');
    expect(output).toEqual([]);
  });
  // harn:end cli-hook-inbox-is-silent-when-empty

  // harn:assume cli-observability-uses-scoped-rest ref=observability-cli-regression
  it('renders scoped member status and bounded run evidence search', async () => {
    const alpha = credentialedAgent('alpha');
    fake.enqueue({
      kind: 'complete',
      final_text: '@richard checks complete',
      items: [
        {
          type: 'run.item',
          item_type: 'tool_call',
          payload: { call_id: 'cli-call', tool: 'Bash', title: 'Run auth checks' },
        },
        {
          type: 'run.item',
          item_type: 'tool_result',
          payload: {
            call_id: 'cli-call', status: 'ok', output_text: 'bounded evidence needle', duration_ms: 125,
          },
        },
      ],
    });
    daemon.postHumanMessage('eng', '@alpha inspect status evidence');
    await daemon.settle();
    const remote = ['--url', `http://127.0.0.1:${String(server.port)}`];

    await memberCli(alpha.env, ...remote, 'status', 'alpha');
    expect(output[0]).toBe('@alpha - idle, not waiting');
    expect(output.some((line) => line.includes('tool Run auth checks ok 125ms'))).toBe(true);
    output = [];
    await memberCli(alpha.env, ...remote, 'search', '-r', 'eng', '--runs', '--limit', '5', 'Run auth checks');
    expect(output.some((line) => /#2:\d+ tool_call Run auth checks/.test(line))).toBe(true);
    await expect(memberCli(alpha.env, ...remote, 'status', 'missing')).rejects.toThrow(
      'no such member missing',
    );
  });
  // harn:end cli-observability-uses-scoped-rest

  it('changes only transport and token for a remote WebSocket', async () => {
    await runCli(
      [
        'node',
        'codor',
        '--url',
        `http://127.0.0.1:${server.port}`,
        '--token',
        'cli-token',
        'channels',
      ],
      { stdout: (line) => output.push(line) },
    );
    expect(output).toEqual(['eng\tEngineering']);
  });

  it('joins a live session as mirrored and adopts it explicitly to drain queued work', async () => {
    const planningCwd = join(dir, 'planning');
    mkdirSync(planningCwd);
    await cli(
      'join',
      'eng',
      '--as',
      'planner',
      '--harness',
      'codex',
      '--session',
      '019f4a9a-e20e-7131-9e9d-703db5c8a2fc',
      '--cwd',
      planningCwd,
    );
    expect(output[0]).toMatch(/^joined @planner /);
    const planner = daemon.store.getMemberByHandle('eng', 'planner')!;
    expect(planner.custody).toBe('mirrored');

    output = [];
    await cli('post', '-r', 'eng', '@planner queued task');
    await daemon.settle();
    expect(codexFake.deliveries).toHaveLength(0);

    codexFake.enqueue({ kind: 'complete', final_text: '@richard adopted work done' });
    output = [];
    await cli('adopt', '-r', 'eng', 'planner');
    expect(output).toEqual(['adopted @planner']);
    await daemon.settle();
    expect(codexFake.wasAttached('019f4a9a-e20e-7131-9e9d-703db5c8a2fc')).toBe(true);
    expect(codexFake.deliveries).toHaveLength(1);
  });

  it('attaches without a room hint, waits for the native child, then re-adopts and drains', async () => {
    const member = daemon.spawnMember('eng', {
      harness: 'codex',
      handle: 'coder',
      cwd: dir,
    });
    codexFake.enqueue({ kind: 'complete', final_text: '@richard initialized' });
    daemon.postHumanMessage('eng', '@coder initialize');
    await daemon.settle();

    const attached = runCli(['node', 'codor', '--data-dir', dir, 'attach', '@coder'], {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      interactiveCommand: () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
      }),
      attachHeartbeatMs: 20,
    });
    for (;;) {
      if (daemon.store.getMember('eng', member.id)?.custody === 'mirrored') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    codexFake.enqueue({ kind: 'complete', final_text: '@richard queued work done' });
    await cli('post', '-r', 'eng', '@coder queued while interactive');
    await daemon.settle();
    expect(codexFake.deliveries).toHaveLength(1);

    await attached;
    await daemon.settle();
    expect(output).toContain('attaching @coder (codex)');
    expect(output).toContain('re-adopted @coder');
    expect(daemon.store.getMember('eng', member.id)).toMatchObject({
      custody: 'owned',
      state: 'idle',
    });
    expect(daemon.store.getAttachLeaseForMember(member.id)).toBeUndefined();
    expect(codexFake.deliveries).toHaveLength(2);
    expect(codexFake.deliveries.at(-1)!.payload).toContain('queued while interactive');
  });

  // harn:assume cli-member-recovery-is-actionable ref=cli-recovery-regression
  it('revives by act and makes ambiguous or dead attach failures actionable', async () => {
    const revivable = daemon.spawnMember('eng', { harness: 'fake', handle: 'revivable', cwd: dir });
    fake.enqueue({ kind: 'complete', final_text: '@richard session ready' });
    daemon.postHumanMessage('eng', '@revivable initialize');
    await daemon.settle();
    daemon.killMember('eng', revivable.id);

    output = [];
    await cli('revive', '-r', 'eng', '@revivable');
    expect(output).toEqual(['revived @revivable']);
    expect(daemon.store.getMember('eng', revivable.id)?.state).toBe('idle');

    daemon.killMember('eng', revivable.id);
    await expect(cli('attach', '-r', 'eng', '@revivable')).rejects.toThrow(
      'member @revivable is dead; revive it to retry',
    );

    const firstTurnDeath = daemon.spawnMember('eng', { harness: 'fake', handle: 'first-turn', cwd: dir });
    daemon.killMember('eng', firstTurnDeath.id);
    await expect(cli('attach', '-r', 'eng', '@first-turn')).rejects.toThrow(
      'member @first-turn is dead; remove it and spawn a replacement',
    );

    daemon.createRoom({
      id: 'ops',
      name: 'Operations',
      owner: { handle: 'operator', display_name: 'Operator' },
    });
    daemon.spawnMember('eng', { harness: 'fake', handle: 'shared', cwd: dir });
    const deadCandidate = daemon.spawnMember('ops', { harness: 'fake', handle: 'shared', cwd: dir });
    daemon.killMember('ops', deadCandidate.id);
    await expect(cli('attach', '@shared')).rejects.toThrow(
      'member @shared is ambiguous: eng (idle), ops (dead); pass --channel <channel-id>',
    );
  });
  // harn:end cli-member-recovery-is-actionable

  // harn:assume source-cli-installers-remain-idempotent-fallback ref=cli-install-regression
  posixHostIt('installs the built CLI as one stable per-user symlink on repeated runs', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'install-home');
    const script = join(repoRoot, 'scripts', 'install-cli.sh');
    const env = { ...process.env, HOME: home };
    execFileSync(script, { env, stdio: 'pipe' });
    execFileSync(script, { env, stdio: 'pipe' });
    expect(readlinkSync(join(home, '.local', 'bin', 'codor'))).toBe(
      join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
    );
    const installed = join(home, '.local', 'bin', 'codor');
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(execFileSync(installed, ['--help'], { env, encoding: 'utf8' })).toContain('Usage: codor');
  });
  // harn:end source-cli-installers-remain-idempotent-fallback

  it('parses documented Claude hooks and Codex notify plus rollout tailing', () => {
    const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
    const claudeTranscript = join(dir, 'claude-transcript.jsonl');
    writeFileSync(
      claudeTranscript,
      readFileSync(join(fixtures, 'claude-transcript.jsonl'), 'utf8'),
    );
    // JSON-escape the path before embedding it in a JSON string value — a raw
    // Windows path's single backslashes are not valid JSON escape sequences.
    const claudeRaw = readFileSync(join(fixtures, 'claude-stop.json'), 'utf8').replace(
      'CLAUDE_TRANSCRIPT_PATH',
      JSON.stringify(claudeTranscript).slice(1, -1),
    );
    expect(parseMirrorHook('claude', claudeRaw)).toMatchObject({
      type: 'mirror_turn',
      harness: 'claude-code',
      session_ref: '213a7049-0ddd-4db7-84ed-411dd7330fe7',
      native_turn_id: 'assistant-turn-1',
      body: 'Done @reviewer',
    });
    expect(parseMirrorHook('claude', JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: '213a7049-0ddd-4db7-84ed-411dd7330fe7',
    }))).toEqual({
      type: 'mirror_session_end',
      harness: 'claude-code',
      session_ref: '213a7049-0ddd-4db7-84ed-411dd7330fe7',
    });

    const codexHome = join(dir, 'codex-home');
    const codexDir = join(codexHome, 'sessions', '2026', '07', '10');
    mkdirSync(codexDir, { recursive: true });
    const codexRollout = join(
      codexDir,
      'rollout-2026-07-10T10-00-00-019f4a9a-e20e-7131-9e9d-703db5c8a2fc.jsonl',
    );
    writeFileSync(codexRollout, readFileSync(join(fixtures, 'codex-rollout.jsonl'), 'utf8'));
    const codexEnv = { HOME: dir, CODEX_HOME: codexHome };
    expect(
      parseMirrorHook('codex', readFileSync(join(fixtures, 'codex-notify.json'), 'utf8'), codexEnv),
    ).toMatchObject({
      type: 'mirror_turn',
      harness: 'codex',
      native_turn_id: 'turn-7',
      body: 'Reviewed @planner',
      transcript_path: codexRollout,
    });
    expect(detectSession({ harness: 'codex', cwd: '/work', env: codexEnv })).toMatchObject({
      harness: 'codex',
      session_ref: '019f4a9a-e20e-7131-9e9d-703db5c8a2fc',
      transcript_path: codexRollout,
    });
  });

  // harn:assume empty-database-desk-uses-service-home ref=bootstrap-service-home-regression
  // harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-tutorial-regression
  // Two full startCodor/close cycles plus native module load routinely exceed
  // vitest's 5s default on Windows, where process and filesystem overhead is
  // higher than on POSIX; this does not indicate a hang (observed ~6s).
  it('bootstraps one home-rooted Desk and one durable Tutorial message', async () => {
    const homeDir = join(dir, 'service-home');
    mkdirSync(homeDir);
    const dataDir = join(dir, 'up-data');
    const running = await startCodor({
      dataDir,
      homeDir,
      token: 'up-token',
      port: 0,
      owner: 'operator',
      room: 'desk',
      roomName: 'Desk',
      relayUrl: 'https://relay.example.test',
      pushVapidPublicKey: 'm3-vapid-public-key',
      line: { name: 'home-launcher', secret: 'local-test-secret' },
      bootstrap: [],
    });
    const desk = running.daemon.store.getRoom('desk');
    expect(desk?.config.cwd).toBe(homeDir);
    expect(isAbsolute(desk!.config.cwd!)).toBe(true);
    expect(desk?.config.cwd).not.toBe(process.cwd());
    const tutorial = running.daemon.store.listMembers('desk')
      .find((member) => member.handle === 'tutorial');
    expect(tutorial).toMatchObject({ kind: 'system', display_name: 'Tutorial' });
    expect(running.daemon.store.listMessages('desk')).toEqual([
      expect.objectContaining({
        author: tutorial!.id,
        kind: 'chat',
        body: 'Welcome to Codor 👋 This is your Desk. Add an agent from the Members panel, then send a message here to start working. Use @mentions when you want a specific helper, and create another channel when you want a separate project.',
      }),
    ]);
    expect(running.daemon.registeredAdapters()
      .filter((adapter) => adapter.id === adapter.harness)
      .map((adapter) => adapter.id)).toEqual(
      [...BUILTIN_ADAPTER_IDS].sort(),
    );
    expect(running.server.socketPath).toBe(localSocketPath(dataDir));
    expect(running.transport).toBeDefined();
    expect(running.residency?.registeredAdapters().map((adapter) => adapter.id)).toEqual(
      [...BUILTIN_ADAPTER_IDS].sort(),
    );
    const pushConfig = await fetch(`http://127.0.0.1:${String(running.server.port)}/api/push/config`, {
      headers: { authorization: 'Bearer up-token' },
    });
    expect(await pushConfig.json()).toEqual({
      enabled: true,
      vapid_public_key: 'm3-vapid-public-key',
    });
    const closeOrder: string[] = [];
    const closeResidency = running.residency!.close.bind(running.residency);
    running.residency!.close = async () => {
      closeOrder.push('residency');
      await closeResidency();
    };
    const closeDaemon = running.daemon.close.bind(running.daemon);
    running.daemon.close = async (options) => {
      closeOrder.push('daemon');
      await closeDaemon(options);
    };
    running.daemon.createRoom({
      id: 'ordinary',
      name: 'Ordinary',
      owner: { handle: 'operator', display_name: 'operator' },
    });
    expect(running.daemon.store.listMembers('ordinary').some(
      (member) => member.handle === 'tutorial',
    )).toBe(false);
    expect(running.daemon.store.listMessages('ordinary')).toEqual([]);
    await running.close();
    expect(closeOrder).toEqual(['residency', 'daemon']);

    const restarted = await startCodor({
      dataDir,
      homeDir,
      token: 'up-token',
      port: 0,
      owner: 'operator',
      room: 'desk',
      roomName: 'Desk',
      bootstrap: [],
    });
    try {
      expect(restarted.daemon.store.listRooms().map((room) => room.id)).toEqual(['desk', 'ordinary']);
      expect(restarted.daemon.store.listMembers('desk')
        .filter((member) => member.handle === 'tutorial')).toHaveLength(1);
      expect(restarted.daemon.store.listMessages('desk')).toHaveLength(1);
      expect(restarted.daemon.store.listMembers('ordinary').some(
        (member) => member.handle === 'tutorial',
      )).toBe(false);
      expect(restarted.daemon.store.listMessages('ordinary')).toEqual([]);
    } finally {
      await restarted.close();
    }
  }, 15000);
  // harn:end empty-database-desk-seeds-tutorial-atomically
  // harn:end empty-database-desk-uses-service-home

  // harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=production-browser-protocol-regression
  it('enforces epoch 2 in the real up composition while an epoch-less agent still hydrates', async () => {
    const token = 'production-epoch-token';
    const running = await startCodor({
      dataDir: join(dir, 'epoch-up-data'),
      token,
      port: 0,
      owner: 'operator',
      bootstrap: [],
    });
    const sockets: WebSocket[] = [];
    const connect = async (credential: string) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${String(running.server.port)}/ws?token=${encodeURIComponent(credential)}`,
      );
      sockets.push(ws);
      const frames: ServerFrame[] = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as ServerFrame));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      return {
        ws,
        frames,
        next: (predicate: (frame: ServerFrame) => boolean) => until(() => frames.find(predicate)),
      };
    };

    try {
      const base = `http://127.0.0.1:${String(running.server.port)}`;
      expect((await fetch(`${base}/api/client-compatibility?client_kind=browser`, {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(426);
      expect((await fetch(
        `${base}/api/client-compatibility?client_kind=browser&browser_protocol=${String(BROWSER_PROTOCOL_EPOCH)}`,
        { headers: { authorization: `Bearer ${token}` } },
      )).status).toBe(200);

      const stale = await connect(token);
      const staleClosed = new Promise<number>((resolve) => stale.ws.once('close', resolve));
      stale.ws.send(JSON.stringify({
        type: 'subscribe', room: 'default', since_seq: 0,
        room_addressed: true, client_kind: 'browser',
      }));
      expect(await stale.next((frame) => frame.type === 'upgrade_required')).toMatchObject({
        type: 'upgrade_required',
        minimum_browser_protocol: BROWSER_PROTOCOL_EPOCH,
      });
      expect(await staleClosed).toBe(4406);
      expect(stale.frames.map((frame) => frame.type)).toEqual(['upgrade_required']);

      const current = await connect(token);
      current.ws.send(JSON.stringify({
        type: 'subscribe', room: 'default', since_seq: 0,
        room_addressed: true, client_kind: 'browser',
        browser_protocol: BROWSER_PROTOCOL_EPOCH,
      }));
      expect(await current.next((frame) => frame.type === 'sync_complete')).toMatchObject({
        type: 'sync_complete', room: 'default',
      });

      const agentToken = 'production-epoch-agent-token';
      const agent = running.daemon.store.addMember('default', {
        kind: 'agent', handle: 'epoch-agent', display_name: 'Epoch Agent', state: 'idle',
      });
      running.daemon.store.setAgentCredentialHash(
        'default',
        agent.id,
        createHash('sha256').update(agentToken).digest('hex'),
      );
      const agentClient = await connect(agentToken);
      agentClient.ws.send(JSON.stringify({
        type: 'subscribe', room: 'default', since_seq: 0,
        room_addressed: true, client_kind: 'browser',
      }));
      expect(await agentClient.next((frame) => frame.type === 'self')).toMatchObject({
        type: 'self', member_id: agent.id,
      });
      expect(await agentClient.next((frame) => frame.type === 'sync_complete')).toMatchObject({
        type: 'sync_complete', room: 'default',
      });
    } finally {
      for (const socket of sockets) socket.close();
      await running.close();
    }
  });
  // harn:end browser-protocol-epoch-blocks-only-stale-browser-ui

  it('normalizes repeatable adapter flags and starts with the configured registry', async () => {
    expect(parseAdapterModules([
      'fixture-harness=./adapter.mjs',
      'acp=@example/acp-adapter',
    ])).toEqual({
      'fixture-harness': './adapter.mjs',
      acp: '@example/acp-adapter',
    });
    expect(() => parseAdapterModules(['broken'])).toThrow('--adapter must be name=module');
    expect(() => parseAdapterModules(['codex=one', 'codex=two'])).toThrow(
      "duplicate --adapter id 'codex'",
    );
    expect(Object.hasOwn(parseAdapterModules(['__proto__=safe.mjs']), '__proto__')).toBe(true);

    const fixture = fileURLToPath(new URL('../../switchboard/test-fixtures/third-party-adapter.mjs', import.meta.url));
    const running = await startCodor({
      dataDir: join(dir, 'configured-up-data'),
      token: 'configured-up-token',
      port: 0,
      adapters: { 'cli-fixture': fixture },
    });
    try {
      expect(running.daemon.registeredAdapters()
        .filter((adapter) => adapter.id === adapter.harness)
        .map((adapter) => adapter.id)).toEqual(
        [...BUILTIN_ADAPTER_IDS, 'cli-fixture'].sort(),
      );
    } finally {
      await running.close();
    }

    const unopenedDataDir = join(dir, 'failed-config-data');
    await expect(startCodor({
      dataDir: unopenedDataDir,
      token: 'configured-up-token',
      port: 0,
      adapters: {
        broken: 'data:text/javascript,export%20const%20notAFactory%20%3D%20true',
      },
    })).rejects.toThrow(/must export createAdapter/);
    expect(existsSync(unopenedDataDir)).toBe(false);

    const outpost = await startOutpost({
      dataDir: join(dir, 'configured-outpost-data'),
      line: { name: 'adapter-test', secret: 'local-only-secret' },
      bootstrap: [],
      adapters: { 'cli-fixture': fixture },
    });
    try {
      expect(outpost.residency.registeredAdapters().map((adapter) => adapter.id)).toEqual(
        [...BUILTIN_ADAPTER_IDS, 'cli-fixture'].sort(),
      );
    } finally {
      await outpost.close();
    }
  });

  it('keeps trusted Tailscale Serve enrollment opt-in through flag and environment defaults', () => {
    const disabled = createProgram({ env: {} }).commands.find((command) => command.name() === 'up')!;
    const enabled = createProgram({
      env: { CODOR_TRUST_TAILSCALE_SERVE: '1' },
    }).commands.find((command) => command.name() === 'up')!;
    expect(disabled.opts().trustTailscaleServe).toBe(false);
    expect(enabled.opts().trustTailscaleServe).toBe(true);
  });
  it('exposes install as the primary installer command with setup as a working alias', () => {
    const program = createProgram();
    const install = program.commands.find((command) => command.name() === 'install');
    expect(install).toBeDefined();
    expect(install!.aliases()).toContain('setup');
    // setup is not a second command, only an alias of install.
    expect(program.commands.map((command) => command.name())).not.toContain('setup');
  });

  it('runs the installer under codor install as well as the codor setup alias', async () => {
    const context = {
      env: { HOME: '/home/inst', USER: 'inst', PATH: '/usr/bin' },
      stdout: (line: string) => output.push(line),
      setup: {
        home: '/home/inst',
        nodePath: process.execPath,
        platform: 'linux' as const,
        repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
        which: () => undefined,
      },
    };
    output = [];
    await runCli(['node', 'codor', 'install', '--dry-run'], context);
    const viaInstall = output.join('\n');
    output = [];
    await runCli(['node', 'codor', 'setup', '--dry-run'], context);
    expect(viaInstall).toContain('[dry-run]');
    expect(output.join('\n')).toContain('[dry-run]');
  });
});
const fixtureGit = (cwd: string, args: readonly string[]): string => execFileSync(
  'git',
  ['-C', cwd, ...args],
  { encoding: 'utf8' },
);
describe('Phase 4 worktree and qualified wait CLI', () => {
  // harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-command-surface
  it('registers only the singular worktree list/add/remove family', async () => {
    const program = createProgram();
    const structuredWorktrees = program.commands.find((command) => command.name() === 'worktree');
    expect(structuredWorktrees?.aliases()).toEqual([]);
    expect(structuredWorktrees?.commands.map((command) => command.name())).toEqual(['list', 'add', 'remove']);
    expect(structuredWorktrees?.commands.find((command) => command.name() === 'add')?.options.map((option) => option.long))
      .toEqual(expect.arrayContaining(['--adopt', '--create', '--path', '--channel']));
    expect(structuredWorktrees?.commands.find((command) => command.name() === 'remove')?.options.map((option) => option.long))
      .toEqual(expect.arrayContaining(['--filesystem', '--yes', '--json', '--channel']));
    await expect(runCli(['node', 'codor', 'worktree'], {
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    })).rejects.toMatchObject({ exitCode: 2 });
    await expect(runCli(['node', 'codor', 'worktree', 'add', '--channel', 'eng', '--path', '/tmp/x'], {
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    })).rejects.toMatchObject({ exitCode: 2 });
  });

  // harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-cli-regression
  it('manages disposable Git worktrees through the authenticated REST lifecycle', async () => {
    const fixture = join(dir, 'worktree CLI fixture with spaces');
    const primary = join(fixture, 'primary checkout');
    const adopted = join(fixture, 'adopted checkout');
    const created = join(fixture, 'created checkout');
    const dirty = join(fixture, 'dirty checkout');
    mkdirSync(primary, { recursive: true });
    fixtureGit(primary, ['init', '-q', '-b', 'main']);
    fixtureGit(primary, ['config', 'user.email', 'fixture@example.test']);
    fixtureGit(primary, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    fixtureGit(primary, ['add', 'README.md']);
    fixtureGit(primary, ['commit', '-qm', 'fixture']);
    fixtureGit(primary, ['worktree', 'add', '-b', 'feature/adopted', adopted, 'HEAD']);
    fixtureGit(primary, ['worktree', 'add', '-b', 'feature/dirty', dirty, 'HEAD']);
    daemon.store.updateRoomConfig('eng', { cwd: primary });

    const origin = `http://127.0.0.1:${String(server.port)}`;
    const invoke = async (...args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli([
          'node', 'codor', '--data-dir', dir, '--url', origin, '--token', 'cli-token', ...args,
        ], {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          isTTY: false,
        });
      } catch (caught) {
        error = caught;
      }
      return { stdout, stderr, error };
    };

    const listed = await invoke('worktree', 'list', '--channel', 'eng', '--cwd', primary, '--json');
    expect(listed.error).toBeUndefined();
    expect(listed.stdout).toHaveLength(1);
    const list = JSON.parse(listed.stdout[0]!) as {
      repository: Record<string, unknown> | null;
      discovered: { path: string; primary: boolean }[];
    };
    expect(list.repository).toBeNull();
    expect(list.discovered).toContainEqual(expect.objectContaining({ path: adopted, primary: false }));
    expect(JSON.stringify(list)).not.toContain('git_admin_id');
    expect(JSON.stringify(list)).not.toContain('common_path');

    const adoptedResult = await invoke(
      'worktree', 'add', '--channel', 'eng', '--adopt', '--path', adopted, '--cwd', primary, '--json',
    );
    expect(adoptedResult.error).toBeUndefined();
    expect(JSON.parse(adoptedResult.stdout[0]!)).toMatchObject({
      alias: worktreeSelectorFromBranch('feature/adopted'), source: 'adopted', branch: 'feature/adopted',
    });

    const createdResult = await invoke(
      'worktree', 'add', '--channel', 'eng', '--create', '--path', created,
      '--branch', 'feature/created', '--cwd', primary, '--json',
    );
    expect(createdResult.error).toBeUndefined();
    expect(JSON.parse(createdResult.stdout[0]!)).toMatchObject({
      alias: worktreeSelectorFromBranch('feature/created'), source: 'created', branch: 'feature/created',
    });

    const dirtyAdopted = await invoke(
      'worktree', 'add', '--channel', 'eng', '--adopt', '--path', dirty, '--cwd', primary, '--json',
    );
    expect(dirtyAdopted.error).toBeUndefined();

    const unregistered = await invoke(
      'worktree', 'remove', 'feature/adopted', '--channel', 'eng', '--yes', '--json',
    );
    expect(unregistered.error).toBeUndefined();
    expect(existsSync(adopted)).toBe(true);
    expect(fixtureGit(primary, ['show-ref', '--verify', 'refs/heads/feature/adopted'])).toContain('feature/adopted');

    writeFileSync(join(dirty, 'uncommitted.txt'), 'dirty\n');
    const dirtyRemoval = await invoke(
      'worktree', 'remove', worktreeSelectorFromBranch('feature/dirty'), '--channel', 'eng', '--filesystem', '--yes', '--json',
    );
    expect(dirtyRemoval.error).toMatchObject({ exitCode: 6 });
    expect(dirtyRemoval.stdout).toEqual([]);
    expect(existsSync(dirty)).toBe(true);

    const removed = await invoke(
      'worktree', 'remove', worktreeSelectorFromBranch('feature/created'), '--channel', 'eng', '--filesystem', '--yes', '--json',
    );
    expect(removed.error).toBeUndefined();
    expect(existsSync(created)).toBe(false);
    expect(fixtureGit(primary, ['show-ref', '--verify', 'refs/heads/feature/created'])).toContain('feature/created');

    const alpha = credentialedAgent('worktree-cli-agent');
    const agentAttempt = await runCli([
      'node', 'codor', '--data-dir', dir, '--url', origin,
      'worktree', 'list', '--channel', 'eng', '--json',
    ], {
      env: alpha.env,
      stdout: () => undefined,
      stderr: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(agentAttempt).toBeUndefined();
  });

  it('uses the fresh preview identity for consent and refuses mismatched preview ids', async () => {
    const fixture = restWorktreeFixture();
    const calls: Array<{ method: string; path: string; body?: string; authorization?: string }> = [];
    let mismatch = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(typeof init?.body === 'string' && { body: init.body }),
        ...(authorization !== undefined && { authorization }),
      });
      if (url.pathname.endsWith('/removal-preview')) {
        return new Response(JSON.stringify({
          repository: fixture.repository,
          worktree: mismatch ? { ...fixture.fresh, id: '01C4F6Y9J4QJ5F4KZ5T6X2V3W4' } : fixture.fresh,
          state: 'clean',
          branch_preserved: true,
        }), { status: 200 });
      }
      if (url.pathname.endsWith('/remove')) {
        return new Response(JSON.stringify({ repository: fixture.repository, worktree: fixture.fresh }), { status: 200 });
      }
      return new Response(JSON.stringify(fixture.list), { status: 200 });
    });
    try {
      const prompt: string[] = [];
      const stdout: string[] = [];
      await runCli([
        'node', 'codor', '--data-dir', dir, '--url', 'http://127.0.0.1:8137', '--token', 'explicit-token',
        'worktree', 'remove', fixture.selected.branch, '--channel', 'eng', '--filesystem',
      ], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => prompt.push(line),
        isTTY: true,
        confirm: async (line) => {
          prompt.push(`confirm:${line}`);
          return 'yes';
        },
      });
      expect(prompt[0]).toContain('fresh-child');
      expect(prompt[0]).toContain('/repo/fresh-child');
      expect(prompt[0]).not.toContain('stale-child');
      expect(prompt[0]).not.toContain('/repo/stale-child');
      expect(prompt.filter((line) => !line.startsWith('confirm:'))).toHaveLength(1);
      expect(stdout).toHaveLength(1);
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

      mismatch = true;
      calls.length = 0;
      prompt.length = 0;
      await expect(runCli([
        'node', 'codor', '--data-dir', dir, '--url', 'http://127.0.0.1:8137', '--token', 'explicit-token',
        'worktree', 'remove', fixture.selected.branch, '--channel', 'eng', '--filesystem',
      ], {
        stdout: () => undefined,
        stderr: (line) => prompt.push(line),
        isTTY: true,
        confirm: async () => 'yes',
      })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.transport });
      expect(prompt).toEqual([]);
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('keeps credential locality, role refusals, default-roster forwarding, and no-mutation boundaries', async () => {
    const fixture = restWorktreeFixture();
    const home = join(dir, 'operator home');
    mkdirSync(join(home, '.config', 'codor'), { recursive: true });
    writeFileSync(operatorTokenPath(home), 'operator-token\n', { mode: 0o600 });
    const requests: Array<{ method: string; path: string; authorization?: string; body?: unknown }> = [];
    let successfulMutations = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      const token = authorization?.replace(/^Bearer /, '');
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(authorization !== undefined && { authorization }),
        ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as unknown }),
      });
      if (token !== 'operator-token' && token !== 'explicit-token' && token !== 'agent-token') {
        return new Response(JSON.stringify({ error: 'forbidden: worktree lifecycle is restricted to owners and admins' }), { status: 403 });
      }
      if (init?.method === 'POST') {
        successfulMutations += 1;
        return new Response(JSON.stringify({ repository: fixture.repository, worktree: fixture.selected }), { status: 200 });
      }
      return new Response(JSON.stringify(fixture.list), { status: 200 });
    });
    const invoke = async (args: string[], env: NodeJS.ProcessEnv) => {
      let error: unknown;
      try {
        await runCli(['node', 'codor', '--data-dir', dir, ...args], {
          env,
          stdout: () => undefined,
          stderr: () => undefined,
          isTTY: false,
        });
      } catch (caught) {
        error = caught;
      }
      return error;
    };
    try {
      await invoke(['--url', 'http://127.0.0.1:8137', 'worktree', 'list', '--channel', 'eng', '--json'], { HOME: home });
      expect(requests[0]).toMatchObject({ method: 'GET', authorization: 'Bearer operator-token' });

      await invoke([
        '--url', 'http://127.0.0.1:8137', '--token', 'explicit-token',
        'worktree', 'add', '--channel', 'eng', '--create', '--path', '/repo/new',
        '--branch', 'feature/new', '--default-roster', '--json',
      ], {});
      expect(requests.at(-1)).toMatchObject({
        method: 'POST',
        authorization: 'Bearer explicit-token',
        body: { path: '/repo/new', branch: 'feature/new', default_roster: true },
      });

      const beforeRemote = requests.length;
      expect(await invoke(['--url', 'https://remote.example.test', 'worktree', 'list', '--channel', 'eng', '--json'], { HOME: home }))
        .toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.authentication });
      expect(requests).toHaveLength(beforeRemote);

      const successfulPosts = successfulMutations;
      for (const token of ['member-token', 'observer-token']) {
        const refusal = await invoke([
          '--url', 'http://127.0.0.1:8137', '--token', token,
          'worktree', 'add', '--channel', 'eng', '--create', '--path', '/repo/refused',
          '--branch', 'feature/refused', '--json',
        ], {});
        expect(refusal).toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.authorization });
      }
      expect(await invoke([
        '--url', 'http://127.0.0.1:8137', '--token', 'agent-token',
        'worktree', 'list', '--channel', 'eng', '--json',
      ], {})).toBeUndefined();
      expect(await invoke([
        '--url', 'http://127.0.0.1:8137', '--token', 'agent-token',
        'worktree', 'add', '--channel', 'eng', '--create', '--path', '/repo/agent-created',
        '--branch', 'feature/agent-created', '--json',
      ], {})).toBeUndefined();
      expect(successfulMutations).toBe(successfulPosts + 1);
    } finally {
      fetch.mockRestore();
    }
  });

  // harn:assume qualified-cli-wait-follows-target-owned-conversation ref=qualified-target-post-wait-regression
  it('post --wait keeps an authoritative foreign peer with an equal local handle', async () => {
    const fixture = join(dir, 'qualified wait fixture');
    const primary = join(fixture, 'primary');
    const child = join(fixture, 'child');
    mkdirSync(primary, { recursive: true });
    fixtureGit(primary, ['init', '-q', '-b', 'main']);
    fixtureGit(primary, ['config', 'user.email', 'fixture@example.test']);
    fixtureGit(primary, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    fixtureGit(primary, ['add', 'README.md']);
    fixtureGit(primary, ['commit', '-qm', 'fixture']);
    fixtureGit(primary, ['worktree', 'add', '-b', 'feature/qualified-wait', child, 'HEAD']);
    daemon.store.updateRoomConfig('eng', { cwd: primary });
    const target = await daemon.adoptWorktree('eng', { path: child });
    const targetAlias = worktreeSelectorFromBranch('feature/qualified-wait');
    const origin = credentialedAgent('same-handle');
    const foreign = daemon.spawnMember(target.worktree.conversation_id, {
      harness: 'fake',
      handle: 'same-handle',
      cwd: child,
    });
    fake.enqueue({ kind: 'complete', final_text: 'origin setup remains active', delay_ms: 2_000 });
    daemon.postHumanMessage('eng', '@same-handle establish the local wait context');
    await until(() => daemon.store.getMember('eng', origin.member.id)?.state === 'running'
      ? true
      : undefined);
    fake.enqueue({ kind: 'complete', final_text: 'foreign setup remains active', delay_ms: 300 });
    daemon.postHumanMessage('eng', `~${targetAlias}:@same-handle establish the scoped group`);
    await until(() => daemon.store.getMember(target.worktree.conversation_id, foreign.id)?.state === 'running'
      ? true
      : undefined);
    void (async () => {
      await until(() => daemon.store.listMessages(target.worktree.conversation_id, { limit: 20 })
        .some((message) => message.body === `~${targetAlias}:@same-handle scoped question`)
        ? true
        : undefined);
      daemon.postAgentMessage(target.worktree.conversation_id, foreign.id, '~main:@same-handle foreign answer');
    })();

    output = [];
    await memberCli(origin.env, 'post', '--wait', '--timeout', '1', `~${targetAlias}:@same-handle scoped question`);
    expect(output.at(-1)).toBe('~main:@same-handle foreign answer');
    const posted = daemon.store.listMessages(target.worktree.conversation_id, { limit: 20 }).find((message) =>
      message.body === `~${targetAlias}:@same-handle scoped question`);
    expect(posted?.mentions.map((mention) => mention.member_id)).toContain(foreign.id);
    expect(daemon.store.listMessages('eng', { limit: 20 }).some((message) =>
      message.body === `~${targetAlias}:@same-handle scoped question`)).toBe(false);
    expect(daemon.store.listDeliveries('eng', { recipient: origin.member.id })
      .some((delivery) => delivery.state === 'consumed')).toBe(true);
    await daemon.settle();
  });
});

const restWorktreeFixture = () => {
  const repository = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    room: 'eng',
    common_path: '/repo',
    primary_path: '/repo/main',
    primary_git_admin_id: '/repo/main/.git',
    created_ts: '2026-08-08T00:00:00.000Z',
    updated_ts: '2026-08-08T00:00:00.000Z',
  };
  const selected = {
    id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
    repository_id: repository.id,
    room: 'eng',
    conversation_id: 'eng',
    alias: 'child',
    path: '/repo/stale-child',
    git_admin_id: '/repo/main/.git/worktrees/child',
    primary: false,
    source: 'created' as const,
    lifecycle: 'active' as const,
    availability: 'available' as const,
    locked: false,
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'feature/child',
    registered_ts: repository.created_ts,
    updated_ts: repository.updated_ts,
  };
  return {
    repository,
    selected,
    fresh: { ...selected, path: '/repo/fresh-child' },
    list: { repository, registered: [selected], discovered: [] },
  };
};

// harn:assume structured-management-help-and-docs-are-complete ref=management-help-regression
describe('Phase 5 management help', () => {
  it('documents every accepted family without selected credentials or private fields', () => {
    const program = createProgram({
      env: {
        CODOR_MEMBER_TOKEN: 'help-member-secret',
        CODOR_TOKEN: 'help-operator-secret',
      },
    });
    const captureHelp = (command: ReturnType<typeof createProgram>): string => {
      let rendered = '';
      command.configureOutput({ writeOut: (value) => { rendered += value; } });
      command.outputHelp();
      return rendered;
    };
    const rootHelp = captureHelp(program);
    for (const family of ['channel', 'agent', 'agent-preset', 'default-roster', 'worktree']) {
      expect(rootHelp).toContain(`codor ${family} --help`);
    }
    expect(rootHelp).toContain('flat commands remain compatible');
    expect(rootHelp).toContain('--token <token>');

    const families = {
      channel: {
        commands: ['list', 'create', 'show', 'rename', 'archive'],
        text: ['Archive is soft retention only', 'no hard-delete or restore command'],
      },
      agent: {
        commands: ['list', 'add', 'configure', 'rename', 'pause', 'revive', 'remove'],
        text: ['Agent add selects exactly one public adapter or preset'],
      },
      'agent-preset': {
        commands: ['list', 'create', 'update', 'delete'],
        text: ['individual reusable preset CRUD', 'separate from default-roster'],
      },
      'default-roster': {
        commands: ['show', 'set'],
        text: ['replaces the entire ordered roster', 'separate from individual presets'],
      },
      worktree: {
        commands: ['list', 'add', 'remove'],
        text: ['Worktree add requires --create or --adopt', 'Remove unregisters by default', '--filesystem'],
      },
    } as const;
    for (const [family, expected] of Object.entries(families)) {
      const command = program.commands.find((candidate) => candidate.name() === family);
      expect(command, family).toBeDefined();
      expect(command!.commands.map((child) => child.name())).toEqual(expected.commands);
      const help = captureHelp(command!);
      for (const phrase of expected.text) expect(help).toContain(phrase);
    }

    const rendered = rootHelp + Object.keys(families)
      .map((family) => captureHelp(program.commands.find((candidate) => candidate.name() === family)!))
      .join('\n');
    for (const secret of ['help-member-secret', 'help-operator-secret', 'acp_launch', 'session_ref', 'Bearer ']) {
      expect(rendered).not.toContain(secret);
    }
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const packedScript = readFileSync(join(repoRoot, 'scripts', 'packed-install-test.sh'), 'utf8');
    const documented = `${rendered}\n${readme}\n${packedScript}`;
    expect(documented).not.toContain('codor channel list --channel');
    expect(documented).toContain('codor channel list --json');
    expect(documented).toContain('codor channel show desk --json');
    const rawGitSetup = packedScript.match(
      /export PHASE5_PRIMARY=[\s\S]*?node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/,
    )?.[1] ?? '';
    expect(rawGitSetup).toContain("git(primary, ['init', '-q', '-b', 'main'])");
    expect(rawGitSetup).not.toContain('worktree add');
    expect(rawGitSetup).not.toContain('phase5-child');
    expect(packedScript).toContain('PHASE5_CHILD_JSON=');
    expect(packedScript).toContain('worktree add --channel phase5-root --create');
  });
});
// harn:end structured-management-help-and-docs-are-complete
