import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { BROWSER_PROTOCOL_EPOCH } from '@codor/protocol';

import {
  CryptoVault,
  Daemon,
  HyperswarmTransport,
  LedgerManager,
  PushProducer,
  PushSubscriptionStore,
  RelayLink,
  RelayPairingHost,
  RelayStore,
  ResidencyCoordinator,
  loadAdapterRegistry,
  localSocketPath,
  startServer,
  type AdapterModuleConfig,
  type LineConfig,
  type RunningServer,
} from '@codor/switchboard';

import { tryResolveRuntimePaths } from './runtime-paths.js';

// harn:assume adapter-registry-sole-harness-source ref=registry-cli-composition
export interface UpOptions {
  dataDir?: string;
  // harn:assume empty-database-desk-uses-service-home ref=bootstrap-service-home
  /** Injectable only so bootstrap tests can prove which service home is used. */
  homeDir?: string;
  // harn:end empty-database-desk-uses-service-home
  token: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  room?: string;
  roomName?: string;
  owner?: string;
  relayUrl?: string;
  /** Tunnel (blind) relay URL override — CODOR_TUNNEL_URL / --tunnel-url. */
  tunnelUrl?: string;
  pushVapidPublicKey?: string;
  adapters?: AdapterModuleConfig;
  adapterBaseDir?: string;
  line?: LineConfig;
  trustTailscaleServe?: boolean;
  voiceProvider?: string;
  bootstrap?: { host: string; port: number }[];
}

export interface RunningCodor {
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

// harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-tutorial-seed
const DESK_TUTORIAL_MESSAGE = 'Welcome to Codor 👋 This is your Desk. Add an agent from the Members panel, then send a message here to start working. Use @mentions when you want a specific helper, and create another channel when you want a separate project.';
// harn:end empty-database-desk-seeds-tutorial-atomically

export async function startCodor(options: UpOptions): Promise<RunningCodor> {
  if (!options.token.trim()) throw new Error('--token or CODOR_TOKEN is required');
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error('Codor foreground mode must bind to 127.0.0.1');
  }
  const adapters = await loadAdapterRegistry({
    adapters: options.adapters,
    baseDir: options.adapterBaseDir,
  });
  // harn:assume empty-database-desk-uses-service-home ref=bootstrap-service-home
  const homeDir = resolve(options.homeDir ?? homedir());
  const dataDir = resolve(options.dataDir ?? join(homeDir, '.codor'));
  // harn:end empty-database-desk-uses-service-home
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
  const relayStore = new RelayStore(dataDir);
  if (options.tunnelUrl) relayStore.setRelayUrl(options.tunnelUrl);
  let relayLink: RelayLink | undefined;
  const relayAdmin = {
    status: () => ({ enabled: relayStore.enabled, relay_url: relayStore.relayUrl, session_id: relayStore.sessionId, devices: relayStore.listDevices().length }),
    enable: (url?: string) => {
      relayStore.enable(url);
      relayLink?.restart();
    },
    disable: () => {
      relayStore.disable();
      relayLink?.restart();
    },
    rotate: () => {
      const id = relayStore.rotate();
      relayLink?.restart();
      return id;
    },
    pair: (endpoint?: string) => new RelayPairingHost({ store: relayStore, pairing: crypto.pairing, identity: crypto.keys.publicIdentity() }).pair(endpoint),
  };
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
    onBackgroundError: (error) => console.error(`[codor] background task failed: ${error.message}`),
  });
  if (daemon.store.listRooms().length === 0) {
    const room = options.room ?? 'default';
    const owner = ownerHandle(options.owner);
    // harn:assume empty-database-desk-uses-service-home ref=bootstrap-service-home
    // harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-tutorial-seed
    daemon.store.createRoom({
      id: room,
      name: options.roomName ?? 'Default',
      owner: { handle: owner, display_name: owner },
      config: { cwd: homeDir },
      bootstrapWelcome: {
        author: { handle: 'tutorial', display_name: 'Tutorial' },
        body: DESK_TUTORIAL_MESSAGE,
      },
    });
    // harn:end empty-database-desk-seeds-tutorial-atomically
    // harn:end empty-database-desk-uses-service-home
  }
  for (const room of daemon.store.listRooms()) crypto.roomKeys.ensureRoom(room.id);
  // harn:assume operator-launches-serve-web-next ref=cli-default-static-root
  const defaultStatic = tryResolveRuntimePaths()?.staticRoot
    ?? resolve(process.cwd(), 'packages/web-next/dist');
  // harn:end operator-launches-serve-web-next
  try {
    await transport?.start();
    await daemon.reconcile();
    // harn:assume browser-protocol-epoch-blocks-only-stale-browser-ui ref=production-browser-protocol-minimum
    const server = await startServer({
      daemon,
      token: options.token,
      host,
      port: options.port ?? 8137,
      socketPath: localSocketPath(dataDir),
      staticRoot: options.staticRoot ?? (existsSync(defaultStatic) ? defaultStatic : undefined),
      crypto,
      pushSubscriptions,
      pushVapidPublicKey: options.pushVapidPublicKey,
      pushRelayEnabled: pushProducer.enabled,
      trustTailscaleServe: options.trustTailscaleServe,
      minimumBrowserProtocol: BROWSER_PROTOCOL_EPOCH,
      relay: relayAdmin,
      // harn:assume voice-provider-selection-is-operator-config ref=voice-selection-up-option
      voiceProvider: options.voiceProvider,
      // harn:end voice-provider-selection-is-operator-config
    });
    // harn:end browser-protocol-epoch-blocks-only-stale-browser-ui
    relayLink = new RelayLink({
      store: relayStore,
      loopbackPort: server.port,
      isDeviceActive: (deviceId) => crypto.keys.getPeer(deviceId) !== undefined,
      onError: (error) => console.error(`[codor] relay link error: ${String(error)}`),
    });
    const stopRelayRevocation = crypto.keys.onPeerRevoked((deviceId) => {
      relayLink?.dropDevice(deviceId);
      relayStore.removeDevice(deviceId);
    });
    relayLink.start();
    return {
      daemon,
      crypto,
      server,
      dataDir,
      transport,
      residency,
      close: async () => {
        stopRelayRevocation();
        relayLink?.stop();
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
  const dataDir = resolve(options.dataDir ?? join(homedir(), '.codor'));
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
