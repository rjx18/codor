import { describe, expect, it } from 'vitest';

import {
  ActSchema,
  AssignableHandleSchema,
  ChangeLogEntrySchema,
  ClientFrameSchema,
  CommitPayloadSchema,
  CreateRoomRequestSchema,
  DeliverySchema,
  deriveAssignableHandle,
  deriveRoomId,
  FileChangePayloadSchema,
  HandleSchema,
  MemberStatusResponseSchema,
  MemberSchema,
  MentionSpanSchema,
  MessageSchema,
  parseRunItemPayload,
  PendingInteractionSchema,
  PolicySchema,
  ReasoningSummaryPayloadSchema,
  RoomIdSchema,
  RoomConfigSchema,
  RoomMeterSchema,
  RoomSchema,
  RunSearchHitSchema,
  ServerFrameSchema,
  TextDeltaPayloadSchema,
  ThinkingLevelSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  WireEventSchema,
} from './index.js';
import type { RunItemType, Session, SpawnOpts } from './index.js';

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const DELIVERY_ID = '018f47b4-7f9f-7d3b-a064-52f004c2b782';
const TS = '2026-07-10T07:00:00.000Z';

const chatMessage = {
  id: 1,
  room: 'traderjoe-eng',
  author: ULID_A,
  kind: 'chat',
  body: 'hello @codex see #12',
  mentions: [{ member_id: ULID_B, start: 6, end: 12 }],
  refs: [12],
  ledger_refs: [],
  ts: TS,
  seq: 42,
} as const;

describe('room ids', () => {
  it.each(['eng', 'traderjoe-eng', 'r1', 'x'.repeat(63)])('accepts safe slug %s', (room) => {
    expect(RoomIdSchema.safeParse(room).success).toBe(true);
  });

  it.each(['../escape', 'a/b', '.', '-eng', 'Eng', '', 'x'.repeat(64)])(
    'rejects unsafe room id %j',
    (room) => {
      expect(RoomIdSchema.safeParse(room).success).toBe(false);
    },
  );

  it('derives pure lowercase ASCII slugs without applying collision suffixes', () => {
    expect(deriveRoomId('Demo Site')).toBe('demo-site');
    expect(deriveRoomId('  Crème brûlée  ')).toBe('cr-me-br-l-e');
    expect(deriveRoomId('')).toBe('channel');
    expect(deriveRoomId('🎉')).toBe('channel');
    expect(deriveRoomId('x'.repeat(80))).toBe('x'.repeat(63));
    expect(deriveRoomId(`${'x'.repeat(62)} ! y`)).toBe('x'.repeat(62));
    expect(deriveRoomId('Same Name')).toBe(deriveRoomId('Same Name'));
  });
});

describe('handles', () => {
  it.each(['codex', 'red-team', 'a1', 'x'.repeat(31)])('accepts %s', (handle) => {
    expect(HandleSchema.safeParse(handle).success).toBe(true);
  });

  // harn:assume starting-agent-name-derives-one-valid-identity-v5 ref=starting-agent-identity-regression
  it('derives assignable handles from friendly starting-agent names', () => {
    expect(deriveAssignableHandle('Review Lead')).toBe('review-lead');
    expect(deriveAssignableHandle('  Release / QA !!! ')).toBe('release-qa');
    expect(deriveAssignableHandle('Crème BRÛLÉE')).toBe('creme-brulee');
    expect(deriveAssignableHandle('日本語')).toBe('agent');
    expect(deriveAssignableHandle('A')).toBe('agent');
    expect(deriveAssignableHandle('x'.repeat(80))).toBe('x'.repeat(31));
    expect(deriveAssignableHandle('switchboard')).toBeUndefined();
    expect(deriveAssignableHandle('ALL')).toBeUndefined();
  });
  // harn:end starting-agent-name-derives-one-valid-identity-v5

  it.each([
    'Codex', // uppercase
    '-lead', // leading dash
    'a', // too short (regex demands 2+)
    'x'.repeat(32), // too long
    'with space',
    'emoji🎉',
    '',
  ])('rejects %j', (handle) => {
    expect(HandleSchema.safeParse(handle).success).toBe(false);
  });

  it.each(['all', 'switchboard'])('rejects reserved handle %s for assignment', (handle) => {
    expect(HandleSchema.safeParse(handle).success).toBe(true); // syntactically fine
    expect(AssignableHandleSchema.safeParse(handle).success).toBe(false); // never assignable
  });
});

describe('members', () => {
  const agent = {
    id: ULID_A,
    kind: 'agent',
    handle: 'coder',
    display_name: 'Coder',
    harness: 'codex',
    session_ref: '019f4ae0-8022-7a92-b81a-60e25f3f1c22',
    cwd: '/home/user/project',
    policy: 'workspace-write',
    state: 'idle',
  };

  it('accepts an agent member and defaults the conventions flags off', () => {
    const parsed = MemberSchema.parse({ ...agent, purpose: 'Implements the feature' });
    expect(parsed.conventions_sent).toBe(false);
    expect(parsed.misaddressed).toBe(false);
    expect(parsed.purpose).toBe('Implements the feature');
  });

  it('accepts a removal tombstone timestamp', () => {
    expect(MemberSchema.parse({ ...agent, removed_ts: TS }).removed_ts).toBe(TS);
  });

  // harn:assume agent-model-and-thinking-are-durable ref=durable-agent-config-schema
  it('carries the model and thinking level as member state, not spawn-time arguments', () => {
    const parsed = MemberSchema.parse({ ...agent, model: 'opus-4.8', thinking: 'ultracode' });
    expect(parsed.model).toBe('opus-4.8');
    expect(parsed.thinking).toBe('ultracode');
  });

  it('treats an absent model or thinking level as the harness default', () => {
    const parsed = MemberSchema.parse(agent);
    expect(parsed.model).toBeUndefined();
    expect(parsed.thinking).toBeUndefined();
  });

  it('rejects a thinking level the protocol does not define', () => {
    expect(() => MemberSchema.parse({ ...agent, thinking: 'extreme' })).toThrow();
  });
  // harn:end agent-model-and-thinking-are-durable

  it('accepts the new states unreachable and custody_uncertain', () => {
    expect(MemberSchema.safeParse({ ...agent, state: 'unreachable' }).success).toBe(true);
    expect(MemberSchema.safeParse({ ...agent, state: 'custody_uncertain' }).success).toBe(true);
  });

  it('persists explicit owned or mirrored custody for agent sessions', () => {
    expect(MemberSchema.parse({ ...agent, custody: 'owned' }).custody).toBe('owned');
    expect(MemberSchema.parse({ ...agent, custody: 'mirrored' }).custody).toBe('mirrored');
  });

  it('rejects reserved handles on non-system members', () => {
    expect(MemberSchema.safeParse({ ...agent, handle: 'switchboard' }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...agent, handle: 'all' }).success).toBe(false);
  });

  it('allows the system member itself to hold the switchboard handle', () => {
    const system = {
      id: ULID_B,
      kind: 'system',
      handle: 'switchboard',
      display_name: 'Switchboard',
    };
    expect(MemberSchema.safeParse(system).success).toBe(true);
  });
});

describe('mention spans', () => {
  it('stores member ids with body offsets (never handle text)', () => {
    expect(MentionSpanSchema.safeParse({ member_id: ULID_A, start: 0, end: 6 }).success).toBe(true);
  });

  it('rejects an empty or inverted span', () => {
    expect(MentionSpanSchema.safeParse({ member_id: ULID_A, start: 6, end: 6 }).success).toBe(false);
    expect(MentionSpanSchema.safeParse({ member_id: ULID_A, start: 7, end: 6 }).success).toBe(false);
  });

  it('rejects handle text where a member id belongs', () => {
    expect(MentionSpanSchema.safeParse({ member_id: '@codex', start: 0, end: 6 }).success).toBe(false);
  });
});

describe('messages', () => {
  it('accepts a chat message with mentions, refs, and seq', () => {
    expect(MessageSchema.parse(chatMessage).ack ?? false).toBe(false);
    expect(MessageSchema.parse({ ...chatMessage, ack: true }).ack).toBe(true);
  });

  it('accepts a finalized run message (tokens-only usage, no cost_usd)', () => {
    const run = {
      ...chatMessage,
      id: 2,
      kind: 'run',
      body: 'done, tests green',
      run: {
        status: 'completed',
        started_ts: TS,
        ended_ts: TS,
        tool_calls: 3,
        usage: { input_tokens: 26387, output_tokens: 110 },
        events_ref: 'runs/2.jsonl',
        final_text: 'done, tests green',
      },
    };
    expect(MessageSchema.safeParse(run).success).toBe(true);
  });

  it('accepts a running run message flagged stalled', () => {
    const run = {
      ...chatMessage,
      id: 3,
      kind: 'run',
      run: {
        status: 'running',
        started_ts: TS,
        stalled_since: TS,
        tool_calls: 0,
        events_ref: 'runs/3.jsonl',
      },
    };
    expect(MessageSchema.safeParse(run).success).toBe(true);
  });

  it('accepts an approval card message', () => {
    const approval = {
      ...chatMessage,
      id: 4,
      kind: 'approval',
      ask: {
        interaction_id: 'int-1',
        kind: 'approval',
        prompt: 'Run touch probe.txt?',
        options: [{ label: 'allow once' }, { label: 'allow always' }, { label: 'deny' }],
        tool: 'Bash',
        detail: 'touch probe.txt',
      },
    };
    expect(MessageSchema.safeParse(approval).success).toBe(true);
  });

  it('accepts a bridge-relayed message with origin', () => {
    const bridged = {
      ...chatMessage,
      id: 5,
      origin: { platform: 'slack', external_id: 'C042/1720', sender_name: 'sarah' },
    };
    expect(MessageSchema.safeParse(bridged).success).toBe(true);
  });
});

describe('pending interactions', () => {
  const base = {
    id: 'int-1',
    room: 'traderjoe-eng',
    member_id: ULID_A,
    message_id: 4,
    native_id: 'toolu_01FHFN9zEu93b9qqyfXnkFXC',
    kind: 'ask',
    targets: [ULID_B],
  };

  it.each(['pending', 'answered', 'acked', 'orphaned'] as const)(
    'persists state %s',
    (state) => {
      expect(PendingInteractionSchema.safeParse({ ...base, state }).success).toBe(true);
    },
  );

  it('persists the answer with who and when', () => {
    const answered = PendingInteractionSchema.parse({
      ...base,
      state: 'answered',
      answer: { 'Which codeword?': 'ALPHA' },
      answered_by: ULID_B,
      answered_ts: TS,
    });
    expect(answered.answer).toEqual({ 'Which codeword?': 'ALPHA' });
  });

  it('rejects states outside the machine', () => {
    expect(PendingInteractionSchema.safeParse({ ...base, state: 'expired' }).success).toBe(false);
  });
});

describe('deliveries', () => {
  const base = { id: 'd-1', room: 'traderjoe-eng', message_id: 1, recipient: ULID_A, ts: TS };

  it.each(['queued', 'delivering', 'consumed', 'held'] as const)('supports state %s', (state) => {
    expect(DeliverySchema.safeParse({ ...base, state }).success).toBe(true);
  });

  it('defaults attempt_count to 0 and supports the attempt WAL binding', () => {
    expect(DeliverySchema.parse({ ...base, state: 'queued' }).attempt_count).toBe(0);
    const inflight = DeliverySchema.parse({
      ...base,
      state: 'delivering',
      attempt_count: 1,
      run_msg_id: 7,
      batch_id: 'b-1',
    });
    expect(inflight.run_msg_id).toBe(7);
  });

  it('tracks the human inbox read lifecycle via read_ts', () => {
    expect(
      DeliverySchema.parse({ ...base, state: 'consumed', read_ts: TS }).read_ts,
    ).toBe(TS);
  });

  // harn:assume approval-deliveries-project-resolution-separately ref=approval-delivery-resolution-protocol-regression
  it('projects interaction resolution independently while remaining additive', () => {
    expect(DeliverySchema.parse({ ...base, state: 'consumed' }).interaction_resolved_ts)
      .toBeUndefined();
    expect(DeliverySchema.parse({
      ...base,
      state: 'consumed',
      read_ts: '2026-07-10T06:00:00.000Z',
      interaction_resolved_ts: TS,
    })).toMatchObject({
      read_ts: '2026-07-10T06:00:00.000Z',
      interaction_resolved_ts: TS,
    });
  });
  // harn:end approval-deliveries-project-resolution-separately

  // harn:assume collaboration-groups-are-durable-state ref=collaboration-delivery-association-regression
  it('projects a group and round association as one additive pair', () => {
    expect(DeliverySchema.parse({ ...base, state: 'queued' })).not.toHaveProperty('group_id');
    expect(DeliverySchema.parse({
      ...base,
      state: 'queued',
      group_id: 'group-1',
      group_round: 2,
    })).toMatchObject({ group_id: 'group-1', group_round: 2 });
    expect(DeliverySchema.safeParse({
      ...base,
      state: 'queued',
      group_id: 'group-1',
    }).success).toBe(false);
    expect(DeliverySchema.safeParse({
      ...base,
      state: 'queued',
      group_round: 1,
    }).success).toBe(false);
  });
  // harn:end collaboration-groups-are-durable-state
});

describe('change log', () => {
  it.each(['message', 'member', 'inbox', 'meter', 'room'] as const)(
    'covers entity %s',
    (entity) => {
      expect(
        ChangeLogEntrySchema.safeParse({ room: 'r', seq: 1, entity, entity_id: 'x' }).success,
      ).toBe(true);
    },
  );

  it('rejects entities outside the visible set', () => {
    expect(
      ChangeLogEntrySchema.safeParse({ room: 'r', seq: 1, entity: 'delivery', entity_id: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('room config', () => {
  it('defaults both brakes OFF and the stall flag to 30 informational minutes', () => {
    const config = RoomConfigSchema.parse({});
    expect(config.turn_brake).toBeNull();
    expect(config.spend_brake_usd).toBeNull();
    expect(config.stall_minutes).toBe(30);
    expect(config.redaction_enabled).toBe(true);
    expect(config.bridged).toBe(false);
    expect(config.color).toBeUndefined();
    expect(config.cwd).toBeUndefined();
    expect(config.starting_agent_handle).toBeUndefined();
  });

  it('supports opting in to brakes per room', () => {
    const config = RoomConfigSchema.parse({ turn_brake: 8, spend_brake_usd: 25 });
    expect(config.turn_brake).toBe(8);
    expect(config.spend_brake_usd).toBe(25);
    expect(RoomConfigSchema.parse({ bridged: true }).bridged).toBe(true);
    expect(RoomConfigSchema.parse({ color: '#d45d5d', cwd: '/work/demo' })).toMatchObject({
      color: '#d45d5d',
      cwd: '/work/demo',
    });
    // harn:assume channel-starting-agent-handle-persisted ref=starting-agent-config-regression
    expect(RoomConfigSchema.parse({ starting_agent_handle: 'codor' }).starting_agent_handle)
      .toBe('codor');
    expect(RoomConfigSchema.safeParse({ starting_agent_handle: 'switchboard' }).success).toBe(false);
    // harn:end channel-starting-agent-handle-persisted
  });

  it('accepts additive create requests with an optional id and starting agent', () => {
    const base = {
      name: 'Demo',
      owner: { handle: 'richard', display_name: 'Richard' },
      color: '#d45d5d',
      cwd: '/work/demo',
    };
    expect(CreateRoomRequestSchema.parse(base).id).toBeUndefined();
    expect(
      CreateRoomRequestSchema.parse({
        ...base,
        id: 'demo',
        starting_agent: {
          harness: 'claude-code',
          handle: 'review-lead',
          display_name: 'Review Lead',
          model: 'haiku',
          thinking: 'high',
        },
      }).starting_agent,
    ).toEqual({
      harness: 'claude-code',
      handle: 'review-lead',
      display_name: 'Review Lead',
      model: 'haiku',
      thinking: 'high',
    });
    expect(CreateRoomRequestSchema.parse({
      ...base,
      starting_agent: { harness: 'claude-code', handle: 'codor' },
    }).starting_agent?.display_name).toBeUndefined();
    // harn:assume one-control-chooses-an-agent-everywhere ref=starting-agent-policy
    // The contract is where this actually bites: zod STRIPS a key the schema does not
    // declare, so before this field existed a create request carrying a policy lost it
    // silently at the API boundary and the channel's agent spawned with none.
    expect(
      CreateRoomRequestSchema.parse({
        ...base,
        starting_agent: { harness: 'claude-code', handle: 'codor', policy: 'full-access' },
      }).starting_agent?.policy,
      'a starting agent must be able to carry its permission level',
    ).toBe('full-access');
    // And it takes the same permission vocabulary a spawned agent does.
    expect(
      CreateRoomRequestSchema.safeParse({
        ...base,
        starting_agent: { harness: 'claude-code', handle: 'codor', policy: 'root' },
      }).success,
    ).toBe(false);
    // harn:end one-control-chooses-an-agent-everywhere

    // A starting agent takes the same thinking vocabulary a spawned one does.
    expect(
      CreateRoomRequestSchema.safeParse({
        ...base,
        starting_agent: { harness: 'claude-code', handle: 'codor', thinking: 'ludicrous' },
      }).success,
    ).toBe(false);
    expect(
      CreateRoomRequestSchema.safeParse({
        ...base,
        starting_agent: { harness: 'claude-code', handle: 'switchboard' },
      }).success,
    ).toBe(false);
  });

  it('rooms default their whole config', () => {
    const room = RoomSchema.parse({ id: 'r', name: 'R', created_ts: TS });
    expect(room.config.turn_brake).toBeNull();
  });

  it('meters carry per-day turns, cost, and tokens', () => {
    expect(
      RoomMeterSchema.parse({
        room: 'r',
        day: '2026-07-10',
        turns: 4,
        cost_usd: 1.23,
        input_tokens: 1000,
        output_tokens: 200,
      }).uncosted_tokens,
    ).toBeUndefined();
    expect(RoomMeterSchema.parse({
      room: 'r',
      day: '2026-07-10',
      turns: 4,
      cost_usd: 1.23,
      input_tokens: 1000,
      output_tokens: 200,
      uncosted_tokens: 75,
    }).uncosted_tokens).toBe(75);
  });
});

describe('normalized run-item payloads', () => {
  const cases: [
    RunItemType,
    { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } },
    unknown,
    unknown,
  ][] = [
    [
      'tool_call',
      ToolCallPayloadSchema,
      {
        call_id: 'call-1',
        tool: 'Bash',
        title: 'pnpm test',
        input: { command: 'pnpm test' },
        vendor: 'extra',
      },
      { call_id: 'call-1', tool: 'Bash' },
    ],
    [
      'tool_result',
      ToolResultPayloadSchema,
      {
        call_id: 'call-1',
        status: 'ok',
        output_text: 'passed',
        diff: { path: 'src/app.ts', unified: '@@ -1 +1 @@', lines: 2 },
        image: { media_type: 'image/png', data_b64: 'aGVsbG8=', width: 1 },
        duration_ms: 12.5,
        raw: { native: true },
        vendor: 'extra',
      },
      { call_id: 'call-1', status: 'pending' },
    ],
    [
      'text_delta',
      TextDeltaPayloadSchema,
      { text: 'Working', vendor: 'extra' },
      { text: 42 },
    ],
    [
      'reasoning_summary',
      ReasoningSummaryPayloadSchema,
      { text: 'Check the failing test', vendor: 'extra' },
      {},
    ],
    [
      'file_change',
      FileChangePayloadSchema,
      {
        path: 'src/app.ts',
        change: 'modified',
        diff: { path: 'src/app.ts', unified: '@@ -1 +1 @@', vendor: 'extra' },
        vendor: 'extra',
      },
      { path: 'src/app.ts', change: 'renamed' },
    ],
    [
      'commit',
      CommitPayloadSchema,
      { sha: 'abc123', message: 'Fix tests', vendor: 'extra' },
      { sha: 123 },
    ],
  ];

  it.each(cases)(
    'round-trips permissive %s payloads and rejects invalid shapes',
    (type, schema, valid, invalid) => {
      expect(schema.parse(valid)).toEqual(valid);
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(parseRunItemPayload(type, valid)).toMatchObject({ success: true, data: valid });
      expect(parseRunItemPayload(type, invalid).success).toBe(false);
    },
  );
});

describe('spawn control vocabularies', () => {
  it.each(['read-only', 'workspace-write', 'full-access'] as const)(
    'accepts canonical policy %s',
    (policy) => {
      expect(PolicySchema.parse(policy)).toBe(policy);
    },
  );

  it('rejects noncanonical policy values', () => {
    expect(PolicySchema.safeParse('danger-full-access').success).toBe(false);
  });

  // harn:assume harness-declares-supported-thinking-levels ref=protocol-thinking-level-regression
  it('keeps SpawnOpts thinking optional and accepts the cross-harness wire union', () => {
    const withoutThinking: SpawnOpts = { cwd: '/work' };
    expect(withoutThinking.thinking).toBeUndefined();
    for (const thinking of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const) {
      const withThinking: SpawnOpts = { cwd: '/work', thinking };
      expect(ThinkingLevelSchema.parse(withThinking.thinking)).toBe(thinking);
    }
    expect(ThinkingLevelSchema.safeParse('extreme').success).toBe(false);
  });
  // harn:end harness-declares-supported-thinking-levels
});

describe('wire events', () => {
  const cases: [string, unknown][] = [
    ['run.started', { type: 'run.started', member: ULID_A, trigger_msg: 1 }],
    ['run.item', { type: 'run.item', item_type: 'tool_call', payload: { command: 'ls' } }],
    [
      'ask.raised',
      { type: 'ask.raised', card: { interaction_id: 'i', kind: 'ask', prompt: 'Which?' } },
    ],
    [
      'approval.raised',
      {
        type: 'approval.raised',
        card: { interaction_id: 'i', kind: 'approval', prompt: 'Allow?', tool: 'Bash' },
      },
    ],
    [
      'run.completed',
      {
        type: 'run.completed',
        status: 'completed',
        final_text: 'PONG',
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.19 },
      },
    ],
    ['member.state', { type: 'member.state', member: ULID_A, state: 'awaiting_input' }],
    ['extension.started', { type: 'extension.started', parent: ULID_A, ext_member: ULID_B }],
    ['extension.ended', { type: 'extension.ended', ext_member: ULID_B, summary: 'PONG' }],
  ];

  it.each(cases)('accepts %s', (_name, event) => {
    expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects unknown event types and running as a completion status', () => {
    expect(WireEventSchema.safeParse({ type: 'run.paused' }).success).toBe(false);
    expect(
      WireEventSchema.safeParse({ type: 'run.completed', status: 'running' }).success,
    ).toBe(false);
  });

  it('accepts fixture-shaped native extension ids before member mapping', () => {
    expect(
      WireEventSchema.safeParse({
        type: 'extension.started',
        parent: '213a7049-0ddd-4db7-84ed-411dd7330fe7',
        ext_member: 'a4fdb5021f374a8d1',
        agent_type: 'general-purpose',
        transcript_path: '/home/user/.claude/projects/project/transcript.jsonl',
        description: 'Inspect cache invalidation',
      }).success,
    ).toBe(true);
  });
});

describe('WS client frames', () => {
  it('lists rooms over the same protocol transport', () => {
    expect(ClientFrameSchema.safeParse({ type: 'list_rooms' }).success).toBe(true);
    expect(ServerFrameSchema.safeParse({
      type: 'rooms',
      rooms: [{ id: 'eng', name: 'Eng', created_ts: TS, config: {} }],
    }).success).toBe(true);
  });

  it('subscribe cursors on since_seq — and requires it', () => {
    expect(
      ClientFrameSchema.safeParse({ type: 'subscribe', room: 'r', since_seq: 0 }).success,
    ).toBe(true);
    expect(ClientFrameSchema.safeParse({ type: 'subscribe', room: 'r' }).success).toBe(false);
  });

  it('accepts a post with an optional threading hint', () => {
    expect(
      ClientFrameSchema.safeParse({ type: 'post', room: 'r', body: 'hi', reply_to: 3 }).success,
    ).toBe(true);
  });

  const acts: [string, unknown][] = [
    ['answer_interaction', { act: 'answer_interaction', interaction_id: 'i', answer: 'ALPHA' }],
    ['redeliver', { act: 'redeliver', delivery_id: 'd' }],
    ['release_hold', { act: 'release_hold', delivery_id: 'd' }],
    ['mark_read', { act: 'mark_read', delivery_id: 'd' }],
    ['join', { act: 'join', harness: 'codex', handle: 'planner', session_ref: 's-1', cwd: '/w' }],
    ['adopt', { act: 'adopt', member_id: ULID_A }],
    ['attach_acquire', { act: 'attach_acquire', member_id: ULID_A, cli_pid: 123 }],
    ['attach_child', { act: 'attach_child', lease_id: 'lease-1', child_pid: 456, process_group_id: 456 }],
    ['attach_heartbeat', { act: 'attach_heartbeat', lease_id: 'lease-1' }],
    ['attach_complete', { act: 'attach_complete', lease_id: 'lease-1' }],
    ['configure_room', { act: 'configure_room', turn_brake: 3, spend_brake_usd: null, stall_minutes: 15 }],
    ['spawn', { act: 'spawn', harness: 'codex', handle: 'coder', cwd: '/w', policy: 'read-only' }],
    ['remove', { act: 'remove', member_id: ULID_A }],
    ['rename', { act: 'rename', member_id: ULID_A, handle: 'reviewer' }],
    ['revive', { act: 'revive', member_id: ULID_A }],
    ['kill', { act: 'kill', member_id: ULID_A }],
    ['pause', { act: 'pause', member_id: ULID_A }],
    ['unpause', { act: 'unpause', member_id: ULID_A }],
    ['interrupt', { act: 'interrupt', member_id: ULID_A }],
    ['set_role', { act: 'set_role', member_id: ULID_A, role: 'admin' }],
  ];

  it.each(acts)('accepts act %s', (_name, act) => {
    expect(ClientFrameSchema.safeParse({ type: 'act', room: 'r', act }).success).toBe(true);
  });

  it('rejects spawning or renaming onto a reserved handle', () => {
    expect(
      ActSchema.safeParse({ act: 'spawn', harness: 'codex', handle: 'all', cwd: '/w' }).success,
    ).toBe(false);
    expect(
      ActSchema.safeParse({ act: 'rename', member_id: ULID_A, handle: 'switchboard' }).success,
    ).toBe(false);
  });

  it('requires a role exactly for human members', () => {
    expect(MemberSchema.safeParse({
      id: ULID_A,
      kind: 'human',
      handle: 'viewer',
      display_name: 'Viewer',
    }).success).toBe(false);
    expect(MemberSchema.safeParse({
      id: ULID_A,
      kind: 'agent',
      handle: 'runner',
      display_name: 'Runner',
      role: 'admin',
    }).success).toBe(false);
  });

  it('accepts session-keyed mirror lifecycle frames and acknowledgements', () => {
    expect(ClientFrameSchema.safeParse({
      type: 'mirror_turn',
      harness: 'codex',
      session_ref: 'thread-1',
      native_turn_id: 'turn-1',
      body: '@planner done',
    }).success).toBe(true);
    expect(ClientFrameSchema.safeParse({
      type: 'mirror_session_end',
      harness: 'claude-code',
      session_ref: 'session-1',
    }).success).toBe(true);
    expect(ServerFrameSchema.safeParse({
      type: 'mirror_ack',
      native_turn_id: 'turn-1',
      message_id: 7,
      deduped: false,
    }).success).toBe(true);
  });
});

describe('WS server frames', () => {
  const member = MemberSchema.parse({
    id: ULID_A,
    kind: 'human',
    handle: 'richard',
    display_name: 'Richard',
    role: 'owner',
  });

  const frames: [string, unknown][] = [
    ['self', { type: 'self', member_id: ULID_A }],
    ['message', { type: 'message', seq: 1, message: chatMessage }],
    ['member', { type: 'member', seq: 2, member }],
    [
      'inbox',
      {
        type: 'inbox',
        seq: 3,
        delivery: { id: 'd', room: 'r', message_id: 1, recipient: ULID_A, state: 'consumed', ts: TS },
      },
    ],
    [
      'meter',
      {
        type: 'meter',
        seq: 4,
        meter: { room: 'r', day: '2026-07-10', turns: 1, cost_usd: 0, input_tokens: 1, output_tokens: 1 },
      },
    ],
    ['room', { type: 'room', seq: 5, room: { id: 'r', name: 'R', created_ts: TS, config: {} } }],
    ['sync_complete', { type: 'sync_complete', seq: 6 }],
    [
      'run_event',
      {
        type: 'run_event',
        room: 'r',
        message_id: 2,
        event: { type: 'run.item', item_type: 'text_delta', payload: 'hi' },
      },
    ],
    ['error', { type: 'error', message: 'no such room', ref: 'subscribe' }],
    [
      'attach_lease',
      {
        type: 'attach_lease',
        status: 'acquired',
        lease: {
          id: 'lease-1',
          room: 'r',
          member_id: ULID_A,
          cli_pid: 123,
          heartbeat_ts: 1000,
        },
        member: {
          id: ULID_A,
          kind: 'agent',
          handle: 'planner',
          display_name: 'Planner',
          harness: 'codex',
          session_ref: 'session-1',
          cwd: '/work',
          state: 'idle',
          custody: 'mirrored',
        },
      },
    ],
  ];

  it.each(frames)('accepts %s', (_name, frame) => {
    const parsed = ServerFrameSchema.safeParse(frame);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error)).toBe(true);
  });

  it('live entity frames carry the producing seq', () => {
    const parsed = ServerFrameSchema.parse({ type: 'message', seq: 9, message: chatMessage });
    expect(parsed).toHaveProperty('seq', 9);
  });
});

// harn:assume live-delivery-consumption-is-idempotent ref=consumption-protocol-regression
describe('live delivery consumption protocol', () => {
  it('accepts the consume act and its delivery plus source-message result', () => {
    expect(ActSchema.parse({ act: 'consume_delivery', delivery_id: DELIVERY_ID }))
      .toEqual({ act: 'consume_delivery', delivery_id: DELIVERY_ID });
    expect(ServerFrameSchema.parse({
      type: 'consume_result',
      delivery: {
        id: DELIVERY_ID,
        room: 'r',
        message_id: chatMessage.id,
        recipient: ULID_A,
        state: 'consumed',
        ts: TS,
      },
      message: chatMessage,
    })).toMatchObject({
      type: 'consume_result',
      delivery: { id: DELIVERY_ID, state: 'consumed' },
      message: { id: chatMessage.id },
    });
  });

  it('rejects a malformed delivery id or a result without its source message', () => {
    expect(ActSchema.safeParse({ act: 'consume_delivery', delivery_id: 'not-a-delivery' }).success)
      .toBe(false);
    expect(ServerFrameSchema.safeParse({
      type: 'consume_result',
      delivery: {
        id: DELIVERY_ID, room: 'r', message_id: 1, recipient: ULID_A,
        state: 'consumed', ts: TS,
      },
    }).success).toBe(false);
  });
});
// harn:end live-delivery-consumption-is-idempotent

// harn:assume live-agent-waits-are-transient ref=wait-protocol-regression
describe('live wait acts', () => {
  const wait = {
    act: 'wait_begin' as const,
    reason: 'reply' as const,
    peers: [ULID_B],
    until_ts: TS,
  };

  it('accepts every wait reason and the idempotent end act', () => {
    for (const reason of ['reply', 'mention', 'any'] as const) {
      expect(ActSchema.parse({ ...wait, reason })).toEqual({ ...wait, reason });
    }
    expect(ActSchema.parse({ act: 'wait_end' })).toEqual({ act: 'wait_end' });
  });

  it('rejects empty peers, handles in place of ids, unknown reasons, and bad deadlines', () => {
    expect(ActSchema.safeParse({ ...wait, peers: [] }).success).toBe(false);
    expect(ActSchema.safeParse({ ...wait, peers: ['tester'] }).success).toBe(false);
    expect(ActSchema.safeParse({ ...wait, reason: 'later' }).success).toBe(false);
    expect(ActSchema.safeParse({ ...wait, until_ts: 'tomorrow' }).success).toBe(false);
  });
});
// harn:end live-agent-waits-are-transient

// harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-protocol-regression
describe('awaiting-reply post intent', () => {
  it('is additive on a post frame and remains absent for ordinary posts', () => {
    expect(ClientFrameSchema.parse({
      type: 'post', room: 'eng', body: '@tester check this', awaiting_reply: true,
    })).toMatchObject({ type: 'post', awaiting_reply: true });
    expect(ClientFrameSchema.parse({ type: 'post', room: 'eng', body: 'progress' }))
      .not.toHaveProperty('awaiting_reply');
  });

  it('rejects a non-boolean marker', () => {
    expect(ClientFrameSchema.safeParse({
      type: 'post', room: 'eng', body: 'progress', awaiting_reply: 'yes',
    }).success).toBe(false);
  });
});
// harn:end awaiting-reply-marker-is-delivery-context

// harn:assume member-status-is-bounded-and-identity-safe ref=status-protocol-regression
describe('member status response', () => {
  const response = {
    member: {
      handle: 'coder',
      state: 'running' as const,
      waiting: {
        peers: ['tester'],
        reason: 'reply' as const,
        since_ts: TS,
        until_ts: TS,
      },
    },
    current_run: {
      message_id: 7,
      started_ts: TS,
      elapsed_ms: 250,
      tool_calls: 1,
    },
    recent: [{ kind: 'tool' as const, title: 'Run tests', status: 'ok' as const, duration_ms: 42, ts: TS }],
  };

  it('round-trips handles, bounded actions, and timestamped journal items', () => {
    expect(MemberStatusResponseSchema.parse(response)).toEqual(response);
    expect(WireEventSchema.parse({
      type: 'run.item', item_type: 'tool_call',
      payload: { call_id: 'c1', tool: 'Bash', title: 'Run tests' }, ts: TS,
    })).toMatchObject({ type: 'run.item', ts: TS });
  });

  it('rejects identity or raw-payload fields and more than five actions', () => {
    expect(MemberStatusResponseSchema.safeParse({
      ...response,
      member: { ...response.member, member_id: ULID_A },
    }).success).toBe(false);
    expect(MemberStatusResponseSchema.safeParse({
      ...response,
      recent: Array.from({ length: 6 }, () => response.recent[0]),
    }).success).toBe(false);
    expect(MemberStatusResponseSchema.safeParse({
      ...response,
      recent: [{ ...response.recent[0], raw: { command: 'secret' } }],
    }).success).toBe(false);
  });
});
// harn:end member-status-is-bounded-and-identity-safe

// harn:assume run-evidence-search-is-bounded-and-redacted ref=run-search-protocol-regression
describe('run evidence search hit', () => {
  it('carries a stable message and journal position with a bounded excerpt', () => {
    expect(RunSearchHitSchema.parse({
      message_id: 12, item_index: 3, kind: 'tool_result', excerpt: '42 tests passed',
    })).toEqual({
      message_id: 12, item_index: 3, kind: 'tool_result', excerpt: '42 tests passed',
    });
  });

  it('rejects unknown evidence kinds and excerpts beyond the serving bound', () => {
    expect(RunSearchHitSchema.safeParse({
      message_id: 12, item_index: 3, kind: 'reasoning', excerpt: 'hidden',
    }).success).toBe(false);
    expect(RunSearchHitSchema.safeParse({
      message_id: 12, item_index: 3, kind: 'tool_call', excerpt: 'x'.repeat(241),
    }).success).toBe(false);
  });
});
// harn:end run-evidence-search-is-bounded-and-redacted

// harn:assume waiting-is-visible-member-state ref=member-waiting-regression
describe('a member says what it is waiting on', () => {
  const alpha: Record<string, unknown> = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'agent',
    handle: 'coder',
    display_name: 'Coder',
    harness: 'claude-code',
    state: 'running',
  };
  const wait = {
    peers: ['01BX5ZZKBKACTAV9WEVGEMMVRZ'],
    reason: 'reply' as const,
    since_ts: TS,
    until_ts: TS,
  };

  it('carries who it waits on, why, and until when', () => {
    const parsed = MemberSchema.parse({ ...alpha, waiting: wait });
    expect(parsed.waiting).toEqual(wait);
  });

  it('means NOT WAITING when absent — which is what every frame has meant until now', () => {
    expect(MemberSchema.parse(alpha).waiting).toBeUndefined();
  });

  it('rejects a wait on nobody', () => {
    // A wait with no peer is not a wait; it is a hang with a label on it.
    expect(() => MemberSchema.parse({ ...alpha, waiting: { ...wait, peers: [] } })).toThrow();
  });

  it('rejects a reason the protocol does not define', () => {
    expect(() => MemberSchema.parse({ ...alpha, waiting: { ...wait, reason: 'vibes' } })).toThrow();
  });

  it('rejects a peer that is not a member id', () => {
    expect(() => MemberSchema.parse({ ...alpha, waiting: { ...wait, peers: ['coder'] } })).toThrow();
  });
});
// harn:end waiting-is-visible-member-state

// harn:assume a-session-carries-the-environment-its-children-need ref=session-env-regression
describe('a session carries the environment its children need', () => {
  it('accepts an environment for the children spawned under it', () => {
    // The type is the contract here — Session is an interface, not a zod schema — so this
    // asserts the shape the adapters are told to merge, and that it survives a spawn.
    const session: Session = {
      harness: 'claude-code',
      cwd: '/work',
      env: { CODOR_SOCKET: '/home/o/.codor/codor.sock', CODOR_CHANNEL: 'eng' },
    };
    expect({ ...process.env, ...session.env }.CODOR_CHANNEL).toBe('eng');
    // Merged OVER, not instead of: the inherited environment survives.
    expect({ ...process.env, ...session.env }.PATH).toBe(process.env.PATH);
  });

  it('means "inherit only" when absent, which is what every adapter does today', () => {
    const session: Session = { harness: 'fake', cwd: '/work' };
    expect(session.env).toBeUndefined();
    expect({ ...process.env, ...session.env }).toEqual({ ...process.env });
  });
});
// harn:end a-session-carries-the-environment-its-children-need
