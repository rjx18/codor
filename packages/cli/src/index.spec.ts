import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_ADAPTER_IDS,
  CryptoVault,
  Daemon,
  FakeAdapter,
  startServer,
  type RunningServer,
} from '@codor/switchboard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProgram,
  detectSession,
  nativeResumeCommand,
  packageName,
  parseMirrorHook,
  renderTerminalQr,
  runCli,
  startWireroom,
} from './index.js';
import { parseLine, startOutpost } from './up.js';
import { parseAdapterModules } from './program.js';

let dir: string;
let daemon: Daemon;
let crypto: CryptoVault;
let fake: FakeAdapter;
let codexFake: FakeAdapter;
let server: RunningServer;
let output: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-cli-'));
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
    socketPath: join(dir, 'wireroom.sock'),
    crypto,
  });
  output = [];
});

afterEach(async () => {
  await server.close();
  await daemon.close();
  crypto.close();
  rmSync(dir, { recursive: true, force: true });
});

const cli = (...args: string[]) =>
  runCli(['node', 'wireroom', '--data-dir', dir, ...args], {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

describe('@codor/cli', () => {
  it('registers the complete M1 command surface', () => {
    expect(packageName()).toBe('@codor/cli');
    expect(createProgram().commands.map((command) => command.name())).toEqual([
      'up',
      'rooms',
      'serve',
      'setup',
      'spawn',
      'post',
      'tail',
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
  });

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
    await cli('ledger', 'init', '--room', 'eng');
    expect(output[0]).toBe(join(dir, 'rooms', 'eng', 'ledger'));
    output = [];
    await cli(
      'ledger', 'add', 'risk-limits', 'Keep exposure below 2%.',
      '--room', 'eng', '--type', 'constraint', '--as', 'alpha',
    );
    expect(output).toEqual(['constraints/risk-limits.md\t[[risk-limits]]']);
    output = [];
    await cli('ledger', 'show', 'risk-limits', '--room', 'eng');
    expect(output[0]).toContain('name: risk-limits');
    expect(output[0]).toContain('Keep exposure below 2%.');
    const destination = join(dir, 'snapshot');
    output = [];
    await cli('ledger', 'pull', '--room', 'eng', '--destination', destination);
    expect(output).toEqual([join(destination, 'ledger')]);
    expect(readFileSync(join(destination, 'ledger', 'constraints', 'risk-limits.md'), 'utf8'))
      .toContain('Keep exposure below 2%.');
  });

  // harn:assume terminal-pairing-qr-matches-plain-url ref=pairing-qr-regression
  it('renders a pairing QR from the exact plain URL and supports explicit plain-only output', async () => {
    let qrPayload: string | undefined;
    await runCli(['node', 'wireroom', '--data-dir', dir, 'pair'], {
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
    expect(output).toHaveLength(2);
    expect(output[0]).toMatch(/^http:\/\/127\.0\.0\.1:8137\/pair\?/);
  });
  // harn:end terminal-pairing-qr-matches-plain-url

  // harn:assume cli-setup-wizard-preserves-service-environment ref=setup-regression
  it('snapshots setup dry-run with the absolute Node path and every detected harness directory', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = '/home/setup-test';
    const installed = new Map([
      ['claude', `${home}/.local/bin/claude`],
      ['codex', `${home}/.nvm/versions/node/v22.8.0/bin/codex`],
      ['opencode', `${home}/.opencode/bin/opencode`],
      ['tailscale', '/usr/bin/tailscale'],
    ]);
    await runCli(['node', 'wireroom', 'setup', '--dry-run'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/local/bin:/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        home,
        nodePath: `${home}/.nvm/versions/node/v22.8.0/bin/node`,
        repoRoot,
        which: (command) => installed.get(command),
      },
    });
    expect(output.join('\n').replaceAll(repoRoot, '<repo>/')).toMatchInlineSnapshot(`
      "[dry-run] create /home/setup-test/.config/wireroom and /home/setup-test/.wireroom mode 700; create /home/setup-test/.config/wireroom/token mode 600 if absent
      [dry-run] install <repo>/packaging/systemd/wireroom.service -> /home/setup-test/.config/systemd/user/wireroom.service mode 600
      [dry-run] unit content:
      [Unit]
      Description=Wireroom local-first agent switchboard
      [Service]
      Type=simple
      WorkingDirectory=%h/wireroom
      EnvironmentFile=%h/.config/wireroom/env
      UMask=0077
      # harn:assume fresh-clone-install-proven-by-script ref=systemd-service
      ExecStart=/home/setup-test/.nvm/versions/node/v22.8.0/bin/node %h/wireroom/packages/cli/dist/index.js --data-dir %h/.wireroom up --static-root %h/wireroom/packages/web/dist --room desk --room-name Desk
      # harn:end fresh-clone-install-proven-by-script
      Restart=on-failure
      RestartSec=5s
      TimeoutStopSec=30s
      KillMode=mixed

      [Install]
      WantedBy=default.target
      [dry-run] write /home/setup-test/.config/wireroom/env mode 600
      WIREROOM_TOKEN=<redacted generated-or-existing token>
      PATH=/home/setup-test/.local/bin:/home/setup-test/.nvm/versions/node/v22.8.0/bin:/home/setup-test/.opencode/bin:/usr/local/bin:/usr/bin
      [dry-run] systemctl --user daemon-reload
      [dry-run] systemctl --user enable --now wireroom.service
      [dry-run] tailscale serve --bg http://127.0.0.1:8137
      [dry-run] tailscale serve status
      [dry-run] generate a ten-minute pairing link and exact-payload terminal QR"
    `);
    expect(existsSync(join(home, '.config', 'wireroom'))).toBe(false);
  });

  it('writes private setup files, runs confirmed host steps, and pairs against the Serve origin', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'setup-home');
    const commands: string[] = [];
    let qrPayload: string | undefined;
    await runCli(['node', 'wireroom', 'setup'], {
      env: { HOME: home, USER: 'setup-test', PATH: '/usr/bin' },
      stdout: (line) => output.push(line),
      setup: {
        confirm: async () => true,
        exec: (command, args) => {
          commands.push([command, ...args].join(' '));
          if (command === 'loginctl') return 'no';
          if (command === 'tailscale' && args.join(' ') === 'serve status') {
            return 'https://setup-host.example.ts.net (tailnet only)';
          }
          return '';
        },
        home,
        nodePath: '/opt/node/bin/node',
        randomToken: () => 'a'.repeat(64),
        renderQr: (payload) => {
          qrPayload = payload;
          return '<setup-qr>';
        },
        repoRoot,
        which: (command) => new Map([
          ['claude', join(home, '.local', 'bin', 'claude')],
          ['codex', '/opt/node/bin/codex'],
          ['tailscale', '/usr/bin/tailscale'],
        ]).get(command),
      },
    });

    const configDir = join(home, '.config', 'wireroom');
    const tokenPath = join(configDir, 'token');
    const envPath = join(configDir, 'env');
    const unitPath = join(home, '.config', 'systemd', 'user', 'wireroom.service');
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.wireroom')).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(unitPath, 'utf8')).toContain('ExecStart=/opt/node/bin/node ');
    expect(readFileSync(envPath, 'utf8')).toContain(
      `PATH=${join(home, '.local', 'bin')}:/opt/node/bin:/usr/bin`,
    );
    expect(commands).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now wireroom.service',
      'loginctl show-user setup-test -p Linger --value',
      'tailscale serve --bg http://127.0.0.1:8137',
      'tailscale serve status',
    ]);
    expect(qrPayload).toBe(output[output.indexOf('<setup-qr>') + 1]);
    expect(new URL(qrPayload!).origin).toBe('https://setup-host.example.ts.net');
    expect(output.join('\n')).not.toContain('a'.repeat(64));
  });
  // harn:end cli-setup-wizard-preserves-service-environment

  it('resolves Gemini interactive resume through the supervised attach path', () => {
    expect(nativeResumeCommand({
      id: 'gemini-member',
      kind: 'agent',
      handle: 'gemini',
      display_name: 'Gemini',
      harness: 'gemini',
      session_ref: '11111111-1111-4111-8111-111111111111',
    }, { WIREROOM_GEMINI_COMMAND: '/opt/gemini' })).toEqual({
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
    }, { WIREROOM_OPENCODE_COMMAND: '/opt/opencode' })).toEqual({
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
    }, { WIREROOM_COPILOT_COMMAND: '/opt/copilot' })).toEqual({
      command: '/opt/copilot',
      args: ['--resume', '33333333-3333-4333-8333-333333333333'],
    });
  });

  it('spawns, posts, and tails through the unix WebSocket protocol', async () => {
    await cli('rooms');
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

  it('changes only transport and token for a remote WebSocket', async () => {
    await runCli(
      [
        'node',
        'wireroom',
        '--url',
        `http://127.0.0.1:${server.port}`,
        '--token',
        'cli-token',
        'rooms',
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

    const attached = runCli(['node', 'wireroom', '--data-dir', dir, 'attach', '@coder'], {
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
      'member @shared is ambiguous: eng (idle), ops (dead); pass --room <channel-id>',
    );
  });
  // harn:end cli-member-recovery-is-actionable

  // harn:assume global-cli-install-is-idempotent ref=cli-install-regression
  it('installs the built CLI as one stable per-user symlink on repeated runs', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const home = join(dir, 'install-home');
    const script = join(repoRoot, 'scripts', 'install-cli.sh');
    const env = { ...process.env, HOME: home };
    execFileSync(script, { env, stdio: 'pipe' });
    execFileSync(script, { env, stdio: 'pipe' });
    expect(readlinkSync(join(home, '.local', 'bin', 'wireroom'))).toBe(
      join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
    );
    const installed = join(home, '.local', 'bin', 'wireroom');
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(execFileSync(installed, ['--help'], { env, encoding: 'utf8' })).toContain('Usage: wireroom');
  });
  // harn:end global-cli-install-is-idempotent

  it('parses documented Claude hooks and Codex notify plus rollout tailing', () => {
    const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
    const claudeTranscript = join(dir, 'claude-transcript.jsonl');
    writeFileSync(
      claudeTranscript,
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
    const running = await startWireroom({
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
    expect(running.server.socketPath).toBe(join(dir, 'up-data', 'wireroom.sock'));
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
    const running = await startWireroom({
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
    await expect(startWireroom({
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
});
