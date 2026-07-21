import {
  effectiveDefaultAgent,
  type Delivery,
  type Member,
  type MemberState,
  type Message,
  type Role,
  type Room,
  type RoomMeter,
  type ServerFrame,
  type WireEvent,
} from '@codor/protocol';
import { create } from 'zustand';

export interface MemberStateObservation {
  state: MemberState;
  ts: string;
}

export interface RunEventBuffer {
  events: WireEvent[];
  dropped_count: number;
  /** Journal index of events[0], seeded from stamped run_event frames. Absent
   *  when this buffer only ever saw unstamped frames (old daemons). */
  first_index?: number;
}

// harn:assume history-cursor-tracks-only-the-contiguous-tail ref=contiguous-history-state
export interface RoomState {
  connected: boolean;
  /** True once a cold hydration has COMMITTED. `connected` flips at socket-open,
   *  before any frame arrives, so only this can gate a transcript reveal. */
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
  /** Full-hydration routing hint retained when visible history is paged down. */
  latestFinalizedAgentId: string | undefined;
  /** Earliest id in the contiguous history range loaded from the newest message. */
  historyCursor: number | undefined;
  errors: string[];
  applyFrame(frame: ServerFrame): void;
  mergeHistoryPage(messages: Message[]): void;
  setConnected(connected: boolean): void;
  reset(): void;
}

export const HISTORY_PAGE_SIZE = 20;
export const RUN_EVENT_LIMIT = 500;

// harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-contract
/**
 * Cold hydration is staged OUTSIDE the store and committed once. Applying each
 * hydration frame straight into visible state made the transcript crawl in a row
 * at a time and mounted every historical run as it arrived — the amplifier behind
 * the journal storm. Frames land here until `sync_complete`, which publishes the
 * whole snapshot in a single update.
 *
 * Staging is per cold load only: a warm reconnect (seq > 0) never stages, so an
 * in-place finalization still applies the instant it arrives. `run_event` and
 * `error` frames are deliberately NOT staged — live evidence keeps flowing.
 */
interface HydrationStaging {
  selfMemberId?: string;
  room?: Room;
  members: Record<string, Member>;
  messages: Record<number, Message>;
  inbox: Record<string, Delivery>;
  meter?: RoomMeter;
}

let staging: HydrationStaging | undefined;

const freshStaging = (): HydrationStaging => ({ members: {}, messages: {}, inbox: {} });

/** Discard anything staged — a reset or room switch must never commit the
 *  previous room's frames into the next room's transcript. */
export function clearHydrationStaging(): void {
  staging = undefined;
}
// harn:end addressed-cold-hydration-is-strict-and-legacy-safe

// harn:assume live-run-event-cache-bounded ref=bounded-live-event-buffer
// harn:assume run-events-merge-by-journal-index ref=client-indexed-buffer-merge
export function appendRunEvent(
  buffer: RunEventBuffer | undefined,
  event: WireEvent,
  index?: number,
): RunEventBuffer {
  let current = buffer ?? { events: [], dropped_count: 0 };
  if (index !== undefined) {
    if (current.events.length === 0) {
      current = { ...current, first_index: index };
    } else if (current.first_index !== undefined) {
      const expected = current.first_index + current.events.length;
      // Exact re-delivery of something already buffered: drop it.
      if (index < expected) return current;
      // A gap means THIS socket missed events (reconnect); the journal fetch
      // owns that range — restart the buffer at the new true position.
      if (index > expected) current = { ...current, events: [], first_index: index };
    }
  }
  const events = [...current.events, event];
  const overflow = Math.max(0, events.length - RUN_EVENT_LIMIT);
  return {
    events: overflow === 0 ? events : events.slice(overflow),
    dropped_count: current.dropped_count + overflow,
    ...(current.first_index !== undefined && { first_index: current.first_index + overflow }),
  };
}
// harn:end run-events-merge-by-journal-index
// harn:end live-run-event-cache-bounded

const ROLE_RANK: Record<Role, number> = { observer: 0, member: 1, admin: 2, owner: 3 };

export const roleAtLeast = (role: Role | undefined, minimum: Role): boolean =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];

export const useRoomStore = create<RoomState>((set, get) => ({
  connected: false,
  hydrated: false,
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
  historyCursor: undefined,
  errors: [],

  // harn:assume client-syncs-by-seq ref=store-upsert-in-place
  // harn:assume permalink-ids-stable ref=paged-message-cache
  // Frames upsert entities IN PLACE by id — a run finalization replaces the
  // existing message row (same #N, new content). Hydration frames retain the
  // prior cursor; sync_complete advances it only after the full snapshot lands.
  applyFrame: (frame) => {
    // harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-contract
    // A cold hydration stages without touching the store AT ALL — no set(), so no
    // render per frame. Warm reconnects (seq > 0) fall straight through, and
    // run_event/error keep flowing so live evidence is never withheld.
    // The window is exactly `self` → `sync_complete`: the server opens every
    // hydration with self, so anything outside that window is a live frame and
    // applies immediately, exactly as before.
    if (get().seq === 0) {
      if (frame.type === 'self') {
        staging = freshStaging();
        staging.selfMemberId = frame.member_id;
        return;
      }
      if (staging !== undefined) {
        switch (frame.type) {
          case 'room':
            staging.room = frame.room;
            return;
          case 'member':
            staging.members[frame.member.id] = frame.member;
            return;
          case 'message':
            staging.messages[frame.message.id] = frame.message;
            return;
          case 'inbox':
            staging.inbox[frame.delivery.id] = frame.delivery;
            return;
          case 'meter':
            staging.meter = frame.meter;
            return;
          default:
            break;
        }
      }
    }
    // harn:end addressed-cold-hydration-is-strict-and-legacy-safe
    set((state) => {
      const bump = 'seq' in frame ? Math.max(state.seq, frame.seq) : state.seq;
      switch (frame.type) {
        case 'self':
          return { selfMemberId: frame.member_id };
        case 'room':
          return { seq: bump, room: frame.room };
        case 'sync_complete': {
          if (state.seq !== 0) return { seq: bump };
          // harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-contract
          // THE hydration commit: everything staged becomes visible together, and
          // the transcript may finally reveal itself.
          const staged = staging;
          staging = undefined;
          const members = { ...state.members, ...staged?.members };
          const memberHistory = { ...state.memberHistory };
          for (const member of Object.values(staged?.members ?? {})) {
            const observed = member.state ?? 'idle';
            const history = memberHistory[member.id] ?? [];
            if (history.at(-1)?.state !== observed) {
              memberHistory[member.id] = [
                ...history,
                { state: observed, ts: new Date().toISOString() },
              ].slice(-12);
            }
          }
          const merged = { ...state.messages, ...staged?.messages };
          const mergedInbox = { ...state.inbox, ...staged?.inbox };
          // The routing hint is derived against the COMMITTED roster — staged
          // member frames were never in `state.members`, so computing it per
          // frame (as the live path does) would silently drop it.
          let latestFinalizedAgentId = state.latestFinalizedAgentId;
          for (const message of Object.values(merged).sort((a, b) => a.id - b.id)) {
            if (
              message.kind === 'run' && message.run !== undefined
              && message.run.status !== 'running' && message.ack !== true
              && members[message.author]?.kind === 'agent'
            ) {
              latestFinalizedAgentId = message.author;
            }
          }
          const committed = {
            seq: bump,
            hydrated: true,
            members,
            memberHistory,
            inbox: mergedInbox,
            latestFinalizedAgentId,
            ...(staged?.selfMemberId !== undefined && { selfMemberId: staged.selfMemberId }),
            ...(staged?.room !== undefined && { room: staged.room }),
            ...(staged?.meter !== undefined && { meter: staged.meter }),
          };
          // When the server bounded the tail, its floor is authoritative — the
          // client must not re-derive a cursor from whatever happened to arrive.
          if (frame.history_floor !== undefined) {
            return { ...committed, messages: merged, historyCursor: frame.history_floor };
          }
          // harn:end addressed-cold-hydration-is-strict-and-legacy-safe
          const sorted = Object.values(merged).sort((a, b) => a.id - b.id);
          if (sorted.length <= HISTORY_PAGE_SIZE) {
            return { ...committed, messages: merged, historyCursor: sorted[0]?.id };
          }
          // harn:assume the-inbox-badge-and-panel-are-one-truth ref=pending-survives-history-trim
          // An interaction still waiting on the operator is not history. Trimming it
          // out of the window makes the inbox say, untruthfully, that nothing needs
          // them — the card is on the server, but the panel cannot see it.
          const answered = new Set<number>();
          for (const message of Object.values(merged)) {
            if (message.reply_to !== undefined) answered.add(message.reply_to);
          }
          const isPending = (message: Message): boolean =>
            (message.kind === 'ask' || message.kind === 'approval')
            && message.ask !== undefined
            && (message.kind === 'approval'
              ? Object.values(mergedInbox).some((delivery) =>
                delivery.message_id === message.id
                && delivery.state === 'consumed'
                && delivery.interaction_resolved_ts === undefined)
              : !answered.has(message.id));
          const tail = sorted.slice(-HISTORY_PAGE_SIZE);
          const kept = new Map(tail.map((m) => [m.id, m]));
          for (const message of sorted) if (isPending(message)) kept.set(message.id, message);
          const latest = [...kept.values()].sort((a, b) => a.id - b.id);
          // harn:end the-inbox-badge-and-panel-are-one-truth
          return {
            ...committed,
            messages: Object.fromEntries(latest.map((message) => [message.id, message])),
            historyCursor: tail[0]?.id,
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
          // harn:assume default-recipient-fallback-chain ref=web-effective-default-cache
          const finalizedAgent =
            frame.message.kind === 'run' &&
            frame.message.run !== undefined &&
            frame.message.run.status !== 'running' &&
            frame.message.ack !== true &&
            state.members[frame.message.author]?.kind === 'agent';
          // harn:end default-recipient-fallback-chain
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
              [frame.message_id]: appendRunEvent(
                state.runEvents[frame.message_id],
                frame.event,
                frame.index,
              ),
            },
          };
        case 'error':
          return { errors: [...state.errors, frame.message] };
        default:
          return {};
      }
    });
  },
  mergeHistoryPage: (messages) =>
    set((state) => {
      const earliest = messages.reduce<number | undefined>(
        (minimum, message) => minimum === undefined ? message.id : Math.min(minimum, message.id),
        undefined,
      );
      return {
        messages: {
          ...state.messages,
          ...Object.fromEntries(messages.map((message) => [message.id, message])),
        },
        ...(earliest !== undefined && {
          historyCursor: state.historyCursor === undefined
            ? earliest
            : Math.min(state.historyCursor, earliest),
        }),
      };
    }),
  // harn:end permalink-ids-stable
  // harn:end client-syncs-by-seq

  setConnected: (connected) => set({ connected }),
  reset: () => {
    // A room switch must never commit the previous room's staged frames.
    clearHydrationStaging();
    set({
      hydrated: false,
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
      historyCursor: undefined,
      errors: [],
    });
  },
}));
// harn:end history-cursor-tracks-only-the-contiguous-tail

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
    if (
      message.kind === 'run' &&
      message.run !== undefined &&
      message.run.status !== 'running' &&
      message.ack !== true
    ) {
      const author = members[message.author];
      if (author?.kind === 'agent') return author;
    }
  }
  return undefined;
};

// harn:assume default-recipient-fallback-chain ref=web-effective-default-cache
export const effectiveDefaultRecipient = (
  state: Pick<RoomState, 'room' | 'members' | 'latestFinalizedAgentId'>,
): Member | undefined => effectiveDefaultAgent({
  members: Object.values(state.members),
  latestFinalizedAgentId: state.latestFinalizedAgentId,
  startingAgentHandle: state.room?.config.starting_agent_handle,
});
// harn:end default-recipient-fallback-chain


// harn:assume the-inbox-badge-and-panel-are-one-truth ref=pending-interactions-selector
/**
 * The single answer to "what needs you". The header's count and the panel's list
 * both come from here, so a badge saying 3 can never open onto "Nothing needs
 * you" — and an ask addressed to somebody else is not the operator's to answer.
 */
export const pendingInteractions = (
  state: Pick<RoomState, 'messages' | 'inbox' | 'members' | 'selfMemberId'>,
): Message[] => {
  const self = me(state.members, state.selfMemberId);
  if (!self) return [];
  const answered = new Set<number>();
  for (const message of Object.values(state.messages)) {
    if (message.reply_to !== undefined) answered.add(message.reply_to);
  }
  // harn:assume approval-cards-follow-durable-resolution ref=actionable-approval-selector
  return Object.values(state.messages)
    .filter((message) =>
      (message.kind === 'ask' || message.kind === 'approval')
      && message.ask !== undefined
      && Object.values(state.inbox).some(
        (delivery) => delivery.message_id === message.id
          && delivery.recipient === self.id
          && (message.kind !== 'approval' || (
            delivery.state === 'consumed' && delivery.interaction_resolved_ts === undefined
          )),
      )
      && (message.kind !== 'ask' || !answered.has(message.id))
    )
    .sort((a, b) => a.id - b.id);
  // harn:end approval-cards-follow-durable-resolution
};
// harn:end the-inbox-badge-and-panel-are-one-truth
