import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import type { CreateRoomRequest, Room, ServerFrame } from '@codor/protocol';

import { ProtocolClient } from './connection.js';

// harn:assume management-failures-have-stable-redacted-exits ref=management-error-contract
export const MANAGEMENT_EXIT_CODES = {
  invocation: 2,
  authentication: 3,
  authorization: 4,
  notFound: 5,
  conflict: 6,
  transport: 7,
} as const;

export type ManagementExitCode = (typeof MANAGEMENT_EXIT_CODES)[keyof typeof MANAGEMENT_EXIT_CODES];

export class ManagementError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManagementError';
    this.exitCode = exitCode;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Map a management response or transport failure to the stable public classes. */
export function classifyManagementError(error: unknown): ManagementError {
  if (error instanceof ManagementError) return error;
  const message = errorText(error);
  const lower = message.toLowerCase();
  let code: number = MANAGEMENT_EXIT_CODES.transport;
  if (/--url|--token|argument|option|invalid frame|zoderror|must be/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.invocation;
  }
  if (/unauthorized|authentication|bearer|token required|401|4401/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.authentication;
  } else if (/no such (?:room|channel)|not found|does not exist/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.notFound;
  } else if (/already|archived|conflict|collision|unique constraint|refus/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.conflict;
  } else if (/forbidden|not authorized|cannot (?:list|manage|rename|archive)|authorization/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.authorization;
  } else if (/timed out|timeout|connection|socket|websocket|closed|econn|protocol/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.transport;
  }
  return new ManagementError(code, message, { cause: error });
}
// harn:end management-failures-have-stable-redacted-exits

function selectedSecrets(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [env.CODOR_TOKEN, env.CODOR_MEMBER_TOKEN];
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === '--token' && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    else if (argument.startsWith('--token=')) values.push(argument.slice('--token='.length));
  }
  return [...new Set(values.filter((value): value is string => value !== undefined && value !== ''))]
    .sort((a, b) => b.length - a.length);
}

// harn:assume management-output-is-json-pure-and-safe ref=management-safe-output
/** Return one safe diagnostic line; it never includes selected bearer material. */
export function redactDiagnostic(
  error: unknown,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let message = errorText(error).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const secret of selectedSecrets(argv, env)) message = message.split(secret).join('<redacted>');
  return message
    .replace(/(Bearer\s+)[^\s]+/gi, '$1<redacted>')
    .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(--token(?:=|\s+))[^\s]+/gi, '$1<redacted>')
    || 'command failed';
}
// harn:end management-output-is-json-pure-and-safe

// harn:assume management-failures-have-stable-redacted-exits ref=source-cli-failure-entrypoint
export function cliExitCode(error: unknown): number {
  return error instanceof ManagementError ? error.exitCode : 1;
}

export function formatCliError(error: unknown): string {
  return redactDiagnostic(error);
}
// harn:end management-failures-have-stable-redacted-exits

export interface ChannelProjection {
  id: string;
  name: string;
  status: 'active' | 'archived';
  created_ts: string;
  archived_ts?: string;
  color?: string;
  cwd?: string;
}

function projectChannel(room: Room): ChannelProjection {
  return {
    id: room.id,
    name: room.name,
    status: room.config.archived_ts === undefined ? 'active' : 'archived',
    created_ts: room.created_ts,
    ...(room.config.archived_ts !== undefined && { archived_ts: room.config.archived_ts }),
    ...(room.config.color !== undefined && { color: room.config.color }),
    ...(room.config.cwd !== undefined && { cwd: room.config.cwd }),
  };
}

function sortedChannels(rooms: readonly Room[]): ChannelProjection[] {
  return rooms.map(projectChannel).sort((a, b) => a.id.localeCompare(b.id));
}

// harn:assume structured-channel-cli-preserves-flat-listing ref=structured-channel-rendering
export function renderChannelList(rooms: readonly Room[], json: boolean): string {
  const channels = sortedChannels(rooms);
  if (json) return JSON.stringify(channels);
  return channels
    .map((channel) => [
      channel.id,
      channel.name,
      channel.status,
      channel.created_ts,
      channel.archived_ts ?? '',
      channel.color ?? '',
      channel.cwd ?? '',
    ].join('\t'))
    .join('\n');
}

export function renderChannel(room: Room, json: boolean): string {
  const channel = projectChannel(room);
  if (json) return JSON.stringify(channel);
  return [
    ['id', channel.id],
    ['name', channel.name],
    ['status', channel.status],
    ['created_ts', channel.created_ts],
    ['archived_ts', channel.archived_ts ?? ''],
    ['color', channel.color ?? ''],
    ['cwd', channel.cwd ?? ''],
  ].map(([key, value]) => `${key}\t${value}`).join('\n');
}
// harn:end structured-channel-cli-preserves-flat-listing

// harn:assume management-frames-correlate-one-result ref=management-correlation-client
/**
 * Complete only on the matching authoritative frame. A ProtocolClient may
 * receive live room traffic, legacy errors, or another request's result first.
 */
async function correlatedManagementFrame<T extends ServerFrame>(
  client: ProtocolClient,
  ref: string,
  matches: (frame: ServerFrame) => frame is T,
): Promise<T> {
  for (;;) {
    const frame = await client.next();
    if (frame.type === 'error') {
      if (frame.ref === ref) throw new Error(frame.message);
      continue;
    }
    if (matches(frame) && 'ref' in frame && frame.ref === ref) return frame;
  }
}
// harn:end management-frames-correlate-one-result

export async function listManagedRooms(
  client: ProtocolClient,
  options: { all?: boolean } = {},
): Promise<Room[]> {
  try {
    const ref = randomUUID();
    client.send({ type: 'list_rooms', ref, all: options.all });
    const response = await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'rooms' }> =>
      frame.type === 'rooms');
    return response.rooms.slice().sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function createManagedRoom(
  client: ProtocolClient,
  request: CreateRoomRequest,
): Promise<Room> {
  try {
    const ref = randomUUID();
    client.send({ type: 'create_room', ref, request });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'room' }> =>
      frame.type === 'room')).room;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function renameManagedRoom(
  client: ProtocolClient,
  room: string,
  name: string,
): Promise<Room> {
  try {
    const ref = randomUUID();
    client.send({ type: 'act', room, ref, act: { act: 'rename_room', name } });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'room' }> =>
      frame.type === 'room')).room;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function archiveManagedRoom(client: ProtocolClient, room: string): Promise<Room> {
  try {
    const ref = randomUUID();
    client.send({ type: 'act', room, ref, act: { act: 'archive_room' } });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'room' }> =>
      frame.type === 'room')).room;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

// harn:assume channel-archive-requires-explicit-confirmation ref=management-confirmation-helper
export interface ConfirmationOptions {
  label: string;
  yes?: boolean;
  json?: boolean;
  isTTY: boolean;
  stderr: (line: string) => void;
  confirm?: (prompt: string) => Promise<string | boolean>;
}

export async function confirmArchive(options: ConfirmationOptions): Promise<void> {
  if (options.yes === true) return;
  if (options.json === true || !options.isTTY) {
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      'channel archive requires --yes in noninteractive or JSON mode',
    );
  }
  const prompt = `Archive channel ${options.label}? [y/N]`;
  let answer: string | boolean;
  if (options.confirm !== undefined) {
    options.stderr(prompt);
    answer = await options.confirm(prompt);
  } else {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      answer = await readline.question(`${prompt} `);
    } finally {
      readline.close();
    }
  }
  const accepted = typeof answer === 'boolean' ? answer : /^(?:y|yes)$/i.test(answer.trim());
  if (!accepted) {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'channel archive cancelled');
  }
}
// harn:end channel-archive-requires-explicit-confirmation
