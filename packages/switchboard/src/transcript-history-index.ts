import Database from 'better-sqlite3';
import type { Message, TranscriptHistoryUnit } from '@codor/protocol';

export const TRANSCRIPT_HISTORY_INDEX_VERSION = 1;

export interface JournalEventSpan {
  index: number;
  offset: number;
  length: number;
}

export interface IndexedTranscriptEntry {
  sourceMessageId: number;
  unitOrdinal: number;
  positionMessageId: number;
  journalOrder: number;
  timestamp: number;
  unit: TranscriptHistoryUnit;
  charged: boolean;
  maxMessageId: number;
  eventSpans: JournalEventSpan[];
}

interface IndexRoomRow {
  version: number;
  complete: number;
  continuation_floor: number | null;
}

interface IndexUnitRow {
  source_message_id: number;
  unit_ordinal: number;
  position_message_id: number;
  journal_order: number;
  timestamp_ms: number;
  unit_json: string;
  charged: number;
  max_message_id: number;
  event_spans_json: string;
}

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS transcript_history_index_rooms (
  room TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  continuation_floor INTEGER,
  indexed_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_history_index_units (
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL,
  unit_ordinal INTEGER NOT NULL,
  position_message_id INTEGER NOT NULL,
  journal_order INTEGER NOT NULL,
  timestamp_ms REAL NOT NULL,
  order_group INTEGER NOT NULL,
  order_a REAL NOT NULL,
  order_b INTEGER NOT NULL,
  order_c INTEGER NOT NULL,
  order_d INTEGER NOT NULL,
  unit_json TEXT NOT NULL,
  charged INTEGER NOT NULL CHECK (charged IN (0, 1)),
  max_message_id INTEGER NOT NULL,
  event_spans_json TEXT NOT NULL,
  PRIMARY KEY (room, source_message_id, unit_ordinal)
);
CREATE INDEX IF NOT EXISTS transcript_history_index_order
  ON transcript_history_index_units (
    room, order_group, order_a, order_b, order_c, order_d
  );
CREATE INDEX IF NOT EXISTS transcript_history_index_charged_order
  ON transcript_history_index_units (
    room, charged, order_group, order_a, order_b, order_c, order_d
  );
CREATE TABLE IF NOT EXISTS transcript_history_index_dirty (
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (room, message_id)
);
CREATE TRIGGER IF NOT EXISTS transcript_history_index_message_insert
AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO transcript_history_index_dirty (room, message_id)
  VALUES (NEW.room, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS transcript_history_index_message_update
AFTER UPDATE ON messages BEGIN
  INSERT OR IGNORE INTO transcript_history_index_dirty (room, message_id)
  VALUES (NEW.room, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS transcript_history_index_message_delete
AFTER DELETE ON messages BEGIN
  INSERT OR IGNORE INTO transcript_history_index_dirty (room, message_id)
  VALUES (OLD.room, OLD.id);
END;
`;

const tuple = (
  entry: IndexedTranscriptEntry,
  continuationFloor: number | undefined,
): [number, number, number, number, number] => {
  const strict = continuationFloor !== undefined
    && entry.positionMessageId >= continuationFloor;
  return strict
    ? [1, entry.positionMessageId, entry.journalOrder, entry.sourceMessageId, entry.unitOrdinal]
    : [0, entry.timestamp, entry.sourceMessageId, entry.unitOrdinal, 0];
};

const parseRow = (row: IndexUnitRow): IndexedTranscriptEntry => ({
  sourceMessageId: row.source_message_id,
  unitOrdinal: row.unit_ordinal,
  positionMessageId: row.position_message_id,
  journalOrder: row.journal_order,
  timestamp: row.timestamp_ms,
  unit: JSON.parse(row.unit_json) as TranscriptHistoryUnit,
  charged: row.charged !== 0,
  maxMessageId: row.max_message_id,
  eventSpans: JSON.parse(row.event_spans_json) as JournalEventSpan[],
});

// harn:assume transcript-history-index-is-write-maintained-and-rebuildable ref=transcript-history-index-schema
export class TranscriptHistoryIndex {
  constructor(private readonly db: Database.Database) {
    db.exec(INDEX_SCHEMA);
  }

  roomState(room: string): { complete: boolean; continuationFloor?: number } {
    const row = this.db.prepare(
      `SELECT version, complete, continuation_floor
       FROM transcript_history_index_rooms WHERE room = ?`,
    ).get(room) as IndexRoomRow | undefined;
    return {
      complete: row?.version === TRANSCRIPT_HISTORY_INDEX_VERSION && row.complete !== 0,
      continuationFloor: row?.continuation_floor ?? undefined,
    };
  }

  dirtyMessageIds(room: string): number[] {
    return (this.db.prepare(
      'SELECT message_id FROM transcript_history_index_dirty WHERE room = ? ORDER BY message_id',
    ).all(room) as { message_id: number }[]).map((row) => row.message_id);
  }

  install(
    room: string,
    continuationFloor: number | undefined,
    entries: readonly IndexedTranscriptEntry[],
  ): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM transcript_history_index_units WHERE room = ?').run(room);
      this.insertEntries(room, continuationFloor, entries);
      this.db.prepare(
        `INSERT INTO transcript_history_index_rooms
           (room, version, complete, continuation_floor, indexed_ts)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(room) DO UPDATE SET
           version = excluded.version,
           complete = 1,
           continuation_floor = excluded.continuation_floor,
           indexed_ts = excluded.indexed_ts`,
      ).run(
        room,
        TRANSCRIPT_HISTORY_INDEX_VERSION,
        continuationFloor ?? null,
        new Date().toISOString(),
      );
      this.db.prepare('DELETE FROM transcript_history_index_dirty WHERE room = ?').run(room);
    })();
  }

  replaceDirty(opts: {
    room: string;
    continuationFloor: number | undefined;
    ordinaryMessageIds: readonly number[];
    rootMessageIds: readonly number[];
    entries: readonly IndexedTranscriptEntry[];
    dirtyMessageIds: readonly number[];
  }): void {
    this.db.transaction(() => {
      const remove = this.db.prepare(
        `DELETE FROM transcript_history_index_units
         WHERE room = ? AND source_message_id = ?`,
      );
      for (const id of new Set([...opts.ordinaryMessageIds, ...opts.rootMessageIds])) {
        remove.run(opts.room, id);
      }
      this.insertEntries(opts.room, opts.continuationFloor, opts.entries);
      this.db.prepare(
        `UPDATE transcript_history_index_rooms
         SET continuation_floor = ?, indexed_ts = ?
         WHERE room = ? AND version = ? AND complete = 1`,
      ).run(
        opts.continuationFloor ?? null,
        new Date().toISOString(),
        opts.room,
        TRANSCRIPT_HISTORY_INDEX_VERSION,
      );
      const clear = this.db.prepare(
        'DELETE FROM transcript_history_index_dirty WHERE room = ? AND message_id = ?',
      );
      for (const id of opts.dirtyMessageIds) clear.run(opts.room, id);
    })();
  }

  /** Maintain an ordinary/tombstoned message synchronously inside the Store's
   * authoritative transaction. Journal-owned rows stay dirty until the daemon
   * reaches the post-finalization boundary (or request recovery). */
  maintainOrdinaryMessage(message: Message): boolean {
    const state = this.roomState(message.room);
    if (!state.complete) return false;
    if (
      message.run_parent_id !== undefined
      || (message.kind === 'run' && message.run !== undefined)
    ) return false;
    this.db.prepare(
      `DELETE FROM transcript_history_index_units
       WHERE room = ? AND source_message_id = ?`,
    ).run(message.room, message.id);
    if (message.kind !== 'ask' && message.kind !== 'approval') {
      this.insertEntries(message.room, state.continuationFloor, [{
        sourceMessageId: message.id,
        unitOrdinal: 0,
        positionMessageId: message.id,
        journalOrder: 0,
        timestamp: Date.parse(message.ts),
        unit: { kind: 'message', message_id: message.id },
        charged: true,
        maxMessageId: message.id,
        eventSpans: [],
      }]);
    }
    this.db.prepare(
      'DELETE FROM transcript_history_index_dirty WHERE room = ? AND message_id = ?',
    ).run(message.room, message.id);
    return true;
  }

  /** Running families are live-owned. Remove any previous finalized projection
   * and clear this mutation inside the same Store transaction. */
  maintainMutableFamily(room: string, rootMessageId: number, messageId: number): void {
    if (!this.roomState(room).complete) return;
    this.db.prepare(
      `DELETE FROM transcript_history_index_units
       WHERE room = ? AND source_message_id = ?`,
    ).run(room, rootMessageId);
    this.db.prepare(
      'DELETE FROM transcript_history_index_dirty WHERE room = ? AND message_id = ?',
    ).run(room, messageId);
  }

  private insertEntries(
    room: string,
    continuationFloor: number | undefined,
    entries: readonly IndexedTranscriptEntry[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO transcript_history_index_units (
         room, source_message_id, unit_ordinal, position_message_id,
         journal_order, timestamp_ms, order_group, order_a, order_b,
         order_c, order_d, unit_json, charged, max_message_id,
         event_spans_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      const order = tuple(entry, continuationFloor);
      insert.run(
        room,
        entry.sourceMessageId,
        entry.unitOrdinal,
        entry.positionMessageId,
        entry.journalOrder,
        entry.timestamp,
        ...order,
        JSON.stringify(entry.unit),
        entry.charged ? 1 : 0,
        entry.maxMessageId,
        JSON.stringify(entry.eventSpans),
      );
    }
  }
  // harn:end transcript-history-index-schema

  // harn:assume indexed-transcript-pages-read-only-current-selected-evidence ref=indexed-transcript-page-query
  selectPage(opts: {
    room: string;
    ceilingMessageId: number;
    before?: { messageId: number; unitOrdinal: number };
    textSlotLimit: number;
  }): { entries: IndexedTranscriptEntry[]; hasMore: boolean; rowsRead: number } {
    const boundary = opts.before === undefined ? undefined : this.db.prepare(
      `SELECT order_group, order_a, order_b, order_c, order_d
       FROM transcript_history_index_units
       WHERE room = ? AND source_message_id = ? AND unit_ordinal = ?
         AND max_message_id <= ?`,
    ).get(
      opts.room,
      opts.before.messageId,
      opts.before.unitOrdinal,
      opts.ceilingMessageId,
    ) as {
      order_group: number;
      order_a: number;
      order_b: number;
      order_c: number;
      order_d: number;
    } | undefined;
    if (opts.before !== undefined && boundary === undefined) {
      throw new Error('invalid transcript history cursor boundary');
    }
    const beforeSql = boundary === undefined
      ? ''
      : `AND (order_group, order_a, order_b, order_c, order_d) < (?, ?, ?, ?, ?)`;
    const beforeArgs = boundary === undefined ? [] : [
      boundary.order_group,
      boundary.order_a,
      boundary.order_b,
      boundary.order_c,
      boundary.order_d,
    ];
    const charged = this.db.prepare(
      `SELECT order_group, order_a, order_b, order_c, order_d
       FROM transcript_history_index_units
       WHERE room = ? AND max_message_id <= ? AND charged = 1 ${beforeSql}
       ORDER BY order_group DESC, order_a DESC, order_b DESC, order_c DESC, order_d DESC
       LIMIT ?`,
    ).all(
      opts.room,
      opts.ceilingMessageId,
      ...beforeArgs,
      opts.textSlotLimit + 1,
    ) as {
      order_group: number;
      order_a: number;
      order_b: number;
      order_c: number;
      order_d: number;
    }[];
    const preceding = charged[opts.textSlotLimit];
    const afterSql = preceding === undefined
      ? ''
      : `AND (order_group, order_a, order_b, order_c, order_d) > (?, ?, ?, ?, ?)`;
    const afterArgs = preceding === undefined ? [] : [
      preceding.order_group,
      preceding.order_a,
      preceding.order_b,
      preceding.order_c,
      preceding.order_d,
    ];
    const rows = this.db.prepare(
      `SELECT source_message_id, unit_ordinal, position_message_id,
              journal_order, timestamp_ms, unit_json, charged,
              max_message_id, event_spans_json
       FROM transcript_history_index_units
       WHERE room = ? AND max_message_id <= ? ${beforeSql} ${afterSql}
       ORDER BY order_group, order_a, order_b, order_c, order_d`,
    ).all(
      opts.room,
      opts.ceilingMessageId,
      ...beforeArgs,
      ...afterArgs,
    ) as IndexUnitRow[];
    return {
      entries: rows.map(parseRow),
      hasMore: preceding !== undefined,
      rowsRead: charged.length + rows.length,
    };
  }
  // harn:end indexed-transcript-pages-read-only-current-selected-evidence
}
