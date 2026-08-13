import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

// harn:assume friendly-schedule-clocks-canonicalize-at-client-boundary ref=client-schedule-canonicalization-regression
describe('client schedule canonicalization', () => {
  it('canonicalizes the same friendly clock across positive, negative, and half-hour offsets', () => {
    const fixed = new Date('2026-08-12T12:00:00.000Z');
    const cases = [
      [480, '[send_at=2026-08-12T20:30:00+08:00]@viewer positive'],
      [-300, '[send_at=2026-08-12T20:30:00-05:00]@viewer negative'],
      [330, '[send_at=2026-08-12T20:30:00+05:30]@viewer half-hour'],
    ] as const;
    for (const [offsetMinutes, expected] of cases) {
      expect(protocol.canonicalizeScheduleRequest('[send_at=8:30PM]' + expected.slice(expected.indexOf(']') + 1), {
        now: fixed, offsetMinutes,
      })).toBe(expected);
    }
    expect(protocol.canonicalizeScheduleRequest('[send_at=11:30PM]@viewer rollover', {
      now: new Date('2026-08-12T18:00:00.000Z'), offsetMinutes: 330,
    })).toBe('[send_at=2026-08-13T23:30:00+05:30]@viewer rollover');
  });

  it('keeps relative, explicit, malformed, and non-leading forms unchanged', () => {
    const now = new Date('2026-08-12T12:00:00.000Z');
    expect(protocol.canonicalizeScheduleRequest('[send_in=2h] @viewer relative', {
      now, offsetMinutes: 480,
    })).toBe('[send_in=2h] @viewer relative');
    expect(protocol.canonicalizeScheduleRequest('[send_at=2026-08-13T08:30:00+08:00] @viewer explicit', {
      now, offsetMinutes: 480,
    })).toBe('[send_at=2026-08-13T08:30:00+08:00] @viewer explicit');
    expect(protocol.canonicalizeScheduleRequest('[send_at=8:30PM @viewer malformed', {
      now, offsetMinutes: 480,
    })).toBe('[send_at=8:30PM @viewer malformed');
    expect(protocol.canonicalizeScheduleRequest('example [send_at=8:30PM] @viewer prose', {
      now, offsetMinutes: 480,
    })).toBe('example [send_at=8:30PM] @viewer prose');
  });
});
// harn:end friendly-schedule-clocks-canonicalize-at-client-boundary

describe('@codor/protocol barrel', () => {
  it('exports every schema surface consumers build on', () => {
    for (const name of [
      'MemberSchema',
      'HandleSchema',
      'AssignableHandleSchema',
      'MessageSchema',
      'MentionSpanSchema',
      'parseBody',
      'AskCardSchema',
      'RunSummarySchema',
      'PendingInteractionSchema',
      'DeliverySchema',
      'ChangeLogEntrySchema',
      'RoomSchema',
      'RoomConfigSchema',
      'RoomMeterSchema',
      'RoomSummarySchema',
      'RoomInboxItemSchema',
      'RoomSupportSchema',
      'CreateRoomRequestSchema',
      'deriveRoomId',
      'PolicySchema',
      'ThinkingLevelSchema',
      'ToolCallPayloadSchema',
      'ToolResultPayloadSchema',
      'TextDeltaPayloadSchema',
      'ReasoningSummaryPayloadSchema',
      'FileChangePayloadSchema',
      'CommitPayloadSchema',
      'parseRunItemPayload',
      'WireEventSchema',
      'ClientFrameSchema',
      'ServerFrameSchema',
      'ScheduleSchema',
      'ScheduleStateSchema',
      'parseScheduleDirective', 'canonicalizeScheduleRequest',
    ] as const) {
      expect(protocol[name], name).toBeDefined();
    }
  });

  it('keeps extension handles as plain text while resolving ordinary agents', () => {
    const agent = protocol.MemberSchema.parse({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      kind: 'agent',
      handle: 'claude',
      display_name: 'Claude',
    });
    const extension = protocol.MemberSchema.parse({
      id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      kind: 'extension',
      handle: 'claude-ext-a4fdb5',
      display_name: 'Review cache',
      parent: agent.id,
    });
    const parsed = protocol.parseBody('@claude inspect @claude-ext-a4fdb5', [agent, extension]);
    expect(parsed.mentions).toEqual([
      expect.objectContaining({ member_id: agent.id }),
    ]);
    expect(parsed.unresolved).toEqual([]);
  });
});

// harn:assume scheduling-directive-is-bounded-and-canonical ref=scheduled-directive-regression
describe('scheduled directive protocol', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');

  it('parses only a complete leading directive into a bounded canonical instant', () => {
    expect(protocol.parseScheduleDirective('  [send_in=2h30m]@sol ship it', {
      now, hostOffsetMinutes: 480,
    })).toMatchObject({
      clean_body: '@sol ship it',
      due_ts: '2026-08-12T14:30:00.000Z',
      host_offset_minutes: 480,
    });
    expect(protocol.parseScheduleDirective('example [send_in=2h] @sol')).toBeUndefined();
    expect(() => protocol.parseScheduleDirective('[send_in=2h30m1h] @sol', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/malformed scheduling directive/);
  });

  it('uses a fixed host offset for clocks and requires offsets on ISO input', () => {
    expect(protocol.parseScheduleDirective('[send_at=8:30PM]@sol evening', {
      now, hostOffsetMinutes: 480,
    })?.due_ts).toBe('2026-08-12T12:30:00.000Z');
    expect(protocol.parseScheduleDirective('[send_at=2026-08-13T08:30:00+08:00] @sol', {
      now, hostOffsetMinutes: 480,
    })?.due_ts).toBe('2026-08-13T00:30:00.000Z');
    expect(() => protocol.parseScheduleDirective('[send_at=2026-08-13T08:30:00] @sol', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/explicit offset/);
  });

  it('keeps recognition at the first token and rejects malformed or case-variant directives', () => {
    expect(protocol.parseScheduleDirective('ordinary [send_in=2h] @sol')).toBeUndefined();
    expect(() => protocol.parseScheduleDirective('[send_in=2h @sol')).toThrow(/malformed/);
    expect(() => protocol.parseScheduleDirective('[send_in=2h]')).toThrow(/body/);
    expect(() => protocol.parseScheduleDirective('[SEND_IN=2h] @sol case', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/malformed/);
  });

  it('accepts every ordered relative unit and refuses duplicates or descending units', () => {
    expect(protocol.parseScheduleDirective('[send_in=1d2h3m4s]@sol all units', {
      now, hostOffsetMinutes: 480,
    })?.due_ts).toBe('2026-08-13T14:03:04.000Z');
    expect(() => protocol.parseScheduleDirective('[send_in=1h2h] @sol duplicate', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/ordered/);
    expect(() => protocol.parseScheduleDirective('[send_in=2m1h] @sol descending', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/ordered/);
  });

  it('enforces UTF-8 bytes, directive bounds, strict future, and the horizon', () => {
    const exact = protocol.parseScheduleDirective(`[send_in=1s] ${'é'.repeat(32_768)}`, {
      now, hostOffsetMinutes: 480,
    });
    expect(exact?.clean_body).toHaveLength(32_768);
    expect(() => protocol.parseScheduleDirective(`[send_in=1s] ${'é'.repeat(32_769)}`, {
      now, hostOffsetMinutes: 480,
    })).toThrow(/UTF-8/);
    expect(() => protocol.parseScheduleDirective(`[send_in=${'1'.repeat(250)}s] @sol too long`, {
      now, hostOffsetMinutes: 480,
    })).toThrow(/256/);
    expect(() => protocol.parseScheduleDirective('[send_in=0s] @sol now', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/invalid relative duration|future/);
    expect(protocol.parseScheduleDirective('[send_in=365d] @sol horizon', {
      now, hostOffsetMinutes: 480,
    })).toBeDefined();
    expect(() => protocol.parseScheduleDirective('[send_in=365d1s] @sol beyond', {
      now, hostOffsetMinutes: 480,
    })).toThrow(/365/);
  });

  it('handles leap/day rollover and fixed-offset DST-adjacent clocks', () => {
    expect(protocol.parseScheduleDirective('[send_at=12:00AM] @sol leap', {
      now: new Date('2028-02-28T23:00:00.000Z'), hostOffsetMinutes: 0,
    })?.due_ts).toBe('2028-02-29T00:00:00.000Z');
    expect(protocol.parseScheduleDirective('[send_at=00:05] @sol day', {
      now: new Date('2026-12-31T23:59:00.000Z'), hostOffsetMinutes: 0,
    })?.due_ts).toBe('2027-01-01T00:05:00.000Z');
    expect(protocol.parseScheduleDirective('[send_at=02:30] @sol dst', {
      now: new Date('2026-03-08T06:00:00.000Z'), hostOffsetMinutes: -300,
    })?.due_ts).toBe('2026-03-08T07:30:00.000Z');
    expect(protocol.parseScheduleDirective('[send_at=2026-03-08T07:30:00Z] @sol z', {
      now: new Date('2026-03-07T12:00:00.000Z'), hostOffsetMinutes: 480,
    })?.due_ts).toBe('2026-03-08T07:30:00.000Z');
  });
});
// harn:end scheduling-directive-is-bounded-and-canonical

// harn:assume scheduled-cancellation-is-authorized-before-claim ref=cancel-schedule-race-regression
it('requires a correlation ref for schedule cancellation acts', () => {
  expect(() => protocol.ActFrameSchema.parse({
    type: 'act',
    room: 'eng',
    act: { act: 'cancel_schedule', schedule_id: 'schedule-1' },
  })).toThrow(/ref/);
});
// harn:end scheduled-cancellation-is-authorized-before-claim

// harn:assume workspace-packages-use-codor-scope ref=codor-package-scope-regression
it('uses the codor scope for every scoped workspace package', () => {
  const manifests = [
    'packages/adapters/antigravity/package.json',
    'packages/adapters/claude-code/package.json',
    'packages/adapters/codex/package.json',
    'packages/adapters/copilot/package.json',
    'packages/adapters/cursor/package.json',
    'packages/adapters/gemini/package.json',
    'packages/adapters/opencode/package.json',
    'packages/bridges/core/package.json',
    'packages/bridges/slack/package.json',
    'packages/bridges/telegram/package.json',
    'packages/cli/package.json',
    'packages/protocol/package.json',
    'packages/switchboard/package.json',
    'packages/web-next/package.json',
    'relay/package.json',
    'website/package.json',
  ];
  for (const manifest of manifests) {
    const parsed = JSON.parse(
      readFileSync(new URL(`../../../${manifest}`, import.meta.url), 'utf8'),
    ) as { name: string };
    expect(parsed.name, manifest).toMatch(/^@codor\//);
  }
});
// harn:end workspace-packages-use-codor-scope

// harn:assume release-gate-runs-unit-and-browser ref=root-release-test-script
it('keeps the fast test loop separate from the full browser release gate', () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  expect(rootPackage.scripts.test).toBe('pnpm -r test');
  expect(rootPackage.scripts['test:all']).toBe(
    'pnpm -r build && pnpm -r --workspace-concurrency=1 test && pnpm --filter @codor/web-next e2e',
  );
});
// harn:end release-gate-runs-unit-and-browser
