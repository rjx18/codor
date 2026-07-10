import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ClaudeCodeAdapter } from '@wireroom/adapter-claude-code';
import { CodexAdapter } from '@wireroom/adapter-codex';
import { GeminiAdapter } from '@wireroom/adapter-gemini';
import { OpenCodeAdapter } from '@wireroom/adapter-opencode';
import { Daemon, startServer, type RunningServer } from '@wireroom/switchboard';

export interface UpOptions {
  dataDir?: string;
  token: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  room?: string;
  roomName?: string;
  owner?: string;
}

export interface RunningWireroom {
  daemon: Daemon;
  server: RunningServer;
  dataDir: string;
  close(): Promise<void>;
}

function ownerHandle(value: string | undefined): string {
  const normalized = (value ?? process.env.USER ?? 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
  if (normalized.length >= 2 && normalized !== 'all' && normalized !== 'switchboard') {
    return normalized;
  }
  return 'user';
}

export async function startWireroom(options: UpOptions): Promise<RunningWireroom> {
  if (!options.token.trim()) throw new Error('--token or WIREROOM_TOKEN is required');
  const dataDir = resolve(options.dataDir ?? join(homedir(), '.wireroom'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const daemon = new Daemon({
    dbPath: join(dataDir, 'switchboard.sqlite'),
    blobRoot: join(dataDir, 'blobs'),
    adapters: [
      new ClaudeCodeAdapter(),
      new CodexAdapter(),
      new GeminiAdapter(),
      new OpenCodeAdapter(),
    ],
  });
  if (daemon.store.listRooms().length === 0) {
    const room = options.room ?? 'default';
    const owner = ownerHandle(options.owner);
    daemon.createRoom({
      id: room,
      name: options.roomName ?? 'Default',
      owner: { handle: owner, display_name: owner },
    });
  }
  await daemon.reconcile();
  const defaultStatic = resolve(process.cwd(), 'packages/web/dist');
  try {
    const server = await startServer({
      daemon,
      token: options.token,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8137,
      socketPath: join(dataDir, 'wireroom.sock'),
      staticRoot: options.staticRoot ?? (existsSync(defaultStatic) ? defaultStatic : undefined),
    });
    return {
      daemon,
      server,
      dataDir,
      close: async () => {
        await server.close();
        await daemon.close();
      },
    };
  } catch (error) {
    await daemon.close({ force: true });
    throw error;
  }
}

export async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const stop = (): void => {
      if (closing) return;
      closing = true;
      void close().finally(resolveShutdown);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
