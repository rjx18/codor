import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AcpProviderIdSchema,
  AgentPresetInputSchema,
  canonicalizeScheduleRequest,
  parseScheduleDirective,
  MemberStatusResponseSchema,
  MessageSchema,
  RunSearchHitSchema,
  type AttachLease,
  type AcpLaunchConfig,
  type Delivery,
  type Member,
  type Message,
  type Policy,
  type RunSearchHit,
  type Schedule,
  type ServerFrame,
  type ThinkingLevel,
} from '@codor/protocol';
import { Command, Option } from 'commander';
import {
  addRemoteLedgerNote,
  CryptoVault,
  HyperswarmTransport,
  LedgerVault,
  pairingUrl,
  type LedgerNoteType,
} from '@codor/switchboard';

import {
  nativeResumeCommand,
  superviseInteractiveAttach,
  type InteractiveCommandResolver,
  type InteractiveSpawner,
} from './attach.js';
import { ProtocolClient, type ProtocolClientOptions } from './connection.js';
import { detectSession } from './detect.js';
import {
  MANAGEMENT_EXIT_CODES,
  ManagementError,
  archiveManagedRoom,
  addManagedAgent,
  addManagedPresetAgent,
  classifyManagementError,
  confirmAgentRemove,
  confirmAgentPresetDelete,
  confirmArchive,
  createManagedRoom,
  createManagedAgentPreset,
  deleteManagedAgentPreset,
  getManagedDefaultRoster,
  listManagedAgentPresets,
  listManagedAgents,
  listManagedRooms,
  mutateManagedAgent,
  renameManagedRoom,
  renderAgent,
  renderAgentList,
  renderAgentPreset,
  renderAgentPresetList,
  renderDefaultRoster,
  renderDeletedPreset,
  renderChannel,
  renderChannelList,
  resolveManagedAgent,
  setManagedDefaultRoster,
  updateManagedAgentPreset,
} from './management.js';
import { parseMirrorHook } from './mirror.js';
import { operatorTokenPath, runSetup, type SetupAccess, type SetupOverrides } from './setup.js';
import { renderPairingCard } from './setup-ui.js';
import { renderTerminalQr } from './terminal-qr.js';
import { runCandidateUpdate, runOfficialUpdate, type UpdateOverrides } from './update.js';
import { parseLine, startOutpost, startCodor, waitForShutdown } from './up.js';
import {
  adoptWorktree,
  confirmWorktreeRemoval,
  createWorktree,
  escapeWorktreeHumanCell,
  listWorktrees,
  previewWorktreeRemoval,
  removeFilesystemWorktree,
  removeWorktree,
  renderWorktree,
  renderWorktreeList,
  resolveWorktreeSelector,
  type WorktreeRestClient,
} from './worktree-management.js';

export interface CliContext {
  stdout?(line: string): void;
  stderr?(line: string): void;
  env?: NodeJS.ProcessEnv;
  interactiveCommand?: InteractiveCommandResolver;
  spawnInteractive?: InteractiveSpawner;
  attachHeartbeatMs?: number;
  renderQr?(payload: string): string;
  setup?: SetupOverrides;
  /** Overrides the TTY probe that picks `codor pair`'s card vs plain output. */
  isTTY?: boolean;
  /** Test seam for the interactive channel archive confirmation. */
  confirm?(prompt: string): Promise<string | boolean>;
  /** Test seams for the packaged stable update journey. */
  update?: UpdateOverrides;
}

interface GlobalOptions {
  dataDir: string;
  url?: string;
  token?: string;
}

interface ChannelOptions {
  channel: string;
}

interface OptionalChannelOptions {
  channel?: string;
}

/**
 * Last-resort bearer source: the installed service's operator token file
 * (mode-0600, written by setup). Used only when neither --token nor a CODOR_*
 * env var supplies one — the common case for a systemd/launchd install where the
 * token lives in the service env, not the operator's interactive shell. Home is
 * taken from env so tests can point it at an isolated directory; a missing or
 * unreadable file falls through to today's tokenless behavior.
 */
function readOperatorTokenFile(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const path = operatorTokenPath(env.HOME ?? homedir());
    if (!existsSync(path)) return undefined;
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

// harn:assume adapter-registry-sole-harness-source ref=registry-cli-composition
function collectAdapter(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseAdapterModules(values: string[]): Record<string, string> {
  const adapters: [string, string][] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
      throw new Error('--adapter must be name=module');
    }
    const id = value.slice(0, separator).trim();
    const module = value.slice(separator + 1).trim();
    if (id === '' || module === '') throw new Error('--adapter must be name=module');
    if (ids.has(id)) throw new Error(`duplicate --adapter id '${id}'`);
    ids.add(id);
    adapters.push([id, module]);
  }
  return Object.fromEntries(adapters);
}

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-cli-format
/**
 * A continuation is deliberately kind=run WITHOUT a lifecycle summary — the
 * status, usage and cost belong to its root, not to it. Reading `message.run!`
 * for one would throw and take down every tail subscriber the moment the writer
 * starts emitting them, so identity comes from `run_parent_id` instead.
 *
 * It says only what is true of the row itself: its own permanent id, its
 * author, and which run it continues. No status, no totals, no synthesized id —
 * borrowing the root's would be a claim this row cannot make.
 */
const formatRunHeader = (message: Message, author: string): string => {
  if (message.run === undefined && message.run_parent_id !== undefined) {
    return `#${message.id} @${author} run continuation of #${message.run_parent_id}`;
  }
  const run = message.run!;
  const usage = run.usage;
  const tokens = usage ? usage.input_tokens + usage.output_tokens : undefined;
  return [
    `#${message.id}`,
    `@${author}`,
    'run',
    run.status,
    tokens === undefined ? undefined : `${tokens}tk`,
    usage?.cost_usd === undefined ? undefined : `$${usage.cost_usd.toFixed(2)}`,
  ].filter((part) => part !== undefined).join(' ');
};
// harn:end continuation-writer-follows-journaled-output-ownership

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const parsePositiveNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
};

const parsePositiveInteger = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
};

const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
};

const formatDuration = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) return '-';
  return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;
};

interface RoomSnapshot {
  self: string;
  members: Map<string, Member>;
  messages: Map<number, Message>;
  schedules: Map<string, Schedule>;
  deliveries: Map<string, Delivery>;
}

// harn:assume cli-waits-consume-only-matching-deliveries ref=collaboration-room-sync
async function syncRoom(client: ProtocolClient, room: string): Promise<RoomSnapshot> {
  let self: string | undefined;
  const members = new Map<string, Member>();
  const messages = new Map<number, Message>();
  const schedules = new Map<string, Schedule>();
  const deliveries = new Map<string, Delivery>();
  client.send({ type: 'subscribe', room, since_seq: 0 });
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'self') self = frame.member_id;
    else if (frame.type === 'member') members.set(frame.member.id, frame.member);
    else if (frame.type === 'message') messages.set(frame.message.id, frame.message);
    else if (frame.type === 'schedule') schedules.set(frame.schedule.id, frame.schedule);
    else if (frame.type === 'cancel_schedule_result') schedules.set(frame.schedule.id, frame.schedule);
    else if (frame.type === 'inbox') deliveries.set(frame.delivery.id, frame.delivery);
    else if (frame.type === 'sync_complete') {
      if (!self) throw new Error('channel subscription did not identify the caller');
      return { self, members, messages, schedules, deliveries };
    }
  }
}

const ownQueuedDeliveries = (snapshot: RoomSnapshot): Delivery[] =>
  [...snapshot.deliveries.values()]
    .filter((delivery) => delivery.recipient === snapshot.self && delivery.state === 'queued')
    .sort((left, right) => left.ts.localeCompare(right.ts));

async function consumeDelivery(
  client: ProtocolClient,
  room: string,
  delivery: Delivery,
): Promise<Message> {
  client.send({
    type: 'act',
    room,
    act: { act: 'consume_delivery', delivery_id: delivery.id },
  });
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'consume_result' && frame.delivery.id === delivery.id) return frame.message;
  }
}

async function setWait(
  client: ProtocolClient,
  room: string,
  self: string,
  reason: 'reply' | 'mention' | 'any',
  peers: string[],
  untilTs: string,
): Promise<void> {
  client.send({ type: 'act', room, act: { act: 'wait_begin', reason, peers, until_ts: untilTs } });
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'member' && frame.member.id === self && frame.member.waiting) return;
  }
}

async function clearWait(client: ProtocolClient, room: string, self: string): Promise<void> {
  client.send({ type: 'act', room, act: { act: 'wait_end' } });
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'member' && frame.member.id === self && !frame.member.waiting) return;
  }
}

// harn:assume same-round-terminal-peers-end-live-waits ref=collaboration-cli-wait-exit
function waitForOwnDelivery(
  client: ProtocolClient,
  room: string,
  initial: RoomSnapshot,
  deadline: number,
  matches: (message: Message) => boolean,
): Promise<{ kind: 'delivery'; delivery: Delivery; message: Message } | undefined>;
function waitForOwnDelivery(
  client: ProtocolClient,
  room: string,
  initial: RoomSnapshot,
  deadline: number,
  matches: (message: Message) => boolean,
  peerFinishedSelf: string,
): Promise<
  | { kind: 'delivery'; delivery: Delivery; message: Message }
  | { kind: 'peer_finished' }
  | undefined
>;
async function waitForOwnDelivery(
  client: ProtocolClient,
  room: string,
  initial: RoomSnapshot,
  deadline: number,
  matches: (message: Message) => boolean,
  peerFinishedSelf?: string,
): Promise<
  | { kind: 'delivery'; delivery: Delivery; message: Message }
  | { kind: 'peer_finished' }
  | undefined
> {
  let snapshot = initial;
  const find = (): { kind: 'delivery'; delivery: Delivery; message: Message } | undefined => {
    for (const delivery of ownQueuedDeliveries(snapshot)) {
      const message = snapshot.messages.get(delivery.message_id);
      if (message && matches(message)) return { kind: 'delivery', delivery, message };
    }
    return undefined;
  };
  for (;;) {
    const existing = find();
    if (existing) return existing;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    let frame: ServerFrame;
    try {
      frame = await client.next(remaining);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out waiting for server frame')) {
        return undefined;
      }
      throw error;
    }
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'message') {
      snapshot.messages.set(frame.message.id, frame.message);
      if (matches(frame.message)) snapshot = await syncRoom(client, room);
    } else if (frame.type === 'inbox') {
      snapshot.deliveries.set(frame.delivery.id, frame.delivery);
    } else if (frame.type === 'member') {
      snapshot.members.set(frame.member.id, frame.member);
      if (frame.member.id === peerFinishedSelf && frame.member.waiting === undefined) {
        return { kind: 'peer_finished' };
      }
    }
  }
}
// harn:end same-round-terminal-peers-end-live-waits
// harn:end cli-waits-consume-only-matching-deliveries

// harn:assume cli-hook-inbox-is-silent-when-empty ref=hook-inbox-renderer
const formatInboxMessage = (message: Message, author: string): string =>
  `#${message.id} from @${author}\n${message.body}`;

function renderHookInbox(messages: { message: Message; author: string }[]): string | undefined {
  if (messages.length === 0) return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Codor inbox:\n${messages
        .map(({ message, author }) => formatInboxMessage(message, author))
        .join('\n\n')}`,
    },
  });
}
// harn:end cli-hook-inbox-is-silent-when-empty

export function createProgram(context: CliContext = {}): Command {
  const env = context.env ?? process.env;
  const out = context.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = context.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const program = new Command();
  // harn:assume human-facing-surfaces-call-rooms-channels ref=cli-channel-terminology
  // harn:assume codor-runtime-identity-is-a-clean-break ref=cli-runtime-identity
  program
    .name('codor')
    .description('Operate local-first multi-agent channels')
    .option('--data-dir <path>', 'switchboard data directory', env.CODOR_DATA_DIR ?? join(homedir(), '.codor'))
    .option('--url <url>', 'remote switchboard URL');
  // harn:assume cli-help-never-renders-selected-bearer ref=redacted-token-option-default
  program.addOption(
    new Option('--token <token>', 'remote bearer token')
      .default(env.CODOR_MEMBER_TOKEN ?? env.CODOR_TOKEN, '<redacted>'),
  );
  // harn:end cli-help-never-renders-selected-bearer
  // harn:end codor-runtime-identity-is-a-clean-break

  const connectionOptions = (): ProtocolClientOptions => {
    const options = program.opts<GlobalOptions>();
    // harn:assume member-env-selects-narrow-cli-identity ref=member-connection-options
    return {
      dataDir: options.dataDir,
      remoteUrl: options.url,
      socketPath: options.url === undefined ? env.CODOR_SOCKET : undefined,
      token: options.token,
    };
    // harn:end member-env-selects-narrow-cli-identity
  };

  const withClient = async <T>(fn: (client: ProtocolClient) => Promise<T>): Promise<T> => {
    const client = await ProtocolClient.connect(connectionOptions());
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  };

  const withManagementClient = async <T>(fn: (client: ProtocolClient) => Promise<T>): Promise<T> => {
    try {
      return await withClient(fn);
    } catch (error) {
      throw classifyManagementError(error);
    }
  };

  const channel = (options: OptionalChannelOptions): string => {
    const room = options.channel ?? env.CODOR_CHANNEL;
    if (!room) throw new Error('--channel or CODOR_CHANNEL is required');
    return room;
  };

  // The installed operator token file is a LOCAL-service credential: fall back to
  // it ONLY when the target is the local daemon, never when an explicit remote
  // --url (or CODOR_URL) is set — so the installed bearer can never ride to an
  // arbitrary origin.
  const targetsLocalService = (): boolean => {
    const raw = program.opts<GlobalOptions>().url ?? env.CODOR_URL;
    if (!raw) return true; // default endpoint is loopback
    try {
      // WHATWG URL keeps IPv6 brackets on hostname ([::1]); strip them so the
      // bracketed loopback form is recognized as local, not silently "remote".
      const host = new URL(raw.replace(/^ws/, 'http')).hostname.replace(/^\[|\]$/g, '');
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
      return false;
    }
  };
  const bearer = (): string | undefined =>
    program.opts<GlobalOptions>().token
    ?? (targetsLocalService() ? readOperatorTokenFile(env) : undefined);

  // harn:assume cli-observability-uses-scoped-rest ref=scoped-rest-client
  const restUrl = (path: string): URL => {
    const globals = program.opts<GlobalOptions>();
    const raw = globals.url ?? env.CODOR_URL ?? 'http://127.0.0.1:8137';
    const base = new URL(raw);
    if (base.protocol === 'ws:') base.protocol = 'http:';
    else if (base.protocol === 'wss:') base.protocol = 'https:';
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error('--url must use http(s) or ws(s)');
    }
    return new URL(path, `${base.origin}/`);
  };

  const fetchJson = async (url: URL): Promise<unknown> => {
    const token = bearer();
    if (!token) throw new Error('--token, CODOR_TOKEN, or CODOR_MEMBER_TOKEN is required');
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const value = await response.json() as unknown;
    if (!response.ok) {
      const detail = typeof value === 'object' && value !== null && 'error' in value
        ? String(value.error)
        : `${response.status} ${response.statusText}`;
      throw new Error(detail);
    }
    return value;
  };
  // harn:end cli-observability-uses-scoped-rest

  const postJson = async (path: string, body?: unknown): Promise<unknown> => {
    const token = bearer();
    if (!token) throw new Error('--token, CODOR_TOKEN, or CODOR_MEMBER_TOKEN is required');
    const response = await fetch(restUrl(path), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      const detail =
        typeof value === 'object' && value !== null && 'error' in value
          ? String((value as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
      throw new Error(detail);
    }
    return value;
  };

  const worktreeRestClient: WorktreeRestClient = {
    get: (path) => fetchJson(restUrl(path)),
    post: (path, body) => postJson(path, body),
  };

  const withCrypto = <T>(fn: (crypto: CryptoVault) => T): T => {
    const crypto = new CryptoVault(program.opts<GlobalOptions>().dataDir);
    try {
      return fn(crypto);
    } finally {
      crypto.close();
    }
  };

  program
    .command('up')
    .description('start the switchboard in the foreground')
    .option('--host <host>', 'HTTP bind host', '127.0.0.1')
    .option('--port <port>', 'HTTP bind port', (value) => Number(value), 8137)
    .option('--static-root <path>', 'built web client directory')
    .option('--channel <id>', 'initial channel id', 'default')
    .option('--channel-name <name>', 'initial channel name', 'Default')
    .option('--owner <handle>', 'initial owner handle')
    .option('--relay-url <url>', 'optional sealed push relay URL', env.CODOR_RELAY_URL)
    .addOption(new Option('--tunnel-url <url>', 'tunnel (blind) relay URL override').default(env.CODOR_TUNNEL_URL).hideHelp())
    .option('--push-vapid-public-key <key>', 'Web Push VAPID public key', env.CODOR_VAPID_PUBLIC_KEY)
    .option('--join <line>', 'join a private home/outpost line as name:secret')
    // harn:assume tailnet-auto-pairing-explicit-trust ref=trusted-tailnet-up-option
    .option(
      '--trust-tailscale-serve',
      'trust Tailscale Serve identity headers for browser enrollment',
      env.CODOR_TRUST_TAILSCALE_SERVE === '1',
    )
    // harn:end tailnet-auto-pairing-explicit-trust
    .option('--adapter <name=module>', 'trusted adapter module (repeatable)', collectAdapter, [])
    // harn:assume voice-provider-selection-is-operator-config ref=voice-selection-cli-option
    .option('--voice-provider <id>', 'web dictation provider (none disables)', 'codex')
    // harn:end voice-provider-selection-is-operator-config
    .action(async (options: {
      host: string;
      port: number;
      staticRoot?: string;
      channel: string;
      channelName: string;
      owner?: string;
      relayUrl?: string;
      tunnelUrl?: string;
      pushVapidPublicKey?: string;
      join?: string;
      trustTailscaleServe: boolean;
      adapter: string[];
      voiceProvider: string;
    }) => {
      const globals = program.opts<GlobalOptions>();
      const running = await startCodor({
        dataDir: globals.dataDir,
        token: globals.token ?? '',
        host: options.host,
        port: options.port,
        staticRoot: options.staticRoot,
        room: options.channel,
        roomName: options.channelName,
        owner: options.owner,
        relayUrl: options.relayUrl,
        tunnelUrl: options.tunnelUrl,
        pushVapidPublicKey: options.pushVapidPublicKey,
        line: options.join ? parseLine(options.join) : undefined,
        trustTailscaleServe: options.trustTailscaleServe,
        adapters: parseAdapterModules(options.adapter),
        voiceProvider: options.voiceProvider,
      });
      out(`codor http://localhost:${running.server.port}`);
      out(`socket ${running.server.socketPath}`);
      await waitForShutdown(running.close);
    });

  const channelManagement = program
    .command('channels')
    .alias('channel')
    .description('list active channels')
    .action(async () => {
      await withClient(async (client) => {
        client.send({ type: 'list_rooms' });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type !== 'rooms') continue;
          for (const room of frame.rooms) out(`${room.id}\t${room.name}`);
          return;
        }
      });
    });

  // harn:assume structured-channel-cli-preserves-flat-listing ref=structured-channel-command-surface
  // harn:assume human-facing-surfaces-call-rooms-channels ref=cli-channel-terminology
  channelManagement
    .command('list')
    .description('list active channels')
    .option('--all', 'include archived channels')
    .option('--json', 'emit one JSON value')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      await withManagementClient(async (client) => {
        const rooms = await listManagedRooms(client, { all: options.all === true });
        const rendered = renderChannelList(rooms, options.json === true);
        if (rendered !== '') out(rendered);
      });
    });

  // harn:assume channel-cli-selects-one-initial-agent-mode ref=channel-create-initial-agent-options
  channelManagement
    .command('create')
    .description('create a channel')
    .argument('<name>', 'channel name')
    .requiredOption('--owner <handle>', 'owner handle')
    .option('--owner-name <display-name>', 'owner display name')
    .option('--id <id>', 'explicit channel id')
    .option('--color <color>', 'channel accent color')
    .option('--cwd <path>', 'channel working directory')
    .option('--default-roster', 'start the channel with the configured default roster')
    .option('--starting-agent <handle>', 'start one manually selected agent')
    .option('--adapter <selector>', 'starting-agent public adapter selector')
    .option('--starting-name <display-name>', 'starting agent display name')
    .option('--starting-policy <policy>', 'starting agent permission policy')
    .option('--starting-model <model>', 'starting agent model override')
    .option('--starting-thinking <level>', 'starting agent thinking level')
    .option('--starting-acp-executable <command>', 'custom ACP executable for the starting agent')
    .option('--starting-acp-arg <arg>', 'literal custom ACP argument (repeatable)', collectString, [])
    .option('--json', 'emit one JSON value')
    .action(async (name: string, options: {
      owner: string;
      ownerName?: string;
      id?: string;
      color?: string;
      cwd?: string;
      defaultRoster?: boolean;
      startingAgent?: string;
      adapter?: string;
      startingName?: string;
      startingPolicy?: Policy;
      startingModel?: string;
      startingThinking?: ThinkingLevel;
      startingAcpExecutable?: string;
      startingAcpArg: string[];
      json?: boolean;
    }) => {
      if (name.length === 0 || options.owner.length === 0) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'channel name and owner are required');
      }
      const startingFlags = options.startingAgent !== undefined
        || options.adapter !== undefined
        || options.startingName !== undefined
        || options.startingPolicy !== undefined
        || options.startingModel !== undefined
        || options.startingThinking !== undefined
        || options.startingAcpExecutable !== undefined
        || options.startingAcpArg.length > 0;
      if (options.defaultRoster === true && startingFlags) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          '--default-roster cannot be combined with starting-agent options',
        );
      }
      if (options.startingAgent === undefined && startingFlags) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          'starting-agent options require --starting-agent',
        );
      }
      if (options.startingAgent !== undefined && options.adapter === undefined) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          '--starting-agent requires --adapter',
        );
      }
      const startingAgent = options.startingAgent === undefined
        ? undefined
        : (() => {
            const selector = parsePublicSelector(options.adapter!, {
              model: options.startingModel,
              modelLabel: 'starting agent',
              acpExecutable: options.startingAcpExecutable,
              acpArg: options.startingAcpArg,
            });
            return {
              harness: selector.harness,
              handle: options.startingAgent!.replace(/^@/, ''),
              ...(options.startingName !== undefined && { display_name: options.startingName }),
              ...(selector.model !== undefined && { model: selector.model }),
              ...(options.startingThinking !== undefined && { thinking: options.startingThinking }),
              policy: options.startingPolicy ?? 'read-only',
              ...(selector.acp_provider !== undefined && { acp_provider: selector.acp_provider }),
              ...(selector.acp_launch !== undefined && { acp_launch: selector.acp_launch }),
            };
          })();
      await withManagementClient(async (client) => {
        const room = await createManagedRoom(client, {
          ...(options.id !== undefined && { id: options.id }),
          name,
          owner: {
            handle: options.owner,
            display_name: options.ownerName ?? options.owner,
          },
          ...(options.color !== undefined && { color: options.color }),
          ...(options.cwd !== undefined && { cwd: options.cwd }),
          ...(options.defaultRoster === true && { default_roster: true as const }),
          ...(startingAgent !== undefined && { starting_agent: startingAgent }),
        });
        const rendered = renderChannel(room, options.json === true);
        out(rendered);
      });
    });
  // harn:end channel-cli-selects-one-initial-agent-mode

  channelManagement
    .command('show')
    .description('show a channel')
    .argument('<channel>', 'channel id')
    .option('--json', 'emit one JSON value')
    .action(async (channelId: string, options: { json?: boolean }) => {
      await withManagementClient(async (client) => {
        const rooms = await listManagedRooms(client, { all: true });
        const room = rooms.find((candidate) => candidate.id === channelId);
        if (room === undefined) {
          throw new ManagementError(MANAGEMENT_EXIT_CODES.notFound, `no such channel ${channelId}`);
        }
        out(renderChannel(room, options.json === true));
      });
    });

  channelManagement
    .command('rename')
    .description('rename an active channel')
    .argument('<channel>', 'channel id')
    .argument('<name>', 'new channel name')
    .option('--json', 'emit one JSON value')
    .action(async (channelId: string, name: string, options: { json?: boolean }) => {
      if (name.length === 0) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'channel name is required');
      }
      await withManagementClient(async (client) => {
        const room = await renameManagedRoom(client, channelId, name);
        out(renderChannel(room, options.json === true));
      });
    });

  // harn:assume channel-archive-requires-explicit-confirmation ref=channel-archive-command-confirmation
  channelManagement
    .command('archive')
    .description('soft-archive a channel')
    .argument('<channel>', 'channel id')
    .option('--yes', 'confirm archive without prompting')
    .option('--json', 'emit one JSON value')
    .action(async (channelId: string, options: { yes?: boolean; json?: boolean }) => {
      const isTTY = context.isTTY ?? Boolean(process.stdin.isTTY);
      await withManagementClient(async (client) => {
        const rooms = await listManagedRooms(client, { all: true });
        const room = rooms.find((candidate) => candidate.id === channelId);
        if (room === undefined) {
          throw new ManagementError(MANAGEMENT_EXIT_CODES.notFound, `no such channel ${channelId}`);
        }
        if (room.config.archived_ts !== undefined) {
          throw new ManagementError(MANAGEMENT_EXIT_CODES.conflict, `channel ${channelId} is already archived`);
        }
        await confirmArchive({
          label: channelId,
          yes: options.yes === true,
          json: options.json === true,
          isTTY,
          stderr: err,
          confirm: context.confirm,
        });
        const archived = await archiveManagedRoom(client, channelId);
        out(renderChannel(archived, options.json === true));
      });
    });
  // harn:end channel-archive-requires-explicit-confirmation
  // harn:end human-facing-surfaces-call-rooms-channels
  // harn:end structured-channel-cli-preserves-flat-listing

  program
    .command('serve')
    .description('host resident members for a remote channel home')
    .requiredOption('--join <line>', 'line name and secret as name:secret')
    .option('--adapter <name=module>', 'trusted adapter module (repeatable)', collectAdapter, [])
    .action(async (options: { join: string; adapter: string[] }) => {
      const running = await startOutpost({
        dataDir: program.opts<GlobalOptions>().dataDir,
        line: parseLine(options.join),
        adapters: parseAdapterModules(options.adapter),
      });
      out(`codor outpost ${running.crypto.keys.identity.device_id}`);
      await waitForShutdown(running.close);
    });
  // harn:end adapter-registry-sole-harness-source
function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface PublicSelectorOptions {
  model?: string;
  acpExecutable?: string;
  acpArg?: string[];
  modelLabel?: string;
}

/** Convert the CLI's public selector spelling into the existing protocol input. */
function parsePublicSelector(selector: string, options: PublicSelectorOptions = {}): {
  harness: string;
  acp_provider?: string;
  acp_launch?: AcpLaunchConfig;
  model?: string;
} {
  const normalized = selector.trim();
  if (normalized === '') {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'adapter selector is required');
  }
  const hasExecutable = options.acpExecutable !== undefined;
  const args = options.acpArg ?? [];
  const hasCustomFlags = hasExecutable || args.length > 0;
  if (normalized === 'acp') {
    if (options.model !== undefined) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.invocation,
        `${options.modelLabel ?? 'ACP'} does not accept --model`,
      );
    }
    if (!hasExecutable) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.invocation,
        'generic acp requires --acp-executable',
      );
    }
    return { harness: 'acp', acp_launch: { executable: options.acpExecutable!, argv: args } };
  }
  if (normalized.startsWith('acp:')) {
    const provider = normalized.slice('acp:'.length);
    if (!AcpProviderIdSchema.safeParse(provider).success) {
      throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'invalid ACP provider selector');
    }
    if (hasCustomFlags) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.invocation,
        'named ACP selectors cannot use custom launch flags',
      );
    }
    if (options.model !== undefined) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.invocation,
        `${options.modelLabel ?? 'ACP'} does not accept --model`,
      );
    }
    return { harness: 'acp', acp_provider: provider };
  }
  if (hasCustomFlags) {
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      'custom launch flags require the generic acp selector',
    );
  }
  return { harness: normalized, ...(options.model !== undefined && { model: options.model }) };
}

interface PresetConfigurationOptions {
  label: string;
  handle: string;
  adapter: string;
  name?: string;
  model?: string;
  thinking?: ThinkingLevel;
  policy?: Policy;
  acpExecutable?: string;
  acpArg?: string[];
}

function parseAgentPresetInput(options: PresetConfigurationOptions) {
  const selector = parsePublicSelector(options.adapter, {
    model: options.model,
    modelLabel: 'agent preset',
    acpExecutable: options.acpExecutable,
    acpArg: options.acpArg,
  });
  try {
    return AgentPresetInputSchema.parse({
      label: options.label,
      handle: options.handle.replace(/^@/, ''),
      ...(options.name !== undefined && { display_name: options.name }),
      harness: selector.harness,
      ...(selector.acp_provider !== undefined && { acp_provider: selector.acp_provider }),
      ...(selector.acp_launch !== undefined && { acp_launch: selector.acp_launch }),
      ...(selector.model !== undefined && { model: selector.model }),
      ...(options.thinking !== undefined && { thinking: options.thinking }),
      ...(options.policy !== undefined && { policy: options.policy }),
    });
  } catch (error) {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'invalid agent preset configuration', { cause: error });
  }
}

// harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-command-surface
const agentPresetManagement = program.command('agent-preset').description('manage reusable agent presets');
agentPresetManagement
  .command('list')
  .description('list agent presets')
  .option('--json', 'emit one JSON value')
  .action(async (options: { json?: boolean }) => {
    await withManagementClient(async (client) => {
      const presets = await listManagedAgentPresets(client);
      const rendered = renderAgentPresetList(presets, options.json === true);
      if (rendered !== '') out(rendered);
    });
  });

const addPresetOptions = (command: Command): void => {
  command
    .requiredOption('--handle <handle>', 'preset member handle')
    .requiredOption('--adapter <selector>', 'public adapter selector')
    .option('--name <display-name>', 'preset display name')
    .option('--model <model>', 'preset model override')
    .option('--thinking <level>', 'preset thinking level')
    .option('--policy <policy>', 'read-only, workspace-write, or full-access')
    .option('--acp-executable <command>', 'custom ACP executable')
    .option('--acp-arg <arg>', 'literal custom ACP argument (repeatable)', collectString, [])
    .option('--json', 'emit one JSON value');
};

const createPreset = agentPresetManagement
  .command('create')
  .description('create an agent preset')
  .argument('<label>', 'preset label');
addPresetOptions(createPreset);
createPreset.action(async (label: string, options: {
  handle: string;
  adapter: string;
  name?: string;
  model?: string;
  thinking?: ThinkingLevel;
  policy?: Policy;
  acpExecutable?: string;
  acpArg: string[];
  json?: boolean;
}) => {
  const input = parseAgentPresetInput({ ...options, label });
  await withManagementClient(async (client) => {
    const preset = await createManagedAgentPreset(client, input);
    out(renderAgentPreset(preset, options.json === true));
  });
});

const updatePreset = agentPresetManagement
  .command('update')
  .description('replace an agent preset')
  .argument('<preset-id>', 'exact preset id')
  .requiredOption('--label <label>', 'replacement preset label');
addPresetOptions(updatePreset);
updatePreset.action(async (presetId: string, options: {
  label: string;
  handle: string;
  adapter: string;
  name?: string;
  model?: string;
  thinking?: ThinkingLevel;
  policy?: Policy;
  acpExecutable?: string;
  acpArg: string[];
  json?: boolean;
}) => {
  const input = parseAgentPresetInput({ ...options, label: options.label });
  await withManagementClient(async (client) => {
    const preset = await updateManagedAgentPreset(client, presetId, input);
    out(renderAgentPreset(preset, options.json === true));
  });
});

agentPresetManagement
  .command('delete')
  .description('delete an agent preset')
  .argument('<preset-id>', 'exact preset id')
  .option('--yes', 'confirm deletion without prompting')
  .option('--json', 'emit one JSON value')
  .action(async (presetId: string, options: { yes?: boolean; json?: boolean }) => {
    const isTTY = context.isTTY ?? Boolean(process.stdin.isTTY);
    await withManagementClient(async (client) => {
      const presets = await listManagedAgentPresets(client);
      const preset = presets.find((candidate) => candidate.id === presetId);
      if (preset === undefined) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.notFound, `no such agent preset ${presetId}`);
      }
      await confirmAgentPresetDelete({
        label: `${preset.label} (${preset.id})`,
        yes: options.yes === true,
        json: options.json === true,
        isTTY,
        stderr: err,
        confirm: context.confirm,
      });
      const deleted = await deleteManagedAgentPreset(client, preset.id);
      out(renderDeletedPreset(deleted, options.json === true));
    });
  });

const defaultRosterManagement = program.command('default-roster').description('manage the default agent roster');
defaultRosterManagement
  .command('show')
  .description('show the ordered default roster')
  .option('--json', 'emit one JSON value')
  .action(async (options: { json?: boolean }) => {
    await withManagementClient(async (client) => {
      const roster = await getManagedDefaultRoster(client);
      const rendered = renderDefaultRoster(roster, options.json === true);
      if (rendered !== '') out(rendered);
    });
  });
defaultRosterManagement
  .command('set')
  .description('replace the ordered default roster')
  .argument('[preset-id...]', 'preset ids in creation order')
  .option('--json', 'emit one JSON value')
  .action(async (presetIds: string[], options: { json?: boolean }) => {
    await withManagementClient(async (client) => {
      const roster = await setManagedDefaultRoster(client, presetIds ?? []);
      out(renderDefaultRoster(roster, options.json === true));
    });
  });
// harn:end structured-preset-and-roster-cli-is-safe-and-ordered

  // harn:assume setup-unattended-mutation-requires-explicit-intent ref=setup-command-surface
  // harn:assume public-install-is-the-primary-command-with-setup-alias ref=install-command-alias
  program
    .command('install')
    .alias('setup')
    .description('install and start the local switchboard service, then pair your first browser')
    .option('--dry-run', 'print every action and generated service content without changing the host')
    .option('--yes', 'approve every setup mutation for unattended use')
    .option('--no-relay', 'keep the blind relay off; mint a local-only first code (works on your network only)')
    .addOption(new Option('--access <method>', 'browser access method').choices(['localhost', 'tailscale']))
    .action(async (options: { access?: SetupAccess; dryRun?: boolean; yes?: boolean; relay?: boolean }) => {
      await runSetup({
        access: options.access,
        dryRun: options.dryRun === true,
        env,
        // Commander maps --no-relay to `relay === false`; default (flag absent) is undefined → relay on.
        noRelay: options.relay === false,
        out,
        overrides: {
          ...context.setup,
          renderQr: context.renderQr ?? context.setup?.renderQr,
        },
        yes: options.yes === true,
      });
    });
  // harn:end public-install-is-the-primary-command-with-setup-alias
  // harn:end setup-unattended-mutation-requires-explicit-intent

  // harn:assume official-codor-update-is-cooperatively-bounded-and-platform-truthful ref=stable-update-command
  program
    .command('update')
    .description('Update the durable Codor runtime to the current official stable release')
    .action(async () => {
      await runOfficialUpdate({
        dataDir: program.opts<GlobalOptions>().dataDir,
        env,
        out,
        overrides: context.update,
      });
    });

  program
    .command('__apply-update', { hidden: true })
    .requiredOption('--expected-version <version>')
    .requiredOption('--timeout-ms <milliseconds>')
    .action(async (options: { expectedVersion: string; timeoutMs: string }) => {
      const timeoutMs = Number(options.timeoutMs);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('private update timeout must be a positive integer number of milliseconds');
      }
      await runCandidateUpdate({
        dataDir: program.opts<GlobalOptions>().dataDir,
        expectedVersion: options.expectedVersion,
        timeoutMs,
        env,
        out,
        overrides: context.update,
      });
    });
  // harn:end official-codor-update-is-cooperatively-bounded-and-platform-truthful

  program
    .command('spawn')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .requiredOption('--harness <harness>', 'registered adapter id')
    .requiredOption('--as <handle>', 'member handle')
    .requiredOption('--cwd <path>', 'working directory')
    .option('--policy <policy>', 'sandbox or permission policy')
    .option('--model <model>', 'model override')
    .action(async (options: ChannelOptions & { harness: string; as: string; cwd: string; policy?: string; model?: string }) => {
      await withClient(async (client) => {
        const existing = new Set<string>();
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'member') existing.add(frame.member.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({
          type: 'act',
          room: options.channel,
          act: {
            act: 'spawn',
            harness: options.harness,
            handle: options.as,
            cwd: options.cwd,
            policy: options.policy,
            model: options.model,
          },
        });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'member' && !existing.has(frame.member.id) && frame.member.handle === options.as) {
            out(`spawned @${frame.member.handle} ${frame.member.id}`);
            return;
          }
        }
      });
    });

  program
    .command('post')
    .option('-r, --channel <channel>', 'channel id; defaults to CODOR_CHANNEL')
    .option('--wait', 'wait for the first direct reply from an addressed member')
    .option('--timeout <seconds>', 'wait timeout in seconds', (value) => parsePositiveNumber(value, '--timeout'), 300)
    .argument('<message>')
    // harn:assume cli-waits-consume-only-matching-deliveries ref=post-wait-command
    .action(async (message: string, options: OptionalChannelOptions & { wait?: boolean; timeout: number }) => {
      await withClient(async (client) => {
        const room = channel(options);
        const initial = await syncRoom(client, room);
        const lastMessageId = Math.max(0, ...initial.messages.keys());
        const knownScheduleIds = new Set(initial.schedules.keys());
        const wireBody = canonicalizeScheduleRequest(message);
        let scheduled: ReturnType<typeof parseScheduleDirective>;
        try {
          scheduled = parseScheduleDirective(wireBody);
        } catch {
          scheduled = undefined;
        }
        if (scheduled !== undefined && options.wait) {
          throw new Error('post --wait is not supported for scheduled messages');
        }
        client.send({
          type: 'post',
          room,
          body: wireBody,
          ...(options.wait && { awaiting_reply: true }),
        });
        // harn:assume cli-post-acknowledges-messages-or-schedules ref=cli-scheduled-post-regression
        let posted: Message | undefined;
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'schedule'
            && !knownScheduleIds.has(frame.schedule.id)
            && (frame.schedule.origin_room === room || frame.schedule.room === room)
            && frame.schedule.author_id === initial.self
            && scheduled !== undefined
            && frame.schedule.body === scheduled.clean_body) {
            out(`scheduled ${frame.schedule.id} due ${frame.schedule.due_ts}`);
            return;
          }
          if (
            frame.type === 'message' &&
            (frame.message.room !== room || frame.message.id > lastMessageId) &&
            frame.message.author === initial.self &&
            frame.message.body === wireBody
          ) {
            posted = frame.message;
            break;
          }
        }
        if (posted === undefined) throw new Error('post acknowledgement disappeared');
        out(`posted #${posted.id}`);
        if (!options.wait) return;
        if (!env.CODOR_MEMBER_TOKEN) throw new Error('post --wait requires CODOR_MEMBER_TOKEN');
        // harn:assume qualified-cli-wait-preserves-scoped-peer-identity ref=qualified-post-wait
        const peers = [...new Set(posted.mentions.map((mention) => mention.member_id))]
          .filter((id) => id !== initial.self);
        if (peers.length === 0) throw new Error('post --wait requires at least one addressed member');
        // harn:end qualified-cli-wait-preserves-scoped-peer-identity
        const deadline = Date.now() + options.timeout * 1_000;
        const replyAfterId = posted.room === room ? posted.id : lastMessageId;
        let registered = false;
        try {
          const qualified = posted.room !== room;
          if (!qualified) {
            await setWait(client, room, initial.self, 'reply', peers, new Date(deadline).toISOString());
            registered = true;
          }
          const snapshot = await syncRoom(client, room);
          const matches = (candidate: Message): boolean =>
            candidate.id > replyAfterId &&
            peers.includes(candidate.author) &&
            candidate.mentions.some((mention) => mention.member_id === initial.self);
          const reply = qualified
            ? await waitForOwnDelivery(client, room, snapshot, deadline, matches)
            : await waitForOwnDelivery(client, room, snapshot, deadline, matches, initial.self);
          if (!reply) {
            out(`TIMEOUT after ${String(options.timeout)}s`);
            return;
          }
          if (reply.kind === 'peer_finished') {
            registered = false;
            out('peer finished; no direct reply');
            return;
          }
          const consumed = await consumeDelivery(client, room, reply.delivery);
          out(consumed.body);
        } finally {
          if (registered) await clearWait(client, room, initial.self);
        }
      });
    });
    // harn:end cli-post-acknowledges-messages-or-schedules
  // harn:end cli-waits-consume-only-matching-deliveries

  program
    .command('tail')
    .option('-r, --channel <channel>', 'channel id; defaults to CODOR_CHANNEL')
    .option('--once', 'print current history and exit')
    .option('--follow', 'follow new channel messages')
    .option('--until-mention <handle>', 'stop after consuming an own delivery directly mentioning handle')
    .option('--until-any', 'stop after consuming any queued own delivery')
    .option('--timeout <seconds>', 'until timeout in seconds', (value) => parsePositiveNumber(value, '--timeout'), 300)
    // harn:assume cli-waits-consume-only-matching-deliveries ref=tail-wait-command
    .action(async (options: OptionalChannelOptions & {
      once?: boolean;
      follow?: boolean;
      untilMention?: string;
      untilAny?: boolean;
      timeout: number;
    }) => {
      await withClient(async (client) => {
        const room = channel(options);
        const members = new Map<string, Member>();
        const print = (frame: ServerFrame): void => {
          if (frame.type === 'member') members.set(frame.member.id, frame.member);
          if (frame.type !== 'message') return;
          const author = members.get(frame.message.author)?.handle ?? frame.message.author;
          // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-cli-tail
          if (frame.message.kind === 'run') {
            // Roots and continuations both print here, each carrying only its
            // own id and body. Nothing is aggregated or hidden: a continuation
            // is a row a reader can scroll to, not a fragment of another one.
            out(formatRunHeader(frame.message, author));
            if (frame.message.body) out(frame.message.body);
            // The evidence line below reads `run?.error`, which is undefined for
            // a continuation by construction — so a root's failure can never be
            // reattributed to a row that merely continues it.
            // harn:assume run-failure-evidence-is-surfaced ref=cli-run-error-evidence
            if (frame.message.run?.error) out(`error: ${frame.message.run.error}`);
            // harn:end run-failure-evidence-is-surfaced
            // harn:end continuation-writer-follows-journaled-output-ownership
          } else {
            out(`#${frame.message.id} @${author} ${frame.message.kind}`);
            if (frame.message.body) out(frame.message.body);
          }
        };
        const until = options.untilMention !== undefined || options.untilAny === true;
        if (options.untilMention !== undefined && options.untilAny) {
          throw new Error('--until-mention and --until-any are mutually exclusive');
        }
        if (until && !options.follow) throw new Error('--until-* requires --follow');
        if (until && options.once) throw new Error('--once cannot be combined with --until-*');
        if (until) {
          if (!env.CODOR_MEMBER_TOKEN) throw new Error('tail --until-* requires CODOR_MEMBER_TOKEN');
          const snapshot = await syncRoom(client, room);
          const self = snapshot.members.get(snapshot.self);
          if (!self) throw new Error('authenticated member is absent from the channel');
          let mentionedId: string | undefined;
          if (options.untilMention !== undefined) {
            const wanted = options.untilMention.replace(/^@/, '');
            const mentioned = [...snapshot.members.values()].find(
              (member) => member.id === options.untilMention || member.handle === wanted,
            );
            if (!mentioned) throw new Error(`no such member ${options.untilMention}`);
            if (mentioned.id !== snapshot.self) {
              throw new Error('--until-mention must name the authenticated member');
            }
            mentionedId = mentioned.id;
          }
          const peers = [...snapshot.members.values()]
            .filter((member) => member.id !== snapshot.self && member.removed_ts === undefined && member.state !== 'dead')
            .map((member) => member.id);
          if (peers.length === 0) throw new Error('tail --until-* requires at least one active peer');
          const deadline = Date.now() + options.timeout * 1_000;
          let registered = false;
          try {
            await setWait(
              client,
              room,
              snapshot.self,
              options.untilAny ? 'any' : 'mention',
              peers,
              new Date(deadline).toISOString(),
            );
            registered = true;
            const match = await waitForOwnDelivery(
              client,
              room,
              await syncRoom(client, room),
              deadline,
              (message) => mentionedId === undefined ||
                message.mentions.some((mention) => mention.member_id === mentionedId),
            );
            if (!match) {
              out(`TIMEOUT after ${String(options.timeout)}s`);
              return;
            }
            const consumed = await consumeDelivery(client, room, match.delivery);
            out(consumed.body);
            return;
          } finally {
            if (registered) await clearWait(client, room, snapshot.self);
          }
        }
        client.send({ type: 'subscribe', room, since_seq: 0 });
        for (;;) {
          const frame = await client.next(24 * 60 * 60 * 1_000);
          if (frame.type === 'error') throw new Error(frame.message);
          print(frame);
          if (options.once && frame.type === 'sync_complete') return;
        }
      });
    });
  // harn:end cli-waits-consume-only-matching-deliveries

  // harn:assume cli-hook-inbox-is-silent-when-empty ref=inbox-command
  program
    .command('inbox')
    .option('-r, --channel <channel>', 'channel id; defaults to CODOR_CHANNEL')
    .option('--new', 'show queued deliveries not yet consumed')
    .option('--consume', 'consume every printed delivery')
    .option('--format <format>', 'text or hook', 'text')
    .action(async (options: OptionalChannelOptions & { new?: boolean; consume?: boolean; format: string }) => {
      if (!options.new) throw new Error('inbox currently requires --new');
      if (!env.CODOR_MEMBER_TOKEN) throw new Error('inbox requires CODOR_MEMBER_TOKEN');
      if (options.format !== 'text' && options.format !== 'hook') {
        throw new Error('--format must be text or hook');
      }
      await withClient(async (client) => {
        const room = channel(options);
        const snapshot = await syncRoom(client, room);
        const rendered: { message: Message; author: string }[] = [];
        for (const delivery of ownQueuedDeliveries(snapshot)) {
          const message = options.consume
            ? await consumeDelivery(client, room, delivery)
            : snapshot.messages.get(delivery.message_id);
          if (!message) continue;
          rendered.push({
            message,
            author: snapshot.members.get(message.author)?.handle ?? message.author,
          });
        }
        if (options.format === 'hook') {
          const hook = renderHookInbox(rendered);
          if (hook !== undefined) out(hook);
          return;
        }
        for (const item of rendered) out(formatInboxMessage(item.message, item.author));
      });
    });
  // harn:end cli-hook-inbox-is-silent-when-empty

  // harn:assume cli-observability-uses-scoped-rest ref=status-command
  program
    .command('status')
    .argument('<member>')
    .option('-r, --channel <channel>', 'channel id; defaults to CODOR_CHANNEL')
    .action(async (memberRef: string, options: OptionalChannelOptions) => {
      await withClient(async (client) => {
        const room = channel(options);
        const snapshot = await syncRoom(client, room);
        const wanted = memberRef.replace(/^@/, '');
        const member = [...snapshot.members.values()].find(
          (candidate) => candidate.id === memberRef || candidate.handle === wanted,
        );
        if (!member) throw new Error(`no such member ${memberRef}`);
        const url = restUrl(
          `/api/rooms/${encodeURIComponent(room)}/members/${encodeURIComponent(member.id)}/status`,
        );
        const status = MemberStatusResponseSchema.parse(await fetchJson(url));
        const running = status.current_run ? ` (${formatElapsed(status.current_run.elapsed_ms)})` : '';
        const waiting = status.member.waiting
          ? `waiting for ${status.member.waiting.peers.map((peer) => `@${peer}`).join(', ')}`
          : 'not waiting';
        out(`@${status.member.handle} - ${status.member.state}${running}, ${waiting}`);
        status.recent.forEach((item, index) => {
          const clock = new Date(item.ts).toISOString().slice(11, 19);
          out(
            `  ${String(index + 1)}. ${item.kind} ${item.title} ${item.status ?? '-'} ` +
            `${formatDuration(item.duration_ms)} ${clock}`,
          );
        });
      });
    });
  // harn:end cli-observability-uses-scoped-rest

  // harn:assume cli-observability-uses-scoped-rest ref=search-command
  program
    .command('search')
    .argument('<query>')
    .option('-r, --channel <channel>', 'channel id; defaults to CODOR_CHANNEL')
    .option('--runs', 'include bounded projected run evidence')
    .option('--limit <count>', 'result/run scan limit', (value) => parsePositiveInteger(value, '--limit'))
    .action(async (query: string, options: OptionalChannelOptions & { runs?: boolean; limit?: number }) => {
      await withClient(async (client) => {
        const room = channel(options);
        const snapshot = await syncRoom(client, room);
        const url = restUrl(`/api/rooms/${encodeURIComponent(room)}/search`);
        url.searchParams.set('q', query);
        if (options.runs) url.searchParams.set('include', 'runs');
        if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
        const raw = await fetchJson(url);
        if (typeof raw !== 'object' || raw === null || !('messages' in raw) || !Array.isArray(raw.messages)) {
          throw new Error('invalid search response');
        }
        const messages = raw.messages.map((message) => MessageSchema.parse(message));
        const runs: RunSearchHit[] = 'runs' in raw && Array.isArray(raw.runs)
          ? raw.runs.map((hit) => RunSearchHitSchema.parse(hit))
          : [];
        for (const message of messages) {
          const author = snapshot.members.get(message.author)?.handle ?? message.author;
          out(`#${message.id} @${author} ${message.kind} ${message.body}`);
        }
        for (const hit of runs) {
          out(`#${hit.message_id}:${hit.item_index} ${hit.kind} ${hit.excerpt}`);
        }
      });
    });
  // harn:end cli-observability-uses-scoped-rest

  program
    .command('members')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .action(async (options: ChannelOptions) => {
      await withClient(async (client) => {
        const members: Member[] = [];
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'member') members.push(frame.member);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type !== 'sync_complete') continue;
          for (const member of members) {
            out(`@${member.handle}\t${member.state ?? member.kind}\t${member.harness ?? '-'}`);
          }
          return;
        }
      });
    });

  program
    .command('join')
    .argument('<channel>')
    .requiredOption('--as <handle>', 'channel member handle')
    .option('--harness <harness>', 'claude-code or codex')
    .option('--session <id>', 'native session id')
    .option('--cwd <path>', 'session working directory')
    .option('--policy <policy>', 'session policy label')
    .action(async (channel: string, options: {
      as: string;
      harness?: string;
      session?: string;
      cwd?: string;
      policy?: string;
    }) => {
      const detected = detectSession({
        harness: options.harness,
        session: options.session,
        cwd: options.cwd,
        env,
      });
      await withClient(async (client) => {
        const existing = new Set<string>();
        client.send({ type: 'subscribe', room: channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'member') existing.add(frame.member.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({
          type: 'act',
          room: channel,
          act: {
            act: 'join',
            harness: detected.harness,
            handle: options.as,
            session_ref: detected.session_ref,
            cwd: detected.cwd,
            policy: options.policy,
          },
        });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (
            frame.type === 'member' &&
            !existing.has(frame.member.id) &&
            frame.member.handle === options.as &&
            frame.member.custody === 'mirrored'
          ) {
            out(`joined @${frame.member.handle} ${frame.member.id} (${detected.harness})`);
            return;
          }
        }
      });
    });

  program
    .command('adopt')
    .argument('<member>')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .action(async (memberRef: string, options: ChannelOptions) => {
      await withClient(async (client) => {
        let member: Member | undefined;
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (
            frame.type === 'member' &&
            (frame.member.id === memberRef || frame.member.handle === memberRef.replace(/^@/, ''))
          ) {
            member = frame.member;
          }
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        if (!member) throw new Error(`no such member ${memberRef}`);
        client.send({ type: 'act', room: options.channel, act: { act: 'adopt', member_id: member.id } });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (
            frame.type === 'member' &&
            frame.member.id === member.id &&
            frame.member.custody === 'owned'
          ) {
            out(`adopted @${frame.member.handle}`);
            return;
          }
        }
      });
    });

  program
    .command('mirror-hook', { hidden: true })
    .argument('<source>', 'claude or codex')
    .argument('[payload]', 'hook JSON; Claude hooks default to stdin')
    .action(async (source: string, payload?: string) => {
      if (source !== 'claude' && source !== 'codex') throw new Error(`unsupported mirror source '${source}'`);
      const raw = payload ?? (await readStandardInput());
      const frame = parseMirrorHook(source, raw, env);
      await withClient(async (client) => {
        client.send(frame);
        for (;;) {
          const response = await client.next();
          if (response.type === 'error') throw new Error(response.message);
          if (response.type === 'mirror_ack') return;
        }
      });
    });

  // harn:assume cli-member-recovery-is-actionable ref=cli-revive-and-attach-surface
  program
    .command('attach')
    .argument('<member>')
    .option('-r, --channel <channel>', 'channel id; omitted searches all channels')
    .action(async (memberRef: string, options: { channel?: string }) => {
      await withClient(async (client) => {
        const wanted = memberRef.replace(/^@/, '');
        let rooms = options.channel ? [options.channel] : undefined;
        if (!rooms) {
          client.send({ type: 'list_rooms' });
          for (;;) {
            const frame = await client.next();
            if (frame.type === 'error') throw new Error(frame.message);
            if (frame.type === 'rooms') {
              rooms = frame.rooms.map((room) => room.id);
              break;
            }
          }
        }

        const matches: { room: string; member: Member }[] = [];
        for (const room of rooms) {
          client.send({ type: 'subscribe', room, since_seq: 0 });
          for (;;) {
            const frame = await client.next();
            if (frame.type === 'error') throw new Error(frame.message);
            if (
              frame.type === 'member' &&
              frame.member.removed_ts === undefined &&
              (frame.member.id === memberRef || frame.member.handle === wanted)
            ) {
              matches.push({ room, member: frame.member });
            }
            if (frame.type === 'sync_complete') break;
          }
        }
        if (matches.length === 0) throw new Error(`no such member ${memberRef}`);
        if (matches.length > 1) {
          const candidates = matches
            .map(({ room, member }) => `${room} (${member.state ?? member.kind})`)
            .sort()
            .join(', ');
          throw new Error(`member ${memberRef} is ambiguous: ${candidates}; pass --channel <channel-id>`);
        }
        const match = matches[0]!;
        client.send({
          type: 'act',
          room: match.room,
          act: { act: 'attach_acquire', member_id: match.member.id, cli_pid: process.pid },
        });
        let acquired: { member: Member; lease: AttachLease };
        for (;;) {
          const frame = await client.next(24 * 60 * 60 * 1_000);
          if (frame.type === 'error') throw new Error(frame.message);
          if (
            frame.type === 'attach_lease' &&
            frame.status === 'acquired' &&
            frame.member.id === match.member.id &&
            frame.lease
          ) {
            acquired = { member: frame.member, lease: frame.lease };
            break;
          }
        }
        out(`attaching @${acquired.member.handle} (${acquired.member.harness})`);
        const result = await superviseInteractiveAttach({
          client,
          room: match.room,
          member: acquired.member,
          lease: acquired.lease,
          env,
          commandResolver: context.interactiveCommand ?? nativeResumeCommand,
          spawnChild: context.spawnInteractive,
          heartbeatMs: context.attachHeartbeatMs,
        });
        if (result.status === 'completed') out(`re-adopted @${acquired.member.handle}`);
        else out(`@${acquired.member.handle} custody remains uncertain until its process group exits`);
      });
    });

  program
    .command('revive')
    .description('revive a dead agent from its persisted native session')
    .argument('<member>')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .action(async (memberRef: string, options: ChannelOptions) => {
      await withClient(async (client) => {
        const wanted = memberRef.replace(/^@/, '');
        let member: Member | undefined;
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (
            frame.type === 'member' &&
            frame.member.removed_ts === undefined &&
            (frame.member.id === memberRef || frame.member.handle === wanted)
          ) {
            member = frame.member;
          }
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        if (!member) throw new Error(`no such member ${memberRef}`);
        client.send({ type: 'act', room: options.channel, act: { act: 'revive', member_id: member.id } });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'member' && frame.member.id === member.id && frame.member.state !== 'dead') {
            out(`revived @${frame.member.handle}`);
            return;
          }
        }
      });
    });
  // harn:end cli-member-recovery-is-actionable

  // harn:assume terminal-pairing-qr-matches-plain-url ref=pair-qr-command
  program
    .command('pair')
    .description('create a ten-minute browser or peer pairing link')
    .option('--endpoint <url>', 'switchboard browser endpoint', 'http://127.0.0.1:8137')
    .option('--no-qr', 'print the plain pairing URL without a terminal QR')
    .action(async (options: { endpoint: string; qr: boolean }) => {
      type PairOffer = {
        endpoint: string;
        pairing_token: string;
        pairing_code: string;
        expires_at: string;
        switchboard_sign_pub: string;
        doors?: 'both' | 'local';
      };
      const emit = (offer: PairOffer): void => {
        const url = pairingUrl(offer);
        if (options.qr) out((context.renderQr ?? renderTerminalQr)(url));
        out(url);
        // harn:assume pairing-code-enrollment-surfaces ref=pair-code-command
        out(`code: ${offer.pairing_code}`);
        // harn:end pairing-code-enrollment-surfaces
        out(`expires ${offer.expires_at}`);
      };
      // On a TTY, present the offer as the SAME bordered card the setup flow
      // ends on (code, clickable link, expiry, QR), with an instruction naming
      // which doors the code opens. Piped/non-TTY output keeps the plain lines
      // above, so scripts and tests see an unchanged surface.
      const tty = context.isTTY ?? process.stdout.isTTY === true;
      const present = (offer: PairOffer): void => {
        if (!tty) {
          emit(offer);
          return;
        }
        const url = pairingUrl(offer);
        out(renderPairingCard({
          code: offer.pairing_code,
          url,
          expires: offer.expires_at,
          qr: options.qr ? (context.renderQr ?? renderTerminalQr)(url) : '',
          instruction: offer.doors === 'both'
            ? 'This code works at codor.app and on your network. Scan the QR or enter the code in your browser to finish pairing.'
            : 'This code works on your network only (run `codor relay enable` for codor.app codes). Scan the QR or enter the code in your browser to finish pairing.',
        }, process.stdout.columns ?? 80));
      };
      // When the relay is enabled, delegate to the daemon's universal mint so the
      // printed code opens BOTH codor.app and the local door. If the daemon is
      // unreachable (or the relay is off), mint locally exactly as before.
      let relayEnabled = false;
      try {
        relayEnabled = ((await fetchJson(restUrl('/api/relay/status'))) as { enabled?: boolean }).enabled === true;
      } catch {
        relayEnabled = false;
      }
      if (relayEnabled) {
        present((await postJson('/api/pairing/offers', { endpoint: options.endpoint })) as PairOffer);
        return;
      }
      // NOTE (ledger): a daemon-off local mint can't know whether a relay is
      // configured, so its card uses the local-only instruction (doors absent).
      withCrypto((crypto) => present(crypto.pairing.issue(options.endpoint)));
    });
  // harn:end terminal-pairing-qr-matches-plain-url

  program.command('peers').description('list enrolled devices and switchboards').action(() => {
    withCrypto((crypto) => {
      for (const peer of crypto.keys.listPeers()) {
        out(`${peer.device_id}\t${peer.kind}\t${peer.label ?? '-'}`);
      }
    });
  });

  program
    .command('revoke')
    .description('revoke a device or switchboard and rotate channel keys')
    .argument('<peer>', 'device id or label')
    .action((peer: string) => {
      withCrypto((crypto) => {
        const revoked = crypto.revokePeer(peer);
        out(`revoked ${revoked.device_id}`);
      });
    });
  const ledger = program.command('ledger').description('manage channel shared-memory notes');
  ledger
    .command('init')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .action((options: ChannelOptions) => {
      const vault = new LedgerVault(program.opts<GlobalOptions>().dataDir, options.channel);
      vault.bootstrap();
      out(vault.root);
    });
  ledger
    .command('add')
    .argument('<name>', 'lowercase note slug')
    .argument('<body>', 'markdown note body')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .requiredOption('--type <type>', 'decision, constraint, or contract')
    .requiredOption('--as <handle>', 'channel member attribution')
    .option('--join <line>', 'route the write to the home using name:secret')
    .option('--home <peer>', 'home switchboard device id')
    .action(async (name: string, body: string, options: ChannelOptions & {
      type: string;
      as: string;
      join?: string;
      home?: string;
    }) => {
      if (!['decision', 'constraint', 'contract'].includes(options.type)) {
        throw new Error('--type must be decision, constraint, or contract');
      }
      const write = {
        name,
        body,
        type: options.type as LedgerNoteType,
        author: options.as,
      };
      if (options.join || options.home) {
        if (!options.join || !options.home) throw new Error('--join and --home must be used together');
        const crypto = new CryptoVault(program.opts<GlobalOptions>().dataDir);
        const transport = new HyperswarmTransport({ lines: [parseLine(options.join)], crypto });
        try {
          await transport.start();
          await transport.waitForPeer(options.home);
          const note = await addRemoteLedgerNote(transport, options.home, options.channel, write);
          out(`${note.relative_path}\t[[${note.name}]]`);
        } finally {
          await transport.close();
          crypto.close();
        }
        return;
      }
      const note = new LedgerVault(program.opts<GlobalOptions>().dataDir, options.channel).add(write);
      out(`${note.relative_path}\t[[${note.name}]]`);
    });
  ledger
    .command('show')
    .argument('<name>', 'note slug')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .action((name: string, options: ChannelOptions) => {
      const note = new LedgerVault(program.opts<GlobalOptions>().dataDir, options.channel).note(name);
      if (!note) throw new Error(`no such ledger note ${name}`);
      out(note.content.trimEnd());
    });
  ledger
    .command('pull')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .option('-d, --destination <path>', 'snapshot parent directory', process.cwd())
    .action((options: ChannelOptions & { destination: string }) => {
      out(new LedgerVault(program.opts<GlobalOptions>().dataDir, options.channel).pull(options.destination));
    });

  const relay = program.command('relay').description('manage the codor.app tunnel relay');
  relay
    .command('status')
    .description('show tunnel relay status')
    .action(async () => {
      out(JSON.stringify(await fetchJson(restUrl('/api/relay/status')), null, 2));
    });
  relay
    .command('pair')
    .description('pair a browser through the tunnel relay')
    .action(async () => {
      // The body must be `{}`: postJson always sends a JSON content-type, and
      // fastify 400s a bodyless POST that declares one.
      const result = (await postJson('/api/relay/pair', {})) as {
        code: string;
        expires_at: string;
        doors?: 'both' | 'local';
      };
      // Label a degraded code honestly: the relay was unreachable, so this code
      // opens the local/tailnet door only — not codor.app — until the relay is back.
      const label = result.doors === 'local'
        ? 'local-only pairing code (relay unreachable; works on your network, not codor.app)'
        : 'pairing code';
      out(`${label} ${result.code} (expires ${result.expires_at})`);
    });
  relay
    .command('enable')
    .description('enable the tunnel relay')
    .argument('[url]', 'relay URL override')
    .action(async (url?: string) => {
      await postJson('/api/relay/enable', url ? { url } : {});
      out('tunnel relay enabled');
    });
  relay
    .command('disable')
    .description('disable the tunnel relay')
    .action(async () => {
      await postJson('/api/relay/disable');
      out('tunnel relay disabled');
    });
  relay
    .command('rotate')
    .description('rotate the tunnel session id (paired devices must re-pair)')
    .action(async () => {
      const result = (await postJson('/api/relay/rotate')) as { session_id: string };
      out(`rotated; new session ${result.session_id}`);
    });
  // harn:assume structured-agent-cli-preserves-flat-lifecycle-and-presets ref=structured-agent-command-surface
  const agentManagement = program.command('agent').description('manage channel agents');
  // harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-management-client
  const agentRoom = async (channel: string, worktree?: string): Promise<string> => {
    if (worktree === undefined) return channel;
    const listed = await listWorktrees(worktreeRestClient, channel);
    return resolveWorktreeSelector(listed.registered, worktree).conversation_id;
  };
  // harn:end structured-worktree-cli-targets-branches-and-child-rooms
  agentManagement
    .command('list')
    .description('list channel agents')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--worktree <branch-or-selector>', 'target registered worktree')
    .option('--json', 'emit one JSON value')
    .action(async (options: ChannelOptions & { worktree?: string; json?: boolean }) => {
      const room = await agentRoom(options.channel, options.worktree);
      await withManagementClient(async (client) => {
        const agents = await listManagedAgents(client, room);
        const rendered = renderAgentList(agents, options.json === true);
        if (rendered !== '') out(rendered);
      });
    });

  agentManagement
    .command('add')
    .description('add a channel agent')
    .argument('[handle]', 'agent handle; omitted when --preset supplies it')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--worktree <branch-or-selector>', 'target registered worktree')
    .option('--adapter <adapter>', 'installed public adapter id')
    .option('--preset <preset-id>', 'exact agent preset id')
    .requiredOption('--cwd <path>', 'working directory')
    .option('--name <display-name>', 'agent display name')
    .option('--purpose <purpose>', 'agent purpose')
    .option('--policy <policy>', 'read-only, workspace-write, or full-access')
    .option('--model <model>', 'model override')
    .option('--thinking <level>', 'thinking level')
    .option('--json', 'emit one JSON value')
    .action(async (rawHandle: string | undefined, options: ChannelOptions & {
      adapter?: string;
      preset?: string;
      worktree?: string;
      cwd: string;
      name?: string;
      purpose?: string;
      policy?: Policy;
      model?: string;
      thinking?: ThinkingLevel;
      json?: boolean;
    }) => {
      if ((options.adapter === undefined) === (options.preset === undefined)) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          'agent add requires exactly one of --adapter or --preset',
        );
      }
      if (options.preset === undefined && rawHandle === undefined) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          'manual agent add requires a handle',
        );
      }
      const handle = rawHandle?.replace(/^@/, '');
      const room = await agentRoom(options.channel, options.worktree);
      await withManagementClient(async (client) => {
        const agent = options.preset !== undefined
          ? await addManagedPresetAgent(client, room, {
              preset_id: options.preset,
              ...(handle !== undefined && { handle }),
              cwd: options.cwd,
              ...(options.policy !== undefined && { policy: options.policy }),
              model: options.model,
              thinking: options.thinking,
              ...(options.name !== undefined && { display_name: options.name }),
              ...(options.purpose !== undefined && { purpose: options.purpose }),
            })
          : await addManagedAgent(client, room, {
              adapter: options.adapter!,
              handle: handle!,
              cwd: options.cwd,
              ...(options.policy !== undefined && { policy: options.policy }),
              model: options.model,
              thinking: options.thinking,
              ...(options.name !== undefined && { display_name: options.name }),
              ...(options.purpose !== undefined && { purpose: options.purpose }),
            });
        out(renderAgent(agent, options.json === true));
      });
    });

  agentManagement
    .command('configure')
    .description('configure an existing channel agent')
    .argument('<agent>', 'agent id or handle')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--worktree <branch-or-selector>', 'target registered worktree')
    .option('--model <model>', 'model override')
    .option('--clear-model', 'clear the model override')
    .option('--thinking <level>', 'thinking level')
    .option('--clear-thinking', 'clear the thinking override')
    .option('--policy <policy>', 'read-only, workspace-write, or full-access')
    .option('--json', 'emit one JSON value')
    .action(async (target: string, options: ChannelOptions & {
      model?: string;
      clearModel?: boolean;
      thinking?: ThinkingLevel;
      clearThinking?: boolean;
      policy?: Policy;
      worktree?: string;
      json?: boolean;
    }) => {
      const hasModel = options.model !== undefined;
      const hasThinking = options.thinking !== undefined;
      if (hasModel && options.clearModel) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, '--model and --clear-model are mutually exclusive');
      }
      if (hasThinking && options.clearThinking) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, '--thinking and --clear-thinking are mutually exclusive');
      }
      if (!hasModel && !options.clearModel && !hasThinking && !options.clearThinking && options.policy === undefined) {
        throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'agent configure requires a setting change');
      }
      const room = await agentRoom(options.channel, options.worktree);
      await withManagementClient(async (client) => {
        const agent = await resolveManagedAgent(client, room, target);
        const updated = await mutateManagedAgent(client, room, {
          act: 'configure',
          member_id: agent.id,
          ...((hasModel || options.clearModel) && { model: options.clearModel ? null : options.model }),
          ...((hasThinking || options.clearThinking) && { thinking: options.clearThinking ? null : options.thinking }),
          ...(options.policy !== undefined && { policy: options.policy }),
        });
        out(renderAgent(updated, options.json === true));
      });
    });

  agentManagement
    .command('rename')
    .description('rename a channel agent')
    .argument('<agent>', 'agent id or handle')
    .argument('<handle>', 'new agent handle')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--worktree <branch-or-selector>', 'target registered worktree')
    .option('--name <display-name>', 'new display name')
    .option('--json', 'emit one JSON value')
    .action(async (target: string, rawHandle: string, options: ChannelOptions & {
      name?: string;
      worktree?: string;
      json?: boolean;
    }) => {
      const handle = rawHandle.replace(/^@/, '');
      const room = await agentRoom(options.channel, options.worktree);
      await withManagementClient(async (client) => {
        const agent = await resolveManagedAgent(client, room, target);
        const updated = await mutateManagedAgent(client, room, {
          act: 'rename',
          member_id: agent.id,
          handle,
          ...(options.name !== undefined && { display_name: options.name }),
        });
        out(renderAgent(updated, options.json === true));
      });
    });

  for (const action of ['pause', 'revive'] as const) {
    agentManagement
      .command(action)
      .description(`${action} a channel agent`)
      .argument('<agent>', 'agent id or handle')
      .requiredOption('--channel <channel>', 'channel id')
      .option('--worktree <branch-or-selector>', 'target registered worktree')
      .option('--json', 'emit one JSON value')
      .action(async (target: string, options: ChannelOptions & { worktree?: string; json?: boolean }) => {
        const room = await agentRoom(options.channel, options.worktree);
        await withManagementClient(async (client) => {
          const agent = await resolveManagedAgent(client, room, target);
          const updated = await mutateManagedAgent(client, room, {
            act: action,
            member_id: agent.id,
          });
          out(renderAgent(updated, options.json === true));
        });
      });
  }

  agentManagement
    .command('remove')
    .description('remove a channel agent')
    .argument('<agent>', 'agent id or handle')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--worktree <branch-or-selector>', 'target registered worktree')
    .option('--yes', 'confirm removal without prompting')
    .option('--json', 'emit one JSON value')
    .action(async (target: string, options: ChannelOptions & { worktree?: string; yes?: boolean; json?: boolean }) => {
      const isTTY = context.isTTY ?? Boolean(process.stdin.isTTY);
      const room = await agentRoom(options.channel, options.worktree);
      await withManagementClient(async (client) => {
        const agent = await resolveManagedAgent(client, room, target);
        await confirmAgentRemove({
          label: `@${agent.handle} in channel ${options.channel}`,
          yes: options.yes === true,
          json: options.json === true,
          isTTY,
          stderr: err,
          confirm: context.confirm,
        });
        const removed = await mutateManagedAgent(client, room, {
          act: 'remove',
          member_id: agent.id,
        });
        out(renderAgent(removed, options.json === true));
      });
    });
  // harn:end human-facing-surfaces-call-rooms-channels
  // harn:end structured-agent-cli-preserves-flat-lifecycle-and-presets

  // harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-command-surface
  const worktreeManagement = program
    .command('worktree')
    .description('manage registered worktrees');

  worktreeManagement
    .command('list')
    .description('list registered and discovered worktrees')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--cwd <path>', 'repository working directory')
    .option('--json', 'emit one JSON value')
    .action(async (options: ChannelOptions & { cwd?: string; json?: boolean }) => {
      const listed = await listWorktrees(worktreeRestClient, options.channel, options.cwd);
      out(renderWorktreeList(listed, options.json === true));
    });

  worktreeManagement
    .command('add')
    .description('adopt or create one secondary worktree')
    .requiredOption('--channel <channel>', 'channel id')
    .requiredOption('--path <absolute-path>', 'worktree path')
    .option('--adopt', 'adopt one already discovered worktree')
    .option('--create', 'create and register one new worktree')
    .option('--branch <branch>', 'new local branch')
    .option('--default-roster', 'seed the child from the configured default roster')
    .option('--cwd <path>', 'repository working directory')
    .option('--json', 'emit one JSON value')
    .action(async (options: ChannelOptions & {
      path: string;
      adopt?: boolean;
      create?: boolean;
      branch?: string;
      defaultRoster?: boolean;
      cwd?: string;
      json?: boolean;
    }) => {
      const adopt = options.adopt === true;
      const create = options.create === true;
      if (adopt === create) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          'worktree add requires exactly one of --adopt or --create',
        );
      }
      if (adopt && (options.branch !== undefined || options.defaultRoster === true)) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          '--branch and --default-roster require --create',
        );
      }
      if (create && options.branch === undefined) {
        throw new ManagementError(
          MANAGEMENT_EXIT_CODES.invocation,
          '--create requires --branch',
        );
      }
      const worktree = adopt
        ? await adoptWorktree(worktreeRestClient, options.channel, {
            path: options.path,
          }, options.cwd)
        : await createWorktree(worktreeRestClient, options.channel, {
            path: options.path,
            branch: options.branch!,
            ...(options.defaultRoster === true && { default_roster: true as const }),
          }, options.cwd);
      out(renderWorktree(worktree, options.json === true));
    });

  // harn:assume worktree-cli-removal-requires-previewed-consent ref=worktree-removal-command-confirmation
  worktreeManagement
    .command('remove')
    .description('unregister or remove one secondary worktree')
    .argument('<worktree>', 'exact branch or derived shorthand')
    .requiredOption('--channel <channel>', 'channel id')
    .option('--cwd <path>', 'repository working directory')
    .option('--filesystem', 'remove the clean checkout after preview')
    .option('--yes', 'confirm removal without prompting')
    .option('--json', 'emit one JSON value')
    .action(async (selector: string, options: ChannelOptions & {
      cwd?: string;
      filesystem?: boolean;
      yes?: boolean;
      json?: boolean;
    }) => {
      const listed = await listWorktrees(worktreeRestClient, options.channel, options.cwd);
      const selected = resolveWorktreeSelector(listed.registered, selector);
      let confirmationWorktree = selected;
      if (options.filesystem === true) {
        const preview = await previewWorktreeRemoval(
          worktreeRestClient,
          options.channel,
          selected.id,
          options.cwd,
        );
        if (preview.state !== 'clean' || preview.branch_preserved !== true) {
          const detail = preview.detail === undefined
            ? `worktree removal refused: ${preview.state}`
            : escapeWorktreeHumanCell(preview.detail);
          throw new ManagementError(MANAGEMENT_EXIT_CODES.conflict, detail);
        }
        confirmationWorktree = preview.worktree;
      }
      const isTTY = context.isTTY ?? Boolean(process.stdin.isTTY);
      await confirmWorktreeRemoval({
        alias: confirmationWorktree.alias,
        path: confirmationWorktree.path,
        yes: options.yes === true,
        json: options.json === true,
        isTTY,
        stderr: err,
        confirm: context.confirm,
      });
      const removed = options.filesystem === true
        ? await removeFilesystemWorktree(worktreeRestClient, options.channel, selected.id, options.cwd)
        : await removeWorktree(worktreeRestClient, options.channel, selected.id);
      out(renderWorktree(removed, options.json === true));
    });
  // harn:end worktree-cli-removal-requires-previewed-consent
  // harn:end structured-worktree-cli-uses-accepted-lifecycle

  const structuredChannelCommands = (channelManagement.commands as Command[]).splice(0);
  channelManagement.aliases().splice(0);
  const structuredChannelManagement = program
    .command('channel')
    .description('manage channels');
  for (const command of structuredChannelCommands) structuredChannelManagement.addCommand(command);

  // harn:assume structured-management-help-and-docs-are-complete ref=management-help-metadata
  const addManagementHelp = (command: Command, text: string): void => {
    command.addHelpText('after', `\n${text}\n`);
  };
  program.addHelpText('after', [
    '',
    'Management families (use family help for accepted subcommands):',
    '  codor channel --help       manage channels; archive is soft retention only',
    '  codor agent --help         manage channel agents',
    '  codor agent-preset --help  manage individual reusable presets',
    '  codor default-roster --help  manage the ordered default roster',
    '  codor worktree --help      manage create/adopt and unregister/filesystem worktrees',
    '',
    'Local commands use the protected local socket by default. For an explicit loopback',
    'connection, use --url <loopback-url> --token <token>. Mutating archive, delete,',
    'and removal actions require confirmation; use --yes for unattended JSON calls.',
    'Existing flat commands remain compatible.',
    '',
    'Examples:',
    '  codor channel list',
    '  codor channel list --json',
    '  codor --url <loopback-url> --token <token> channel show desk --json',
  ].join('\n'));
  addManagementHelp(structuredChannelManagement, [
    'Archive is soft retention only; there is no hard-delete or restore command.',
    'Examples:',
    '  codor channel show desk --json',
    '  codor channel archive desk --yes --json',
  ].join('\n'));
  addManagementHelp(agentManagement, [
    'Agent add selects exactly one public adapter or preset.',
    'Examples:',
    '  codor agent add reviewer --channel desk --adapter housecat --cwd "$PWD"',
    '  codor agent add --channel desk --preset <preset-id> --cwd "$PWD"',
  ].join('\n'));
  addManagementHelp(agentPresetManagement, [
    'Agent-preset is individual reusable preset CRUD and is separate from default-roster.',
    'Examples:',
    '  codor agent-preset create "Review helper" --handle reviewer --adapter housecat',
    '  codor agent-preset list --json',
  ].join('\n'));
  addManagementHelp(defaultRosterManagement, [
    'Default-roster set replaces the entire ordered roster and is separate from individual presets.',
    'Examples:',
    '  codor default-roster show --json',
    '  codor default-roster set <preset-id> --json',
  ].join('\n'));
  addManagementHelp(worktreeManagement, [
    'Worktree add requires --create or --adopt. Remove unregisters by default;',
    '--filesystem enables guarded clean checkout removal after preview.',
    'Examples:',
    '  codor worktree list --channel desk --json',
    '  codor worktree add --channel desk --create --path <absolute-path> --branch <branch>',
    '  codor worktree remove <branch-or-shorthand> --channel desk --filesystem --yes --json',
  ].join('\n'));
  // harn:end structured-management-help-and-docs-are-complete

  const topLevelCommands = program.commands as Command[];
  const phase3Commands = [agentPresetManagement, defaultRosterManagement];
  for (const command of phase3Commands) {
    const index = topLevelCommands.indexOf(command);
    if (index >= 0) topLevelCommands.splice(index, 1);
  }
  const serveIndex = topLevelCommands.findIndex((command) => command.name() === 'serve');
  topLevelCommands.splice(serveIndex < 0 ? topLevelCommands.length : serveIndex, 0, ...phase3Commands);
  const configureCommander = (command: Command): void => {
    command
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    for (const child of command.commands) configureCommander(child);
  };
  configureCommander(program);
  return program;
}

export async function runCli(argv = process.argv, context: CliContext = {}): Promise<void> {
  try {
    await createProgram(context).parseAsync(argv);
  } catch (error) {
    if (!isCommanderFailure(error)) throw error;
    if (error.exitCode === 0) return;
    const structuredRoot = structuredManagementRoot(argv);
    if (structuredRoot !== undefined) {
      const message = error.code === 'commander.help' ? `${structuredRoot} requires a subcommand` : error.message;
      throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, message, { cause: error });
    }
    throw error;
  }
}

interface CommanderFailure {
  code: string;
  exitCode: number;
  message: string;
}

function isCommanderFailure(error: unknown): error is CommanderFailure {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<CommanderFailure>;
  return typeof candidate.code === 'string'
    && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
    && typeof candidate.message === 'string';
}

function structuredManagementRoot(argv: readonly string[]): 'channel' | 'agent' | 'agent-preset' | 'default-roster' | 'worktree' | undefined {
  const args = argv.slice(2);
  const optionsWithValues = new Set(['--data-dir', '--url', '--token']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if ([...optionsWithValues].some((option) => argument.startsWith(`${option}=`))) continue;
    if (argument.startsWith('-')) return undefined;
    return argument === 'channel' || argument === 'agent' || argument === 'agent-preset' || argument === 'default-roster' || argument === 'worktree'
      ? argument
      : undefined;
  }
  return undefined;
}
