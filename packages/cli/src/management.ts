import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import type {
  AgentPresetInput,
  AgentPresetPublic,
  Act,
  CreateRoomRequest,
  DefaultRoster,
  Member,
  Policy,
  Room,
  ServerFrame,
  ThinkingLevel,
} from '@codor/protocol';

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
  const schemaFailure = (error instanceof Error && error.name === 'ZodError')
    || (typeof error === 'object' && error !== null && Array.isArray((error as { issues?: unknown }).issues));
  if (/no such (?:room|channel|agent(?: member)?|agent preset|worktree)|(?:agent )?preset [^ ]+ (?:not found|does not exist)|(?:missing|references missing).*agent preset|not found|does not exist/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.notFound;
  } else if (/token required|(?:codor_token|codor_member_token).*required/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.authentication;
  } else if (
    schemaFailure
    || /--url|--token|--acp-|argument|option|invalid frame|zoderror|invalid input|invalid (?:agent )?preset|must be|expected|does not support .*thinking|does not accept|valid (?:levels|policies)|working directory/.test(lower)
  ) {
    code = MANAGEMENT_EXIT_CODES.invocation;
  } else if (/unauthorized|authentication|bearer|token required|401|4401/.test(lower)) {
    code = MANAGEMENT_EXIT_CODES.authentication;
  } else if (
    /already|archived|conflict|collision|unique constraint|refus|unknown adapter|not installed|unavailable|not currently offered|requires private|shadowed|removed|active turn|stop the turn|custody is uncertain|interactive attach lease|attach lease|not paused|not dead|requires paused or dead|cannot pause|cannot configure|cannot revive|cannot remove|mirrored from another switchboard|no resumable session|does not support resume|referenc|worktree (?:repository|path|target|alias|checkout|identity)|primary (?:checkout|worktree)|only an available|a room may register|local branch|cwd is not one of the room|live child runtime|unresolved work|git administrative state/.test(lower)
  ) {
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
  const valueFlags = new Set([
    '--acp-executable', '--acp-arg', '--starting-acp-executable', '--starting-acp-arg',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === '--token' && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    else if (argument.startsWith('--token=')) values.push(argument.slice('--token='.length));
    else if (valueFlags.has(argument) && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    else {
      for (const flag of valueFlags) {
        if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
      }
    }
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
function encodeHumanCell(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    if (character === '\\') return '\\\\';
    if (character === '\t') return '\\t';
    if (character === '\r') return '\\r';
    if (character === '\n') return '\\n';
    if (code === 0x1b) return '\\x1b';
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return character;
  }).join('');
}

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
    ].map(encodeHumanCell).join('\t'))
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
  ].map(([key, value]) => `${key}\t${encodeHumanCell(value)}`).join('\n');
}
// harn:end structured-channel-cli-preserves-flat-listing

// harn:assume agent-management-correlates-safe-member-results ref=agent-management-projection
export interface AgentProjection {
  id: string;
  handle: string;
  display_name: string;
  status: string;
  adapter: string;
  cwd?: string;
  policy?: string;
  model?: string;
  thinking?: string;
  purpose?: string;
  custody?: string;
  removed_ts?: string;
}

function projectAgent(member: Member): AgentProjection {
  const adapter = member.harness === 'acp' && member.acp_provider !== undefined
    ? `acp:${member.acp_provider}`
    : member.harness ?? '';
  return {
    id: member.id,
    handle: member.handle,
    display_name: member.display_name,
    status: member.state ?? 'unknown',
    adapter,
    ...(member.cwd !== undefined && { cwd: member.cwd }),
    ...(member.policy !== undefined && { policy: member.policy }),
    ...(member.model !== undefined && { model: member.model }),
    ...(member.thinking !== undefined && { thinking: member.thinking }),
    ...(member.purpose !== undefined && { purpose: member.purpose }),
    ...(member.custody !== undefined && { custody: member.custody }),
    ...(member.removed_ts !== undefined && { removed_ts: member.removed_ts }),
  };
}

function sortedAgents(members: readonly Member[]): AgentProjection[] {
  return members
    .filter((member) => member.kind === 'agent' && member.removed_ts === undefined)
    .map(projectAgent)
    .sort((left, right) => left.handle.localeCompare(right.handle) || left.id.localeCompare(right.id));
}

export function renderAgentList(members: readonly Member[], json: boolean): string {
  const agents = sortedAgents(members);
  if (json) return JSON.stringify(agents);
  return agents
    .map((agent) => [
      agent.id,
      agent.handle,
      agent.display_name,
      agent.status,
      agent.adapter,
      agent.cwd ?? '',
      agent.policy ?? '',
      agent.model ?? '',
      agent.thinking ?? '',
      agent.purpose ?? '',
      agent.custody ?? '',
    ].map(encodeHumanCell).join('\t'))
    .join('\n');
}

export function renderAgent(member: Member, json: boolean): string {
  const agent = projectAgent(member);
  if (json) return JSON.stringify(agent);
  return [
    ['id', agent.id],
    ['handle', agent.handle],
    ['display_name', agent.display_name],
    ['status', agent.status],
    ['adapter', agent.adapter],
    ['cwd', agent.cwd ?? ''],
    ['policy', agent.policy ?? ''],
    ['model', agent.model ?? ''],
    ['thinking', agent.thinking ?? ''],
    ['purpose', agent.purpose ?? ''],
    ['custody', agent.custody ?? ''],
    ['removed_ts', agent.removed_ts ?? ''],
  ].map(([key, value]) => `${key}\t${encodeHumanCell(value)}`).join('\n');
}
// harn:end agent-management-correlates-safe-member-results

// harn:assume management-output-is-json-pure-and-safe ref=management-safe-output
export interface DeletedPresetProjection {
  id: string;
  deleted: true;
}

function projectPreset(preset: AgentPresetPublic): AgentPresetPublic {
  return { ...preset };
}

function sortedPresets(presets: readonly AgentPresetPublic[]): AgentPresetPublic[] {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  return presets
    .map(projectPreset)
    .sort((left, right) => compare(left.label, right.label) || compare(left.id, right.id));
}

const presetHumanFields = (preset: AgentPresetPublic): [string, string][] => [
  ['id', preset.id],
  ['schema_version', String(preset.schema_version)],
  ['created_ts', preset.created_ts],
  ['updated_ts', preset.updated_ts],
  ['label', preset.label],
  ['handle', preset.handle],
  ['display_name', preset.display_name ?? ''],
  ['adapter', preset.adapter],
  ['model', preset.model ?? ''],
  ['thinking', preset.thinking ?? ''],
  ['policy', preset.policy ?? ''],
  ['custom_acp', preset.custom_acp === true ? 'true' : ''],
];

export function renderAgentPresetList(
  presets: readonly AgentPresetPublic[],
  json: boolean,
): string {
  const sorted = sortedPresets(presets);
  if (json) return JSON.stringify(sorted);
  return sorted.map((preset) => [
    preset.id,
    preset.label,
    preset.handle,
    preset.display_name ?? '',
    preset.adapter,
    preset.model ?? '',
    preset.thinking ?? '',
    preset.policy ?? '',
    preset.custom_acp === true ? 'true' : '',
    preset.created_ts,
    preset.updated_ts,
  ].map(encodeHumanCell).join('\t')).join('\n');
}

export function renderAgentPreset(preset: AgentPresetPublic, json: boolean): string {
  if (json) return JSON.stringify(projectPreset(preset));
  return presetHumanFields(preset)
    .map(([key, value]) => `${key}\t${encodeHumanCell(value)}`)
    .join('\n');
}

export function renderDeletedPreset(result: DeletedPresetProjection, json: boolean): string {
  return json
    ? JSON.stringify(result)
    : `id\t${encodeHumanCell(result.id)}\ndeleted\ttrue`;
}

export function renderDefaultRoster(roster: DefaultRoster, json: boolean): string {
  if (json) return JSON.stringify(roster);
  return roster.preset_ids
    .map((presetId, ordinal) => `${String(ordinal)}\t${encodeHumanCell(presetId)}`)
    .join('\n');
}
// harn:end management-output-is-json-pure-and-safe

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

// harn:assume management-frames-correlate-one-result ref=management-correlation-client
// harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-management-client
export async function listManagedAgentPresets(client: ProtocolClient): Promise<AgentPresetPublic[]> {
  try {
    const ref = randomUUID();
    client.send({ type: 'list_agent_presets', ref });
    const response = await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'agent_presets' }> =>
      frame.type === 'agent_presets');
    return sortedPresets(response.presets);
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function createManagedAgentPreset(
  client: ProtocolClient,
  input: AgentPresetInput,
): Promise<AgentPresetPublic> {
  try {
    const ref = randomUUID();
    client.send({ type: 'create_agent_preset', ref, input });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'agent_preset' }> =>
      frame.type === 'agent_preset')).preset;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function updateManagedAgentPreset(
  client: ProtocolClient,
  presetId: string,
  input: AgentPresetInput,
): Promise<AgentPresetPublic> {
  try {
    const ref = randomUUID();
    client.send({ type: 'update_agent_preset', ref, preset_id: presetId, input });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'agent_preset' }> =>
      frame.type === 'agent_preset')).preset;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function deleteManagedAgentPreset(
  client: ProtocolClient,
  presetId: string,
): Promise<DeletedPresetProjection> {
  try {
    const ref = randomUUID();
    client.send({ type: 'delete_agent_preset', ref, preset_id: presetId });
    const result = await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'agent_preset_deleted' }> =>
      frame.type === 'agent_preset_deleted');
    return { id: result.id, deleted: result.deleted };
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function getManagedDefaultRoster(client: ProtocolClient): Promise<DefaultRoster> {
  try {
    const ref = randomUUID();
    client.send({ type: 'get_default_roster', ref });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'default_roster' }> =>
      frame.type === 'default_roster')).roster;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function setManagedDefaultRoster(
  client: ProtocolClient,
  presetIds: readonly string[],
): Promise<DefaultRoster> {
  try {
    if (new Set(presetIds).size !== presetIds.length) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.conflict,
        'default roster preset ids must be unique',
      );
    }
    const ref = randomUUID();
    client.send({ type: 'set_default_roster', ref, input: { preset_ids: [...presetIds] } });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'default_roster' }> =>
      frame.type === 'default_roster')).roster;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

// harn:end structured-preset-and-roster-cli-is-safe-and-ordered

export interface AddManagedPresetAgentRequest {
  preset_id: string;
  handle?: string;
  cwd: string;
  policy?: Policy;
  model?: string;
  thinking?: ThinkingLevel;
  display_name?: string;
  purpose?: string;
}

export async function addManagedPresetAgent(
  client: ProtocolClient,
  room: string,
  request: AddManagedPresetAgentRequest,
): Promise<Member> {
  try {
    const ref = randomUUID();
    client.send({ type: 'add_agent', room, ref, ...request });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'member' }> =>
      frame.type === 'member')).member;
  } catch (error) {
    throw classifyManagementError(error);
  }
}
// harn:end management-frames-correlate-one-result

// harn:assume agent-management-correlates-safe-member-results ref=agent-management-correlation-client
export interface AddManagedAgentRequest {
  adapter: string;
  handle: string;
  cwd: string;
  policy?: Policy;
  model?: string;
  thinking?: ThinkingLevel;
  display_name?: string;
  purpose?: string;
}

export async function listManagedAgents(client: ProtocolClient, room: string): Promise<Member[]> {
  try {
    const ref = randomUUID();
    client.send({ type: 'list_agents', room, ref });
    const response = await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'agents' }> =>
      frame.type === 'agents');
    return response.agents
      .filter((member) => member.kind === 'agent' && member.removed_ts === undefined)
      .sort((left, right) => left.handle.localeCompare(right.handle) || left.id.localeCompare(right.id));
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function addManagedAgent(
  client: ProtocolClient,
  room: string,
  request: AddManagedAgentRequest,
): Promise<Member> {
  try {
    const ref = randomUUID();
    client.send({ type: 'add_agent', room, ref, ...request });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'member' }> =>
      frame.type === 'member')).member;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export type ManagedAgentMutation = Extract<
  Act,
  { act: 'configure' | 'rename' | 'pause' | 'revive' | 'remove' }
>;

export async function mutateManagedAgent(
  client: ProtocolClient,
  room: string,
  act: ManagedAgentMutation,
): Promise<Member> {
  try {
    const ref = randomUUID();
    client.send({ type: 'act', room, ref, act });
    return (await correlatedManagementFrame(client, ref, (frame): frame is Extract<ServerFrame, { type: 'member' }> =>
      frame.type === 'member')).member;
  } catch (error) {
    throw classifyManagementError(error);
  }
}

export async function resolveManagedAgent(
  client: ProtocolClient,
  room: string,
  target: string,
): Promise<Member> {
  const wanted = target.replace(/^@/, '');
  const members = await listManagedAgents(client, room);
  const found = members.find((member) => member.id === wanted)
    ?? members.find((member) => member.handle === wanted);
  if (found === undefined) throw new ManagementError(MANAGEMENT_EXIT_CODES.notFound, `no such agent ${target}`);
  return found;
}
// harn:end agent-management-correlates-safe-member-results

// harn:assume channel-archive-requires-explicit-confirmation ref=management-confirmation-helper
export interface ConfirmationOptions {
  label: string;
  yes?: boolean;
  json?: boolean;
  isTTY: boolean;
  stderr: (line: string) => void;
  confirm?: (prompt: string) => Promise<string | boolean>;
  action?: 'archive' | 'remove' | 'delete-preset';
}

// harn:assume agent-remove-requires-explicit-confirmation ref=management-agent-remove-confirmation
export async function confirmManagementAction(options: ConfirmationOptions): Promise<void> {
  if (options.yes === true) return;
  const action = options.action ?? 'archive';
  if (options.json === true || !options.isTTY) {
    const message = action === 'archive'
      ? 'channel archive requires --yes in noninteractive or JSON mode'
      : action === 'remove'
        ? 'agent removal requires --yes in noninteractive or JSON mode'
        : 'agent preset deletion requires --yes in noninteractive or JSON mode';
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      message,
    );
  }
  const prompt = action === 'archive'
    ? `Archive channel ${options.label}? [y/N]`
    : action === 'remove'
      ? `Remove agent ${options.label}? [y/N]`
      : `Delete agent preset ${options.label}? [y/N]`;
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
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      action === 'archive'
        ? 'channel archive cancelled'
        : action === 'remove'
          ? 'agent removal cancelled'
          : 'agent preset deletion cancelled',
    );
  }
}
// harn:end agent-remove-requires-explicit-confirmation

export async function confirmArchive(options: ConfirmationOptions): Promise<void> {
  return confirmManagementAction({ ...options, action: 'archive' });
}

export async function confirmAgentRemove(options: ConfirmationOptions): Promise<void> {
  return confirmManagementAction({ ...options, action: 'remove' });
}

// harn:assume preset-deletion-requires-explicit-confirmation ref=preset-delete-confirmation
export async function confirmAgentPresetDelete(options: ConfirmationOptions): Promise<void> {
  // The stored label is intentionally preserved; only its human prompt form is escaped.
  return confirmManagementAction({
    ...options,
    label: encodeHumanCell(options.label),
    action: 'delete-preset',
  });
}
// harn:end preset-deletion-requires-explicit-confirmation
// harn:end channel-archive-requires-explicit-confirmation
