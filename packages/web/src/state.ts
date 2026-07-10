import type {
  Delivery,
  Member,
  Message,
  Room,
  RoomMeter,
  ServerFrame,
  WireEvent,
} from '@wireroom/protocol';
import { create } from 'zustand';

export interface RoomState {
  connected: boolean;
  room: Room | undefined;
  seq: number;
  members: Record<string, Member>;
  messages: Record<number, Message>;
  inbox: Record<string, Delivery>;
  meter: RoomMeter | undefined;
  runEvents: Record<number, WireEvent[]>;
  errors: string[];
  applyFrame(frame: ServerFrame): void;
  setConnected(connected: boolean): void;
  reset(): void;
}

export const useRoomStore = create<RoomState>((set) => ({
  connected: false,
  room: undefined,
  seq: 0,
  members: {},
  messages: {},
  inbox: {},
  meter: undefined,
  runEvents: {},
  errors: [],

  // harn:assume client-syncs-by-seq ref=store-upsert-in-place
  // Frames upsert entities IN PLACE by id — a run finalization replaces the
  // existing message row (same #N, new content). Hydration frames retain the
  // prior cursor; sync_complete advances it only after the full snapshot lands.
  applyFrame: (frame) =>
    set((state) => {
      const bump = 'seq' in frame ? Math.max(state.seq, frame.seq) : state.seq;
      switch (frame.type) {
        case 'room':
          return { seq: bump, room: frame.room };
        case 'sync_complete':
          return { seq: bump };
        case 'member':
          return { seq: bump, members: { ...state.members, [frame.member.id]: frame.member } };
        case 'message':
          return { seq: bump, messages: { ...state.messages, [frame.message.id]: frame.message } };
        case 'inbox':
          return { seq: bump, inbox: { ...state.inbox, [frame.delivery.id]: frame.delivery } };
        case 'meter':
          return { seq: bump, meter: frame.meter };
        case 'run_event':
          return {
            runEvents: {
              ...state.runEvents,
              [frame.message_id]: [...(state.runEvents[frame.message_id] ?? []), frame.event],
            },
          };
        case 'error':
          return { errors: [...state.errors, frame.message] };
        default:
          return {};
      }
    }),
  // harn:end client-syncs-by-seq

  setConnected: (connected) => set({ connected }),
  reset: () =>
    set({ room: undefined, seq: 0, members: {}, messages: {}, inbox: {}, meter: undefined, runEvents: {}, errors: [] }),
}));

// ── pure selectors (unit-tested) ────────────────────────────────────────

export const sortedMessages = (messages: Record<number, Message>): Message[] =>
  Object.values(messages).sort((a, b) => a.id - b.id);

export const me = (members: Record<string, Member>): Member | undefined =>
  Object.values(members).find((m) => m.kind === 'human' && m.role === 'owner');

export const unreadCount = (state: Pick<RoomState, 'inbox' | 'members'>): number => {
  const self = me(state.members);
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
