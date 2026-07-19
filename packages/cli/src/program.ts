import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  MemberStatusResponseSchema,
  MessageSchema,
  RunSearchHitSchema,
  type AttachLease,
  type Delivery,
  type Member,
  type Message,
  type RunSearchHit,
  type ServerFrame,
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
import { parseMirrorHook } from './mirror.js';
import { runSetup, type SetupOverrides } from './setup.js';
import { renderTerminalQr } from './terminal-qr.js';
import { parseLine, startOutpost, startCodor, waitForShutdown } from './up.js';

export interface CliContext {
  stdout?(line: string): void;
  stderr?(line: string): void;
  env?: NodeJS.ProcessEnv;
  interactiveCommand?: InteractiveCommandResolver;
  spawnInteractive?: InteractiveSpawner;
  attachHeartbeatMs?: number;
  renderQr?(payload: string): string;
  setup?: SetupOverrides;
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

// harn:assume continuation-output-schema-is-reader-first ref=continuation-cli-format
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
// harn:end continuation-output-schema-is-reader-first

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
  deliveries: Map<string, Delivery>;
}

// harn:assume cli-waits-consume-only-matching-deliveries ref=collaboration-room-sync
async function syncRoom(client: ProtocolClient, room: string): Promise<RoomSnapshot> {
  let self: string | undefined;
  const members = new Map<string, Member>();
  const messages = new Map<number, Message>();
  const deliveries = new Map<string, Delivery>();
  client.send({ type: 'subscribe', room, since_seq: 0 });
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'self') self = frame.member_id;
    else if (frame.type === 'member') members.set(frame.member.id, frame.member);
    else if (frame.type === 'message') messages.set(frame.message.id, frame.message);
    else if (frame.type === 'inbox') deliveries.set(frame.delivery.id, frame.delivery);
    else if (frame.type === 'sync_complete') {
      if (!self) throw new Error('channel subscription did not identify the caller');
      return { self, members, messages, deliveries };
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

  const channel = (options: OptionalChannelOptions): string => {
    const room = options.channel ?? env.CODOR_CHANNEL;
    if (!room) throw new Error('--channel or CODOR_CHANNEL is required');
    return room;
  };

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
    const token = program.opts<GlobalOptions>().token;
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
    .action(async (options: {
      host: string;
      port: number;
      staticRoot?: string;
      channel: string;
      channelName: string;
      owner?: string;
      relayUrl?: string;
      pushVapidPublicKey?: string;
      join?: string;
      trustTailscaleServe: boolean;
      adapter: string[];
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
        pushVapidPublicKey: options.pushVapidPublicKey,
        line: options.join ? parseLine(options.join) : undefined,
        trustTailscaleServe: options.trustTailscaleServe,
        adapters: parseAdapterModules(options.adapter),
      });
      out(`codor http://localhost:${running.server.port}`);
      out(`socket ${running.server.socketPath}`);
      await waitForShutdown(running.close);
    });

  program.command('channels').description('list channels').action(async () => {
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

  // harn:assume cli-setup-wizard-preserves-service-environment ref=setup-command-surface
  program
    .command('setup')
    .description('configure the local switchboard user service and first browser pairing')
    .option('--dry-run', 'print every action and generated unit content without changing the host')
    .action(async (options: { dryRun?: boolean }) => {
      await runSetup({
        dryRun: options.dryRun === true,
        env,
        out,
        overrides: {
          ...context.setup,
          renderQr: context.renderQr ?? context.setup?.renderQr,
        },
      });
    });
  // harn:end cli-setup-wizard-preserves-service-environment

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
        client.send({
          type: 'post',
          room,
          body: message,
          ...(options.wait && { awaiting_reply: true }),
        });
        let posted: Message;
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (
            frame.type === 'message' &&
            frame.message.id > lastMessageId &&
            frame.message.author === initial.self &&
            frame.message.body === message
          ) {
            posted = frame.message;
            break;
          }
        }
        out(`posted #${posted.id}`);
        if (!options.wait) return;
        if (!env.CODOR_MEMBER_TOKEN) throw new Error('post --wait requires CODOR_MEMBER_TOKEN');
        const peers = [...new Set(posted.mentions.map((mention) => mention.member_id))]
          .filter((id) => id !== initial.self && initial.members.get(id)?.removed_ts === undefined);
        if (peers.length === 0) throw new Error('post --wait requires at least one addressed member');
        const deadline = Date.now() + options.timeout * 1_000;
        let registered = false;
        try {
          await setWait(client, room, initial.self, 'reply', peers, new Date(deadline).toISOString());
          registered = true;
          const reply = await waitForOwnDelivery(
            client,
            room,
            await syncRoom(client, room),
            deadline,
            (candidate) =>
              candidate.id > posted.id &&
              peers.includes(candidate.author) &&
              candidate.mentions.some((mention) => mention.member_id === initial.self),
            initial.self,
          );
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
          // harn:assume continuation-output-schema-is-reader-first ref=continuation-cli-tail
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
            // harn:end continuation-output-schema-is-reader-first
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
    .action((options: { endpoint: string; qr: boolean }) => {
      withCrypto((crypto) => {
        const offer = crypto.pairing.issue(options.endpoint);
        const url = pairingUrl(offer);
        if (options.qr) out((context.renderQr ?? renderTerminalQr)(url));
        out(url);
        // harn:assume pairing-code-enrollment-surfaces ref=pair-code-command
        out(`code: ${offer.pairing_code}`);
        // harn:end pairing-code-enrollment-surfaces
        out(`expires ${offer.expires_at}`);
      });
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

  // harn:end human-facing-surfaces-call-rooms-channels
  return program;
}

export async function runCli(argv = process.argv, context: CliContext = {}): Promise<void> {
  await createProgram(context).parseAsync(argv);
}
