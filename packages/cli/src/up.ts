import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ClaudeCodeAdapter } from '@wireroom/adapter-claude-code';
import { CopilotAdapter } from '@wireroom/adapter-copilot';
import { CodexAdapter } from '@wireroom/adapter-codex';
import { GeminiAdapter } from '@wireroom/adapter-gemini';
import { OpenCodeAdapter } from '@wireroom/adapter-opencode';
import type { HarnessAdapter } from '@wireroom/protocol';
import {
  CryptoVault,
  Daemon,
  HyperswarmTransport,
  LedgerManager,
  PushProducer,
  PushSubscriptionStore,
  ResidencyCoordinator,
  startServer,
  type LineConfig,
  type RunningServer,
} from '@wireroom/switchboard';

export interface UpOptions {
  dataDir?: string;
  token: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  room?: string;
  roomName?: string;
  owner?: string;
  relayUrl?: string;
}

export interface RunningWireroom {
  daemon: Daemon;
  crypto: CryptoVault;
  server: RunningServer;
  dataDir: string;
  close(): Promise<void>;
}

export interface OutpostOptions {
  dataDir?: string;
  line: LineConfig;
  bootstrap?: { host: string; port: number }[];
}

export interface RunningOutpost {
  crypto: CryptoVault;
  transport: HyperswarmTransport;
  residency: ResidencyCoordinator;
  dataDir: string;
  close(): Promise<void>;
}

function configuredAdapters(): HarnessAdapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CopilotAdapter(),
    new CodexAdapter(),
    new GeminiAdapter(),
    new OpenCodeAdapter(),
  ];
}

export function parseLine(value: string): LineConfig {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) {
    throw new Error('--join must be name:secret');
  }
  return { name: value.slice(0, separator), secret: value.slice(separator + 1) };
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
  const crypto = new CryptoVault(dataDir);
  const pushSubscriptions = new PushSubscriptionStore(dataDir, crypto.keys);
  const pushProducer = new PushProducer({
    relayUrl: options.relayUrl,
    identity: crypto.keys.identity,
    roomKeys: crypto.roomKeys,
    subscriptions: pushSubscriptions,
  });
  const ledger = new LedgerManager({ dataDir });
  const daemon = new Daemon({
    dbPath: join(dataDir, 'switchboard.sqlite'),
    blobRoot: join(dataDir, 'blobs'),
    adapters: configuredAdapters(),
    ledger,
    pushProducer,
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
  for (const room of daemon.store.listRooms()) crypto.roomKeys.ensureRoom(room.id);
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
      crypto,
      pushSubscriptions,
    });
    return {
      daemon,
      crypto,
      server,
      dataDir,
      close: async () => {
        await server.close();
        await daemon.close();
        crypto.close();
      },
    };
  } catch (error) {
    await daemon.close({ force: true });
    crypto.close();
    throw error;
  }
}

export async function startOutpost(options: OutpostOptions): Promise<RunningOutpost> {
  const dataDir = resolve(options.dataDir ?? join(homedir(), '.wireroom'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const crypto = new CryptoVault(dataDir);
  const transport = new HyperswarmTransport({
    lines: [options.line],
    crypto,
    bootstrap: options.bootstrap,
  });
  const residency = new ResidencyCoordinator({
    transport,
    adapters: configuredAdapters(),
    journalPath: join(dataDir, 'resident.sqlite'),
    blobRoot: join(dataDir, 'resident-blobs'),
  });
  try {
    await transport.start();
    return {
      crypto,
      transport,
      residency,
      dataDir,
      close: async () => {
        await residency.close();
        await transport.close();
        crypto.close();
      },
    };
  } catch (error) {
    await residency.close();
    await transport.close();
    crypto.close();
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
