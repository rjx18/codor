import type { Room, ServerFrame } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGEMENT_EXIT_CODES,
  ManagementError,
  cliExitCode,
  classifyManagementError,
  confirmArchive,
  listManagedRooms,
  redactDiagnostic,
  renderChannel,
  renderChannelList,
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
    for (const id of ['unauthorized', 'bearer', '401']) {
      expect(cliExitCode(classifyManagementError(new Error(`no such channel ${id}`)))).toBe(
        MANAGEMENT_EXIT_CODES.notFound,
      );
    }
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
});
// harn:end channel-archive-requires-explicit-confirmation
