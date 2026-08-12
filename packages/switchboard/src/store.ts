import { createHash, randomUUID } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import Database from 'better-sqlite3';
import {
  type AgentPreset,
  type AgentPresetInput,
  AgentPresetInputSchema,
  AgentPresetSchema,
  type AcpLaunchConfig,
  type AcpUsageBaseline,
  type AgentTaskList,
  type AgentTaskUpdate,
  AgentTaskListSchema,
  type AttachLease,
  type Attachment,
  AttachLeaseSchema,
  type BridgeOrigin,
  BridgeOriginSchema,
  type ChangeEntity,
  type ChangeLogEntry,
  ChangeLogEntrySchema,
  type Delivery,
  DeliverySchema,
  type DefaultRoster,
  type DefaultRosterInput,
  DefaultRosterInputSchema,
  DefaultRosterSchema,
  type Member,
  MemberSchema,
  type Message,
  MessageSchema,
  type Schedule,
  ScheduleSchema,
  type ScheduledTarget,
  ScheduleStateSchema,
  type PendingInteraction,
  PendingInteractionSchema,
  type Room,
  type RoomConfig,
  RoomConfigSchema,
  RoomIdSchema,
  type RoomInboxItem,
  type RoomMeter,
  RoomMeterSchema,
  RoomSchema,
  type RoomSupport,
  RoomSupportSchema,
  type SessionLifecycleSupport,
  type RunSummary,
  RunSummarySchema,
  deriveRoomColor,
  type WorktreeAvailability,
  type WorktreeDiscoveryCandidate,
  type WorktreeLifecycle,
  type WorktreeSource,
  type RepositoryRecord,
  type RegisteredWorktree,
  type ScopedMemberTarget,
  type WorktreeRoutingCatalog,
  WorktreeRoutingCatalogSchema,
  WorktreeRoutingTargetSchema,
  WorktreeRoutingTombstoneSchema,
  WorktreeAliasSchema,
  worktreeSelectorFromBranch,
  RegisteredWorktreeSchema,
  RepositoryRecordSchema,
} from '@codor/protocol';

import { estimateCostUsd, priceForModel } from './pricing.js';
import { redactText } from './redact.js';
import {
  type CollaborationGroup,
  CollaborationGroupSchema,
  type CollaborationParticipant,
  CollaborationParticipantSchema,
  type CollaborationRound,
  type CollaborationRoundParticipantInput,
  type CollaborationRoundProjection,
  CollaborationRoundSchema,
  type CollaborationTerminalStatus,
} from './collaboration.js';

// harn:assume run-journals-own-evidence-across-output-messages ref=store-schema-no-blobs
// The DB persists pointers (RunSummary.events_ref) — never run event payloads.
// One lifecycle root points at the JSONL journal for all of its lightweight
// continuation rows; the store has no table or column for event payloads.
// harn:assume attach-custody-lease-tracks-child-pid ref=attach-lease-store
// harn:assume collaboration-groups-are-durable-state ref=collaboration-store-schema
// harn:assume substantive-output-messages-drive-unread ref=message-activity-storage
// harn:assume registered-worktree-identities-are-durable ref=worktree-store-schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  config TEXT NOT NULL,        -- RoomConfig JSON
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  common_path TEXT NOT NULL,
  primary_path TEXT NOT NULL,
  primary_git_admin_id TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  UNIQUE (room)
);
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  conversation_id TEXT,
  alias TEXT NOT NULL,
  path TEXT NOT NULL,
  git_admin_id TEXT NOT NULL,
  primary_checkout INTEGER NOT NULL DEFAULT 0 CHECK (primary_checkout IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('main', 'adopted', 'created')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'unregistered', 'removed')),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'missing', 'locked', 'prunable')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  head TEXT,
  branch TEXT,
  registered_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  unregistered_ts TEXT,
  removed_ts TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_active_alias_unique
  ON worktrees (repository_id, alias) WHERE lifecycle = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_active_admin_unique
  ON worktrees (repository_id, git_admin_id) WHERE lifecycle = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_active_path_unique
  ON worktrees (repository_id, path) WHERE lifecycle = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_active_primary_unique
  ON worktrees (repository_id) WHERE lifecycle = 'active' AND primary_checkout = 1;
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
  model TEXT,
  thinking TEXT,
  acp_launch TEXT,
  acp_provider TEXT,
  session_lifecycle TEXT,
  acp_usage_baseline TEXT,
  acp_usage_pending TEXT,
  credential_hash TEXT,
  host TEXT,
  state TEXT,
  custody TEXT,
  parent TEXT,
  role TEXT,
  conventions_sent INTEGER NOT NULL DEFAULT 0,
  misaddressed INTEGER NOT NULL DEFAULT 0,
  roster_stale INTEGER NOT NULL DEFAULT 1,
  removed_ts TEXT,
  tasks TEXT                    -- AgentTaskList JSON projection; NULL when empty
);
CREATE TABLE IF NOT EXISTS messages (
  room TEXT NOT NULL REFERENCES rooms(id),
  id INTEGER NOT NULL,
  author TEXT NOT NULL,
  author_worktree_id TEXT,
  author_conversation_id TEXT,
  author_alias TEXT,
  author_handle TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL,      -- MentionSpan[] JSON (member ids, never handles)
  refs TEXT NOT NULL,          -- number[] JSON
  ledger_refs TEXT NOT NULL,   -- string[] JSON
  reply_to INTEGER,
  run TEXT,                    -- RunSummary JSON: events_ref pointer only, no events
  -- harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-message-storage
  run_parent_id INTEGER,       -- lifecycle root for a permanent continuation row
  -- harn:end continuation-writer-follows-journaled-output-ownership
  ask TEXT,                    -- AskCard JSON
  origin TEXT,                 -- BridgeOrigin JSON
  attachments TEXT,            -- Attachment[] JSON (metadata; files live under the data dir)
  voice TEXT,                  -- VoiceNote JSON (bounded dictation metadata); NULL for typed messages
  ack INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  activity_seq INTEGER,
  PRIMARY KEY (room, id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id),
  message_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  target_worktree_id TEXT,
  target_conversation_id TEXT,
  target_alias TEXT,
  target_handle TEXT,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  run_msg_id INTEGER,
  read_ts TEXT,
  steered_ts TEXT,
  interaction_resolved_ts TEXT,
  payload_snapshot TEXT,        -- immutable routed prompt context; never run events
  process_id INTEGER,            -- bounded attempt evidence, never run event payloads
  process_group_id INTEGER,
  queue_seq INTEGER NOT NULL,    -- durable FIFO order; timestamps can tie
  group_id TEXT,
  group_round INTEGER,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_groups (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  root_message_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'completed', 'cancelled')),
  created_ts TEXT NOT NULL,
  completed_ts TEXT,
  UNIQUE (room, root_message_id),
  FOREIGN KEY (room, root_message_id) REFERENCES messages(room, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS collaboration_rounds (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  state TEXT NOT NULL CHECK (state IN ('collecting', 'released', 'closed')),
  created_ts TEXT NOT NULL,
  released_ts TEXT,
  PRIMARY KEY (group_id, round_number)
);
CREATE TABLE IF NOT EXISTS collaboration_participants (
  group_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  member_id TEXT NOT NULL REFERENCES members(id),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
  terminal_status TEXT CHECK (
    terminal_status IS NULL OR terminal_status IN ('completed', 'failed', 'interrupted', 'skipped')
  ),
  result_message_id INTEGER,
  completed_ts TEXT,
  PRIMARY KEY (group_id, round_number, member_id),
  UNIQUE (group_id, round_number, ordinal),
  FOREIGN KEY (group_id, round_number)
    REFERENCES collaboration_rounds(group_id, round_number) ON DELETE CASCADE
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
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
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
// harn:end registered-worktree-identities-are-durable
// harn:end substantive-output-messages-drive-unread
// harn:end collaboration-groups-are-durable-state
// harn:end attach-custody-lease-tracks-child-pid
// harn:end run-journals-own-evidence-across-output-messages

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
  // harn:assume collaboration-groups-are-durable-state ref=collaboration-store-migration
  if (!columns.some((column) => column.name === 'group_id')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN group_id TEXT');
  }
  if (!columns.some((column) => column.name === 'group_round')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN group_round INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS collaboration_groups_room_state
      ON collaboration_groups (room, state, created_ts);
    CREATE INDEX IF NOT EXISTS collaboration_rounds_state
      ON collaboration_rounds (group_id, state, round_number);
    CREATE INDEX IF NOT EXISTS collaboration_participants_terminal
      ON collaboration_participants (group_id, round_number, terminal_status, ordinal);
    CREATE INDEX IF NOT EXISTS delivery_group_round_lookup
      ON deliveries (room, group_id, group_round, state, queue_seq);
    CREATE UNIQUE INDEX IF NOT EXISTS delivery_group_round_recipient_unique
      ON deliveries (group_id, group_round, recipient)
      WHERE group_id IS NOT NULL;
  `);
  // harn:end collaboration-groups-are-durable-state
}
// harn:end delivery-payload-snapshotted

// harn:assume qualified-member-target-identity-is-durable ref=qualified-routing-store-query
/** Additive identity columns keep old messages and deliveries byte-compatible. */
function migrateQualifiedRouting(db: Database.Database): void {
  const messageColumns = db.pragma('table_info(messages)') as { name: string }[];
  for (const column of [
    'author_worktree_id', 'author_conversation_id', 'author_alias', 'author_handle',
  ]) {
    if (!messageColumns.some((candidate) => candidate.name === column)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
    }
  }
  const deliveryColumns = db.pragma('table_info(deliveries)') as { name: string }[];
  for (const column of [
    'target_worktree_id', 'target_conversation_id', 'target_alias', 'target_handle',
  ]) {
    if (!deliveryColumns.some((candidate) => candidate.name === column)) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS delivery_target_fifo
      ON deliveries (target_conversation_id, recipient, state, queue_seq, id);
    CREATE INDEX IF NOT EXISTS delivery_global_fifo
      ON deliveries (queue_seq, id);
  `);
}
// harn:end qualified-member-target-identity-is-durable

function migrateMemberCustody(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'custody')) {
    db.exec('ALTER TABLE members ADD COLUMN custody TEXT');
  }
}

// harn:assume durable-agent-runtime-configuration ref=durable-agent-runtime-storage
// An existing database has members whose model and thinking were only ever held in
// memory, and are already gone. Null is the honest value for them: it means the
// harness default, which is exactly what they have been silently getting.
function migrateMemberAgentConfig(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'model')) {
    db.exec('ALTER TABLE members ADD COLUMN model TEXT');
  }
  if (!columns.some((column) => column.name === 'thinking')) {
    db.exec('ALTER TABLE members ADD COLUMN thinking TEXT');
  }
  if (!columns.some((column) => column.name === 'acp_launch')) {
    db.exec('ALTER TABLE members ADD COLUMN acp_launch TEXT');
  }
  if (!columns.some((column) => column.name === 'session_lifecycle')) {
    db.exec('ALTER TABLE members ADD COLUMN session_lifecycle TEXT');
  }
  if (!columns.some((column) => column.name === 'acp_usage_baseline')) {
    db.exec('ALTER TABLE members ADD COLUMN acp_usage_baseline TEXT');
  }
  if (!columns.some((column) => column.name === 'acp_usage_pending')) {
    db.exec('ALTER TABLE members ADD COLUMN acp_usage_pending TEXT');
  }
}
// harn:end durable-agent-runtime-configuration

function migrateMemberLimits(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'limits')) {
    db.exec('ALTER TABLE members ADD COLUMN limits TEXT');
  }
}

// harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
function migrateMemberTasks(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'tasks')) {
    db.exec('ALTER TABLE members ADD COLUMN tasks TEXT');
  }
}
// harn:end member-task-projection-is-durable-and-session-scoped

function migrateMemberContextWindow(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'context_window')) {
    db.exec('ALTER TABLE members ADD COLUMN context_window INTEGER');
  }
}

// harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-storage
// Existing ACP members were launched from a custom acp_launch and carry no named
// provider; NULL is the honest value for them. New named members persist a safe public
// provider id here while their exact launch stays in the private acp_launch column.
function migrateMemberAcpProvider(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'acp_provider')) {
    db.exec('ALTER TABLE members ADD COLUMN acp_provider TEXT');
  }
}
// harn:end named-acp-provider-selection-resolves-to-private-structured-launch

// harn:assume agent-member-credentials-stay-secret ref=member-credential-storage
function migrateMemberCredential(db: Database.Database): void {
  const columns = db.pragma('table_info(members)') as { name: string }[];
  if (!columns.some((column) => column.name === 'credential_hash')) {
    db.exec('ALTER TABLE members ADD COLUMN credential_hash TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_credential_hash_unique
    ON members (credential_hash) WHERE credential_hash IS NOT NULL
  `);
}

function migrateScheduleStore(db: Database.Database): void {
  const columns = db.pragma('table_info(schedules)') as { name: string }[];
  if (columns.length > 0 && !columns.some((column) => column.name === 'origin_room')) {
    db.exec('ALTER TABLE schedules ADD COLUMN origin_room TEXT');
  }
  if (columns.length > 0 && !columns.some((column) => column.name === 'refs')) {
    db.exec('ALTER TABLE schedules ADD COLUMN refs TEXT');
  }
  if (columns.length > 0 && !columns.some((column) => column.name === 'ledger_refs')) {
    db.exec('ALTER TABLE schedules ADD COLUMN ledger_refs TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      origin_room TEXT,
      author_id TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      target_member_id TEXT NOT NULL,
      target_conversation_id TEXT NOT NULL,
      target_worktree_id TEXT,
      target_alias TEXT,
      target_handle TEXT NOT NULL,
      target_display_name TEXT,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL,
      refs TEXT,
      ledger_refs TEXT,
      due_ts TEXT NOT NULL,
      host_offset_minutes INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
      created_ts TEXT NOT NULL,
      updated_ts TEXT NOT NULL,
      claimed_ts TEXT,
      completed_ts TEXT,
      error TEXT,
      delivered_message_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (state, due_ts, id);
    CREATE INDEX IF NOT EXISTS schedules_room_state ON schedules (room, state, due_ts, id);
  `);
}
// harn:end agent-member-credentials-stay-secret

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

function migrateMessagePinned(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'pinned')) {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateMessageDeleted(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'deleted')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateMessageAttachments(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'attachments')) {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  }
}

// harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-message-storage
function migrateMessageVoice(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'voice')) {
    db.exec('ALTER TABLE messages ADD COLUMN voice TEXT');
  }
}
// harn:end voice-message-metadata-is-bounded-and-additive

  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-message-storage
function migrateMessageContinuations(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'run_parent_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN run_parent_id INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS message_run_continuations
    ON messages (room, run_parent_id, id) WHERE run_parent_id IS NOT NULL
  `);
}
  // harn:end continuation-writer-follows-journaled-output-ownership

// harn:assume substantive-output-messages-drive-unread ref=message-activity-storage
function migrateMessageActivity(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((column) => column.name === 'activity_seq')) {
    db.exec('ALTER TABLE messages ADD COLUMN activity_seq INTEGER');
  }
  db.exec(`
    UPDATE messages
    SET activity_seq = seq
    WHERE activity_seq IS NULL
      AND deleted = 0
      AND ack = 0
      AND (
        kind = 'chat'
        OR (
          kind = 'run'
          AND run IS NOT NULL
          AND json_extract(run, '$.status') <> 'running'
        )
      );
    CREATE INDEX IF NOT EXISTS message_unread_activity
      ON messages (room, activity_seq) WHERE activity_seq IS NOT NULL;
  `);
}
// harn:end substantive-output-messages-drive-unread

// harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-storage
function migrateRoomReadCursors(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_read_cursors (
      room TEXT NOT NULL REFERENCES rooms(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      read_seq INTEGER NOT NULL,
      updated_ts TEXT NOT NULL,
      PRIMARY KEY (room, member_id)
    );
    INSERT OR IGNORE INTO room_read_cursors (room, member_id, read_seq, updated_ts)
    SELECT members.room, members.id, rooms.seq, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM members
    JOIN rooms ON rooms.id = members.room
    WHERE members.kind = 'human';
  `);
}
// harn:end human-room-read-cursors-are-durable-and-monotonic

// harn:assume readable-branch-conversations-own-worktree-identity ref=readable-worktree-conversation-store
export function deterministicWorktreeConversationId(root: string, branch: string): string {
  const branchSlug = branch.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (branchSlug === '') throw new Error('worktree branch does not produce a readable conversation id');

  const readable = `${root}-${branchSlug}`;
  const lossless = branch === branchSlug;
  if (lossless && readable.length <= 63) return RoomIdSchema.parse(readable);

  const digest = createHash('sha256').update(root).update('\0').update(branch).digest('hex').slice(0, 8);
  const rootPart = root.slice(0, 20).replace(/-+$/g, '') || 'room';
  const branchBudget = 63 - rootPart.length - digest.length - 2;
  const branchPart = branchSlug.slice(0, Math.max(1, branchBudget)).replace(/-+$/g, '') || 'branch';
  return RoomIdSchema.parse(`${rootPart}-${branchPart}-${digest}`);
}

/**
 * Phase 1 rows predate conversation_id. Backfill them without using the normal
 * room-creation path: a child inherits only the root human and reserved system
 * identities through lookup, so no agent roster or transcript is copied.
 */
function appendMigrationChange(
  db: Database.Database,
  room: string,
  entity: ChangeEntity,
  entityId: string,
): number {
  const bumped = db.prepare('UPDATE rooms SET seq = seq + 1 WHERE id = ? RETURNING seq')
    .get(room) as { seq: number } | undefined;
  if (!bumped) throw new Error(`no such room: ${room}`);
  db.prepare('INSERT INTO changes (room_id, seq, entity, entity_id) VALUES (?, ?, ?, ?)')
    .run(room, bumped.seq, entity, entityId);
  return bumped.seq;
}

function migrateWorktreeConversations(db: Database.Database): void {
  const columns = db.pragma('table_info(worktrees)') as { name: string }[];
  if (!columns.some((column) => column.name === 'conversation_id')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN conversation_id TEXT');
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS worktrees_conversation_unique ON worktrees (conversation_id) WHERE conversation_id IS NOT NULL',
  );

  const now = new Date().toISOString();
  const migrate = db.transaction(() => {
    db.prepare(
      `UPDATE worktrees SET conversation_id = room
       WHERE primary_checkout = 1 AND (conversation_id IS NULL OR conversation_id = '')`,
    ).run();

    const rows = db.prepare(
      `SELECT id, room, alias, branch, conversation_id
       FROM worktrees WHERE primary_checkout = 0 ORDER BY id`,
    ).all() as { id: string; room: string; alias: string; branch: string | null; conversation_id: string | null }[];
    for (const row of rows) {
      if (row.branch === null || row.branch === '') continue;
      const conversationId = row.conversation_id && row.conversation_id !== ''
        ? row.conversation_id
        : deterministicWorktreeConversationId(row.room, row.branch);
      const child = db.prepare('SELECT id, seq FROM rooms WHERE id = ?').get(conversationId) as
        { id: string; seq: number } | undefined;
      if (child === undefined) {
        const root = db.prepare('SELECT name, created_ts, config FROM rooms WHERE id = ?').get(row.room) as
          { name: string; created_ts: string; config: string } | undefined;
        if (!root) throw new Error(`no root room for worktree ${row.id}`);
        db.prepare(
          'INSERT INTO rooms (id, name, created_ts, config, seq) VALUES (?, ?, ?, ?, 0)',
        ).run(conversationId, row.branch, now, root.config);
        appendMigrationChange(db, conversationId, 'room', conversationId);
        const inherited = db.prepare(
          `SELECT id, kind FROM members
           WHERE room = ? AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))
           ORDER BY id`,
        ).all(row.room) as { id: string; kind: string }[];
        const humanIds: string[] = [];
        for (const member of inherited) {
          appendMigrationChange(db, conversationId, 'member', member.id);
          if (member.kind === 'human') humanIds.push(member.id);
        }
        const currentSeq = (db.prepare('SELECT seq FROM rooms WHERE id = ?').get(conversationId) as { seq: number }).seq;
        for (const memberId of humanIds) {
          db.prepare(
            `INSERT OR IGNORE INTO room_read_cursors (room, member_id, read_seq, updated_ts)
             VALUES (?, ?, ?, ?)`,
          ).run(conversationId, memberId, currentSeq, now);
        }
      } else {
        const inheritedHumans = db.prepare(
          `SELECT id FROM members WHERE room = ? AND kind = 'human' ORDER BY id`,
        ).all(row.room) as { id: string }[];
        for (const member of inheritedHumans) {
          db.prepare(
            `INSERT OR IGNORE INTO room_read_cursors (room, member_id, read_seq, updated_ts)
             VALUES (?, ?, ?, ?)`,
          ).run(conversationId, member.id, child.seq, now);
        }
      }
      db.prepare('UPDATE worktrees SET conversation_id = ? WHERE id = ?')
        .run(conversationId, row.id);
    }
  });
  migrate();
}
// harn:end readable-branch-conversations-own-worktree-identity

// harn:assume existing-worktree-records-repair-locally-once ref=local-worktree-record-repair
function repairWorktreeConversationIds(
  db: Database.Database,
  roomDataRoots: readonly string[],
): void {
  const rows = db.prepare(
    `SELECT id, room, conversation_id, branch
     FROM worktrees
     WHERE primary_checkout = 0 AND branch IS NOT NULL AND branch != ''
     ORDER BY id`,
  ).all() as { id: string; room: string; conversation_id: string; branch: string }[];
  const repairs = rows
    .map((row) => ({ ...row, target: deterministicWorktreeConversationId(row.room, row.branch) }))
    .filter((row) => row.conversation_id !== row.target);
  if (repairs.length === 0) return;

  const moved: { from: string; to: string }[] = [];
  try {
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const repair of repairs) {
        const collision = db.prepare(
          'SELECT id FROM worktrees WHERE conversation_id = ? AND id != ?',
        ).get(repair.target, repair.id) as { id: string } | undefined;
        if (collision !== undefined || db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(repair.target) !== undefined) {
          throw new Error(`deterministic worktree conversation already exists: ${repair.target}`);
        }
        for (const root of roomDataRoots) {
          const from = join(root, repair.conversation_id);
          if (!existsSync(from)) continue;
          const to = join(root, repair.target);
          if (existsSync(to)) throw new Error(`worktree room data destination already exists: ${to}`);
          renameSync(from, to);
          moved.push({ from, to });
        }

        const prior = db.prepare('SELECT * FROM rooms WHERE id = ?').get(repair.conversation_id) as RoomRow | undefined;
        if (prior === undefined) throw new Error(`missing worktree conversation: ${repair.conversation_id}`);
        db.prepare('INSERT INTO rooms (id, name, created_ts, config, seq) VALUES (?, ?, ?, ?, ?)')
          .run(repair.target, repair.branch, prior.created_ts, prior.config, prior.seq);
        for (const table of ['members', 'messages', 'deliveries', 'collaboration_groups', 'pending_interactions', 'meters', 'mirrored_turns', 'attach_leases'] as const) {
          db.prepare(`UPDATE ${table} SET room = ? WHERE room = ?`).run(repair.target, repair.conversation_id);
        }
        db.prepare('UPDATE messages SET author_conversation_id = ? WHERE author_conversation_id = ?')
          .run(repair.target, repair.conversation_id);
        db.prepare('UPDATE deliveries SET target_conversation_id = ? WHERE target_conversation_id = ?')
          .run(repair.target, repair.conversation_id);
        db.prepare('UPDATE changes SET room_id = ? WHERE room_id = ?').run(repair.target, repair.conversation_id);
        db.prepare('UPDATE room_read_cursors SET room = ? WHERE room = ?').run(repair.target, repair.conversation_id);
        db.prepare('UPDATE worktrees SET conversation_id = ?, alias = ?, updated_ts = ? WHERE id = ?')
          .run(repair.target, worktreeSelectorFromBranch(repair.branch), new Date().toISOString(), repair.id);
        db.prepare('DELETE FROM rooms WHERE id = ?').run(repair.conversation_id);
      }
    })();
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (existsSync(entry.to) && !existsSync(entry.from)) renameSync(entry.to, entry.from);
    }
    throw error;
  }
}
// harn:end existing-worktree-records-repair-locally-once

// harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-migration
function migrateApprovalDeliveryResolution(db: Database.Database): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[];
  if (!columns.some((column) => column.name === 'interaction_resolved_ts')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN interaction_resolved_ts TEXT');
  }
  db.exec(`
    UPDATE deliveries
    SET interaction_resolved_ts = COALESCE(
          interaction_resolved_ts,
          (
            SELECT interaction.answered_ts
            FROM pending_interactions AS interaction
            WHERE interaction.room = deliveries.room
              AND interaction.message_id = deliveries.message_id
              AND interaction.kind = 'approval'
              AND interaction.state <> 'pending'
            LIMIT 1
          ),
          read_ts,
          ts
        ),
        read_ts = COALESCE(
          read_ts,
          (
            SELECT interaction.answered_ts
            FROM pending_interactions AS interaction
            WHERE interaction.room = deliveries.room
              AND interaction.message_id = deliveries.message_id
              AND interaction.kind = 'approval'
              AND interaction.state <> 'pending'
            LIMIT 1
          ),
          ts
        )
    WHERE (interaction_resolved_ts IS NULL OR read_ts IS NULL)
      AND EXISTS (
        SELECT 1
        FROM pending_interactions AS interaction
        JOIN members AS recipient
          ON recipient.room = interaction.room
         AND recipient.id = deliveries.recipient
         AND recipient.kind = 'human'
        WHERE interaction.room = deliveries.room
          AND interaction.message_id = deliveries.message_id
          AND interaction.kind = 'approval'
          AND interaction.state <> 'pending'
          AND EXISTS (
            SELECT 1 FROM json_each(interaction.targets) AS target
            WHERE target.value = deliveries.recipient
          )
      )
  `);
}
// harn:end approval-deliveries-project-resolution-separately

function migrateDeliveryHopCount(db: Database.Database): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[];
  if (!columns.some((column) => column.name === 'hop_count')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN hop_count INTEGER NOT NULL DEFAULT 0');
  }
}

// harn:assume agent-delivery-lifecycle-streams-v2 ref=steered-delivery-storage
function migrateDeliverySteering(db: Database.Database): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[];
  if (!columns.some((column) => column.name === 'steered_ts')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN steered_ts TEXT');
  }
}
// harn:end agent-delivery-lifecycle-streams-v2

function migrateMeterUncostedTokens(db: Database.Database): void {
  const columns = db.pragma('table_info(meters)') as { name: string }[];
  if (!columns.some((column) => column.name === 'uncosted_tokens')) {
    db.exec('ALTER TABLE meters ADD COLUMN uncosted_tokens INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateMeterEstimatedCost(db: Database.Database): void {
  const columns = db.pragma('table_info(meters)') as { name: string }[];
  if (!columns.some((column) => column.name === 'estimated_cost_usd')) {
    db.exec('ALTER TABLE meters ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0');
  }
}

const CODEX_REPRICING_MIGRATION = 'codex-usage-pricing-v1';
const LEGACY_CODEX_MODEL = 'gpt-5.6-sol';

interface LegacyCodexRunRow {
  room: string;
  id: number;
  author: string;
  run: string;
  ts: string;
  session_ref: string | null;
  member_model: string | null;
}

interface JournalModelEvidence {
  ts: string;
  model: string;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  return files;
}

function nativeCodexJournalModels(
  codexHome: string,
  sessionRefs: ReadonlySet<string>,
): Map<string, JournalModelEvidence[]> {
  if (sessionRefs.size === 0) return new Map();
  const paths = new Map<string, string>();
  for (const path of walkFiles(join(codexHome, 'sessions'))) {
    const name = basename(path, '.jsonl');
    for (const sessionRef of sessionRefs) {
      if (name === sessionRef || name.endsWith(`-${sessionRef}`)) paths.set(sessionRef, path);
    }
  }

  const evidence = new Map<string, JournalModelEvidence[]>();
  for (const [sessionRef, path] of paths) {
    const rows: JournalModelEvidence[] = [];
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as {
          timestamp?: unknown;
          type?: unknown;
          payload?: { model?: unknown };
        };
        if (
          entry.type === 'turn_context' &&
          typeof entry.timestamp === 'string' &&
          typeof entry.payload?.model === 'string' &&
          entry.payload.model !== ''
        ) {
          rows.push({ ts: entry.timestamp, model: entry.payload.model });
        }
      } catch {
        // A malformed native line is not model evidence; later durable fallbacks remain.
      }
    }
    rows.sort((left, right) => left.ts.localeCompare(right.ts));
    if (rows.length > 0) evidence.set(sessionRef, rows);
  }
  return evidence;
}

function journalModelAt(
  evidence: readonly JournalModelEvidence[] | undefined,
  startedTs: string,
): string | undefined {
  if (evidence === undefined) return undefined;
  let resolved: string | undefined;
  for (const row of evidence) {
    if (row.ts > startedTs) break;
    resolved = row.model;
  }
  return resolved;
}

function priceableModel(...models: Array<string | null | undefined>): string | undefined {
  return models.find((model): model is string => model !== null && priceForModel(model) !== undefined);
}

function runMeterDay(run: RunSummary, messageTs: string): string {
  return (run.ended_ts ?? messageTs).slice(0, 10);
}

// harn:assume legacy-codex-repricing-is-atomic-and-idempotent ref=legacy-codex-repricing-migration
function migrateLegacyCodexPricing(db: Database.Database, codexHome: string): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codor_migrations (
        id TEXT PRIMARY KEY,
        applied_ts TEXT NOT NULL
      )
    `);
    const applied = db.prepare('SELECT 1 FROM codor_migrations WHERE id = ?')
      .get(CODEX_REPRICING_MIGRATION);
    if (applied !== undefined) return;

    const rows = db.prepare(`
      SELECT message.room, message.id, message.author, message.run, message.ts,
             member.session_ref, member.model AS member_model
      FROM messages AS message
      JOIN members AS member
        ON member.room = message.room AND member.id = message.author
      WHERE message.kind = 'run'
        AND message.run IS NOT NULL
        AND member.harness = 'codex'
        AND json_extract(message.run, '$.status') <> 'running'
        AND json_extract(message.run, '$.usage') IS NOT NULL
        AND COALESCE(json_extract(message.run, '$.usage.input_tokens'), 0)
          + COALESCE(json_extract(message.run, '$.usage.output_tokens'), 0) > 0
        AND json_extract(message.run, '$.usage.cost_usd') IS NULL
        AND json_extract(message.run, '$.estimated_cost_usd') IS NULL
    `).all() as LegacyCodexRunRow[];

    const sessionRefs = new Set(rows.flatMap((row) => row.session_ref === null ? [] : [row.session_ref]));
    const journalModels = nativeCodexJournalModels(codexHome, sessionRefs);
    const affected = new Set<string>();
    const updateRun = db.prepare('UPDATE messages SET run = ? WHERE room = ? AND id = ?');
    for (const row of rows) {
      const run = RunSummarySchema.parse(JSON.parse(row.run));
      const model = priceableModel(
        run.model,
        row.session_ref === null
          ? undefined
          : journalModelAt(journalModels.get(row.session_ref), run.started_ts),
        row.member_model,
        LEGACY_CODEX_MODEL,
      );
      if (model === undefined || run.usage === undefined) {
        throw new Error(`legacy Codex run ${row.room}#${row.id} has no priceable model`);
      }
      // Legacy Usage predates cached_input_tokens, so all recorded input is
      // deliberately ordinary input under the approved migration contract.
      const estimatedCostUsd = estimateCostUsd(model, {
        input_tokens: run.usage.input_tokens,
        output_tokens: run.usage.output_tokens,
      });
      if (estimatedCostUsd === undefined) {
        throw new Error(`legacy Codex run ${row.room}#${row.id} cannot be priced`);
      }
      updateRun.run(JSON.stringify({
        ...run,
        model,
        estimated_cost_usd: estimatedCostUsd,
      }), row.room, row.id);
      affected.add(`${row.room}\u0000${runMeterDay(run, row.ts)}`);
    }

    const allRuns = db.prepare(`
      SELECT room, run, ts FROM messages
      WHERE kind = 'run' AND run IS NOT NULL
    `).all() as Array<{ room: string; run: string; ts: string }>;
    const totals = new Map<string, {
      turns: number;
      costUsd: number;
      estimatedCostUsd: number;
      inputTokens: number;
      outputTokens: number;
      uncostedTokens: number;
    }>();
    for (const row of allRuns) {
      const run = RunSummarySchema.parse(JSON.parse(row.run));
      if (run.status === 'running') continue;
      const key = `${row.room}\u0000${runMeterDay(run, row.ts)}`;
      if (!affected.has(key)) continue;
      const total = totals.get(key) ?? {
        turns: 0,
        costUsd: 0,
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        uncostedTokens: 0,
      };
      total.turns += 1;
      if (run.usage !== undefined) {
        total.inputTokens += run.usage.input_tokens;
        total.outputTokens += run.usage.output_tokens;
        if (run.usage.cost_usd !== undefined) total.costUsd += run.usage.cost_usd;
        else if (run.estimated_cost_usd !== undefined) {
          total.estimatedCostUsd += run.estimated_cost_usd;
        } else {
          total.uncostedTokens += run.usage.input_tokens + run.usage.output_tokens;
        }
      }
      totals.set(key, total);
    }

    const replaceMeter = db.prepare(`
      INSERT INTO meters
        (room, day, turns, cost_usd, estimated_cost_usd, input_tokens, output_tokens, uncosted_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room, day) DO UPDATE SET
        turns = excluded.turns,
        cost_usd = excluded.cost_usd,
        estimated_cost_usd = excluded.estimated_cost_usd,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        uncosted_tokens = excluded.uncosted_tokens
    `);
    for (const [key, total] of totals) {
      const separator = key.indexOf('\u0000');
      replaceMeter.run(
        key.slice(0, separator),
        key.slice(separator + 1),
        total.turns,
        total.costUsd,
        total.estimatedCostUsd,
        total.inputTokens,
        total.outputTokens,
        total.uncostedTokens,
      );
    }

    const remaining = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(json_extract(message.run, '$.usage.input_tokens'), 0)
        + COALESCE(json_extract(message.run, '$.usage.output_tokens'), 0)
      ), 0) AS tokens
      FROM messages AS message
      JOIN members AS member
        ON member.room = message.room AND member.id = message.author
      WHERE message.kind = 'run'
        AND message.run IS NOT NULL
        AND member.harness = 'codex'
        AND json_extract(message.run, '$.status') <> 'running'
        AND json_extract(message.run, '$.usage.cost_usd') IS NULL
        AND json_extract(message.run, '$.estimated_cost_usd') IS NULL
    `).get() as { tokens: number };
    if (remaining.tokens !== 0) {
      throw new Error(`legacy Codex pricing left ${remaining.tokens} unpriced tokens`);
    }
    db.prepare('INSERT INTO codor_migrations (id, applied_ts) VALUES (?, ?)')
      .run(CODEX_REPRICING_MIGRATION, new Date().toISOString());
  })();
}
// harn:end legacy-codex-repricing-is-atomic-and-idempotent

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

// harn:assume individual-agent-presets-are-versioned-local-state ref=individual-agent-preset-store-migration
/** Additive migration for switchboard-local preset and singleton roster state. */
function migrateAgentPresetStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_presets (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      label TEXT NOT NULL,
      handle TEXT NOT NULL,
      display_name TEXT,
      harness TEXT NOT NULL,
      model TEXT,
      thinking TEXT,
      policy TEXT,
      acp_provider TEXT,
      acp_launch TEXT,
      created_ts TEXT NOT NULL,
      updated_ts TEXT NOT NULL
    );
  `);
  // harn:assume default-roster-is-one-versioned-ordered-preset-reference-group ref=default-roster-store
  db.exec(`
    CREATE TABLE IF NOT EXISTS default_rosters (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      updated_ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS default_roster_items (
      roster_id TEXT NOT NULL REFERENCES default_rosters(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      preset_id TEXT NOT NULL REFERENCES agent_presets(id) ON DELETE RESTRICT,
      PRIMARY KEY (roster_id, ordinal),
      UNIQUE (roster_id, preset_id)
    );
    CREATE INDEX IF NOT EXISTS default_roster_items_preset
      ON default_roster_items (preset_id, roster_id);
  `);
  db.prepare(
    `INSERT OR IGNORE INTO default_rosters (id, schema_version, updated_ts)
     VALUES ('default', 1, ?)`,
  ).run(new Date().toISOString());
  // harn:end default-roster-is-one-versioned-ordered-preset-reference-group
}
// harn:end individual-agent-presets-are-versioned-local-state

const toBool = (n: number): boolean => n !== 0;
const fromBool = (b: boolean): number => (b ? 1 : 0);
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const jsonOrNull = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

const messageDrivesUnread = (message: Message): boolean =>
  message.deleted !== true
  && message.ack !== true
  && (
    message.kind === 'chat'
    || (message.kind === 'run' && message.run !== undefined && message.run.status !== 'running')
  );

type MessageActivityMode = 'auto' | 'defer' | 'force';

function nextActivitySeq(
  message: Message,
  mode: MessageActivityMode,
  seq: number,
  stored: number | null = null,
): number | null {
  if (message.deleted === true || message.ack === true || mode === 'defer') return null;
  if (mode === 'force') return seq;
  if (!messageDrivesUnread(message)) return null;
  return message.kind === 'chat' ? (stored ?? seq) : seq;
}

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
  model: string | null;
  thinking: string | null;
  acp_launch: string | null;
  // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-storage
  acp_provider: string | null;
  // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
  session_lifecycle: string | null;
  acp_usage_baseline: string | null;
  acp_usage_pending: string | null;
  host: string | null;
  state: string | null;
  custody: string | null;
  parent: string | null;
  role: string | null;
  conventions_sent: number;
  misaddressed: number;
  roster_stale: number;
  removed_ts: string | null;
  limits: string | null;
  tasks: string | null;
}

interface AgentPresetRow {
  id: string;
  schema_version: number;
  label: string;
  handle: string;
  display_name: string | null;
  harness: string;
  model: string | null;
  thinking: string | null;
  policy: string | null;
  acp_provider: string | null;
  acp_launch: string | null;
  created_ts: string;
  updated_ts: string;
}

interface DefaultRosterRow {
  id: string;
  schema_version: number;
  updated_ts: string;
}

interface MessageRow {
  room: string;
  id: number;
  author: string;
  author_worktree_id: string | null;
  author_conversation_id: string | null;
  author_alias: string | null;
  author_handle: string | null;
  kind: string;
  body: string;
  mentions: string;
  refs: string;
  ledger_refs: string;
  reply_to: number | null;
  run: string | null;
  run_parent_id: number | null;
  ask: string | null;
  origin: string | null;
  attachments: string | null;
  // harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-message-storage
  voice: string | null;
  // harn:end voice-message-metadata-is-bounded-and-additive
  ack: number;
  pinned: number;
  deleted: number;
  ts: string;
  seq: number;
  activity_seq: number | null;
}

interface DeliveryRow {
  id: string;
  room: string;
  message_id: number;
  recipient: string;
  target_worktree_id: string | null;
  target_conversation_id: string | null;
  target_alias: string | null;
  target_handle: string | null;
  state: string;
  attempt_count: number;
  batch_id: string | null;
  run_msg_id: number | null;
  read_ts: string | null;
  steered_ts: string | null;
  interaction_resolved_ts: string | null;
  payload_snapshot: string | null;
  process_id: number | null;
  process_group_id: number | null;
  hop_count: number;
  queue_seq: number;
  group_id: string | null;
  group_round: number | null;
  ts: string;
}

interface CollaborationGroupRow {
  id: string;
  room: string;
  root_message_id: number;
  state: string;
  created_ts: string;
  completed_ts: string | null;
}

interface CollaborationRoundRow {
  group_id: string;
  round_number: number;
  state: string;
  created_ts: string;
  released_ts: string | null;
}

interface CollaborationParticipantRow {
  group_id: string;
  round_number: number;
  ordinal: number;
  member_id: string;
  delivery_id: string;
  terminal_status: string | null;
  result_message_id: number | null;
  completed_ts: string | null;
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

interface RepositoryRow {
  id: string;
  room: string;
  common_path: string;
  primary_path: string;
  primary_git_admin_id: string;
  created_ts: string;
  updated_ts: string;
}

interface WorktreeRow {
  id: string;
  repository_id: string;
  room: string;
  conversation_id: string | null;
  alias: string;
  path: string;
  git_admin_id: string;
  primary_checkout: number;
  source: WorktreeSource;
  lifecycle: WorktreeLifecycle;
  availability: WorktreeAvailability;
  locked: number;
  head: string | null;
  branch: string | null;
  registered_ts: string;
  updated_ts: string;
  unregistered_ts: string | null;
  removed_ts: string | null;
}

interface MeterRow {
  room: string;
  day: string;
  turns: number;
  cost_usd: number;
  estimated_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  uncosted_tokens: number;
}

interface ScheduleRow {
  id: string;
  room: string;
  origin_room: string | null;
  author_id: string;
  author_handle: string;
  target_member_id: string;
  target_conversation_id: string;
  target_worktree_id: string | null;
  target_alias: string | null;
  target_handle: string;
  target_display_name: string | null;
  body: string;
  mentions: string;
  refs: string | null;
  ledger_refs: string | null;
  due_ts: string;
  host_offset_minutes: number;
  state: string;
  created_ts: string;
  updated_ts: string;
  claimed_ts: string | null;
  completed_ts: string | null;
  error: string | null;
  delivered_message_id: number | null;
}

function agentPresetFromRow(row: AgentPresetRow): AgentPreset {
  return AgentPresetSchema.parse({
    id: row.id,
    schema_version: row.schema_version,
    label: row.label,
    handle: row.handle,
    display_name: row.display_name ?? undefined,
    harness: row.harness,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    policy: row.policy ?? undefined,
    acp_provider: row.acp_provider ?? undefined,
    acp_launch: row.acp_launch === null ? undefined : JSON.parse(row.acp_launch),
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  });
}

function defaultRosterFromRows(
  roster: DefaultRosterRow,
  items: readonly { preset_id: string }[],
): DefaultRoster {
  return DefaultRosterSchema.parse({
    id: roster.id,
    schema_version: roster.schema_version,
    updated_ts: roster.updated_ts,
    preset_ids: items.map((item) => item.preset_id),
  });
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
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-storage
    acp_provider: row.acp_provider ?? undefined,
    // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
    host: row.host ?? undefined,
    state: row.state ?? undefined,
    custody: row.custody ?? undefined,
    parent: row.parent ?? undefined,
    role: row.role ?? undefined,
    conventions_sent: toBool(row.conventions_sent),
    misaddressed: toBool(row.misaddressed),
    roster_stale: toBool(row.roster_stale),
    removed_ts: row.removed_ts ?? undefined,
    limits: row.limits ? JSON.parse(row.limits) as unknown : undefined,
    // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
    tasks: row.tasks ? JSON.parse(row.tasks) as unknown : undefined,
    // harn:end member-task-projection-is-durable-and-session-scoped
  });
}

// harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
/** Materialize a validated replace/upsert update onto the prior list. Replace is a
 *  complete snapshot (empty clears); upsert updates known ids in place and appends a
 *  new id only from a complete (content+status) patch, never inventing content. An
 *  over-bound or malformed result rejects the whole update (prior list unchanged). */
function materializeTasks(prev: AgentTaskList | undefined, update: AgentTaskUpdate): AgentTaskList | undefined {
  if (update.op === 'replace') {
    if (update.items.length === 0) return undefined; // authoritative empty clears
    const parsed = AgentTaskListSchema.safeParse({
      items: update.items,
      ...(update.explanation !== undefined && { explanation: update.explanation }),
    });
    return parsed.success ? parsed.data : prev;
  }
  const items = (prev?.items ?? []).map((task) => ({ ...task }));
  const indexById = new Map(items.map((task, index) => [task.id, index]));
  for (const patch of update.items) {
    const at = indexById.get(patch.id);
    if (at !== undefined) {
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) if (key !== 'id') changed[key] = value;
      items[at] = { ...items[at]!, ...changed } as (typeof items)[number];
    } else if (patch.content !== undefined && patch.status !== undefined) {
      items.push({
        id: patch.id, content: patch.content, status: patch.status,
        ...(patch.active_form !== undefined && { active_form: patch.active_form }),
        ...(patch.priority !== undefined && { priority: patch.priority }),
      });
      indexById.set(patch.id, items.length - 1);
    }
    // else: unknown partial patch is ignored — it never invents a task
  }
  if (items.length === 0) return prev; // upsert never clears
  const parsed = AgentTaskListSchema.safeParse({
    items,
    ...(prev?.explanation !== undefined && { explanation: prev.explanation }),
  });
  return parsed.success ? parsed.data : prev;
}

const tasksEqual = (left: AgentTaskList | undefined, right: AgentTaskList | undefined): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
// harn:end member-task-projection-is-durable-and-session-scoped

function messageFromRow(row: MessageRow): Message {
  return MessageSchema.parse({
    id: row.id,
    room: row.room,
    author: row.author,
    // harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-message-storage
    ...(row.author_worktree_id !== null && row.author_conversation_id !== null &&
      row.author_alias !== null && row.author_handle !== null && {
        author_target: {
          worktree_id: row.author_worktree_id,
          conversation_id: row.author_conversation_id,
          alias: row.author_alias,
          handle: row.author_handle,
          member_id: row.author,
        },
      }),
    // harn:end cross-worktree-output-stays-in-origin
    kind: row.kind,
    body: row.body,
    mentions: JSON.parse(row.mentions),
    refs: JSON.parse(row.refs),
    ledger_refs: JSON.parse(row.ledger_refs),
    reply_to: row.reply_to ?? undefined,
    run: row.run ? JSON.parse(row.run) : undefined,
    run_parent_id: row.run_parent_id ?? undefined,
    ask: row.ask ? JSON.parse(row.ask) : undefined,
    origin: row.origin ? JSON.parse(row.origin) : undefined,
    ack: toBool(row.ack) ? true : undefined,
    pinned: toBool(row.pinned) ? true : undefined,
    deleted: toBool(row.deleted) ? true : undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    // harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-message-storage
    voice: row.voice ? JSON.parse(row.voice) : undefined,
    // harn:end voice-message-metadata-is-bounded-and-additive
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
    // harn:assume qualified-member-target-identity-is-durable ref=qualified-delivery-target-schema
    ...(row.target_worktree_id !== null && row.target_conversation_id !== null &&
      row.target_alias !== null && row.target_handle !== null && {
        target: {
          worktree_id: row.target_worktree_id,
          conversation_id: row.target_conversation_id,
          member_id: row.recipient,
          alias: row.target_alias,
          handle: row.target_handle,
        },
      }),
    // harn:end qualified-member-target-identity-is-durable
    state: row.state,
    hop_count: row.hop_count,
    attempt_count: row.attempt_count,
    batch_id: row.batch_id ?? undefined,
    run_msg_id: row.run_msg_id ?? undefined,
    read_ts: row.read_ts ?? undefined,
    steered_ts: row.steered_ts ?? undefined,
    interaction_resolved_ts: row.interaction_resolved_ts ?? undefined,
    group_id: row.group_id ?? undefined,
    group_round: row.group_round ?? undefined,
    ts: row.ts,
  });
}

function collaborationGroupFromRow(row: CollaborationGroupRow): CollaborationGroup {
  return CollaborationGroupSchema.parse({
    ...row,
    completed_ts: row.completed_ts ?? undefined,
  });
}

function collaborationRoundFromRow(row: CollaborationRoundRow): CollaborationRound {
  return CollaborationRoundSchema.parse({
    ...row,
    released_ts: row.released_ts ?? undefined,
  });
}

function collaborationParticipantFromRow(
  row: CollaborationParticipantRow,
): CollaborationParticipant {
  return CollaborationParticipantSchema.parse({
    ...row,
    terminal_status: row.terminal_status ?? undefined,
    result_message_id: row.result_message_id ?? undefined,
    completed_ts: row.completed_ts ?? undefined,
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

// harn:assume every-channel-has-a-visible-accent ref=channel-accent-persistence
function roomFromRow(row: RoomRow): Room {
  const config = JSON.parse(row.config) as Partial<RoomConfig>;
  return RoomSchema.parse({
    id: row.id,
    name: row.name,
    created_ts: row.created_ts,
    // Channels the CLI made (the boot-seeded unit among them) carry no colour.
    // Deriving on read gives every existing channel an accent without a migration.
    config: { ...config, color: config.color ?? deriveRoomColor(row.id) },
  });
}
// harn:end every-channel-has-a-visible-accent
// harn:assume scheduled-state-machine-recovers-from-one-next-due-alarm ref=durable-schedule-store

function scheduleFromRow(row: ScheduleRow): Schedule {
  return ScheduleSchema.parse({
    id: row.id,
    room: row.room,
    ...(row.origin_room !== null && { origin_room: row.origin_room }),
    author_id: row.author_id,
    author_handle: row.author_handle,
    target: {
      member_id: row.target_member_id,
      conversation_id: row.target_conversation_id,
      ...(row.target_worktree_id !== null && { worktree_id: row.target_worktree_id }),
      ...(row.target_alias !== null && { alias: row.target_alias }),
      handle: row.target_handle,
      ...(row.target_display_name !== null && { display_name: row.target_display_name }),
    },
    body: row.body,
    mentions: JSON.parse(row.mentions),
    ...(row.refs !== null && { refs: JSON.parse(row.refs) }),
    ...(row.ledger_refs !== null && { ledger_refs: JSON.parse(row.ledger_refs) }),
    due_ts: row.due_ts,
    host_offset_minutes: row.host_offset_minutes,
    state: ScheduleStateSchema.parse(row.state),
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
    ...(row.claimed_ts !== null && { claimed_ts: row.claimed_ts }),
    ...(row.completed_ts !== null && { completed_ts: row.completed_ts }),
    ...(row.error !== null && { error: row.error }),
    ...(row.delivered_message_id !== null && { delivered_message_id: row.delivered_message_id }),
  });
}
function repositoryFromRow(row: RepositoryRow): RepositoryRecord {
  return RepositoryRecordSchema.parse({
    id: row.id,
    room: row.room,
    common_path: row.common_path,
    primary_path: row.primary_path,
    primary_git_admin_id: row.primary_git_admin_id,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  });
}

function worktreeFromRow(row: WorktreeRow): RegisteredWorktree {
  if (row.conversation_id === null || row.conversation_id === '') {
    throw new Error(`worktree ${row.id} has no conversation mapping`);
  }
  return RegisteredWorktreeSchema.parse({
    id: row.id,
    repository_id: row.repository_id,
    room: row.room,
    conversation_id: row.conversation_id,
    alias: row.alias,
    path: row.path,
    git_admin_id: row.git_admin_id,
    primary: toBool(row.primary_checkout),
    source: row.source,
    lifecycle: row.lifecycle,
    availability: row.availability,
    locked: toBool(row.locked),
    head: row.head ?? undefined,
    branch: row.branch ?? undefined,
    registered_ts: row.registered_ts,
    updated_ts: row.updated_ts,
    unregistered_ts: row.unregistered_ts ?? undefined,
    removed_ts: row.removed_ts ?? undefined,
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
  model?: string;
  thinking?: Member['thinking'];
  // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-storage
  acp_provider?: string;
  // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
  host?: string;
  state?: Member['state'];
  custody?: Member['custody'];
  parent?: string;
  role?: Member['role'];
  roster_stale?: boolean;
  removed_ts?: string;
}

export interface AgentRuntimeConfig {
  acp_launch?: AcpLaunchConfig;
  lifecycle?: SessionLifecycleSupport;
  usage_baseline?: AcpUsageBaseline;
}

// harn:assume registered-worktree-identities-are-durable ref=worktree-store-lifecycle
/** A fresh Git observation contains no Codor identity and never becomes an
 * active row unless an explicit lifecycle method asks the store to register it. */
export interface WorktreeObservation {
  path: string;
  git_admin_id: string;
  primary: boolean;
  availability: WorktreeAvailability;
  locked: boolean;
  head?: string;
  branch?: string;
}

export interface RepositoryObservation {
  common_path: string;
  primary_path: string;
  primary_git_admin_id: string;
}
// harn:end registered-worktree-identities-are-durable

// harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-room-seed
/** A fully preflighted agent snapshot that may join the room transaction. */
export interface InitialAgent {
  member: NewMember;
  runtime?: AgentRuntimeConfig;
}
// harn:end default-roster-channel-members-are-detached-ordered-snapshots

export interface NewMessage {
  author: string;
  author_target?: ScopedMemberTarget;
  kind: Message['kind'];
  body: string;
  mentions?: Message['mentions'];
  refs?: number[];
  ledger_refs?: string[];
  reply_to?: number;
  run?: RunSummary;
  run_parent_id?: number;
  ask?: Message['ask'];
  origin?: Message['origin'];
  ack?: boolean;
  attachments?: Attachment[];
  voice?: Message['voice'];
}

export interface SyncResult {
  seq: number;
  room: Room;
  /** Earliest id of the CONTIGUOUS tail a bounded cold hydration served, with
   *  correctness outliers excluded. Absent on an unbounded replay. */
  history_floor?: number;
  messages: Message[];
  members: Member[];
  inbox: Delivery[];
  meters: RoomMeter[];
  schedules?: Schedule[];
  support?: RoomSupport;
}

export interface FanoutDelivery {
  recipient: string;
  target?: ScopedMemberTarget;
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
  outputMessages: Message[];
  member: Member;
  meter: RoomMeter;
  deliveries: Delivery[];
  collaboration?: CollaborationRoundProjection;
}

export interface TurnOutputPatch {
  id: number;
  body: string;
  mentions: Message['mentions'];
  refs: Message['refs'];
  ledger_refs: Message['ledger_refs'];
  ack?: boolean;
  substantive: boolean;
}

export interface AtomicMirroredTurn {
  message: Message;
  deliveries: Delivery[];
  member?: Member;
  collaboration?: CollaborationRoundProjection;
  deduped: boolean;
}

export interface RoutedMessagePlan {
  fanout: FanoutDelivery[];
  collaboration?: {
    groupId?: string;
    participants: CollaborationRoundParticipantInput[];
  };
  markMisaddressed?: boolean;
}

export interface NewSchedule {
  origin_room?: string;
  room: string;
  author_id: string;
  author_handle: string;
  target: ScheduledTarget;
  body: string;
  mentions: Message['mentions'];
  refs?: number[];
  ledger_refs?: string[];
  due_ts: string;
  host_offset_minutes: number;
  created_ts?: string;
}

export interface AtomicScheduledMessage {
  schedule: Schedule;
  message?: Message;
  deliveries: Delivery[];
  member?: Member;
  collaboration?: CollaborationRoundProjection;
}

export interface AtomicRoutedMessage {
  message: Message;
  deliveries: Delivery[];
  member?: Member;
  collaboration?: CollaborationRoundProjection;
}

export type CollaborationRoundRelease = {
  status: 'pending' | 'released' | 'closed' | 'already_released';
  deliveries: Delivery[];
  projection?: CollaborationRoundProjection;
};

export interface DeliveryAttemptProcess {
  pid?: number;
  process_group_id?: number;
}

export type LifecycleRetryRefusalReason =
  | 'attempt_ceiling'
  | 'deleted_trigger'
  | 'settled_collaboration';

export class AgentPresetNotFoundError extends Error {
  readonly code = 'agent_preset_not_found';

  constructor(readonly presetId: string) {
    super(`no such agent preset: ${presetId}`);
    this.name = 'AgentPresetNotFoundError';
  }
}

export class AgentPresetReferenceConflictError extends Error {
  readonly code = 'agent_preset_reference_conflict';

  constructor(readonly presetId: string) {
    super(`agent preset is referenced by the default roster: ${presetId}`);
    this.name = 'AgentPresetReferenceConflictError';
  }
}

/**
 * The room store: better-sqlite3, synchronous, one file per switchboard.
 * Every mutation of a client-visible entity appends to the change log inside
 * the same transaction — sync hydrates exclusively from that log.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(path: string, options: { codexHome?: string; roomDataRoots?: readonly string[] } = {}) {
    this.db = new Database(path);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(SCHEMA);
      migrateAgentPresetStore(this.db);
      migrateDeliveryPayloadSnapshot(this.db);
      migrateQualifiedRouting(this.db);
      migrateMemberCustody(this.db);
      migrateMemberLifecycle(this.db);
      // MUST run after migrateMemberLifecycle: on a legacy database that one REBUILDS the
      // members table from an explicit column list, which would silently drop these two
      // again — and then every insert would fail on a column that no longer exists.
      migrateMemberAgentConfig(this.db);
      migrateMemberLimits(this.db);
      migrateMemberTasks(this.db);
      migrateMemberContextWindow(this.db);
      migrateMemberAcpProvider(this.db);
      migrateMemberCredential(this.db);
      migrateScheduleStore(this.db);
      migrateMessageAck(this.db);
      migrateMessagePinned(this.db);
      migrateMessageDeleted(this.db);
      migrateMessageAttachments(this.db);
      migrateMessageVoice(this.db);
      migrateMessageContinuations(this.db);
      migrateMessageActivity(this.db);
      migrateRoomReadCursors(this.db);
      migrateWorktreeConversations(this.db);
      repairWorktreeConversationIds(this.db, options.roomDataRoots ?? []);
      migrateApprovalDeliveryResolution(this.db);
      migrateDeliveryHopCount(this.db);
      migrateDeliverySteering(this.db);
      migrateMeterUncostedTokens(this.db);
      migrateMeterEstimatedCost(this.db);
      migrateBridgeOriginUniqueness(this.db);
      migrateLegacyCodexPricing(
        this.db,
        options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      );
      this.reconcileWorktreeChildMetadata();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // harn:assume readable-branch-conversations-own-worktree-identity ref=readable-worktree-conversation-store
  /** Idempotent open-time reconciliation for children materialized before the
   * canonical projection existed (root config copied verbatim, root cwd, or a
   * leaked starting agent handle). One ordinary child room change is appended
   * only when the visible name/config actually drifts; root rows are read,
   * never written, and root ids/history are untouched. */
  private reconcileWorktreeChildMetadata(): void {
    // Active AND tombstoned mapped children: a durable conversation keeps its
    // truthful metadata through unregister/removal as well.
    const rows = this.db.prepare(
      `SELECT room, branch, path, conversation_id
       FROM worktrees
       WHERE primary_checkout = 0
         AND conversation_id IS NOT NULL AND conversation_id != ''`,
    ).all() as { room: string; branch: string | null; path: string; conversation_id: string }[];
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) {
        if (row.branch === null || row.branch === '') continue;
        const childRow = this.db.prepare('SELECT * FROM rooms WHERE id = ?')
          .get(row.conversation_id) as RoomRow | undefined;
        if (childRow === undefined) continue;
        const currentConfig = RoomConfigSchema.parse(JSON.parse(childRow.config) as unknown);
        const patch = this.childMetadataPatch(
          { name: childRow.name, config: currentConfig },
          row.branch,
          row.path,
        );
        if (patch === undefined) continue;
        this.db.prepare('UPDATE rooms SET name = ?, config = ? WHERE id = ?')
          .run(patch.name, JSON.stringify(patch.config), row.conversation_id);
        this.appendChange(row.conversation_id, 'room', row.conversation_id);
      }
    })();
  }
  // harn:end readable-branch-conversations-own-worktree-identity

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
   * The internal bootstrap option may add one attributed welcome in the same
   * transaction; ordinary room creation does not use it.
   */
  // harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-welcome-transaction
  createRoom(opts: {
    id: string;
    name: string;
    owner: { handle: string; display_name: string };
    config?: Partial<RoomConfig>;
    // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-room-seed
    /** Concrete, already validated agents, inserted in this exact order. */
    initialAgents?: readonly InitialAgent[];
    // harn:end default-roster-channel-members-are-detached-ordered-snapshots
    bootstrapWelcome?: {
      author: { handle: string; display_name: string };
      body: string;
    };
  }): { room: Room; owner: Member; system: Member; initialAgents: Member[] } {
    const config = RoomConfigSchema.parse({
      ...opts.config,
      color: opts.config?.color ?? deriveRoomColor(opts.id),
    });
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
      // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-room-seed
      // These rows are deliberately dead until the daemon has activated each
      // independent runtime. A failed external spawn therefore cannot undo the
      // room transaction or erase a durable member identity.
      const initialAgents = this.insertInitialAgentMembers(opts.id, opts.initialAgents ?? []);
      // harn:end default-roster-channel-members-are-detached-ordered-snapshots
      if (opts.bootstrapWelcome !== undefined) {
        const tutorial = this.insertMember(opts.id, {
          kind: 'system',
          handle: opts.bootstrapWelcome.author.handle,
          display_name: opts.bootstrapWelcome.author.display_name,
        });
        this.postMessage(opts.id, {
          author: tutorial.id,
          kind: 'chat',
          body: opts.bootstrapWelcome.body,
        });
      }
      return { owner, system, initialAgents };
    })();
    return { room: this.getRoom(opts.id)!, ...result };
  }
  // harn:end empty-database-desk-seeds-tutorial-atomically
  // harn:end owner-and-system-members-seeded

  getRoom(id: string): Room | undefined {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row ? roomFromRow(row) : undefined;
  }

  listRooms(): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY id').all() as RoomRow[];
    return rows.map(roomFromRow);
  }

  // harn:assume main-and-direct-conversations-stay-compatible ref=conversation-root-query
  /** All rooms remain available to daemon recovery; only this projection hides children. */
  listPublicRooms(): Room[] {
    const rows = this.db.prepare(
      `SELECT rooms.* FROM rooms
       WHERE NOT EXISTS (
         SELECT 1 FROM worktrees
         WHERE worktrees.conversation_id = rooms.id
           AND worktrees.primary_checkout = 0
       )
       ORDER BY rooms.id`,
    ).all() as RoomRow[];
    return rows.map(roomFromRow);
  }

  isChildRoom(room: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS child FROM worktrees
       WHERE conversation_id = ? AND primary_checkout = 0 LIMIT 1`,
    ).get(room) as { child: number } | undefined;
    return row !== undefined;
  }

  rootRoomId(room: string): string | undefined {
    const row = this.db.prepare(
      `SELECT room FROM worktrees
       WHERE conversation_id = ? AND primary_checkout = 0
       ORDER BY lifecycle = 'active' DESC, updated_ts DESC LIMIT 1`,
    ).get(room) as { room: string } | undefined;
    return row?.room;
  }

  private childRoomIds(root: string): string[] {
    const rows = this.db.prepare(
      `SELECT conversation_id FROM worktrees
       WHERE room = ? AND primary_checkout = 0 AND conversation_id IS NOT NULL
       ORDER BY conversation_id`,
    ).all(root) as { conversation_id: string }[];
    return rows.map((row) => row.conversation_id);
  }
  // harn:end main-and-direct-conversations-stay-compatible

  // harn:assume readable-branch-conversations-own-worktree-identity ref=readable-worktree-conversation-store
  /** One detached snapshot member insertion shared by channel creation and
   * child registration: the private runtime columns travel with the row and no
   * preset or roster reference is ever persisted. */
  private insertInitialAgentMembers(
    room: string,
    initialAgents: readonly InitialAgent[],
  ): Member[] {
    return initialAgents.map(({ member, runtime }) => {
      const inserted = this.insertMember(room, member);
      if (
        runtime?.acp_launch !== undefined ||
        runtime?.lifecycle !== undefined ||
        runtime?.usage_baseline !== undefined
      ) {
        this.db.prepare(
          `UPDATE members
           SET acp_launch = ?, session_lifecycle = ?, acp_usage_baseline = ?
           WHERE room = ? AND id = ?`,
        ).run(
          runtime.acp_launch === undefined ? null : JSON.stringify(runtime.acp_launch),
          runtime.lifecycle === undefined ? null : JSON.stringify(runtime.lifecycle),
          runtime.usage_baseline === undefined ? null : JSON.stringify(runtime.usage_baseline),
          room,
          inserted.id,
        );
      }
      return inserted;
    });
  }

  /** A NEW child inherits the root configuration exactly once: its canonical
   * registered path is the cwd, and a root-only starting agent handle never
   * leaks across. After creation the child's configuration is room-local
   * state that only the narrow patch below may touch. */
  private childRoomProjection(branch: string, rootConfig: RoomConfig, canonicalPath: string): {
    name: string;
    config: RoomConfig;
  } {
    const { starting_agent_handle: _rootStartingHandle, ...inherited } = rootConfig;
    return {
      name: branch,
      config: RoomConfigSchema.parse({ ...inherited, cwd: canonicalPath }),
    };
  }

  /** The ONLY reconciliation an existing child may receive: its display name
   * follows the alias, its cwd follows the canonical registered path, and a
   * stale root-only starting handle is cleared. Brakes, stall interval,
   * redaction, color, bridged state, and every other room-local field are
   * preserved byte-for-byte. Returns undefined when nothing visibly drifts. */
  private childMetadataPatch(
    existing: { name: string; config: RoomConfig },
    branch: string,
    canonicalPath: string,
    options: { reconcileConfig: boolean } = { reconcileConfig: true },
  ): { name: string; config: RoomConfig } | undefined {
    const name = branch;
    // An alias edit reconciles the display name ONLY; migration/re-adoption
    // additionally patch exactly the canonical cwd and a stale root-only
    // starting handle, preserving every other room-local field byte-for-byte.
    const config = options.reconcileConfig
      ? RoomConfigSchema.parse((() => {
          const { starting_agent_handle: _stale, ...preserved } = existing.config;
          return { ...preserved, cwd: canonicalPath };
        })())
      : existing.config;
    if (existing.name === name && JSON.stringify(existing.config) === JSON.stringify(config)) {
      return undefined;
    }
    return { name, config };
  }
  // harn:end readable-branch-conversations-own-worktree-identity

  private ensureChildConversation(
    root: string,
    conversationId: string,
    branch: string,
    canonicalPath: string,
    now: string,
  ): void {
    const rootRoom = this.getRoom(root);
    if (rootRoom === undefined) throw new Error(`no root room: ${root}`);
    const existing = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(conversationId) as
      RoomRow | undefined;
    if (existing !== undefined) {
      // Explicit re-adoption patches ONLY the name, canonical cwd, and a stale
      // root starting handle; every other child-local field is preserved, and
      // one ordinary room change lands only on visible drift.
      const currentConfig = RoomConfigSchema.parse(JSON.parse(existing.config) as unknown);
      const patch = this.childMetadataPatch(
        { name: existing.name, config: currentConfig },
        branch,
        canonicalPath,
      );
      if (patch !== undefined) {
        this.db.prepare('UPDATE rooms SET name = ?, config = ? WHERE id = ?')
          .run(patch.name, JSON.stringify(patch.config), conversationId);
        this.appendChange(conversationId, 'room', conversationId);
      }
      for (const member of this.db.prepare(
        `SELECT id FROM members WHERE room = ? AND kind = 'human' ORDER BY id`,
      ).all(root) as { id: string }[]) {
        this.db.prepare(
          `INSERT OR IGNORE INTO room_read_cursors (room, member_id, read_seq, updated_ts)
           VALUES (?, ?, ?, ?)`,
        ).run(conversationId, member.id, existing.seq, now);
      }
      return;
    }
    const projection = this.childRoomProjection(branch, rootRoom.config, canonicalPath);
    this.db.prepare(
      'INSERT INTO rooms (id, name, created_ts, config, seq) VALUES (?, ?, ?, ?, 0)',
    ).run(conversationId, projection.name, now, JSON.stringify(projection.config));
    this.appendChange(conversationId, 'room', conversationId);
    const inherited = this.db.prepare(
      `SELECT id, kind FROM members
       WHERE room = ? AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))
       ORDER BY id`,
    ).all(root) as { id: string; kind: string }[];
    const humanIds: string[] = [];
    for (const member of inherited) {
      this.appendChange(conversationId, 'member', member.id);
      if (member.kind === 'human') humanIds.push(member.id);
    }
    const currentSeq = this.currentSeq(conversationId);
    for (const memberId of humanIds) {
      this.db.prepare(
        `INSERT INTO room_read_cursors (room, member_id, read_seq, updated_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room, member_id) DO NOTHING`,
      ).run(conversationId, memberId, currentSeq, now);
    }
  }

  private appendInheritedMemberChanges(root: string, memberId: string): void {
    for (const child of this.childRoomIds(root)) {
      this.appendChange(child, 'member', memberId);
    }
  }
  // harn:end registered-worktrees-materialize-stable-conversations

  /** Return the room's repository projection without creating one as a side effect. */
  getRepository(room: string): RepositoryRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE room = ? ORDER BY id LIMIT 1')
      .get(room) as RepositoryRow | undefined;
    return row === undefined ? undefined : repositoryFromRow(row);
  }

  getRepositoryByCommonPath(room: string, commonPath: string): RepositoryRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE room = ? AND common_path = ?')
      .get(room, commonPath) as RepositoryRow | undefined;
    return row === undefined ? undefined : repositoryFromRow(row);
  }

  getWorktree(room: string, worktreeId: string): RegisteredWorktree | undefined {
    const row = this.db
      .prepare('SELECT * FROM worktrees WHERE room = ? AND id = ?')
      .get(room, worktreeId) as WorktreeRow | undefined;
    return row === undefined ? undefined : worktreeFromRow(row);
  }

  getWorktreeByConversation(room: string, conversationId: string): RegisteredWorktree | undefined {
    const row = this.db.prepare(
      `SELECT * FROM worktrees
       WHERE room = ? AND conversation_id = ?
       ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, updated_ts DESC
       LIMIT 1`,
    ).get(room, conversationId) as WorktreeRow | undefined;
    return row === undefined ? undefined : worktreeFromRow(row);
  }
  // harn:assume qualified-member-target-identity-is-durable ref=qualified-routing-store-query
  /** Read-only, path-free projection for qualified routing and completion. */
  routingCatalog(room: string): WorktreeRoutingCatalog {
    const root = this.rootRoomId(room) ?? room;
    const registered = this.listWorktrees(root, { includeTombstones: true });
    const targets = registered
      .filter((worktree) => worktree.lifecycle === 'active' && worktree.conversation_id !== undefined)
      .map((worktree) => WorktreeRoutingTargetSchema.parse({
        worktree_id: worktree.id,
        conversation_id: worktree.conversation_id,
        alias: worktree.alias,
        primary: worktree.primary,
        lifecycle: 'active',
        members: this.listMembers(worktree.conversation_id)
          .filter((member) =>
            member.removed_ts === undefined && (member.kind === 'human' || member.kind === 'agent'))
          .map((member) => ({
            member_id: member.id,
            handle: member.handle,
            kind: member.kind,
            display_name: member.display_name,
            ...(member.purpose !== undefined && { purpose: member.purpose }),
          })),
        removed_members: this.listMembers(worktree.conversation_id, { includeRemoved: true })
          .filter((member) =>
            member.removed_ts !== undefined && (member.kind === 'human' || member.kind === 'agent'))
          .map((member) => ({
            member_id: member.id,
            handle: member.handle,
            kind: member.kind,
          }))
          .sort((left, right) => left.member_id.localeCompare(right.member_id))
          .slice(0, 256),
      }));
    const tombstones = registered
      .filter((worktree) => worktree.lifecycle !== 'active' && worktree.conversation_id !== undefined)
      .map((worktree) => WorktreeRoutingTombstoneSchema.parse({
        worktree_id: worktree.id,
        conversation_id: worktree.conversation_id,
        alias: worktree.alias,
        lifecycle: worktree.lifecycle,
      }));
    return WorktreeRoutingCatalogSchema.parse({ room: root, targets, tombstones });
  }

  private routingTargetRecord(target: ScopedMemberTarget, originRoom: string): {
    root: string;
    worktree: RegisteredWorktree;
    member: Member;
  } | undefined {
    const root = this.rootRoomId(target.conversation_id) ?? target.conversation_id;
    const originRoot = this.rootRoomId(originRoom) ?? originRoom;
    const originRepository = this.getRepository(originRoot);
    const targetRepository = this.getRepository(root);
    if (
      originRepository === undefined
      || targetRepository === undefined
      || originRepository.id !== targetRepository.id
    ) return undefined;
    const worktree = this.getWorktreeByConversation(root, target.conversation_id);
    if (
      worktree === undefined
      || worktree.id !== target.worktree_id
      || worktree.room !== root
      || worktree.repository_id !== targetRepository.id
      || worktree.conversation_id !== target.conversation_id
    ) return undefined;
    const member = this.getMember(target.conversation_id, target.member_id);
    if (
      member === undefined
      || member.handle !== target.handle
      || (member.kind !== 'human' && member.kind !== 'agent')
    ) return undefined;
    return { root, worktree, member };
  }

  /** Re-check a persisted qualified target immediately before execution. The
   * origin room is explicit and required: a target may only ever be validated
   * against the repository of the conversation the work came from, never
   * against itself. */
  routingTargetIsActive(target: ScopedMemberTarget, originRoom: string): boolean {
    const located = this.routingTargetRecord(target, originRoom);
    return located !== undefined
      && located.worktree.lifecycle === 'active'
      && (located.worktree.availability === 'available' || located.worktree.availability === 'locked')
      && located.member.removed_ts === undefined;
  }

  // harn:end qualified-member-target-identity-is-durable

  getWorktreeByGitAdmin(
    room: string,
    gitAdminId: string,
    options: { includeTombstones?: boolean } = {},
  ): RegisteredWorktree | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM worktrees
         WHERE room = ? AND git_admin_id = ?
           AND (? = 1 OR lifecycle = 'active')
         ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, updated_ts DESC
         LIMIT 1`,
      )
      .get(room, gitAdminId, options.includeTombstones ? 1 : 0) as WorktreeRow | undefined;
    return row === undefined ? undefined : worktreeFromRow(row);
  }

  listWorktrees(
    room: string,
    options: { includeTombstones?: boolean; repositoryId?: string } = {},
  ): RegisteredWorktree[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worktrees
         WHERE room = ?
           AND (? IS NULL OR repository_id = ?)
           AND (? = 1 OR lifecycle = 'active')
         ORDER BY primary_checkout DESC, alias, id`,
      )
      .all(
        room,
        options.repositoryId ?? null,
        options.repositoryId ?? null,
        options.includeTombstones ? 1 : 0,
      ) as WorktreeRow[];
    return rows.map(worktreeFromRow);
  }

  listRegisteredWorktrees(room: string, repositoryId?: string): RegisteredWorktree[] {
    return this.listWorktrees(room, { repositoryId });
  }

  // harn:assume worktree-lifecycle-preserves-existing-state-by-default ref=worktree-root-neutral-registration
  /** Persist the repository, its stable main row, and one explicitly selected
   * secondary in one SQLite transaction. Registration effects are limited to
   * repository/worktree rows and CHILD conversation metadata (plus the one
   * explicitly preflighted new-child seed); every existing root entity — Room
   * config, roster, history, tasks, usage — is preserved byte-for-byte. */
  registerWorktree(
    room: string,
    repository: RepositoryObservation,
    main: WorktreeObservation,
    secondary: WorktreeObservation,
    sourceOrLegacySelector: Exclude<WorktreeSource, 'main'> | string,
    nowOrSource: string = new Date().toISOString(),
    initialAgentsOrNow: readonly InitialAgent[] | string = [],
    legacyInitialAgents: readonly InitialAgent[] = [],
  ): { repository: RepositoryRecord; worktree: RegisteredWorktree; seeded: Member[] } {
    if (!main.primary || secondary.primary) throw new Error('invalid primary/secondary worktree observations');
    // Direct Store callers predating branch-owned identities supplied an
    // extra display selector before the source. Treat it only as a branch
    // observation fallback; no selector is persisted from that argument.
    const legacyCall = sourceOrLegacySelector !== 'adopted' && sourceOrLegacySelector !== 'created';
    const source = (legacyCall ? nowOrSource : sourceOrLegacySelector) as Exclude<WorktreeSource, 'main'>;
    const now = legacyCall
      ? typeof initialAgentsOrNow === 'string' ? initialAgentsOrNow : new Date().toISOString()
      : nowOrSource;
    const initialAgents = legacyCall
      ? legacyInitialAgents
      : Array.isArray(initialAgentsOrNow) ? initialAgentsOrNow : [];
    const branch = secondary.branch ?? (legacyCall ? sourceOrLegacySelector : undefined);
    if (branch === undefined || branch === '') {
      throw new Error('a secondary worktree must have a branch');
    }
    const normalizedAlias = worktreeSelectorFromBranch(branch);
    const conversationId = deterministicWorktreeConversationId(room, branch);
    return this.db.transaction(() => {
      if (!this.getRoom(room)) throw new Error(`no such room: ${room}`);

      const existingRoomRepository = this.db
        .prepare('SELECT * FROM repositories WHERE room = ? LIMIT 1')
        .get(room) as RepositoryRow | undefined;
      if (
        existingRoomRepository !== undefined
        && existingRoomRepository.common_path !== repository.common_path
      ) {
        throw new Error('a room may register only one Git repository');
      }

      let repositoryRow = this.db
        .prepare('SELECT * FROM repositories WHERE room = ? AND common_path = ?')
        .get(room, repository.common_path) as RepositoryRow | undefined;
      if (repositoryRow === undefined) {
        const repositoryId = this.newUlid();
        this.db.prepare(
          `INSERT INTO repositories
             (id, room, common_path, primary_path, primary_git_admin_id, created_ts, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          repositoryId,
          room,
          repository.common_path,
          repository.primary_path,
          repository.primary_git_admin_id,
          now,
          now,
        );
        repositoryRow = this.db
          .prepare('SELECT * FROM repositories WHERE id = ?')
          .get(repositoryId) as RepositoryRow;
      } else {
        this.db.prepare(
          `UPDATE repositories
           SET primary_path = ?, primary_git_admin_id = ?, updated_ts = ?
           WHERE id = ?`,
        ).run(repository.primary_path, repository.primary_git_admin_id, now, repositoryRow.id);
        repositoryRow = this.db
          .prepare('SELECT * FROM repositories WHERE id = ?')
          .get(repositoryRow.id) as RepositoryRow;
      }

      const mainRow = this.db
        .prepare(
          `SELECT * FROM worktrees
           WHERE repository_id = ? AND primary_checkout = 1
           ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, updated_ts DESC
           LIMIT 1`,
        )
        .get(repositoryRow.id) as WorktreeRow | undefined;
      if (mainRow === undefined) {
        this.insertWorktreeRow(
          repositoryRow.id,
          room,
          'main',
          main,
          'main',
          room,
          now,
        );
      } else {
        if (mainRow.conversation_id !== room) {
          this.db.prepare('UPDATE worktrees SET conversation_id = ? WHERE id = ?').run(room, mainRow.id);
        }
        this.updateWorktreeRow(mainRow.id, main, {
          alias: 'main',
          lifecycle: 'active',
          source: 'main',
          unregistered_ts: null,
          removed_ts: null,
          updated_ts: now,
        });
      }

      const existingSecondary = this.db
        .prepare(
          `SELECT * FROM worktrees
           WHERE repository_id = ? AND git_admin_id = ? AND primary_checkout = 0
           ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, updated_ts DESC
           LIMIT 1`,
        )
        .get(repositoryRow.id, secondary.git_admin_id) as WorktreeRow | undefined;
      let secondaryId: string;
      if (existingSecondary === undefined) {
        secondaryId = this.newUlid();
        this.insertWorktreeRow(
          repositoryRow.id,
          room,
          normalizedAlias,
          secondary,
          source,
          conversationId,
          now,
          secondaryId,
        );
      } else {
        secondaryId = existingSecondary.id;
        if (existingSecondary.conversation_id === null || existingSecondary.conversation_id === '') {
          this.db.prepare('UPDATE worktrees SET conversation_id = ? WHERE id = ?').run(
            conversationId,
            existingSecondary.id,
          );
        } else if (existingSecondary.conversation_id !== conversationId) {
          throw new Error('registered worktree conversation does not match its branch identity');
        }
        this.updateWorktreeRow(existingSecondary.id, secondary, {
          alias: normalizedAlias,
          lifecycle: 'active',
          // The original source and registration timestamp are identity history;
          // re-adoption only clears the tombstone and refreshes observations.
          source: existingSecondary.source,
          unregistered_ts: null,
          removed_ts: null,
          updated_ts: now,
        });
      }

      const secondaryRow = this.db.prepare('SELECT * FROM worktrees WHERE id = ?')
        .get(secondaryId) as WorktreeRow;
      if (secondaryRow.conversation_id === null || secondaryRow.conversation_id === '') {
        throw new Error(`worktree ${secondaryId} has no conversation mapping`);
      }
      this.ensureChildConversation(room, secondaryRow.conversation_id, branch, secondary.path, now);
      // harn:assume worktree-child-default-roster-is-an-explicit-snapshot ref=child-default-roster-store
      // Only a brand-new child receives the preflighted detached snapshots,
      // bound to that exact conversation inside this same transaction. Any
      // later re-adoption reuses the durable child and seeds nothing.
      const seeded = existingSecondary === undefined
        ? this.insertInitialAgentMembers(secondaryRow.conversation_id, initialAgents)
        : [];
      // harn:end worktree-child-default-roster-is-an-explicit-snapshot

      const refreshedRepository = this.db
        .prepare('SELECT * FROM repositories WHERE id = ?')
        .get(repositoryRow.id) as RepositoryRow;
      const refreshedWorktree = this.db
        .prepare(
          `SELECT * FROM worktrees
           WHERE repository_id = ? AND git_admin_id = ? AND primary_checkout = 0
           ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, updated_ts DESC
           LIMIT 1`,
        )
        .get(repositoryRow.id, secondary.git_admin_id) as WorktreeRow;
      return {
        repository: repositoryFromRow(refreshedRepository),
        worktree: worktreeFromRow(refreshedWorktree),
        seeded,
      };
    })();
  }
  // harn:end worktree-lifecycle-preserves-existing-state-by-default

  /** Refresh an active row from a fresh Git observation. This deliberately
   * bypasses the room changelog because worktree metadata is an additive REST
   * projection, not room-sync state. */
  refreshWorktreeObservation(
    room: string,
    worktreeId: string,
    observation: WorktreeObservation,
    now = new Date().toISOString(),
  ): RegisteredWorktree {
    return this.db.transaction(() => {
      const existing = this.getWorktree(room, worktreeId);
      if (existing === undefined || existing.lifecycle !== 'active') {
        throw new Error(`no active worktree: ${worktreeId}`);
      }
      this.updateWorktreeRow(existing.id, observation, { updated_ts: now });
      return this.getWorktree(room, worktreeId)!;
    })();
  }

  unregisterWorktree(room: string, worktreeId: string, now = new Date().toISOString()): RegisteredWorktree {
    return this.db.transaction(() => {
      const existing = this.getWorktree(room, worktreeId);
      if (existing === undefined || existing.lifecycle !== 'active' || existing.primary) {
        throw new Error(`only an active secondary worktree can be unregistered: ${worktreeId}`);
      }
      this.db.prepare(
        `UPDATE worktrees
         SET lifecycle = 'unregistered', unregistered_ts = ?, updated_ts = ?
         WHERE room = ? AND id = ? AND lifecycle = 'active'`,
      ).run(now, now, room, worktreeId);
      return this.getWorktree(room, worktreeId)!;
    })();
  }

  removeWorktree(room: string, worktreeId: string, now = new Date().toISOString()): RegisteredWorktree {
    return this.db.transaction(() => {
      const existing = this.getWorktree(room, worktreeId);
      if (existing === undefined || existing.lifecycle !== 'active' || existing.primary) {
        throw new Error(`only an active secondary worktree can be removed: ${worktreeId}`);
      }
      this.db.prepare(
        `UPDATE worktrees
         SET lifecycle = 'removed', availability = 'missing', locked = 0,
             removed_ts = ?, updated_ts = ?
         WHERE room = ? AND id = ? AND lifecycle = 'active'`,
      ).run(now, now, room, worktreeId);
      return this.getWorktree(room, worktreeId)!;
    })();
  }

  private insertWorktreeRow(
    repositoryId: string,
    room: string,
    alias: string,
    observation: WorktreeObservation,
    source: WorktreeSource,
    conversationId: string,
    now: string,
    id = this.newUlid(),
  ): void {
    this.db.prepare(
      `INSERT INTO worktrees
         (id, repository_id, room, conversation_id, alias, path, git_admin_id, primary_checkout, source,
          lifecycle, availability, locked, head, branch, registered_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      repositoryId,
      room,
      conversationId,
      WorktreeAliasSchema.parse(alias),
      observation.path,
      observation.git_admin_id,
      fromBool(observation.primary),
      source,
      observation.availability,
      fromBool(observation.locked),
      observation.head ?? null,
      observation.branch ?? null,
      now,
      now,
    );
  }

  private updateWorktreeRow(
    id: string,
    observation: WorktreeObservation,
    patch: {
      alias?: string;
      lifecycle?: WorktreeLifecycle;
      source?: WorktreeSource;
      unregistered_ts?: string | null;
      removed_ts?: string | null;
      updated_ts: string;
    },
  ): void {
    const alias = patch.alias === undefined ? undefined : WorktreeAliasSchema.parse(patch.alias);
    this.db.prepare(
      `UPDATE worktrees
       SET alias = COALESCE(?, alias), path = ?, git_admin_id = ?,
           primary_checkout = ?, source = COALESCE(?, source), lifecycle = COALESCE(?, lifecycle),
           availability = ?, locked = ?, head = ?, branch = ?,
           unregistered_ts = CASE WHEN ? = 1 THEN ? ELSE unregistered_ts END,
           removed_ts = CASE WHEN ? = 1 THEN ? ELSE removed_ts END,
           updated_ts = ?
       WHERE id = ?`,
    ).run(
      alias ?? null,
      observation.path,
      observation.git_admin_id,
      fromBool(observation.primary),
      patch.source ?? null,
      patch.lifecycle ?? null,
      observation.availability,
      fromBool(observation.locked),
      observation.head ?? null,
      observation.branch ?? null,
      patch.unregistered_ts === undefined ? 0 : 1,
      patch.unregistered_ts ?? null,
      patch.removed_ts === undefined ? 0 : 1,
      patch.removed_ts ?? null,
      patch.updated_ts,
      id,
    );
  }
  updateRoomConfig(room: string, patch: Partial<RoomConfig>): Room {
    return this.db.transaction(() => {
      const current = this.getRoom(room);
      if (!current) throw new Error(`no such room: ${room}`);
      if ('archived_ts' in patch && patch.archived_ts !== current.config.archived_ts) {
        throw new Error(`archived state for channel ${room} is immutable`);
      }
      const config = RoomConfigSchema.parse({ ...current.config, ...patch });
      this.db
        .prepare('UPDATE rooms SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), room);
      this.appendChange(room, 'room', room);
      return this.getRoom(room)!;
    })();
  }

  // harn:assume channel-archive-is-durable-soft-state ref=channel-archive-storage
  /** Rename an active channel and append exactly one room change. */
  renameRoom(room: string, name: string): Room {
    return this.db.transaction(() => {
      const current = this.getRoom(room);
      if (!current) throw new Error(`no such room: ${room}`);
      if (current.config.archived_ts !== undefined) {
        throw new Error(`channel ${room} is archived and cannot be renamed`);
      }
      const validatedName = RoomSchema.parse({ ...current, name }).name;
      this.db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(validatedName, room);
      this.appendChange(room, 'room', room);
      return this.getRoom(room)!;
    })();
  }

  /** Archive an active channel without deleting any related durable records. */
  archiveRoom(room: string): Room {
    return this.db.transaction(() => {
      const current = this.getRoom(room);
      if (!current) throw new Error(`no such room: ${room}`);
      if (current.config.archived_ts !== undefined) {
        throw new Error(`channel ${room} is already archived`);
      }
      const archivedTs = new Date().toISOString();
      const config = RoomConfigSchema.parse({ ...current.config, archived_ts: archivedTs });
      this.db
        .prepare('UPDATE rooms SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), room);
      this.appendChange(room, 'room', room);
      return this.getRoom(room)!;
    })();
  }
  // harn:end channel-archive-is-durable-soft-state

  // harn:assume individual-agent-presets-are-versioned-local-state ref=individual-agent-preset-store-crud
  listAgentPresets(): AgentPreset[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_presets ORDER BY id',
    ).all() as AgentPresetRow[];
    return rows.map(agentPresetFromRow);
  }

  getAgentPreset(id: string): AgentPreset | undefined {
    const row = this.db.prepare(
      'SELECT * FROM agent_presets WHERE id = ?',
    ).get(id) as AgentPresetRow | undefined;
    return row === undefined ? undefined : agentPresetFromRow(row);
  }

  createAgentPreset(input: AgentPresetInput): AgentPreset {
    const validated = AgentPresetInputSchema.parse(input);
    return this.db.transaction(() => {
      const id = this.newUlid();
      const ts = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO agent_presets
          (id, schema_version, label, handle, display_name, harness, model, thinking,
           policy, acp_provider, acp_launch, created_ts, updated_ts)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        validated.label,
        validated.handle,
        orNull(validated.display_name),
        validated.harness,
        orNull(validated.model),
        orNull(validated.thinking),
        orNull(validated.policy),
        orNull(validated.acp_provider),
        jsonOrNull(validated.acp_launch),
        ts,
        ts,
      );
      return this.getAgentPreset(id)!;
    })();
  }

  updateAgentPreset(id: string, input: AgentPresetInput): AgentPreset {
    const validated = AgentPresetInputSchema.parse(input);
    return this.db.transaction(() => {
      const existing = this.getAgentPreset(id);
      if (existing === undefined) throw new AgentPresetNotFoundError(id);
      const updatedTs = new Date().toISOString();
      this.db.prepare(
        `UPDATE agent_presets
         SET label = ?, handle = ?, display_name = ?, harness = ?, model = ?,
             thinking = ?, policy = ?, acp_provider = ?, acp_launch = ?, updated_ts = ?
         WHERE id = ?`,
      ).run(
        validated.label,
        validated.handle,
        orNull(validated.display_name),
        validated.harness,
        orNull(validated.model),
        orNull(validated.thinking),
        orNull(validated.policy),
        orNull(validated.acp_provider),
        jsonOrNull(validated.acp_launch),
        updatedTs,
        id,
      );
      return this.getAgentPreset(id)!;
    })();
  }
  // harn:end individual-agent-presets-are-versioned-local-state

  // harn:assume default-roster-references-block-preset-deletion ref=preset-roster-reference-integrity
  deleteAgentPreset(id: string): void {
    this.db.transaction(() => {
      if (this.getAgentPreset(id) === undefined) throw new AgentPresetNotFoundError(id);
      const reference = this.db.prepare(
        `SELECT 1 FROM default_roster_items
         WHERE roster_id = 'default' AND preset_id = ? LIMIT 1`,
      ).get(id);
      if (reference !== undefined) throw new AgentPresetReferenceConflictError(id);
      this.db.prepare('DELETE FROM agent_presets WHERE id = ?').run(id);
    })();
  }
  // harn:end default-roster-references-block-preset-deletion

  // harn:assume default-roster-is-one-versioned-ordered-preset-reference-group ref=default-roster-store
  getDefaultRoster(): DefaultRoster {
    const roster = this.db.prepare(
      `SELECT id, schema_version, updated_ts FROM default_rosters WHERE id = 'default'`,
    ).get() as DefaultRosterRow | undefined;
    if (roster === undefined) throw new Error('default roster is not initialized');
    const items = this.db.prepare(
      `SELECT preset_id FROM default_roster_items
       WHERE roster_id = 'default' ORDER BY ordinal`,
    ).all() as { preset_id: string }[];
    return defaultRosterFromRows(roster, items);
  }

  replaceDefaultRoster(input: DefaultRosterInput | readonly string[]): DefaultRoster {
    const validated = DefaultRosterInputSchema.parse(
      Array.isArray(input) ? { preset_ids: [...input] } : input,
    );
    return this.db.transaction(() => {
      // Validate every reference before deleting the old complete ordered list.
      for (const presetId of validated.preset_ids) {
        if (this.getAgentPreset(presetId) === undefined) {
          throw new AgentPresetNotFoundError(presetId);
        }
      }
      const updatedTs = new Date().toISOString();
      this.db.prepare(
        `UPDATE default_rosters
         SET schema_version = 1, updated_ts = ? WHERE id = 'default'`,
      ).run(updatedTs);
      this.db.prepare(
        `DELETE FROM default_roster_items WHERE roster_id = 'default'`,
      ).run();
      const insert = this.db.prepare(
        `INSERT INTO default_roster_items (roster_id, ordinal, preset_id)
         VALUES ('default', ?, ?)`,
      );
      validated.preset_ids.forEach((presetId, ordinal) => insert.run(ordinal, presetId));
      return this.getDefaultRoster();
    })();
  }
  // harn:end default-roster-is-one-versioned-ordered-preset-reference-group

  // ── members ───────────────────────────────────────────────────────────

  private insertMember(room: string, member: NewMember): Member {
    const validated = MemberSchema.parse({ id: this.newUlid(), ...member });
    // harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-storage
    // The safe public provider id is persisted with the other member identity columns.
    // The exact launch is written privately (addMember) and never appears here.
    this.db
      .prepare(
        `INSERT INTO members (id, room, kind, handle, display_name, purpose, harness, session_ref,
           cwd, policy, model, thinking, host, state, custody, parent, role, conventions_sent,
           misaddressed, roster_stale, removed_ts, acp_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        orNull(validated.model),
        orNull(validated.thinking),
        orNull(validated.host),
        orNull(validated.state),
        orNull(validated.custody),
        orNull(validated.parent),
        orNull(validated.role),
        fromBool(validated.conventions_sent),
        fromBool(validated.misaddressed),
        fromBool(validated.roster_stale),
        orNull(validated.removed_ts),
        orNull(validated.acp_provider),
      );
    // harn:end named-acp-provider-selection-resolves-to-private-structured-launch
    const seq = this.appendChange(room, 'member', validated.id);
    // harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-storage
    if (validated.kind === 'human') {
      this.db.prepare(
        `INSERT INTO room_read_cursors (room, member_id, read_seq, updated_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room, member_id) DO NOTHING`,
      ).run(room, validated.id, seq, new Date().toISOString());
      if (!this.isChildRoom(room)) {
        for (const child of this.childRoomIds(room)) {
          const childSeq = this.appendChange(child, 'member', validated.id);
          this.db.prepare(
            `INSERT INTO room_read_cursors (room, member_id, read_seq, updated_ts)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (room, member_id) DO NOTHING`,
          ).run(child, validated.id, childSeq, new Date().toISOString());
        }
      }
    }
    // harn:end human-room-read-cursors-are-durable-and-monotonic
    return validated;
  }

  addMember(room: string, member: NewMember, runtime: AgentRuntimeConfig = {}): Member {
    return this.db.transaction(() => {
      const inserted = this.insertMember(room, member);
      if (
        runtime.acp_launch !== undefined ||
        runtime.lifecycle !== undefined ||
        runtime.usage_baseline !== undefined
      ) {
        this.db.prepare(
          `UPDATE members
           SET acp_launch = ?, session_lifecycle = ?, acp_usage_baseline = ?
           WHERE room = ? AND id = ?`,
        ).run(
          runtime.acp_launch === undefined ? null : JSON.stringify(runtime.acp_launch),
          runtime.lifecycle === undefined ? null : JSON.stringify(runtime.lifecycle),
          runtime.usage_baseline === undefined ? null : JSON.stringify(runtime.usage_baseline),
          room,
          inserted.id,
        );
      }
      return inserted;
    })();
  }

  getAgentRuntimeConfig(room: string, memberId: string): AgentRuntimeConfig | undefined {
    const row = this.db.prepare(
      `SELECT acp_launch, session_lifecycle, acp_usage_baseline
       FROM members WHERE room = ? AND id = ?`,
    ).get(room, memberId) as Pick<
      MemberRow,
      'acp_launch' | 'session_lifecycle' | 'acp_usage_baseline'
    > | undefined;
    if (row === undefined) return undefined;
    return {
      ...(row.acp_launch !== null && { acp_launch: JSON.parse(row.acp_launch) as AcpLaunchConfig }),
      ...(row.session_lifecycle !== null && {
        lifecycle: JSON.parse(row.session_lifecycle) as SessionLifecycleSupport,
      }),
      ...(row.acp_usage_baseline !== null && {
        usage_baseline: JSON.parse(row.acp_usage_baseline) as AcpUsageBaseline,
      }),
    };
  }

  setAgentUsageBaseline(room: string, memberId: string, baseline: AcpUsageBaseline): void {
    this.db.prepare(
      'UPDATE members SET acp_usage_baseline = ? WHERE room = ? AND id = ?',
    ).run(JSON.stringify(baseline), room, memberId);
  }

  stageAgentUsageBaseline(
    room: string,
    memberId: string,
    runMsgId: number,
    baseline: AcpUsageBaseline,
  ): void {
    this.db.prepare(
      'UPDATE members SET acp_usage_pending = ? WHERE room = ? AND id = ?',
    ).run(JSON.stringify({ run_msg_id: runMsgId, baseline }), room, memberId);
  }

  private promoteAgentUsageBaseline(room: string, memberId: string, runMsgId: number): void {
    const row = this.db.prepare(
      'SELECT acp_usage_pending FROM members WHERE room = ? AND id = ?',
    ).get(room, memberId) as Pick<MemberRow, 'acp_usage_pending'> | undefined;
    if (row?.acp_usage_pending === null || row === undefined) return;
    const pending = JSON.parse(row.acp_usage_pending) as {
      run_msg_id: number;
      baseline: AcpUsageBaseline;
    };
    if (pending.run_msg_id !== runMsgId) return;
    this.db.prepare(
      `UPDATE members
       SET acp_usage_baseline = ?, acp_usage_pending = NULL
       WHERE room = ? AND id = ?`,
    ).run(JSON.stringify(pending.baseline), room, memberId);
  }

  setAgentSessionLifecycle(
    room: string,
    memberId: string,
    lifecycle: SessionLifecycleSupport,
  ): void {
    this.db.prepare(
      'UPDATE members SET session_lifecycle = ? WHERE room = ? AND id = ?',
    ).run(JSON.stringify(lifecycle), room, memberId);
  }

  setAgentSessionRuntime(
    room: string,
    memberId: string,
    sessionRef: string,
    lifecycle: SessionLifecycleSupport,
  ): Member {
    return this.db.transaction(() => {
      // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
      // Same-id reconnect/rebuild/revive preserves the task projection; moving to a
      // genuinely different native session id clears it atomically here too.
      const existing = this.getMember(room, memberId);
      const clearTasks = existing?.session_ref !== undefined && existing.session_ref !== sessionRef;
      this.db.prepare(
        `UPDATE members SET session_ref = ?, session_lifecycle = ?${clearTasks ? ', tasks = NULL' : ''} WHERE room = ? AND id = ?`,
      ).run(sessionRef, JSON.stringify(lifecycle), room, memberId);
      // harn:end member-task-projection-is-durable-and-session-scoped
      this.appendChange(room, 'member', memberId);
      return this.getMember(room, memberId)!;
    })();
  }

  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-store-transaction
  // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
  /**
   * Commit the durable half of an explicit fresh-context boundary. Identity,
   * configuration, history, limits, spend, ACP launch identity, and the
   * concurrent misaddress bit are deliberately outside this UPDATE.
   */
  clearAgentContext(room: string, memberId: string): Member {
    return this.db.transaction(() => {
      const existing = this.getMember(room, memberId);
      if (!existing || existing.kind !== 'agent' || existing.removed_ts !== undefined) {
        throw new Error(`no active agent member: ${memberId}`);
      }
      this.db.prepare(
        `UPDATE members
         SET session_ref = NULL,
             session_lifecycle = NULL,
             acp_usage_baseline = NULL,
             acp_usage_pending = NULL,
             context_window = NULL,
             credential_hash = NULL,
             tasks = NULL,
             conventions_sent = 0,
             roster_stale = 1
         WHERE room = ? AND id = ?`,
      ).run(room, memberId);
      this.appendChange(room, 'member', memberId);
      return this.getMember(room, memberId)!;
    })();
  }
  // harn:end member-task-projection-is-durable-and-session-scoped
  // harn:end member-context-reset-is-authorized-atomic-and-lazy

  // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
  /** Materialize a run.tasks update onto the member's durable task projection in one
   *  transaction. Appends exactly one member change row only when the list actually
   *  changes; an identical (duplicate) delivery is a no-op returning undefined so the
   *  daemon emits no duplicate frame. */
  applyMemberTaskUpdate(room: string, memberId: string, update: AgentTaskUpdate): Member | undefined {
    return this.db.transaction(() => {
      const existing = this.getMember(room, memberId);
      if (existing === undefined) return undefined;
      const next = materializeTasks(existing.tasks, update);
      if (tasksEqual(existing.tasks, next)) return undefined; // idempotent no-op
      this.db.prepare('UPDATE members SET tasks = ? WHERE room = ? AND id = ?')
        .run(next === undefined ? null : JSON.stringify(next), room, memberId);
      this.appendChange(room, 'member', memberId);
      return this.getMember(room, memberId)!;
    })();
  }
  // harn:end member-task-projection-is-durable-and-session-scoped

  updateMember(
    room: string,
    memberId: string,
    patch: Partial<Omit<Member, 'id' | 'kind'>>,
  ): Member {
    return this.db.transaction(() => {
      const requestedRoom = room;
      const existing = this.getMember(requestedRoom, memberId);
      if (!existing) throw new Error(`no such member: ${memberId}`);
      const storageRoom = this.memberStorageRoom(requestedRoom, memberId);
      const merged = MemberSchema.parse({ ...existing, ...patch });
      // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-storage
      // Preserve the task projection across ordinary config edits; clear it only when
      // this update moves the member to a genuinely different native session.
      const changesSession = existing.session_ref !== undefined &&
        merged.session_ref !== undefined && merged.session_ref !== existing.session_ref;
      const nextTasks = changesSession ? undefined : merged.tasks;
      // harn:end member-task-projection-is-durable-and-session-scoped
      room = storageRoom;
      this.db
        .prepare(
          // harn:assume member-config-is-changed-not-respawned ref=member-config-storage
          // A2 gave members a model and a thinking level and taught the INSERT and the
          // READ about them — but not this. Nothing changed them after spawn, so nothing
          // noticed. A configure that called this would have reported success and
          // persisted nothing at all.
          `UPDATE members SET handle = ?, display_name = ?, purpose = ?, harness = ?, session_ref = ?,
             cwd = ?, policy = ?, model = ?, thinking = ?, host = ?, state = ?, custody = ?,
             parent = ?, role = ?, conventions_sent = ?, misaddressed = ?, roster_stale = ?,
             removed_ts = ?, limits = ?, tasks = ?, acp_provider = ?
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
          orNull(merged.model),
          orNull(merged.thinking),
          orNull(merged.host),
          orNull(merged.state),
          orNull(merged.custody),
          orNull(merged.parent),
          orNull(merged.role),
          fromBool(merged.conventions_sent),
          fromBool(merged.misaddressed),
          fromBool(merged.roster_stale),
          orNull(merged.removed_ts),
          merged.limits === undefined ? null : JSON.stringify(merged.limits),
          nextTasks === undefined ? null : JSON.stringify(nextTasks),
          // acp_provider is public locked identity: preserved from the merged member,
          // never rewritten by an ordinary Configure edit (harness stays locked too).
          orNull(merged.acp_provider),
          room,
          memberId,
        );
      // harn:end member-config-is-changed-not-respawned
      this.appendChange(storageRoom, 'member', memberId);
      if (storageRoom !== room && (existing.kind === 'human' || existing.kind === 'system')) {
        this.appendInheritedMemberChanges(storageRoom, memberId);
      } else if (storageRoom === room && !this.isChildRoom(room)
        && (existing.kind === 'human' || existing.kind === 'system')) {
        this.appendInheritedMemberChanges(room, memberId);
      }
      return this.getMember(requestedRoom, memberId)!;
    })();
  }

  // harn:assume agent-member-credentials-stay-secret ref=member-credential-storage
  setAgentCredentialHash(room: string, memberId: string, credentialHash: string): void {
    if (!/^[a-f0-9]{64}$/.test(credentialHash)) {
      throw new Error('member credential hash must be a SHA-256 digest');
    }
    const member = this.getMember(room, memberId);
    if (!member || member.kind !== 'agent' || member.removed_ts !== undefined) {
      throw new Error(`no active agent member: ${memberId}`);
    }
    this.db
      .prepare('UPDATE members SET credential_hash = ? WHERE room = ? AND id = ?')
      .run(credentialHash, room, memberId);
  }

  findAgentByCredentialHash(
    credentialHash: string,
  ): { room: string; member: Member } | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM members
         WHERE credential_hash = ? AND kind = 'agent' AND removed_ts IS NULL
           AND state <> 'dead'`,
      )
      .get(credentialHash) as MemberRow | undefined;
    return row ? { room: row.room, member: memberFromRow(row) } : undefined;
  }
  // harn:end agent-member-credentials-stay-secret

  // harn:assume main-and-direct-conversations-stay-compatible ref=conversation-shared-human-resolution
  private memberStorageRoom(room: string, memberId: string): string {
    const local = this.db.prepare('SELECT room FROM members WHERE room = ? AND id = ?')
      .get(room, memberId) as { room: string } | undefined;
    if (local !== undefined) return local.room;
    const root = this.rootRoomId(room);
    if (root === undefined) return room;
    const inherited = this.db.prepare(
      `SELECT room FROM members
       WHERE room = ? AND id = ?
         AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))`,
    ).get(root, memberId) as { room: string } | undefined;
    return inherited?.room ?? room;
  }

  getMember(room: string, memberId: string): Member | undefined {
    const row = this.db
      .prepare('SELECT * FROM members WHERE room = ? AND id = ?')
      .get(room, memberId) as MemberRow | undefined;
    if (row) return memberFromRow(row);
    const root = this.rootRoomId(room);
    if (root === undefined) return undefined;
    const inherited = this.db.prepare(
      `SELECT * FROM members
       WHERE room = ? AND id = ?
         AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))`,
    ).get(root, memberId) as MemberRow | undefined;
    return inherited ? memberFromRow(inherited) : undefined;
  }

  getMemberByHandle(room: string, handle: string): Member | undefined {
    const row = this.db
      .prepare('SELECT * FROM members WHERE room = ? AND handle = ? AND removed_ts IS NULL')
      .get(room, handle) as MemberRow | undefined;
    if (row) return memberFromRow(row);
    const root = this.rootRoomId(room);
    if (root === undefined) return undefined;
    const inherited = this.db.prepare(
      `SELECT * FROM members
       WHERE room = ? AND handle = ? AND removed_ts IS NULL
         AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))`,
    ).get(root, handle) as MemberRow | undefined;
    return inherited ? memberFromRow(inherited) : undefined;
  }
  // harn:end main-and-direct-conversations-stay-compatible

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
    const root = this.rootRoomId(room);
    if (root === undefined) return rows.map(memberFromRow);
    const inherited = this.db.prepare(
      `SELECT * FROM members
       WHERE room = ? AND (? = 1 OR removed_ts IS NULL)
         AND (kind = 'human' OR (kind = 'system' AND handle = 'switchboard'))
       ORDER BY id`,
    ).all(root, options.includeRemoved ? 1 : 0) as MemberRow[];
    const byId = new Map([...inherited, ...rows].map((row) => [row.id, row]));
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)).map(memberFromRow);
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
        collaboration?: RoutedMessagePlan['collaboration'];
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
      const collaboration = finalized.collaboration === undefined
        ? undefined
        : this.createCollaborationGroup(room, {
            groupId: finalized.collaboration.groupId,
            rootMessageId: message.id,
            participants: finalized.collaboration.participants,
          });
      if (collaboration) deliveries.push(...collaboration.deliveries);
      this.recordMirroredTurn(room, opts.memberId, opts.nativeTurnId, message.id);
      return { message, deliveries, member, collaboration, deduped: false };
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
  postMessage(
    room: string,
    message: NewMessage,
    options: { activity?: MessageActivityMode } = {},
  ): Message {
    return this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages WHERE room = ?')
        .get(room) as { id: number };
      const seq = this.appendChange(room, 'message', String(next.id));
      const validated = MessageSchema.parse({
        id: next.id,
        room,
        author: message.author,
        // harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-origin-transaction
        author_target: message.author_target,
        // harn:end cross-worktree-output-stays-in-origin
        kind: message.kind,
        body: message.body,
        mentions: message.mentions ?? [],
        refs: message.refs ?? [],
        ledger_refs: message.ledger_refs ?? [],
        reply_to: message.reply_to,
        run: message.run,
        run_parent_id: message.run_parent_id,
        ask: message.ask,
        origin: message.origin,
        ack: message.ack,
        attachments: message.attachments,
        voice: message.voice,
        ts: new Date().toISOString(),
        seq,
      });
      // harn:assume substantive-output-messages-drive-unread ref=message-activity-storage
      const activitySeq = nextActivitySeq(validated, options.activity ?? 'auto', seq);
        this.db
        .prepare(
          `INSERT INTO messages (room, id, author, author_worktree_id, author_conversation_id,
             author_alias, author_handle, kind, body, mentions, refs, ledger_refs,
             reply_to, run, run_parent_id, ask, origin, attachments, voice, ack, pinned, deleted, ts, seq, activity_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room,
          validated.id,
          validated.author,
          validated.author_target?.worktree_id ?? null,
          validated.author_target?.conversation_id ?? null,
          validated.author_target?.alias ?? null,
          validated.author_target?.handle ?? null,
          validated.kind,
          validated.body,
          JSON.stringify(validated.mentions),
          JSON.stringify(validated.refs),
          JSON.stringify(validated.ledger_refs),
          orNull(validated.reply_to),
          jsonOrNull(validated.run),
          orNull(validated.run_parent_id),
          jsonOrNull(validated.ask),
          jsonOrNull(validated.origin),
          jsonOrNull(validated.attachments),
          jsonOrNull(validated.voice),
          fromBool(validated.ack === true),
          fromBool(validated.pinned === true),
          fromBool(validated.deleted === true),
          validated.ts,
          validated.seq,
          activitySeq,
        );
      // harn:end substantive-output-messages-drive-unread
      return validated;
    })();
  }
  // harn:end message-id-txn-allocation

  // harn:assume eligible-multi-agent-routing-starts-one-group ref=atomic-routed-message-commit
  commitRoutedMessage(
    room: string,
    opts: {
      message: NewMessage;
      plan(message: Message): RoutedMessagePlan;
    },
  ): AtomicRoutedMessage {
    return this.db.transaction(() => {
      const message = this.postMessage(room, opts.message);
      const plan = opts.plan(message);
      const member = plan.markMisaddressed
        ? this.updateMember(room, message.author, { misaddressed: true })
        : undefined;
      const deliveries = plan.fanout.map((delivery) => this.createDelivery(room, {
        message_id: message.id,
        recipient: delivery.recipient,
        state: delivery.state,
        payload_snapshot: delivery.payload_snapshot,
        hop_count: delivery.hop_count,
        target: delivery.target,
      }));
      const collaboration = plan.collaboration === undefined
        ? undefined
        : this.createCollaborationGroup(room, {
            groupId: plan.collaboration.groupId,
            rootMessageId: message.id,
            participants: plan.collaboration.participants,
          });
      if (collaboration) deliveries.push(...collaboration.deliveries);
      return { message, deliveries, member, collaboration };
    })();
  }
  // harn:end eligible-multi-agent-routing-starts-one-group

  // harn:assume scheduled-state-machine-recovers-from-one-next-due-alarm ref=durable-schedule-store
  // harn:assume scheduled-state-streams-through-room-seq ref=schedule-change-log-storage
  /** Persist one validated schedule before any message or delivery write. */
  createSchedule(input: NewSchedule, createdTs = input.created_ts ?? new Date().toISOString()): Schedule {
    return this.db.transaction(() => {
      const target = input.target;
      const targetMember = this.getMember(target.conversation_id, target.member_id);
      if (targetMember === undefined || targetMember.removed_ts !== undefined) {
        throw new Error(`scheduled target is not active: ${target.member_id}`);
      }
      if (target.worktree_id !== undefined && target.alias !== undefined) {
        const qualified = {
          worktree_id: target.worktree_id,
          conversation_id: target.conversation_id,
          member_id: target.member_id,
          alias: target.alias,
          handle: target.handle,
        } satisfies ScopedMemberTarget;
        if (!this.routingTargetIsActive(qualified, input.origin_room ?? input.room)) {
          throw new Error(`scheduled target is not active: ${target.alias}:@${target.handle}`);
        }
      }
      const schedule = ScheduleSchema.parse({
        id: randomUUID(),
        room: input.room,
        ...(input.origin_room !== undefined && { origin_room: input.origin_room }),
        author_id: input.author_id,
        author_handle: input.author_handle,
        target,
        body: input.body,
        mentions: input.mentions,
        ...(input.refs !== undefined && { refs: input.refs }),
        ...(input.ledger_refs !== undefined && { ledger_refs: input.ledger_refs }),
        due_ts: input.due_ts,
        host_offset_minutes: input.host_offset_minutes,
        state: 'pending',
        created_ts: createdTs,
        updated_ts: createdTs,
      });
      this.db.prepare(
        `INSERT INTO schedules
         (id, room, origin_room, author_id, author_handle, target_member_id,
          target_conversation_id, target_worktree_id, target_alias, target_handle,
         target_display_name, body, mentions, due_ts, host_offset_minutes, state,
         refs, ledger_refs, created_ts, updated_ts, claimed_ts, completed_ts, error, delivered_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        schedule.id,
        schedule.room,
        schedule.origin_room ?? null,
        schedule.author_id,
        schedule.author_handle,
        schedule.target.member_id,
        schedule.target.conversation_id,
        schedule.target.worktree_id ?? null,
        schedule.target.alias ?? null,
        schedule.target.handle,
        schedule.target.display_name ?? null,
        schedule.body,
        JSON.stringify(schedule.mentions),
        schedule.due_ts,
        schedule.host_offset_minutes,
        schedule.state,
        schedule.refs === undefined ? null : JSON.stringify(schedule.refs),
        schedule.ledger_refs === undefined ? null : JSON.stringify(schedule.ledger_refs),
        schedule.created_ts,
        schedule.updated_ts,
        null,
        null,
        null,
        null,
      );
      this.appendChange(schedule.room, 'schedule', schedule.id);
      return schedule;
    })();
  }
  // harn:end scheduled-state-streams-through-room-seq

  getSchedule(room: string, id: string): Schedule | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE room = ? AND id = ?')
      .get(room, id) as ScheduleRow | undefined;
    return row === undefined ? undefined : scheduleFromRow(row);
  }

  findSchedule(id: string, preferredRoom?: string): Schedule | undefined {
    if (preferredRoom !== undefined) {
      const local = this.getSchedule(preferredRoom, id);
      if (local !== undefined) return local;
    }
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row === undefined ? undefined : scheduleFromRow(row);
  }

  listSchedules(room: string, options: { state?: Schedule['state']; limit?: number } = {}): Schedule[] {
    const rows = this.db.prepare(
      `SELECT * FROM schedules WHERE room = ?
       AND (? IS NULL OR state = ?)
       ORDER BY due_ts, id LIMIT ?`,
    ).all(room, options.state ?? null, options.state ?? null, options.limit ?? 10_000) as ScheduleRow[];
    return rows.map(scheduleFromRow);
  }

  listRecoverableSchedules(): Schedule[] {
    const rows = this.db.prepare(
      `SELECT * FROM schedules WHERE state IN ('pending', 'sending') ORDER BY due_ts, id`,
    ).all() as ScheduleRow[];
    return rows.map(scheduleFromRow);
  }

  nextScheduleDue(): string | undefined {
    const row = this.db.prepare(
      `SELECT due_ts FROM schedules WHERE state IN ('pending', 'sending') ORDER BY due_ts, id LIMIT 1`,
    ).get() as { due_ts: string } | undefined;
    return row?.due_ts;
  }

  claimDueSchedules(now = new Date().toISOString()): Schedule[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM schedules WHERE state = 'pending' AND due_ts <= ? ORDER BY due_ts, id`,
      ).all(now) as ScheduleRow[];
      const claimed: Schedule[] = [];
      for (const row of rows) {
        const result = this.db.prepare(
          `UPDATE schedules SET state = 'sending', claimed_ts = ?, updated_ts = ?
           WHERE id = ? AND state = 'pending'`,
        ).run(now, now, row.id);
        if (result.changes !== 1) continue;
        this.appendChange(row.room, 'schedule', row.id);
        claimed.push(this.getSchedule(row.room, row.id)!);
      }
      return claimed;
    })();
  }

  private updateScheduleTerminal(
    room: string,
    id: string,
    state: Schedule['state'],
    now: string,
    patch: { error?: string; delivered_message_id?: number } = {},
  ): Schedule {
    const existing = this.getSchedule(room, id);
    if (existing === undefined) throw new Error(`no such schedule: ${id}`);
    if (existing.state === state) return existing;
    if (existing.state !== 'sending' && existing.state !== 'pending') return existing;
    this.db.prepare(
      `UPDATE schedules SET state = ?, updated_ts = ?, completed_ts = ?, error = ?,
       delivered_message_id = COALESCE(?, delivered_message_id)
       WHERE room = ? AND id = ? AND state IN ('pending', 'sending')`,
    ).run(
      state, now, now, patch.error ?? null, patch.delivered_message_id ?? null, room, id,
    );
    this.appendChange(room, 'schedule', id);
    return this.getSchedule(room, id)!;
  }

  cancelSchedule(
    room: string,
    id: string,
    actorId: string,
    options: { admin?: boolean; now?: string } = {},
  ): Schedule {
    return this.db.transaction(() => {
      const existing = this.getSchedule(room, id);
      if (existing === undefined) throw new Error(`no such schedule: ${id}`);
      if (!options.admin && existing.author_id !== actorId) {
        throw new Error('forbidden: only the schedule author or a room administrator may cancel it');
      }
      if (existing.state !== 'pending') return existing;
      const now = options.now ?? new Date().toISOString();
      const result = this.db.prepare(
        `UPDATE schedules SET state = 'cancelled', updated_ts = ?, completed_ts = ?
         WHERE room = ? AND id = ? AND state = 'pending'`,
      ).run(now, now, room, id);
      if (result.changes === 1) this.appendChange(room, 'schedule', id);
      return this.getSchedule(room, id)!;
    })();
  }

  failSchedule(room: string, id: string, reason: string, now = new Date().toISOString()): Schedule {
    return this.db.transaction(() => this.updateScheduleTerminal(
      room, id, 'failed', now, { error: reason.slice(0, 1_000) },
    ))();
  }

  // harn:assume scheduled-message-commit-is-exactly-once ref=atomic-scheduled-message-commit
  /** Commit the ordinary message, its deliveries, and terminal schedule link in one transaction. */
  commitScheduledMessage(
    room: string,
    id: string,
    opts: {
      message: NewMessage;
      plan: (message: Message) => RoutedMessagePlan;
      now?: string;
      failureReason?: string;
    },
  ): AtomicScheduledMessage {
    return this.db.transaction(() => {
      const schedule = this.getSchedule(room, id);
      if (schedule === undefined) throw new Error(`no such schedule: ${id}`);
      if (schedule.state === 'sent' || schedule.state === 'failed' || schedule.state === 'cancelled') {
        return { schedule, message: schedule.delivered_message_id === undefined
          ? undefined : this.getMessage(room, schedule.delivered_message_id), deliveries: [] } as AtomicScheduledMessage;
      }
      if (schedule.state !== 'sending') throw new Error(`schedule ${id} is not claimed`);
      const target = schedule.target;
      const active = this.getMember(target.conversation_id, target.member_id)?.removed_ts === undefined
        && this.getMember(target.conversation_id, target.member_id) !== undefined
        && (target.worktree_id === undefined || target.alias === undefined || this.routingTargetIsActive({
          worktree_id: target.worktree_id,
          conversation_id: target.conversation_id,
          member_id: target.member_id,
          alias: target.alias,
          handle: target.handle,
        }, schedule.origin_room ?? room));
      if (!active) {
        const failed = this.updateScheduleTerminal(
          room, id, 'failed', opts.now ?? new Date().toISOString(),
          { error: opts.failureReason ?? 'frozen target is no longer active' },
        );
        return { schedule: failed, message: undefined, deliveries: [] };
      }
      const message = this.postMessage(room, opts.message);
      const plan = opts.plan(message);
      const member = plan.markMisaddressed
        ? this.updateMember(room, message.author, { misaddressed: true })
        : undefined;
      const deliveries = plan.fanout.map((delivery) => this.createDelivery(room, {
        message_id: message.id,
        recipient: delivery.recipient,
        state: delivery.state,
        payload_snapshot: delivery.payload_snapshot,
        hop_count: delivery.hop_count,
        target: delivery.target,
      }));
      const collaboration = plan.collaboration === undefined
        ? undefined
        : this.createCollaborationGroup(room, {
            groupId: plan.collaboration.groupId,
            rootMessageId: message.id,
            participants: plan.collaboration.participants,
          });
      if (collaboration) deliveries.push(...collaboration.deliveries);
      const sent = this.updateScheduleTerminal(
        room, id, 'sent', opts.now ?? new Date().toISOString(),
        { delivered_message_id: message.id },
      );
      return { schedule: sent, message, deliveries, member, collaboration };
    })();
  }
  // harn:end scheduled-message-commit-is-exactly-once
  // harn:end scheduled-state-machine-recovers-from-one-next-due-alarm

  postBridgeMessage(
    room: string,
    bridgeMemberId: string,
    body: string,
    origin: BridgeOrigin,
    parsed: Pick<Message, 'mentions' | 'refs' | 'ledger_refs'>,
    plan?: (message: Message) => RoutedMessagePlan,
  ): AtomicRoutedMessage & { deduped: boolean } {
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
      if (existing) {
        return { message: messageFromRow(existing), deliveries: [], deduped: true };
      }
      const message = this.postMessage(room, {
        author: bridgeMemberId,
        kind: 'chat',
        body,
        ...parsed,
        origin: validOrigin,
      });
      const routed = plan?.(message);
      const memberPatch = routed?.markMisaddressed
        ? this.updateMember(room, bridgeMemberId, { misaddressed: true })
        : undefined;
      const deliveries = (routed?.fanout ?? []).map((delivery) => this.createDelivery(room, {
        message_id: message.id,
        recipient: delivery.recipient,
        state: delivery.state,
        payload_snapshot: delivery.payload_snapshot,
        hop_count: delivery.hop_count,
        target: delivery.target,
      }));
      const collaboration = routed?.collaboration === undefined
        ? undefined
        : this.createCollaborationGroup(room, {
            groupId: routed.collaboration.groupId,
            rootMessageId: message.id,
            participants: routed.collaboration.participants,
          });
      if (collaboration) deliveries.push(...collaboration.deliveries);
      return {
        message,
        deliveries,
        member: memberPatch,
        collaboration,
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

  // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-message-storage
  /** Allocate and insert a permanent empty continuation before its id is journaled. */
  createRunContinuation(room: string, rootMessageId: number): Message {
    const root = this.getMessage(room, rootMessageId);
    if (root?.kind !== 'run' || root.run === undefined || root.run_parent_id !== undefined) {
      throw new Error(`#${rootMessageId} is not a lifecycle run root`);
    }
    if (root.run.status !== 'running' || root.run.output_mode !== 'messages') {
      throw new Error(`#${rootMessageId} is not accepting continuation output`);
    }
    return this.postMessage(room, {
      author: root.author,
      kind: 'run',
      body: '',
      author_target: root.author_target,
      run_parent_id: root.id,
    }, { activity: 'defer' });
  }

  listRunContinuations(room: string, rootMessageId: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE room = ? AND run_parent_id = ? ORDER BY id',
    ).all(room, rootMessageId) as MessageRow[];
    return rows.map(messageFromRow);
  }

  /** Resolve either a root or one of its result fragments to lifecycle truth. */
  getRunRoot(room: string, message: Message): Message | undefined {
    return message.run_parent_id === undefined
      ? (message.run === undefined ? undefined : message)
      : this.getMessage(room, message.run_parent_id);
  }
  // harn:end continuation-writer-follows-journaled-output-ownership

  // harn:assume default-recipient-fallback-chain ref=substantive-default-recipient
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
  // harn:end default-recipient-fallback-chain

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
    options: { activity?: MessageActivityMode } = {},
  ): Message {
    return this.db.transaction(() => {
      const existing = this.getMessage(room, id);
      if (!existing) throw new Error(`no such message: #${id}`);
      const seq = this.appendChange(room, 'message', String(id));
      const merged = MessageSchema.parse({ ...existing, ...patch, seq });
      // harn:assume substantive-output-messages-drive-unread ref=message-activity-storage
      const storedActivity = this.db.prepare(
        'SELECT activity_seq FROM messages WHERE room = ? AND id = ?',
      ).get(room, id) as { activity_seq: number | null };
      const activitySeq = nextActivitySeq(
        merged,
        options.activity ?? 'auto',
        seq,
        storedActivity.activity_seq,
      );
      this.db
        .prepare(
          `UPDATE messages SET body = ?, mentions = ?, refs = ?, ledger_refs = ?,
             run = ?, ask = ?, ack = ?, seq = ?, activity_seq = ?
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
          activitySeq,
          room,
          id,
        );
      // harn:end substantive-output-messages-drive-unread
      return merged;
    })();
  }

  /**
   * Flip a message's pinned flag through the change log, so live frames and
   * reconnect sync both carry it. Same id, new seq; nothing else on the row
   * moves.
   */
  setMessagePinned(room: string, id: number, pinned: boolean): Message {
    return this.db.transaction(() => {
      const existing = this.getMessage(room, id);
      if (!existing) throw new Error(`no such message: #${id}`);
      const seq = this.appendChange(room, 'message', String(id));
      const merged = MessageSchema.parse({ ...existing, pinned: pinned || undefined, seq });
      this.db
        .prepare('UPDATE messages SET pinned = ?, seq = ? WHERE room = ? AND id = ?')
        .run(fromBool(pinned), seq, room, id);
      return merged;
    })();
  }

  /**
   * Purge a message in place through the change log: body emptied, payload
   * columns nulled, pin cleared (a tombstone cannot stay pinned), the deleted
   * flag set. Same id and new seq keep ordering, attribution, and permalinks
   * coherent; the purge is irreversible.
   */
  deleteMessage(room: string, id: number): Message {
    return this.db.transaction(() => {
      const existing = this.getMessage(room, id);
      if (!existing) throw new Error(`no such message: #${id}`);
      const seq = this.appendChange(room, 'message', String(id));
      const merged = MessageSchema.parse({
        ...existing,
        body: '',
        mentions: [],
        refs: [],
        ledger_refs: [],
        ask: undefined,
        origin: undefined,
        attachments: undefined,
        pinned: undefined,
        deleted: true,
        seq,
      });
      this.db
        .prepare(
          `UPDATE messages SET body = '', mentions = '[]', refs = '[]', ledger_refs = '[]',
             ask = NULL, origin = NULL, attachments = NULL, pinned = 0, deleted = 1, seq = ?
           WHERE room = ? AND id = ?`,
        )
        .run(seq, room, id);
      return merged;
    })();
  }

  getMessage(room: string, id: number): Message | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND id = ?')
      .get(room, id) as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /** Every pinned message, id-ascending — the strip hydrates from this whole
   *  set (pins are few) so a pin older than the loaded page still shows. */
  listPinnedMessages(room: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND pinned = 1 ORDER BY id')
      .all(room) as MessageRow[];
    return rows.map(messageFromRow);
  }

  /** Engine-reported context window, persisted so gauge estimates outlive
   *  restarts (daemon-internal; not part of the protocol Member shape). */
  getMemberContextWindow(room: string, id: string): number | undefined {
    const row = this.db
      .prepare('SELECT context_window FROM members WHERE room = ? AND id = ?')
      .get(room, id) as { context_window: number | null } | undefined;
    return row?.context_window ?? undefined;
  }

  setMemberContextWindow(room: string, id: string, contextWindow: number | undefined): void {
    this.db
      .prepare('UPDATE members SET context_window = ? WHERE room = ? AND id = ?')
      .run(contextWindow ?? null, room, id);
  }

  // harn:assume durable-room-summaries-stream-and-fallback ref=durable-room-summary
  /** Newest message in a room — the rail preview's single source. */
  latestMessage(room: string, options: { ignoreAcks?: boolean } = {}): Message | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE room = ? AND (? = 0 OR ack = 0)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(room, options.ignoreAcks ? 1 : 0) as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /** Legacy caller-cursor arithmetic retained until every client opts into
   *  durable room support. */
  countMessagesAfter(room: string, afterId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE room = ? AND id > ?')
      .get(room, afterId) as { n: number };
    return row.n;
  }
  // harn:end durable-room-summaries-stream-and-fallback

  // harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-storage
  getRoomReadSeq(room: string, memberId: string): number {
    const member = this.getMember(room, memberId);
    if (member?.kind !== 'human') throw new Error(`no human member ${memberId} in ${room}`);
    const row = this.db.prepare(
      'SELECT read_seq FROM room_read_cursors WHERE room = ? AND member_id = ?',
    ).get(room, memberId) as { read_seq: number } | undefined;
    if (!row) throw new Error(`human member ${memberId} has no room read cursor`);
    return row.read_seq;
  }

  markRoomRead(
    room: string,
    memberId: string,
    throughSeq: number,
  ): { read_seq: number; deliveries: Delivery[] } {
    return this.db.transaction(() => {
      if (!Number.isInteger(throughSeq) || throughSeq < 0) {
        throw new Error('room read seq must be a non-negative integer');
      }
      const roomSeq = this.currentSeq(room);
      if (throughSeq > roomSeq) {
        throw new Error(`room read seq ${throughSeq} is ahead of current seq ${roomSeq}`);
      }
      const previous = this.getRoomReadSeq(room, memberId);
      const readSeq = Math.max(previous, throughSeq);
      if (readSeq > previous) {
        this.db.prepare(
          `UPDATE room_read_cursors SET read_seq = ?, updated_ts = ?
           WHERE room = ? AND member_id = ?`,
        ).run(readSeq, new Date().toISOString(), room, memberId);
      }

      const candidates = this.db.prepare(
        `SELECT deliveries.id
         FROM deliveries
         JOIN messages ON messages.room = deliveries.room
          AND messages.id = deliveries.message_id
         WHERE deliveries.room = ?
           AND deliveries.recipient = ?
           AND deliveries.state = 'consumed'
           AND deliveries.read_ts IS NULL
           AND messages.seq <= ?
         ORDER BY deliveries.queue_seq, deliveries.id`,
      ).all(room, memberId, readSeq) as { id: string }[];
      const readTs = new Date().toISOString();
      const deliveries = candidates.map(({ id }) =>
        this.updateDelivery(room, id, { read_ts: readTs }));
      return { read_seq: readSeq, deliveries };
    })();
  }
  // harn:end human-room-read-cursors-are-durable-and-monotonic

  // harn:assume substantive-output-messages-drive-unread ref=message-activity-storage
  countUnreadMessages(room: string, memberId: string): number {
    const readSeq = this.getRoomReadSeq(room, memberId);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n
       FROM messages
       WHERE room = ?
         AND deleted = 0
         AND activity_seq IS NOT NULL
         AND activity_seq > ?
         AND author <> ?`,
    ).get(room, readSeq, memberId) as { n: number };
    return row.n;
  }
  // harn:end substantive-output-messages-drive-unread

  // harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-projection
  // harn:assume actionable-inbox-clears-on-read-or-reply ref=actionable-inbox-projection
  private actionableInbox(room: string, memberId: string): RoomInboxItem[] {
    const rows = this.db.prepare(
      `SELECT deliveries.*
       FROM deliveries
       JOIN messages ON messages.room = deliveries.room
        AND messages.id = deliveries.message_id
       WHERE deliveries.room = ?
         AND deliveries.recipient = ?
         AND deliveries.state = 'consumed'
         AND deliveries.read_ts IS NULL
         AND messages.deleted = 0
         AND (
           messages.kind IN ('ask', 'approval')
           OR EXISTS (
             SELECT 1 FROM json_each(messages.mentions) AS mention
             WHERE json_extract(mention.value, '$.member_id') = ?
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages AS reply
           WHERE reply.room = messages.room
             AND reply.reply_to = messages.id
             AND reply.author = ?
             AND reply.deleted = 0
         )
       ORDER BY deliveries.queue_seq DESC, deliveries.id DESC`,
    ).all(room, memberId, memberId, memberId) as DeliveryRow[];

    return rows.flatMap((row) => {
      const delivery = deliveryFromRow(row);
      const message = this.getMessage(room, delivery.message_id);
      if (!message) return [];
      const author = this.getMember(room, message.author);
      if (!author) return [];
      return [{
        delivery,
        author_id: author.id,
        author_handle: author.handle,
        author_kind: author.kind,
        message_kind: message.kind,
        preview: (message.body.split('\n', 1)[0] ?? '').slice(0, 140),
        ts: message.ts,
      } satisfies RoomInboxItem];
    });
  }
  // harn:end actionable-inbox-clears-on-read-or-reply

  roomSupport(room: string, memberId: string): RoomSupport {
    const viewer = this.getMember(room, memberId);
    if (viewer?.kind !== 'human') throw new Error(`no human member ${memberId} in ${room}`);
    const roomRow = this.getRoom(room);
    if (!roomRow) throw new Error(`no such room: ${room}`);
    const members = this.listMembers(room);
    const latest = this.latestMessage(room, { ignoreAcks: true });
    const latestRun = this.listRunMessages(room, { limit: 1 })[0];
    const latestAuthor = latest ? this.getMember(room, latest.author) : undefined;
    const latestRunAuthor = latestRun
      ? this.getMember(room, latestRun.author)
      : undefined;
    const working = members.some(
      (member) => member.kind === 'agent'
        && (member.state === 'running' || member.state === 'queued'),
    );

    const activeRows = this.db.prepare(
      `SELECT * FROM messages
       WHERE room = ? AND deleted = 0 AND kind = 'run'
         AND json_extract(run, '$.status') = 'running'
       ORDER BY id`,
    ).all(room) as MessageRow[];
    const interactionRows = this.db.prepare(
      `SELECT messages.*
       FROM pending_interactions
       JOIN messages ON messages.room = pending_interactions.room
        AND messages.id = pending_interactions.message_id
       WHERE pending_interactions.room = ?
         AND pending_interactions.state = 'pending'
         AND messages.deleted = 0
         AND EXISTS (
           SELECT 1 FROM json_each(pending_interactions.targets) AS target
           WHERE target.value = ?
         )
       ORDER BY messages.id`,
    ).all(room, memberId) as MessageRow[];

    return RoomSupportSchema.parse({
      room,
      summary: {
        id: roomRow.id,
        name: roomRow.name,
        created_ts: roomRow.created_ts,
        color: roomRow.config.color,
        working,
        attention: !working
          && latestRun?.run?.status === 'failed'
          && latestRunAuthor?.kind === 'agent'
          && latestRunAuthor.state === 'dead',
        ...(latest !== undefined && {
          latest: {
            id: latest.id,
            ts: latest.ts,
            kind: latest.kind,
            author_handle: latestAuthor?.handle ?? '',
            author_kind: latestAuthor?.kind ?? 'human',
            preview: (latest.body.split('\n', 1)[0] ?? '').slice(0, 140),
          },
        }),
        unread: this.countUnreadMessages(room, memberId),
      },
      latest_finalized_agent_id: this.latestFinalizedAgentAuthor(room),
      active_runs: activeRows.map(messageFromRow),
      interactions: interactionRows.map(messageFromRow),
      inbox: this.actionableInbox(room, memberId),
    });
  }
  // harn:end room-support-is-bounded-recipient-scoped-state

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

  // harn:assume run-evidence-search-is-bounded-and-redacted ref=bounded-run-message-listing
  listRunMessages(
    room: string,
    opts: { limit?: number; author?: string } = {},
  ): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE room = ? AND kind = 'run' AND run IS NOT NULL
           AND (? IS NULL OR author = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(room, opts.author ?? null, opts.author ?? null, opts.limit ?? 50) as MessageRow[];
    return rows.map(messageFromRow);
  }
  // harn:end run-evidence-search-is-bounded-and-redacted

  // harn:assume member-status-is-bounded-and-identity-safe ref=bounded-live-post-listing
  listChatMessagesByAuthorWithin(
    room: string,
    author: string,
    startedTs: string,
    endedTs: string | undefined,
    limit = 5,
  ): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE room = ? AND author = ? AND kind = 'chat' AND ts >= ?
           AND (? IS NULL OR ts <= ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(room, author, startedTs, endedTs ?? null, endedTs ?? null, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }
  // harn:end member-status-is-bounded-and-identity-safe

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

  // harn:assume collaboration-groups-are-durable-state ref=collaboration-store-projection
  createDelivery(
    room: string,
    delivery: {
      message_id: number;
      recipient: string;
      target?: ScopedMemberTarget;
      state?: Delivery['state'];
      payload_snapshot?: string;
      hop_count?: number;
      group_id?: string;
      group_round?: number;
    },
  ): Delivery {
    return this.db.transaction(() => {
      // A stored target is an execution identity, not a hint. Validate the
      // complete stable tuple while the delivery is still new; stale queued
      // rows are settled by the daemon and never silently re-resolved.
      if (delivery.target !== undefined && !this.routingTargetIsActive(delivery.target, room)) {
        throw new Error(
          `qualified delivery target is not active: ${delivery.target.alias}:@${delivery.target.handle}`,
        );
      }
      const nextQueueSeq = this.db
        .prepare('SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM deliveries')
        .get() as { seq: number };
      const validated = DeliverySchema.parse({
        id: randomUUID(),
        room,
        message_id: delivery.message_id,
        recipient: delivery.recipient,
        target: delivery.target,
        state: delivery.state ?? 'queued',
        hop_count: delivery.hop_count ?? 0,
        group_id: delivery.group_id,
        group_round: delivery.group_round,
        ts: new Date().toISOString(),
      });
      this.db
        .prepare(
          `INSERT INTO deliveries (id, room, message_id, recipient, target_worktree_id,
             target_conversation_id, target_alias, target_handle, state, attempt_count,
             batch_id, run_msg_id, read_ts, interaction_resolved_ts, payload_snapshot,
             process_id, process_group_id, hop_count, queue_seq, group_id, group_round, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.id,
          room,
          validated.message_id,
          validated.recipient,
          validated.target?.worktree_id ?? null,
          validated.target?.conversation_id ?? null,
          validated.target?.alias ?? null,
          validated.target?.handle ?? null,
          validated.state,
          validated.attempt_count,
          orNull(validated.batch_id),
          orNull(validated.run_msg_id),
          orNull(validated.read_ts),
          orNull(validated.interaction_resolved_ts),
          orNull(delivery.payload_snapshot),
          null,
          null,
          validated.hop_count ?? 0,
          nextQueueSeq.seq,
          orNull(validated.group_id),
          orNull(validated.group_round),
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
  // harn:end collaboration-groups-are-durable-state

  updateDelivery(
    room: string,
    deliveryId: string,
    patch: Partial<Pick<Delivery,
      'state' | 'attempt_count' | 'batch_id' | 'run_msg_id' | 'read_ts' | 'steered_ts' |
      'interaction_resolved_ts'>>,
  ): Delivery {
    return this.db.transaction(() => {
      const existing = this.getDelivery(room, deliveryId);
      if (!existing) throw new Error(`no such delivery: ${deliveryId}`);
      const merged = DeliverySchema.parse({ ...existing, ...patch });
      this.db
        .prepare(
          `UPDATE deliveries SET state = ?, attempt_count = ?, batch_id = ?,
             run_msg_id = ?, read_ts = ?, steered_ts = ?, interaction_resolved_ts = ?
           WHERE room = ? AND id = ?`,
        )
        .run(
          merged.state,
          merged.attempt_count,
          orNull(merged.batch_id),
          orNull(merged.run_msg_id),
          orNull(merged.read_ts),
          orNull(merged.steered_ts),
          orNull(merged.interaction_resolved_ts),
          room,
          deliveryId,
        );
      const recipient = this.getMember(room, merged.recipient);
      // Client-visible inbox records: human deliveries always; agent
      // deliveries once they need operator attention (held ⇄ released).
      if (
        recipient?.kind === 'human' ||
        merged.state === 'held' ||
        existing.state === 'held' ||
        merged.steered_ts !== existing.steered_ts
      ) {
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

  // harn:assume live-delivery-consumption-is-idempotent ref=consume-queued-transaction
  consumeQueuedDelivery(
    room: string,
    deliveryId: string,
    recipientId: string,
  ): { delivery: Delivery; message: Message } {
    return this.db.transaction(() => {
      const existing = this.getDelivery(room, deliveryId);
      if (!existing) throw new Error(`no such delivery: ${deliveryId}`);
      if (existing.recipient !== recipientId) {
        throw new Error(`delivery ${deliveryId} is not addressed to member ${recipientId}`);
      }
      this.db
        .prepare(
          `UPDATE deliveries SET state = 'consumed'
           WHERE room = ? AND id = ? AND recipient = ? AND state = 'queued'`,
        )
        .run(room, deliveryId, recipientId);
      const delivery = this.getDelivery(room, deliveryId)!;
      const message = this.getMessage(room, delivery.message_id);
      if (!message) throw new Error(`delivery ${deliveryId} has no source message`);
      return { delivery, message };
    })();
  }
  // harn:end live-delivery-consumption-is-idempotent

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

  // harn:assume target-member-turns-serialize-across-origins ref=cross-origin-delivery-queue
  /** Durable FIFO across every origin conversation for one target member. */
  listDeliveriesForTarget(
    targetRoom: string,
    memberId: string,
    filter: { state?: Delivery['state'] } = {},
  ): Delivery[] {
    const rows = this.db.prepare(
      `SELECT * FROM deliveries
       WHERE (
         (target_conversation_id = ? AND recipient = ?)
         OR (target_conversation_id IS NULL AND room = ? AND recipient = ?)
       )
       AND (? IS NULL OR state = ?)
       ORDER BY queue_seq, id`,
    ).all(
      targetRoom,
      memberId,
      targetRoom,
      memberId,
      filter.state ?? null,
      filter.state ?? null,
    ) as DeliveryRow[];
    return rows.map(deliveryFromRow);
  }
  // harn:end target-member-turns-serialize-across-origins

  // harn:assume agent-authority-follows-one-active-invocation ref=agent-active-invocation-resolution
  /** Durable cross-origin invocations used to restore credential scope after a restart. */
  listActiveInvocations(memberId: string): {
    originRoom: string;
    targetRoom: string;
    target: ScopedMemberTarget;
  }[] {
    const found: {
      originRoom: string;
      targetRoom: string;
      target: ScopedMemberTarget;
    }[] = [];
    const seen = new Set<string>();
    for (const room of this.listRooms()) {
      for (const delivery of this.listDeliveries(room.id, { state: 'delivering' })) {
        const target = delivery.target;
        if (target === undefined || target.member_id !== memberId || delivery.run_msg_id === undefined) continue;
        if (!this.routingTargetIsActive(target, room.id)) continue;
        const run = this.getMessage(room.id, delivery.run_msg_id);
        if (run?.kind !== 'run' || run.run?.status !== 'running') continue;
        const key = `${room.id}:${run.id}:${target.worktree_id}:${target.conversation_id}:${target.member_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ originRoom: room.id, targetRoom: target.conversation_id, target });
      }
    }
    return found;
  }
  // harn:end agent-authority-follows-one-active-invocation

  // harn:assume turn-start-transactional ref=atomic-turn-start
  /** Creates/reuses the run and binds the complete batch in one transaction. */
  beginTurn(
    room: string,
    opts: {
      memberId: string;
      /** Member home conversation; `room` remains the visible origin. */
      targetRoom?: string;
      authorTarget?: ScopedMemberTarget;
      deliveryIds: string[];
      startedTs: string;
      model?: string;
      eventsRef: (messageId: number) => string;
      reuseRunMsgId?: number;
      resumeHeldRun?: boolean;
    },
  ): AtomicTurnStart | undefined {
    return this.db.transaction(() => {
      // harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-turn-orchestration
      const targetRoom = opts.targetRoom ?? room;
      // harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-admission-guard
      // Admission is decided HERE, inside the transaction that binds them — not by a
      // filter that ran in an earlier statement. Between selecting a delivery and
      // admitting it, anything may have consumed it: the end of a turn, the removal of
      // the member, or (in live-collab) the agent itself. Trusting the earlier filter is
      // how a consumed delivery gets resurrected and handed to an agent as work.
      //
      // A FRESH turn admits only what is `queued`. Nothing else may be swept into it: a
      // held delivery stays held, and a consumed one is gone.
      //
      // A REUSED run — a reconciled retry, or an ambiguous turn the operator has just
      // released — re-admits the deliveries ALREADY BOUND TO THAT RUN, whatever state the
      // interruption left them in: `delivering` after a crash, `held` after an ambiguous
      // turn was parked. They are not being swept in; this run already claimed them, and
      // the operator asked for the retry. Restricting admission to `queued` alone would
      // silently kill both crash recovery and release_hold.
      //
      // `consumed` is admissible in NO case. That is the whole point: it is the state a
      // delivery reaches when its work is done, or when the member it was addressed to no
      // longer exists, and resurrecting it hands an agent work that was already taken.
      const boundToReusedRun = (delivery: Delivery): boolean =>
        opts.reuseRunMsgId !== undefined && delivery.run_msg_id === opts.reuseRunMsgId;
      const admissible = opts.deliveryIds
        .map((deliveryId) => {
          const delivery = this.getDelivery(room, deliveryId);
          if (!delivery) throw new Error(`no such delivery: ${deliveryId}`);
          if (delivery.recipient !== opts.memberId) {
            throw new Error(`delivery ${deliveryId} does not belong to member ${opts.memberId}`);
          }
          if (targetRoom !== room && delivery.target?.conversation_id !== targetRoom) {
            throw new Error(`delivery ${deliveryId} is not addressed to target conversation ${targetRoom}`);
          }
          return delivery;
        })
        .filter((delivery) =>
          delivery.state !== 'consumed' &&
          (delivery.target === undefined || this.routingTargetIsActive(delivery.target, room)) &&
          (delivery.state === 'queued' || boundToReusedRun(delivery)),
        );

      // harn:assume unresolved-delivery-fences-fresh-member-turns ref=durable-delivery-turn-fence
      // The in-memory inflight guard cannot survive a process boundary. Refuse a
      // FRESH run while this member still owns another durably active attempt;
      // runtime/boot reconciliation moves that attempt to held or consumed, and
      // an explicit reused-run recovery is allowed to reclaim its own binding.
      const ownsUnresolvedAttempt = opts.reuseRunMsgId === undefined && this
        .listDeliveriesForTarget(targetRoom, opts.memberId, { state: 'delivering' })
        .some((delivery) => {
          if (delivery.run_msg_id === undefined) return false;
          const run = this.getMessage(delivery.room, delivery.run_msg_id);
          return run?.kind === 'run' && run.run?.status === 'running';
        });
      if (ownsUnresolvedAttempt) return undefined;
      // harn:end unresolved-delivery-fences-fresh-member-turns

      // harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-start-with-nothing-admissible
      // Nothing left to say. An empty run message would be a defect of its own, so the
      // turn does not begin at all — no message, no attempt, and the caller idles the
      // member.
      if (admissible.length === 0) return undefined;
      // harn:end only-an-admissible-delivery-becomes-delivering

      let runMessage: Message;
      if (opts.reuseRunMsgId !== undefined) {
        let existing = this.getMessage(room, opts.reuseRunMsgId);
        const mayResumeHeld = opts.resumeHeldRun === true
          && existing?.kind === 'run'
          && existing.run?.status === 'interrupted'
          && admissible.every((delivery) => delivery.state === 'held' && delivery.run_msg_id === existing!.id);
        if (
          !existing?.run ||
          existing.kind !== 'run' ||
          existing.author !== opts.memberId ||
          (existing.run.status !== 'running' && !mayResumeHeld)
        ) {
          throw new Error(`run #${opts.reuseRunMsgId} is not reusable`);
        }
        // harn:assume held-recovery-runs-are-inactive-until-release ref=held-run-inactive-transition
        if (mayResumeHeld) {
          existing = this.updateMessage(room, existing.id, {
            run: {
              ...existing.run,
              status: 'running',
              ended_ts: undefined,
              error: undefined,
              stalled_since: undefined,
            },
          }, { activity: 'defer' });
        }
        // harn:end held-recovery-runs-are-inactive-until-release
        if (existing.run === undefined) throw new Error(`run #${opts.reuseRunMsgId} lost its run state`);
        const reusableRun = existing.run;
        runMessage = reusableRun.output_mode === 'messages'
          ? existing
          : this.updateMessage(room, existing.id, {
              run: { ...reusableRun, output_mode: 'messages' },
            }, { activity: 'defer' });
      } else {
        const posted = this.postMessage(room, {
          author: opts.memberId,
          kind: 'run',
          body: '',
          author_target: opts.authorTarget,
        });
        // harn:assume resolved-run-cost-estimates-are-finalization-snapshots ref=resolved-run-estimate-schema
        runMessage = this.updateMessage(room, posted.id, {
          run: {
            status: 'running',
            started_ts: opts.startedTs,
            ...(opts.model !== undefined && { model: opts.model }),
            tool_calls: 0,
            events_ref: opts.eventsRef(posted.id),
            output_mode: 'messages',
          },
        });
        // harn:end resolved-run-cost-estimates-are-finalization-snapshots
      }

      const deliveries = admissible.map((delivery) => {
        const updated = this.updateDelivery(room, delivery.id, {
          state: 'delivering',
          attempt_count: delivery.attempt_count + 1,
          run_msg_id: runMessage.id,
          batch_id: `batch-${runMessage.id}`,
        });
        this.setDeliveryAttemptProcess(room, [delivery.id], undefined);
        return updated;
      });
      // harn:end only-an-admissible-delivery-becomes-delivering
      // harn:end cross-worktree-output-stays-in-origin
      return { runMessage, deliveries };
    })();
  }
  // harn:end turn-start-transactional

  // harn:assume turn-output-finalization-is-atomic ref=atomic-turn-finalization
  /** Commits lifecycle truth, every output row, custody, accounting, and fanout together. */
  completeTurn(
    room: string,
    opts: {
      runMsgId: number;
      /** Runtime home for the target member; visible output remains in `room`. */
      targetRoom?: string;
      message: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run' | 'ack'>>;
      outputs: TurnOutputPatch[];
      resultMessageId: number;
      inputDeliveryIds: string[];
      memberId: string;
      memberPatch: Partial<Omit<Member, 'id' | 'kind'>>;
      meterDay: string;
      meterDelta: {
        turns?: number;
        cost_usd?: number;
        estimated_cost_usd?: number;
        input_tokens?: number;
        output_tokens?: number;
        uncosted_tokens?: number;
      };
      fanout: FanoutDelivery[];
      participantTerminal?: {
        deliveryId: string;
        status: Exclude<CollaborationTerminalStatus, 'skipped'>;
        completedTs: string;
      };
      collaboration?: RoutedMessagePlan['collaboration'];
    },
  ): AtomicTurnCompletion {
    return this.db.transaction(() => {
      // harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-origin-transaction
      const targetRoom = opts.targetRoom ?? room;
      const rootOutput = opts.outputs.find((output) => output.id === opts.runMsgId);
      if (!rootOutput) throw new Error(`turn #${opts.runMsgId} has no root output patch`);
      const message = this.updateMessage(room, opts.runMsgId, {
        ...opts.message,
        body: rootOutput.body,
        mentions: rootOutput.mentions,
        refs: rootOutput.refs,
        ledger_refs: rootOutput.ledger_refs,
      }, { activity: rootOutput.substantive && rootOutput.ack !== true ? 'force' : 'defer' });
      const outputMessages = [message];
      for (const output of opts.outputs) {
        if (output.id === opts.runMsgId) continue;
        const current = this.getMessage(room, output.id);
        if (current?.run_parent_id !== opts.runMsgId) {
          throw new Error(`#${output.id} is not a continuation of turn #${opts.runMsgId}`);
        }
        outputMessages.push(this.updateMessage(room, output.id, {
          body: output.body,
          mentions: output.mentions,
          refs: output.refs,
          ledger_refs: output.ledger_refs,
          ack: output.ack,
        }, { activity: output.substantive && output.ack !== true ? 'force' : 'defer' }));
      }
      const referenced = new Set(opts.outputs.map((output) => output.id));
      for (const continuation of this.listRunContinuations(room, opts.runMsgId)) {
        if (referenced.has(continuation.id) || continuation.deleted === true) continue;
        outputMessages.push(this.deleteMessage(room, continuation.id));
      }
      if (!referenced.has(opts.resultMessageId)) {
        throw new Error(`turn #${opts.runMsgId} result #${opts.resultMessageId} is not journal-owned`);
      }
      for (const deliveryId of opts.inputDeliveryIds) {
        this.updateDelivery(room, deliveryId, { state: 'consumed' });
      }
      const member = this.updateMember(targetRoom, opts.memberId, opts.memberPatch);
      this.promoteAgentUsageBaseline(targetRoom, opts.memberId, opts.runMsgId);
      const meter = this.bumpMeter(targetRoom, opts.meterDay, opts.meterDelta);
      const deliveries = opts.fanout.map((delivery) =>
        this.createDelivery(room, {
          message_id: opts.resultMessageId,
          recipient: delivery.recipient,
          state: delivery.state,
          payload_snapshot: delivery.payload_snapshot,
          hop_count: delivery.hop_count,
          target: delivery.target,
        }),
      );
      if (opts.participantTerminal !== undefined) {
        this.recordCollaborationParticipantTerminal(room, {
          deliveryId: opts.participantTerminal.deliveryId,
          status: opts.participantTerminal.status,
          resultMessageId: opts.resultMessageId,
          completedTs: opts.participantTerminal.completedTs,
        });
      }
      const collaboration = opts.collaboration === undefined
        ? undefined
        : this.createCollaborationGroup(room, {
            groupId: opts.collaboration.groupId,
            rootMessageId: opts.resultMessageId,
            participants: opts.collaboration.participants,
          });
      if (collaboration) deliveries.push(...collaboration.deliveries);
      return {
        message,
        outputMessages: outputMessages.sort((left, right) => left.id - right.id),
        member,
        meter,
        deliveries,
        collaboration,
      };
    })();
  }
  // harn:end turn-output-finalization-is-atomic

  getCollaborationGroup(room: string, groupId: string): CollaborationGroup | undefined {
    const row = this.db.prepare(
      'SELECT * FROM collaboration_groups WHERE room = ? AND id = ?',
    ).get(room, groupId) as CollaborationGroupRow | undefined;
    return row ? collaborationGroupFromRow(row) : undefined;
  }

  getCollaborationGroupByRoot(
    room: string,
    rootMessageId: number,
  ): CollaborationGroup | undefined {
    const row = this.db.prepare(
      'SELECT * FROM collaboration_groups WHERE room = ? AND root_message_id = ?',
    ).get(room, rootMessageId) as CollaborationGroupRow | undefined;
    return row ? collaborationGroupFromRow(row) : undefined;
  }

  listCollaborationGroups(
    room: string,
    state?: CollaborationGroup['state'],
  ): CollaborationGroup[] {
    const rows = this.db.prepare(
      `SELECT * FROM collaboration_groups
       WHERE room = ? AND (? IS NULL OR state = ?)
       ORDER BY created_ts, id`,
    ).all(room, state ?? null, state ?? null) as CollaborationGroupRow[];
    return rows.map(collaborationGroupFromRow);
  }

  getCollaborationRound(
    room: string,
    groupId: string,
    roundNumber: number,
  ): CollaborationRound | undefined {
    const row = this.db.prepare(
      `SELECT collaboration_rounds.* FROM collaboration_rounds
       JOIN collaboration_groups ON collaboration_groups.id = collaboration_rounds.group_id
       WHERE collaboration_groups.room = ?
         AND collaboration_rounds.group_id = ?
         AND collaboration_rounds.round_number = ?`,
    ).get(room, groupId, roundNumber) as CollaborationRoundRow | undefined;
    return row ? collaborationRoundFromRow(row) : undefined;
  }

  listCollaborationRounds(room: string, groupId: string): CollaborationRound[] {
    const rows = this.db.prepare(
      `SELECT collaboration_rounds.* FROM collaboration_rounds
       JOIN collaboration_groups ON collaboration_groups.id = collaboration_rounds.group_id
       WHERE collaboration_groups.room = ? AND collaboration_rounds.group_id = ?
       ORDER BY collaboration_rounds.round_number`,
    ).all(room, groupId) as CollaborationRoundRow[];
    return rows.map(collaborationRoundFromRow);
  }

  listCollaborationParticipants(
    room: string,
    groupId: string,
    roundNumber: number,
  ): CollaborationParticipant[] {
    const rows = this.db.prepare(
      `SELECT collaboration_participants.* FROM collaboration_participants
       JOIN collaboration_groups ON collaboration_groups.id = collaboration_participants.group_id
       WHERE collaboration_groups.room = ?
         AND collaboration_participants.group_id = ?
         AND collaboration_participants.round_number = ?
       ORDER BY collaboration_participants.ordinal`,
    ).all(room, groupId, roundNumber) as CollaborationParticipantRow[];
    return rows.map(collaborationParticipantFromRow);
  }

  findCollaborationParticipantByDelivery(
    room: string,
    deliveryId: string,
  ): CollaborationParticipant | undefined {
    const row = this.db.prepare(
      `SELECT collaboration_participants.* FROM collaboration_participants
       JOIN collaboration_groups ON collaboration_groups.id = collaboration_participants.group_id
       WHERE collaboration_groups.room = ? AND collaboration_participants.delivery_id = ?`,
    ).get(room, deliveryId) as CollaborationParticipantRow | undefined;
    return row ? collaborationParticipantFromRow(row) : undefined;
  }

  getCollaborationRoundProjection(
    room: string,
    groupId: string,
    roundNumber: number,
  ): CollaborationRoundProjection | undefined {
    const group = this.getCollaborationGroup(room, groupId);
    const round = this.getCollaborationRound(room, groupId, roundNumber);
    if (!group || !round) return undefined;
    const participants = this.listCollaborationParticipants(room, groupId, roundNumber);
    const deliveries = participants.map((participant) => {
      const delivery = this.getDelivery(room, participant.delivery_id);
      if (
        !delivery ||
        delivery.group_id !== groupId ||
        delivery.group_round !== roundNumber ||
        delivery.recipient !== participant.member_id
      ) {
        throw new Error(`invalid collaboration delivery association: ${participant.delivery_id}`);
      }
      return delivery;
    });
    return { group, round, participants, deliveries };
  }

  updateCollaborationGroup(
    room: string,
    groupId: string,
    patch: Partial<Pick<CollaborationGroup, 'state' | 'completed_ts'>>,
  ): CollaborationGroup {
    const existing = this.getCollaborationGroup(room, groupId);
    if (!existing) throw new Error(`no such collaboration group: ${groupId}`);
    const merged = CollaborationGroupSchema.parse({ ...existing, ...patch });
    this.db.prepare(
      'UPDATE collaboration_groups SET state = ?, completed_ts = ? WHERE room = ? AND id = ?',
    ).run(merged.state, orNull(merged.completed_ts), room, groupId);
    return merged;
  }

  updateCollaborationRound(
    room: string,
    groupId: string,
    roundNumber: number,
    patch: Partial<Pick<CollaborationRound, 'state' | 'released_ts'>>,
  ): CollaborationRound {
    const existing = this.getCollaborationRound(room, groupId, roundNumber);
    if (!existing) throw new Error(`no such collaboration round: ${groupId}/${roundNumber}`);
    const merged = CollaborationRoundSchema.parse({ ...existing, ...patch });
    this.db.prepare(
      `UPDATE collaboration_rounds SET state = ?, released_ts = ?
       WHERE group_id = ? AND round_number = ?`,
    ).run(merged.state, orNull(merged.released_ts), groupId, roundNumber);
    return merged;
  }

  updateCollaborationParticipant(
    room: string,
    groupId: string,
    roundNumber: number,
    memberId: string,
    patch: Partial<Pick<CollaborationParticipant,
      'terminal_status' | 'result_message_id' | 'completed_ts'>>,
  ): CollaborationParticipant {
    const existing = this.listCollaborationParticipants(room, groupId, roundNumber)
      .find((participant) => participant.member_id === memberId);
    if (!existing) {
      throw new Error(`no such collaboration participant: ${groupId}/${roundNumber}/${memberId}`);
    }
    const merged = CollaborationParticipantSchema.parse({ ...existing, ...patch });
    this.db.prepare(
      `UPDATE collaboration_participants
       SET terminal_status = ?, result_message_id = ?, completed_ts = ?
       WHERE group_id = ? AND round_number = ? AND member_id = ?`,
    ).run(
      orNull(merged.terminal_status),
      orNull(merged.result_message_id),
      orNull(merged.completed_ts),
      groupId,
      roundNumber,
      memberId,
    );
    return merged;
  }

  // harn:assume group-participant-terminality-commits-with-the-turn ref=collaboration-turn-finalization
  recordCollaborationParticipantTerminal(
    room: string,
    opts: {
      deliveryId: string;
      status: Exclude<CollaborationTerminalStatus, 'skipped'>;
      resultMessageId: number;
      completedTs: string;
    },
  ): CollaborationParticipant {
    const participant = this.findCollaborationParticipantByDelivery(room, opts.deliveryId);
    if (!participant) throw new Error(`delivery ${opts.deliveryId} is not a collaboration participant`);
    if (participant.terminal_status !== undefined) {
      if (
        participant.terminal_status !== opts.status ||
        participant.result_message_id !== opts.resultMessageId
      ) {
        throw new Error(`collaboration participant ${opts.deliveryId} already has a different result`);
      }
      return participant;
    }
    return this.updateCollaborationParticipant(
      room,
      participant.group_id,
      participant.round_number,
      participant.member_id,
      {
        terminal_status: opts.status,
        result_message_id: opts.resultMessageId,
        completed_ts: opts.completedTs,
      },
    );
  }

  recoverCollaborationParticipantTerminal(
    room: string,
    opts: {
      deliveryId: string;
      status: Exclude<CollaborationTerminalStatus, 'skipped'>;
      resultMessageId: number;
      completedTs: string;
    },
  ): { delivery: Delivery; participant: CollaborationParticipant } {
    return this.db.transaction(() => {
      const delivery = this.getDelivery(room, opts.deliveryId);
      if (!delivery) throw new Error(`no such delivery: ${opts.deliveryId}`);
      const consumed = delivery.state === 'consumed'
        ? delivery
        : this.updateDelivery(room, delivery.id, { state: 'consumed' });
      const participant = this.recordCollaborationParticipantTerminal(room, opts);
      return { delivery: consumed, participant };
    })();
  }
  // harn:end group-participant-terminality-commits-with-the-turn

  // harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-member-skip-transaction
  skipCollaborationParticipant(
    room: string,
    deliveryId: string,
    completedTs: string,
  ): { delivery: Delivery; participant: CollaborationParticipant } {
    return this.db.transaction(() => {
      const participant = this.findCollaborationParticipantByDelivery(room, deliveryId);
      if (!participant) throw new Error(`delivery ${deliveryId} is not a collaboration participant`);
      const delivery = this.getDelivery(room, deliveryId);
      if (!delivery) throw new Error(`no such delivery: ${deliveryId}`);
      if (participant.terminal_status !== undefined) return { delivery, participant };
      if (
        (delivery.state !== 'queued' && delivery.state !== 'held' && delivery.state !== 'consumed') ||
        delivery.run_msg_id !== undefined
      ) {
        throw new Error(`collaboration delivery ${deliveryId} already started`);
      }
      const consumed = delivery.state === 'consumed'
        ? delivery
        : this.updateDelivery(room, deliveryId, { state: 'consumed' });
      const skipped = this.updateCollaborationParticipant(
        room,
        participant.group_id,
        participant.round_number,
        participant.member_id,
        { terminal_status: 'skipped', completed_ts: completedTs },
      );
      return { delivery: consumed, participant: skipped };
    })();
  }

  private postSystemRefusalMessage(room: string, body: string): Message {
    const system = this.listMembers(room).find((member) => member.kind === 'system');
    if (system === undefined) throw new Error(`room ${room} has no system member`);
    return this.postMessage(room, { author: system.id, kind: 'system', body });
  }

  /**
   * Settle a stale scoped QUEUED/HELD delivery as one durable unit: its
   * consumed state, its group slot, and exactly one origin refusal commit
   * together. A repeat call after a crash finds nothing to transition and
   * posts nothing, so the refusal can never be lost or duplicated. Run-bound
   * rows belong to settleInvalidScopedAttempt instead.
   */
  settleStaleScopedDelivery(
    room: string,
    opts: { deliveryId: string; reason: string; settledTs: string },
  ): {
    delivery: Delivery;
    participant?: CollaborationParticipant;
    refusal?: Message;
    settled: boolean;
  } {
    return this.db.transaction(() => {
      const delivery = this.getDelivery(room, opts.deliveryId);
      if (!delivery) throw new Error(`no such delivery: ${opts.deliveryId}`);
      if (
        (delivery.state !== 'queued' && delivery.state !== 'held' && delivery.state !== 'consumed') ||
        delivery.run_msg_id !== undefined
      ) {
        throw new Error(`scoped delivery ${opts.deliveryId} already started; settle the attempt instead`);
      }
      const participant = delivery.group_id === undefined
        ? undefined
        : this.findCollaborationParticipantByDelivery(room, delivery.id);
      const settled = delivery.state !== 'consumed' ||
        (participant !== undefined && participant.terminal_status === undefined);
      if (!settled) {
        return {
          delivery,
          ...(participant !== undefined && { participant }),
          settled: false,
        };
      }
      const consumed = delivery.state === 'consumed'
        ? delivery
        : this.updateDelivery(room, delivery.id, { state: 'consumed' });
      const skipped = participant !== undefined && participant.terminal_status === undefined
        ? this.updateCollaborationParticipant(
            room,
            participant.group_id,
            participant.round_number,
            participant.member_id,
            { terminal_status: 'skipped', completed_ts: opts.settledTs },
          )
        : participant;
      const refusal = this.postSystemRefusalMessage(room, `qualified target refused: ${opts.reason}`);
      return {
        delivery: consumed,
        ...(skipped !== undefined && { participant: skipped }),
        refusal,
        settled: true,
      };
    })();
  }

  /**
   * Settle a stale scoped attempt whose work had already started — the boot
   * and retry seam: consume its bound delivery rows, interrupt run evidence
   * that has no remaining valid work, mark any group participant truthfully
   * `interrupted`, and append exactly one origin refusal, all in one
   * transaction. Idempotent: once nothing transitions there is nothing to
   * emit, so a repeated reconcile neither throws nor duplicates the refusal.
   */
  settleInvalidScopedAttempt(
    room: string,
    opts: { deliveryIds: string[]; reason: string; settledTs: string },
  ): {
    deliveries: Delivery[];
    participants: CollaborationParticipant[];
    runs: Message[];
    refusal?: Message;
    settled: boolean;
  } {
    return this.db.transaction(() => {
      if (opts.deliveryIds.length === 0) throw new Error('no scoped attempt deliveries to settle');
      const runIds = new Set<number>();
      let transitioned = false;
      const deliveries: Delivery[] = [];
      const participants: CollaborationParticipant[] = [];
      for (const deliveryId of opts.deliveryIds) {
        const delivery = this.getDelivery(room, deliveryId);
        if (!delivery) throw new Error(`no such delivery: ${deliveryId}`);
        if (delivery.run_msg_id !== undefined) runIds.add(delivery.run_msg_id);
        if (delivery.state === 'consumed') {
          deliveries.push(delivery);
        } else {
          transitioned = true;
          deliveries.push(this.updateDelivery(room, delivery.id, { state: 'consumed' }));
        }
        if (delivery.group_id === undefined) continue;
        const participant = this.findCollaborationParticipantByDelivery(room, delivery.id);
        if (participant === undefined || participant.terminal_status !== undefined) continue;
        participants.push(this.updateCollaborationParticipant(
          room,
          participant.group_id,
          participant.round_number,
          participant.member_id,
          { terminal_status: 'interrupted', completed_ts: opts.settledTs },
        ));
        transitioned = true;
      }
      const runs: Message[] = [];
      for (const runId of runIds) {
        const run = this.getMessage(room, runId);
        if (run?.kind !== 'run' || run.run?.status !== 'running') continue;
        // Interrupt only when no valid bound work remains: a partially stale
        // batch leaves its surviving rows to the normal recovery seam.
        const remaining = this.listDeliveries(room)
          .some((candidate) => candidate.run_msg_id === runId && candidate.state !== 'consumed');
        if (remaining) continue;
        runs.push(this.updateMessage(room, run.id, {
          body: '',
          mentions: [],
          refs: [],
          ledger_refs: [],
          run: {
            ...run.run,
            status: 'interrupted',
            ended_ts: opts.settledTs,
            stalled_since: undefined,
            final_text: undefined,
          },
        }));
        transitioned = true;
      }
      const refusal = transitioned
        ? this.postSystemRefusalMessage(room, `qualified target refused: ${opts.reason}`)
        : undefined;
      return {
        deliveries,
        participants,
        runs,
        ...(refusal !== undefined && { refusal }),
        settled: transitioned,
      };
    })();
  }
  // harn:end open-collaboration-groups-reconcile-without-resurrection

  // harn:assume collaboration-round-release-is-one-barrier ref=collaboration-round-release-transaction
  releaseCollaborationRound(
    room: string,
    opts: {
      groupId: string;
      roundNumber: number;
      releasedTs: string;
      nextParticipants: CollaborationRoundParticipantInput[];
    },
  ): CollaborationRoundRelease {
    return this.db.transaction((): CollaborationRoundRelease => {
      const projection = this.getCollaborationRoundProjection(
        room,
        opts.groupId,
        opts.roundNumber,
      );
      if (!projection) {
        throw new Error(`no such collaboration round: ${opts.groupId}/${opts.roundNumber}`);
      }
      if (projection.round.state !== 'collecting') {
        return { status: 'already_released', deliveries: [], projection };
      }
      if (projection.participants.some((participant) => participant.terminal_status === undefined)) {
        return { status: 'pending', deliveries: [], projection };
      }
      if (opts.nextParticipants.length === 0) {
        this.updateCollaborationRound(room, opts.groupId, opts.roundNumber, {
          state: 'closed',
          released_ts: opts.releasedTs,
        });
        this.updateCollaborationGroup(room, opts.groupId, {
          state: 'completed',
          completed_ts: opts.releasedTs,
        });
        return {
          status: 'closed',
          deliveries: [],
          projection: this.getCollaborationRoundProjection(
            room,
            opts.groupId,
            opts.roundNumber,
          )!,
        };
      }

      this.assertCollaborationParticipantInputShape(opts.nextParticipants, 1);
      this.assertActiveAgentParticipants(room, opts.nextParticipants);
      const next = this.materializeCollaborationRound(
        room,
        projection.group,
        opts.roundNumber + 1,
        opts.releasedTs,
        opts.nextParticipants,
      );
      this.updateCollaborationRound(room, opts.groupId, opts.roundNumber, {
        state: 'released',
        released_ts: opts.releasedTs,
      });
      return { status: 'released', deliveries: next.deliveries, projection: next };
    })();
  }

  /**
   * Close a terminal round/group and commit its one visible refusal in the
   * SAME transaction — the invalid-qualified barrier exit. The refusal is
   * created by the state transition itself, so repeated advancement or a
   * restart returns `already_released` and can never lose, duplicate, or
   * reorder the evidence. Returns the durable refusal row for emission.
   */
  closeCollaborationRoundWithRefusal(
    room: string,
    opts: {
      groupId: string;
      roundNumber: number;
      releasedTs: string;
      refusalBody: string;
    },
  ): { status: 'closed' | 'already_released' | 'pending'; refusal?: Message } {
    return this.db.transaction((): { status: 'closed' | 'already_released' | 'pending'; refusal?: Message } => {
      const projection = this.getCollaborationRoundProjection(room, opts.groupId, opts.roundNumber);
      if (!projection) {
        throw new Error(`no such collaboration round: ${opts.groupId}/${opts.roundNumber}`);
      }
      if (projection.round.state !== 'collecting') return { status: 'already_released' };
      if (projection.participants.some((participant) => participant.terminal_status === undefined)) {
        return { status: 'pending' };
      }
      this.updateCollaborationRound(room, opts.groupId, opts.roundNumber, {
        state: 'closed',
        released_ts: opts.releasedTs,
      });
      this.updateCollaborationGroup(room, opts.groupId, {
        state: 'completed',
        completed_ts: opts.releasedTs,
      });
      const refusal = this.postSystemRefusalMessage(room, opts.refusalBody);
      return { status: 'closed', refusal };
    })();
  }
  // harn:end collaboration-round-release-is-one-barrier

  // harn:assume group-round-creation-is-atomic-and-idempotent ref=collaboration-round-materialization
  private assertCollaborationParticipantInputShape(
    participants: CollaborationRoundParticipantInput[],
    minimum: number,
  ): void {
    if (participants.length < minimum) {
      throw new Error(`collaboration round requires at least ${minimum} participant(s)`);
    }
    const seen = new Set<string>();
    for (const participant of participants) {
      const identity = `${participant.target?.worktree_id ?? 'local'}:${participant.memberId}`;
      if (seen.has(identity)) {
        throw new Error(`duplicate collaboration participant: ${participant.memberId}`);
      }
      seen.add(identity);
      if (participant.state !== undefined && participant.state !== 'queued' && participant.state !== 'held') {
        throw new Error(`invalid initial collaboration delivery state: ${participant.state}`);
      }
    }
  }

  private assertActiveAgentParticipants(
    room: string,
    participants: CollaborationRoundParticipantInput[],
  ): void {
    for (const participant of participants) {
      const member = participant.target === undefined
        ? this.getMember(room, participant.memberId)
        : this.routingTargetRecord(participant.target, room)?.member;
      if (!member || member.kind !== 'agent' || member.removed_ts !== undefined) {
        throw new Error(`no active agent member: ${participant.memberId}`);
      }
      if (participant.target !== undefined && !this.routingTargetIsActive(participant.target, room)) {
        throw new Error(`qualified collaboration target is not active: ${participant.target.alias}:@${participant.target.handle}`);
      }
    }
  }

  private assertExistingCollaborationRound(
    projection: CollaborationRoundProjection,
    requested: CollaborationRoundParticipantInput[],
  ): CollaborationRoundProjection {
    const sameMembers = projection.participants.length === requested.length &&
      projection.participants.every(
        (participant, index) => {
          const requestedParticipant = requested[index]!;
          const delivery = projection.deliveries[index];
          return participant.member_id === requestedParticipant.memberId
            && delivery?.target?.worktree_id === requestedParticipant.target?.worktree_id
            && delivery?.target?.conversation_id === requestedParticipant.target?.conversation_id
            && delivery?.target?.alias === requestedParticipant.target?.alias
            && delivery?.target?.handle === requestedParticipant.target?.handle;
        },
      );
    const sameSnapshots = sameMembers && projection.deliveries.every(
      (delivery, index) =>
        this.getDeliveryPayloadSnapshot(delivery.room, delivery.id) === requested[index]!.payloadSnapshot,
    );
    if (!sameSnapshots) {
      throw new Error(
        `collaboration round ${projection.group.id}/${projection.round.round_number}` +
        ' already exists with different participants or payloads',
      );
    }
    return projection;
  }

  private materializeCollaborationRound(
    room: string,
    group: CollaborationGroup,
    roundNumber: number,
    createdTs: string,
    participants: CollaborationRoundParticipantInput[],
  ): CollaborationRoundProjection {
    const round = CollaborationRoundSchema.parse({
      group_id: group.id,
      round_number: roundNumber,
      state: 'collecting',
      created_ts: createdTs,
    });
    this.db.prepare(
      `INSERT INTO collaboration_rounds
         (group_id, round_number, state, created_ts, released_ts)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(round.group_id, round.round_number, round.state, round.created_ts, null);

    for (const [ordinal, input] of participants.entries()) {
      const delivery = this.createDelivery(room, {
        message_id: group.root_message_id,
        recipient: input.memberId,
        state: input.state,
        payload_snapshot: input.payloadSnapshot,
        hop_count: input.hopCount,
        target: input.target,
        group_id: group.id,
        group_round: roundNumber,
      });
      const participant = CollaborationParticipantSchema.parse({
        group_id: group.id,
        round_number: roundNumber,
        ordinal,
        member_id: input.memberId,
        delivery_id: delivery.id,
      });
      this.db.prepare(
        `INSERT INTO collaboration_participants
           (group_id, round_number, ordinal, member_id, delivery_id,
            terminal_status, result_message_id, completed_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        participant.group_id,
        participant.round_number,
        participant.ordinal,
        participant.member_id,
        participant.delivery_id,
        null,
        null,
        null,
      );
    }
    return this.getCollaborationRoundProjection(room, group.id, roundNumber)!;
  }

  createCollaborationGroup(
    room: string,
    opts: {
      groupId?: string;
      rootMessageId: number;
      participants: CollaborationRoundParticipantInput[];
      createdTs?: string;
    },
  ): CollaborationRoundProjection {
    return this.db.transaction(() => {
      this.assertCollaborationParticipantInputShape(opts.participants, 2);
      const existing = this.getCollaborationGroupByRoot(room, opts.rootMessageId);
      if (existing) {
        const projection = this.getCollaborationRoundProjection(room, existing.id, 1)!;
        return this.assertExistingCollaborationRound(projection, opts.participants);
      }
      if (!this.getMessage(room, opts.rootMessageId)) {
        throw new Error(`no such collaboration root message: #${opts.rootMessageId}`);
      }
      this.assertActiveAgentParticipants(room, opts.participants);
      const createdTs = opts.createdTs ?? new Date().toISOString();
      const group = CollaborationGroupSchema.parse({
        id: opts.groupId ?? randomUUID(),
        room,
        root_message_id: opts.rootMessageId,
        state: 'open',
        created_ts: createdTs,
      });
      this.db.prepare(
        `INSERT INTO collaboration_groups
           (id, room, root_message_id, state, created_ts, completed_ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(group.id, group.room, group.root_message_id, group.state, group.created_ts, null);
      return this.materializeCollaborationRound(
        room,
        group,
        1,
        createdTs,
        opts.participants,
      );
    })();
  }

  createCollaborationRound(
    room: string,
    opts: {
      groupId: string;
      roundNumber: number;
      participants: CollaborationRoundParticipantInput[];
      createdTs?: string;
    },
  ): CollaborationRoundProjection {
    return this.db.transaction(() => {
      if (!Number.isInteger(opts.roundNumber) || opts.roundNumber < 2) {
        throw new Error('later collaboration round number must be an integer of at least 2');
      }
      this.assertCollaborationParticipantInputShape(opts.participants, 1);
      const existing = this.getCollaborationRoundProjection(room, opts.groupId, opts.roundNumber);
      if (existing) return this.assertExistingCollaborationRound(existing, opts.participants);
      const group = this.getCollaborationGroup(room, opts.groupId);
      if (!group) throw new Error(`no such collaboration group: ${opts.groupId}`);
      if (group.state !== 'open') throw new Error(`collaboration group ${opts.groupId} is ${group.state}`);
      if (!this.getCollaborationRound(room, opts.groupId, opts.roundNumber - 1)) {
        throw new Error(`collaboration round ${opts.groupId}/${opts.roundNumber - 1} does not exist`);
      }
      this.assertActiveAgentParticipants(room, opts.participants);
      return this.materializeCollaborationRound(
        room,
        group,
        opts.roundNumber,
        opts.createdTs ?? new Date().toISOString(),
        opts.participants,
      );
    })();
  }
  // harn:end group-round-creation-is-atomic-and-idempotent
  // harn:end collaboration-groups-are-durable-state

  // harn:assume failed-finalization-reconciles-at-runtime ref=finalization-repair-transaction
  /**
   * Settle a turn whose journal is terminal but whose NORMAL finalization could
   * not commit — the #599 shape: a lifecycle retry rebound to a delivery whose
   * participant already holds a terminal result, so completeTurn's participant
   * write correctly refused and took the whole transaction down with it, leaving
   * the row `running` and the delivery `delivering` after the in-memory guard
   * had already cleared.
   *
   * This is deliberately NOT the normal path: it routes nothing, replaces no
   * participant result, and keeps the original journal so the evidence of what
   * the engine actually did survives. It only makes the durable state honest —
   * the attempt failed, its input is settled, the member is not running.
   *
   * Idempotent by construction: a run that is no longer `running` has already
   * been repaired (or finalized normally), so a second runtime or boot pass
   * returns `repaired: false` and writes nothing — including the meter, which
   * is why the rolled-back attempt is counted exactly once rather than never.
   */
  repairFailedFinalization(
    room: string,
    opts: {
      runMsgId: number;
      memberId: string;
      /** Runtime home for the target member; lifecycle rows remain in room. */
      targetRoom?: string;
      deliveryIds: string[];
      outputs?: TurnOutputPatch[];
      error: string;
      endedTs: string;
      model?: string;
      usage?: RunSummary['usage'];
      estimatedCostUsd?: number;
      meterDay: string;
      meterDelta: {
        turns?: number;
        cost_usd?: number;
        estimated_cost_usd?: number;
        input_tokens?: number;
        output_tokens?: number;
        uncosted_tokens?: number;
      };
    },
  ): {
    repaired: boolean;
    message?: Message;
    outputMessages?: Message[];
    member?: Member;
    meter?: RoomMeter;
    notice?: Message;
    deliveries: Delivery[];
    held: string[];
  } {
    return this.db.transaction(() => {
      const targetRoom = opts.targetRoom ?? room;
      const runMsg = this.getMessage(room, opts.runMsgId);
      if (!runMsg?.run || runMsg.run.status !== 'running') {
        return { repaired: false, deliveries: [], held: [] };
      }
      const outputPatches = opts.outputs ?? [];
      const rootOutput = outputPatches.find((output) => output.id === opts.runMsgId) ?? {
        id: opts.runMsgId,
        body: '',
        mentions: [],
        refs: [],
        ledger_refs: [],
        substantive: false,
      };
      const message = this.updateMessage(room, opts.runMsgId, {
        body: rootOutput.body,
        mentions: rootOutput.mentions,
        refs: rootOutput.refs,
        ledger_refs: rootOutput.ledger_refs,
        run: {
          ...runMsg.run,
          status: 'failed',
          ended_ts: opts.endedTs,
          stalled_since: undefined,
          final_text: undefined,
          model: opts.model ?? runMsg.run.model,
          usage: opts.usage,
          estimated_cost_usd: opts.estimatedCostUsd,
          error: opts.error,
        },
      }, { activity: rootOutput.substantive ? 'force' : 'defer' });
      const outputMessages = [message];
      const referenced = new Set(outputPatches.map((output) => output.id));
      for (const output of outputPatches) {
        if (output.id === opts.runMsgId) continue;
        const current = this.getMessage(room, output.id);
        if (current?.run_parent_id !== opts.runMsgId) continue;
        outputMessages.push(this.updateMessage(room, output.id, {
          body: output.body,
          mentions: output.mentions,
          refs: output.refs,
          ledger_refs: output.ledger_refs,
        }, { activity: output.substantive ? 'force' : 'defer' }));
      }
      for (const continuation of this.listRunContinuations(room, opts.runMsgId)) {
        if (referenced.has(continuation.id) || continuation.deleted === true) continue;
        outputMessages.push(this.deleteMessage(room, continuation.id));
      }

      const deliveries: Delivery[] = [];
      const held: string[] = [];
      for (const deliveryId of opts.deliveryIds) {
        const delivery = this.getDelivery(room, deliveryId);
        if (!delivery || delivery.state !== 'delivering') continue;
        // Consume only what is PROVABLY obsolete: this delivery's collaboration
        // work already has a terminal result, or its round/group is closed, so
        // re-running it could only duplicate an answer that already exists.
        // Anything else is ambiguous and becomes the operator's call.
        const obsolete = this.collaborationWorkIsSettled(room, delivery.id);
        deliveries.push(
          this.updateDelivery(room, delivery.id, {
            state: obsolete ? 'consumed' : 'held',
            batch_id: undefined,
          }),
        );
        this.setDeliveryAttemptProcess(room, [delivery.id], undefined);
        if (!obsolete) held.push(delivery.id);
      }

      const current = this.getMember(targetRoom, opts.memberId);
      const member = current === undefined
        ? undefined
        : this.updateMember(targetRoom, opts.memberId, {
          // A repaired attempt leaves the member reachable, not dead: nothing
          // about a finalization rollback says the agent itself is gone.
          state: current.state === 'dead' || current.state === 'paused' ? current.state : 'idle',
        });
      this.promoteAgentUsageBaseline(targetRoom, opts.memberId, opts.runMsgId);

      // completeTurn's rollback took its meter write with it, so this attempt's
      // spend is currently recorded NOWHERE. Count it here, exactly once — and
      // return it, so a connected UI sees the same total the database now holds.
      const meter = this.bumpMeter(targetRoom, opts.meterDay, opts.meterDelta);
      const system = this.listMembers(room).find((candidate) => candidate.kind === 'system');
      if (!system) throw new Error(`room ${room} has no system member`);
      const handle = `@${member?.handle ?? opts.memberId}`;
      const detail = opts.error.replace(/^finalization could not commit:\s*/, '');
      // The notice commits with the repair. A crash after this transaction can
      // neither lose the explanation nor create a duplicate on the next pass.
      const notice = this.postMessage(room, {
        author: system.id,
        kind: 'system',
        body: held.length > 0
          ? `turn #${String(opts.runMsgId)} for ${handle} could not finalize (${detail}) — its instruction is held; release_hold or redeliver to retry`
          : `turn #${String(opts.runMsgId)} for ${handle} could not finalize (${detail}) — its work already had a result, so the duplicate instruction was consumed`,
      });
      return {
        repaired: true,
        message,
        outputMessages: outputMessages.sort((left, right) => left.id - right.id),
        member,
        meter,
        notice,
        deliveries,
        held,
      };
    })();
  }

  /**
   * True when this delivery's collaboration work is already settled — a terminal
   * participant, or a round/group that is no longer accepting work. A delivery
   * with no collaboration context at all is NOT settled: an ordinary turn that
   * failed to finalize is exactly the ambiguous case an operator should see.
   *
   * Public because it is the SAME predicate on both sides of the seam: the
   * daemon asks it before attempting normal finalization, and repair asks it
   * when deciding consume-vs-hold. A second copy of this rule that drifted
   * would let a closed group accept a new result — `recordCollaboration-
   * ParticipantTerminal` guards only the participant, never its round or group.
   */
  collaborationWorkIsSettled(room: string, deliveryId: string): boolean {
    const participant = this.findCollaborationParticipantByDelivery(room, deliveryId);
    if (!participant) return false;
    if (participant.terminal_status !== undefined) return true;
    const group = this.getCollaborationGroup(room, participant.group_id);
    if (group !== undefined && group.state !== 'open') return true;
    const round = this.getCollaborationRound(room, participant.group_id, participant.round_number);
    return round !== undefined && round.state !== 'collecting';
  }
  // harn:end failed-finalization-reconciles-at-runtime

  // harn:assume lifecycle-retries-only-live-collaboration-work ref=lifecycle-interruption-settlement
  /**
   * Settle a turn the daemon's OWN lifecycle interrupted, deciding retry
   * eligibility and terminality as ONE fact.
   *
   * The #598/#599 bug was these being two facts: the attempt finalized as a
   * terminal participant result, and only afterwards was its delivery re-queued
   * — so the retry came back to a participant that already had an answer. Here
   * a delivery is either durably re-queued (and its participant deliberately
   * left nonterminal, its round still open, so the eventual retry produces the
   * one result) or it is settled and its participant recorded `interrupted` so
   * the barrier releases. Never both, never neither: a nonterminal participant
   * may exist only with a queued retry behind it.
   *
   * Retry is admissible only while the work is genuinely still live — below the
   * attempt ceiling, trigger not deleted, and collaboration work not settled.
   * Operator Stop never reaches here; it is terminal by construction.
   */
  settleLifecycleInterruption(
    room: string,
    opts: {
      runMsgId: number;
      memberId: string;
      /** Runtime home for the target member; lifecycle rows remain in room. */
      targetRoom?: string;
      deliveryIds: string[];
      message: Partial<Pick<Message, 'body' | 'mentions' | 'refs' | 'ledger_refs' | 'run' | 'ack'>>;
      outputs: TurnOutputPatch[];
      memberPatch: Partial<Omit<Member, 'id' | 'kind'>>;
      endedTs: string;
      attemptCeiling: number;
      meterDay: string;
      meterDelta: {
        turns?: number;
        cost_usd?: number;
        estimated_cost_usd?: number;
        input_tokens?: number;
        output_tokens?: number;
        uncosted_tokens?: number;
      };
    },
  ): {
    message: Message;
    outputMessages: Message[];
    member: Member;
    meter: RoomMeter;
    notice?: Message;
    requeued: Delivery[];
    settled: Delivery[];
    refusals: { delivery: Delivery; reason: LifecycleRetryRefusalReason }[];
  } {
    return this.db.transaction(() => {
      const targetRoom = opts.targetRoom ?? room;
      const rootOutput = opts.outputs.find((output) => output.id === opts.runMsgId) ?? {
        id: opts.runMsgId,
        body: '',
        mentions: [],
        refs: [],
        ledger_refs: [],
        substantive: false,
      };
      const message = this.updateMessage(room, opts.runMsgId, {
        ...opts.message,
        body: rootOutput.body,
        mentions: rootOutput.mentions,
        refs: rootOutput.refs,
        ledger_refs: rootOutput.ledger_refs,
      }, { activity: rootOutput.substantive ? 'force' : 'defer' });
      const outputMessages = [message];
      const referenced = new Set(opts.outputs.map((output) => output.id));
      for (const output of opts.outputs) {
        if (output.id === opts.runMsgId) continue;
        const current = this.getMessage(room, output.id);
        if (current?.run_parent_id !== opts.runMsgId) continue;
        outputMessages.push(this.updateMessage(room, output.id, {
          body: output.body,
          mentions: output.mentions,
          refs: output.refs,
          ledger_refs: output.ledger_refs,
        }, { activity: output.substantive ? 'force' : 'defer' }));
      }
      for (const continuation of this.listRunContinuations(room, opts.runMsgId)) {
        if (referenced.has(continuation.id) || continuation.deleted === true) continue;
        outputMessages.push(this.deleteMessage(room, continuation.id));
      }
      const member = this.updateMember(targetRoom, opts.memberId, opts.memberPatch);
      this.promoteAgentUsageBaseline(targetRoom, opts.memberId, opts.runMsgId);
      const requeued: Delivery[] = [];
      const settled: Delivery[] = [];
      const refusals: { delivery: Delivery; reason: LifecycleRetryRefusalReason }[] = [];

      for (const deliveryId of opts.deliveryIds) {
        const delivery = this.getDelivery(room, deliveryId);
        if (!delivery) continue;
        if (delivery.state !== 'consumed' && delivery.state !== 'delivering') continue;

        const atCeiling = delivery.attempt_count >= opts.attemptCeiling;
        const triggerPurged = this.getMessage(room, delivery.message_id)?.deleted === true;
        const workSettled = this.collaborationWorkIsSettled(room, delivery.id);
        if (!atCeiling && !triggerPurged && !workSettled) {
          // Live work: re-queue WITHOUT touching the participant, so the round
          // stays open for the retry that will produce its one result.
          requeued.push(this.updateDelivery(room, delivery.id, {
            state: 'queued',
            run_msg_id: undefined,
            batch_id: undefined,
          }));
          this.setDeliveryAttemptProcess(room, [delivery.id], undefined);
          continue;
        }

        // Refused: settle the input and release the barrier in the same commit.
        // A participant left nonterminal here would block its round forever,
        // because nothing is coming back to answer it.
        const consumed = this.updateDelivery(room, delivery.id, {
          state: 'consumed',
          batch_id: undefined,
        });
        settled.push(consumed);
        this.setDeliveryAttemptProcess(room, [delivery.id], undefined);
        refusals.push({
          delivery: consumed,
          reason: atCeiling
            ? 'attempt_ceiling'
            : triggerPurged
              ? 'deleted_trigger'
              : 'settled_collaboration',
        });
        const participant = this.findCollaborationParticipantByDelivery(room, delivery.id);
        if (participant !== undefined && participant.terminal_status === undefined) {
          this.recordCollaborationParticipantTerminal(room, {
            deliveryId: delivery.id,
            status: 'interrupted',
            resultMessageId: opts.runMsgId,
            completedTs: opts.endedTs,
          });
        }
      }
      const meter = this.bumpMeter(targetRoom, opts.meterDay, opts.meterDelta);
      let notice: Message | undefined;
      if (refusals.length > 0) {
        const system = this.listMembers(room).find((candidate) => candidate.kind === 'system');
        if (!system) throw new Error(`room ${room} has no system member`);
        const recipients = [...new Set(refusals.map(({ delivery }) => delivery.recipient))]
          .map((recipient) => `@${this.getMember(room, recipient)?.handle ?? recipient}`)
          .join(', ');
        const reasons = [...new Set(refusals.map(({ reason }) => reason))]
          .map((reason) => reason === 'attempt_ceiling'
            ? 'the retry ceiling was reached'
            : reason === 'deleted_trigger'
              ? 'the instruction was deleted'
              : 'the collaboration work was already settled')
          .join('; ');
        const mayForce = refusals.some(({ reason }) => reason === 'attempt_ceiling');
        notice = this.postMessage(room, {
          author: system.id,
          kind: 'system',
          body: `delivery to ${recipients} not re-queued after lifecycle interruption (turn #${String(opts.runMsgId)}: ${reasons}) — ${mayForce ? 'retry_run can force a fresh attempt' : 'the instruction was consumed'}`,
        });
      }
      return {
        message,
        outputMessages: outputMessages.sort((left, right) => left.id - right.id),
        member,
        meter,
        notice,
        requeued,
        settled,
        refusals,
      };
    })();
  }
  // harn:end lifecycle-retries-only-live-collaboration-work

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

  // harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-store
  private resolveApprovalDeliveries(
    interaction: PendingInteraction,
    resolvedTs: string,
  ): Delivery[] {
    const targets = new Set(interaction.targets);
    const rows = this.db.prepare(
      `SELECT deliveries.* FROM deliveries
       JOIN members
         ON members.room = deliveries.room
        AND members.id = deliveries.recipient
        AND members.kind = 'human'
       WHERE deliveries.room = ? AND deliveries.message_id = ?
       ORDER BY deliveries.queue_seq, deliveries.id`,
    ).all(interaction.room, interaction.message_id) as DeliveryRow[];
    return rows
      .map(deliveryFromRow)
      .filter((delivery) => targets.has(delivery.recipient))
      .map((delivery) => (
        delivery.read_ts !== undefined && delivery.interaction_resolved_ts !== undefined
          ? delivery
          : this.updateDelivery(interaction.room, delivery.id, {
              read_ts: delivery.read_ts ?? resolvedTs,
              interaction_resolved_ts: delivery.interaction_resolved_ts ?? resolvedTs,
            })
      ));
  }

  orphanInteraction(
    room: string,
    interactionId: string,
    orphanedTs: string,
  ): { interaction: PendingInteraction; deliveries: Delivery[] } {
    return this.db.transaction(() => {
      const existing = this.getInteraction(interactionId);
      if (!existing || existing.room !== room) throw new Error(`no such interaction ${interactionId}`);
      if (existing.state !== 'pending' && existing.state !== 'answered') {
        throw new Error(`interaction ${interactionId} is ${existing.state}`);
      }
      const interaction = this.upsertInteraction({ ...existing, state: 'orphaned' });
      const deliveries = interaction.kind === 'approval'
        ? this.resolveApprovalDeliveries(interaction, orphanedTs)
        : [];
      return { interaction, deliveries };
    })();
  }
  // harn:end approval-deliveries-project-resolution-separately

  // harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-transaction
  answerApproval(
    room: string,
    interactionId: string,
    answer: unknown,
    answeredBy: string,
    answeredTs: string,
  ): { interaction: PendingInteraction; deliveries: Delivery[] } {
    return this.db.transaction(() => {
      const existing = this.getInteraction(interactionId);
      if (!existing || existing.room !== room) throw new Error(`no such interaction ${interactionId}`);
      if (existing.kind !== 'approval') throw new Error(`interaction ${interactionId} is not an approval`);
      if (existing.state !== 'pending') throw new Error(`interaction ${interactionId} is ${existing.state}`);
      if (!existing.targets.includes(answeredBy)) {
        throw new Error(`interaction ${interactionId} is not addressed to member ${answeredBy}`);
      }
      const interaction = this.upsertInteraction({
        ...existing,
        state: 'answered',
        answer,
        answered_by: answeredBy,
        answered_ts: answeredTs,
      });
      const deliveries = this.resolveApprovalDeliveries(interaction, answeredTs);
      return { interaction, deliveries };
    })();
  }
  // harn:end approval-answer-is-atomic-and-chatless

  // ── meters ────────────────────────────────────────────────────────────

  // harn:assume spend-meter-always-on ref=meter-cost-and-token-accounting
  bumpMeter(
    room: string,
    day: string,
    delta: {
      turns?: number;
      cost_usd?: number;
      estimated_cost_usd?: number;
      input_tokens?: number;
      output_tokens?: number;
      uncosted_tokens?: number;
    },
  ): RoomMeter {
    // harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=separated-meter-accounting
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO meters
             (room, day, turns, cost_usd, estimated_cost_usd, input_tokens, output_tokens, uncosted_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (room, day) DO UPDATE SET
             turns = turns + excluded.turns,
             cost_usd = cost_usd + excluded.cost_usd,
             estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             uncosted_tokens = uncosted_tokens + excluded.uncosted_tokens`,
        )
        .run(
          room,
          day,
          delta.turns ?? 0,
          delta.cost_usd ?? 0,
          delta.estimated_cost_usd ?? 0,
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
    // harn:end estimated-cost-is-advisory-not-spend-brake-input
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
  sync(
    room: string,
    sinceSeq: number,
    opts: {
      hydrateLimit?: number;
      subscriber?: string;
      strictTail?: boolean;
      supportFor?: string;
    } = {},
  ): SyncResult {
    return this.db.transaction(() => {
      const seq = this.currentSeq(room);
      // A bound is honoured ONLY on a cold subscribe that asked for one. Every
      // warm sync replays every change as before, or an in-place finalization
      // could be missed; a subscriber that sends no bound is untouched too.
      if (sinceSeq === 0 && opts.hydrateLimit !== undefined) {
        const roomRow = this.getRoom(room);
        if (!roomRow) throw new Error(`no such room: ${room}`);
        const snapshot = this.boundedColdSnapshot(
          room,
          roomRow,
          seq,
          opts.hydrateLimit,
          opts.subscriber,
          opts.strictTail === true,
          opts.supportFor,
        );
        return { ...snapshot, schedules: this.listSchedules(room) };
      }
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
        schedules: [...(wanted.get('schedule') ?? [])]
          .map((id) => this.getSchedule(room, id))
          .filter((schedule): schedule is Schedule => schedule !== undefined),
        ...(opts.supportFor !== undefined && {
          support: this.roomSupport(room, opts.supportFor),
        }),
      };
    })();
  }
  // harn:end sync-cursor-commits-after-hydration

  // harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-contract
  /**
   * A cold viewer's bounded snapshot, built INSIDE sync()'s transaction. An
   * addressed subscriber gets exactly the contiguous tail and a separate
   * support projection. A legacy subscriber keeps the prior outlier-bearing
   * shape until the client cutover:
   *   - every running run, so a live turn renders however old it is;
   *   - the cards of unresolved interactions, so an ask that scrolled past the
   *     tail is still answerable;
   *   - the messages this subscriber's unread deliveries point at, because the
   *     inbox filter drops deliveries whose message is absent and the badge
   *     would undercount;
   *   - the latest finalized non-ack agent run, the default-recipient seed.
   * `history_floor` is the tail's floor ALONE — an outlier must never drag the
   * client's cursor backwards past a gap it did not receive.
   */
  private boundedColdSnapshot(
    room: string,
    roomRow: Room,
    seq: number,
    limit: number,
    subscriber?: string,
    strictTail = false,
    supportFor?: string,
  ): SyncResult {
    const tail = (this.db
      .prepare('SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?')
      .all(room, limit) as MessageRow[])
      .map(messageFromRow)
      .reverse();

    const byId = new Map<number, Message>(tail.map((message) => [message.id, message]));
    const includeOutliers = (rows: MessageRow[]): void => {
      for (const row of rows) {
        const message = messageFromRow(row);
        if (!byId.has(message.id)) byId.set(message.id, message);
      }
    };

    if (!strictTail) {
      includeOutliers(this.db
        .prepare(
          `SELECT * FROM messages
            WHERE room = ? AND kind = 'run' AND json_extract(run, '$.status') = 'running'`,
        )
        .all(room) as MessageRow[]);

      includeOutliers(this.db
        .prepare(
          `SELECT messages.* FROM messages
             JOIN pending_interactions ON pending_interactions.room = messages.room
              AND pending_interactions.message_id = messages.id
            WHERE messages.room = ? AND pending_interactions.state IN ('pending', 'answered')`,
        )
        .all(room) as MessageRow[]);

      if (subscriber !== undefined) {
        includeOutliers(this.db
          .prepare(
            `SELECT messages.* FROM messages
               JOIN deliveries ON deliveries.room = messages.room
                AND deliveries.message_id = messages.id
              WHERE messages.room = ? AND deliveries.recipient = ?
                AND deliveries.read_ts IS NULL AND deliveries.state = 'consumed'`,
          )
          .all(room, subscriber) as MessageRow[]);
      }

      includeOutliers(this.db
        .prepare(
          `SELECT messages.* FROM messages
             JOIN members ON members.room = messages.room AND members.id = messages.author
            WHERE messages.room = ? AND messages.kind = 'run' AND members.kind = 'agent'
              AND members.removed_ts IS NULL AND messages.ack = 0
              AND json_extract(messages.run, '$.status') <> 'running'
            ORDER BY messages.id DESC LIMIT 1`,
        )
        .all(room) as MessageRow[]);
    }

    const latestMeter = this.db
      .prepare('SELECT * FROM meters WHERE room = ? ORDER BY day DESC LIMIT 1')
      .get(room) as MeterRow | undefined;

    return {
      seq,
      room: roomRow,
      history_floor: tail[0]?.id,
      messages: [...byId.values()].sort((left, right) => left.id - right.id),
      // The full roster and the subscriber's inbox stay whole: bounding history
      // must not shrink who is in the room or what is waiting for them.
      members: this.listMembers(room, { includeRemoved: true }),
      inbox: this.listDeliveries(room),
      meters: latestMeter ? [meterFromRow(latestMeter)] : [],
      ...(supportFor !== undefined && { support: this.roomSupport(room, supportFor) }),
    };
  }
  // harn:end addressed-cold-hydration-is-strict-and-legacy-safe

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
