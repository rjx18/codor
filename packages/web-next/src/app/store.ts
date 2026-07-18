import {
  effectiveDefaultAgent,
  type Delivery,
  type Member,
  type MemberState,
  type Message,
  type Role,
  type Room,
  type RoomMeter,
  type RoomSupport,
  type ServerFrame,
} from '@codor/protocol';
import { create } from 'zustand';

import {
  appendRunEvent,
  type MemberStateObservation,
  type RunEventBuffer,
} from '@legacy/state.js';

export const HISTORY_PAGE_SIZE = 20;

export interface RoomSlice {
  hydrated: boolean;
  selfMemberId: string | undefined;
  room: Room | undefined;
  seq: number;
  members: Record<string, Member>;
  memberHistory: Record<string, MemberStateObservation[]>;
  messages: Record<number, Message>;
  inbox: Record<string, Delivery>;
  meter: RoomMeter | undefined;
  runEvents: Record<number, RunEventBuffer>;
  support: RoomSupport | undefined;
  historyCursor: number | undefined;
  errors: string[];
}

interface ClientState {
  connected: boolean;
  activeRoom: string;
  rooms: Record<string, RoomSlice>;
  roomList: Room[];
  applyFrame(frame: ServerFrame, fallbackRoom?: string): void;
  mergeHistoryPage(room: string, messages: Message[]): void;
  setActiveRoom(room: string): void;
  setConnected(connected: boolean): void;
  reset(): void;
}

const emptyMembers: Record<string, Member> = {};
const emptyMessages: Record<number, Message> = {};
const emptyInbox: Record<string, Delivery> = {};
const emptyRunEvents: Record<number, RunEventBuffer> = {};
const emptyMemberHistory: Record<string, MemberStateObservation[]> = {};
const emptyErrors: string[] = [];

const EMPTY_ROOM: RoomSlice = {
  hydrated: false,
  selfMemberId: undefined,
  room: undefined,
  seq: 0,
  members: emptyMembers,
  memberHistory: emptyMemberHistory,
  messages: emptyMessages,
  inbox: emptyInbox,
  meter: undefined,
  runEvents: emptyRunEvents,
  support: undefined,
  historyCursor: undefined,
  errors: emptyErrors,
};

const freshRoom = (room?: Room): RoomSlice => ({
  hydrated: false,
  selfMemberId: undefined,
  room,
  seq: 0,
  members: {},
  memberHistory: {},
  messages: {},
  inbox: {},
  meter: undefined,
  runEvents: {},
  support: undefined,
  historyCursor: undefined,
  errors: [],
});

interface HydrationStaging {
  selfMemberId?: string;
  room?: Room;
  members: Record<string, Member>;
  messages: Record<number, Message>;
  inbox: Record<string, Delivery>;
  meter?: RoomMeter;
  support?: RoomSupport;
}

const staging = new Map<string, HydrationStaging>();
const freshStaging = (): HydrationStaging => ({ members: {}, messages: {}, inbox: {} });

function frameRoom(frame: ServerFrame, fallback?: string): string | undefined {
  switch (frame.type) {
    case 'self':
    case 'member':
    case 'sync_complete':
      return frame.room ?? fallback;
    case 'message':
      return frame.message.room;
    case 'inbox':
      return frame.delivery.room;
    case 'consume_result':
      return frame.message.room;
    case 'meter':
      return frame.meter.room;
    case 'room':
      return frame.room.id;
    case 'room_support':
      return frame.support.room;
    case 'run_event':
      return frame.room;
    default:
      return fallback;
  }
}

function observeMember(
  history: Record<string, MemberStateObservation[]>,
  member: Member,
): Record<string, MemberStateObservation[]> {
  const state: MemberState = member.state ?? 'idle';
  const prior = history[member.id] ?? [];
  if (prior.at(-1)?.state === state) return history;
  return {
    ...history,
    [member.id]: [...prior, { state, ts: new Date().toISOString() }].slice(-12),
  };
}

function rollingTail(messages: Record<number, Message>, next: Message): Record<number, Message> {
  const merged = { ...messages, [next.id]: next };
  const ordered = Object.values(merged).sort((left, right) => left.id - right.id);
  if (ordered.length <= HISTORY_PAGE_SIZE) return merged;
  return Object.fromEntries(
    ordered.slice(-HISTORY_PAGE_SIZE).map((message) => [message.id, message]),
  );
}

export const useClientStore = create<ClientState>((set, get) => ({
  connected: false,
  activeRoom: '',
  rooms: {},
  roomList: [],

  applyFrame: (frame, fallbackRoom) => {
    if (frame.type === 'rooms') {
      set((state) => {
        const rooms = { ...state.rooms };
        for (const room of frame.rooms) {
          rooms[room.id] = rooms[room.id] === undefined
            ? freshRoom(room)
            : { ...rooms[room.id]!, room };
        }
        return { roomList: frame.rooms, rooms };
      });
      return;
    }

    const roomId = frameRoom(frame, fallbackRoom);
    if (roomId === undefined) return;
    const existing = get().rooms[roomId] ?? EMPTY_ROOM;

    // Every addressed cold snapshot starts with self. Keep each room's frames
    // outside visible Zustand state until that room's sync_complete arrives.
    if (frame.type === 'self' && !existing.hydrated) {
      const stage = freshStaging();
      stage.selfMemberId = frame.member_id;
      staging.set(roomId, stage);
      return;
    }
    const stage = staging.get(roomId);
    if (stage !== undefined) {
      switch (frame.type) {
        case 'room':
          stage.room = frame.room;
          return;
        case 'member':
          stage.members[frame.member.id] = frame.member;
          return;
        case 'message':
          stage.messages[frame.message.id] = frame.message;
          return;
        case 'inbox':
          stage.inbox[frame.delivery.id] = frame.delivery;
          return;
        case 'meter':
          stage.meter = frame.meter;
          return;
        case 'room_support':
          stage.support = frame.support;
          return;
        default:
          break;
      }
    }

    set((state) => {
      const current = state.rooms[roomId] ?? freshRoom();
      const bump = 'seq' in frame ? Math.max(current.seq, frame.seq) : current.seq;
      let next = current;
      switch (frame.type) {
        case 'self':
          next = { ...current, selfMemberId: frame.member_id };
          break;
        case 'room':
          next = { ...current, seq: bump, room: frame.room };
          break;
        case 'sync_complete': {
          const hydrated = staging.get(roomId);
          staging.delete(roomId);
          if (hydrated === undefined) {
            next = { ...current, seq: bump, hydrated: true };
            break;
          }
          // A live delta can race ahead of the subscription's opening `self`
          // frame when several rooms share one socket. The snapshot remains the
          // atomic base, while any already-landed delta in `current` wins.
          const members = { ...hydrated.members, ...current.members };
          const messages = { ...hydrated.messages, ...current.messages };
          const inbox = { ...hydrated.inbox, ...current.inbox };
          let memberHistory = current.memberHistory;
          for (const member of Object.values(members)) {
            memberHistory = observeMember(memberHistory, member);
          }
          next = {
            ...current,
            hydrated: true,
            seq: bump,
            selfMemberId: hydrated.selfMemberId,
            room: hydrated.room ?? current.room,
            members,
            memberHistory,
            messages,
            inbox,
            meter: current.meter ?? hydrated.meter,
            support: current.support ?? hydrated.support,
            historyCursor: frame.history_floor
              ?? Object.values(messages).sort((a, b) => a.id - b.id)[0]?.id,
          };
          break;
        }
        case 'member':
          next = {
            ...current,
            seq: bump,
            members: { ...current.members, [frame.member.id]: frame.member },
            memberHistory: observeMember(current.memberHistory, frame.member),
          };
          break;
        case 'message': {
          const messages = state.activeRoom === roomId
            ? { ...current.messages, [frame.message.id]: frame.message }
            : rollingTail(current.messages, frame.message);
          next = {
            ...current,
            seq: bump,
            messages,
            ...(state.activeRoom !== roomId && {
              historyCursor: Object.values(messages).sort((a, b) => a.id - b.id)[0]?.id,
            }),
          };
          break;
        }
        case 'inbox':
          next = {
            ...current,
            seq: bump,
            inbox: { ...current.inbox, [frame.delivery.id]: frame.delivery },
          };
          break;
        case 'consume_result':
          next = {
            ...current,
            messages: { ...current.messages, [frame.message.id]: frame.message },
            inbox: { ...current.inbox, [frame.delivery.id]: frame.delivery },
          };
          break;
        case 'meter':
          next = { ...current, seq: bump, meter: frame.meter };
          break;
        case 'room_support':
          next = { ...current, seq: bump, support: frame.support };
          break;
        case 'run_event':
          // Background rooms need summary changes, not partial evidence buffers.
          // A promotion reads the authoritative journal from scratch.
          if (state.activeRoom !== roomId) return {};
          next = {
            ...current,
            runEvents: {
              ...current.runEvents,
              [frame.message_id]: appendRunEvent(
                current.runEvents[frame.message_id],
                frame.event,
                frame.index,
              ),
            },
          };
          break;
        case 'error':
          next = { ...current, errors: [...current.errors, frame.message] };
          break;
        default:
          return {};
      }
      return { rooms: { ...state.rooms, [roomId]: next } };
    });
  },

  mergeHistoryPage: (roomId, messages) => {
    set((state) => {
      const current = state.rooms[roomId] ?? freshRoom();
      const earliest = messages.reduce<number | undefined>(
        (minimum, message) => minimum === undefined ? message.id : Math.min(minimum, message.id),
        undefined,
      );
      return {
        rooms: {
          ...state.rooms,
          [roomId]: {
            ...current,
            messages: {
              ...current.messages,
              ...Object.fromEntries(messages.map((message) => [message.id, message])),
            },
            ...(earliest !== undefined && {
              historyCursor: current.historyCursor === undefined
                ? earliest
                : Math.min(current.historyCursor, earliest),
            }),
          },
        },
      };
    });
  },

  setActiveRoom: (roomId) => {
    set((state) => {
      if (state.activeRoom === roomId) return {};
      const rooms = { ...state.rooms };
      const previous = rooms[state.activeRoom];
      if (previous !== undefined && Object.keys(previous.runEvents).length > 0) {
        rooms[state.activeRoom] = { ...previous, runEvents: {} };
      }
      if (rooms[roomId] === undefined) rooms[roomId] = freshRoom();
      return { activeRoom: roomId, rooms };
    });
  },

  setConnected: (connected) => set({ connected }),
  reset: () => {
    staging.clear();
    set({ connected: false, activeRoom: '', rooms: {}, roomList: [] });
  },
}));

export const roomSlice = (state: ClientState, room: string): RoomSlice =>
  state.rooms[room] ?? EMPTY_ROOM;

export const sortedMessages = (messages: Record<number, Message>): Message[] =>
  Object.values(messages).sort((left, right) => left.id - right.id);

export const me = (
  members: Record<string, Member>,
  selfMemberId?: string,
): Member | undefined => selfMemberId !== undefined
  ? members[selfMemberId]
  : Object.values(members).find((member) => member.kind === 'human' && member.role === 'owner');

export const heldDeliveries = (inbox: Record<string, Delivery>): Delivery[] =>
  Object.values(inbox).filter((delivery) => delivery.state === 'held');

const ROLE_RANK: Record<Role, number> = { observer: 0, member: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role: Role | undefined, minimum: Role): boolean =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];

export const effectiveDefaultRecipient = (slice: RoomSlice): Member | undefined =>
  effectiveDefaultAgent({
    members: Object.values(slice.members),
    latestFinalizedAgentId: slice.support?.latest_finalized_agent_id,
    startingAgentHandle: slice.room?.config.starting_agent_handle,
  });

export function resetClientStoreForTest(): void {
  useClientStore.getState().reset();
}
