import type {
  Delivery,
  Member,
  MemberState,
  Message,
  Room,
  RoomMeter,
  ServerFrame,
  WireEvent,
  Role,
} from '@wireroom/protocol';
import { create } from 'zustand';

export interface MemberStateObservation {
  state: MemberState;
  ts: string;
}

export interface RunEventBuffer {
  events: WireEvent[];
  dropped_count: number;
}

export interface RoomState {
  connected: boolean;
  selfMemberId: string | undefined;
  room: Room | undefined;
  seq: number;
  members: Record<string, Member>;
  memberHistory: Record<string, MemberStateObservation[]>;
  messages: Record<number, Message>;
  inbox: Record<string, Delivery>;
  meter: RoomMeter | undefined;
  runEvents: Record<number, RunEventBuffer>;
  /** Full-hydration routing hint retained when visible history is paged down. */
  latestFinalizedAgentId: string | undefined;
  errors: string[];
  applyFrame(frame: ServerFrame): void;
  mergeHistory(messages: Message[]): void;
  setConnected(connected: boolean): void;
  reset(): void;
}

export const HISTORY_PAGE_SIZE = 50;
export const RUN_EVENT_LIMIT = 500;

// harn:assume live-run-event-cache-bounded ref=bounded-live-event-buffer
export function appendRunEvent(
  buffer: RunEventBuffer | undefined,
  event: WireEvent,
): RunEventBuffer {
  const current = buffer ?? { events: [], dropped_count: 0 };
  const events = [...current.events, event];
  const overflow = Math.max(0, events.length - RUN_EVENT_LIMIT);
  return {
    events: overflow === 0 ? events : events.slice(overflow),
    dropped_count: current.dropped_count + overflow,
  };
}
// harn:end live-run-event-cache-bounded

const ROLE_RANK: Record<Role, number> = { observer: 0, member: 1, admin: 2, owner: 3 };

export const roleAtLeast = (role: Role | undefined, minimum: Role): boolean =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];

export const useRoomStore = create<RoomState>((set) => ({
  connected: false,
  selfMemberId: undefined,
  room: undefined,
  seq: 0,
  members: {},
  memberHistory: {},
  messages: {},
  inbox: {},
  meter: undefined,
  runEvents: {},
  latestFinalizedAgentId: undefined,
  errors: [],

  // harn:assume client-syncs-by-seq ref=store-upsert-in-place
  // harn:assume permalink-ids-stable ref=paged-message-cache
  // Frames upsert entities IN PLACE by id — a run finalization replaces the
  // existing message row (same #N, new content). Hydration frames retain the
  // prior cursor; sync_complete advances it only after the full snapshot lands.
  applyFrame: (frame) =>
    set((state) => {
      const bump = 'seq' in frame ? Math.max(state.seq, frame.seq) : state.seq;
      switch (frame.type) {
        case 'self':
          return { selfMemberId: frame.member_id };
        case 'room':
          return { seq: bump, room: frame.room };
        case 'sync_complete': {
          if (state.seq !== 0 || Object.keys(state.messages).length <= HISTORY_PAGE_SIZE) {
            return { seq: bump };
          }
          const latest = Object.values(state.messages)
            .sort((a, b) => a.id - b.id)
            .slice(-HISTORY_PAGE_SIZE);
          return {
            seq: bump,
            messages: Object.fromEntries(latest.map((message) => [message.id, message])),
          };
        }
        case 'member':
          {
            const nextState = frame.member.state ?? 'idle';
            const history = state.memberHistory[frame.member.id] ?? [];
            const last = history.at(-1);
            const nextHistory =
              last?.state === nextState
                ? history
                : [...history, { state: nextState, ts: new Date().toISOString() }].slice(-12);
            return {
              seq: bump,
              members: { ...state.members, [frame.member.id]: frame.member },
              memberHistory: {
                ...state.memberHistory,
                [frame.member.id]: nextHistory,
              },
            };
          }
        case 'message': {
          const finalizedAgent =
            frame.message.kind === 'run' &&
            frame.message.run !== undefined &&
            frame.message.run.status !== 'running' &&
            state.members[frame.message.author]?.kind === 'agent';
          return {
            seq: bump,
            messages: { ...state.messages, [frame.message.id]: frame.message },
            ...(finalizedAgent && { latestFinalizedAgentId: frame.message.author }),
          };
        }
        case 'inbox':
          return { seq: bump, inbox: { ...state.inbox, [frame.delivery.id]: frame.delivery } };
        case 'meter':
          return { seq: bump, meter: frame.meter };
        case 'run_event':
          return {
            runEvents: {
              ...state.runEvents,
              [frame.message_id]: appendRunEvent(state.runEvents[frame.message_id], frame.event),
            },
          };
        case 'error':
          return { errors: [...state.errors, frame.message] };
        default:
          return {};
      }
    }),
  mergeHistory: (messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        ...Object.fromEntries(messages.map((message) => [message.id, message])),
      },
    })),
  // harn:end permalink-ids-stable
  // harn:end client-syncs-by-seq

  setConnected: (connected) => set({ connected }),
  reset: () =>
    set({
      room: undefined,
      selfMemberId: undefined,
      seq: 0,
      members: {},
      memberHistory: {},
      messages: {},
      inbox: {},
      meter: undefined,
      runEvents: {},
      latestFinalizedAgentId: undefined,
      errors: [],
    }),
}));

// ── pure selectors (unit-tested) ────────────────────────────────────────

export const sortedMessages = (messages: Record<number, Message>): Message[] =>
  Object.values(messages).sort((a, b) => a.id - b.id);

export const me = (
  members: Record<string, Member>,
  selfMemberId?: string,
): Member | undefined => selfMemberId !== undefined
  ? members[selfMemberId]
  : Object.values(members).find((m) => m.kind === 'human' && m.role === 'owner');

export const unreadCount = (
  state: Pick<RoomState, 'inbox' | 'members' | 'selfMemberId'>,
): number => {
  const self = me(state.members, state.selfMemberId);
  if (!self) return 0;
  return Object.values(state.inbox).filter(
    (d) => d.recipient === self.id && d.state === 'consumed' && d.read_ts === undefined,
  ).length;
};

export const heldDeliveries = (inbox: Record<string, Delivery>): Delivery[] =>
  Object.values(inbox).filter((d) => d.state === 'held');

export const latestFinalizedAgentAuthor = (
  messages: Record<number, Message>,
  members: Record<string, Member>,
): Member | undefined => {
  const ordered = sortedMessages(messages);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const message = ordered[i]!;
    if (message.kind === 'run' && message.run !== undefined && message.run.status !== 'running') {
      const author = members[message.author];
      if (author?.kind === 'agent') return author;
    }
  }
  return undefined;
};
