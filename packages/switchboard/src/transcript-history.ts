import { performance } from 'node:perf_hooks';

import {
  HISTORICAL_TRANSCRIPT_PAGE_SIZE,
  parseRunItemPayload,
  TranscriptHistoryPageSchema,
  type Message,
  type TranscriptHistoryPage,
  type TranscriptHistoryUnit,
  type WireEvent,
} from '@codor/protocol';

const MESSAGE_CHUNK_SIZE = 64;

export interface TranscriptHistorySource {
  listMessages(room: string, opts: { before: number; limit: number }): Message[];
  getMessage(room: string, id: number): Message | undefined;
  readRunJournal(room: string, rootMessageId: number): WireEvent[];
}

export interface TranscriptHistoryMetrics {
  duration_ms: number;
  response_bytes: number;
  selected_units: number;
  message_reads: number;
  message_records_read: number;
  journal_reads: number;
  journal_events_scanned: number;
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
      if (event.item_type === 'text_delta') {
        const parsed = parseRunItemPayload('text_delta', event.payload);
        if (!parsed.success) {
          prose.delete(target);
          add('tool', index, target, timestamp);
          return;
        }
        const previous = prose.get(target);
        if (previous !== undefined) {
          previous.unit.event_indices.push(index);
        } else {
          prose.set(target, add('prose', index, target, timestamp));
        }
        proseTargets.add(target);
        streamedText.set(target, `${streamedText.get(target) ?? ''}${parsed.data.text}`);
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
  const hasVisibleText = finalText.length > 0 && (
    !targetHasProse
    || (modern && finalText.startsWith(targetStream) && finalText.length > targetStream.length)
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

// harn:assume historical-transcript-pages-match-output-scoped-rendering ref=transcript-history-page-builder
export function buildTranscriptHistoryPage(opts: {
  room: string;
  cursor?: string;
  source: TranscriptHistorySource;
}): TranscriptHistoryBuildResult {
  const started = performance.now();
  const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor, opts.room);
  let ceiling = cursor?.ceiling_message_id;
  let before = ceiling === undefined ? Number.MAX_SAFE_INTEGER : ceiling + 1;
  let exhausted = false;
  let messageReads = 0;
  let messageRecordsRead = 0;
  let journalReads = 0;
  let journalEventsScanned = 0;
  const messages = new Map<number, Message>();
  const journals = new Map<number, WireEvent[]>();
  let entries: Entry[] = [];
  let boundaryIndex = -1;

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
        events = opts.source.readRunJournal(opts.room, root.id);
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
    const floors = [...messages.values()].flatMap((message) => [
      ...(message.run?.output_mode === 'messages' ? [message.id] : []),
      ...(message.run_parent_id !== undefined ? [message.run_parent_id] : []),
    ]);
    const floor = floors.length === 0 ? undefined : Math.min(...floors);
    entries = next.sort((left, right) => compareEntries(left, right, floor));
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
    rebuildEntries();
    const candidates = boundaryIndex < 0 ? [] : entries.slice(0, boundaryIndex);
    if (boundaryIndex >= 0 && candidates.length > HISTORICAL_TRANSCRIPT_PAGE_SIZE) break;
    if (chunk.length === 0) exhausted = true;
  }

  rebuildEntries();
  if (cursor !== undefined && boundaryIndex < 0) throw new Error('invalid transcript history cursor boundary');
  const candidates = entries.slice(0, boundaryIndex);
  const selected = candidates.slice(-HISTORICAL_TRANSCRIPT_PAGE_SIZE);
  const hasMore = candidates.length > HISTORICAL_TRANSCRIPT_PAGE_SIZE;
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
          ceiling_message_id: ceiling ?? 0,
          before: {
            message_id: selected[0].sourceMessageId,
            unit_ordinal: selected[0].unitOrdinal,
          },
        })
      : null,
    has_more: hasMore,
  };
  const parsed = TranscriptHistoryPageSchema.parse(page);
  return {
    page: parsed,
    metrics: {
      duration_ms: performance.now() - started,
      response_bytes: Buffer.byteLength(JSON.stringify(parsed)),
      selected_units: parsed.units.length,
      message_reads: messageReads,
      message_records_read: messageRecordsRead,
      journal_reads: journalReads,
      journal_events_scanned: journalEventsScanned,
    },
  };
}
// harn:end historical-transcript-pages-match-output-scoped-rendering
