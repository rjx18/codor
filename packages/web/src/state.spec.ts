import type { Member, Message } from '@wireroom/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  heldDeliveries,
  HISTORY_PAGE_SIZE,
  latestFinalizedAgentAuthor,
  me,
  sortedMessages,
  unreadCount,
  useRoomStore,
} from './state.js';

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const ULID_C = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const TS = '2026-07-10T07:00:00.000Z';

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
    state.mergeHistory([message({ id: 5, seq: 5 }), message({ id: 4, seq: 4 })]);

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
    expect(state.runEvents[1]).toHaveLength(1);
    expect(state.seq).toBe(2); // ephemeral frames never move the cursor
  });

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
});
