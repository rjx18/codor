import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import {
  type AttachLease,
  AttachLeaseSchema,
  type BridgeOrigin,
  BridgeOriginSchema,
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

import { redactText } from './redact.js';

// harn:assume run-blobs-off-db ref=store-schema-no-blobs
// The DB persists pointers (RunSummary.events_ref) — never run event payloads.
// Run streams are JSONL blobs on disk, journaled by the daemon; the store has
// no table or column for them, which keeps the DB small and makes
// one-message-per-run structural.
// harn:assume attach-custody-lease-tracks-child-pid ref=attach-lease-store
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
  purpose TEXT,
  harness TEXT,
  session_ref TEXT,
  cwd TEXT,
  policy TEXT,
  host TEXT,
  state TEXT,
  custody TEXT,
  parent TEXT,
  role TEXT,
  conventions_sent INTEGER NOT NULL DEFAULT 0,
  misaddressed INTEGER NOT NULL DEFAULT 0,
  roster_stale INTEGER NOT NULL DEFAULT 1,
  removed_ts TEXT
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
  ack INTEGER NOT NULL DEFAULT 0,
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
  queue_seq INTEGER NOT NULL,    -- durable FIFO order; timestamps can tie
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
CREATE TABLE IF NOT EXISTS mirrored_turns (
  room TEXT NOT NULL REFERENCES rooms(id),
  member_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (room, member_id, native_turn_id)
);
CREATE TABLE IF NOT EXISTS attach_leases (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id),
  member_id TEXT NOT NULL UNIQUE,
  cli_pid INTEGER NOT NULL,
  child_pid INTEGER,
  process_group_id INTEGER,
  heartbeat_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  entity TEXT NOT NULL,        -- message|member|inbox|meter|room
  entity_id TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
`;
// harn:end attach-custody-lease-tracks-child-pid
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
  if (!columns.some((column) => column.name === 'queue_seq')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN queue_seq INTEGER');
  }
  db.exec('UPDATE deliveries SET queue_seq = rowid WHERE queue_seq IS NULL');
}
// harn:end delivery-payload-snapshotted

function migrateMemberCustody(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'custody')) {
    db.exec('ALTER TABLE members ADD COLUMN custody TEXT');
  }
}

// harn:assume roster-briefing-refreshes-on-membership ref=active-roster-storage
function migrateMemberLifecycle(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'purpose')) {
    db.exec('ALTER TABLE members ADD COLUMN purpose TEXT');
  }
  if (!columns.some((column) => column.name === 'roster_stale')) {
    db.exec('ALTER TABLE members ADD COLUMN roster_stale INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some((column) => column.name === 'removed_ts')) {
    db.exec('ALTER TABLE members ADD COLUMN removed_ts TEXT');
  }
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'members'",
  ).get() as { sql: string };
  if (/UNIQUE\s*\(\s*room\s*,\s*handle\s*\)/i.test(table.sql)) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE members RENAME TO members_with_global_handle_unique;
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL REFERENCES rooms(id),
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        purpose TEXT,
        harness TEXT,
        session_ref TEXT,
        cwd TEXT,
        policy TEXT,
        host TEXT,
        state TEXT,
        custody TEXT,
        parent TEXT,
        role TEXT,
        conventions_sent INTEGER NOT NULL DEFAULT 0,
        misaddressed INTEGER NOT NULL DEFAULT 0,
        roster_stale INTEGER NOT NULL DEFAULT 1,
        removed_ts TEXT
      );
      INSERT INTO members SELECT id, room, kind, handle, display_name, purpose, harness,
        session_ref, cwd, policy, host, state, custody, parent, role, conventions_sent,
        misaddressed, roster_stale, removed_ts
      FROM members_with_global_handle_unique;
      DROP TABLE members_with_global_handle_unique;
    `);
    db.pragma('foreign_keys = ON');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_active_handle_unique
    ON members (room, handle) WHERE removed_ts IS NULL
  `);
}
// harn:end roster-briefing-refreshes-on-membership

function migrateMessageAck(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'ack')) {
    db.exec('ALTER TABLE messages ADD COLUMN ack INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateDeliveryHopCount(db: Database.Database): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[];
  if (!columns.some((column) => column.name === 'hop_count')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN hop_count INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateMeterUncostedTokens(db: Database.Database): void {
  const columns = db.pragma('table_info(meters)') as { name: string }[];
  if (!columns.some((column) => column.name === 'uncosted_tokens')) {
    db.exec('ALTER TABLE meters ADD COLUMN uncosted_tokens INTEGER NOT NULL DEFAULT 0');
  }
}

// harn:assume bridge-enable-admin-or-owner ref=bridge-origin-uniqueness
function migrateBridgeOriginUniqueness(db: Database.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS message_bridge_origin_unique
    ON messages (
      author,
      json_extract(origin, '$.platform'),
      json_extract(origin, '$.external_id')
    )
    WHERE origin IS NOT NULL
  `);
}
// harn:end bridge-enable-admin-or-owner

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
  purpose: string | null;
  harness: string | null;
  session_ref: string | null;
  cwd: string | null;
  policy: string | null;
  host: string | null;
  state: string | null;
  custody: string | null;
  parent: string | null;
  role: string | null;
  conventions_sent: number;
  misaddressed: number;
  roster_stale: number;
  removed_ts: string | null;
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
  ack: number;
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
  hop_count: number;
  queue_seq: number;
  ts: string;
}

interface AttachLeaseRow {
  id: string;
  room: string;
  member_id: string;
  cli_pid: number;
  child_pid: number | null;
  process_group_id: number | null;
  heartbeat_ts: number;
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
  uncosted_tokens: number;
}

function memberFromRow(row: MemberRow): Member {
  return MemberSchema.parse({
    id: row.id,
    kind: row.kind,
    handle: row.handle,
    display_name: row.display_name,
    purpose: row.purpose ?? undefined,
    harness: row.harness ?? undefined,
    session_ref: row.session_ref ?? undefined,
    cwd: row.cwd ?? undefined,
    policy: row.policy ?? undefined,
    host: row.host ?? undefined,
    state: row.state ?? undefined,
    custody: row.custody ?? undefined,
    parent: row.parent ?? undefined,
    role: row.role ?? undefined,
    conventions_sent: toBool(row.conventions_sent),
    misaddressed: toBool(row.misaddressed),
    roster_stale: toBool(row.roster_stale),
    removed_ts: row.removed_ts ?? undefined,
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
    ack: toBool(row.ack) ? true : undefined,
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
    hop_count: row.hop_count,
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
  purpose?: string;
  harness?: string;
  session_ref?: string;
  cwd?: string;
  policy?: string;
  host?: string;
  state?: Member['state'];
  custody?: Member['custody'];
  parent?: string;
  role?: Member['role'];
  roster_stale?: boolean;
  removed_ts?: string;
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
  ack?: boolean;
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
  hop_count?: number;
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

export interface AtomicMirroredTurn {
  message: Message;
  deliveries: Delivery[];
  member?: Member;
  deduped: boolean;
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
    migrateMemberCustody(this.db);
    migrateMemberLifecycle(this.db);
    migrateMessageAck(this.db);
    migrateDeliveryHopCount(this.db);
    migrateMeterUncostedTokens(this.db);
    migrateBridgeOriginUniqueness(this.db);
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
        `INSERT INTO members (id, room, kind, handle, display_name, purpose, harness, session_ref,
           cwd, policy, host, state, custody, parent, role, conventions_sent, misaddressed,
           roster_stale, removed_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        room,
        validated.kind,
        validated.handle,
        validated.display_name,
        orNull(validated.purpose),
        orNull(validated.harness),
        orNull(validated.session_ref),
        orNull(validated.cwd),
        orNull(validated.policy),
        orNull(validated.host),
        orNull(validated.state),
        orNull(validated.custody),
        orNull(validated.parent),
        orNull(validated.role),
        fromBool(validated.conventions_sent),
        fromBool(validated.misaddressed),
        fromBool(validated.roster_stale),
        orNull(validated.removed_ts),
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
          `UPDATE members SET handle = ?, display_name = ?, purpose = ?, harness = ?, session_ref = ?,
             cwd = ?, policy = ?, host = ?, state = ?, custody = ?, parent = ?, role = ?,
             conventions_sent = ?, misaddressed = ?, roster_stale = ?, removed_ts = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.handle,
          merged.display_name,
          orNull(merged.purpose),
          orNull(merged.harness),
          orNull(merged.session_ref),
          orNull(merged.cwd),
          orNull(merged.policy),
          orNull(merged.host),
          orNull(merged.state),
          orNull(merged.custody),
          orNull(merged.parent),
          orNull(merged.role),
          fromBool(merged.conventions_sent),
          fromBool(merged.misaddressed),
          fromBool(merged.roster_stale),
          orNull(merged.removed_ts),
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
      .prepare('SELECT * FROM members WHERE room = ? AND handle = ? AND removed_ts IS NULL')
      .get(room, handle) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  findMemberBySessionRef(
    harness: string,
    sessionRef: string,
  ): { room: string; member: Member } | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM members WHERE harness = ? AND session_ref = ? AND removed_ts IS NULL ORDER BY room LIMIT 1',
      )
      .get(harness, sessionRef) as MemberRow | undefined;
    return row ? { room: row.room, member: memberFromRow(row) } : undefined;
  }

  getExtensionByNativeId(room: string, parentId: string, nativeId: string): Member | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM members
         WHERE room = ? AND kind = 'extension' AND parent = ? AND session_ref = ?
         ORDER BY id LIMIT 1`,
      )
      .get(room, parentId, nativeId) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  listMembers(room: string, options: { includeRemoved?: boolean } = {}): Member[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM members WHERE room = ?
         AND (? = 1 OR removed_ts IS NULL) ORDER BY id`,
      )
      .all(room, options.includeRemoved ? 1 : 0) as MemberRow[];
    return rows.map(memberFromRow);
  }

  markAgentRostersStale(room: string): void {
    this.db.prepare(
      `UPDATE members SET roster_stale = 1
       WHERE room = ? AND kind = 'agent' AND removed_ts IS NULL`,
    ).run(room);
  }

  clearAgentRosterStale(room: string, memberId: string): void {
    this.db.prepare(
      `UPDATE members SET roster_stale = 0
       WHERE room = ? AND id = ? AND kind = 'agent' AND removed_ts IS NULL`,
    ).run(room, memberId);
  }

  getMirroredMessageId(room: string, memberId: string, nativeTurnId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT message_id FROM mirrored_turns
         WHERE room = ? AND member_id = ? AND native_turn_id = ?`,
      )
      .get(room, memberId, nativeTurnId) as { message_id: number } | undefined;
    return row?.message_id;
  }

  recordMirroredTurn(
    room: string,
    memberId: string,
    nativeTurnId: string,
    messageId: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mirrored_turns (room, member_id, native_turn_id, message_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(room, memberId, nativeTurnId, messageId);
  }

  // harn:assume mirrored-turn-commit-transactional ref=atomic-mirrored-turn
  commitMirroredTurn(
    room: string,
    opts: {
      memberId: string;
      nativeTurnId: string;
      finalize(placeholder: Message): {
        message: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run'>>;
        fanout: FanoutDelivery[];
        markMisaddressed?: boolean;
      };
    },
  ): AtomicMirroredTurn {
    return this.db.transaction(() => {
      const existingId = this.getMirroredMessageId(room, opts.memberId, opts.nativeTurnId);
      if (existingId !== undefined) {
        const message = this.getMessage(room, existingId);
        if (!message) throw new Error(`mirrored turn points to missing message #${existingId}`);
        return { message, deliveries: [], deduped: true };
      }

      const placeholder = this.postMessage(room, {
        author: opts.memberId,
        kind: 'run',
        body: '',
      });
      const finalized = opts.finalize(placeholder);
      const message = this.updateMessage(room, placeholder.id, finalized.message);
      const member = finalized.markMisaddressed
        ? this.updateMember(room, opts.memberId, { misaddressed: true })
        : undefined;
      const deliveries = finalized.fanout.map((delivery) => this.createDelivery(room, {
        message_id: message.id,
        recipient: delivery.recipient,
        state: delivery.state,
        payload_snapshot: delivery.payload_snapshot,
        hop_count: delivery.hop_count,
      }));
      this.recordMirroredTurn(room, opts.memberId, opts.nativeTurnId, message.id);
      return { message, deliveries, member, deduped: false };
    })();
  }
  // harn:end mirrored-turn-commit-transactional

  createAttachLease(input: {
    room: string;
    member_id: string;
    cli_pid: number;
    heartbeat_ts: number;
  }): AttachLease {
    const lease = AttachLeaseSchema.parse({ id: this.newUlid(), ...input });
    this.db
      .prepare(
        `INSERT INTO attach_leases
           (id, room, member_id, cli_pid, child_pid, process_group_id, heartbeat_ts)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(lease.id, lease.room, lease.member_id, lease.cli_pid, lease.heartbeat_ts);
    return lease;
  }

  getAttachLease(id: string): AttachLease | undefined {
    const row = this.db.prepare('SELECT * FROM attach_leases WHERE id = ?').get(id) as
      | AttachLeaseRow
      | undefined;
    return row ? this.attachLeaseFromRow(row) : undefined;
  }

  getAttachLeaseForMember(memberId: string): AttachLease | undefined {
    const row = this.db.prepare('SELECT * FROM attach_leases WHERE member_id = ?').get(memberId) as
      | AttachLeaseRow
      | undefined;
    return row ? this.attachLeaseFromRow(row) : undefined;
  }

  listAttachLeases(): AttachLease[] {
    return (this.db.prepare('SELECT * FROM attach_leases ORDER BY id').all() as AttachLeaseRow[])
      .map((row) => this.attachLeaseFromRow(row));
  }

  setAttachLeaseChild(
    id: string,
    childPid: number,
    processGroupId: number,
    heartbeatTs: number,
  ): AttachLease {
    const result = this.db
      .prepare(
        `UPDATE attach_leases
         SET child_pid = ?, process_group_id = ?, heartbeat_ts = ?
         WHERE id = ?`,
      )
      .run(childPid, processGroupId, heartbeatTs, id);
    if (result.changes !== 1) throw new Error(`no such attach lease ${id}`);
    return this.getAttachLease(id)!;
  }

  heartbeatAttachLease(id: string, heartbeatTs: number): AttachLease {
    const result = this.db
      .prepare('UPDATE attach_leases SET heartbeat_ts = ? WHERE id = ?')
      .run(heartbeatTs, id);
    if (result.changes !== 1) throw new Error(`no such attach lease ${id}`);
    return this.getAttachLease(id)!;
  }

  deleteAttachLease(id: string): void {
    this.db.prepare('DELETE FROM attach_leases WHERE id = ?').run(id);
  }

  private attachLeaseFromRow(row: AttachLeaseRow): AttachLease {
    return AttachLeaseSchema.parse({
      id: row.id,
      room: row.room,
      member_id: row.member_id,
      cli_pid: row.cli_pid,
      child_pid: row.child_pid ?? undefined,
      process_group_id: row.process_group_id ?? undefined,
      heartbeat_ts: row.heartbeat_ts,
    });
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
        ack: message.ack,
        ts: new Date().toISOString(),
        seq,
      });
      this.db
        .prepare(
          `INSERT INTO messages (room, id, author, kind, body, mentions, refs, ledger_refs,
             reply_to, run, ask, origin, ack, ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fromBool(validated.ack === true),
          validated.ts,
          validated.seq,
        );
      return validated;
    })();
  }
  // harn:end message-id-txn-allocation

  postBridgeMessage(
    room: string,
    bridgeMemberId: string,
    body: string,
    origin: BridgeOrigin,
    parsed: Pick<Message, 'mentions' | 'refs' | 'ledger_refs'>,
  ): { message: Message; deduped: boolean } {
    const member = this.getMember(room, bridgeMemberId);
    if (member?.kind !== 'bridge') throw new Error(`no such bridge member: ${bridgeMemberId}`);
    const validOrigin = BridgeOriginSchema.parse(origin);
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM messages
         WHERE room = ? AND author = ?
           AND json_extract(origin, '$.platform') = ?
           AND json_extract(origin, '$.external_id') = ?
         LIMIT 1`,
      ).get(room, bridgeMemberId, validOrigin.platform, validOrigin.external_id) as MessageRow | undefined;
      if (existing) return { message: messageFromRow(existing), deduped: true };
      return {
        message: this.postMessage(room, {
          author: bridgeMemberId,
          kind: 'chat',
          body,
          ...parsed,
          origin: validOrigin,
        }),
        deduped: false,
      };
    })();
  }

  latestMessageId(room: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?',
    ).get(room) as { id: number };
    return row.id;
  }

  // harn:assume default-recipient-latest-substantive ref=substantive-default-recipient
  latestFinalizedAgentAuthor(room: string): string | undefined {
    const row = this.db.prepare(
      `SELECT messages.author
       FROM messages
       JOIN members ON members.room = messages.room AND members.id = messages.author
       WHERE messages.room = ?
         AND messages.kind = 'run'
         AND members.kind = 'agent'
         AND members.removed_ts IS NULL
         AND messages.ack = 0
         AND json_extract(messages.run, '$.status') <> 'running'
       ORDER BY messages.id DESC
       LIMIT 1`,
    ).get(room) as { author: string } | undefined;
    return row?.author;
  }
  // harn:end default-recipient-latest-substantive

  listMessagesAfter(room: string, after: number, limit = 100): Message[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).all(room, after, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }

  /**
   * In-place update of a message (run finalization: body becomes final_text,
   * mentions/refs re-parsed, run summary updated). Same id, new seq.
   */
  updateMessage(
    room: string,
    id: number,
    patch: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run' | 'ask' | 'ack'>>,
  ): Message {
    return this.db.transaction(() => {
      const existing = this.getMessage(room, id);
      if (!existing) throw new Error(`no such message: #${id}`);
      const seq = this.appendChange(room, 'message', String(id));
      const merged = MessageSchema.parse({ ...existing, ...patch, seq });
      this.db
        .prepare(
          `UPDATE messages SET body = ?, mentions = ?, refs = ?, ledger_refs = ?,
             run = ?, ask = ?, ack = ?, seq = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.body,
          JSON.stringify(merged.mentions),
          JSON.stringify(merged.refs),
          JSON.stringify(merged.ledger_refs),
          jsonOrNull(merged.run),
          jsonOrNull(merged.ask),
          fromBool(merged.ack === true),
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

  // harn:assume permalink-ids-stable ref=message-history-search
  listMessages(room: string, opts: { limit?: number; before?: number } = {}): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE room = ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(room, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 100) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  // harn:assume search-does-not-reveal-redacted-text ref=redacted-message-search-match
  searchMessages(room: string, query: string, opts: { limit?: number } = {}): Message[] {
    const limit = opts.limit ?? 50;
    if (this.getRoom(room)?.config.redaction_enabled !== false) {
      const needle = query.toLowerCase();
      const rows = this.db
        .prepare('SELECT * FROM messages WHERE room = ? ORDER BY id DESC')
        .all(room) as MessageRow[];
      return rows
        .map(messageFromRow)
        .filter((message) => redactText(message.body).toLowerCase().includes(needle))
        .slice(0, limit);
    }
    const literal = query.replace(/[\\%_]/g, '\\$&');
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE room = ? AND body LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(room, `%${literal}%`, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }
  // harn:end search-does-not-reveal-redacted-text
  // harn:end permalink-ids-stable

  // ── deliveries ────────────────────────────────────────────────────────

  createDelivery(
    room: string,
    delivery: {
      message_id: number;
      recipient: string;
      state?: Delivery['state'];
      payload_snapshot?: string;
      hop_count?: number;
    },
  ): Delivery {
    return this.db.transaction(() => {
      const nextQueueSeq = this.db
        .prepare('SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM deliveries WHERE room = ?')
        .get(room) as { seq: number };
      const validated = DeliverySchema.parse({
        id: randomUUID(),
        room,
        message_id: delivery.message_id,
        recipient: delivery.recipient,
        state: delivery.state ?? 'queued',
        hop_count: delivery.hop_count ?? 0,
        ts: new Date().toISOString(),
      });
      this.db
        .prepare(
          `INSERT INTO deliveries (id, room, message_id, recipient, state, attempt_count,
             batch_id, run_msg_id, read_ts, payload_snapshot, process_id, process_group_id,
             hop_count, queue_seq, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          validated.hop_count ?? 0,
          nextQueueSeq.seq,
          validated.ts,
        );
      // Human inbox records are client-visible; recipient kind decides.
      const recipient = this.getMember(room, validated.recipient);
      if (recipient?.kind === 'human' || validated.state === 'held') {
        this.appendChange(room, 'inbox', validated.id);
      }
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

  // harn:assume delivery-fifo-has-durable-sequence ref=delivery-queue-sequence
  listDeliveries(
    room: string,
    filter: { recipient?: string; state?: Delivery['state'] } = {},
  ): Delivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE room = ?
           AND (? IS NULL OR recipient = ?)
           AND (? IS NULL OR state = ?)
         ORDER BY queue_seq, id`,
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
  // harn:end delivery-fifo-has-durable-sequence

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
      message: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run' | 'ack'>>;
      inputDeliveryIds: string[];
      memberId: string;
      memberPatch: Partial<Omit<Member, 'id' | 'kind'>>;
      meterDay: string;
      meterDelta: {
        turns?: number;
        cost_usd?: number;
        input_tokens?: number;
        output_tokens?: number;
        uncosted_tokens?: number;
      };
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
          hop_count: delivery.hop_count,
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

  // harn:assume spend-meter-always-on ref=meter-cost-and-token-accounting
  bumpMeter(
    room: string,
    day: string,
    delta: {
      turns?: number;
      cost_usd?: number;
      input_tokens?: number;
      output_tokens?: number;
      uncosted_tokens?: number;
    },
  ): RoomMeter {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO meters
             (room, day, turns, cost_usd, input_tokens, output_tokens, uncosted_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (room, day) DO UPDATE SET
             turns = turns + excluded.turns,
             cost_usd = cost_usd + excluded.cost_usd,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             uncosted_tokens = uncosted_tokens + excluded.uncosted_tokens`,
        )
        .run(
          room,
          day,
          delta.turns ?? 0,
          delta.cost_usd ?? 0,
          delta.input_tokens ?? 0,
          delta.output_tokens ?? 0,
          delta.uncosted_tokens ?? 0,
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
  // harn:end spend-meter-always-on

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

  // harn:assume sync-cursor-commits-after-hydration ref=consistent-sync-snapshot
  /** Delta-sync: hydrate rows and its final cursor from one SQLite snapshot. */
  sync(room: string, sinceSeq: number): SyncResult {
    return this.db.transaction(() => {
      const seq = this.currentSeq(room);
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
        seq,
        room: roomRow,
        messages: [...(wanted.get('message') ?? [])]
          .map((id) => this.getMessage(room, Number(id)))
          .filter((message): message is Message => message !== undefined),
        members: [...(wanted.get('member') ?? [])]
          .map((id) => this.getMember(room, id))
          .filter((member): member is Member => member !== undefined),
        inbox: [...(wanted.get('inbox') ?? [])]
          .map((id) => this.getDelivery(room, id))
          .filter((delivery): delivery is Delivery => delivery !== undefined),
        meters: [...(wanted.get('meter') ?? [])]
          .map((day) => this.getMeter(room, day))
          .filter((meter): meter is RoomMeter => meter !== undefined),
      };
    })();
  }
  // harn:end sync-cursor-commits-after-hydration

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
