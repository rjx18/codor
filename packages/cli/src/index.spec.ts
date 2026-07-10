import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CryptoVault,
  Daemon,
  FakeAdapter,
  startServer,
  type RunningServer,
} from '@wireroom/switchboard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProgram,
  detectSession,
  nativeResumeCommand,
  packageName,
  parseMirrorHook,
  runCli,
  startWireroom,
} from './index.js';
import { parseLine } from './up.js';

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

describe('@wireroom/cli', () => {
  it('registers the complete M1 command surface', () => {
    expect(packageName()).toBe('@wireroom/cli');
    expect(createProgram().commands.map((command) => command.name())).toEqual([
      'up',
      'rooms',
      'serve',
      'spawn',
      'post',
      'tail',
      'members',
      'join',
      'adopt',
      'mirror-hook',
      'attach',
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
    await cli('pair', '--endpoint', `http://127.0.0.1:${String(server.port)}`);
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
    await cli(
      'spawn',
      '-r',
      'eng',
      '--harness',
      'fake',
      '--as',
      'reviewer',
      '--cwd',
      '/work/review',
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
      '/work/planning',
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
    });
    expect(running.daemon.store.listRooms().map((room) => room.id)).toEqual(['default']);
    expect(running.daemon.registeredAdapters().map((adapter) => adapter.id)).toEqual([
      'claude-code',
      'codex',
      'copilot',
      'gemini',
      'opencode',
    ]);
    expect(running.server.socketPath).toBe(join(dir, 'up-data', 'wireroom.sock'));
    await running.close();
  });
});
