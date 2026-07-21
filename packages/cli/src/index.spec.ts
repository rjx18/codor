import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_PROTOCOL_EPOCH, type ServerFrame } from '@codor/protocol';
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
  detectSession,
  nativeResumeCommand,
  packageName,
  parseMirrorHook,
  renderTerminalQr,
  runCli,
  startCodor,
} from './index.js';
import { parseLine, startOutpost } from './up.js';
import { parseAdapterModules } from './program.js';
import { probeCodorStatus, waitForCodor } from './setup.js';

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
  // harn:assume human-facing-surfaces-call-rooms-channels ref=cli-channel-regression
  it('registers the complete M1 command surface', () => {
    expect(packageName()).toBe('@codor/cli');
    expect(createProgram().commands.map((command) => command.name())).toEqual([
      'up',
      'channels',
      'serve',
      'install',
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
    ]);
    const program = createProgram();
    expect(program.commands.find((command) => command.name() === 'spawn')?.options.map((option) => option.long))
      .toContain('--channel');
    expect(program.commands.flatMap((command) => command.options.map((option) => option.long)))
      .not.toContain('--room');
  });
  // harn:end human-facing-surfaces-call-rooms-channels

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
      "[dry-run] create /home/setup-test/.config/codor and /home/setup-test/.codor mode 700; create /home/setup-test/.config/codor/token mode 600 if absent
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
      ExecStart=\"/home/setup-test/.nvm/versions/node/v22.8.0/bin/node\" \"<repo>/packages/cli/dist/index.js\" \"--data-dir\" \"/home/setup-test/.codor\" \"up\" \"--static-root\" \"<repo>/packages/web-next/dist\" \"--channel\" \"desk\" \"--channel-name\" \"Desk\"
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
      PATH=/home/setup-test/.local/bin:/home/setup-test/.nvm/versions/node/v22.8.0/bin:/home/setup-test/.opencode/bin:/usr/local/bin:/usr/bin
      [dry-run] systemctl --user daemon-reload
      [dry-run] systemctl --user enable --now codor.service
      [dry-run] access localhost; skip Tailscale Serve
      [dry-run] wait for Codor pairing status, then generate a ten-minute QR, URL, and pairing code"
    `);
    expect(existsSync(join(home, '.config', 'codor'))).toBe(false);
  });

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

    const sleeps: number[] = [];
    await expect(waitForCodor(
      'http://127.0.0.1:65535',
      async () => false,
      async (milliseconds) => { sleeps.push(milliseconds); },
    )).rejects.toThrow('did not become ready');
    expect(sleeps).toEqual(Array.from({ length: 19 }, () => 250));
  });

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
        platform: 'linux',
        probe: async () => true,
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
    // Tailscale is resolved to an absolute path, capability-probed, and Serve is
    // published during Choose access — before the daemon is started.
    expect(commands).toEqual([
      '/usr/bin/tailscale serve --help',
      '/usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      '/usr/bin/tailscale serve status',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now codor.service',
      'loginctl show-user setup-test -p Linger --value',
    ]);
    expect(qrPayload).toBe(output[output.indexOf('<setup-qr>') + 1]);
    expect(new URL(qrPayload!).origin).toBe('https://setup-host.example.ts.net');
    expect(output.join('\n')).toMatch(/code: [23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}/);
    expect(output.join('\n')).not.toContain('a'.repeat(64));
  });

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
      uid: 501,
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
    expect(output).toContain('[dry-run] launchctl kickstart -k gui/501/app.codor.switchboard');
    const plistStart = output.indexOf('[dry-run] launch agent content:') + 1;
    const plistEnd = output.findIndex((line, index) => index >= plistStart && line.startsWith('[dry-run] launchctl'));
    const dryRunPlist = output.slice(plistStart, plistEnd).join('\n') + '\n';
    expect(dryRunPlist).toContain('<string>app.codor.switchboard</string>');
    expect(dryRunPlist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(dryRunPlist).toContain(`${join(repoRoot, 'packages', 'web-next', 'dist').replace('&', '&amp;')}</string>`);
    expect(dryRunPlist).toContain('<string>&lt;redacted generated-or-existing token&gt;</string>');
    expect(dryRunPlist).toContain('<key>ProcessType</key>\n  <string>Background</string>');
    expect(dryRunPlist).toContain('<key>Umask</key>\n  <integer>63</integer>');

    output = [];
    await runCli(['node', 'codor', 'setup', '--yes', '--access', 'localhost'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/opt/homebrew/bin:/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        ...common,
        exec: (command, args) => {
          commands.push([command, ...args].join(' '));
          if (command === 'launchctl' && args[0] === 'bootout') throw new Error('not loaded');
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
    expect(commands).toEqual([
      `plutil -lint ${launchAgentPath}`,
      'launchctl bootout gui/501/app.codor.switchboard',
      `launchctl bootstrap gui/501 ${launchAgentPath}`,
      'launchctl enable gui/501/app.codor.switchboard',
      'launchctl kickstart -k gui/501/app.codor.switchboard',
    ]);
    expect(new URL(qrPayload!).origin).toBe('http://127.0.0.1:8137');
    expect(output.join('\n')).not.toContain(token);
  });
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
      JSON.stringify(claudeTranscript).slice(1, -1),
      readFileSync(join(fixtures, 'claude-transcript.jsonl'), 'utf8'),
    );
    const claudeRaw = readFileSync(join(fixtures, 'claude-stop.json'), 'utf8').replace(
      'CLAUDE_TRANSCRIPT_PATH',
      claudeTranscript,
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

  it('boots a default room plus the data-directory socket', async () => {
    const running = await startCodor({
      dataDir: join(dir, 'up-data'),
      token: 'up-token',
      port: 0,
      owner: 'operator',
      relayUrl: 'https://relay.example.test',
      pushVapidPublicKey: 'm3-vapid-public-key',
      line: { name: 'home-launcher', secret: 'local-test-secret' },
      bootstrap: [],
    });
    expect(running.daemon.store.listRooms().map((room) => room.id)).toEqual(['default']);
    expect(running.daemon.registeredAdapters().map((adapter) => adapter.id)).toEqual(
      [...BUILTIN_ADAPTER_IDS].sort(),
    );
    expect(running.server.socketPath).toBe(localSocketPath(join(dir, 'up-data')));
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
    await running.close();
    expect(closeOrder).toEqual(['residency', 'daemon']);
  });

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

  // harn:assume adapter-registry-sole-harness-source ref=registry-cli-composition
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
      expect(running.daemon.registeredAdapters().map((adapter) => adapter.id)).toEqual(
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
  // harn:end adapter-registry-sole-harness-source

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
