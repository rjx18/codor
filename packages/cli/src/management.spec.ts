import type { AgentPresetPublic, Member, Room, ServerFrame } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGEMENT_EXIT_CODES,
  ManagementError,
  cliExitCode,
  classifyManagementError,
  confirmAgentRemove,
  confirmAgentPresetDelete,
  confirmArchive,
  listManagedAgentPresets,
  listManagedRooms,
  listManagedAgents,
  redactDiagnostic,
  renderChannel,
  renderChannelList,
  renderAgent,
  renderAgentList,
} from './management.js';
import type { ProtocolClient } from './connection.js';
import { runCli } from './program.js';

const room = {
  id: 'eng',
  name: 'Engineering',
  created_ts: '2026-08-06T00:00:00.000Z',
  config: {
    turn_brake: null,
    spend_brake_usd: null,
    stall_minutes: 30,
    redaction_enabled: true,
    bridged: false,
    color: '#80c56d',
    cwd: '/work/project',
  },
} satisfies Room;

const agent = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  kind: 'agent',
  handle: 'worker',
  display_name: 'Worker\t\u001b[31m',
  purpose: 'safe\npurpose',
  harness: 'acp',
  acp_provider: 'kimi',
  session_ref: 'native-session-secret',
  cwd: '/work/project',
  policy: 'read-only',
  model: 'safe-model',
  thinking: 'high',
  host: 'private-host',
  state: 'idle',
  custody: 'owned',
} satisfies Member;

// harn:assume management-output-is-json-pure-and-safe ref=management-output-regression
describe('management output', () => {
  it('renders a safe stable projection and one compact JSON value', () => {
    const json = renderChannelList([room], true);
    expect(json).toBe(JSON.stringify([{
      id: 'eng', name: 'Engineering', status: 'active', created_ts: room.created_ts,
      color: '#80c56d', cwd: '/work/project',
    }]));
    expect(json).not.toContain('member');
    expect(renderChannel(room, false)).toBe([
      'id\teng',
      'name\tEngineering',
      'status\tactive',
      `created_ts\t${room.created_ts}`,
      'archived_ts\t',
      'color\t#80c56d',
      'cwd\t/work/project',
    ].join('\n'));
  });

  it('escapes hostile human cells without changing JSON values', () => {
    const hostile = {
      ...room,
      name: 'Name\trow\r\n\u001b[31m\\tail',
      config: {
        ...room.config,
        color: 'blue\u0001\tgreen',
        cwd: '/work/\u007fproject',
      },
    } satisfies Room;
    const projected = JSON.parse(renderChannelList([hostile], true)) as Array<{
      name: string;
      color?: string;
      cwd?: string;
    }>;
    expect(projected[0]).toMatchObject({
      name: hostile.name,
      color: hostile.config.color,
      cwd: hostile.config.cwd,
    });

    const rawControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
    const list = renderChannelList([hostile], false);
    expect(list.split('\n')).toHaveLength(1);
    for (const cell of list.split('\t')) expect(cell).not.toMatch(rawControl);
    expect(list).toContain('Name\\trow\\r\\n\\x1b[31m\\\\tail');

    const shown = renderChannel(hostile, false);
    expect(shown.split('\n')).toHaveLength(7);
    for (const line of shown.split('\n')) {
      expect(line.split('\t')).toHaveLength(2);
      expect(line.split('\t')[1]).not.toMatch(rawControl);
    }
  });

  it('projects agents in deterministic order without native identity or control bytes', () => {
    const other = {
      ...agent,
      id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      handle: 'alpha',
      display_name: 'Alpha',
    } satisfies Member;
    const human = {
      id: '01C4F6Y9J4QJ5F4KZ5T6X2V3W4',
      kind: 'human',
      handle: 'richard',
      display_name: 'Richard',
    } satisfies Member;
    const removed = { ...agent, removed_ts: '2026-08-06T01:00:00.000Z' } satisfies Member;

    const parsed = JSON.parse(renderAgentList([agent, removed, human, other], true)) as Array<Record<string, unknown>>;
    expect(parsed.map((entry) => entry.handle)).toEqual(['alpha', 'worker']);
    expect(parsed[1]).toMatchObject({ adapter: 'acp:kimi', purpose: 'safe\npurpose' });
    expect(parsed[1]).not.toHaveProperty('session_ref');
    expect(parsed[1]).not.toHaveProperty('host');
    expect(renderAgent(agent, true)).not.toMatch(/native-session-secret|private-host/);

    const humanRows = renderAgentList([agent], false);
    expect(humanRows).toContain('Worker\\t\\x1b[31m');
    expect(humanRows).toContain('safe\\npurpose');
    expect(humanRows).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});
// harn:end management-output-is-json-pure-and-safe

// harn:assume management-failures-have-stable-redacted-exits ref=management-error-regression
describe('management failures', () => {
  it('keeps stable codes and redacts bearer-bearing diagnostics', () => {
    const failure = new ManagementError(
      MANAGEMENT_EXIT_CODES.authorization,
      'forbidden: Bearer secret at https://host.test/ws?token=secret',
    );
    expect(cliExitCode(failure)).toBe(4);
    const message = redactDiagnostic(
      failure,
      ['node', 'codor', '--token', 'secret'],
      { CODOR_TOKEN: 'secret' },
    );
    expect(message).toBe('forbidden: Bearer <redacted> at https://host.test/ws?token=<redacted>');
    expect(cliExitCode(classifyManagementError(new Error('channel eng is archived and cannot be renamed')))).toBe(
      MANAGEMENT_EXIT_CODES.conflict,
    );
    expect(cliExitCode(classifyManagementError(new Error('forbidden: admin cannot rename room')))).toBe(
      MANAGEMENT_EXIT_CODES.authorization,
    );
    expect(cliExitCode(classifyManagementError(new Error('--token, CODOR_TOKEN, or CODOR_MEMBER_TOKEN is required')))).toBe(
      MANAGEMENT_EXIT_CODES.authentication,
    );

    const worktreeFailures = [
      ['worktree target must be absolute', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree target parent must already exist', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree target parent must be a directory', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree path must be absolute', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree path does not exist', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree path must be a directory', MANAGEMENT_EXIT_CODES.invocation],
      ['worktree alias must be a non-main label', MANAGEMENT_EXIT_CODES.invocation],
      ['invalid local branch name: bad branch', MANAGEMENT_EXIT_CODES.invocation],
      ['cwd is not inside a Git worktree', MANAGEMENT_EXIT_CODES.invocation],
      ["cwd is not one of the room's known directories", MANAGEMENT_EXIT_CODES.invocation],
      ['worktree target already exists', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree target is dirty', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree target is missing', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree path is not a discovered candidate', MANAGEMENT_EXIT_CODES.conflict],
      ['the primary checkout is registered as main, not adoptable', MANAGEMENT_EXIT_CODES.conflict],
      ['only an available, unlocked worktree can be adopted', MANAGEMENT_EXIT_CODES.conflict],
      ['the primary checkout is unavailable', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree target overlaps an existing checkout', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree target overlaps Git administrative state', MANAGEMENT_EXIT_CODES.conflict],
      ['the primary checkout has no commit HEAD', MANAGEMENT_EXIT_CODES.conflict],
      ['created worktree belongs to a different repository', MANAGEMENT_EXIT_CODES.conflict],
      ['created worktree could not be rediscovered', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree was created but registration failed: a room may register only one Git repository', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree repository is not registered', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree belongs to a different or unavailable repository', MANAGEMENT_EXIT_CODES.conflict],
      ['registered worktree is missing or mismatched', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree path is missing', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree is locked, prunable, or unavailable', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree must be clean before removal', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree cannot be removed', MANAGEMENT_EXIT_CODES.conflict],
      ['worktree alias is already in use: child', MANAGEMENT_EXIT_CODES.conflict],
      ['the main alias is reserved', MANAGEMENT_EXIT_CODES.conflict],
      ['a room may register only one Git repository', MANAGEMENT_EXIT_CODES.conflict],
      ['local branch already exists: feature/main', MANAGEMENT_EXIT_CODES.conflict],
      ['registered worktree identity does not match Git', MANAGEMENT_EXIT_CODES.conflict],
      ['could not verify local branch: feature/new', MANAGEMENT_EXIT_CODES.conflict],
      ['no active worktree: 01ARZ3NDEKTSV4RRFFQ69G5FAV', MANAGEMENT_EXIT_CODES.conflict],
      ['only an active secondary worktree can be unregistered: 01ARZ3NDEKTSV4RRFFQ69G5FAV', MANAGEMENT_EXIT_CODES.conflict],
      ['only an active secondary worktree can be removed', MANAGEMENT_EXIT_CODES.conflict],
      ['cannot remove worktree child: live child runtime or unresolved work remains', MANAGEMENT_EXIT_CODES.conflict],
      ['room has no existing repository cwd', MANAGEMENT_EXIT_CODES.conflict],
      ['fetch failed', MANAGEMENT_EXIT_CODES.transport],
      ['invalid worktree list response', MANAGEMENT_EXIT_CODES.transport],
      ['protocol framing failed', MANAGEMENT_EXIT_CODES.transport],
    ] as const;
    for (const [messageText, expected] of worktreeFailures) {
      expect(cliExitCode(classifyManagementError(new Error(messageText))), messageText).toBe(expected);
    }
    for (const id of ['unauthorized', 'bearer', '401']) {
      expect(cliExitCode(classifyManagementError(new Error(`no such channel ${id}`)))).toBe(
        MANAGEMENT_EXIT_CODES.notFound,
      );
      expect(cliExitCode(classifyManagementError(new Error(`no such agent ${id}`)))).toBe(
        MANAGEMENT_EXIT_CODES.notFound,
      );
    }
    expect(cliExitCode(classifyManagementError(new Error("adapter 'missing' is not installed on the daemon host"))))
      .toBe(MANAGEMENT_EXIT_CODES.conflict);
    expect(cliExitCode(classifyManagementError(new Error('cannot pause @worker during an active turn; stop the turn first'))))
      .toBe(MANAGEMENT_EXIT_CODES.conflict);
    expect(cliExitCode(classifyManagementError(new Error(
      'member @worker is mirrored from another switchboard; configure it there',
    )))).toBe(MANAGEMENT_EXIT_CODES.conflict);
    expect(cliExitCode(classifyManagementError(new Error('member @worker has no resumable session'))))
      .toBe(MANAGEMENT_EXIT_CODES.conflict);
    expect(cliExitCode(classifyManagementError(new Error("adapter 'fake' does not support resume"))))
      .toBe(MANAGEMENT_EXIT_CODES.conflict);
    expect(cliExitCode(classifyManagementError(new Error("adapter 'fake' does not support thinking level 'ultra'"))))
      .toBe(MANAGEMENT_EXIT_CODES.invocation);
    expect(cliExitCode(classifyManagementError(new Error(
      "model 'stale-model' is not currently offered by harness 'fake'",
    )))).toBe(MANAGEMENT_EXIT_CODES.conflict);
    const schemaFailure = new Error('Invalid input') as Error & { issues: unknown[] };
    schemaFailure.name = 'ZodError';
    schemaFailure.issues = [];
    expect(cliExitCode(classifyManagementError(schemaFailure))).toBe(MANAGEMENT_EXIT_CODES.invocation);
  });

  it('normalizes malformed structured invocations to one typed invocation failure', async () => {
    const invoke = async (args: string[]) => {
      const stderr: string[] = [];
      let error: unknown;
      try {
        await runCli(['node', 'codor', ...args], {
          env: {},
          stdout: () => undefined,
          stderr: (line) => stderr.push(line),
        });
      } catch (caught) {
        error = caught;
      }
      return { error, stderr };
    };

    for (const args of [
      ['channel'],
      ['channel', 'create'],
      ['channel', 'create', 'Missing Owner'],
      ['channel', 'list', '--unknown'],
      ['channel', 'unknown'],
      ['agent'],
      ['agent', 'add'],
      ['agent', 'list'],
    ]) {
      const result = await invoke(args);
      expect(result.error).toMatchObject({
        name: 'ManagementError',
        exitCode: MANAGEMENT_EXIT_CODES.invocation,
      });
      expect(result.stderr).toEqual([]);
    }
  });
});
// harn:end management-failures-have-stable-redacted-exits

// harn:assume management-frames-correlate-one-result ref=management-correlation-cli-regression
describe('management correlation', () => {
  // harn:assume agent-management-correlates-safe-member-results ref=agent-management-client-regression
  it('ignores unrelated member traffic until the matching agent snapshot', async () => {
    const frames: ServerFrame[] = [
      { type: 'member', seq: 1, room: 'eng', member: agent, ref: 'other-request' },
    ];
    const send = vi.fn((frame: { type: string; ref?: string }) => {
      if (frame.type === 'list_agents' && frame.ref !== undefined) {
        frames.push({ type: 'agents', room: 'eng', agents: [agent], ref: frame.ref });
      }
    });
    const client = {
      send,
      next: async () => frames.shift()!,
    } as unknown as ProtocolClient;

    const listed = await listManagedAgents(client, 'eng');
    expect(listed).toEqual([agent]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'list_agents', room: 'eng', ref: expect.any(String),
    }));
  });

  it('ignores unrelated results and errors until the matching rooms reply', async () => {
    const frames: ServerFrame[] = [
      { type: 'error', ref: 'other-request', message: 'unrelated failure' },
      { type: 'rooms', ref: 'other-request', rooms: [room], room_seqs: { eng: 1 } },
    ];
    const send = vi.fn((frame: { ref?: string }) => {
      frames.push({ type: 'rooms', ref: frame.ref, rooms: [room], room_seqs: { eng: 1 } });
    });
    const client = {
      send,
      next: async () => frames.shift()!,
    } as unknown as ProtocolClient;

    const listed = await listManagedRooms(client, { all: true });

    expect(listed.map((candidate) => candidate.id)).toEqual(['eng']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'list_rooms', all: true, ref: expect.any(String),
    }));
  });
  // harn:end agent-management-correlates-safe-member-results
});
// harn:end management-frames-correlate-one-result

// harn:assume channel-archive-requires-explicit-confirmation ref=channel-archive-confirmation-regression
describe('archive confirmation', () => {
  it('requires yes for unattended and JSON calls, and accepts only yes/ y interactively', async () => {
    const stderr: string[] = [];
    await expect(confirmArchive({
      label: 'eng', json: true, isTTY: true, stderr: (line) => stderr.push(line),
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    await expect(confirmArchive({
      label: 'eng', isTTY: false, stderr: (line) => stderr.push(line),
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    await expect(confirmArchive({
      label: 'eng', isTTY: true, stderr: (line) => stderr.push(line),
      confirm: async () => 'no',
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    await confirmArchive({
      label: 'eng', isTTY: true, stderr: (line) => stderr.push(line),
      confirm: async () => 'YES',
    });
    await confirmArchive({ label: 'eng', yes: true, isTTY: false, stderr: () => undefined });
    expect(stderr).toEqual(['Archive channel eng? [y/N]', 'Archive channel eng? [y/N]']);
  });

  it('uses the same explicit confirmation boundary for agent removal', async () => {
    const stderr: string[] = [];
    await expect(confirmAgentRemove({
      label: '@worker in channel eng', isTTY: false, stderr: (line) => stderr.push(line),
    })).rejects.toMatchObject({
      exitCode: MANAGEMENT_EXIT_CODES.invocation,
      message: 'agent removal requires --yes in noninteractive or JSON mode',
    });
    await expect(confirmAgentRemove({
      label: '@worker in channel eng', isTTY: true, stderr: (line) => stderr.push(line),
      confirm: async () => 'no',
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    await confirmAgentRemove({
      label: '@worker in channel eng', isTTY: true, stderr: (line) => stderr.push(line),
      confirm: async () => 'yes',
    });
    expect(stderr).toEqual([
      'Remove agent @worker in channel eng? [y/N]',
      'Remove agent @worker in channel eng? [y/N]',
    ]);
  });
});
// harn:end channel-archive-requires-explicit-confirmation

// harn:assume preset-deletion-requires-explicit-confirmation ref=preset-delete-confirmation-regression
describe('preset deletion confirmation', () => {
  it('escapes a hostile stored label into one safe stderr prompt line', async () => {
    const stderr: string[] = [];
    const hostile = 'Hostile\tlabel\r\n\u001b[31m\\tail';
    await expect(confirmAgentPresetDelete({
      label: `${hostile} (01ARZ3NDEKTSV4RRFFQ69G5FAV)`,
      isTTY: true,
      stderr: (line) => stderr.push(line),
      confirm: async () => false,
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    expect(stderr).toEqual([[
      'Delete agent preset Hostile\\tlabel\\r\\n\\x1b[31m\\\\tail',
      ' (01ARZ3NDEKTSV4RRFFQ69G5FAV)? [y/N]',
    ].join('')]);
    expect(stderr[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(stderr[0]!.split('\n')).toHaveLength(1);
  });
});
// harn:end preset-deletion-requires-explicit-confirmation

// harn:assume management-frames-correlate-one-result ref=management-correlation-cli-regression
// harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-management-client-regression
describe('preset management correlation', () => {
  it('ignores unrelated room, member, preset, and error frames and sorts labels stably', async () => {
    const preset = (label: string, id: string): AgentPresetPublic => ({
      id,
      schema_version: 1,
      created_ts: '2026-08-06T00:00:00.000Z',
      updated_ts: '2026-08-06T00:00:00.000Z',
      label,
      handle: `${label.toLowerCase()}-preset`,
      adapter: 'fake',
    });
    const alpha = preset('Alpha', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const zulu = preset('Zulu', '01BX5ZZKBKACTAV9WEVGEMMVRZ');
    const frames: ServerFrame[] = [
      { type: 'agent_preset', ref: 'other-preset', preset: zulu },
      { type: 'room', seq: 1, ref: 'room-result', room },
      { type: 'member', seq: 1, room: 'eng', ref: 'member-result', member: agent },
      { type: 'error', ref: 'other-error', message: 'unrelated failure' },
    ];
    const send = vi.fn((frame: { type: string; ref?: string }) => {
      if (frame.type === 'list_agent_presets' && frame.ref !== undefined) {
        frames.push({ type: 'agent_presets', ref: frame.ref, presets: [zulu, alpha] });
      }
    });
    const client = {
      send,
      next: async () => frames.shift()!,
    } as unknown as ProtocolClient;

    const listed = await listManagedAgentPresets(client);
    expect(listed.map((candidate) => candidate.label)).toEqual(['Alpha', 'Zulu']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'list_agent_presets', ref: expect.any(String),
    }));
  });
});
// harn:end structured-preset-and-roster-cli-is-safe-and-ordered
// harn:end management-frames-correlate-one-result
