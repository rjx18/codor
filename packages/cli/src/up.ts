import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CryptoVault,
  Daemon,
  HyperswarmTransport,
  LedgerManager,
  PushProducer,
  PushSubscriptionStore,
  ResidencyCoordinator,
  loadAdapterRegistry,
  startServer,
  type AdapterModuleConfig,
  type LineConfig,
  type RunningServer,
} from '@codor/switchboard';

// harn:assume adapter-registry-sole-harness-source ref=registry-cli-composition
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
  pushVapidPublicKey?: string;
  adapters?: AdapterModuleConfig;
  adapterBaseDir?: string;
  line?: LineConfig;
  trustTailscaleServe?: boolean;
  bootstrap?: { host: string; port: number }[];
}

export interface RunningWireroom {
  daemon: Daemon;
  crypto: CryptoVault;
  server: RunningServer;
  dataDir: string;
  transport?: HyperswarmTransport;
  residency?: ResidencyCoordinator;
  close(): Promise<void>;
}

export interface OutpostOptions {
  dataDir?: string;
  line: LineConfig;
  bootstrap?: { host: string; port: number }[];
  adapters?: AdapterModuleConfig;
  adapterBaseDir?: string;
}

export interface RunningOutpost {
  crypto: CryptoVault;
  transport: HyperswarmTransport;
  residency: ResidencyCoordinator;
  dataDir: string;
  close(): Promise<void>;
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
  const adapters = await loadAdapterRegistry({
    adapters: options.adapters,
    baseDir: options.adapterBaseDir,
  });
  const dataDir = resolve(options.dataDir ?? join(homedir(), '.wireroom'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const crypto = new CryptoVault(dataDir);
  const transport = options.line ? new HyperswarmTransport({
    lines: [options.line],
    crypto,
    bootstrap: options.bootstrap,
  }) : undefined;
  const residency = transport ? new ResidencyCoordinator({
    transport,
    adapters,
    journalPath: join(dataDir, 'resident.sqlite'),
    blobRoot: join(dataDir, 'resident-blobs'),
  }) : undefined;
  const pushSubscriptions = new PushSubscriptionStore(dataDir, crypto.keys);
  const pushProducer = new PushProducer({
    relayUrl: options.relayUrl,
    identity: crypto.keys.identity,
    roomKeys: crypto.roomKeys,
    subscriptions: pushSubscriptions,
  });
  const ledger = new LedgerManager({ dataDir, transport });
  const daemon = new Daemon({
    dbPath: join(dataDir, 'switchboard.sqlite'),
    blobRoot: join(dataDir, 'blobs'),
    adapters,
    hostId: residency ? crypto.keys.identity.device_id : undefined,
    residency,
    ledger,
    pushProducer,
    onBackgroundError: (error) => console.error(`[wireroom] background task failed: ${error.message}`),
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
  const defaultStatic = resolve(process.cwd(), 'packages/web/dist');
  try {
    await transport?.start();
    await daemon.reconcile();
    const server = await startServer({
      daemon,
      token: options.token,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8137,
      socketPath: join(dataDir, 'wireroom.sock'),
      staticRoot: options.staticRoot ?? (existsSync(defaultStatic) ? defaultStatic : undefined),
      crypto,
      pushSubscriptions,
      pushVapidPublicKey: options.pushVapidPublicKey,
      pushRelayEnabled: pushProducer.enabled,
      trustTailscaleServe: options.trustTailscaleServe,
    });
    return {
      daemon,
      crypto,
      server,
      dataDir,
      transport,
      residency,
      close: async () => {
        await server.close();
        // harn:assume residency-closes-before-daemon-settlement ref=residency-first-shutdown
        await residency?.close();
        await daemon.close();
        await transport?.close();
        crypto.close();
        // harn:end residency-closes-before-daemon-settlement
      },
    };
  } catch (error) {
    await residency?.close();
    await daemon.close({ force: true });
    await transport?.close();
    crypto.close();
    throw error;
  }
}

export async function startOutpost(options: OutpostOptions): Promise<RunningOutpost> {
  const adapters = await loadAdapterRegistry({
    adapters: options.adapters,
    baseDir: options.adapterBaseDir,
  });
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
    adapters,
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
// harn:end adapter-registry-sole-harness-source

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
