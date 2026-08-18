import type {
  Message,
  TranscriptHistoryIndexedEvent,
  TranscriptHistoryPage,
  TranscriptHistoryUnit,
} from '@codor/protocol';
import {
  HISTORICAL_TRANSCRIPT_CACHE_SIZE,
  newestTranscriptHistoryUnits,
} from '@codor/protocol';

import {
  fetchTranscriptHistory,
  TranscriptHistoryUnsupportedError,
} from '@runtime/api.js';

import type { ClientState, ClientStore, TranscriptHistoryState } from '../app/store.js';
import { roomSlice, sourceClientStore } from '../app/store.js';

type RequestKind = 'head' | `cursor:${string}`;
type HistoryFetch = (input: string, init?: RequestInit) => Promise<Response>;

const requests = new WeakMap<ClientState['updateTranscriptHistory'], Map<string, Promise<boolean>>>();

const requestMap = (store: ClientStore): Map<string, Promise<boolean>> => {
  // A managed UI reads through the mirror singleton, whose state methods still
  // belong to the active source store. Keying by that source-owned method keeps
  // an in-flight same-room request from one computer from being reused after a
  // switch to another computer with different credentials.
  const source = store.getState().updateTranscriptHistory;
  let map = requests.get(source);
  if (map === undefined) {
    map = new Map();
    requests.set(source, map);
  }
  return map;
};

export function transcriptUnitKey(unit: TranscriptHistoryUnit): string {
  if (unit.kind === 'message') return `message:${String(unit.message_id)}`;
  return [
    unit.kind,
    String(unit.root_message_id),
    String(unit.output_message_id),
    unit.event_indices.join(','),
  ].join(':');
}

const mergeJournals = (
  current: TranscriptHistoryState['journals'],
  pages: readonly TranscriptHistoryPage[],
): TranscriptHistoryState['journals'] => {
  const merged = new Map<number, Map<number, TranscriptHistoryIndexedEvent>>();
  for (const journal of Object.values(current)) {
    merged.set(journal.root_message_id, new Map(journal.events.map((event) => [event.index, event])));
  }
  for (const page of pages) {
    for (const journal of page.journals) {
      const events = merged.get(journal.root_message_id) ?? new Map();
      for (const event of journal.events) events.set(event.index, event);
      merged.set(journal.root_message_id, events);
    }
  }
  return Object.fromEntries([...merged].map(([root, events]) => [root, {
    root_message_id: root,
    events: [...events.values()].sort((left, right) => left.index - right.index),
  }]));
};

// harn:assume paged-history-live-message-reconciliation ref=page-message-sequence-merge
const mergeMessages = (
  current: Record<number, Message>,
  pages: readonly TranscriptHistoryPage[],
  liveMessages: Readonly<Record<number, Message>> = {},
): Record<number, Message> => {
  const messages = { ...current };
  for (const page of pages) for (const message of page.messages) {
    const live = liveMessages[message.id];
    const candidate = live !== undefined && live.seq > message.seq ? live : message;
    const previous = messages[message.id];
    if (previous === undefined || candidate.seq > previous.seq) messages[message.id] = candidate;
  }
  return messages;
};
// harn:end paged-history-live-message-reconciliation

const uniqueUnits = (units: readonly TranscriptHistoryUnit[]): TranscriptHistoryUnit[] => {
  const seen = new Set<string>();
  return units.filter((unit) => {
    const key = transcriptUnitKey(unit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// A head response is authoritative wherever it meets the established client
// range. Preserve only the established older prefix before its first stable
// overlap, then use the response's exact chronological order. A bridge can
// exhaust without an overlap when the established range has fallen behind the
// server entirely; in that case the response replaces the stale finalized
// range. Live-only room records remain in the message map and never become
// history units here.
const mergeAuthoritativeHeadUnits = (
  current: readonly TranscriptHistoryUnit[],
  incoming: readonly TranscriptHistoryUnit[],
): TranscriptHistoryUnit[] => {
  const authoritative = uniqueUnits(incoming);
  if (authoritative.length === 0) return [];
  const incomingKeys = new Set(authoritative.map(transcriptUnitKey));
  const firstOverlap = current.findIndex((unit) => incomingKeys.has(transcriptUnitKey(unit)));
  if (firstOverlap < 0) return authoritative;
  return uniqueUnits([...current.slice(0, firstOverlap), ...authoritative]);
};

const projectCacheWindow = (
  pagesNewestFirst: readonly TranscriptHistoryPage[],
): NonNullable<TranscriptHistoryState['cacheWindow']> | undefined => {
  if (pagesNewestFirst[0] === undefined) return undefined;
  const chronologicalPages = [...pagesNewestFirst].reverse();
  const units = newestTranscriptHistoryUnits(
    uniqueUnits(chronologicalPages.flatMap((page) => page.units)),
    HISTORICAL_TRANSCRIPT_CACHE_SIZE,
  );
  const messageIds = new Set<number>();
  const eventIndices = new Map<number, Set<number>>();
  for (const unit of units) {
    if (unit.kind === 'message') {
      messageIds.add(unit.message_id);
      continue;
    }
    messageIds.add(unit.root_message_id);
    messageIds.add(unit.output_message_id);
    const selected = eventIndices.get(unit.root_message_id) ?? new Set<number>();
    unit.event_indices.forEach((index) => selected.add(index));
    eventIndices.set(unit.root_message_id, selected);
  }
  const allMessages = mergeMessages({}, pagesNewestFirst);
  const allJournals = mergeJournals({}, pagesNewestFirst);
  const oldest = pagesNewestFirst.at(-1)!;
  return {
    messages: Object.fromEntries([...messageIds].flatMap((id) => {
      const message = allMessages[id];
      return message === undefined ? [] : [[id, message]];
    })),
    journals: Object.fromEntries([...eventIndices].flatMap(([root, selected]) => {
      const journal = allJournals[root];
      if (journal === undefined) return [];
      return [[root, {
        root_message_id: root,
        events: journal.events.filter((event) => selected.has(event.index)),
      }]];
    })),
    units,
    beforeCursor: oldest.before_cursor,
    hasMore: oldest.has_more,
  };
};

// harn:assume finalized-browser-history-is-combined-page-owned ref=combined-history-materializer
// harn:assume live-before-history-materialization-reconciles ref=history-materializer-uses-live-room-records
export function indexedEventsForUnit(
  history: TranscriptHistoryState,
  unit: Exclude<TranscriptHistoryUnit, { kind: 'message' }>,
): TranscriptHistoryIndexedEvent[] {
  const selected = new Set(unit.event_indices);
  return (history.journals[unit.root_message_id]?.events ?? [])
    .filter((event) => selected.has(event.index));
}

/** Merge one older page or a newest-to-oldest head bridge without allowing a
 * page boundary to regroup the server's authoritative visible units. */
export function mergeTranscriptPages(
  current: TranscriptHistoryState,
  pagesNewestFirst: readonly TranscriptHistoryPage[],
  mode: 'older' | 'head',
  liveMessages: Readonly<Record<number, Message>> = {},
): TranscriptHistoryState {
  const chronologicalPages = [...pagesNewestFirst].reverse();
  const incoming = chronologicalPages.flatMap((page) => page.units);
  const incomingKeys = new Set(incoming.map(transcriptUnitKey));
  const firstOverlap = mode === 'head'
    ? current.units.findIndex((unit) => incomingKeys.has(transcriptUnitKey(unit)))
    : -1;
  const preservedOlderPrefix = firstOverlap > 0;
  const units = mode === 'older'
    ? uniqueUnits([...incoming, ...current.units])
    : mergeAuthoritativeHeadUnits(current.units, incoming);
  const oldestFetched = pagesNewestFirst.at(-1);
  return {
    ...current,
    initialized: true,
    ...(mode === 'head' && { headNeedsRevalidation: false }),
    legacyFallback: false,
    failed: false,
    loadingHead: false,
    loadingCursor: undefined,
    messages: mergeMessages(current.messages, pagesNewestFirst, liveMessages),
    journals: mergeJournals(current.journals, pagesNewestFirst),
    units,
    ...(mode === 'head' && pagesNewestFirst[0] !== undefined
      ? { cacheWindow: projectCacheWindow(pagesNewestFirst) }
      : {}),
    ...(mode === 'older' || !preservedOlderPrefix ? {
      beforeCursor: oldestFetched?.before_cursor ?? null,
      hasMore: oldestFetched?.has_more ?? false,
    } : {}),
  };
}
// harn:end live-before-history-materialization-reconciles
// harn:end finalized-browser-history-is-combined-page-owned

const historyOf = (store: ClientStore, room: string): TranscriptHistoryState =>
  roomSlice(store.getState(), room).transcriptHistory;

const update = (
  store: ClientStore,
  room: string,
  mutate: (current: TranscriptHistoryState) => TranscriptHistoryState,
): void => store.getState().updateTranscriptHistory(room, mutate);

const runRequest = (
  store: ClientStore,
  room: string,
  kind: RequestKind,
  task: () => Promise<boolean>,
): Promise<boolean> => {
  const key = `${room}\0${kind}`;
  const map = requestMap(store);
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const promise = task().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
};

// harn:assume transcript-history-prepends-one-text-slot-page ref=deliberate-text-slot-page-controller
async function loadOlderTranscriptHistoryFrom(
  store: ClientStore,
  room: string,
  token: () => string,
): Promise<boolean> {
  const cursor = historyOf(store, room).beforeCursor;
  if (cursor === undefined || cursor === null) return false;
  return runRequest(store, room, `cursor:${cursor}`, async () => {
    if (historyOf(store, room).loadingCursor !== undefined) return false;
    update(store, room, (history) => ({ ...history, loadingCursor: cursor, failed: false }));
    try {
      const page = await fetchTranscriptHistory(room, cursor, { token: token() });
      update(store, room, (history) => mergeTranscriptPages(
        history,
        [page],
        'older',
        roomSlice(store.getState(), room).messages,
      ));
      return true;
    } catch {
      update(store, room, (history) => ({
        ...history,
        loadingCursor: history.loadingCursor === cursor ? undefined : history.loadingCursor,
        failed: true,
      }));
      return false;
    }
  });
}

export function loadOlderTranscriptHistory(
  store: ClientStore,
  room: string,
  token: () => string,
): Promise<boolean> {
  return loadOlderTranscriptHistoryFrom(sourceClientStore(store), room, token);
}
// harn:end transcript-history-prepends-one-text-slot-page

// harn:assume combined-head-reconciliation-is-two-page-bounded ref=bounded-combined-history-head-refresh
// harn:assume bounded-combined-head-adopts-authoritative-window ref=bounded-authoritative-head-merge
function refreshTranscriptHistoryHeadFrom(
  store: ClientStore,
  room: string,
  token: () => string,
  request?: HistoryFetch,
  includePredecessor = true,
): Promise<boolean> {
  if (historyOf(store, room).legacyFallback) return Promise.resolve(true);
  return runRequest(store, room, 'head', async () => {
    update(store, room, (history) => ({ ...history, loadingHead: true, failed: false }));
    const pages: TranscriptHistoryPage[] = [];
    try {
      const head = await fetchTranscriptHistory(room, undefined, { token: token(), fetch: request });
      pages.push(head);
      if (includePredecessor && head.has_more && head.before_cursor !== null) {
        pages.push(await fetchTranscriptHistory(room, head.before_cursor, {
          token: token(), fetch: request,
        }));
      }
      update(store, room, (history) => mergeTranscriptPages(
        history,
        pages,
        'head',
        roomSlice(store.getState(), room).messages,
      ));
      return true;
    } catch (error) {
      const current = historyOf(store, room);
      // harn:assume combined-history-capability-gates-socket-fallback ref=capability-gated-legacy-fallback
      if (
        error instanceof TranscriptHistoryUnsupportedError
        && !current.initialized
        && current.legacySocketHydration
      ) {
        update(store, room, (history) => ({
          ...history,
          initialized: true,
          headNeedsRevalidation: false,
          legacyFallback: true,
          loadingHead: false,
          loadingCursor: undefined,
          failed: false,
          coldMessageIds: undefined,
          beforeCursor: null,
          hasMore: false,
        }));
        return true;
      }
      // harn:end combined-history-capability-gates-socket-fallback
      // harn:assume transcript-history-failures-are-bounded-and-actionable ref=history-failure-state
      update(store, room, (history) => ({ ...history, loadingHead: false, failed: true }));
      // harn:end transcript-history-failures-are-bounded-and-actionable
      return false;
    }
  });
}

export function refreshTranscriptHistoryHead(
  store: ClientStore,
  room: string,
  token: () => string,
  request?: HistoryFetch,
  includePredecessor?: boolean,
): Promise<boolean> {
  const source = sourceClientStore(store);
  const history = historyOf(source, room);
  return refreshTranscriptHistoryHeadFrom(
    source,
    room,
    token,
    request,
    includePredecessor ?? (history.initialized || history.headNeedsRevalidation),
  );
}
// harn:end bounded-combined-head-adopts-authoritative-window
// harn:end combined-head-reconciliation-is-two-page-bounded

function ensureTranscriptHistoryFrom(
  store: ClientStore,
  room: string,
  token: () => string,
): Promise<boolean> {
  const history = historyOf(store, room);
  if (history.initialized && !history.headNeedsRevalidation) return Promise.resolve(true);
  if (history.coldMessageIds === undefined) {
    const coldMessageIds = Object.fromEntries(
      Object.keys(roomSlice(store.getState(), room).messages).map((id) => [Number(id), true as const]),
    );
    update(store, room, (current) => current.coldMessageIds === undefined
      ? { ...current, coldMessageIds }
      : current);
  }
  return refreshTranscriptHistoryHeadFrom(
    store,
    room,
    token,
    undefined,
    history.headNeedsRevalidation,
  );
}

export function ensureTranscriptHistory(
  store: ClientStore,
  room: string,
  token: () => string,
): Promise<boolean> {
  return ensureTranscriptHistoryFrom(sourceClientStore(store), room, token);
}

export function targetMaterialized(history: TranscriptHistoryState, id: number): boolean {
  for (const unit of history.units) {
    if (unit.kind === 'message' && unit.message_id === id) return true;
    if (unit.kind !== 'message' && unit.output_message_id === id) return true;
  }
  const target = history.messages[id];
  if (target?.kind !== 'run' || target.run_parent_id !== undefined) return false;
  return history.units.some((unit) => unit.kind !== 'message' && unit.root_message_id === id);
}

export function finalizedTranscriptRoots(store: ClientStore, room: string): Set<number> {
  const source = sourceClientStore(store);
  const slice = roomSlice(source.getState(), room);
  const roots = new Set(historyOf(source, room).units.flatMap(
    (unit) => unit.kind === 'message' ? [] : [unit.root_message_id],
  ));
  for (const message of Object.values(slice.messages)) {
    if (message.kind !== 'run') continue;
    const rootId = message.run_parent_id ?? message.id;
    const root = slice.messages[rootId]
      ?? slice.support?.active_runs.find((candidate) => candidate.id === rootId);
    if (root?.run?.status !== undefined && root.run.status !== 'running') roots.add(rootId);
  }
  return roots;
}

// harn:assume transcript-targets-walk-combined-pages ref=combined-history-target-reveal
export async function revealTranscriptTarget(
  store: ClientStore,
  room: string,
  id: number,
  token: () => string,
): Promise<boolean> {
  const source = sourceClientStore(store);
  if (!await ensureTranscriptHistoryFrom(source, room, token)) return false;
  while (!targetMaterialized(historyOf(source, room), id)) {
    const history = historyOf(source, room);
    if (!history.hasMore || history.beforeCursor === null || history.beforeCursor === undefined) return false;
    if (!await loadOlderTranscriptHistoryFrom(source, room, token)) return false;
  }
  return true;
}
// harn:end transcript-targets-walk-combined-pages
