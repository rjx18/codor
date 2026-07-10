import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Member, Message, ServerFrame } from '@wireroom/protocol';
import { Command } from 'commander';

import { ProtocolClient, type ProtocolClientOptions } from './connection.js';
import { detectSession } from './detect.js';
import { parseMirrorHook } from './mirror.js';
import { startWireroom, waitForShutdown } from './up.js';

export interface CliContext {
  stdout?(line: string): void;
  stderr?(line: string): void;
  env?: NodeJS.ProcessEnv;
}

interface GlobalOptions {
  dataDir: string;
  url?: string;
  token?: string;
}

interface RoomOptions {
  room: string;
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
  program
    .name('wireroom')
    .description('Operate local-first multi-agent rooms')
    .option('--data-dir <path>', 'switchboard data directory', env.WIREROOM_DATA_DIR ?? join(homedir(), '.wireroom'))
    .option('--url <url>', 'remote switchboard URL')
    .option('--token <token>', 'remote bearer token', env.WIREROOM_TOKEN);

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

  program
    .command('up')
    .description('start the switchboard in the foreground')
    .option('--host <host>', 'HTTP bind host', '127.0.0.1')
    .option('--port <port>', 'HTTP bind port', (value) => Number(value), 8137)
    .option('--static-root <path>', 'built web client directory')
    .option('--room <id>', 'initial room id', 'default')
    .option('--room-name <name>', 'initial room name', 'Default')
    .option('--owner <handle>', 'initial owner handle')
    .action(async (options: {
      host: string;
      port: number;
      staticRoot?: string;
      room: string;
      roomName: string;
      owner?: string;
    }) => {
      const globals = program.opts<GlobalOptions>();
      const running = await startWireroom({
        dataDir: globals.dataDir,
        token: globals.token ?? '',
        host: options.host,
        port: options.port,
        staticRoot: options.staticRoot,
        room: options.room,
        roomName: options.roomName,
        owner: options.owner,
      });
      out(`wireroom http://localhost:${running.server.port}`);
      out(`socket ${running.server.socketPath}`);
      await waitForShutdown(running.close);
    });

  program.command('rooms').description('list rooms').action(async () => {
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
    .command('spawn')
    .requiredOption('-r, --room <room>', 'room id')
    .requiredOption('--harness <harness>', 'registered adapter id')
    .requiredOption('--as <handle>', 'member handle')
    .requiredOption('--cwd <path>', 'working directory')
    .option('--policy <policy>', 'sandbox or permission policy')
    .option('--model <model>', 'model override')
    .action(async (options: RoomOptions & { harness: string; as: string; cwd: string; policy?: string; model?: string }) => {
      await withClient(async (client) => {
        const existing = new Set<string>();
        client.send({ type: 'subscribe', room: options.room, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'member') existing.add(frame.member.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({
          type: 'act',
          room: options.room,
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
    .requiredOption('-r, --room <room>', 'room id')
    .argument('<message>')
    .action(async (message: string, options: RoomOptions) => {
      await withClient(async (client) => {
        let lastMessageId = 0;
        client.send({ type: 'subscribe', room: options.room, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'message') lastMessageId = Math.max(lastMessageId, frame.message.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({ type: 'post', room: options.room, body: message });
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
    .requiredOption('-r, --room <room>', 'room id')
    .option('--once', 'print current history and exit')
    .action(async (options: RoomOptions & { once?: boolean }) => {
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
        client.send({ type: 'subscribe', room: options.room, since_seq: 0 });
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
    .requiredOption('-r, --room <room>', 'room id')
    .action(async (options: RoomOptions) => {
      await withClient(async (client) => {
        const members: Member[] = [];
        client.send({ type: 'subscribe', room: options.room, since_seq: 0 });
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
    .argument('<room>')
    .requiredOption('--as <handle>', 'room member handle')
    .option('--harness <harness>', 'claude-code or codex')
    .option('--session <id>', 'native session id')
    .option('--cwd <path>', 'session working directory')
    .option('--policy <policy>', 'session policy label')
    .action(async (room: string, options: {
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
        client.send({ type: 'subscribe', room, since_seq: 0 });
        for (;;) {
          const frame = await client.next();
          if (frame.type === 'member') existing.add(frame.member.id);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'sync_complete') break;
        }
        client.send({
          type: 'act',
          room,
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
    .requiredOption('-r, --room <room>', 'room id')
    .action(async (memberRef: string, options: RoomOptions) => {
      await withClient(async (client) => {
        let member: Member | undefined;
        client.send({ type: 'subscribe', room: options.room, since_seq: 0 });
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
        client.send({ type: 'act', room: options.room, act: { act: 'adopt', member_id: member.id } });
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

  program
    .command('attach')
    .argument('<member>')
    .action(() => {
      throw new Error('attach requires custody leases from P1.4');
    });
  program.command('ledger').argument('[args...]').action(() => err('ledger is not implemented yet'));

  return program;
}

export async function runCli(argv = process.argv, context: CliContext = {}): Promise<void> {
  await createProgram(context).parseAsync(argv);
}
