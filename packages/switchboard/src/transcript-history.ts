import { performance } from 'node:perf_hooks';

import {
  HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  newestTranscriptHistoryUnits,
  parseRunItemPayload,
  transcriptHistoryTextSlotCount,
  transcriptHistoryTextSlotIndices,
  TranscriptHistoryPageSchema,
  type Message,
  type TranscriptHistoryPage,
  type TranscriptHistoryUnit,
  type WireEvent,
} from '@codor/protocol';

import {
  type IndexedTranscriptEntry,
  type JournalEventSpan,
  TranscriptHistoryIndex,
} from './transcript-history-index.js';

const MESSAGE_CHUNK_SIZE = 64;

export interface TranscriptHistorySource {
  listMessages(room: string, opts: { before: number; limit: number }): Message[];
  getMessage(room: string, id: number): Message | undefined;
  readRunJournal(room: string, rootMessageId: number): WireEvent[];
  transcriptHistoryIndex?: TranscriptHistoryIndex;
  readRunJournalWithSpans?: (
    room: string,
    rootMessageId: number,
  ) => { events: WireEvent[]; spans: JournalEventSpan[] };
  readRunJournalSpans?: (
    room: string,
    rootMessageId: number,
    spans: readonly JournalEventSpan[],
  ) => WireEvent[];
}

export interface TranscriptHistoryMetrics {
  duration_ms: number;
  response_bytes: number;
  selected_units: number;
  selected_text_slots: number;
  message_reads: number;
  message_records_read: number;
  journal_reads: number;
  journal_events_scanned: number;
  index_rows_read?: number;
  index_backfilled?: boolean;
}

export interface TranscriptHistoryBuildResult {
  page: TranscriptHistoryPage;
  metrics: TranscriptHistoryMetrics;
}

interface CursorPayload {
  v: 1;
  room: string;
  ceiling_message_id: number;
  before: { message_id: number; unit_ordinal: number };
}

interface Entry {
  sourceMessageId: number;
  unitOrdinal: number;
  positionMessageId: number;
  journalOrder: number;
  timestamp: number;
  unit: TranscriptHistoryUnit;
}

type JournalEntry = Entry & {
  unit: Exclude<TranscriptHistoryUnit, { kind: 'message' }>;
};

const terminalStatus = (message: Message): boolean =>
  message.run?.status === 'completed'
  || message.run?.status === 'failed'
  || message.run?.status === 'interrupted';

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, room: string): CursorPayload {
  if (cursor.length > 4096) throw new Error('invalid transcript history cursor');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      value.v !== 1
      || typeof value.room !== 'string'
      || !Number.isSafeInteger(value.ceiling_message_id)
      || (value.ceiling_message_id ?? -1) < 0
      || typeof value.before !== 'object'
      || value.before === null
      || !Number.isSafeInteger(value.before.message_id)
      || value.before.message_id < 1
      || !Number.isSafeInteger(value.before.unit_ordinal)
      || value.before.unit_ordinal < 0
    ) throw new Error('invalid shape');
    if (value.room !== room) throw new Error('cursor belongs to a different room');
    return value as CursorPayload;
  } catch (error) {
    if (error instanceof Error && error.message === 'cursor belongs to a different room') throw error;
    throw new Error('invalid transcript history cursor');
  }
}

function eventTarget(event: WireEvent, rootMessageId: number): number {
  return event.type === 'run.item' || event.type === 'timeline' || event.type === 'run.completed'
    ? (event.output_message_id ?? rootMessageId)
    : rootMessageId;
}

function messageTime(message: Message): number {
  if (message.kind === 'run' && terminalStatus(message)) {
    return Date.parse(message.run?.ended_ts ?? message.ts);
  }
  return Date.parse(message.ts);
}

type ProseItemType = 'text_delta' | 'text_block';

function parseProseItem(event: Extract<WireEvent, { type: 'run.item' }>):
  { kind: ProseItemType; text: string } | undefined {
  if (event.item_type !== 'text_delta' && event.item_type !== 'text_block') return undefined;
  const parsed = parseRunItemPayload(event.item_type, event.payload);
  return parsed.success ? { kind: event.item_type, text: parsed.data.text } : undefined;
}

// harn:assume explicit-prose-boundaries-survive-transcript-lifecycle ref=transcript-prose-boundary-unitizer
function unitizeRun(
  root: Message,
  events: readonly WireEvent[],
  getMessage: (id: number) => Message | undefined,
): Entry[] {
  const entries: Entry[] = [];
  const calls = new Map<number, Map<string, JournalEntry>>();
  const pendingCompactions = new Map<number, JournalEntry[]>();
  const proseTargets = new Set<number>();
  const streamedText = new Map<number, string>();
  const visibleText = new Map<number, string>();
  const lastProseType = new Map<number, ProseItemType>();
  const prose = new Map<number, JournalEntry>();
  let lastTimestamp = messageTime(root);
  let completion: {
    index: number;
    event: Extract<WireEvent, { type: 'run.completed' }>;
    target: number;
  } | undefined;

  const add = (
    kind: 'prose' | 'tool' | 'timeline',
    index: number,
    target: number,
    timestamp: number,
  ): JournalEntry => {
    const entry: JournalEntry = {
      sourceMessageId: root.id,
      unitOrdinal: entries.length,
      positionMessageId: target,
      journalOrder: index,
      timestamp,
      unit: {
        kind,
        root_message_id: root.id,
        output_message_id: target,
        event_indices: [index],
      },
    };
    entries.push(entry);
    return entry;
  };

  events.forEach((event, index) => {
    if (event.type === 'run.completed') {
      completion = { index, event, target: eventTarget(event, root.id) };
      return;
    }

    if (event.type === 'run.item') {
      const target = eventTarget(event, root.id);
      const timestamp = event.ts === undefined ? lastTimestamp : Date.parse(event.ts);
      if (event.ts !== undefined) lastTimestamp = timestamp;
      const parsedProse = parseProseItem(event);
      if (parsedProse !== undefined || event.item_type === 'text_delta' || event.item_type === 'text_block') {
        if (parsedProse === undefined) {
          prose.delete(target);
          add('tool', index, target, timestamp);
          return;
        }
        if (parsedProse.kind === 'text_block') {
          prose.delete(target);
          add('prose', index, target, timestamp);
        } else {
          const previous = prose.get(target);
          if (previous !== undefined) {
            previous.unit.event_indices.push(index);
          } else {
            prose.set(target, add('prose', index, target, timestamp));
          }
        }
        proseTargets.add(target);
        streamedText.set(target, `${streamedText.get(target) ?? ''}${parsedProse.text}`);
        const previousVisible = visibleText.get(target) ?? '';
        const boundary = parsedProse.kind === 'text_block'
          || lastProseType.get(target) === 'text_block';
        visibleText.set(
          target,
          `${previousVisible}${boundary && previousVisible.length > 0 ? '\n\n' : ''}${parsedProse.text}`,
        );
        lastProseType.set(target, parsedProse.kind);
        return;
      }
      prose.delete(target);
      if (event.item_type === 'reasoning_summary') {
        return;
      }
      if (event.item_type === 'tool_call') {
        const parsed = parseRunItemPayload('tool_call', event.payload);
        const entry = add('tool', index, target, timestamp);
        if (parsed.success) {
          const targetCalls = calls.get(target) ?? new Map<string, JournalEntry>();
          targetCalls.set(parsed.data.call_id, entry);
          calls.set(target, targetCalls);
        }
        return;
      }
      if (event.item_type === 'tool_result') {
        const parsed = parseRunItemPayload('tool_result', event.payload);
        if (parsed.success) {
          const call = calls.get(target)?.get(parsed.data.call_id);
          if (call !== undefined) {
            if (call.unit.event_indices.length === 1) call.unit.event_indices.push(index);
            else call.unit.event_indices[1] = index;
            return;
          }
        }
        add('tool', index, target, timestamp);
        return;
      }
      add('tool', index, target, timestamp);
      return;
    }

    if (event.type !== 'timeline' || event.item.type !== 'compaction') return;
    const target = eventTarget(event, root.id);
    prose.delete(target);
    const targetPending = pendingCompactions.get(target) ?? [];
    if (event.item.status === 'completed') {
      const pending = targetPending.shift();
      if (pending !== undefined) {
        pending.unit.event_indices.push(index);
        return;
      }
    }
    const entry = add('timeline', index, target, lastTimestamp);
    if (event.item.status === 'loading') {
      targetPending.push(entry);
      pendingCompactions.set(target, targetPending);
    }
  });

  const modern = root.run?.output_mode === 'messages';
  const hasProse = proseTargets.size > 0;
  if (!modern && hasProse) {
    let toolBatchTimestamp: number | undefined;
    for (const entry of entries) {
      if (entry.unit.kind === 'tool') {
        toolBatchTimestamp ??= entry.timestamp;
        entry.timestamp = toolBatchTimestamp;
      } else {
        toolBatchTimestamp = undefined;
      }
    }
  }

  const settledTarget = root.run?.result_message_id
    ?? completion?.target
    ?? entries.at(-1)?.positionMessageId
    ?? root.id;
  const targetHasProse = proseTargets.has(settledTarget);
  const finalText = modern
    ? (getMessage(settledTarget)?.body ?? '')
    : (root.run?.final_text ?? root.body);
  const targetStream = streamedText.get(settledTarget) ?? '';
  const targetVisible = visibleText.get(settledTarget) ?? '';
  const modernResidual = modern && (
    (finalText.startsWith(targetVisible) && finalText.length > targetVisible.length)
    || (targetVisible !== targetStream
      && finalText.startsWith(targetStream)
      && finalText.length > targetStream.length)
  );
  const hasVisibleText = finalText.length > 0 && (
    !targetHasProse
    || modernResidual
  );
  const failed = root.run?.status === 'failed' || root.run?.status === 'interrupted';

  if (hasVisibleText || failed) {
    const completionIndex = completion?.index;
    entries.push({
      sourceMessageId: root.id,
      unitOrdinal: entries.length,
      positionMessageId: settledTarget,
      journalOrder: completionIndex ?? Number.MAX_SAFE_INTEGER,
      timestamp: !modern && hasProse && entries.length > 0
        ? entries.at(-1)!.timestamp
        : messageTime(root),
      unit: {
        kind: 'settled_tail',
        root_message_id: root.id,
        output_message_id: settledTarget,
        event_indices: completionIndex === undefined ? [] : [completionIndex],
      },
    });
  }

  if (!modern && !hasProse) {
    const ended = messageTime(root);
    for (const entry of entries) entry.timestamp = ended;
  }
  return entries;
}
// harn:end explicit-prose-boundaries-survive-transcript-lifecycle

function compareEntries(left: Entry, right: Entry, continuationFloor: number | undefined): number {
  const leftStrict = continuationFloor !== undefined && left.positionMessageId >= continuationFloor;
  const rightStrict = continuationFloor !== undefined && right.positionMessageId >= continuationFloor;
  if (leftStrict !== rightStrict) return leftStrict ? 1 : -1;
  if (leftStrict && rightStrict) {
    return left.positionMessageId - right.positionMessageId
      || left.journalOrder - right.journalOrder
      || left.sourceMessageId - right.sourceMessageId
      || left.unitOrdinal - right.unitOrdinal;
  }
  return left.timestamp - right.timestamp
    || left.sourceMessageId - right.sourceMessageId
    || left.unitOrdinal - right.unitOrdinal;
}

function continuationFloor(messages: Iterable<Message>): number | undefined {
  const floors = [...messages].flatMap((message) => [
    ...(message.run?.output_mode === 'messages' ? [message.id] : []),
    ...(message.run_parent_id !== undefined ? [message.run_parent_id] : []),
  ]);
  return floors.length === 0 ? undefined : Math.min(...floors);
}

function eventSpanMap(spans: readonly JournalEventSpan[]): Map<number, JournalEventSpan> {
  return new Map(spans.map((span) => [span.index, span]));
}

function indexedEntries(
  entries: readonly Entry[],
  spansByRoot: ReadonlyMap<number, readonly JournalEventSpan[]>,
): IndexedTranscriptEntry[] {
  const charged = new Set(transcriptHistoryTextSlotIndices(entries.map((entry) => entry.unit)));
  return entries.map((entry, index) => {
    const spans = eventSpanMap(spansByRoot.get(entry.sourceMessageId) ?? []);
    const eventSpans = entry.unit.kind === 'message'
      ? []
      : entry.unit.event_indices.map((eventIndex) => {
          const span = spans.get(eventIndex);
          if (span === undefined) {
            throw new Error(`journal event ${String(eventIndex)} has no byte span`);
          }
          return span;
        });
    return {
      ...entry,
      charged: charged.has(index),
      maxMessageId: Math.max(entry.sourceMessageId, entry.positionMessageId),
      eventSpans,
    };
  });
}

function ordinaryEntry(message: Message): Entry | undefined {
  if (
    message.run_parent_id !== undefined
    || (message.kind === 'run' && message.run !== undefined)
    || message.kind === 'ask'
    || message.kind === 'approval'
  ) return undefined;
  return {
    sourceMessageId: message.id,
    unitOrdinal: 0,
    positionMessageId: message.id,
    journalOrder: 0,
    timestamp: messageTime(message),
    unit: { kind: 'message', message_id: message.id },
  };
}

function reconcileIndexedRoom(opts: {
  room: string;
  source: TranscriptHistorySource;
  index: TranscriptHistoryIndex;
}): { messageRecordsRead: number; journalReads: number; journalEventsScanned: number } {
  const dirty = opts.index.dirtyMessageIds(opts.room);
  if (dirty.length === 0) {
    return { messageRecordsRead: 0, journalReads: 0, journalEventsScanned: 0 };
  }
  if (opts.source.readRunJournalWithSpans === undefined) {
    throw new Error('indexed transcript history source cannot derive journal spans');
  }
  let messageRecordsRead = 0;
  let journalReads = 0;
  let journalEventsScanned = 0;
  const changed = new Map<number, Message>();
  const roots = new Set<number>();
  let nextFloor = opts.index.roomState(opts.room).continuationFloor;
  for (const id of dirty) {
    const message = opts.source.getMessage(opts.room, id);
    if (message === undefined) continue;
    changed.set(id, message);
    messageRecordsRead += 1;
    if (message.run_parent_id !== undefined) roots.add(message.run_parent_id);
    if (message.run !== undefined && message.run_parent_id === undefined) roots.add(message.id);
    const candidate = message.run_parent_id
      ?? (message.run?.output_mode === 'messages' ? message.id : undefined);
    if (candidate !== undefined) nextFloor = Math.min(nextFloor ?? candidate, candidate);
  }
  const replacement: IndexedTranscriptEntry[] = [];
  for (const message of changed.values()) {
    const entry = ordinaryEntry(message);
    if (entry !== undefined) replacement.push(...indexedEntries([entry], new Map()));
  }
  for (const rootId of roots) {
    const root = opts.source.getMessage(opts.room, rootId);
    if (root === undefined || !terminalStatus(root)) continue;
    if (!changed.has(rootId)) messageRecordsRead += 1;
    const journal = opts.source.readRunJournalWithSpans(opts.room, rootId);
    journalReads += 1;
    journalEventsScanned += journal.events.length;
    const loaded = new Set<number>();
    const family = unitizeRun(root, journal.events, (id) => {
      const known = changed.get(id);
      if (known !== undefined) return known;
      const message = opts.source.getMessage(opts.room, id);
      if (message !== undefined && !loaded.has(id)) {
        loaded.add(id);
        messageRecordsRead += 1;
      }
      return message;
    });
    replacement.push(...indexedEntries(family, new Map([[rootId, journal.spans]])));
  }
  opts.index.replaceDirty({
    room: opts.room,
    continuationFloor: nextFloor,
    ordinaryMessageIds: dirty,
    rootMessageIds: [...roots],
    entries: replacement,
    dirtyMessageIds: dirty,
  });
  return { messageRecordsRead, journalReads, journalEventsScanned };
}

// harn:assume transcript-history-index-is-write-maintained-and-rebuildable ref=transcript-history-index-lifecycle
/** Journal-aware eager maintenance after a terminal family and all permanent
 * output metadata have committed. Any exception leaves the trigger-created
 * dirty rows intact for the bounded request-time crash recovery path. */
export function maintainIndexedTranscriptHistoryMessage(opts: {
  room: string;
  message: Message;
  source: TranscriptHistorySource;
}): void {
  const index = opts.source.transcriptHistoryIndex;
  if (index?.roomState(opts.room).complete !== true) return;
  const root = opts.message.run_parent_id === undefined
    ? (opts.message.run === undefined ? undefined : opts.message)
    : opts.source.getMessage(opts.room, opts.message.run_parent_id);
  if (root === undefined || !terminalStatus(root)) return;
  const familyDirty = index.dirtyMessageIds(opts.room).filter((id) => {
    if (id === root.id) return true;
    return opts.source.getMessage(opts.room, id)?.run_parent_id === root.id;
  });
  if (familyDirty.length === 0) return;
  if (opts.source.readRunJournalWithSpans === undefined) {
    throw new Error('indexed transcript history source cannot derive journal spans');
  }
  const journal = opts.source.readRunJournalWithSpans(opts.room, root.id);
  const family = unitizeRun(
    root,
    journal.events,
    (id) => opts.source.getMessage(opts.room, id),
  );
  const state = index.roomState(opts.room);
  const floor = root.run?.output_mode === 'messages'
    ? Math.min(state.continuationFloor ?? root.id, root.id)
    : state.continuationFloor;
  index.replaceDirty({
    room: opts.room,
    continuationFloor: floor,
    ordinaryMessageIds: [],
    rootMessageIds: [root.id],
    entries: indexedEntries(family, new Map([[root.id, journal.spans]])),
    dirtyMessageIds: familyDirty,
  });
}
// harn:end transcript-history-index-is-write-maintained-and-rebuildable

// harn:assume indexed-transcript-pages-read-only-current-selected-evidence ref=indexed-transcript-page-query
function buildIndexedTranscriptHistoryPage(opts: {
  room: string;
  cursor?: CursorPayload;
  source: TranscriptHistorySource;
  index: TranscriptHistoryIndex;
  started: number;
}): TranscriptHistoryBuildResult {
  if (opts.source.readRunJournalSpans === undefined) {
    throw new Error('indexed transcript history source cannot read journal spans');
  }
  const repair = reconcileIndexedRoom(opts);
  let messageReads = 0;
  let messageRecordsRead = repair.messageRecordsRead;
  let ceiling = opts.cursor?.ceiling_message_id;
  if (ceiling === undefined) {
    const newest = opts.source.listMessages(opts.room, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 1,
    });
    messageReads += 1;
    messageRecordsRead += newest.length;
    ceiling = newest.at(-1)?.id ?? 0;
  }
  const selection = opts.index.selectPage({
    room: opts.room,
    ceilingMessageId: ceiling,
    before: opts.cursor === undefined ? undefined : {
      messageId: opts.cursor.before.message_id,
      unitOrdinal: opts.cursor.before.unit_ordinal,
    },
    textSlotLimit: HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  });
  const selectedMessageIds = new Set<number>();
  const spansByRoot = new Map<number, Map<number, JournalEventSpan>>();
  for (const entry of selection.entries) {
    if (entry.unit.kind === 'message') {
      selectedMessageIds.add(entry.unit.message_id);
      continue;
    }
    selectedMessageIds.add(entry.unit.root_message_id);
    selectedMessageIds.add(entry.unit.output_message_id);
    const spans = spansByRoot.get(entry.unit.root_message_id) ?? new Map();
    for (const span of entry.eventSpans) spans.set(span.index, span);
    spansByRoot.set(entry.unit.root_message_id, spans);
  }
  const messages = [...selectedMessageIds]
    .map((id) => opts.source.getMessage(opts.room, id))
    .filter((message): message is Message => message !== undefined)
    .sort((left, right) => left.id - right.id);
  messageRecordsRead += messages.length;
  const journals = [...spansByRoot].map(([rootMessageId, byIndex]) => {
    const spans = [...byIndex.values()].sort((left, right) => left.index - right.index);
    const events = opts.source.readRunJournalSpans!(opts.room, rootMessageId, spans);
    return {
      root_message_id: rootMessageId,
      events: spans.map((span, index) => ({ index: span.index, event: events[index]! })),
    };
  }).filter((journal) => journal.events.length > 0);
  const oldest = selection.entries[0];
  const page = TranscriptHistoryPageSchema.parse({
    messages,
    journals,
    units: selection.entries.map((entry) => entry.unit),
    before_cursor: selection.hasMore && oldest !== undefined
      ? encodeCursor({
          v: 1,
          room: opts.room,
          ceiling_message_id: ceiling,
          before: {
            message_id: oldest.sourceMessageId,
            unit_ordinal: oldest.unitOrdinal,
          },
        })
      : null,
    has_more: selection.hasMore,
  });
  return {
    page,
    metrics: {
      duration_ms: performance.now() - opts.started,
      response_bytes: Buffer.byteLength(JSON.stringify(page)),
      selected_units: page.units.length,
      selected_text_slots: transcriptHistoryTextSlotCount(page.units),
      message_reads: messageReads,
      message_records_read: messageRecordsRead,
      journal_reads: repair.journalReads + journals.length,
      journal_events_scanned: repair.journalEventsScanned
        + journals.reduce((count, journal) => count + journal.events.length, 0),
      index_rows_read: selection.rowsRead,
      index_backfilled: false,
    },
  };
}
// harn:end indexed-transcript-pages-read-only-current-selected-evidence

// harn:assume historical-transcript-pages-budget-text-slots ref=transcript-history-text-slot-page-builder
export function buildTranscriptHistoryPage(opts: {
  room: string;
  cursor?: string;
  source: TranscriptHistorySource;
}): TranscriptHistoryBuildResult {
  const started = performance.now();
  const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor, opts.room);
  const index = opts.source.transcriptHistoryIndex;
  if (index?.roomState(opts.room).complete === true) {
    return buildIndexedTranscriptHistoryPage({
      room: opts.room,
      cursor,
      source: opts.source,
      index,
      started,
    });
  }
  let ceiling = index === undefined ? cursor?.ceiling_message_id : undefined;
  let before = ceiling === undefined ? Number.MAX_SAFE_INTEGER : ceiling + 1;
  let exhausted = false;
  let messageReads = 0;
  let messageRecordsRead = 0;
  let journalReads = 0;
  let journalEventsScanned = 0;
  const messages = new Map<number, Message>();
  const journals = new Map<number, WireEvent[]>();
  const journalSpans = new Map<number, JournalEventSpan[]>();
  let entries: Entry[] = [];
  let boundaryIndex = -1;
  let establishedFloor: number | undefined;

  const loadMessage = (id: number): Message | undefined => {
    const known = messages.get(id);
    if (known !== undefined) return known;
    const loaded = opts.source.getMessage(opts.room, id);
    if (loaded !== undefined && (ceiling === undefined || loaded.id <= ceiling)) {
      messages.set(loaded.id, loaded);
      messageRecordsRead += 1;
    }
    return loaded;
  };

  const rebuildEntries = (): void => {
    const roots = new Map<number, Message>();
    for (const message of messages.values()) {
      if (message.run_parent_id !== undefined) {
        const root = loadMessage(message.run_parent_id);
        if (root !== undefined) roots.set(root.id, root);
      } else if (message.kind === 'run' && message.run !== undefined) {
        roots.set(message.id, message);
      }
    }

    const next: Entry[] = [];
    for (const message of messages.values()) {
      if (message.run_parent_id !== undefined || (message.kind === 'run' && message.run !== undefined)) continue;
      // harn:assume actionable-interactions-do-not-spend-history-text-slots ref=interaction-text-slot-unitizer
      // Pending/resolved interaction state is recipient-scoped RoomSupport, not
      // immutable transcript history. Counting the durable card row here would
      // either resurrect an answered card or spend a visible-unit slot on state
      // the page cannot truthfully project.
      if (message.kind === 'ask' || message.kind === 'approval') continue;
      // harn:end actionable-interactions-do-not-spend-history-text-slots
      next.push({
        sourceMessageId: message.id,
        unitOrdinal: 0,
        positionMessageId: message.id,
        journalOrder: 0,
        timestamp: messageTime(message),
        unit: { kind: 'message', message_id: message.id },
      });
    }
    for (const root of roots.values()) {
      if (!terminalStatus(root)) continue;
      let events = journals.get(root.id);
      if (events === undefined) {
        if (index !== undefined && opts.source.readRunJournalWithSpans !== undefined) {
          const journal = opts.source.readRunJournalWithSpans(opts.room, root.id);
          events = journal.events;
          journalSpans.set(root.id, journal.spans);
        } else {
          events = opts.source.readRunJournal(opts.room, root.id);
        }
        journals.set(root.id, events);
        journalReads += 1;
        journalEventsScanned += events.length;
      }
      const family = unitizeRun(root, events, loadMessage);
      for (const entry of family) {
        loadMessage(entry.positionMessageId);
        next.push(entry);
      }
    }
    establishedFloor = continuationFloor(messages.values());
    entries = next.sort((left, right) => compareEntries(left, right, establishedFloor));
    boundaryIndex = cursor === undefined
      ? entries.length
      : entries.findIndex((entry) =>
          entry.sourceMessageId === cursor.before.message_id
          && entry.unitOrdinal === cursor.before.unit_ordinal);
  };

  while (!exhausted) {
    const chunk = opts.source.listMessages(opts.room, { before, limit: MESSAGE_CHUNK_SIZE });
    messageReads += 1;
    messageRecordsRead += chunk.length;
    if (ceiling === undefined) ceiling = chunk.at(-1)?.id ?? 0;
    for (const message of chunk) {
      if (message.id <= ceiling) messages.set(message.id, message);
    }
    exhausted = chunk.length < MESSAGE_CHUNK_SIZE;
    if (chunk.length > 0) before = chunk[0]!.id;
    if (chunk.length === 0) exhausted = true;
  }

  // harn:assume transcript-history-cursors-cover-complete-established-order ref=complete-transcript-order-before-page-boundaries
  // Message ids are the storage scan order, not the legacy transcript order.
  // An old id may carry a newer timestamp and therefore sort after entries that
  // were discovered in the first chunk. Selecting a boundary before the ceiling
  // is fully discovered makes that late entry unreachable on every later page.
  // Establish the complete immutable-ceiling order once, then page that order.
  rebuildEntries();
  if (cursor !== undefined && boundaryIndex < 0) {
    throw new Error('invalid transcript history cursor boundary');
  }
  if (index !== undefined) {
    if (opts.source.readRunJournalWithSpans === undefined) {
      throw new Error('indexed transcript history source cannot derive journal spans');
    }
    index.install(opts.room, establishedFloor, indexedEntries(entries, journalSpans));
  }
  const candidates = entries.slice(0, boundaryIndex);
  const selectedUnits = newestTranscriptHistoryUnits(
    candidates.map((entry) => entry.unit),
    HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  );
  const selectedSet = new Set(selectedUnits);
  const selected = candidates.filter((entry) => selectedSet.has(entry.unit));
  const hasMore = selected.length < candidates.length;
  const selectedMessageIds = new Set<number>();
  const selectedEvents = new Map<number, Set<number>>();
  for (const entry of selected) {
    if (entry.unit.kind === 'message') {
      selectedMessageIds.add(entry.unit.message_id);
      continue;
    }
    selectedMessageIds.add(entry.unit.root_message_id);
    selectedMessageIds.add(entry.unit.output_message_id);
    const indices = selectedEvents.get(entry.unit.root_message_id) ?? new Set<number>();
    entry.unit.event_indices.forEach((index) => indices.add(index));
    selectedEvents.set(entry.unit.root_message_id, indices);
  }
  const page: TranscriptHistoryPage = {
    messages: [...selectedMessageIds]
      .map((id) => loadMessage(id))
      .filter((message): message is Message => message !== undefined)
      .sort((left, right) => left.id - right.id),
    journals: [...selectedEvents]
      .map(([rootMessageId, indices]) => ({
        root_message_id: rootMessageId,
        events: [...indices]
          .sort((left, right) => left - right)
          .map((index) => ({ index, event: journals.get(rootMessageId)![index]! })),
      }))
      .filter((journal) => journal.events.length > 0),
    units: selected.map((entry) => entry.unit),
    before_cursor: hasMore && selected[0] !== undefined
      ? encodeCursor({
          v: 1,
          room: opts.room,
          ceiling_message_id: cursor?.ceiling_message_id ?? ceiling ?? 0,
          before: {
            message_id: selected[0].sourceMessageId,
            unit_ordinal: selected[0].unitOrdinal,
          },
        })
      : null,
    has_more: hasMore,
  };
  const parsed = TranscriptHistoryPageSchema.parse(page);
  // harn:end transcript-history-cursors-cover-complete-established-order
  return {
    page: parsed,
    metrics: {
      duration_ms: performance.now() - started,
      response_bytes: Buffer.byteLength(JSON.stringify(parsed)),
      selected_units: parsed.units.length,
      selected_text_slots: transcriptHistoryTextSlotCount(parsed.units),
      message_reads: messageReads,
      message_records_read: messageRecordsRead,
      journal_reads: journalReads,
      journal_events_scanned: journalEventsScanned,
      index_rows_read: index === undefined ? undefined : entries.length,
      index_backfilled: index === undefined ? undefined : true,
    },
  };
}
// harn:end historical-transcript-pages-budget-text-slots
