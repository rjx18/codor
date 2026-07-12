import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AttachLease, Member, Message, ServerFrame } from '@codor/protocol';
import { Command } from 'commander';
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

const formatRunHeader = (message: Message, author: string): string => {
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

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
    .option('--url <url>', 'remote switchboard URL')
    .option('--token <token>', 'remote bearer token', env.CODOR_TOKEN);
  // harn:end codor-runtime-identity-is-a-clean-break

  const connectionOptions = (): ProtocolClientOptions => {
    const options = program.opts<GlobalOptions>();
    return { dataDir: options.dataDir, remoteUrl: options.url, token: options.token };
  };

  const withClient = async (fn: (client: ProtocolClient) => Promise<void>): Promise<void> => {
    const client = await ProtocolClient.connect(connectionOptions());
    try {
      await fn(client);
    } finally {
      await client.close();
    }
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
    .requiredOption('-r, --channel <channel>', 'channel id')
    .argument('<message>')
    .action(async (message: string, options: ChannelOptions) => {
      await withClient(async (client) => {
        let lastMessageId = 0;
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'message') lastMessageId = Math.max(lastMessageId, frame.message.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({ type: 'post', room: options.channel, body: message });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'message' && frame.message.id > lastMessageId && frame.message.body === message) {
            out(`posted #${frame.message.id}`);
            return;
          }
        }
      });
    });

  program
    .command('tail')
    .requiredOption('-r, --channel <channel>', 'channel id')
    .option('--once', 'print current history and exit')
    .action(async (options: ChannelOptions & { once?: boolean }) => {
      await withClient(async (client) => {
        const members = new Map<string, Member>();
        const print = (frame: ServerFrame): void => {
          if (frame.type === 'member') members.set(frame.member.id, frame.member);
          if (frame.type !== 'message') return;
          const author = members.get(frame.message.author)?.handle ?? frame.message.author;
          if (frame.message.kind === 'run') {
            out(formatRunHeader(frame.message, author));
            if (frame.message.body) out(frame.message.body);
          } else {
            out(`#${frame.message.id} @${author} ${frame.message.kind}`);
            if (frame.message.body) out(frame.message.body);
          }
        };
        client.send({ type: 'subscribe', room: options.channel, since_seq: 0 });
        for (;;) {
          const frame = await client.next(24 * 60 * 60 * 1_000);
          if (frame.type === 'error') throw new Error(frame.message);
          print(frame);
          if (options.once && frame.type === 'sync_complete') return;
        }
      });
    });

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
