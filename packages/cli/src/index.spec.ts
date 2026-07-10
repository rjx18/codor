import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Daemon, FakeAdapter, startServer, type RunningServer } from '@wireroom/switchboard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProgram,
  detectSession,
  packageName,
  parseMirrorHook,
  runCli,
  startWireroom,
} from './index.js';

let dir: string;
let daemon: Daemon;
let fake: FakeAdapter;
let codexFake: FakeAdapter;
let server: RunningServer;
let output: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-cli-'));
  fake = new FakeAdapter();
  codexFake = new FakeAdapter('codex');
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
  server = await startServer({
    daemon,
    token: 'cli-token',
    socketPath: join(dir, 'wireroom.sock'),
  });
  output = [];
});

afterEach(async () => {
  await server.close();
  await daemon.close();
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
      'spawn',
      'post',
      'tail',
      'members',
      'join',
      'adopt',
      'mirror-hook',
      'attach',
      'ledger',
    ]);
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
    expect(running.server.socketPath).toBe(join(dir, 'up-data', 'wireroom.sock'));
    await running.close();
  });
});
