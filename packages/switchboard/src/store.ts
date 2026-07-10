import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import {
  type ChangeEntity,
  type ChangeLogEntry,
  ChangeLogEntrySchema,
  type Delivery,
  DeliverySchema,
  type Member,
  MemberSchema,
  type Message,
  MessageSchema,
  type PendingInteraction,
  PendingInteractionSchema,
  type Room,
  type RoomConfig,
  RoomConfigSchema,
  type RoomMeter,
  RoomMeterSchema,
  RoomSchema,
  type RunSummary,
} from '@wireroom/protocol';

// harn:assume run-blobs-off-db ref=store-schema-no-blobs
// The DB persists pointers (RunSummary.events_ref) — never run event payloads.
// Run streams are JSONL blobs on disk, journaled by the daemon; the store has
// no table or column for them, which keeps the DB small and makes
// one-message-per-run structural.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  config TEXT NOT NULL,        -- RoomConfig JSON
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  harness TEXT,
  session_ref TEXT,
  cwd TEXT,
  policy TEXT,
  host TEXT,
  state TEXT,
  parent TEXT,
  role TEXT,
  conventions_sent INTEGER NOT NULL DEFAULT 0,
  misaddressed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (room, handle)
);
CREATE TABLE IF NOT EXISTS messages (
  room TEXT NOT NULL REFERENCES rooms(id),
  id INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL,      -- MentionSpan[] JSON (member ids, never handles)
  refs TEXT NOT NULL,          -- number[] JSON
  ledger_refs TEXT NOT NULL,   -- string[] JSON
  reply_to INTEGER,
  run TEXT,                    -- RunSummary JSON: events_ref pointer only, no events
  ask TEXT,                    -- AskCard JSON
  origin TEXT,                 -- BridgeOrigin JSON
  ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room, id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id),
  message_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  run_msg_id INTEGER,
  read_ts TEXT,
  payload_snapshot TEXT,        -- immutable routed prompt context; never run events
  process_id INTEGER,            -- bounded attempt evidence, never run event payloads
  process_group_id INTEGER,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_interactions (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id),
  member_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  native_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  targets TEXT NOT NULL,       -- MemberId[] JSON
  state TEXT NOT NULL,
  answer TEXT,                 -- JSON
  answered_by TEXT,
  answered_ts TEXT
);
CREATE TABLE IF NOT EXISTS meters (
  room TEXT NOT NULL REFERENCES rooms(id),
  day TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room, day)
);
CREATE TABLE IF NOT EXISTS changes (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  entity TEXT NOT NULL,        -- message|member|inbox|meter|room
  entity_id TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
`;
// harn:end run-blobs-off-db

// harn:assume delivery-payload-snapshotted ref=delivery-payload-storage
function migrateDeliveryPayloadSnapshot(db: Database.Database): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[];
  if (!columns.some((column) => column.name === 'payload_snapshot')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN payload_snapshot TEXT');
  }
  if (!columns.some((column) => column.name === 'process_id')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN process_id INTEGER');
  }
  if (!columns.some((column) => column.name === 'process_group_id')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN process_group_id INTEGER');
  }
}
// harn:end delivery-payload-snapshotted

const toBool = (n: number): boolean => n !== 0;
const fromBool = (b: boolean): number => (b ? 1 : 0);
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const jsonOrNull = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

interface MemberRow {
  id: string;
  room: string;
  kind: string;
  handle: string;
  display_name: string;
  harness: string | null;
  session_ref: string | null;
  cwd: string | null;
  policy: string | null;
  host: string | null;
  state: string | null;
  parent: string | null;
  role: string | null;
  conventions_sent: number;
  misaddressed: number;
}

interface MessageRow {
  room: string;
  id: number;
  author: string;
  kind: string;
  body: string;
  mentions: string;
  refs: string;
  ledger_refs: string;
  reply_to: number | null;
  run: string | null;
  ask: string | null;
  origin: string | null;
  ts: string;
  seq: number;
}

interface DeliveryRow {
  id: string;
  room: string;
  message_id: number;
  recipient: string;
  state: string;
  attempt_count: number;
  batch_id: string | null;
  run_msg_id: number | null;
  read_ts: string | null;
  payload_snapshot: string | null;
  process_id: number | null;
  process_group_id: number | null;
  ts: string;
}

interface InteractionRow {
  id: string;
  room: string;
  member_id: string;
  message_id: number;
  native_id: string;
  kind: string;
  targets: string;
  state: string;
  answer: string | null;
  answered_by: string | null;
  answered_ts: string | null;
}

interface RoomRow {
  id: string;
  name: string;
  created_ts: string;
  config: string;
  seq: number;
}

interface MeterRow {
  room: string;
  day: string;
  turns: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

function memberFromRow(row: MemberRow): Member {
  return MemberSchema.parse({
    id: row.id,
    kind: row.kind,
    handle: row.handle,
    display_name: row.display_name,
    harness: row.harness ?? undefined,
    session_ref: row.session_ref ?? undefined,
    cwd: row.cwd ?? undefined,
    policy: row.policy ?? undefined,
    host: row.host ?? undefined,
    state: row.state ?? undefined,
    parent: row.parent ?? undefined,
    role: row.role ?? undefined,
    conventions_sent: toBool(row.conventions_sent),
    misaddressed: toBool(row.misaddressed),
  });
}

function messageFromRow(row: MessageRow): Message {
  return MessageSchema.parse({
    id: row.id,
    room: row.room,
    author: row.author,
    kind: row.kind,
    body: row.body,
    mentions: JSON.parse(row.mentions),
    refs: JSON.parse(row.refs),
    ledger_refs: JSON.parse(row.ledger_refs),
    reply_to: row.reply_to ?? undefined,
    run: row.run ? JSON.parse(row.run) : undefined,
    ask: row.ask ? JSON.parse(row.ask) : undefined,
    origin: row.origin ? JSON.parse(row.origin) : undefined,
    ts: row.ts,
    seq: row.seq,
  });
}

function deliveryFromRow(row: DeliveryRow): Delivery {
  return DeliverySchema.parse({
    id: row.id,
    room: row.room,
    message_id: row.message_id,
    recipient: row.recipient,
    state: row.state,
    attempt_count: row.attempt_count,
    batch_id: row.batch_id ?? undefined,
    run_msg_id: row.run_msg_id ?? undefined,
    read_ts: row.read_ts ?? undefined,
    ts: row.ts,
  });
}

function interactionFromRow(row: InteractionRow): PendingInteraction {
  return PendingInteractionSchema.parse({
    id: row.id,
    room: row.room,
    member_id: row.member_id,
    message_id: row.message_id,
    native_id: row.native_id,
    kind: row.kind,
    targets: JSON.parse(row.targets),
    state: row.state,
    answer: row.answer === null ? undefined : JSON.parse(row.answer),
    answered_by: row.answered_by ?? undefined,
    answered_ts: row.answered_ts ?? undefined,
  });
}

function roomFromRow(row: RoomRow): Room {
  return RoomSchema.parse({
    id: row.id,
    name: row.name,
    created_ts: row.created_ts,
    config: JSON.parse(row.config),
  });
}

function meterFromRow(row: MeterRow): RoomMeter {
  return RoomMeterSchema.parse(row);
}

export interface NewMember {
  kind: Member['kind'];
  handle: string;
  display_name: string;
  harness?: string;
  session_ref?: string;
  cwd?: string;
  policy?: string;
  host?: string;
  state?: Member['state'];
  parent?: string;
  role?: Member['role'];
}

export interface NewMessage {
  author: string;
  kind: Message['kind'];
  body: string;
  mentions?: Message['mentions'];
  refs?: number[];
  ledger_refs?: string[];
  reply_to?: number;
  run?: RunSummary;
  ask?: Message['ask'];
  origin?: Message['origin'];
}

export interface SyncResult {
  seq: number;
  room: Room;
  messages: Message[];
  members: Member[];
  inbox: Delivery[];
  meters: RoomMeter[];
}

export interface FanoutDelivery {
  recipient: string;
  state?: Delivery['state'];
  payload_snapshot?: string;
}

export interface AtomicTurnStart {
  runMessage: Message;
  deliveries: Delivery[];
}

export interface AtomicTurnCompletion {
  message: Message;
  member: Member;
  meter: RoomMeter;
  deliveries: Delivery[];
}

export interface DeliveryAttemptProcess {
  pid?: number;
  process_group_id?: number;
}

/**
 * The room store: better-sqlite3, synchronous, one file per switchboard.
 * Every mutation of a client-visible entity appends to the change log inside
 * the same transaction — sync hydrates exclusively from that log.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    migrateDeliveryPayloadSnapshot(this.db);
  }

  close(): void {
    this.db.close();
  }

  // harn:assume changelog-covers-every-visible-entity ref=changelog-append
  /**
   * Allocates the room's next seq and appends one change row — called by
   * EVERY mutating method below, inside its transaction. Returns the seq so
   * the mutation can stamp it on the entity (messages carry their seq).
   */
  private appendChange(room: string, entity: ChangeEntity, entityId: string): number {
    const bumped = this.db
      .prepare('UPDATE rooms SET seq = seq + 1 WHERE id = ? RETURNING seq')
      .get(room) as { seq: number } | undefined;
    if (!bumped) throw new Error(`no such room: ${room}`);
    this.db
      .prepare('INSERT INTO changes (room_id, seq, entity, entity_id) VALUES (?, ?, ?, ?)')
      .run(room, bumped.seq, entity, entityId);
    return bumped.seq;
  }
  // harn:end changelog-covers-every-visible-entity

  // ── rooms ─────────────────────────────────────────────────────────────

  // harn:assume owner-and-system-members-seeded ref=room-seeding
  /**
   * Creates a room and atomically seeds its two structural members: the
   * owner human (the authenticated principal's author identity) and the
   * non-addressable system member holding the reserved 'switchboard' handle.
   */
  createRoom(opts: {
    id: string;
    name: string;
    owner: { handle: string; display_name: string };
    config?: Partial<RoomConfig>;
  }): { room: Room; owner: Member; system: Member } {
    const config = RoomConfigSchema.parse(opts.config ?? {});
    const ts = new Date().toISOString();
    const result = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO rooms (id, name, created_ts, config, seq) VALUES (?, ?, ?, ?, 0)')
        .run(opts.id, opts.name, ts, JSON.stringify(config));
      this.appendChange(opts.id, 'room', opts.id);
      const owner = this.insertMember(opts.id, {
        kind: 'human',
        handle: opts.owner.handle,
        display_name: opts.owner.display_name,
        role: 'owner',
      });
      const system = this.insertMember(opts.id, {
        kind: 'system',
        handle: 'switchboard',
        display_name: 'Switchboard',
      });
      return { owner, system };
    })();
    return { room: this.getRoom(opts.id)!, ...result };
  }
  // harn:end owner-and-system-members-seeded

  getRoom(id: string): Room | undefined {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row ? roomFromRow(row) : undefined;
  }

  listRooms(): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY id').all() as RoomRow[];
    return rows.map(roomFromRow);
  }

  updateRoomConfig(room: string, patch: Partial<RoomConfig>): Room {
    return this.db.transaction(() => {
      const current = this.getRoom(room);
      if (!current) throw new Error(`no such room: ${room}`);
      const config = RoomConfigSchema.parse({ ...current.config, ...patch });
      this.db
        .prepare('UPDATE rooms SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), room);
      this.appendChange(room, 'room', room);
      return this.getRoom(room)!;
    })();
  }

  // ── members ───────────────────────────────────────────────────────────

  private insertMember(room: string, member: NewMember): Member {
    const validated = MemberSchema.parse({ id: this.newUlid(), ...member });
    this.db
      .prepare(
        `INSERT INTO members (id, room, kind, handle, display_name, harness, session_ref,
           cwd, policy, host, state, parent, role, conventions_sent, misaddressed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        room,
        validated.kind,
        validated.handle,
        validated.display_name,
        orNull(validated.harness),
        orNull(validated.session_ref),
        orNull(validated.cwd),
        orNull(validated.policy),
        orNull(validated.host),
        orNull(validated.state),
        orNull(validated.parent),
        orNull(validated.role),
        fromBool(validated.conventions_sent),
        fromBool(validated.misaddressed),
      );
    this.appendChange(room, 'member', validated.id);
    return validated;
  }

  addMember(room: string, member: NewMember): Member {
    return this.db.transaction(() => this.insertMember(room, member))();
  }

  updateMember(
    room: string,
    memberId: string,
    patch: Partial<Omit<Member, 'id' | 'kind'>>,
  ): Member {
    return this.db.transaction(() => {
      const existing = this.getMember(room, memberId);
      if (!existing) throw new Error(`no such member: ${memberId}`);
      const merged = MemberSchema.parse({ ...existing, ...patch });
      this.db
        .prepare(
          `UPDATE members SET handle = ?, display_name = ?, harness = ?, session_ref = ?,
             cwd = ?, policy = ?, host = ?, state = ?, parent = ?, role = ?,
             conventions_sent = ?, misaddressed = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.handle,
          merged.display_name,
          orNull(merged.harness),
          orNull(merged.session_ref),
          orNull(merged.cwd),
          orNull(merged.policy),
          orNull(merged.host),
          orNull(merged.state),
          orNull(merged.parent),
          orNull(merged.role),
          fromBool(merged.conventions_sent),
          fromBool(merged.misaddressed),
          room,
          memberId,
        );
      this.appendChange(room, 'member', memberId);
      return merged;
    })();
  }

  getMember(room: string, memberId: string): Member | undefined {
    const row = this.db
      .prepare('SELECT * FROM members WHERE room = ? AND id = ?')
      .get(room, memberId) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  getMemberByHandle(room: string, handle: string): Member | undefined {
    const row = this.db
      .prepare('SELECT * FROM members WHERE room = ? AND handle = ?')
      .get(room, handle) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  listMembers(room: string): Member[] {
    const rows = this.db
      .prepare('SELECT * FROM members WHERE room = ? ORDER BY id')
      .all(room) as MemberRow[];
    return rows.map(memberFromRow);
  }

  // ── messages ──────────────────────────────────────────────────────────

  // harn:assume message-id-txn-allocation ref=message-id-allocation
  /**
   * Message ids are per-room dense monotonic ints allocated as MAX(id)+1
   * INSIDE the same synchronous transaction as the insert — ids are permanent
   * (#N refs), so allocation can never race or leave gaps.
   */
  postMessage(room: string, message: NewMessage): Message {
    return this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages WHERE room = ?')
        .get(room) as { id: number };
      const seq = this.appendChange(room, 'message', String(next.id));
      const validated = MessageSchema.parse({
        id: next.id,
        room,
        author: message.author,
        kind: message.kind,
        body: message.body,
        mentions: message.mentions ?? [],
        refs: message.refs ?? [],
        ledger_refs: message.ledger_refs ?? [],
        reply_to: message.reply_to,
        run: message.run,
        ask: message.ask,
        origin: message.origin,
        ts: new Date().toISOString(),
        seq,
      });
      this.db
        .prepare(
          `INSERT INTO messages (room, id, author, kind, body, mentions, refs, ledger_refs,
             reply_to, run, ask, origin, ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room,
          validated.id,
          validated.author,
          validated.kind,
          validated.body,
          JSON.stringify(validated.mentions),
          JSON.stringify(validated.refs),
          JSON.stringify(validated.ledger_refs),
          orNull(validated.reply_to),
          jsonOrNull(validated.run),
          jsonOrNull(validated.ask),
          jsonOrNull(validated.origin),
          validated.ts,
          validated.seq,
        );
      return validated;
    })();
  }
  // harn:end message-id-txn-allocation

  /**
   * In-place update of a message (run finalization: body becomes final_text,
   * mentions/refs re-parsed, run summary updated). Same id, new seq.
   */
  updateMessage(
    room: string,
    id: number,
    patch: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run' | 'ask'>>,
  ): Message {
    return this.db.transaction(() => {
      const existing = this.getMessage(room, id);
      if (!existing) throw new Error(`no such message: #${id}`);
      const seq = this.appendChange(room, 'message', String(id));
      const merged = MessageSchema.parse({ ...existing, ...patch, seq });
      this.db
        .prepare(
          `UPDATE messages SET body = ?, mentions = ?, refs = ?, ledger_refs = ?,
             run = ?, ask = ?, seq = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.body,
          JSON.stringify(merged.mentions),
          JSON.stringify(merged.refs),
          JSON.stringify(merged.ledger_refs),
          jsonOrNull(merged.run),
          jsonOrNull(merged.ask),
          seq,
          room,
          id,
        );
      return merged;
    })();
  }

  getMessage(room: string, id: number): Message | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND id = ?')
      .get(room, id) as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  listMessages(room: string, opts: { limit?: number; before?: number } = {}): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE room = ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(room, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 100) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  // ── deliveries ────────────────────────────────────────────────────────

  createDelivery(
    room: string,
    delivery: {
      message_id: number;
      recipient: string;
      state?: Delivery['state'];
      payload_snapshot?: string;
    },
  ): Delivery {
    return this.db.transaction(() => {
      const validated = DeliverySchema.parse({
        id: randomUUID(),
        room,
        message_id: delivery.message_id,
        recipient: delivery.recipient,
        state: delivery.state ?? 'queued',
        ts: new Date().toISOString(),
      });
      this.db
        .prepare(
          `INSERT INTO deliveries (id, room, message_id, recipient, state, attempt_count,
             batch_id, run_msg_id, read_ts, payload_snapshot, process_id, process_group_id, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.id,
          room,
          validated.message_id,
          validated.recipient,
          validated.state,
          validated.attempt_count,
          orNull(validated.batch_id),
          orNull(validated.run_msg_id),
          orNull(validated.read_ts),
          orNull(delivery.payload_snapshot),
          null,
          null,
          validated.ts,
        );
      // Human inbox records are client-visible; recipient kind decides.
      const recipient = this.getMember(room, validated.recipient);
      if (recipient?.kind === 'human') this.appendChange(room, 'inbox', validated.id);
      return validated;
    })();
  }

  updateDelivery(
    room: string,
    deliveryId: string,
    patch: Partial<Pick<Delivery, 'state' | 'attempt_count' | 'batch_id' | 'run_msg_id' | 'read_ts'>>,
  ): Delivery {
    return this.db.transaction(() => {
      const existing = this.getDelivery(room, deliveryId);
      if (!existing) throw new Error(`no such delivery: ${deliveryId}`);
      const merged = DeliverySchema.parse({ ...existing, ...patch });
      this.db
        .prepare(
          `UPDATE deliveries SET state = ?, attempt_count = ?, batch_id = ?,
             run_msg_id = ?, read_ts = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.state,
          merged.attempt_count,
          orNull(merged.batch_id),
          orNull(merged.run_msg_id),
          orNull(merged.read_ts),
          room,
          deliveryId,
        );
      const recipient = this.getMember(room, merged.recipient);
      // Client-visible inbox records: human deliveries always; agent
      // deliveries once they need operator attention (held ⇄ released).
      if (recipient?.kind === 'human' || merged.state === 'held' || existing.state === 'held') {
        this.appendChange(room, 'inbox', deliveryId);
      }
      return merged;
    })();
  }

  getDelivery(room: string, deliveryId: string): Delivery | undefined {
    const row = this.db
      .prepare('SELECT * FROM deliveries WHERE room = ? AND id = ?')
      .get(room, deliveryId) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : undefined;
  }

  getDeliveryPayloadSnapshot(room: string, deliveryId: string): string | undefined {
    const row = this.db
      .prepare('SELECT payload_snapshot FROM deliveries WHERE room = ? AND id = ?')
      .get(room, deliveryId) as { payload_snapshot: string | null } | undefined;
    return row?.payload_snapshot ?? undefined;
  }

  // harn:assume attempt-start-evidence-persisted ref=attempt-process-evidence
  /** Internal process evidence for one delivery attempt; not client-visible. */
  getDeliveryAttemptProcess(room: string, deliveryId: string): DeliveryAttemptProcess | undefined {
    const row = this.db
      .prepare('SELECT process_id, process_group_id FROM deliveries WHERE room = ? AND id = ?')
      .get(room, deliveryId) as
      | { process_id: number | null; process_group_id: number | null }
      | undefined;
    if (!row || (row.process_id === null && row.process_group_id === null)) return undefined;
    return {
      ...(row.process_id !== null && { pid: row.process_id }),
      ...(row.process_group_id !== null && { process_group_id: row.process_group_id }),
    };
  }

  setDeliveryAttemptProcess(
    room: string,
    deliveryIds: string[],
    process: DeliveryAttemptProcess | undefined,
  ): void {
    this.db.transaction(() => {
      const update = this.db.prepare(
        `UPDATE deliveries SET process_id = ?, process_group_id = ?
         WHERE room = ? AND id = ?`,
      );
      for (const deliveryId of deliveryIds) {
        const result = update.run(
          process?.pid ?? null,
          process?.process_group_id ?? null,
          room,
          deliveryId,
        );
        if (result.changes !== 1) throw new Error(`no such delivery: ${deliveryId}`);
      }
    })();
  }
  // harn:end attempt-start-evidence-persisted

  listDeliveries(
    room: string,
    filter: { recipient?: string; state?: Delivery['state'] } = {},
  ): Delivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE room = ?
           AND (? IS NULL OR recipient = ?)
           AND (? IS NULL OR state = ?)
         ORDER BY ts, id`,
      )
      .all(
        room,
        filter.recipient ?? null,
        filter.recipient ?? null,
        filter.state ?? null,
        filter.state ?? null,
      ) as DeliveryRow[];
    return rows.map(deliveryFromRow);
  }

  // harn:assume turn-start-transactional ref=atomic-turn-start
  /** Creates/reuses the run and binds the complete batch in one transaction. */
  beginTurn(
    room: string,
    opts: {
      memberId: string;
      deliveryIds: string[];
      startedTs: string;
      eventsRef: (messageId: number) => string;
      reuseRunMsgId?: number;
    },
  ): AtomicTurnStart {
    return this.db.transaction(() => {
      let runMessage: Message;
      if (opts.reuseRunMsgId !== undefined) {
        const existing = this.getMessage(room, opts.reuseRunMsgId);
        if (
          !existing?.run ||
          existing.kind !== 'run' ||
          existing.author !== opts.memberId ||
          existing.run.status !== 'running'
        ) {
          throw new Error(`run #${opts.reuseRunMsgId} is not reusable`);
        }
        runMessage = existing;
      } else {
        const posted = this.postMessage(room, { author: opts.memberId, kind: 'run', body: '' });
        runMessage = this.updateMessage(room, posted.id, {
          run: {
            status: 'running',
            started_ts: opts.startedTs,
            tool_calls: 0,
            events_ref: opts.eventsRef(posted.id),
          },
        });
      }

      const deliveries = opts.deliveryIds.map((deliveryId) => {
        const delivery = this.getDelivery(room, deliveryId);
        if (!delivery) throw new Error(`no such delivery: ${deliveryId}`);
        if (delivery.recipient !== opts.memberId) {
          throw new Error(`delivery ${deliveryId} does not belong to member ${opts.memberId}`);
        }
        const updated = this.updateDelivery(room, deliveryId, {
          state: 'delivering',
          attempt_count: delivery.attempt_count + 1,
          run_msg_id: runMessage.id,
          batch_id: `batch-${runMessage.id}`,
        });
        this.setDeliveryAttemptProcess(room, [deliveryId], undefined);
        return updated;
      });
      return { runMessage, deliveries };
    })();
  }
  // harn:end turn-start-transactional

  // harn:assume turn-finalization-transactional ref=atomic-turn-finalization
  /** Commits all durable effects of run completion together. */
  completeTurn(
    room: string,
    opts: {
      runMsgId: number;
      message: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run'>>;
      inputDeliveryIds: string[];
      memberId: string;
      memberPatch: Partial<Omit<Member, 'id' | 'kind'>>;
      meterDay: string;
      meterDelta: { turns?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number };
      fanout: FanoutDelivery[];
    },
  ): AtomicTurnCompletion {
    return this.db.transaction(() => {
      const message = this.updateMessage(room, opts.runMsgId, opts.message);
      for (const deliveryId of opts.inputDeliveryIds) {
        this.updateDelivery(room, deliveryId, { state: 'consumed' });
      }
      const member = this.updateMember(room, opts.memberId, opts.memberPatch);
      const meter = this.bumpMeter(room, opts.meterDay, opts.meterDelta);
      const deliveries = opts.fanout.map((delivery) =>
        this.createDelivery(room, {
          message_id: opts.runMsgId,
          recipient: delivery.recipient,
          state: delivery.state,
          payload_snapshot: delivery.payload_snapshot,
        }),
      );
      return { message, member, meter, deliveries };
    })();
  }
  // harn:end turn-finalization-transactional

  // ── pending interactions ──────────────────────────────────────────────

  upsertInteraction(interaction: PendingInteraction): PendingInteraction {
    return this.db.transaction(() => {
      const validated = PendingInteractionSchema.parse(interaction);
      this.db
        .prepare(
          `INSERT INTO pending_interactions (id, room, member_id, message_id, native_id,
             kind, targets, state, answer, answered_by, answered_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET native_id = excluded.native_id,
             state = excluded.state, answer = excluded.answer,
             answered_by = excluded.answered_by, answered_ts = excluded.answered_ts`,
        )
        .run(
          validated.id,
          validated.room,
          validated.member_id,
          validated.message_id,
          validated.native_id,
          validated.kind,
          JSON.stringify(validated.targets),
          validated.state,
          jsonOrNull(validated.answer),
          orNull(validated.answered_by),
          orNull(validated.answered_ts),
        );
      return validated;
    })();
  }

  getInteraction(id: string): PendingInteraction | undefined {
    const row = this.db
      .prepare('SELECT * FROM pending_interactions WHERE id = ?')
      .get(id) as InteractionRow | undefined;
    return row ? interactionFromRow(row) : undefined;
  }

  listInteractions(room: string, state?: PendingInteraction['state']): PendingInteraction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_interactions WHERE room = ?
           AND (? IS NULL OR state = ?) ORDER BY id`,
      )
      .all(room, state ?? null, state ?? null) as InteractionRow[];
    return rows.map(interactionFromRow);
  }

  // ── meters ────────────────────────────────────────────────────────────

  bumpMeter(
    room: string,
    day: string,
    delta: { turns?: number; cost_usd?: number; input_tokens?: number; output_tokens?: number },
  ): RoomMeter {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO meters (room, day, turns, cost_usd, input_tokens, output_tokens)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (room, day) DO UPDATE SET
             turns = turns + excluded.turns,
             cost_usd = cost_usd + excluded.cost_usd,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens`,
        )
        .run(
          room,
          day,
          delta.turns ?? 0,
          delta.cost_usd ?? 0,
          delta.input_tokens ?? 0,
          delta.output_tokens ?? 0,
        );
      this.appendChange(room, 'meter', day);
      const row = this.db
        .prepare('SELECT * FROM meters WHERE room = ? AND day = ?')
        .get(room, day) as MeterRow;
      return meterFromRow(row);
    })();
  }

  getMeter(room: string, day: string): RoomMeter | undefined {
    const row = this.db
      .prepare('SELECT * FROM meters WHERE room = ? AND day = ?')
      .get(room, day) as MeterRow | undefined;
    return row ? meterFromRow(row) : undefined;
  }

  // ── sync ──────────────────────────────────────────────────────────────

  currentSeq(room: string): number {
    const row = this.db.prepare('SELECT seq FROM rooms WHERE id = ?').get(room) as
      | { seq: number }
      | undefined;
    if (!row) throw new Error(`no such room: ${room}`);
    return row.seq;
  }

  getChangesSince(room: string, sinceSeq: number): ChangeLogEntry[] {
    const rows = this.db
      .prepare('SELECT room_id, seq, entity, entity_id FROM changes WHERE room_id = ? AND seq > ? ORDER BY seq')
      .all(room, sinceSeq) as { room_id: string; seq: number; entity: string; entity_id: string }[];
    return rows.map((row) =>
      ChangeLogEntrySchema.parse({
        room: row.room_id,
        seq: row.seq,
        entity: row.entity,
        entity_id: row.entity_id,
      }),
    );
  }

  /** Delta-sync: read the log since the cursor, hydrate changed rows. */
  sync(room: string, sinceSeq: number): SyncResult {
    const changes = this.getChangesSince(room, sinceSeq);
    const wanted = new Map<ChangeEntity, Set<string>>();
    for (const change of changes) {
      let ids = wanted.get(change.entity);
      if (!ids) wanted.set(change.entity, (ids = new Set()));
      ids.add(change.entity_id);
    }
    const roomRow = this.getRoom(room);
    if (!roomRow) throw new Error(`no such room: ${room}`);
    return {
      seq: this.currentSeq(room),
      room: roomRow,
      messages: [...(wanted.get('message') ?? [])]
        .map((id) => this.getMessage(room, Number(id)))
        .filter((m): m is Message => m !== undefined),
      members: [...(wanted.get('member') ?? [])]
        .map((id) => this.getMember(room, id))
        .filter((m): m is Member => m !== undefined),
      inbox: [...(wanted.get('inbox') ?? [])]
        .map((id) => this.getDelivery(room, id))
        .filter((d): d is Delivery => d !== undefined),
      meters: [...(wanted.get('meter') ?? [])]
        .map((day) => this.getMeter(room, day))
        .filter((m): m is RoomMeter => m !== undefined),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** Crockford-base32 ULID (timestamp + randomness), no external dep. */
  private newUlid(): string {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let ts = Date.now();
    let time = '';
    for (let i = 0; i < 10; i++) {
      time = ALPHABET[ts % 32] + time;
      ts = Math.floor(ts / 32);
    }
    let random = '';
    for (let i = 0; i < 16; i++) {
      random += ALPHABET[Math.floor(Math.random() * 32)];
    }
    return time + random;
  }
}
