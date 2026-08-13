import {
  effectiveDefaultAgent,
  type Delivery,
  type RegisteredWorktree,
  type Member,
  type MemberState,
  type Message,
  type Role,
  type Room,
  type RoomMeter,
  type RoomSummary,
  type RoomSupport,
  type Schedule,
  type ServerFrame,
  type TranscriptHistoryJournal,
  type TranscriptHistoryPage,
  type TranscriptHistoryUnit,
} from '@codor/protocol';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

import {
  appendRunEvent,
  type MemberStateObservation,
  type RunEventBuffer,
} from '@runtime/state.js';

export const HISTORY_PAGE_SIZE = 20;

export interface TranscriptHistoryState {
  /** A successful head response, including an honestly empty one, has landed. */
  initialized: boolean;
  /** A persisted readable projection has not yet been proven by this
   * authenticated browser session. */
  headNeedsRevalidation: boolean;
  /** The mounted host predates the combined transcript-history endpoint. */
  legacyFallback: boolean;
  loadingHead: boolean;
  loadingCursor: string | undefined;
  failed: boolean;
  /** Message ids present when the first combined-head request began. They are
   * cold WebSocket context, not a second finalized-history source. */
  coldMessageIds: Record<number, true> | undefined;
  messages: Record<number, Message>;
  journals: Record<number, TranscriptHistoryJournal>;
  units: TranscriptHistoryUnit[];
  /** Newest successfully materialized server page. Kept separately so a
   * bounded last-good snapshot never pairs a sliced unit tail with the cursor
   * of some older page the operator subsequently loaded. */
  latestPage: TranscriptHistoryPage | undefined;
  /** Undefined before the first successful head; null at the archive floor. */
  beforeCursor: string | null | undefined;
  hasMore: boolean;
}

const EMPTY_TRANSCRIPT_HISTORY: TranscriptHistoryState = {
  initialized: false,
  headNeedsRevalidation: false,
  legacyFallback: false,
  loadingHead: false,
  loadingCursor: undefined,
  failed: false,
  coldMessageIds: undefined,
  messages: {},
  journals: {},
  units: [],
  latestPage: undefined,
  beforeCursor: undefined,
  hasMore: true,
};

const freshTranscriptHistory = (): TranscriptHistoryState => ({
  ...EMPTY_TRANSCRIPT_HISTORY,
  messages: {},
  journals: {},
  units: [],
});

export interface RoomSlice {
  hydrated: boolean;
  selfMemberId: string | undefined;
  room: Room | undefined;
  seq: number;
  members: Record<string, Member>;
  memberHistory: Record<string, MemberStateObservation[]>;
  messages: Record<number, Message>;
  // harn:assume browser-schedules-follow-authoritative-room-state ref=schedule-room-store
  schedules: Record<string, Schedule>;
  /** Producing sequence per schedule id; cancel results reuse the current row. */
  scheduleSeq: Record<string, number>;
  // harn:end browser-schedules-follow-authoritative-room-state
  inbox: Record<string, Delivery>;
  meter: RoomMeter | undefined;
  runEvents: Record<number, RunEventBuffer>;
  support: RoomSupport | undefined;
  historyCursor: number | undefined;
  // harn:assume finalized-browser-history-is-combined-page-owned ref=combined-history-store
  transcriptHistory: TranscriptHistoryState;
  // harn:end finalized-browser-history-is-combined-page-owned
  errors: string[];
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-client-error-correlation
  errorRefs: Record<string, number>;
  /** Exact latest text for each correlated action, so overlapping actions never
   * borrow the room's generic latest error from one another. */
  errorTexts: Record<string, string>;
  // harn:end member-context-reset-is-authorized-atomic-and-lazy
  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-projection
  /** Correlated management results retained until their owning card consumes them. */
  actionResults: Record<string, ActionResult>;
  /** Client-owned ref → member target, used to keep errors member-local. */
  actionTargets: Record<string, string>;
  // harn:end context-reset-confirmation-is-anchored-and-member-local
}

// harn:assume context-reset-requests-settle-by-explicit-ref ref=clear-context-ref-client-result
export interface ActionResult {
  ref: string;
  status: 'success' | 'error';
  memberId?: string;
  message?: string;
}
// harn:end context-reset-requests-settle-by-explicit-ref

// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-state
/** The last successful root-scoped registration projection. Transient
 * REST/socket failure never clears it: rows render last-good state until a
 * refresh or reconnect replaces the set. */
export interface WorktreeGroupSlice {
  repositoryId: string | undefined;
  /** Main first, active secondaries alias-ordered (server ordering). */
  registered: RegisteredWorktree[];
  loaded: boolean;
}
// harn:end registered-worktree-navigation-is-promotion-gated

export interface ClientState {
  connected: boolean;
  /** The connector parked on a device-auth refusal (app-WS 4403): positive
   *  pairing-dead evidence for the recovery surface. Cleared on (re)connect. */
  authRefused: boolean;
  activeRoom: string;
  rooms: Record<string, RoomSlice>;
  roomList: Room[];
  roomSummaries: RoomSummary[];
  roomSummariesLoaded: boolean;
  /** Root room id → last-good registered worktree projection. */
  worktreeGroups: Record<string, WorktreeGroupSlice>;
  // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-room-readiness-state
  /** Exact-room live evidence for the connector's CURRENT socket generation:
   *  a room appears here only after its own addressed sync_complete since the
   *  latest generation start. Retained room slices are last-good content and
   *  never mark readiness; the connector clears this evidence on every socket
   *  replacement, so rows re-render connecting until each room re-proves. */
  roomLive: Record<string, true>;
  applyFrame(frame: ServerFrame, fallbackRoom?: string): void;
  mergeHistoryPage(room: string, messages: Message[]): void;
  updateTranscriptHistory(
    room: string,
    update: (current: TranscriptHistoryState) => TranscriptHistoryState,
  ): void;
  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-projection
  /** Remember the exact target before a correlated management act is sent. */
  registerActionRef(room: string, ref: string, memberId: string): void;
  /** Read and remove one bounded correlated result from its source room. */
  consumeActionResult(room: string, ref: string): ActionResult | undefined;
  // harn:end context-reset-confirmation-is-anchored-and-member-local
  setActiveRoom(room: string): void;
  setConnected(connected: boolean): void;
  setAuthRefused(authRefused: boolean): void;
  setRoomSummaries(summaries: RoomSummary[]): void;
  hydrateLastGoodRoom(
    room: Room,
    summaries: RoomSummary[],
    history: Pick<TranscriptHistoryState, 'messages' | 'journals' | 'units' | 'hasMore'> & {
      beforeCursor: string | null;
    },
  ): void;
  setWorktreeGroup(root: string, group: { repositoryId?: string; registered: RegisteredWorktree[] }): void;
  /** Withdraw current-generation live evidence for the listed rooms (socket
   *  replacement or a fresh desire): they read connecting until their own new
   *  sync_complete. */
  markRoomsConnecting(rooms: readonly string[]): void;
  /** Record that a room's own addressed sync_complete arrived in the current
   *  generation. */
  markRoomLive(room: string): void;
  // harn:end worktree-conversation-status-is-live-and-independent
  reset(): void;
}

const emptyMembers: Record<string, Member> = {};
const emptyMessages: Record<number, Message> = {};
const emptySchedules: Record<string, Schedule> = {};
const emptyScheduleSeq: Record<string, number> = {};
const emptyInbox: Record<string, Delivery> = {};
const emptyRunEvents: Record<number, RunEventBuffer> = {};
const emptyMemberHistory: Record<string, MemberStateObservation[]> = {};
const emptyErrors: string[] = [];
const emptyErrorRefs: Record<string, number> = {};
const emptyErrorTexts: Record<string, string> = {};
const emptyActionResults: Record<string, ActionResult> = {};
const emptyActionTargets: Record<string, string> = {};
const MAX_ACTION_RESULTS = 64;
const MAX_ACTION_TARGETS = 64;

const EMPTY_ROOM: RoomSlice = {
  hydrated: false,
  selfMemberId: undefined,
  room: undefined,
  seq: 0,
  members: emptyMembers,
  memberHistory: emptyMemberHistory,
  messages: emptyMessages,
  schedules: emptySchedules,
  scheduleSeq: emptyScheduleSeq,
  inbox: emptyInbox,
  meter: undefined,
  runEvents: emptyRunEvents,
  support: undefined,
  historyCursor: undefined,
  transcriptHistory: EMPTY_TRANSCRIPT_HISTORY,
  errors: emptyErrors,
  errorRefs: emptyErrorRefs,
  errorTexts: emptyErrorTexts,
  actionResults: emptyActionResults,
  actionTargets: emptyActionTargets,
};

const freshRoom = (room?: Room): RoomSlice => ({
  hydrated: false,
  selfMemberId: undefined,
  room,
  seq: 0,
  members: {},
  memberHistory: {},
  messages: {},
  schedules: {},
  scheduleSeq: {},
  inbox: {},
  meter: undefined,
  runEvents: {},
  support: undefined,
  historyCursor: undefined,
  transcriptHistory: freshTranscriptHistory(),
  errors: [],
  errorRefs: {},
  errorTexts: {},
  actionResults: {},
  actionTargets: {},
});

function projectActionResult(current: RoomSlice, result: ActionResult): RoomSlice {
  const actionResults = { ...current.actionResults, [result.ref]: result };
  const resultRefs = Object.keys(actionResults);
  while (resultRefs.length > MAX_ACTION_RESULTS) {
    const oldest = resultRefs.shift();
    if (oldest !== undefined) delete actionResults[oldest];
  }
  // Keep the target beside its result until the owning card consumes that
  // exact ref. This lets a remounted card distinguish its own settled result
  // from an unrelated member frame while the source room remains authoritative.
  return { ...current, actionResults };
}

function retainActionTarget(
  current: RoomSlice,
  ref: string,
  memberId: string,
): RoomSlice {
  const actionTargets = { ...current.actionTargets, [ref]: memberId };
  const targetRefs = Object.keys(actionTargets);
  while (targetRefs.length > MAX_ACTION_TARGETS) {
    const oldest = targetRefs.shift();
    if (oldest !== undefined) delete actionTargets[oldest];
  }
  return { ...current, actionTargets };
}

interface HydrationStaging {
  selfMemberId?: string;
  room?: Room;
  members: Record<string, Member>;
  messages: Record<number, Message>;
  schedules: Record<string, { schedule: Schedule; seq: number }>;
  inbox: Record<string, Delivery>;
  meter?: RoomMeter;
  support?: RoomSupport;
}

const freshStaging = (): HydrationStaging => ({ members: {}, messages: {}, schedules: {}, inbox: {} });

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
    case 'schedule':
      return frame.schedule.room;
    case 'cancel_schedule_result':
      return frame.schedule.room;
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

function mergeMessagesBySequence(
  retained: Record<number, Message>,
  staged: Record<number, Message>,
): Record<number, Message> {
  const merged = { ...retained };
  for (const [id, message] of Object.entries(staged)) {
    const previous = merged[Number(id)];
    if (previous === undefined || message.seq >= previous.seq) merged[Number(id)] = message;
  }
  return merged;
}

function mergeSchedulesBySequence(
  retained: Record<string, Schedule>,
  retainedSeq: Record<string, number>,
  staged: Record<string, { schedule: Schedule; seq: number }>,
): { schedules: Record<string, Schedule>; scheduleSeq: Record<string, number> } {
  const schedules = { ...retained };
  const scheduleSeq = { ...retainedSeq };
  for (const { schedule, seq } of Object.values(staged)) {
    const prior = scheduleSeq[schedule.id] ?? -1;
    if (seq >= prior) {
      schedules[schedule.id] = schedule;
      scheduleSeq[schedule.id] = seq;
    }
  }
  return { schedules, scheduleSeq };
}

export type ClientStore = UseBoundStore<StoreApi<ClientState>>;

const clientStoreByHistoryAction = new WeakMap<ClientState['updateTranscriptHistory'], ClientStore>();

/** Build one fully-isolated client store. Hosted computer sessions each own one;
 *  the exported singleton below remains the unchanged direct/self-hosted path. */
export function createClientStore(): ClientStore {
  const staging = new Map<string, HydrationStaging>();
  const store = create<ClientState>((set) => ({
  connected: false,
  authRefused: false,
  activeRoom: '',
  rooms: {},
  roomList: [],
  roomSummaries: [],
  roomSummariesLoaded: false,
  worktreeGroups: {},
  roomLive: {},

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

    // harn:assume combined-history-sync-classifies-bounded-cold-only ref=warm-sync-authoritative-merge
    // Every addressed subscription snapshot starts with self. Keep its frames
    // outside visible Zustand state until sync_complete even when retained or
    // cached content is already readable: hydrated is last-good presentation,
    // not proof that this generation's opening snapshot is live delta traffic.
    if (frame.type === 'self') {
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
          if (frame.ref !== undefined) {
            set((state) => {
              const current = state.rooms[roomId] ?? freshRoom();
              const next = projectActionResult(current, {
                ref: frame.ref!,
                status: 'success',
                memberId: frame.member.id,
              });
              return { rooms: { ...state.rooms, [roomId]: next } };
            });
          }
          return;
        case 'message':
          stage.messages[frame.message.id] = frame.message;
          return;
        case 'schedule':
          stage.schedules[frame.schedule.id] = { schedule: frame.schedule, seq: frame.seq };
          return;
        case 'cancel_schedule_result':
          stage.schedules[frame.schedule.id] = { schedule: frame.schedule, seq: 0 };
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
          // The opening snapshot is the authoritative base. Retained records
          // not present in a warm delta survive, while a message collision is
          // resolved by protocol sequence so a genuinely newer live record
          // cannot be replaced by an older staged snapshot.
          const members = { ...current.members, ...hydrated.members };
          const messages = mergeMessagesBySequence(current.messages, hydrated.messages);
          const scheduleState = mergeSchedulesBySequence(
            current.schedules,
            current.scheduleSeq,
            hydrated.schedules,
          );
          const inbox = { ...current.inbox, ...hydrated.inbox };
          let memberHistory = current.memberHistory;
          for (const member of Object.values(members)) {
            memberHistory = observeMember(memberHistory, member);
          }
          // Only a bounded cold snapshot is page context. Warm replay omits
          // history_floor and must remain visible live recovery; frames received
          // after sync_complete bypass staging and remain live as before.
          const transcriptHistory = frame.history_floor !== undefined
            && current.transcriptHistory.coldMessageIds !== undefined
            ? {
                ...current.transcriptHistory,
                coldMessageIds: {
                  ...current.transcriptHistory.coldMessageIds,
                  ...Object.fromEntries(
                    Object.keys(hydrated.messages).map((id) => [Number(id), true as const]),
                  ),
                },
              }
            : current.transcriptHistory;
          // harn:end combined-history-sync-classifies-bounded-cold-only
          next = {
            ...current,
            hydrated: true,
            seq: bump,
            selfMemberId: hydrated.selfMemberId,
            room: hydrated.room ?? current.room,
            members,
            memberHistory,
            messages,
            schedules: scheduleState.schedules,
            scheduleSeq: scheduleState.scheduleSeq,
            inbox,
            meter: hydrated.meter ?? current.meter,
            support: hydrated.support ?? current.support,
            transcriptHistory,
            historyCursor: frame.history_floor
              ?? current.historyCursor
              ?? Object.values(messages).sort((a, b) => a.id - b.id)[0]?.id,
          };
          break;
        }
        case 'member':
          // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-projection
          const memberCurrent = frame.ref === undefined
            ? current
            : projectActionResult(current, {
                ref: frame.ref,
                status: 'success',
                memberId: frame.member.id,
              });
          next = {
            ...memberCurrent,
            seq: bump,
            members: { ...memberCurrent.members, [frame.member.id]: frame.member },
            memberHistory: observeMember(memberCurrent.memberHistory, frame.member),
          };
          // harn:end context-reset-confirmation-is-anchored-and-member-local
          break;
        // harn:assume paged-history-live-message-reconciliation ref=live-history-message-map
        case 'message': {
          const messages = state.activeRoom === roomId
            ? { ...current.messages, [frame.message.id]: frame.message }
            : rollingTail(current.messages, frame.message);
          const historical = current.transcriptHistory.messages[frame.message.id];
          const transcriptHistory = historical !== undefined
            && frame.message.seq > historical.seq
            ? {
                ...current.transcriptHistory,
                messages: {
                  ...current.transcriptHistory.messages,
                  [frame.message.id]: frame.message,
                },
              }
            : current.transcriptHistory;
          next = {
            ...current,
            seq: bump,
            messages,
            transcriptHistory,
            ...(state.activeRoom !== roomId && {
              historyCursor: Object.values(messages).sort((a, b) => a.id - b.id)[0]?.id,
            }),
          };
          break;
        }
        // harn:assume browser-schedules-follow-authoritative-room-state ref=schedule-room-store-regression
        case 'schedule': {
          const prior = current.scheduleSeq[frame.schedule.id] ?? -1;
          if (frame.seq <= prior) return {};
          next = {
            ...current,
            seq: bump,
            schedules: { ...current.schedules, [frame.schedule.id]: frame.schedule },
            scheduleSeq: { ...current.scheduleSeq, [frame.schedule.id]: frame.seq },
          };
          break;
        }
        case 'cancel_schedule_result':
          next = {
            ...current,
            schedules: { ...current.schedules, [frame.schedule.id]: frame.schedule },
            // A result has no independent room sequence; the schedule frame's
            // producing sequence remains the cursor authority.
          };
          break;
        // harn:end browser-schedules-follow-authoritative-room-state
        // harn:end paged-history-live-message-reconciliation
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
          // room_support carries the room's currentSeq, which is NOT a
          // contiguous delivery cursor: advancing `seq` here would jump the
          // per-room cursor past a message frame the client missed, making the
          // gap undetectable by resume OR seq reconciliation (only a cold reload
          // would recover it). Support is authoritative content; the cursor must
          // still reflect only actually-delivered ordered frames.
          next = { ...current, support: frame.support };
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
          // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-client-error-correlation
          next = {
            ...current,
            errors: [...current.errors, frame.message],
            ...(frame.ref !== undefined && {
              errorRefs: {
                ...current.errorRefs,
                [frame.ref]: (current.errorRefs[frame.ref] ?? 0) + 1,
              },
              errorTexts: {
                ...current.errorTexts,
                [frame.ref]: frame.message,
              },
            }),
          };
          // harn:assume context-reset-requests-settle-by-explicit-ref ref=clear-context-ref-client-result
          if (frame.ref !== undefined) {
            next = projectActionResult(next, {
              ref: frame.ref,
              status: 'error',
              memberId: current.actionTargets[frame.ref],
              message: frame.message,
            });
          }
          // harn:end context-reset-requests-settle-by-explicit-ref
          // harn:end member-context-reset-is-authorized-atomic-and-lazy
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

  // The action closure belongs to the originating store. In hosted mode the
  // legacy hook mirrors one source store, and invoking this method still writes
  // to that computer's isolated source rather than the mirror singleton.
  updateTranscriptHistory: (roomId, update) => {
    set((state) => {
      const current = state.rooms[roomId] ?? freshRoom();
      return {
        rooms: {
          ...state.rooms,
          [roomId]: {
            ...current,
            transcriptHistory: update(current.transcriptHistory),
          },
        },
      };
    });
  },

  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-projection
  registerActionRef: (roomId, ref, memberId) => {
    set((state) => {
      const current = state.rooms[roomId] ?? freshRoom();
      const next = retainActionTarget(current, ref, memberId);
      return { rooms: { ...state.rooms, [roomId]: next } };
    });
  },
  consumeActionResult: (roomId, ref) => {
    let consumed: ActionResult | undefined;
    set((state) => {
      const current = state.rooms[roomId] ?? freshRoom();
      consumed = current.actionResults[ref];
      if (consumed === undefined) return {};
      const actionResults = { ...current.actionResults };
      delete actionResults[ref];
      const actionTargets = { ...current.actionTargets };
      delete actionTargets[ref];
      return { rooms: { ...state.rooms, [roomId]: { ...current, actionResults, actionTargets } } };
    });
    return consumed;
  },
  // harn:end context-reset-confirmation-is-anchored-and-member-local

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

  setConnected: (connected) => set(connected ? { connected, authRefused: false } : { connected }),
  setAuthRefused: (authRefused) => set({ authRefused }),
  setRoomSummaries: (roomSummaries) => set({ roomSummaries, roomSummariesLoaded: true }),
  // harn:assume hosted-last-good-room-cache-is-bounded-read-only-projection ref=hosted-last-good-room-lifecycle
  hydrateLastGoodRoom: (room, roomSummaries, history) => set((state) => {
    const current = state.rooms[room.id] ?? freshRoom();
    return {
      connected: false,
      authRefused: false,
      activeRoom: room.id,
      roomSummaries,
      roomSummariesLoaded: true,
      rooms: {
        ...state.rooms,
        [room.id]: {
          ...current,
          hydrated: true,
          room,
          messages: { ...history.messages },
          transcriptHistory: {
            ...freshTranscriptHistory(),
            initialized: true,
            // harn:assume cached-transcript-head-stays-stale-until-revalidated ref=cached-history-revalidation-state
            headNeedsRevalidation: true,
            // harn:end cached-transcript-head-stays-stale-until-revalidated
            failed: false,
            // Only rows already represented by the persisted page are cold
            // duplicates. A newer message arriving from current live hydration
            // must remain visible while head revalidation is retrying.
            coldMessageIds: Object.fromEntries(
              Object.keys(history.messages).map((id) => [Number(id), true as const]),
            ),
            messages: { ...history.messages },
            journals: { ...history.journals },
            units: [...history.units],
            latestPage: {
              messages: Object.values(history.messages),
              journals: Object.values(history.journals),
              units: [...history.units],
              before_cursor: history.beforeCursor,
              has_more: history.hasMore,
            },
            beforeCursor: history.beforeCursor,
            hasMore: history.hasMore,
          },
        },
      },
    };
  }),
  // harn:end hosted-last-good-room-cache-is-bounded-read-only-projection
  setWorktreeGroup: (root, group) => set((state) => ({
    worktreeGroups: {
      ...state.worktreeGroups,
      [root]: {
        repositoryId: group.repositoryId ?? state.worktreeGroups[root]?.repositoryId,
        registered: group.registered,
        loaded: true,
      },
    },
  })),
  // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-room-readiness-state
  markRoomsConnecting: (rooms) => set((state) => {
    const roomLive = { ...state.roomLive };
    for (const room of rooms) delete roomLive[room];
    return { roomLive };
  }),
  markRoomLive: (room) => set((state) => state.roomLive[room] === true
    ? {}
    : { roomLive: { ...state.roomLive, [room]: true } }),
  // harn:end worktree-conversation-status-is-live-and-independent
  reset: () => {
    staging.clear();
    set({ connected: false, authRefused: false, activeRoom: '', rooms: {}, roomList: [], roomSummaries: [], roomSummariesLoaded: false, worktreeGroups: {}, roomLive: {} });
  },
  }));
  clientStoreByHistoryAction.set(store.getState().updateTranscriptHistory, store);
  return store;
}

export const useClientStore = createClientStore();

let mirroredStore: ClientStore | undefined;
let stopMirroring: (() => void) | undefined;

/** Point the legacy UI hook at one managed hosted store. State methods retain
 *  their source-store closures, and the subscription republishes every change. */
export function mirrorClientStore(store: ClientStore): void {
  if (mirroredStore === store) return;
  stopMirroring?.();
  mirroredStore = store;
  const publish = (state: ClientState): void => { useClientStore.setState(state, true); };
  publish(store.getState());
  stopMirroring = store.subscribe(publish);
}

// harn:assume finalized-browser-history-is-combined-page-owned ref=captured-history-source-store
/** Resolve the store that owns the current state methods. Managed room UI calls
 * through the mirror singleton, while direct and already-isolated callers are
 * their own source. Callers must capture this result before awaiting. */
export function sourceClientStore(store: ClientStore): ClientStore {
  return clientStoreByHistoryAction.get(store.getState().updateTranscriptHistory) ?? store;
}
// harn:end finalized-browser-history-is-combined-page-owned

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
  stopMirroring?.();
  stopMirroring = undefined;
  mirroredStore = undefined;
  useClientStore.setState(useClientStore.getInitialState(), true);
  useClientStore.getState().reset();
}
