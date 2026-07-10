import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Daemon, FakeAdapter, startServer, type RunningServer } from '@wireroom/switchboard';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProgram, packageName, runCli, startWireroom } from './index.js';

let dir: string;
let daemon: Daemon;
let fake: FakeAdapter;
let server: RunningServer;
let output: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-cli-'));
  fake = new FakeAdapter();
  daemon = new Daemon({
    dbPath: join(dir, 'switchboard.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
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
