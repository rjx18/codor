import { RoomConfigSchema, type Member, type Message, type Room } from '@codor/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_PAGE_SIZE, effectiveDefaultRecipient, heldDeliveries, latestFinalizedAgentAuthor, me, pendingInteractions, sortedMessages, unreadCount, useRoomStore } from './state.js';

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const ULID_C = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const TS = '2026-07-10T07:00:00.000Z';

const room = (startingAgentHandle?: string): Room => ({
  id: 'eng',
  name: 'Engineering',
  created_ts: TS,
  config: RoomConfigSchema.parse({
    ...(startingAgentHandle !== undefined && { starting_agent_handle: startingAgentHandle }),
  }),
});

const richard: Member = {
  id: ULID_A,
  kind: 'human',
  handle: 'richard',
  display_name: 'Richard',
  role: 'owner',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};
const alpha: Member = {
  id: ULID_B,
  kind: 'agent',
  handle: 'alpha',
  display_name: 'Alpha',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};

const message = (over: Partial<Message> & Pick<Message, 'id' | 'seq'>): Message => ({
  room: 'eng',
  author: ULID_A,
  kind: 'chat',
  body: 'hello',
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: TS,
  ...over,
});

beforeEach(() => {
  useRoomStore.getState().reset();
});

describe('frame application (in-place, seq-cursored)', () => {
  it('advances the seq cursor to the max seen across frames', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'message', seq: 7, message: message({ id: 1, seq: 7 }) });
    applyFrame({ type: 'member', seq: 5, member: richard }); // stale ordering
    expect(useRoomStore.getState().seq).toBe(7);
    applyFrame({ type: 'message', seq: 12, message: message({ id: 2, seq: 12 }) });
    expect(useRoomStore.getState().seq).toBe(12);
  });

  it('commits a hydration cursor only when sync_complete arrives', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'sync_complete', seq: 4 });
    applyFrame({ type: 'message', seq: 4, message: message({ id: 1, seq: 12 }) });
    expect(useRoomStore.getState().messages[1]!.seq).toBe(12);
    expect(useRoomStore.getState().seq).toBe(4);

    applyFrame({ type: 'sync_complete', seq: 12 });
    expect(useRoomStore.getState().seq).toBe(12);
  });

  it('keeps one initial history page and merges older REST rows without moving seq', () => {
    const { applyFrame } = useRoomStore.getState();
    for (let id = 1; id <= HISTORY_PAGE_SIZE + 5; id++) {
      applyFrame({ type: 'message', seq: 0, message: message({ id, seq: id }) });
    }
    applyFrame({ type: 'sync_complete', seq: HISTORY_PAGE_SIZE + 5 });

    let state = useRoomStore.getState();
    expect(Object.keys(state.messages)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(sortedMessages(state.messages)[0]!.id).toBe(6);
    state.mergeHistoryPage([message({ id: 5, seq: 5 }), message({ id: 4, seq: 4 })]);

    state = useRoomStore.getState();
    expect(sortedMessages(state.messages).slice(0, 3).map((item) => item.id)).toEqual([4, 5, 6]);
    expect(state.seq).toBe(HISTORY_PAGE_SIZE + 5);
  });

  it('retains the full-history default recipient after the visible page is trimmed', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'member', seq: 0, member: alpha });
    applyFrame({
      type: 'message',
      seq: 0,
      message: message({
        id: 1,
        seq: 3,
        kind: 'run',
        author: alpha.id,
        body: 'done',
        run: {
          status: 'completed',
          started_ts: TS,
          ended_ts: TS,
          tool_calls: 0,
          events_ref: 'runs/1.jsonl',
          final_text: 'done',
        },
      }),
    });
    for (let id = 2; id <= HISTORY_PAGE_SIZE + 2; id++) {
      applyFrame({ type: 'message', seq: 0, message: message({ id, seq: id + 2 }) });
    }
    applyFrame({ type: 'sync_complete', seq: HISTORY_PAGE_SIZE + 4 });

    const state = useRoomStore.getState();
    expect(state.messages[1]).toBeUndefined();
    expect(state.latestFinalizedAgentId).toBe(alpha.id);
  });

  it('a run finalization REPLACES the message in place — never a duplicate', () => {
    const { applyFrame } = useRoomStore.getState();
    const running = message({
      id: 3,
      seq: 4,
      kind: 'run',
      author: ULID_B,
      body: '',
      run: { status: 'running', started_ts: TS, tool_calls: 0, events_ref: 'runs/3.jsonl' },
    });
    applyFrame({ type: 'message', seq: 4, message: running });
    const finalized = {
      ...running,
      seq: 9,
      body: 'all done @richard',
      run: { ...running.run!, status: 'completed' as const, final_text: 'all done @richard' },
    };
    applyFrame({ type: 'message', seq: 9, message: finalized });

    const state = useRoomStore.getState();
    expect(Object.keys(state.messages)).toHaveLength(1);
    expect(state.messages[3]!.run!.status).toBe('completed');
    expect(state.messages[3]!.body).toBe('all done @richard');
    expect(state.seq).toBe(9);
  });

  it('run_event frames accumulate live enrichment without touching the cursor', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'message', seq: 2, message: message({ id: 1, seq: 2 }) });
    applyFrame({
      type: 'run_event',
      room: 'eng',
      message_id: 1,
      event: { type: 'run.item', item_type: 'text_delta', payload: 'hi' },
    });
    const state = useRoomStore.getState();
    expect(state.runEvents[1]).toEqual({
      events: [{ type: 'run.item', item_type: 'text_delta', payload: 'hi' }],
      dropped_count: 0,
    });
    expect(state.seq).toBe(2); // ephemeral frames never move the cursor
  });

  // harn:assume live-run-event-cache-bounded ref=bounded-run-stream-regression
  it('retains only the latest 500 live events and counts every dropped event', () => {
    const { applyFrame } = useRoomStore.getState();
    for (let index = 0; index < 600; index++) {
      applyFrame({
        type: 'run_event',
        room: 'eng',
        message_id: 4,
        event: { type: 'run.item', item_type: 'text_delta', payload: { text: String(index) } },
      });
    }
    const buffer = useRoomStore.getState().runEvents[4]!;
    expect(buffer.events).toHaveLength(500);
    expect(buffer.dropped_count).toBe(100);
    expect(buffer.events[0]).toMatchObject({ payload: { text: '100' } });
  });
  // harn:end live-run-event-cache-bounded

  it('records distinct observed member state transitions without duplicating refreshes', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'member', seq: 1, member: { ...alpha, state: 'idle' } });
    applyFrame({ type: 'member', seq: 2, member: { ...alpha, state: 'queued' } });
    applyFrame({ type: 'member', seq: 3, member: { ...alpha, state: 'queued' } });
    applyFrame({ type: 'member', seq: 4, member: { ...alpha, state: 'running' } });

    expect(useRoomStore.getState().memberHistory[alpha.id]!.map((item) => item.state)).toEqual([
      'idle',
      'queued',
      'running',
    ]);
  });
});

describe('selectors', () => {
  it('me() finds the owner human; unreadCount counts only my unread consumed records', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({ type: 'member', seq: 1, member: richard });
    applyFrame({ type: 'member', seq: 2, member: alpha });
    applyFrame({
      type: 'inbox',
      seq: 3,
      delivery: { id: 'd1', room: 'eng', message_id: 1, recipient: ULID_A, state: 'consumed', attempt_count: 0, ts: TS },
    });
    applyFrame({
      type: 'inbox',
      seq: 4,
      delivery: { id: 'd2', room: 'eng', message_id: 2, recipient: ULID_B, state: 'queued', attempt_count: 0, ts: TS },
    });
    const state = useRoomStore.getState();
    expect(me(state.members)!.handle).toBe('richard');
    expect(unreadCount(state)).toBe(1);

    applyFrame({
      type: 'inbox',
      seq: 5,
      delivery: { id: 'd1', room: 'eng', message_id: 1, recipient: ULID_A, state: 'consumed', attempt_count: 0, read_ts: TS, ts: TS },
    });
    expect(unreadCount(useRoomStore.getState())).toBe(0);
  });

  it('uses the authenticated self frame instead of assuming the owner is me', () => {
    const { applyFrame } = useRoomStore.getState();
    const observer: Member = {
      id: ULID_C,
      kind: 'human',
      handle: 'observer-user',
      display_name: 'Observer',
      role: 'observer',
      conventions_sent: false,
      misaddressed: false,
      roster_stale: false,
    };
    applyFrame({ type: 'member', seq: 1, member: richard });
    applyFrame({ type: 'member', seq: 2, member: observer });
    applyFrame({ type: 'self', member_id: observer.id });
    applyFrame({
      type: 'inbox',
      seq: 3,
      delivery: { id: 'owner', room: 'eng', message_id: 1, recipient: richard.id, state: 'consumed', attempt_count: 0, ts: TS },
    });
    applyFrame({
      type: 'inbox',
      seq: 4,
      delivery: { id: 'observer', room: 'eng', message_id: 2, recipient: observer.id, state: 'consumed', attempt_count: 0, ts: TS },
    });

    const state = useRoomStore.getState();
    expect(me(state.members, state.selfMemberId)?.id).toBe(observer.id);
    expect(unreadCount(state)).toBe(1);
  });

  it('heldDeliveries surfaces the hold banner rows', () => {
    const { applyFrame } = useRoomStore.getState();
    applyFrame({
      type: 'inbox',
      seq: 3,
      delivery: { id: 'h1', room: 'eng', message_id: 5, recipient: ULID_B, state: 'held', attempt_count: 1, ts: TS },
    });
    expect(heldDeliveries(useRoomStore.getState().inbox).map((d) => d.id)).toEqual(['h1']);
  });

  it('latestFinalizedAgentAuthor ignores running placeholders', () => {
    const members = { [richard.id]: richard, [alpha.id]: alpha };
    const messages: Record<number, Message> = {
      1: message({
        id: 1,
        seq: 1,
        kind: 'run',
        author: ULID_B,
        run: { status: 'completed', started_ts: TS, tool_calls: 0, events_ref: 'runs/1.jsonl' },
      }),
      2: message({
        id: 2,
        seq: 2,
        kind: 'run',
        author: ULID_B,
        run: { status: 'running', started_ts: TS, tool_calls: 0, events_ref: 'runs/2.jsonl' },
      }),
    };
    expect(latestFinalizedAgentAuthor(messages, members)!.handle).toBe('alpha');
    expect(sortedMessages(messages).map((m) => m.id)).toEqual([1, 2]);
  });

  // harn:assume default-recipient-fallback-chain ref=web-effective-default-regression
  it('matches the server effective-default fallback chain', () => {
    const beta = { ...alpha, id: ULID_C, handle: 'beta', display_name: 'Beta' };
    expect(effectiveDefaultRecipient({
      room: room('alpha'),
      members: { [alpha.id]: alpha, [beta.id]: beta },
      latestFinalizedAgentId: undefined,
    })).toBe(alpha);
    expect(effectiveDefaultRecipient({
      room: room('alpha'),
      members: { [alpha.id]: alpha, [beta.id]: beta },
      latestFinalizedAgentId: beta.id,
    })).toBe(beta);
    expect(effectiveDefaultRecipient({
      room: room(),
      members: { [alpha.id]: alpha },
      latestFinalizedAgentId: undefined,
    })).toBe(alpha);
    expect(effectiveDefaultRecipient({
      room: room('alpha'),
      members: {
        [alpha.id]: { ...alpha, state: 'dead' },
        [beta.id]: beta,
      },
      latestFinalizedAgentId: undefined,
    })).toBe(beta);
    expect(effectiveDefaultRecipient({
      room: room(),
      members: { [alpha.id]: alpha, [beta.id]: beta },
      latestFinalizedAgentId: undefined,
    })).toBeUndefined();
  });

  it('keeps acknowledgement runs out of cached and visible-history defaults', () => {
    const { applyFrame } = useRoomStore.getState();
    const beta = { ...alpha, id: ULID_C, handle: 'beta', display_name: 'Beta' };
    applyFrame({ type: 'member', seq: 1, member: alpha });
    applyFrame({ type: 'member', seq: 2, member: beta });
    const substantive = message({
      id: 3,
      seq: 2,
      kind: 'run',
      author: alpha.id,
      body: 'done',
      run: { status: 'completed', started_ts: TS, tool_calls: 0, events_ref: 'runs/3.jsonl' },
    });
    const ack = message({
      id: 4,
      seq: 3,
      kind: 'run',
      author: beta.id,
      body: '<ACK_OK>',
      ack: true,
      run: { status: 'completed', started_ts: TS, tool_calls: 0, events_ref: 'runs/4.jsonl' },
    });
    applyFrame({ type: 'message', seq: 2, message: substantive });
    applyFrame({ type: 'message', seq: 3, message: ack });

    expect(useRoomStore.getState().latestFinalizedAgentId).toBe(alpha.id);
    expect(latestFinalizedAgentAuthor({ 4: ack }, { [beta.id]: beta })).toBeUndefined();
  });
  // harn:end default-recipient-fallback-chain
});

// harn:assume the-inbox-badge-and-panel-are-one-truth ref=pending-interactions-regression
describe('what needs the operator', () => {
  const ask = (id: number): Message => ({
    id, room: 'eng', author: 'agent-1', kind: 'approval', body: 'Run it?',
    ts: '2026-07-12T00:00:00.000Z',
    ask: { interaction_id: `i-${String(id)}`, kind: 'approval', prompt: 'Run it?', options: [{ label: 'Allow' }] },
  } as unknown as Message);

  const base = (messages: Message[], recipient = 'me') => ({
    messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    inbox: Object.fromEntries(messages.map((m) => [
      `d-${String(m.id)}`, { message_id: m.id, recipient, state: 'consumed' } as never,
    ])),
    members: { me: { id: 'me', kind: 'human', handle: 'richard' } as never },
    selfMemberId: 'me',
  });

  it('lists an ask that is waiting on this operator', () => {
    expect(pendingInteractions(base([ask(1)])).map((m) => m.id)).toEqual([1]);
  });

  it('does not list an ask addressed to somebody else', () => {
    // Clicking it would land on a card whose buttons are disabled.
    expect(pendingInteractions(base([ask(1)], 'someone-else'))).toEqual([]);
  });

  it('does not list an approval whose addressed delivery is durably read', () => {
    const answered = { ...base([ask(1)]) };
    answered.inbox['d-1'] = { message_id: 1, recipient: 'me', state: 'consumed', read_ts: TS } as never;
    expect(pendingInteractions(answered)).toEqual([]);
  });
});

// harn:assume the-inbox-badge-and-panel-are-one-truth ref=pending-survives-history-trim
describe('history trim', () => {
  it('keeps an ask that is still waiting, however far back it is', () => {
    const { applyFrame, reset } = useRoomStore.getState();
    reset();

    // Hydration: the ask arrives first, then the channel fills past the window.
    const messages: Record<number, unknown> = {
      1: {
        ...message({ id: 1, seq: 1 }),
        kind: 'approval',
        ask: { interaction_id: 'i-1', kind: 'approval', prompt: 'Run it?', options: [{ label: 'Allow' }] },
      },
    };
    for (let id = 2; id <= HISTORY_PAGE_SIZE + 10; id++) {
      messages[id] = message({ id, seq: id });
    }
    useRoomStore.setState({ messages: messages as never, inbox: { d1: { message_id: 1, recipient: 'me', state: 'consumed' } as never }, seq: 0 });

    applyFrame({ type: 'sync_complete', seq: HISTORY_PAGE_SIZE + 20 } as never);

    const kept = useRoomStore.getState().messages;
    // An interaction still waiting is not history: dropping it makes the inbox say,
    // untruthfully, that nothing needs the operator.
    expect(kept[1]).toBeDefined();
    expect(Object.keys(kept)).toHaveLength(HISTORY_PAGE_SIZE + 1);
  });

  it('still trims the ordinary chatter it is supposed to', () => {
    const { applyFrame, reset } = useRoomStore.getState();
    reset();
    const messages: Record<number, unknown> = {};
    for (let id = 1; id <= HISTORY_PAGE_SIZE + 10; id++) messages[id] = message({ id, seq: id });
    useRoomStore.setState({ messages: messages as never, seq: 0 });

    applyFrame({ type: 'sync_complete', seq: 999 } as never);
    expect(Object.keys(useRoomStore.getState().messages)).toHaveLength(HISTORY_PAGE_SIZE);
  });
});

// harn:assume history-cursor-tracks-only-the-contiguous-tail ref=contiguous-history-state-regression
describe('contiguous history cursor', () => {
  it('loads 1-161 exactly once while unresolved approval 10 stays pinned', () => {
    const messages: Record<number, Message> = {};
    for (let id = 1; id <= 161; id++) messages[id] = message({ id, seq: id });
    messages[10] = {
      ...messages[10]!,
      kind: 'approval',
      ask: {
        interaction_id: 'approval-10',
        kind: 'approval',
        prompt: 'Allow it?',
        options: [{ label: 'Allow' }],
      },
    };
    useRoomStore.setState({ messages, inbox: { d10: { message_id: 10, recipient: 'me', state: 'consumed' } as never }, seq: 0 });
    useRoomStore.getState().applyFrame({ type: 'sync_complete', seq: 161 });

    let state = useRoomStore.getState();
    expect(state.historyCursor).toBe(112);
    expect(sortedMessages(state.messages).map((item) => item.id)).toEqual([10, ...Array.from(
      { length: 50 },
      (_, index) => index + 112,
    )]);

    state.mergeHistoryPage(Array.from({ length: 50 }, (_, index) => messages[index + 62]!));
    state = useRoomStore.getState();
    expect(state.historyCursor).toBe(62);
    expect(state.messages[111]).toBeDefined();

    state.mergeHistoryPage(Array.from({ length: 50 }, (_, index) => messages[index + 12]!));
    state.mergeHistoryPage(Array.from({ length: 11 }, (_, index) => messages[index + 1]!));
    state.mergeHistoryPage([messages[1]!, messages[10]!]);
    state = useRoomStore.getState();
    expect(state.historyCursor).toBe(1);
    expect(sortedMessages(state.messages).map((item) => item.id)).toEqual(
      Array.from({ length: 161 }, (_, index) => index + 1),
    );

    state.applyFrame({ type: 'message', seq: 162, message: message({ id: 5, seq: 162 }) });
    expect(useRoomStore.getState().historyCursor).toBe(1);
  });
});
// harn:end history-cursor-tracks-only-the-contiguous-tail

// harn:assume approval-cards-follow-authoritative-inbox ref=actionable-approval-state-regression
describe('authoritative approval visibility', () => {
  const human = { id: 'me', kind: 'human', handle: 'richard' } as never;
  const interaction = (id: number, kind: 'ask' | 'approval'): Message => ({
    ...message({ id, seq: id }),
    kind,
    ask: { interaction_id: `i-${String(id)}`, kind, prompt: 'Continue?', options: [{ label: 'Yes' }] },
  });
  const stateFor = (item: Message, delivery: Record<string, unknown>, replies: Message[] = []) => ({
    messages: Object.fromEntries([item, ...replies].map((entry) => [entry.id, entry])),
    inbox: { delivery: { message_id: item.id, recipient: 'me', state: 'consumed', ...delivery } as never },
    members: { me: human },
    selfMemberId: 'me',
  });

  it('keeps an approval actionable only while its addressed consumed delivery is unread', () => {
    const approval = interaction(10, 'approval');
    expect(pendingInteractions(stateFor(approval, {})).map((item) => item.id)).toEqual([10]);
    expect(pendingInteractions(stateFor(approval, { read_ts: TS }))).toEqual([]);
    expect(pendingInteractions({
      ...stateFor(approval, {}),
      inbox: { delivery: { message_id: 10, recipient: 'someone-else', state: 'consumed' } as never },
    })).toEqual([]);
  });

  it('keeps question reply history semantics independent from delivery read state', () => {
    const question = interaction(20, 'ask');
    expect(pendingInteractions(stateFor(question, { read_ts: TS })).map((item) => item.id)).toEqual([20]);
    const reply = { ...message({ id: 21, seq: 21 }), reply_to: 20 };
    expect(pendingInteractions(stateFor(question, {}, [reply]))).toEqual([]);
  });
});
// harn:end approval-cards-follow-authoritative-inbox
