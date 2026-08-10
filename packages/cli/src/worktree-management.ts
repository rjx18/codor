import { createInterface } from 'node:readline/promises';

import {
  WorktreeAdoptRequestSchema,
  WorktreeCreateRequestSchema,
  WorktreeListResponseSchema,
  WorktreeLifecycleResponseSchema,
  WorktreeRemovalPreviewResponseSchema,
  type RegisteredWorktree,
  type WorktreeAdoptRequest,
  type WorktreeCreateRequest,
  type WorktreeListResponse,
  type WorktreeRemovalPreviewResponse,
} from '@codor/protocol';

import {
  classifyManagementError,
  MANAGEMENT_EXIT_CODES,
  ManagementError,
} from './management.js';

export interface WorktreeRestClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

export interface WorktreeRepositoryProjection {
  id: string;
  room: string;
  primary_path: string;
}

export interface WorktreeProjection {
  id: string;
  alias: string;
  path: string;
  conversation_id: string;
  primary: boolean;
  source: RegisteredWorktree['source'];
  lifecycle: RegisteredWorktree['lifecycle'];
  availability: RegisteredWorktree['availability'];
  locked: boolean;
  branch?: string;
  head?: string;
}

export interface WorktreeDiscoveryProjection {
  path: string;
  primary: boolean;
  availability: RegisteredWorktree['availability'];
  locked: boolean;
  branch?: string;
  head?: string;
  registered_id?: string;
  alias?: string;
  conversation_id?: string;
}

export interface WorktreeListProjection {
  repository: WorktreeRepositoryProjection | null;
  registered: WorktreeProjection[];
  discovered: WorktreeDiscoveryProjection[];
}

export interface WorktreeRemovalPreviewProjection {
  worktree: WorktreeProjection;
  state: WorktreeRemovalPreviewResponse['state'];
  branch_preserved: true;
  detail?: string;
}

export interface WorktreeRemovalConfirmationOptions {
  alias: string;
  path: string;
  yes?: boolean;
  json?: boolean;
  isTTY: boolean;
  stderr: (line: string) => void;
  confirm?: (prompt: string) => Promise<string | boolean>;
}

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

interface SafeParseSchema<T> {
  safeParse(value: unknown): ParseResult<T>;
}

// harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-management-client
export function escapeWorktreeHumanCell(value: string): string {
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

const compareBytes = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

function projectRegistered(worktree: RegisteredWorktree): WorktreeProjection {
  return {
    id: worktree.id,
    alias: worktree.alias,
    path: worktree.path,
    conversation_id: worktree.conversation_id,
    primary: worktree.primary,
    source: worktree.source,
    lifecycle: worktree.lifecycle,
    availability: worktree.availability,
    locked: worktree.locked,
    ...(worktree.branch !== undefined && { branch: worktree.branch }),
    ...(worktree.head !== undefined && { head: worktree.head }),
  };
}

function projectDiscovered(candidate: WorktreeListResponse['discovered'][number]): WorktreeDiscoveryProjection {
  return {
    path: candidate.path,
    primary: candidate.primary,
    availability: candidate.availability,
    locked: candidate.locked,
    ...(candidate.branch !== undefined && { branch: candidate.branch }),
    ...(candidate.head !== undefined && { head: candidate.head }),
    ...(candidate.registered_id !== undefined && { registered_id: candidate.registered_id }),
    ...(candidate.alias !== undefined && { alias: candidate.alias }),
    ...(candidate.conversation_id !== undefined && { conversation_id: candidate.conversation_id }),
  };
}

export function projectWorktreeList(response: WorktreeListResponse): WorktreeListProjection {
  const registered = response.registered
    .map(projectRegistered)
    .sort((left, right) => (
      Number(right.primary) - Number(left.primary)
      || compareBytes(left.alias, right.alias)
      || compareBytes(left.id, right.id)
    ));
  const discovered = response.discovered
    .map(projectDiscovered)
    .sort((left, right) => (
      Number(right.primary) - Number(left.primary)
      || compareBytes(left.path, right.path)
    ));
  return {
    repository: response.repository === null
      ? null
      : {
          id: response.repository.id,
          room: response.repository.room,
          primary_path: response.repository.primary_path,
        },
    registered,
    discovered,
  };
}

const registeredHumanRow = (worktree: WorktreeProjection): string => [
  'registered',
  worktree.id,
  worktree.alias,
  worktree.path,
  worktree.conversation_id,
  String(worktree.primary),
  worktree.source,
  worktree.lifecycle,
  worktree.availability,
  String(worktree.locked),
  worktree.branch ?? '',
  worktree.head ?? '',
].map(escapeWorktreeHumanCell).join('\t');

const discoveredHumanRow = (worktree: WorktreeDiscoveryProjection): string => [
  'discovered',
  worktree.path,
  String(worktree.primary),
  worktree.availability,
  String(worktree.locked),
  worktree.branch ?? '',
  worktree.head ?? '',
  worktree.registered_id ?? '',
  worktree.alias ?? '',
  worktree.conversation_id ?? '',
].map(escapeWorktreeHumanCell).join('\t');

export function renderWorktreeList(value: WorktreeListProjection, json: boolean): string {
  if (json) return JSON.stringify(value);
  const repository = value.repository === null
    ? ['repository', '', '', '']
    : ['repository', value.repository.id, value.repository.room, value.repository.primary_path];
  return [
    repository.map(escapeWorktreeHumanCell).join('\t'),
    ...value.registered.map(registeredHumanRow),
    ...value.discovered.map(discoveredHumanRow),
  ].join('\n');
}

export function renderWorktree(value: WorktreeProjection, json: boolean): string {
  if (json) return JSON.stringify(value);
  return registeredHumanRow(value);
}
// harn:end structured-worktree-cli-targets-branches-and-child-rooms

function apiPath(room: string): string {
  return `/api/rooms/${encodeURIComponent(room)}/worktrees`;
}

function withCwd(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path;
  return `${path}?${new URLSearchParams({ cwd }).toString()}`;
}

function parseResponse<T>(schema: SafeParseSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.transport,
      `invalid worktree ${label} response`,
    );
  }
  return parsed.data;
}

function parseRequest<T>(schema: SafeParseSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      `invalid worktree ${label}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function safeWorktreeError(error: unknown): ManagementError {
  const classified = classifyManagementError(error);
  const message = escapeWorktreeHumanCell(classified.message);
  if (message === classified.message) return classified;
  return new ManagementError(classified.exitCode, message, { cause: error });
}

async function callWorktree<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw safeWorktreeError(error);
  }
}

// harn:assume structured-worktree-cli-targets-branches-and-child-rooms ref=branch-worktree-management-client
export async function listWorktrees(
  client: WorktreeRestClient,
  room: string,
  cwd?: string,
): Promise<WorktreeListProjection> {
  return callWorktree(async () => {
    const value = await client.get(withCwd(apiPath(room), cwd));
    return projectWorktreeList(parseResponse(WorktreeListResponseSchema, value, 'list'));
  });
}

function projectLifecycle(value: unknown): WorktreeProjection {
  return projectRegistered(parseResponse(WorktreeLifecycleResponseSchema, value, 'lifecycle').worktree);
}

export async function adoptWorktree(
  client: WorktreeRestClient,
  room: string,
  request: WorktreeAdoptRequest,
  cwd?: string,
): Promise<WorktreeProjection> {
  return callWorktree(async () => {
    const body = parseRequest(WorktreeAdoptRequestSchema, request, 'adopt arguments');
    return projectLifecycle(await client.post(withCwd(`${apiPath(room)}/adopt`, cwd), body));
  });
}

export async function createWorktree(
  client: WorktreeRestClient,
  room: string,
  request: WorktreeCreateRequest,
  cwd?: string,
): Promise<WorktreeProjection> {
  return callWorktree(async () => {
    const body = parseRequest(WorktreeCreateRequestSchema, request, 'create arguments');
    return projectLifecycle(await client.post(withCwd(apiPath(room), cwd), body));
  });
}

export async function removeWorktree(
  client: WorktreeRestClient,
  room: string,
  worktreeId: string,
  cwd?: string,
): Promise<WorktreeProjection> {
  void cwd;
  return callWorktree(async () => projectLifecycle(
    await client.post(`${apiPath(room)}/${encodeURIComponent(worktreeId)}/unregister`, {}),
  ));
}

export async function previewWorktreeRemoval(
  client: WorktreeRestClient,
  room: string,
  worktreeId: string,
  cwd?: string,
): Promise<WorktreeRemovalPreviewProjection> {
  return callWorktree(async () => {
    const value = parseResponse(
      WorktreeRemovalPreviewResponseSchema,
      await client.get(withCwd(`${apiPath(room)}/${encodeURIComponent(worktreeId)}/removal-preview`, cwd)),
      'removal preview',
    );
    if (value.worktree.id !== worktreeId) {
      throw new ManagementError(
        MANAGEMENT_EXIT_CODES.transport,
        'worktree removal preview identity mismatch',
      );
    }
    return {
      worktree: projectRegistered(value.worktree),
      state: value.state,
      branch_preserved: true,
      ...(value.detail !== undefined && { detail: value.detail }),
    };
  });
}

export async function removeFilesystemWorktree(
  client: WorktreeRestClient,
  room: string,
  worktreeId: string,
  cwd?: string,
): Promise<WorktreeProjection> {
  return callWorktree(async () => projectLifecycle(
    await client.post(withCwd(`${apiPath(room)}/${encodeURIComponent(worktreeId)}/remove`, cwd), {}),
  ));
}

export function resolveWorktreeSelector(
  registered: readonly WorktreeProjection[],
  selector: string,
): WorktreeProjection {
  const exact = registered.filter((worktree) => worktree.branch === selector);
  const matches = exact.length > 0
    ? exact
    : registered.filter((worktree) => worktree.alias === selector);
  if (matches.length === 0) {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.notFound, `no such worktree ${escapeWorktreeHumanCell(selector)}`);
  }
  if (matches.length > 1) {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.conflict, `worktree selector ${escapeWorktreeHumanCell(selector)} is ambiguous; use the exact branch`);
  }
  const found = matches[0]!;
  if (found.primary) {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.conflict, 'the primary worktree cannot be removed');
  }
  if (found.lifecycle !== 'active') {
    throw new ManagementError(MANAGEMENT_EXIT_CODES.conflict, `worktree ${escapeWorktreeHumanCell(found.alias)} is not active`);
  }
  return found;
}
// harn:end structured-worktree-cli-targets-branches-and-child-rooms

// harn:assume worktree-cli-removal-requires-previewed-consent ref=worktree-removal-confirmation
export async function confirmWorktreeRemoval(options: WorktreeRemovalConfirmationOptions): Promise<void> {
  if (options.yes === true) return;
  if (options.json === true || !options.isTTY) {
    throw new ManagementError(
      MANAGEMENT_EXIT_CODES.invocation,
      'worktree removal requires --yes in noninteractive or JSON mode',
    );
  }
  const prompt = `Remove worktree ${escapeWorktreeHumanCell(options.alias)} at ${escapeWorktreeHumanCell(options.path)}? Branch will be preserved. [y/N]`;
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
  if (typeof answer === 'boolean' ? answer : /^(?:y|yes)$/i.test(answer.trim())) return;
  throw new ManagementError(MANAGEMENT_EXIT_CODES.invocation, 'worktree removal cancelled');
}
// harn:end worktree-cli-removal-requires-previewed-consent
