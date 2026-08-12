import type {
  Message,
  TranscriptHistoryIndexedEvent,
  TranscriptHistoryPage,
  TranscriptHistoryUnit,
} from '@codor/protocol';

import {
  fetchTranscriptHistory,
  TranscriptHistoryUnsupportedError,
} from '@runtime/api.js';

import type { ClientState, ClientStore, TranscriptHistoryState } from '../app/store.js';
import { roomSlice, sourceClientStore } from '../app/store.js';

type RequestKind = 'head' | `cursor:${string}`;

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
// range. Remove every overlapping stable identity from the current sequence,
// then splice the response at its first overlap so units loaded outside that
// overlap keep their relative order on either side. A bridge can contain no
// overlap when the established range has fallen behind the server entirely;
// in that case the newest response belongs before the retained range.
const mergeAuthoritativeHeadUnits = (
  current: readonly TranscriptHistoryUnit[],
  incoming: readonly TranscriptHistoryUnit[],
): TranscriptHistoryUnit[] => {
  const authoritative = uniqueUnits(incoming);
  if (authoritative.length === 0) return uniqueUnits(current);
  const incomingKeys = new Set(authoritative.map(transcriptUnitKey));
  const firstOverlap = current.findIndex((unit) => incomingKeys.has(transcriptUnitKey(unit)));
  if (firstOverlap < 0) return uniqueUnits([...authoritative, ...current]);
  return uniqueUnits([
    ...current.slice(0, firstOverlap).filter((unit) => !incomingKeys.has(transcriptUnitKey(unit))),
    ...authoritative,
    ...current.slice(firstOverlap).filter((unit) => !incomingKeys.has(transcriptUnitKey(unit))),
  ]);
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
  const units = mode === 'older'
    ? uniqueUnits([...incoming, ...current.units])
    : mergeAuthoritativeHeadUnits(current.units, incoming);
  const oldestFetched = pagesNewestFirst.at(-1);
  const establishFloor = !current.initialized || current.units.length === 0;
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
      ? { latestPage: pagesNewestFirst[0] }
      : {}),
    ...(mode === 'older' || establishFloor ? {
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

// harn:assume transcript-history-prepends-one-deliberate-page ref=deliberate-history-page-controller
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
// harn:end transcript-history-prepends-one-deliberate-page

const pageOverlaps = (page: TranscriptHistoryPage, keys: ReadonlySet<string>): boolean =>
  page.units.some((unit) => keys.has(transcriptUnitKey(unit)));

// harn:assume missed-terminal-history-refreshes-through-combined-head ref=combined-history-head-refresh
// harn:assume missed-terminal-history-refreshes-through-combined-head ref=combined-history-gap-bridge
function refreshTranscriptHistoryHeadFrom(
  store: ClientStore,
  room: string,
  token: () => string,
): Promise<boolean> {
  if (historyOf(store, room).legacyFallback) return Promise.resolve(true);
  return runRequest(store, room, 'head', async () => {
    update(store, room, (history) => ({ ...history, loadingHead: true, failed: false }));
    const existingKeys = new Set(historyOf(store, room).units.map(transcriptUnitKey));
    const pages: TranscriptHistoryPage[] = [];
    try {
      let page = await fetchTranscriptHistory(room, undefined, { token: token() });
      pages.push(page);
      while (
        existingKeys.size > 0
        && !pageOverlaps(page, existingKeys)
        && page.has_more
        && page.before_cursor !== null
      ) {
        page = await fetchTranscriptHistory(room, page.before_cursor, { token: token() });
        pages.push(page);
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
      // harn:assume combined-history-supports-bounded-legacy-host-fallback ref=history-legacy-fallback-materializer
      if (error instanceof TranscriptHistoryUnsupportedError && !current.initialized) {
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
      // harn:end combined-history-supports-bounded-legacy-host-fallback
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
): Promise<boolean> {
  return refreshTranscriptHistoryHeadFrom(sourceClientStore(store), room, token);
}
// harn:end missed-terminal-history-refreshes-through-combined-head
// harn:end missed-terminal-history-refreshes-through-combined-head

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
  return refreshTranscriptHistoryHeadFrom(store, room, token);
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
