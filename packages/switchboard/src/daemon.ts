import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import type {
  AgentLimit,
  AgentUsage,
  ModelCatalog,
  AskCard,
  Attachment,
  Policy,
  ThinkingLevel,
  AttachLease,
  BridgeOrigin,
  Delivery,
  HarnessAdapter,
  Member,
  MemberStatusResponse,
  Message,
  PendingInteraction,
  Role,
  RoomSupport,
  RunSearchHit,
  ServerFrame,
  Session,
  WireEvent,
  CreateRoomRequest,
} from '@codor/protocol';

import {
  AttachmentSchema,
  MemberStatusResponseSchema,
  deriveRoomId,
  parseRunItemPayload,
} from '@codor/protocol';

import { BlobStore } from './blobs.js';
import { validateSpawnOptions } from './adapter-registry.js';
import { roleAllows } from './authorization.js';
import {
  composeGroupRoundPayload,
  selectDeliveryBatchPrefix,
  type GroupRoundPayloadContext,
} from './collaboration.js';
import { ContinuationWriter, projectContinuationOutputs } from './continuation.js';
import type { LedgerGraph, LedgerManager } from './ledger/watch.js';
import type { LedgerNote, LedgerWrite } from './ledger/vault.js';
import type { HumanPushKind, HumanPushNotifier } from './push/producer.js';
import { estimateCostUsd } from './pricing.js';
import { redactValue } from './redact.js';
import {
  RemoteAttemptAmbiguousError,
  type ResidencyCoordinator,
  remoteMemberSpec,
} from './residency.js';
import {
  composeDeliveryBriefing,
  composePayload,
  evaluateBrakes,
  parseBody,
  type PayloadContext,
  resolveRecipients,
  type ResolvedRef,
} from './router.js';
import {
  Store,
  type FanoutDelivery,
  type RoutedMessagePlan,
  type TurnOutputPatch,
} from './store.js';
import { normalizeWorkingDirectory } from './working-directory.js';

const execFileAsync = promisify(execFile);

// ── Room git working-state (diff explorer) ─────────────────────────────────
// Every git call is read-only and runs through execFileAsync (no shell, no
// interpolation). The directory is always one the room already recorded — never
// a free path from the client. Per-file diffs are capped so a large working tree
// cannot balloon the response. See gitWorkingState / readGitWorkingFiles below.
// ── Message attachments ────────────────────────────────────────────────────
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const ORPHAN_ATTACHMENT_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_ID = /^[0-9a-f]{32}$/;

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Boot-recovery requeue fence: a delivery whose turn has been started this many
// times without completing is left consumed instead of re-queued, so a poisonous
// instruction that kills the daemon on every start cannot ping-pong the service.
// Matches the existing give-up bound (residency retries stop at attempt_count 2).
export const RECOVERY_ATTEMPT_CEILING = 2;

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FILE_DIFF_CHARS = 40_000;
const DIFF_TRUNCATED_MARKER = '\n… diff truncated …\n';

export type RoomGitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface RoomGitFile {
  path: string;
  status: RoomGitFileStatus;
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
}

export interface RoomGitWorkingState {
  cwds: string[];
  selected: string | null;
  clean: boolean;
  files: RoomGitFile[];
}

interface PorcelainEntry {
  path: string;
  status: RoomGitFileStatus;
}

function porcelainStatus(x: string, y: string): RoomGitFileStatus {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified';
}

/** Parse `git status --porcelain=v1 -z` into per-file entries. A rename/copy
 *  record carries a trailing original-path field, which is consumed (skipped). */
function parsePorcelainStatus(output: string): PorcelainEntry[] {
  const tokens = output.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const x = token[0]!;
    const y = token[1]!;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++; // skip original path
    entries.push({ path: token.slice(3), status: porcelainStatus(x, y) });
  }
  return entries;
}

/** Additions/deletions counted from a unified diff — the fallback for sources
 *  `--numstat` does not cover (untracked files diffed via --no-index). */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * Untrusted CLI stdout: only these shapes become buttons, and never many.
 * Multi-segment ids are real (opencode reports `openrouter/anthropic/claude-…`),
 * but a leading dash is not a model — it is a flag smuggled into an argv slot.
 */
const MODEL_ID = /^\w[\w.:-]*(?:\/[\w.:-]+)*$/;
const MAX_MODELS = 200;

export interface DaemonOptions {
  dbPath: string;
  blobRoot: string;
  adapters: HarnessAdapter[];
  /**
   * Ask each adapter for its model list at registration. Off in the browser
   * suite: discovery shells out to real CLIs, which would make it non-hermetic.
   */
  discoverModels?: boolean;
  /** Account usage refresh cadence; production defaults to 15 minutes. */
  limitsProbeMs?: number;
  attachLeaseTimeoutMs?: number;
  attachLeasePollMs?: number;
  processProbe?: (target: number) => boolean;
  stallPollMs?: number;
  hostId?: string;
  residency?: ResidencyCoordinator;
  ledger?: LedgerManager;
  pushProducer?: HumanPushNotifier;
  onBackgroundError?: (error: Error) => void;
  homeDir?: string;
  socketPath?: string;
}

export interface MemberDetails {
  member: Member;
  queued_count: number;
  spend: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    estimated_cost_usd: number; // tokens-only harnesses priced from the model table
    uncosted_tokens: number;
  };
}

export type FrameListener = (room: string, frame: ServerFrame) => void;

interface TurnCompletion {
  status: 'completed' | 'failed' | 'interrupted';
  final_text?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
}

interface RetryTurnRefusal {
  reason: string;
  alreadyHeld: boolean;
}

interface DeliveryPayloadSnapshot {
  context: Omit<PayloadContext, 'conventions' | 'roster'>;
  you: string;
}

interface GroupDeliveryPayloadSnapshot {
  kind: 'group';
  payload: string;
}

interface GroupWaitContext {
  room: string;
  groupId: string;
  roundNumber: number;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(): string {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let random = '';
  for (let i = 0; i < 16; i++) random += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  return time + random;
}

function extensionSuffix(nativeId: string): string {
  const clean = nativeId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.length >= 6) return clean.slice(0, 6);
  let hash = 2166136261;
  for (const char of nativeId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${clean}${(hash >>> 0).toString(36)}`.slice(0, 6).padEnd(6, '0');
}

function extensionDescription(event: Extract<WireEvent, { type: 'run.item' }>): string | undefined {
  if (event.item_type !== 'tool_call' || typeof event.payload !== 'object' || event.payload === null) {
    return undefined;
  }
  const payload = event.payload as { tool?: unknown; input?: unknown };
  if (payload.tool !== 'Agent' && payload.tool !== 'Task') return undefined;
  if (typeof payload.input !== 'object' || payload.input === null) return undefined;
  const input = payload.input as { description?: unknown; name?: unknown; prompt?: unknown };
  for (const value of [input.description, input.name, input.prompt]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 160);
  }
  return undefined;
}

/** Semantic identity of an interaction — native ids are process-lifetime only. */
function interactionKey(kind: 'ask' | 'approval', card: AskCard): string {
  const labels = (card.options ?? []).map((o) => o.label).join('|');
  return `${kind}\0${card.prompt}\0${labels}\0${card.tool ?? ''}`;
}

/**
 * The switchboard daemon core: turn pump, interaction state machine,
 * attempt-WAL reconcile, change-log fanout. Transport-free — server.ts puts
 * WS/REST in front of it; tests drive it with a FakeAdapter.
 */
export class Daemon {
  readonly store: Store;
  readonly blobs: BlobStore;
  readonly pushLog: { room: string; body: string; ts: string }[] = [];
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly modelCatalogs = new Map<string, ModelCatalog>();
  private pendingDiscoveries = 0;
  private readonly sessions = new Map<string, Session>();
  /**
   * Members whose settings changed and whose cached session is therefore out of date.
   *
   * The session is NOT dropped when it is marked: a turn in flight raised its own ask
   * cards against that very session object, and answering one looks it up here — pull it
   * out from under a running turn and the operator's answer lands on nothing. It is
   * rebuilt at the START of the next turn, which is the only moment at which the old
   * settings stop being the ones actually in use.
   */
  private readonly staleSessions = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private readonly listeners: FrameListener[] = [];
  private readonly pendingAttach = new Set<string>();
  private readonly releasedDeliveries = new Set<string>();
  private readonly operatorInterrupts = new Set<string>();
  /** Members whose in-flight turn THIS daemon's lifecycle is interrupting, so
   *  finalization can tell retryable collateral from a deliberate Stop. */
  private readonly lifecycleInterrupts = new Set<string>();
  private readonly memberWaits = new Map<string, NonNullable<Member['waiting']>>();
  // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-runtime-registry
  private readonly lastUsage = new Map<string, AgentUsage>();
  // harn:end last-agent-usage-is-transient-and-seeded
  private readonly groupWaits = new Map<string, GroupWaitContext>();
  private readonly attachLeaseTimeoutMs: number;
  private readonly processProbe: (target: number) => boolean;
  private readonly attachLeaseTimer: NodeJS.Timeout;
  private readonly stallTimer: NodeJS.Timeout;
  private readonly limitsProbeTimer: NodeJS.Timeout;
  private probingLimits = false;
  private readonly runActivity = new Map<string, number>();
  private readonly hostId?: string;
  private readonly residency?: ResidencyCoordinator;
  private readonly ledger?: LedgerManager;
  private readonly pushProducer?: HumanPushNotifier;
  private readonly onBackgroundError: (error: Error) => void;
  private readonly homeDir: string;
  private readonly socketPath: string;
  private readonly attachmentsRoot: string;
  private readonly stopResidencyReachability?: () => void;
  private closing = false;
  private closed = false;

  constructor(options: DaemonOptions) {
    this.store = new Store(options.dbPath);
    this.blobs = new BlobStore(options.blobRoot);
    this.hostId = options.hostId;
    this.residency = options.residency;
    this.ledger = options.ledger;
    this.pushProducer = options.pushProducer;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.homeDir = options.homeDir ?? homedir();
    this.socketPath = options.socketPath ?? join(dirname(options.dbPath), 'codor.sock');
    this.attachmentsRoot = join(dirname(options.dbPath), 'attachments');
    this.sweepOrphanAttachments(); // boot-time: drop uploads no message ever claimed
    this.ledger?.setRoomValidator((room) => this.store.getRoom(room) !== undefined);
    this.ledger?.setRemoteWriteAuthorizer((peerId, room, author) => {
      const members = this.store.listMembers(room);
      const peerBelongsToRoom = members.some((member) =>
        member.kind === 'agent' && member.host === peerId);
      if (!peerBelongsToRoom) return false;
      const attributed = members.find((member) => member.handle === author);
      if (attributed?.kind === 'agent') return attributed.host === peerId;
      return attributed?.kind === 'human' && attributed.role !== undefined &&
        roleAllows(attributed.role, 'manage_ledger');
    });
    this.ledger?.setChangeHandler(({ room, name, author }) => {
      if (this.store.getRoom(room)) this.postSystemMessage(room, `@${author} updated [[${name}]]`);
    });
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter);
    if (options.discoverModels ?? true) this.discoverModels();
    this.attachLeaseTimeoutMs = options.attachLeaseTimeoutMs ?? 5_000;
    this.processProbe = options.processProbe ?? ((target) => {
      try {
        process.kill(target, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    });
    this.attachLeaseTimer = setInterval(
      () => this.reconcileAttachLeases(),
      options.attachLeasePollMs ?? 1_000,
    );
    this.attachLeaseTimer.unref();
    this.stallTimer = setInterval(() => this.checkStalls(), options.stallPollMs ?? 60_000);
    this.stallTimer.unref();
    this.track(this.probeAdapterLimits());
    this.limitsProbeTimer = setInterval(
      () => this.track(this.probeAdapterLimits()),
      options.limitsProbeMs ?? 15 * 60_000,
    );
    this.limitsProbeTimer.unref();
    this.stopResidencyReachability = this.residency?.onReachability((peerId, connected) =>
      this.handleResidentReachability(peerId, connected));
  }

  // harn:assume agent-member-credentials-stay-secret ref=member-session-environment
  private issueMemberCredential(room: string, member: Member, session: Session): void {
    const token = randomBytes(32).toString('base64url');
    const credentialHash = createHash('sha256').update(token).digest('hex');
    this.store.setAgentCredentialHash(room, member.id, credentialHash);
    session.env = {
      ...session.env,
      CODOR_SOCKET: this.socketPath,
      CODOR_CHANNEL: room,
      CODOR_MEMBER_ID: member.id,
      CODOR_MEMBER_TOKEN: token,
      // harn:assume member-session-masks-operator-token ref=member-token-environment-mask
      CODOR_TOKEN: token,
      // harn:end member-session-masks-operator-token
    };
  }

  authenticateAgentToken(token: string): { room: string; member: Member } | undefined {
    if (token === '') return undefined;
    const credentialHash = createHash('sha256').update(token).digest('hex');
    return this.store.findAgentByCredentialHash(credentialHash);
  }
  // harn:end agent-member-credentials-stay-secret

  async close(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    clearInterval(this.attachLeaseTimer);
    clearInterval(this.stallTimer);
    clearInterval(this.limitsProbeTimer);
    this.stopResidencyReachability?.();
    if (options.force !== true) {
      // harn:assume lifecycle-retries-only-live-collaboration-work ref=recovery-requeue-contract
      // A graceful stop interrupts live turns through the same adapter path the
      // Stop button uses, so those runs finalize `interrupted` BEFORE the store
      // closes — at boot they are indistinguishable from a deliberate Stop (#492).
      // Mark them HERE, where the cause is provably lifecycle, so finalization
      // takes the atomic retry-or-terminal settlement instead of committing a
      // participant result and re-queueing behind it.
      for (const turn of this.snapshotInFlightTurns()) {
        this.lifecycleInterrupts.add(this.store.getMessage(turn.room, turn.runMsgId)!.author);
      }
      // harn:end lifecycle-retries-only-live-collaboration-work
      for (const [memberId, session] of this.sessions) {
        const member = this.store.listRooms().find((room) => this.store.getMember(room.id, memberId));
        const persisted = member ? this.store.getMember(member.id, memberId) : undefined;
        if (persisted?.harness) this.requireAdapter(persisted.harness).interrupt(session);
      }
      // Each turn settled itself atomically as it finalized; there is no second
      // healing pass to run, and nothing left half-committed if we stop here.
      await this.settle();
    }
    await this.ledger?.close();
    this.store.close();
    this.closed = true;
  }

  // harn:assume lifecycle-retries-only-live-collaboration-work ref=recovery-requeue-contract
  /** Deliveries bound to a run the daemon's lifecycle is about to interrupt (or
   *  already has) — the set the atomic settlement decides over. */
  private boundLifecycleDeliveries(room: string, runMsgId: number): Delivery[] {
    return this.store
      .listDeliveries(room)
      .filter((delivery) => delivery.run_msg_id === runMsgId
        && (delivery.state === 'consumed' || delivery.state === 'delivering'));
  }

  /** The in-flight turns a graceful close is about to interrupt, captured BEFORE
   *  the interrupt so the cause is provably lifecycle. Scoped to turns THIS daemon
   *  is actually running (`inflight`) — a run left `running` by an earlier crash is
   *  not ours to heal here; boot recovery owns that seam. A turn an operator stopped
   *  is excluded: its run already finalized, or its member is still marked as an
   *  operator interrupt — either way a deliberate Stop must stay stopped. */
  private snapshotInFlightTurns(): { room: string; runMsgId: number; deliveryIds: string[] }[] {
    const snapshot: { room: string; runMsgId: number; deliveryIds: string[] }[] = [];
    for (const room of this.store.listRooms()) {
      for (const message of this.store.listMessages(room.id, { limit: Number.MAX_SAFE_INTEGER })) {
        if (message.kind !== 'run' || message.run?.status !== 'running') continue;
        if (!this.inflight.has(message.author)) continue; // not a turn this daemon is running
        if (this.operatorInterrupts.has(message.author)) continue; // a Stop stays stopped
        const bound = this.boundLifecycleDeliveries(room.id, message.id);
        if (bound.length === 0) continue;
        snapshot.push({
          room: room.id,
          runMsgId: message.id,
          deliveryIds: bound.map((delivery) => delivery.id),
        });
      }
    }
    return snapshot;
  }
  // harn:end lifecycle-retries-only-live-collaboration-work

  /** Tracks a fire-and-forget turn chain so settle() can await quiescence. */
  private track(promise: Promise<void>): void {
    const wrapped = promise.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        this.onBackgroundError(failure);
      } catch {
        // A diagnostic sink must never break daemon settlement.
      }
    }).finally(() => this.active.delete(wrapped));
    this.active.add(wrapped);
  }

  /** Resolves when no turn chains are running (blocked asks keep it waiting). */
  async settle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active]);
    }
  }

  // harn:assume stall-flags-never-kills ref=run-stall-watchdog
  checkStalls(now = new Date()): void {
    for (const room of this.store.listRooms()) {
      const timeoutMs = room.config.stall_minutes * 60_000;
      for (const message of this.store.listMessages(room.id, { limit: Number.MAX_SAFE_INTEGER })) {
        if (message.kind !== 'run' || message.run?.status !== 'running') continue;
        // harn:assume live-agent-waits-are-transient ref=wait-stall-exemption
        const wait = this.memberWaits.get(message.author);
        if (wait && Date.parse(wait.until_ts) > now.getTime()) continue;
        // harn:end live-agent-waits-are-transient
        const key = `${room.id}:${message.id}`;
        const lastActivity = this.runActivity.get(key) ?? Date.parse(message.run.started_ts);
        if (now.getTime() - lastActivity < timeoutMs || message.run.stalled_since !== undefined) {
          continue;
        }
        const stalled = this.store.updateMessage(room.id, message.id, {
          run: { ...message.run, stalled_since: now.toISOString() },
        });
        this.emitMessage(room.id, stalled);
        const member = this.store.getMember(room.id, message.author);
        const body = `@${member?.handle ?? message.author} run #${message.id} has stalled with no events`;
        this.pushLog.push({ room: room.id, body, ts: now.toISOString() });
        this.queueHumanPush(room.id, message.id, 'stall', body, [this.ownerOf(room.id).id]);
      }
    }
  }

  private noteRunActivity(room: string, messageId: number): void {
    this.runActivity.set(`${room}:${messageId}`, Date.now());
    const message = this.store.getMessage(room, messageId);
    if (message?.run?.status !== 'running' || message.run.stalled_since === undefined) return;
    const progressed = this.store.updateMessage(room, messageId, {
      run: { ...message.run, stalled_since: undefined },
    });
    this.emitMessage(room, progressed);
  }
  // harn:end stall-flags-never-kills

  onFrame(listener: FrameListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // harn:assume redaction-before-fanout ref=redacted-frame-emit
  /**
   * ALL fanout funnels through here: frames are deep-redacted before any
   * listener (WS/REST serializer) sees them, unless the room opted out.
   * The store and blobs keep raw content.
   */
  private emit(room: string, frame: ServerFrame): void {
    const projected = this.projectFrame(room, frame);
    for (const listener of this.listeners) listener(room, projected);
  }

  projectFrame(room: string, frame: ServerFrame): ServerFrame {
    // harn:assume run-item-raw-journal-only ref=live-run-item-raw-projection
    let liveFrame = frame;
    if (
      frame.type === 'run_event' &&
      frame.event.type === 'run.item' &&
      typeof frame.event.payload === 'object' &&
      frame.event.payload !== null &&
      !Array.isArray(frame.event.payload)
    ) {
      const { raw: _raw, ...payload } = frame.event.payload as Record<string, unknown>;
      liveFrame = { ...frame, event: { ...frame.event, payload } };
    }
    // harn:end run-item-raw-journal-only
    const config = this.store.getRoom(room)?.config;
    if (config?.redaction_enabled === false) return liveFrame;
    return redactValue(liveFrame);
  }

  /** Redacted view of arbitrary sync/REST payloads. */
  project<T>(room: string, value: T): T {
    const config = this.store.getRoom(room)?.config;
    if (config?.redaction_enabled === false) return value;
    return redactValue(value);
  }
  // harn:end redaction-before-fanout

  private emitMessage(room: string, message: Message): void {
    this.emit(room, { type: 'message', seq: message.seq, message });
  }

  // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-member-projection
  // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-seeding
  /**
   * Pre-turn gauge seeding: estimate context from the harness's on-disk
   * session artifact so operators see pressure BEFORE spending a turn.
   * Fire-and-forget; a seed never overwrites a live (non-estimated) value.
   */
  private seedContextUsage(room: string, member: Member): void {
    if (member.kind !== 'agent' || member.harness === undefined || member.session_ref === undefined) return;
    const adapter = this.adapters.get(member.harness);
    if (adapter?.peekContextUsage === undefined) return;
    const existing = this.lastUsage.get(member.id);
    if (existing !== undefined && existing.estimated !== true) return;
    const ref = member.session_ref;
    this.track((async () => {
      const peeked = await adapter.peekContextUsage!(ref);
      if (peeked === undefined) return;
      // The artifact scan cannot see settings-applied windows (e.g. the 1m
      // beta), so an engine-reported window persisted on the member outranks
      // the peek's curated guess; the used-tokens estimate stays the peek's.
      const persisted = this.store.getMemberContextWindow(room, member.id);
      const seeded = persisted === undefined ? peeked : { ...peeked, contextWindowMaxTokens: persisted };
      const current = this.lastUsage.get(member.id);
      if (current !== undefined && current.estimated !== true) return; // live won meanwhile
      if (isDeepStrictEqual(current, seeded)) return;
      this.lastUsage.set(member.id, { ...seeded });
      const fresh = this.store.getMember(room, member.id);
      if (fresh !== undefined && fresh.removed_ts === undefined) this.emitMember(room, fresh);
    })().catch(() => undefined));
  }
  // harn:end last-agent-usage-is-transient-and-seeded

  private memberWithLastUsage(room: string, member: Member): Member {
    const lastUsage = this.lastUsage.get(member.id);
    return lastUsage === undefined ? member : { ...member, lastUsage: { ...lastUsage } };
  }
  // harn:end last-agent-usage-is-transient-and-seeded

  // harn:assume engine-reported-window-outlives-restarts ref=persisted-window-seed
  /** Persist the engine's reported window (a stable engine fact, unlike usage)
   *  so estimated seeds after a restart present the true ceiling. */
  private landContextWindow(room: string, memberId: string, usage: AgentUsage | undefined): void {
    const window = usage?.contextWindowMaxTokens;
    if (usage?.estimated === true || typeof window !== 'number' || window <= 0) return;
    if (this.store.getMemberContextWindow(room, memberId) === window) return;
    this.store.setMemberContextWindow(room, memberId, window);
  }
  // harn:end engine-reported-window-outlives-restarts

  private emitMember(room: string, member: Member): void {
    // harn:assume live-agent-waits-are-transient ref=wait-member-projection
    // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-member-projection
    const waiting = this.memberWaits.get(member.id);
    this.emit(room, {
      type: 'member',
      seq: this.store.currentSeq(room),
      member: { ...this.memberWithLastUsage(room, member), ...(waiting && { waiting }) },
    });
    // harn:end last-agent-usage-is-transient-and-seeded
    // harn:end live-agent-waits-are-transient
  }

  private landMemberLimits(room: string, memberId: string, limits: AgentLimit[]): void {
    const member = this.store.getMember(room, memberId);
    if (!member || member.removed_ts !== undefined) return;
    if (isDeepStrictEqual(member.limits, limits)) return;
    this.emitMember(room, this.store.updateMember(room, member.id, { limits }));
  }

  // harn:assume push-only-for-human-targeted-events ref=push-target-dispatch
  private emitInbox(room: string, delivery: Delivery): void {
    this.emit(room, { type: 'inbox', seq: this.store.currentSeq(room), delivery });
    const recipient = this.store.getMember(room, delivery.recipient);
    if (recipient?.kind !== 'human' || delivery.state !== 'consumed' || delivery.read_ts !== undefined) {
      return;
    }
    const message = this.store.getMessage(room, delivery.message_id);
    if (!message || !['chat', 'run', 'ask', 'approval'].includes(message.kind)) return;
    const kind: HumanPushKind = message.kind === 'ask' || message.kind === 'approval'
      ? message.kind
      : 'inbox';
    this.queueHumanPush(room, message.id, kind, message.body, [recipient.id], delivery.id);
  }

  private queueHumanPush(
    room: string,
    messageId: number,
    kind: HumanPushKind,
    preview: string,
    targetHumanIds: string[],
    deliveryId?: string,
  ): void {
    if (!this.pushProducer || targetHumanIds.length === 0) return;
    this.track(
      this.pushProducer.notify({
        room,
        msg_id: messageId,
        kind,
        preview,
        target_human_ids: targetHumanIds,
        ...(deliveryId && { delivery_id: deliveryId }),
      }).then((results) => {
        const failures = results.filter((result) => result.status === 'failed');
        if (failures.length > 0) {
          const statuses = failures.map((result) => result.http_status ?? result.error ?? 'unknown').join(',');
          throw new Error(`push delivery failed for ${String(failures.length)} device(s): ${statuses}`);
        }
      }),
    );
  }
  // harn:end push-only-for-human-targeted-events

  // ── room / member management ──────────────────────────────────────────

  // harn:assume channel-creation-derived-and-seeded ref=derived-channel-creation
  createRoom(opts: CreateRoomRequest): ReturnType<Store['createRoom']> {
    // harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=starting-agent-create-validation
    if (opts.starting_agent?.handle === opts.owner.handle) {
      throw new Error(
        `starting agent handle @${opts.starting_agent.handle} is already in use by the channel owner`,
      );
    }
    // harn:end starting-agent-name-derives-one-valid-identity-v6
    const baseId = opts.id ?? deriveRoomId(opts.name);
    let id = baseId;
    if (opts.id === undefined) {
      for (let suffix = 2; this.store.getRoom(id); suffix++) id = `${baseId}-${String(suffix)}`;
    }
    // harn:assume spawn-default-cwd-is-absolute-or-empty ref=implicit-starting-agent-cwd
    const cwd = opts.cwd !== undefined
      ? normalizeWorkingDirectory(opts.cwd, this.homeDir)
      : opts.starting_agent !== undefined
        ? normalizeWorkingDirectory(process.cwd(), this.homeDir)
        : undefined;
    // harn:end spawn-default-cwd-is-absolute-or-empty
    const created = this.store.createRoom({
      id,
      name: opts.name,
      owner: opts.owner,
      config: {
        ...(opts.color !== undefined && { color: opts.color }),
        ...(cwd !== undefined && { cwd }),
        // harn:assume channel-starting-agent-handle-persisted ref=starting-agent-creation-record
        ...(opts.starting_agent !== undefined && {
          starting_agent_handle: opts.starting_agent.handle,
        }),
        // harn:end channel-starting-agent-handle-persisted
      },
    });
    if (opts.starting_agent) {
      try {
        this.spawnMember(id, {
          ...opts.starting_agent,
          cwd: cwd!,
        });
      } catch (error) {
        this.postSystemMessage(
          id,
          `could not spawn @${opts.starting_agent.handle}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return created;
  }
  // harn:end channel-creation-derived-and-seeded

  configureRoom(room: string, patch: Parameters<Store['updateRoomConfig']>[1]) {
    const updated = this.store.updateRoomConfig(room, patch);
    this.emit(room, { type: 'room', seq: this.store.currentSeq(room), room: updated });
    return updated;
  }

  enableLedger(room: string): void {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    if (!this.ledger) throw new Error('ledger is not configured');
    this.ledger.enable(room);
  }

  addLedgerNote(room: string, write: LedgerWrite): LedgerNote {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    if (!this.ledger) throw new Error('ledger is not configured');
    return this.ledger.add(room, write);
  }

  getLedgerNote(room: string, name: string): LedgerNote | undefined {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    return this.ledger?.note(room, name);
  }

  ledgerSnapshot(room: string): Record<string, string> {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    return this.ledger?.snapshot(room) ?? {};
  }

  ledgerGraph(room: string): LedgerGraph {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    return this.ledger?.graph(room) ?? { nodes: [], edges: [] };
  }

  // harn:assume bridge-enable-admin-or-owner ref=bridge-daemon-ingress
  enableBridge(
    room: string,
    platform: 'slack' | 'telegram',
    channel: string,
  ): { member: Member; after: number } {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    const normalizedChannel = channel.trim();
    if (normalizedChannel === '') throw new Error('bridge channel is required');
    const handle = `${platform}-bridge`;
    const existing = this.store.getMemberByHandle(room, handle);
    if (existing) {
      if (existing.kind !== 'bridge') throw new Error(`handle @${handle} is already in use`);
      const expectedName = `${platform === 'slack' ? 'Slack' : 'Telegram'} · ${normalizedChannel}`;
      if (existing.display_name !== expectedName) {
        throw new Error(`${platform} bridge is already paired to another channel`);
      }
      if (this.store.getRoom(room)?.config.bridged !== true) {
        this.configureRoom(room, { bridged: true });
      }
      return { member: existing, after: this.store.latestMessageId(room) };
    }
    const member = this.store.addMember(room, {
      kind: 'bridge',
      handle,
      display_name: `${platform === 'slack' ? 'Slack' : 'Telegram'} · ${normalizedChannel}`,
    });
    this.emitMember(room, member);
    this.configureRoom(room, { bridged: true });
    return { member, after: this.store.latestMessageId(room) };
  }

  postBridgeMessage(
    room: string,
    bridgeMemberId: string,
    body: string,
    origin: BridgeOrigin,
  ): { message: Message; deduped: boolean } {
    const bridge = this.store.getMember(room, bridgeMemberId);
    if (bridge?.kind !== 'bridge') throw new Error(`no such bridge member: ${bridgeMemberId}`);
    const platform = bridge.handle.endsWith('-bridge')
      ? bridge.handle.slice(0, -'-bridge'.length)
      : '';
    if (origin.platform !== platform) throw new Error('bridge origin platform does not match member');
    const normalizedBody = body.trim();
    if (normalizedBody === '') throw new Error('bridge message body is required');
    const parsed = parseBody(normalizedBody, this.store.listMembers(room));
    const result = this.store.postBridgeMessage(
      room,
      bridgeMemberId,
      normalizedBody,
      origin,
      parsed,
      (message) => {
        const planned = this.planRoutedMessage(room, message, undefined, undefined, false, true);
        return planned.plan;
      },
    );
    if (!result.deduped) {
      this.emitMessage(room, result.message);
      if (result.member) this.emitMember(room, result.member);
      this.dispatchCreatedDeliveries(room, result.deliveries);
    }
    return result;
  }

  bridgeMessagesAfter(room: string, after: number, limit = 100): Message[] {
    if (!this.store.getRoom(room)) throw new Error(`no such room ${room}`);
    return this.store.listMessagesAfter(room, after, limit);
  }
  // harn:end bridge-enable-admin-or-owner

  ownerOf(room: string): Member {
    const owner = this.store.listMembers(room).find((m) => m.kind === 'human' && m.role === 'owner');
    if (!owner) throw new Error(`room ${room} has no owner`);
    return owner;
  }

  // harn:assume adapters-own-their-model-catalog ref=adapter-model-discovery
  /**
   * Ask every adapter that can answer what models its harness takes. Runs once,
   * in the background, at registration — never on a request path, because a hung
   * CLI must not be able to wedge /api/adapters, which gates both dialogs.
   * Any failure leaves the harness without a list: the dialog then offers the
   * custom escape, which is a worse UI, not a broken one.
   */
  private discoverModels(): void {
    for (const adapter of this.adapters.values()) {
      if (!adapter.listModels) continue;
      this.pendingDiscoveries += 1;
      void adapter.listModels().finally(() => {
        this.pendingDiscoveries -= 1;
      }).then(
        (catalog) => {
          const models = catalog.models.filter((model) => MODEL_ID.test(model)).slice(0, MAX_MODELS);
          if (models.length > 0) this.modelCatalogs.set(adapter.id, { ...catalog, models });
        },
        (error: unknown) => this.onBackgroundError(
          error instanceof Error ? error : new Error(`${adapter.id} model discovery failed`),
        ),
      );
    }
  }

  // harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-pending-signal
  /**
   * True while a harness that can answer still hasn't. It lets a browser tell an
   * empty catalog apart from an unfinished one, so a page loaded during discovery
   * asks again instead of stranding the operator with no models until reload.
   */
  modelDiscoveryPending(): boolean {
    return this.pendingDiscoveries > 0;
  }
  // harn:end model-catalogs-reach-a-browser-that-arrives-early

  registeredAdapters(): {
    id: string;
    capabilities: HarnessAdapter['capabilities'];
    models?: string[];
    models_source?: ModelCatalog['source'];
  }[] {
    return [...this.adapters.values()]
      .map((adapter) => {
        const catalog = this.modelCatalogs.get(adapter.id);
        return {
          id: adapter.id,
          capabilities: adapter.capabilities,
          ...(catalog && { models: catalog.models, models_source: catalog.source }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  // harn:end adapters-own-their-model-catalog

  /** Provider limits are account-level: one probe fans out to every active
   * agent using that harness. Missing credentials and failures preserve the
   * last stream-reported value. */
  private async probeAdapterLimits(): Promise<void> {
    if (this.probingLimits || this.closing) return;
    this.probingLimits = true;
    try {
      const membersByHarness = new Map<string, { room: string; member: Member }[]>();
      for (const room of this.store.listRooms()) {
        for (const member of this.store.listMembers(room.id)) {
          if (member.kind !== 'agent' || member.harness === undefined) continue;
          const members = membersByHarness.get(member.harness) ?? [];
          members.push({ room: room.id, member });
          membersByHarness.set(member.harness, members);
        }
      }

      for (const adapter of this.adapters.values()) {
        const targets = membersByHarness.get(adapter.id);
        if (!adapter.probeLimits || targets === undefined || targets.length === 0) continue;
        let limits: AgentLimit[] | undefined;
        try {
          limits = await adapter.probeLimits();
        } catch {
          continue;
        }
        if (this.closing || limits === undefined || limits.length === 0) continue;
        for (const target of targets) {
          const current = this.store.getMember(target.room, target.member.id);
          if (
            current?.kind !== 'agent'
            || current.harness !== adapter.id
            || current.removed_ts !== undefined
          ) continue;
          this.landMemberLimits(target.room, current.id, limits);
        }
      }
    } finally {
      this.probingLimits = false;
    }
  }

  setHumanRole(room: string, memberId: string, role: Role): Member {
    const member = this.store.getMember(room, memberId);
    if (member?.kind !== 'human') throw new Error(`no such human member: ${memberId}`);
    if (member.role === 'owner' && role !== 'owner') {
      const owners = this.store.listMembers(room).filter((candidate) =>
        candidate.kind === 'human' && candidate.role === 'owner');
      if (owners.length === 1) throw new Error('a room must retain at least one owner');
    }
    const updated = this.store.updateMember(room, memberId, { role });
    this.emitMember(room, updated);
    this.postSystemMessage(room, `@${updated.handle} is now ${role}`);
    return updated;
  }

  // harn:assume pins-are-durable-owner-admin-markers ref=pin-message-contract
  /**
   * Pin or unpin a message. Only human owners/admins may flip it — the server's
   * capability gate enforces the role, and this refuses non-humans/underprivileged
   * callers defensively so a direct daemon call cannot bypass the contract.
   * Idempotent: re-flipping to the same value changes nothing and emits nothing.
   * The flip rides the change log like any message edit; it never re-routes
   * deliveries or touches run journals.
   */
  pinMessage(room: string, messageId: number, pinned: boolean, byMemberId: string): Message {
    const actor = this.store.getMember(room, byMemberId);
    if (actor?.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new Error('forbidden: only owners and admins can pin messages');
    }
    const message = this.store.getMessage(room, messageId);
    if (!message) throw new Error(`no such message: #${messageId}`);
    if (pinned && message.deleted === true) {
      throw new Error('cannot pin a deleted message'); // a tombstone is not a pin target
    }
    if ((message.pinned === true) === pinned) return message; // idempotent — emit nothing
    const updated = this.store.setMessagePinned(room, messageId, pinned);
    this.emitMessage(room, updated);
    return updated;
  }
  // harn:end pins-are-durable-owner-admin-markers

  // harn:assume deleted-messages-purge-rows-and-files ref=delete-message-contract
  /**
   * Purge a chat message, leaving a durable [deleted] tombstone. Only human
   * owners/admins may delete (the server gate enforces the role; this refuses
   * non-humans/underprivileged callers defensively). Only chat messages qualify
   * — run rows are journal evidence and system rows are daemon speech, both
   * refused. Idempotent when already deleted (emits nothing). Still-pending
   * deliveries (queued or held) of the message are cancelled so purged content
   * never delivers late; already-consumed deliveries keep their snapshots. Any
   * attachment files are unlinked from disk (the store nulls their metadata).
   * Deletion never renumbers messages or touches run journals.
   */
  deleteMessage(room: string, messageId: number, byMemberId: string): Message {
    const actor = this.store.getMember(room, byMemberId);
    if (actor?.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new Error('forbidden: only owners and admins can delete messages');
    }
    const message = this.store.getMessage(room, messageId);
    if (!message) throw new Error(`no such message: #${messageId}`);
    if (message.kind !== 'chat') {
      throw new Error(`only chat messages can be deleted, not ${message.kind}`);
    }
    if (message.deleted === true) return message; // idempotent — emit nothing
    const tombstone = this.store.deleteMessage(room, messageId);
    // The store nulled the metadata column; remove the bytes from disk too.
    this.unlinkAttachments(room, message.attachments);
    // Cancel still-pending deliveries so the purged body is never delivered.
    for (const delivery of this.store.listDeliveries(room)) {
      if (delivery.message_id !== messageId) continue;
      if (delivery.state !== 'queued' && delivery.state !== 'held') continue;
      this.emitInbox(room, this.store.updateDelivery(room, delivery.id, { state: 'consumed' }));
    }
    this.emitMessage(room, tombstone);
    return tombstone;
  }
  // harn:end deleted-messages-purge-rows-and-files

  memberDetails(room: string): MemberDetails[] {
    const messages = this.store.listMessages(room, { limit: Number.MAX_SAFE_INTEGER });
    return this.store.listMembers(room).map((member) => {
      const runs = messages.filter(
        (message) =>
          message.kind === 'run' &&
          message.author === member.id &&
          message.run?.status !== 'running',
      );
      return {
        // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-member-projection
        member: this.memberWithLastUsage(room, member),
        // harn:end last-agent-usage-is-transient-and-seeded
        queued_count: this.store.listDeliveries(room, {
          recipient: member.id,
          state: 'queued',
        }).length,
        spend: runs.reduce(
          (total, message) => {
            const usage = message.run?.usage;
            // Self-reported cost wins. Otherwise estimate from tokens when the
            // member's model has a known price; an unpriced model stays uncosted
            // rather than being guessed.
            const estimate =
              usage !== undefined && usage.cost_usd === undefined
                ? estimateCostUsd(member.model, usage)
                : undefined;
            return {
              turns: total.turns + 1,
              input_tokens: total.input_tokens + (usage?.input_tokens ?? 0),
              output_tokens: total.output_tokens + (usage?.output_tokens ?? 0),
              cost_usd: total.cost_usd + (usage?.cost_usd ?? 0),
              estimated_cost_usd: total.estimated_cost_usd + (estimate ?? 0),
              uncosted_tokens:
                total.uncosted_tokens +
                (usage !== undefined && usage.cost_usd === undefined && estimate === undefined
                  ? usage.input_tokens + usage.output_tokens
                  : 0),
            };
          },
          {
            turns: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            estimated_cost_usd: 0,
            uncosted_tokens: 0,
          },
        ),
      };
    });
  }

  // harn:assume roster-briefing-refreshes-on-membership ref=roster-membership-transitions
  private markRostersStale(room: string): void {
    this.store.markAgentRostersStale(room);
  }
  // harn:end roster-briefing-refreshes-on-membership

  // harn:assume working-directories-validated-before-spawn ref=daemon-cwd-enforcement
  spawnMember(
    room: string,
    opts: {
      harness: string;
      handle: string;
      display_name?: string;
      cwd: string;
      policy?: string;
      model?: string;
      thinking?: Session['thinking'];
      purpose?: string;
    },
  ): Member {
    const cwd = normalizeWorkingDirectory(opts.cwd, this.homeDir);
    const adapter = this.requireAdapter(opts.harness);
    const spawnOpts = {
      cwd,
      policy: opts.policy,
      model: opts.model,
      thinking: opts.thinking,
    };
    // harn:assume canonical-spawn-controls-enforced ref=daemon-initial-spawn-validation
    validateSpawnOptions(adapter, spawnOpts);
    const session = adapter.spawn(spawnOpts);
    // harn:end canonical-spawn-controls-enforced
    const member = this.store.addMember(room, {
      kind: 'agent',
      handle: opts.handle,
      display_name: opts.display_name ?? opts.handle,
      purpose: opts.purpose,
      harness: opts.harness,
      cwd,
      policy: opts.policy,
      // harn:assume agent-model-and-thinking-are-durable ref=durable-agent-config-rebuild
      // These are turn arguments, re-derived from the session on every turn. Held only
      // in memory, they vanish on restart and the agent quietly becomes a different one.
      model: opts.model,
      thinking: opts.thinking,
      // harn:end agent-model-and-thinking-are-durable
      host: this.hostId,
      state: 'idle',
      custody: 'owned',
    });
    this.issueMemberCredential(room, member, session);
    this.sessions.set(member.id, session);
    this.markRostersStale(room);
    this.emitMember(room, member);
    return member;
  }
  // harn:end working-directories-validated-before-spawn

  // harn:assume room-home-single-authority ref=remote-run-home-finalization
  spawnRemoteMember(
    room: string,
    opts: {
      host: string;
      harness: string;
      handle: string;
      display_name?: string;
      cwd: string;
      policy?: string;
      session_ref?: string;
    },
  ): Member {
    if (!this.residency || !this.hostId) throw new Error('remote residency is not configured');
    if (opts.host === this.hostId) throw new Error('remote member host must differ from the room home');
    const member = this.store.addMember(room, {
      kind: 'agent',
      handle: opts.handle,
      display_name: opts.display_name ?? opts.handle,
      harness: opts.harness,
      session_ref: opts.session_ref,
      cwd: opts.cwd,
      policy: opts.policy,
      host: opts.host,
      state: this.residency.isReachable(opts.host) ? 'idle' : 'unreachable',
      custody: 'owned',
    });
    this.emitMember(room, member);
    return member;
  }

  private isRemoteMember(member: Member): member is Member & { host: string } {
    return member.kind === 'agent' && member.host !== undefined && member.host !== this.hostId;
  }

  private remoteRpcId(room: string, runMessageId: number): string {
    if (!this.hostId) throw new Error('remote residency requires a home host id');
    return `${this.hostId}:${room}:${String(runMessageId)}`;
  }
  // harn:end room-home-single-authority

  // harn:assume remote-deliveries-queue-when-unreachable ref=remote-member-reachability
  private handleResidentReachability(peerId: string, connected: boolean): void {
    for (const room of this.store.listRooms()) {
      for (const member of this.store.listMembers(room.id)) {
        if (!this.isRemoteMember(member) || member.host !== peerId) continue;
        if (member.state === 'dead' || member.state === 'paused' || member.state === 'custody_uncertain') {
          continue;
        }
        if (!connected) {
          if (member.state !== 'unreachable') {
            this.emitMember(room.id, this.store.updateMember(room.id, member.id, { state: 'unreachable' }));
          }
          continue;
        }
        const queued = this.store.listDeliveries(room.id, {
          recipient: member.id,
          state: 'queued',
        });
        const restored = this.store.updateMember(room.id, member.id, {
          state: queued.length > 0 ? 'queued' : 'idle',
        });
        this.emitMember(room.id, restored);
        this.track(this.maybeStartTurn(room.id, member.id));
      }
    }
    if (connected) this.track(this.reconcile());
  }
  // harn:end remote-deliveries-queue-when-unreachable

  private attachedSession(member: Member): Session {
    if (!member.harness || !member.session_ref) {
      throw new Error(`member @${member.handle} has no resumable session`);
    }
    const adapter = this.requireAdapter(member.harness);
    if (!adapter.capabilities.resume) {
      throw new Error(`adapter '${adapter.id}' does not support resume`);
    }
    const session = adapter.attach(member.session_ref);
    session.cwd = member.cwd ?? session.cwd;
    session.policy = member.policy;
    // A revived agent must be the SAME agent: same model, same thinking level.
    session.model = member.model;
    session.thinking = member.thinking;
    const located = this.store.listRooms().find((room) =>
      this.store.getMember(room.id, member.id) !== undefined);
    if (!located) throw new Error(`no room for agent member: ${member.id}`);
    this.issueMemberCredential(located.id, member, session);
    return session;
  }

  // harn:assume revive-via-session-ref ref=revive-native-session
  reviveMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (existing.state !== 'dead') throw new Error(`member @${existing.handle} is not dead`);
    if (this.store.getAttachLeaseForMember(memberId) || this.pendingAttach.has(memberId)) {
      throw new Error(`member @${existing.handle} has an active interactive attach lease`);
    }
    const session = this.attachedSession(existing);
    this.sessions.set(memberId, session);
    const member = this.store.updateMember(room, memberId, { state: 'idle', custody: 'owned' });
    this.emitMember(room, member);
    this.track(this.maybeStartTurn(room, memberId));
    return member;
  }
  // harn:end revive-via-session-ref

  // harn:assume adoption-explicit-or-sessionend ref=mirrored-adoption-transition
  joinMember(
    room: string,
    opts: {
      harness: string;
      handle: string;
      session_ref: string;
      cwd: string;
      policy?: string;
      purpose?: string;
    },
  ): Member {
    const cwd = normalizeWorkingDirectory(opts.cwd, this.homeDir);
    const adapter = this.requireAdapter(opts.harness);
    if (!adapter.capabilities.resume) {
      throw new Error(`adapter '${adapter.id}' cannot back a persistent mirrored member`);
    }
    const joined = this.store.findMemberBySessionRef(opts.harness, opts.session_ref);
    if (joined) {
      throw new Error(
        `session ${opts.session_ref} is already @${joined.member.handle} in room ${joined.room}`,
      );
    }
    const member = this.store.addMember(room, {
      kind: 'agent',
      handle: opts.handle,
      display_name: opts.handle,
      purpose: opts.purpose,
      harness: opts.harness,
      session_ref: opts.session_ref,
      cwd,
      policy: opts.policy,
      state: 'idle',
      custody: 'mirrored',
    });
    this.markRostersStale(room);
    this.emitMember(room, member);
    // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-seeding
    this.seedContextUsage(room, member);
    // harn:end last-agent-usage-is-transient-and-seeded
    this.postSystemMessage(room, `@${member.handle} joined from a live ${opts.harness} terminal`);
    return member;
  }

  adoptMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (existing.custody !== 'mirrored') throw new Error(`member @${existing.handle} is not mirrored`);
    const lease = this.store.getAttachLeaseForMember(memberId);
    if (lease) {
      if (existing.state !== 'custody_uncertain' || this.attachChildRecorded(lease)) {
        throw new Error(`member @${existing.handle} has an active interactive attach lease`);
      }
      this.store.deleteAttachLease(lease.id);
    }
    return this.adoptMirroredMember(room, existing, `@${existing.handle} was adopted by the switchboard`);
  }

  private adoptMirroredMember(room: string, existing: Member, systemMessage: string): Member {
    const session = this.attachedSession(existing);
    this.sessions.set(existing.id, session);
    const member = this.store.updateMember(room, existing.id, {
      custody: 'owned',
      state: 'idle',
    });
    this.markRostersStale(room);
    this.emitMember(room, member);
    this.postSystemMessage(room, systemMessage);
    this.track(this.maybeStartTurn(room, member.id));
    return member;
  }

  mirrorSessionEnd(harness: string, sessionRef: string): boolean {
    if (harness !== 'claude-code') return false;
    const joined = this.store.findMemberBySessionRef(harness, sessionRef);
    if (!joined || joined.member.custody !== 'mirrored') return false;
    if (this.store.getAttachLeaseForMember(joined.member.id)) return false;
    this.adoptMember(joined.room, joined.member.id);
    return true;
  }
  // harn:end adoption-explicit-or-sessionend

  // harn:assume attach-custody-lease-tracks-child-pid ref=attach-release-handshake
  async acquireAttachLease(
    room: string,
    memberId: string,
    cliPid: number,
  ): Promise<{ lease: AttachLease; member: Member }> {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (existing.custody !== 'owned') throw new Error(`member @${existing.handle} is not switchboard-owned`);
    // harn:assume cli-member-recovery-is-actionable ref=attach-error-remediation
    if (existing.state === 'dead') {
      throw new Error(
        existing.session_ref
          ? `member @${existing.handle} is dead; revive it to retry`
          : `member @${existing.handle} is dead; remove it and spawn a replacement`,
      );
    }
    // harn:end cli-member-recovery-is-actionable
    if (existing.state === 'awaiting_input') {
      throw new Error(`member @${existing.handle} is awaiting input; answer or interrupt it before attach`);
    }
    if (!existing.session_ref) throw new Error(`member @${existing.handle} has no resumable session yet`);
    const adapter = this.requireAdapter(existing.harness!);
    if (!adapter.capabilities.interactiveAttach) {
      throw new Error(`adapter '${adapter.id}' does not support interactive attach`);
    }
    if (this.store.getAttachLeaseForMember(memberId) || this.pendingAttach.has(memberId)) {
      throw new Error(`member @${existing.handle} already has an attach lease`);
    }

    this.pendingAttach.add(memberId);
    try {
      while (this.inflight.has(memberId)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const current = this.store.getMember(room, memberId);
      if (!current || current.custody !== 'owned') {
        throw new Error(`member @${existing.handle} changed custody while attach was waiting`);
      }
      if (current.state === 'awaiting_input') {
        throw new Error(`member @${existing.handle} is awaiting input; answer or interrupt it before attach`);
      }
      const lease = this.store.createAttachLease({
        room,
        member_id: memberId,
        cli_pid: cliPid,
        heartbeat_ts: Date.now(),
      });
      try {
        const queued = this.store.listDeliveries(room, {
          recipient: memberId,
          state: 'queued',
        }).length;
        const member = this.store.updateMember(room, memberId, {
          custody: 'mirrored',
          state: queued > 0 ? 'queued' : 'idle',
        });
        this.sessions.delete(memberId);
        this.emitMember(room, member);
        this.postSystemMessage(room, `@${member.handle} released to an interactive terminal`);
        return { lease, member };
      } catch (error) {
        this.store.deleteAttachLease(lease.id);
        throw error;
      }
    } finally {
      this.pendingAttach.delete(memberId);
    }
  }

  reportAttachChild(
    leaseId: string,
    childPid: number,
    processGroupId: number,
  ): { lease: AttachLease; member: Member } {
    const lease = this.store.setAttachLeaseChild(leaseId, childPid, processGroupId, Date.now());
    const member = this.store.getMember(lease.room, lease.member_id);
    if (!member) throw new Error(`attach lease ${leaseId} has no member`);
    return { lease, member };
  }

  heartbeatAttachLease(leaseId: string): void {
    this.store.heartbeatAttachLease(leaseId, Date.now());
  }

  completeAttachLease(leaseId: string): {
    status: 'completed' | 'uncertain';
    lease?: AttachLease;
    member: Member;
  } {
    const lease = this.store.getAttachLease(leaseId);
    if (!lease) throw new Error(`no such attach lease ${leaseId}`);
    if (!this.attachChildRecorded(lease)) {
      const member = this.markCustodyUncertain(
        lease,
        'attach completed before its native child identity was recorded; custody is uncertain',
      );
      return { status: 'uncertain', lease, member };
    }
    if (this.attachChildAlive(lease)) {
      const member = this.markCustodyUncertain(lease);
      return { status: 'uncertain', lease, member };
    }
    return { status: 'completed', member: this.finishAttachLease(lease) };
  }
  // harn:end attach-custody-lease-tracks-child-pid

  // harn:assume custody-uncertain-never-double-writes ref=attach-lease-loss-reconcile
  reconcileAttachLeases(now = Date.now()): void {
    for (const lease of this.store.listAttachLeases()) {
      if (now - lease.heartbeat_ts <= this.attachLeaseTimeoutMs) continue;
      if (!this.attachChildRecorded(lease)) {
        this.markCustodyUncertain(
          lease,
          'attach heartbeat expired before its native child identity was recorded; custody is uncertain',
        );
      } else if (this.attachChildAlive(lease)) this.markCustodyUncertain(lease);
      else this.finishAttachLease(lease);
    }
  }

  private attachChildRecorded(lease: AttachLease): boolean {
    return lease.process_group_id !== undefined || lease.child_pid !== undefined;
  }

  private attachChildAlive(lease: AttachLease): boolean {
    if (lease.process_group_id !== undefined) return this.processProbe(-lease.process_group_id);
    if (lease.child_pid !== undefined) return this.processProbe(lease.child_pid);
    return false;
  }

  private markCustodyUncertain(
    lease: AttachLease,
    reason = 'attach heartbeat was lost while its terminal may still be alive; custody is uncertain',
  ): Member {
    const existing = this.store.getMember(lease.room, lease.member_id);
    if (!existing) throw new Error(`attach lease ${lease.id} has no member`);
    if (existing.state === 'custody_uncertain') return existing;
    const member = this.store.updateMember(lease.room, lease.member_id, {
      custody: 'mirrored',
      state: 'custody_uncertain',
    });
    this.emitMember(lease.room, member);
    this.postSystemMessage(
      lease.room,
      `@${member.handle} ${reason}`,
    );
    return member;
  }

  private finishAttachLease(lease: AttachLease): Member {
    const existing = this.store.getMember(lease.room, lease.member_id);
    if (!existing || existing.kind !== 'agent') throw new Error(`attach lease ${lease.id} has no agent member`);
    const session = this.attachedSession(existing);
    this.sessions.set(existing.id, session);
    this.store.deleteAttachLease(lease.id);
    const member = this.store.updateMember(lease.room, existing.id, {
      custody: 'owned',
      state: 'idle',
    });
    this.emitMember(lease.room, member);
    this.postSystemMessage(
      lease.room,
      `@${existing.handle} interactive terminal exited; the switchboard re-adopted its session`,
    );
    this.track(this.maybeStartTurn(lease.room, member.id));
    return member;
  }
  // harn:end custody-uncertain-never-double-writes

  // harn:assume member-config-is-changed-not-respawned ref=configure-member-daemon
  /**
   * Give a live agent new settings without losing it.
   *
   * The harness holds nothing: every turn is a fresh subprocess whose arguments are
   * re-derived from the session, and the conversation lives in the resume token on the
   * member row. So a change writes the row and DISCARDS the cached session — the next
   * turn rebuilds from that row and runs entirely on the new settings, while a turn
   * already in flight keeps the session object it started with and completes entirely
   * on the old ones. A turn can therefore never be assembled out of a mixture of the
   * two: not because we were careful, but because there is only ever one row to read.
   *
   * `undefined` leaves a setting alone; `null` clears it back to the harness default.
   */
  configureMember(
    room: string,
    memberId: string,
    changes: { model?: string | null; thinking?: ThinkingLevel | null; policy?: Policy },
    opts: { actor?: string } = {},
  ): Member {
    const member = this.store.getMember(room, memberId);
    if (!member || member.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (member.removed_ts !== undefined) throw new Error(`member @${member.handle} was removed`);
    // harn:assume a-permission-change-is-never-silent ref=configure-custody-and-capability-guards
    // A mirrored member's session lives on another switchboard. A half-applied remote
    // change is worse than a refused one, so refuse it here and say where to go.
    if (member.custody === 'mirrored') {
      throw new Error(
        `member @${member.handle} is mirrored from another switchboard; configure it there`,
      );
    }

    const settled = <T>(next: T | null | undefined, current: T | undefined): T | undefined =>
      next === undefined ? current : (next ?? undefined);
    const next = {
      cwd: member.cwd ?? process.cwd(),
      model: settled(changes.model, member.model),
      thinking: settled(changes.thinking, member.thinking),
      policy: settled(changes.policy, member.policy),
    };
    // The same single gate the spawn path uses: an unknown policy, or a thinking level
    // this harness cannot honour, is refused rather than recorded as a preference it
    // would silently ignore.
    validateSpawnOptions(this.requireAdapter(member.harness!), next);
    // harn:end a-permission-change-is-never-silent

    const updated = this.store.updateMember(room, memberId, {
      model: next.model,
      thinking: next.thinking,
      policy: next.policy,
    });
    // The next turn rebuilds from the row we just wrote. A turn already in flight keeps
    // the session it started with — including for the ask cards it has already raised.
    this.staleSessions.add(memberId);

    // harn:assume a-permission-change-is-never-silent ref=configure-audit-message
    // Raising what an agent may do to the operator's machine is a consequential act. A
    // capability change visible only as a flicker in a member frame is one nobody saw.
    const changed = ([
      ['policy', member.policy, updated.policy],
      ['model', member.model, updated.model],
      ['thinking', member.thinking, updated.thinking],
    ] as const)
      .filter(([, before, after]) => before !== after)
      .map(([field, before, after]) => `${field}: ${before ?? 'default'} → ${after ?? 'default'}`);
    if (changed.length > 0) {
      const actor = opts.actor === undefined ? undefined : this.store.getMember(room, opts.actor);
      this.postSystemMessage(
        room,
        `@${actor?.handle ?? 'someone'} changed @${updated.handle} — ${changed.join(', ')}`,
      );
    }
    // harn:end a-permission-change-is-never-silent

    this.emitMember(room, updated);
    return updated;
  }
  // harn:end member-config-is-changed-not-respawned

  killMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (this.store.getAttachLeaseForMember(memberId) || this.pendingAttach.has(memberId)) {
      throw new Error(`member @${existing.handle} has an active interactive attach lease`);
    }
    const session = this.sessions.get(memberId);
    if (existing.harness && session) this.requireAdapter(existing.harness).interrupt(session);
    for (const interaction of this.store.listInteractions(room)) {
      if (
        interaction.member_id === memberId &&
        (interaction.state === 'pending' || interaction.state === 'answered')
      ) {
        this.orphanInteraction(room, interaction);
      }
    }
    this.memberWaits.delete(memberId);
    this.groupWaits.delete(memberId);
    const member = this.store.updateMember(room, memberId, { state: 'dead' });
    this.emitMember(room, member);
    for (const delivery of this.store.listDeliveries(room, { recipient: memberId })) {
      if (
        delivery.group_id !== undefined &&
        delivery.run_msg_id === undefined &&
        (delivery.state === 'queued' || delivery.state === 'held')
      ) {
        this.skipUnavailableGroupDelivery(room, delivery);
      }
    }
    this.postSystemMessage(
      room,
      member.session_ref
        ? `@${member.handle} was killed; revive to retry`
        : `@${member.handle} was killed; remove it and spawn a replacement`,
    );
    return member;
  }

  pauseMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (existing.state === 'dead') throw new Error(`member @${existing.handle} is dead; revive it instead`);
    const member = this.store.updateMember(room, memberId, { state: 'paused' });
    this.emitMember(room, member);
    return member;
  }

  unpauseMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    if (existing.state !== 'paused') throw new Error(`member @${existing.handle} is not paused`);
    const member = this.store.updateMember(room, memberId, { state: 'idle' });
    this.emitMember(room, member);
    this.track(this.maybeStartTurn(room, memberId));
    return member;
  }

  interruptMember(room: string, memberId: string): void {
    const member = this.store.getMember(room, memberId);
    const session = this.sessions.get(memberId);
    if (member?.harness && session) {
      if (this.inflight.has(memberId)) this.operatorInterrupts.add(memberId);
      this.requireAdapter(member.harness).interrupt(session);
    }
  }

  // harn:assume manual-compaction-is-an-operator-act ref=compact-member-contract
  /**
   * Compact an agent's engine session on an operator's explicit request. Codor
   * never triggers compaction itself; this is the on-demand lever for a human
   * watching the context ring climb. Owner/admin humans only (the server gate
   * enforces the role, this refuses others defensively), and only for an IDLE
   * agent with a live session: compacting mid-turn races the engine rewriting
   * the same history, so an in-flight member is refused and told to stop first.
   * The harness does the compaction natively — a harness that cannot say so
   * clearly rather than silently doing nothing. When the engine reports its
   * re-baselined context, it lands as transient member usage exactly like live
   * turn telemetry, so the ring reflects the compaction immediately.
   */
  async compactMember(room: string, memberId: string, byMemberId: string): Promise<void> {
    const actor = this.store.getMember(room, byMemberId);
    if (actor?.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new Error('forbidden: only owners and admins can compact an agent session');
    }
    const member = this.store.getMember(room, memberId);
    if (member?.kind !== 'agent' || member.removed_ts !== undefined) {
      throw new Error(`no such agent member: ${memberId}`);
    }
    if (member.harness === undefined) throw new Error(`@${member.handle} has no harness to compact`);
    // Idle-only, and the two refusals are distinct on purpose: a turn in flight
    // is a "stop it first" the operator can act on, while paused/queued/dead is
    // a different problem entirely. A retained session is NOT evidence of idle —
    // a dead or paused member can still hold one.
    if (this.inflight.has(memberId) || member.state === 'running') {
      throw new Error(`@${member.handle} is running — stop the turn before compacting`);
    }
    if (member.state !== 'idle') {
      throw new Error(`@${member.handle} is ${member.state} — only an idle agent can be compacted`);
    }
    const session = this.sessions.get(memberId);
    if (session === undefined) throw new Error(`@${member.handle} has no live session to compact`);
    const adapter = this.requireAdapter(member.harness);
    if (adapter.compactSession === undefined) {
      throw new Error(`harness '${member.harness}' does not support compaction`);
    }
    const usage = await adapter.compactSession(session);
    this.landCompactedUsage(room, memberId, usage);
  }

  /**
   * The re-baseline takes the same transient path live turn telemetry does.
   * A member frame goes out on EVERY successful compaction, even when the
   * engine reported no usage: the UI needs a completion edge to stop showing
   * the operator a spinner, and silence is indistinguishable from still-working.
   */
  private landCompactedUsage(room: string, memberId: string, usage?: AgentUsage): void {
    if (usage !== undefined) {
      this.lastUsage.set(memberId, { ...usage });
      this.landContextWindow(room, memberId, usage);
    }
    const current = this.store.getMember(room, memberId);
    if (current !== undefined) this.emitMember(room, current);
  }
  // harn:end manual-compaction-is-an-operator-act

  // harn:assume rename-preserves-mention-resolution ref=member-rename-stable-mentions
  renameMember(room: string, memberId: string, handle: string, displayName?: string): Member {
    const before = this.store.getMember(room, memberId);
    if (!before || before.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    const collision = this.store.getMemberByHandle(room, handle);
    if (collision && collision.id !== memberId) {
      throw new Error(`handle '@${handle}' is already in use`);
    }
    const member = this.store.updateMember(room, memberId, {
      handle,
      ...(displayName !== undefined && { display_name: displayName }),
    });
    this.markRostersStale(room);
    this.emitMember(room, member);
    const body = `@${before.handle} is now @${handle}`;
    const secondStart = body.lastIndexOf('@');
    this.postSystemMessage(room, body, {
      mentions: [
        { member_id: member.id, start: 0, end: before.handle.length + 1 },
        { member_id: member.id, start: secondStart, end: secondStart + handle.length + 1 },
      ],
    });
    return member;
  }
  // harn:end rename-preserves-mention-resolution

  // harn:assume removed-members-remain-attribution-tombstones ref=member-removal-daemon
  removeMember(room: string, memberId: string): Member {
    const existing = this.store.getMember(room, memberId);
    if (!existing || existing.kind !== 'agent') throw new Error(`no such agent member: ${memberId}`);
    // harn:assume removing-an-agent-is-one-deliberate-step ref=remove-live-member
    // Removing an agent is ONE act, not a ritual of kill-then-find-the-other-button. The
    // invariant is preserved rather than bypassed: the member is still dead before it is
    // tombstoned — killMember interrupts the running turn, orphans its cards, and refuses
    // outright if an interactive attach lease is held, so nothing is ever half-removed.
    if (existing.state !== 'dead') this.killMember(room, memberId);
    // harn:end removing-an-agent-is-one-deliberate-step

    const member = this.store.updateMember(room, memberId, {
      removed_ts: new Date().toISOString(),
    });
    this.sessions.delete(memberId);
    this.staleSessions.delete(memberId);
    // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-runtime-registry
    this.lastUsage.delete(memberId);
    // harn:end last-agent-usage-is-transient-and-seeded

    // harn:assume removing-an-agent-is-one-deliberate-step ref=remove-drains-queued-work
    // Work addressed to a member that no longer exists has nowhere to go. Left queued it
    // would wait in the pump forever for an agent that is never coming back, and count
    // against a member the roster no longer shows.
    const abandoned = this.store.listDeliveries(room, { recipient: memberId, state: 'queued' });
    for (const delivery of abandoned) {
      if (delivery.group_id !== undefined) this.skipUnavailableGroupDelivery(room, delivery);
      else this.store.updateDelivery(room, delivery.id, { state: 'consumed' });
    }
    // harn:end removing-an-agent-is-one-deliberate-step

    this.markRostersStale(room);
    this.emitMember(room, member);
    this.postSystemMessage(
      room,
      abandoned.length > 0
        ? `@${member.handle} was removed; ${String(abandoned.length)} queued message${abandoned.length === 1 ? '' : 's'} dropped; its history remains attributed`
        : `@${member.handle} was removed; its history remains attributed`,
    );
    return member;
  }
  // harn:end removed-members-remain-attribution-tombstones

  private requireAdapter(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`no adapter registered for harness '${id}'`);
    return adapter;
  }

  /** Sessions are rebuilt from the persisted member row after a restart. */
  private sessionFor(room: string, member: Member): Session {
    // A configure since the last turn: discard the cached session so this turn is built
    // wholly from the row, and therefore wholly from the new settings.
    if (this.staleSessions.delete(member.id)) this.sessions.delete(member.id);
    let session = this.sessions.get(member.id);
    if (!session) {
      const adapter = this.requireAdapter(member.harness!);
      session =
        member.session_ref !== undefined
          ? adapter.attach(member.session_ref)
          : (() => {
              const spawnOpts = {
                cwd: member.cwd ?? process.cwd(),
                policy: member.policy,
                model: member.model,
                thinking: member.thinking,
              };
              // harn:assume canonical-spawn-controls-enforced ref=daemon-session-rebuild-validation
              validateSpawnOptions(adapter, spawnOpts);
              const rebuilt = adapter.spawn(spawnOpts);
              // harn:end canonical-spawn-controls-enforced
              return rebuilt;
            })();
      session.cwd = member.cwd ?? session.cwd; // revive MUST reuse the persisted cwd
      session.policy = member.policy;
      // harn:assume agent-model-and-thinking-are-durable ref=durable-agent-config-rebuild
      // This is the path a restart takes. Restoring cwd and policy but not these two is
      // how an agent silently reverted to its harness default model, mid-conversation.
      session.model = member.model;
      session.thinking = member.thinking;
      // harn:end agent-model-and-thinking-are-durable
      this.issueMemberCredential(room, member, session);
      this.sessions.set(member.id, session);
    }
    return session;
  }

  // ── posting ───────────────────────────────────────────────────────────

  private postChatMessage(
    room: string,
    body: string,
    authorId: string,
    replyTo?: number,
    awaitingReply = false,
    interim = false,
    attachments?: Attachment[],
  ): Message {
    const parsed = parseBody(body, this.store.listMembers(room));
    // harn:assume eligible-multi-agent-routing-starts-one-group ref=multi-agent-group-ingress
    const committed = this.store.commitRoutedMessage(room, {
      message: {
        author: authorId,
        kind: 'chat',
        body,
        mentions: parsed.mentions,
        refs: parsed.refs,
        ledger_refs: parsed.ledger_refs,
        reply_to: replyTo,
        ...(attachments !== undefined && attachments.length > 0 && { attachments }),
      },
      plan: (message) => this.planRoutedMessage(
        room,
        message,
        undefined,
        undefined,
        awaitingReply,
        !interim,
      ).plan,
    });
    this.emitMessage(room, committed.message);
    if (committed.member) this.emitMember(room, committed.member);
    this.dispatchCreatedDeliveries(room, committed.deliveries);
    return committed.message;
  }

  postHumanMessage(
    room: string,
    body: string,
    opts: { author?: string; reply_to?: number; attachments?: Attachment[] } = {},
  ): Message {
    const authorId = opts.author ?? this.ownerOf(room).id;
    const author = this.store.getMember(room, authorId);
    if (author?.kind !== 'human') throw new Error(`no such human author: ${authorId}`);
    return this.postChatMessage(room, body, authorId, opts.reply_to, false, false, opts.attachments);
  }

  // harn:assume agent-network-authority-is-narrow ref=agent-interim-post-ingress
  postAgentMessage(
    room: string,
    memberId: string,
    body: string,
    replyTo?: number,
    awaitingReply = false,
  ): Message {
    const author = this.store.getMember(room, memberId);
    if (!author || author.kind !== 'agent' || author.removed_ts !== undefined) {
      throw new Error(`no active agent author: ${memberId}`);
    }
    // harn:assume interim-agent-posts-are-nonfinal-routing ref=interim-post-classification
    // A latest running row makes this an interim post. It remains ordinary chat; status
    // derives the live-turn window from timestamps instead of changing Message kind.
    const currentRun = this.store.listRunMessages(room, { author: memberId, limit: 1 })[0];
    if (currentRun?.run?.status === 'running') this.noteRunActivity(room, currentRun.id);
    // harn:end interim-agent-posts-are-nonfinal-routing
    return this.postChatMessage(room, body, memberId, replyTo, awaitingReply, true);
  }
  // harn:end agent-network-authority-is-narrow

  // harn:assume live-agent-waits-are-transient ref=transient-wait-registry
  // harn:assume answered-approval-tools-can-register-live-waits ref=approved-tool-wait-eligibility
  private canUseLiveWait(room: string, member: Member): boolean {
    if (member.state === 'running') return true;
    if (member.state !== 'awaiting_input') return false;
    const openInteractions = this.store.listInteractions(room).filter((interaction) =>
      interaction.member_id === member.id
      && (interaction.state === 'pending' || interaction.state === 'answered'));
    return openInteractions.length > 0
      && openInteractions.every((interaction) => interaction.state === 'answered');
  }
  // harn:end answered-approval-tools-can-register-live-waits

  beginWait(
    room: string,
    memberId: string,
    input: {
      reason: NonNullable<Member['waiting']>['reason'];
      peers: string[];
      until_ts: string;
    },
    now = new Date(),
  ): Member {
    const member = this.store.getMember(room, memberId);
    if (!member || member.kind !== 'agent' || member.removed_ts !== undefined) {
      throw new Error(`no active agent member: ${memberId}`);
    }
    if (!this.canUseLiveWait(room, member)) {
      throw new Error(`member @${member.handle} cannot wait while ${member.state ?? 'inactive'}`);
    }
    const until = Date.parse(input.until_ts);
    if (!Number.isFinite(until) || until <= now.getTime()) {
      throw new Error('wait deadline must be in the future');
    }
    const run = this.store.listMessages(room, { limit: Number.MAX_SAFE_INTEGER })
      .reverse()
      .find((message) =>
        message.kind === 'run' && message.author === memberId && message.run?.status === 'running');
    if (!run) throw new Error(`member @${member.handle} has no running turn to wait in`);
    const peers = [...new Set(input.peers)];
    if (peers.length === 0 || peers.includes(memberId)) {
      throw new Error('wait peers must name at least one other member');
    }
    for (const peerId of peers) {
      const peer = this.store.getMember(room, peerId);
      if (!peer || peer.removed_ts !== undefined) throw new Error(`no active wait peer: ${peerId}`);
    }
    const waiting = {
      peers,
      reason: input.reason,
      since_ts: now.toISOString(),
      until_ts: input.until_ts,
    } satisfies NonNullable<Member['waiting']>;
    this.memberWaits.set(memberId, waiting);
    // harn:assume same-round-terminal-peers-end-live-waits ref=collaboration-wait-context
    const groupedDelivery = this.store.listDeliveries(room, { recipient: memberId })
      .find((delivery) => delivery.run_msg_id === run.id && delivery.group_id !== undefined);
    if (groupedDelivery?.group_id !== undefined && groupedDelivery.group_round !== undefined) {
      this.groupWaits.set(memberId, {
        room,
        groupId: groupedDelivery.group_id,
        roundNumber: groupedDelivery.group_round,
      });
    } else {
      this.groupWaits.delete(memberId);
    }
    // harn:end same-round-terminal-peers-end-live-waits
    this.noteRunActivity(room, run.id);
    this.emitMember(room, member);
    const groupContext = this.groupWaits.get(memberId);
    if (groupContext) {
      this.clearSatisfiedGroupWaits(room, groupContext.groupId, groupContext.roundNumber);
    }
    return this.memberWaits.has(memberId) ? { ...member, waiting } : member;
  }

  endWait(room: string, memberId: string): Member {
    const member = this.store.getMember(room, memberId);
    if (!member || member.kind !== 'agent' || member.removed_ts !== undefined) {
      throw new Error(`no active agent member: ${memberId}`);
    }
    if (!this.canUseLiveWait(room, member)) {
      throw new Error(`member @${member.handle} cannot end a wait while ${member.state ?? 'inactive'}`);
    }
    const run = this.store.listMessages(room, { limit: Number.MAX_SAFE_INTEGER })
      .reverse()
      .find((message) =>
        message.kind === 'run' && message.author === memberId && message.run?.status === 'running');
    if (!run) throw new Error(`member @${member.handle} has no running turn to end a wait in`);
    const changed = this.memberWaits.delete(memberId);
    this.groupWaits.delete(memberId);
    if (changed) this.emitMember(room, member);
    return member;
  }
  // harn:end live-agent-waits-are-transient

  postSystemMessage(
    room: string,
    body: string,
    opts: { mentions?: Message['mentions'] } = {},
  ): Message {
    const system = this.store.listMembers(room).find((m) => m.kind === 'system')!;
    const message = this.store.postMessage(room, {
      author: system.id,
      kind: 'system',
      body,
      mentions: opts.mentions,
    });
    this.emitMessage(room, message);
    return message; // system messages NEVER route (eligibility gate)
  }

  // harn:assume mirror-one-message-per-native-turn ref=mirrored-turn-dedupe-route
  mirrorTurn(input: {
    harness: string;
    session_ref: string;
    native_turn_id: string;
    body: string;
    transcript_path?: string;
  }): { message: Message; deduped: boolean } {
    const joined = this.store.findMemberBySessionRef(input.harness, input.session_ref);
    if (!joined) throw new Error(`no mirrored member for ${input.harness} session ${input.session_ref}`);
    if (joined.member.custody !== 'mirrored') {
      throw new Error(`member @${joined.member.handle} is not mirrored; native turn was dropped`);
    }

    const parsed = parseBody(input.body, this.store.listMembers(joined.room));
    const startedTs = new Date().toISOString();
    const committed = this.store.commitMirroredTurn(joined.room, {
      memberId: joined.member.id,
      nativeTurnId: input.native_turn_id,
      finalize: (placeholder) => {
        const eventsRef = this.blobs.ref(placeholder.id);
        const patch = {
          body: input.body,
          mentions: parsed.mentions,
          refs: parsed.refs,
          ledger_refs: parsed.ledger_refs,
          run: {
            status: 'completed' as const,
            started_ts: startedTs,
            ended_ts: startedTs,
            tool_calls: 0,
            events_ref: eventsRef,
            final_text: input.body,
            output_mode: 'messages' as const,
            result_message_id: placeholder.id,
          },
        };
        const draft: Message = { ...placeholder, ...patch };
        const planned = this.planRoutedMessage(
          joined.room,
          draft,
          this.ownerOf(joined.room).id,
          undefined,
          false,
          true,
        );
        return {
          message: patch,
          fanout: planned.plan.fanout,
          collaboration: planned.plan.collaboration,
          markMisaddressed: planned.result.misaddressed,
        };
      },
    });
    if (committed.deduped) return { message: committed.message, deduped: true };

    const eventsRef = committed.message.run!.events_ref;
    this.blobs.append(joined.room, eventsRef, {
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: {
        source: 'mirrored-turn',
        native_turn_id: input.native_turn_id,
        transcript_path: input.transcript_path,
      },
      output_message_id: committed.message.id,
    });
    this.blobs.append(joined.room, eventsRef, {
      type: 'run.completed',
      status: 'completed',
      final_text: input.body,
      output_message_id: committed.message.id,
    });
    this.emitMessage(joined.room, committed.message);
    if (committed.member) this.emitMember(joined.room, committed.member);
    this.dispatchCreatedDeliveries(joined.room, committed.deliveries);
    return { message: committed.message, deduped: false };
  }
  // harn:end mirror-one-message-per-native-turn
  // harn:end eligible-multi-agent-routing-starts-one-group

  // harn:assume extension-lifecycle-from-hooks ref=switchboard-extension-lifecycle
  private startExtension(
    room: string,
    parent: Member,
    event: Extract<WireEvent, { type: 'extension.started' }>,
    streamDescription?: string,
  ): Extract<WireEvent, { type: 'extension.started' }> {
    const description = streamDescription ?? event.description;
    let extension = this.store.getExtensionByNativeId(room, parent.id, event.ext_member);
    if (extension) {
      extension = this.store.updateMember(room, extension.id, {
        state: 'running',
        ...(description !== undefined && { display_name: description }),
      });
    } else {
      const suffix = extensionSuffix(event.ext_member);
      const handle = `${parent.handle.slice(0, 20)}-ext-${suffix}`;
      extension = this.store.addMember(room, {
        kind: 'extension',
        handle,
        display_name: description ?? `${parent.display_name} extension ${suffix}`,
        harness: parent.harness,
        session_ref: event.ext_member,
        cwd: parent.cwd,
        state: 'running',
        parent: parent.id,
      });
    }
    this.emitMember(room, extension);
    return {
      ...event,
      parent: parent.id,
      ext_member: extension.id,
      ...(description !== undefined && { description }),
    };
  }

  private endExtension(
    room: string,
    parent: Member,
    event: Extract<WireEvent, { type: 'extension.ended' }>,
  ): Extract<WireEvent, { type: 'extension.ended' }> {
    const existing = this.store.getExtensionByNativeId(room, parent.id, event.ext_member);
    if (!existing) return event;
    const extension = existing.state === 'dead'
      ? existing
      : this.store.updateMember(room, existing.id, { state: 'dead' });
    if (existing.state !== 'dead') this.emitMember(room, extension);
    return { ...event, ext_member: extension.id };
  }
  // harn:end extension-lifecycle-from-hooks

  // ── routing / fanout ──────────────────────────────────────────────────

  private latestFinalizedAgentAuthor(room: string): string | undefined {
    return this.store.latestFinalizedAgentAuthor(room);
  }

  private dispatchCreatedDeliveries(room: string, created: Delivery[]): void {
    for (const delivery of created) {
      const recipient = this.store.getMember(room, delivery.recipient);
      // harn:assume agent-delivery-lifecycle-streams ref=delivery-created-emit
      // Agent recipients stream their queued frame too — a connected client's
      // seen tick starts honest instead of waiting for a reconnect snapshot.
      if (recipient !== undefined) this.emitInbox(room, delivery);
      // harn:end agent-delivery-lifecycle-streams
      if (recipient?.kind === 'agent') {
        if (
          delivery.group_id !== undefined &&
          (recipient.state === 'dead' || recipient.removed_ts !== undefined)
        ) {
          this.skipUnavailableGroupDelivery(room, delivery);
        } else {
          this.dispatchAgentDelivery(room, delivery, recipient);
        }
      }
    }
  }

  // harn:assume agent-chains-uninterrupted-by-default ref=delivery-hop-brake-dispatch
  private deliveryBrakeReason(room: string, delivery: Delivery): string | undefined {
    const config = this.store.getRoom(room)!.config;
    const meter = this.store.getMeter(room, new Date().toISOString().slice(0, 10));
    const verdict = evaluateBrakes(config, {
      consecutiveAgentDeliveries: Math.max(0, (delivery.hop_count ?? 0) - 1),
      spendTodayUsd: meter?.cost_usd ?? 0,
    });
    if (!verdict.hold) return undefined;
    return verdict.reason === 'turn_brake'
        ? `turn brake before hop ${delivery.hop_count ?? 0}`
        : `spend brake at $${(meter?.cost_usd ?? 0).toFixed(2)}`;
  }

  private dispatchAgentDelivery(room: string, delivery: Delivery, recipient: Member): void {
    const reason = this.deliveryBrakeReason(room, delivery);
    if (reason) {
      this.holdDelivery(room, delivery.id, reason);
      return;
    }
    this.queueAgentDelivery(room, recipient);
  }
  // harn:end agent-chains-uninterrupted-by-default

  // harn:assume mirrored-deliveries-queue ref=mirrored-custody-hold
  private queueAgentDelivery(room: string, recipient: Member): void {
    const mirrored = recipient.custody === 'mirrored';
    const remoteUnreachable = this.isRemoteMember(recipient) &&
      !this.residency?.isReachable(recipient.host);
    // harn:assume inflight-member-state-survives-new-delivery ref=preserve-live-state-on-queue
    const hasLiveTurn = this.inflight.has(recipient.id) &&
      (recipient.state === 'running' || recipient.state === 'awaiting_input');
    const preservesState =
      hasLiveTurn ||
      recipient.state === 'paused' ||
      recipient.state === 'dead' ||
      recipient.state === 'custody_uncertain';
    // harn:end inflight-member-state-survives-new-delivery
    const member = this.store.updateMember(room, recipient.id, {
      state: preservesState ? recipient.state : remoteUnreachable ? 'unreachable' : 'queued',
    });
    this.emitMember(room, member);
    if (mirrored) {
      const queued = this.store.listDeliveries(room, {
        recipient: recipient.id,
        state: 'queued',
      }).length;
      if (queued === 1) {
        this.postSystemMessage(
          room,
          `@${recipient.handle} is mirrored in an operator terminal; 1 delivery is queued`,
        );
      }
      return;
    }
    if (remoteUnreachable) return;
    this.track(this.maybeStartTurn(room, recipient.id));
  }
  // harn:end mirrored-deliveries-queue

  private planFanout(
    room: string,
    message: Message,
    triggerAuthor?: string,
    agentHop?: number,
    awaitingReply = false,
  ) {
    const members = this.store.listMembers(room);
    const author = members.find((m) => m.id === message.author);
    const result = resolveRecipients(message, {
      members,
      author,
      repliedTo: message.reply_to !== undefined ? this.store.getMessage(room, message.reply_to) : undefined,
      latestFinalizedAgentAuthor: this.latestFinalizedAgentAuthor(room),
      roomConfig: this.store.getRoom(room)!.config,
      triggerAuthor,
    });
    const recipients = [...result.agents, ...result.humans];
    const fanout: FanoutDelivery[] = [
      ...result.humans.map((human) => ({ recipient: human.id, state: 'consumed' as const })),
      ...result.agents.map((agent) => ({
        recipient: agent.id,
        state: 'queued' as const,
        payload_snapshot: this.snapshotPayload(room, message, agent, recipients, awaitingReply),
        hop_count: agentHop ?? (author?.kind === 'agent' ? 1 : 0),
      })),
    ];
    return { result, fanout };
  }

  private planRoutedMessage(
    room: string,
    message: Message,
    triggerAuthor?: string,
    agentHop?: number,
    awaitingReply = false,
    allowGroup = true,
  ): { result: ReturnType<typeof resolveRecipients>; plan: RoutedMessagePlan } {
    const planned = this.planFanout(room, message, triggerAuthor, agentHop, awaitingReply);
    const base: RoutedMessagePlan = {
      fanout: planned.fanout,
      ...(planned.result.misaddressed && { markMisaddressed: true }),
    };
    if (!allowGroup || planned.result.agents.length < 2) {
      return { result: planned.result, plan: base };
    }

    const groupId = ulid();
    const context = this.groupPayloadContext(room, message, groupId, 1);
    const humanIds = new Set(planned.result.humans.map((member) => member.id));
    const agentFanout = new Map(
      planned.fanout
        .filter((delivery) => !humanIds.has(delivery.recipient))
        .map((delivery) => [delivery.recipient, delivery]),
    );
    return {
      result: planned.result,
      plan: {
        ...base,
        fanout: planned.fanout.filter((delivery) => humanIds.has(delivery.recipient)),
        collaboration: {
          groupId,
          participants: planned.result.agents.map((agent) => ({
            memberId: agent.id,
            payloadSnapshot: this.groupPayloadSnapshot(
              composeGroupRoundPayload(context, agent.handle),
            ),
            state: 'queued',
            hopCount: agentFanout.get(agent.id)?.hop_count,
          })),
        },
      },
    };
  }

  private groupPayloadContext(
    room: string,
    root: Message,
    groupId: string,
    roundNumber: number,
  ): GroupRoundPayloadContext {
    const author = this.store.getMember(room, root.author);
    if (!author) throw new Error(`group root #${root.id} has no author`);
    return {
      groupId,
      roundNumber,
      room,
      root: {
        messageId: root.id,
        authorHandle: author.handle,
        body: root.body,
      },
      refs: root.refs
        .map((id) => this.store.getMessage(room, id))
        .filter((ref): ref is Message => ref !== undefined)
        .map((ref) => ({
          id: ref.id,
          authorHandle: this.store.getMember(room, ref.author)?.handle ?? 'unknown',
          ts: ref.ts,
          body: this.runRefBody(ref),
        })),
      ledgerRefs: this.ledger?.resolve(room, root.ledger_refs),
    };
  }

  // harn:assume run-failure-evidence-is-surfaced ref=run-ref-error-evidence
  /**
   * A referenced run's quotable content: its reply text, else its failure
   * evidence (labeled so consumers know it is evidence, not a reply), else
   * its body. Keeps refs to failed/interrupted runs from resolving empty.
   */
  private runRefBody(ref: Message): string {
    if (ref.kind !== 'run') return ref.body;
    const finalText = ref.run?.final_text;
    if (finalText !== undefined && finalText !== '') return finalText;
    const error = ref.run?.error;
    if (error !== undefined && error !== '') {
      return `[run ${ref.run?.status ?? 'failed'}] ${error}`;
    }
    return ref.body;
  }
  // harn:end run-failure-evidence-is-surfaced

  // harn:assume collaboration-round-release-is-one-barrier ref=group-payload-snapshot-integration
  private groupPayloadSnapshot(payload: string): string {
    return JSON.stringify({ kind: 'group', payload } satisfies GroupDeliveryPayloadSnapshot);
  }
  // harn:end collaboration-round-release-is-one-barrier

  // harn:assume delivery-payload-snapshotted ref=daemon-payload-snapshot
  private snapshotPayload(
    room: string,
    message: Message,
    recipient: Member,
    recipients: Member[],
    awaitingReply = false,
  ): string {
    const author = this.store.getMember(room, message.author)!;
    const recipientIds = new Set(recipients.map((member) => member.id));
    const toHandles = [
      ...new Set(
        message.mentions
          .filter((span) => recipientIds.has(span.member_id))
          .map((span) => this.store.getMember(room, span.member_id)?.handle)
          .filter((handle): handle is string => handle !== undefined),
      ),
    ];
    if (toHandles.length === 0) toHandles.push(...recipients.map((member) => member.handle));
    const refs: ResolvedRef[] = message.refs
      .map((id) => this.store.getMessage(room, id))
      .filter((ref): ref is Message => ref !== undefined)
      .map((ref) => ({
        id: ref.id,
        author_handle: this.store.getMember(room, ref.author)?.handle ?? 'unknown',
        ts: ref.ts,
        body: this.runRefBody(ref),
      }));
    const ledgerRefs = this.ledger?.resolve(room, message.ledger_refs) ?? [];
    const snapshot: DeliveryPayloadSnapshot = {
      context: {
        room,
        message,
        authorHandle: author.handle,
        authorKind: author.kind,
        toHandles,
        refs,
        ledgerRefs,
        // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-snapshot
        ...(awaitingReply && { awaitingReply: true }),
        // harn:end awaiting-reply-marker-is-delivery-context
      },
      you: recipient.handle,
    };
    return JSON.stringify(snapshot);
  }
  // harn:end delivery-payload-snapshotted

  // ── the turn pump ─────────────────────────────────────────────────────

  // harn:assume one-inflight-turn-per-member ref=inflight-guard
  /**
   * At most ONE turn in flight per member: deliveries landing while a
   * member runs stay queued and are drained as one batched turn when the
   * member goes idle again (the pump re-runs itself after finalize).
   */
  // harn:assume turn-start-requires-owned-custody ref=shared-turn-start-custody-gate
  private turnStartEligibility(
    room: string,
    memberId: string,
  ): { member?: Member; refusal?: string } {
    const member = this.store.getMember(room, memberId);
    if (!member || member.kind !== 'agent') return { refusal: `no such agent member: ${memberId}` };
    if (this.closing) return { refusal: 'the daemon is closing' };
    if (this.inflight.has(memberId)) return { refusal: `member @${member.handle} already has a turn in flight` };
    if (this.pendingAttach.has(memberId)) return { refusal: `member @${member.handle} has an attach acquisition pending` };
    if (member.custody !== 'owned') return { refusal: `member @${member.handle} is not switchboard-owned` };
    if (this.isRemoteMember(member) && !this.residency?.isReachable(member.host)) {
      return { refusal: `member @${member.handle} resident switchboard is unreachable` };
    }
    if (member.state === 'paused' || member.state === 'dead' || member.state === 'custody_uncertain') {
      return { refusal: `member @${member.handle} is ${member.state}` };
    }
    return { member };
  }
  // harn:end turn-start-requires-owned-custody

  // harn:assume brakes-rechecked-at-turn-start ref=turn-start-brake-recheck
  private applyTurnStartBrakes(room: string, batch: Delivery[], atomic: boolean): Delivery[] {
    const braked = batch
      .filter((delivery) => (delivery.hop_count ?? 0) > 0 && !this.releasedDeliveries.has(delivery.id))
      .map((delivery) => ({ delivery, reason: this.deliveryBrakeReason(room, delivery) }))
      .filter((item): item is { delivery: Delivery; reason: string } => item.reason !== undefined);
    if (braked.length === 0) {
      for (const delivery of batch) this.releasedDeliveries.delete(delivery.id);
      return batch;
    }

    if (atomic) {
      const reason = braked[0]!.reason;
      for (const delivery of batch) this.holdDelivery(room, delivery.id, reason);
      return [];
    }

    const heldIds = new Set(braked.map(({ delivery }) => delivery.id));
    for (const { delivery, reason } of braked) this.holdDelivery(room, delivery.id, reason);
    const runnable = batch.filter((delivery) => !heldIds.has(delivery.id));
    for (const delivery of runnable) this.releasedDeliveries.delete(delivery.id);
    return runnable;
  }

  async maybeStartTurn(room: string, memberId: string): Promise<void> {
    const eligible = this.turnStartEligibility(room, memberId);
    if (!eligible.member) return; // holds its queue; the room shows the backlog
    const member = eligible.member;
    const queued = this.store.listDeliveries(room, { recipient: memberId, state: 'queued' });
    if (queued.length === 0) return;
    // harn:assume grouped-deliveries-have-an-isolated-batch-class ref=group-batch-pump-integration
    const selected = selectDeliveryBatchPrefix(queued);
    const batch = this.applyTurnStartBrakes(
      room,
      selected,
      selected[0]?.group_id !== undefined,
    );
    // harn:end grouped-deliveries-have-an-isolated-batch-class
    if (batch.length === 0) {
      const current = this.store.getMember(room, memberId);
      if (current?.state === 'queued') this.emitMember(room, this.store.updateMember(room, memberId, { state: 'idle' }));
      return;
    }
    this.inflight.add(memberId);
    try {
      await this.runTurn(room, member, batch);
    } finally {
      this.inflight.delete(memberId);
    }
    await this.maybeStartTurn(room, memberId); // drain anything queued meanwhile
  }
  // harn:end brakes-rechecked-at-turn-start
  // harn:end one-inflight-turn-per-member

  private async runTurn(room: string, member: Member, batch: Delivery[], reuseRunMsg?: Message): Promise<void> {
    // harn:assume turns-reuse-one-root-and-append-output-messages ref=run-message-lifecycle
    // Exactly one lifecycle root owns the turn, its input custody, and journal.
    // A crash retry reuses it; only later visible stretches may append rows.
    const originalStates = new Map(batch.map((delivery) => [delivery.id, delivery.state]));
    const started = this.store.beginTurn(room, {
      memberId: member.id,
      deliveryIds: batch.map((delivery) => delivery.id),
      startedTs: new Date().toISOString(),
      eventsRef: (messageId) => this.blobs.ref(messageId),
      reuseRunMsgId: reuseRunMsg?.id,
    });
    // harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-start-with-nothing-admissible
    // Everything in the batch was consumed between selection and admission — the member
    // was removed, or the work was taken by something else. There is nothing to say, and
    // an empty run message would be a defect of its own. Idle the member and stop.
    if (!started) {
      const current = this.store.getMember(room, member.id);
      if (current !== undefined && current.state === 'queued') {
        this.emitMember(room, this.store.updateMember(room, member.id, { state: 'idle' }));
      }
      return;
    }
    // harn:end only-an-admissible-delivery-becomes-delivering
    const runMsg = started.runMessage;
    this.emitMessage(room, runMsg);
    this.noteRunActivity(room, runMsg.id);
    // harn:end turns-reuse-one-root-and-append-output-messages

    // harn:assume run-events-merge-by-journal-index ref=daemon-journal-index-stamp
    // The journal position of the NEXT appended event. A reconciled retry
    // reuses the run message, so its blob may already carry lines.
    const existingJournal = reuseRunMsg !== undefined
      ? this.blobs.read(room, runMsg.run!.events_ref)
      : [];
    let journalIndex = existingJournal.length;
    const continuation = new ContinuationWriter(runMsg.id, existingJournal);
    // harn:end run-events-merge-by-journal-index

    // harn:assume delivery-attempt-wal-reconcile ref=wal-bind-before-spawn
    // Attempt WAL: bind every batched delivery to the run message and count
    // the attempt BEFORE the adapter spawns — consumption happens only when
    // run.completed lands, so a crash leaves reconcilable evidence.
    const bound = started.deliveries;
    // harn:end delivery-attempt-wal-reconcile
    // harn:assume agent-delivery-lifecycle-streams ref=delivery-bound-emit
    // Every bound delivery whose state moved (queued/held -> delivering)
    // streams its transition — formerly only releases out of held did.
    for (const delivery of bound) {
      if (originalStates.get(delivery.id) !== delivery.state) this.emitInbox(room, delivery);
    }
    // harn:end agent-delivery-lifecycle-streams

    const payload = this.composeBatchPayload(room, member, bound);
    this.emitMember(room, this.store.updateMember(room, member.id, { state: 'running' }));

    const remote = this.isRemoteMember(member);
    const adapter = remote ? undefined : this.requireAdapter(member.harness!);
    const session = remote ? undefined : this.sessionFor(room, member);
    let completion: TurnCompletion | undefined;
    let toolCalls = 0;
    const pendingExtensionDescriptions: string[] = [];

    try {
      const triggerMsg = bound.at(-1)?.message_id ?? runMsg.id;
      const events = remote
        ? this.residency!.deliver(member.host, {
            rpc_id: this.remoteRpcId(room, runMsg.id),
            room,
            member: remoteMemberSpec(member),
            payload,
            trigger_msg: triggerMsg,
          }, {
            lastEventIndex: this.blobs.read(room, runMsg.run!.events_ref).length - 1,
            onSessionRef: (sessionRef) => {
              const persisted = this.store.getMember(room, member.id);
              if (persisted?.session_ref === sessionRef) return;
              this.emitMember(
                room,
                this.store.updateMember(room, member.id, { session_ref: sessionRef }),
              );
            },
          })
        : adapter!.deliver(session!, payload, {
        // harn:assume attempt-start-evidence-persisted ref=attempt-start-evidence
        onStarted: (process) => {
          this.noteRunActivity(room, runMsg.id);
          this.store.setDeliveryAttemptProcess(
            room,
            bound.map((delivery) => delivery.id),
            process,
          );
          const startedEvent: WireEvent = {
            type: 'run.started',
            member: member.id,
            trigger_msg: triggerMsg,
          };
          this.blobs.append(room, runMsg.run!.events_ref, startedEvent);
          // harn:assume run-events-merge-by-journal-index ref=daemon-journal-index-stamp
          this.emit(room, {
            type: 'run_event',
            room,
            message_id: runMsg.id,
            event: startedEvent,
            index: journalIndex++,
          });
          // harn:end run-events-merge-by-journal-index
        },
        onSessionRef: (sessionRef) => {
          const persisted = this.store.getMember(room, member.id);
          if (persisted?.session_ref === sessionRef) return;
          this.emitMember(
            room,
            this.store.updateMember(room, member.id, { session_ref: sessionRef }),
          );
        },
        // harn:end attempt-start-evidence-persisted
      });
      for await (const event of events) {
        this.noteRunActivity(room, runMsg.id);
        let journalEvent = event;
        if (event.type === 'run.item') {
          // harn:assume member-status-is-bounded-and-identity-safe ref=run-item-journal-timestamp
          // Every run item is journaled with a wall-clock ts — prose (text_delta,
          // reasoning) included — so transcript blocks can be ordered by true time,
          // not only tool events. One path, no per-type branching.
          journalEvent = { ...event, ts: new Date().toISOString() };
          // harn:end member-status-is-bounded-and-identity-safe
          if (event.item_type === 'tool_call') toolCalls++;
          const description = extensionDescription(event);
          if (description !== undefined) pendingExtensionDescriptions.push(description);
        } else if (event.type === 'extension.started') {
          journalEvent = this.startExtension(
            room,
            member,
            event,
            pendingExtensionDescriptions.shift(),
          );
        } else if (event.type === 'extension.ended') {
          journalEvent = this.endExtension(room, member, event);
        }
        // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-runtime-registry
        // Live usage is member runtime state: broadcast it, but do not append it
        // to the durable run journal or change log.
        if (event.type === 'usage_updated') {
          this.landContextWindow(room, member.id, event.usage);
          // Keyed by bare member id like every sibling per-member map (ULIDs
          // never repeat, so no cross-room collision). Skip the re-broadcast
          // when the snapshot is unchanged — a full member frame per identical
          // usage report is pure fanout waste.
          if (!isDeepStrictEqual(this.lastUsage.get(member.id), event.usage)) {
            this.lastUsage.set(member.id, { ...event.usage });
            const current = this.store.getMember(room, member.id);
            if (current !== undefined) this.emitMember(room, current);
          }
          continue;
        }
        // harn:end last-agent-usage-is-transient-and-seeded
        // harn:assume agent-usage-limits-reported-not-guessed ref=member-limits-persisted
        // Limits are member status, not run content: land the harness's report
        // on the member row and stream the member frame — nothing is journaled.
        if (event.type === 'run.limits') {
          this.landMemberLimits(room, member.id, event.limits);
          continue;
        }
        // harn:end agent-usage-limits-reported-not-guessed
        // harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-writer-engine
        // Allocate+insert before the id becomes journal truth. The empty row is
        // streamed before its first targeted event, so readers never observe an
        // event whose permanent message does not exist yet.
        let allocated: Message | undefined;
        const assigned = continuation.assign(
          journalEvent,
          this.store.latestMessageId(room),
          () => {
            allocated = this.store.createRunContinuation(room, runMsg.id);
            return allocated.id;
          },
        );
        journalEvent = assigned.event;
        if (allocated !== undefined) this.emitMessage(room, allocated);
        this.blobs.append(room, runMsg.run!.events_ref, journalEvent);
        // harn:end continuation-writer-follows-journaled-output-ownership
        // harn:assume run-events-merge-by-journal-index ref=daemon-journal-index-stamp
        // Stamp the frame with the position this event just took in the
        // journal, so a viewer who joined mid-run merges exactly.
        const stampedIndex = journalIndex++;
        // harn:assume compaction-timeline-items-are-durable-run-evidence ref=compaction-journal-fanout
        if (
          journalEvent.type === 'run.started' ||
          journalEvent.type === 'run.item' ||
          journalEvent.type === 'timeline' ||
          journalEvent.type === 'extension.started' ||
          journalEvent.type === 'extension.ended'
        ) {
          this.emit(room, {
            type: 'run_event',
            room,
            message_id: runMsg.id,
            event: journalEvent,
            index: stampedIndex,
          });
        }
        // harn:end compaction-timeline-items-are-durable-run-evidence
        // harn:end run-events-merge-by-journal-index
        if (event.type === 'ask.raised' || event.type === 'approval.raised') {
          this.handleInteractionRaised(room, member, event.card, event.type === 'ask.raised' ? 'ask' : 'approval');
        } else if (journalEvent.type === 'run.completed') {
          // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-runtime-registry
          if (journalEvent.agent_usage !== undefined) {
            this.lastUsage.set(member.id, { ...journalEvent.agent_usage });
            this.landContextWindow(room, member.id, journalEvent.agent_usage);
          }
          // harn:end last-agent-usage-is-transient-and-seeded
          // harn:assume failed-run-details-never-route-as-replies ref=failed-run-finalization
          completion = {
            status: journalEvent.status,
            final_text: journalEvent.final_text,
            error: journalEvent.error,
            usage: journalEvent.usage,
          };
          // harn:end failed-run-details-never-route-as-replies
        }
      }
    } catch (error) {
      if (error instanceof RemoteAttemptAmbiguousError) {
        this.holdAmbiguousTurn(room, member, bound, runMsg.id, 'resident reported ambiguous');
        return;
      }
      // harn:assume failed-run-details-never-route-as-replies ref=failed-run-finalization
      completion = completion ?? {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      // harn:end failed-run-details-never-route-as-replies
    }

    if (
      session?.session_ref !== undefined &&
      session.session_ref !== this.store.getMember(room, member.id)?.session_ref
    ) {
      this.emitMember(room, this.store.updateMember(room, member.id, { session_ref: session.session_ref }));
    }

    // harn:assume operator-interrupt-not-failure ref=interrupt-failure-classification
    const operatorInterrupted = this.operatorInterrupts.delete(member.id);
    if (operatorInterrupted && completion?.status === 'failed') {
      completion = { ...completion, status: 'interrupted' };
    }
    // harn:end operator-interrupt-not-failure
    // harn:assume lifecycle-retries-only-live-collaboration-work ref=recovery-requeue-contract
    // Some harnesses report a SIGINT as a generic failure. Once close() has
    // captured lifecycle cause, classify that native exit as interrupted so it
    // reaches the atomic retry-or-terminal settlement instead of killing the
    // member and consuming the instruction as an operator result.
    if (this.lifecycleInterrupts.has(member.id) && completion?.status === 'failed') {
      completion = { ...completion, status: 'interrupted' };
    }
    // harn:end lifecycle-retries-only-live-collaboration-work
    // harn:assume failed-finalization-reconciles-at-runtime ref=runtime-finalization-reconcile
    // The engine's journal is already terminal here. If normal finalization
    // cannot commit — a lifecycle retry rebound to a delivery whose participant
    // already holds a result — the rollback used to leave the row running and
    // the delivery delivering while the in-memory guard cleared, so nothing
    // noticed until a human went looking. Reconcile immediately instead.
    const finalCompletion = completion ?? { status: 'interrupted' as const };
    const lifecycleSettlement = finalCompletion.status === 'interrupted'
      && this.lifecycleInterrupts.has(member.id);
    if (!lifecycleSettlement && this.normalFinalizationIsIllegal(room, bound)) {
      // Known-settled work never attempts normal completion: completeTurn would
      // roll back anyway, and for a closed group it might not even refuse.
      this.reconcileFailedFinalization(
        room,
        member.id,
        runMsg.id,
        bound,
        finalCompletion,
        new Error('its collaboration work was already settled'),
      );
      return;
    }
    try {
      this.finalizeTurn(room, member.id, runMsg.id, finalCompletion, bound, toolCalls);
    } catch (error) {
      this.reconcileFailedFinalization(room, member.id, runMsg.id, bound, finalCompletion, error);
    }
    // harn:end failed-finalization-reconciles-at-runtime
  }

  // harn:assume failed-finalization-reconciles-at-runtime ref=runtime-finalization-reconcile
  /**
   * The one repair both runtime and boot use. It never routes and never
   * replaces a participant result: it makes the durable state honest, streams
   * the repaired rows, and says so once. A second pass finds nothing to do.
   */
  private reconcileFailedFinalization(
    room: string,
    memberId: string,
    runMsgId: number,
    batch: Delivery[],
    completion: TurnCompletion | undefined,
    error: unknown,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    const runMsg = this.store.getMessage(room, runMsgId);
    if (runMsg?.run === undefined) throw new Error(`turn #${runMsgId} has no lifecycle root`);
    const projection = projectContinuationOutputs(
      runMsgId,
      this.blobs.read(room, runMsg.run.events_ref),
    );
    const repaired = this.store.repairFailedFinalization(room, {
      runMsgId,
      memberId,
      deliveryIds: batch.map((delivery) => delivery.id),
      outputs: this.outputPatches(room, runMsg, projection, false, false),
      error: `finalization could not commit: ${detail}`,
      endedTs: new Date().toISOString(),
      meterDay: new Date().toISOString().slice(0, 10),
      meterDelta: {
        turns: 1,
        cost_usd: completion?.usage?.cost_usd ?? 0,
        input_tokens: completion?.usage?.input_tokens ?? 0,
        output_tokens: completion?.usage?.output_tokens ?? 0,
        uncosted_tokens:
          completion?.usage !== undefined && completion.usage.cost_usd === undefined
            ? completion.usage.input_tokens + completion.usage.output_tokens
            : 0,
      },
    });
    if (!repaired.repaired) {
      // The run is already terminal, so the Store transaction DID commit and
      // something after it threw — an emit or barrier step. That is a real
      // failure with nothing to repair, and swallowing it here would hide it
      // from background error reporting and from later reconciliation.
      throw error instanceof Error ? error : new Error(detail);
    }
    for (const output of repaired.outputMessages ?? []) this.emitMessage(room, output);
    if (repaired.member !== undefined) this.emitMember(room, repaired.member);
    if (repaired.meter !== undefined) {
      this.emit(room, { type: 'meter', seq: this.store.currentSeq(room), meter: repaired.meter });
    }
    for (const delivery of repaired.deliveries) this.emitInbox(room, delivery);
    if (repaired.notice !== undefined) this.emitMessage(room, repaired.notice);
    this.memberWaits.delete(memberId);
    this.groupWaits.delete(memberId);
    this.retireTerminalRunRuntime(room, memberId, runMsgId);
  }
  // harn:assume collaboration-lifecycle-interruption-is-nonterminal ref=lifecycle-collaboration-finalization
  /**
   * Commit the one lifecycle settlement and stream what it changed. Nothing is
   * routed: an interrupted attempt produced no answer to deliver, and its retry
   * (if admitted) will produce the one result the round is still waiting for.
   */
  private settleLifecycleInterruptedTurn(
    room: string,
    memberId: string,
    runMsgId: number,
    batch: Delivery[],
    messagePatch: Parameters<Store['completeTurn']>[1]['message'],
    endedTs: string,
    preserveOtherActiveTurn = false,
  ): void {
    const current = this.store.getMember(room, memberId);
    const usage = messagePatch.run?.usage;
    const runMsg = this.store.getMessage(room, runMsgId);
    if (runMsg?.run === undefined) throw new Error(`turn #${runMsgId} has no lifecycle root`);
    const projection = projectContinuationOutputs(
      runMsgId,
      this.blobs.read(room, runMsg.run.events_ref),
    );
    const outputs = this.outputPatches(room, runMsg, projection, false, false);
    const settlement = this.store.settleLifecycleInterruption(room, {
      runMsgId,
      memberId,
      deliveryIds: batch.map((delivery) => delivery.id),
      message: messagePatch,
      outputs,
      memberPatch: {
        state: preserveOtherActiveTurn
          ? (current?.state ?? 'running')
          : current?.state === 'dead' || current?.state === 'paused'
            ? current.state
            : 'idle',
      },
      endedTs,
      attemptCeiling: RECOVERY_ATTEMPT_CEILING,
      meterDay: endedTs.slice(0, 10),
      meterDelta: {
        turns: 1,
        cost_usd: usage?.cost_usd ?? 0,
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        uncosted_tokens:
          usage !== undefined && usage.cost_usd === undefined
            ? usage.input_tokens + usage.output_tokens
            : 0,
      },
    });
    if (!preserveOtherActiveTurn) {
      this.lifecycleInterrupts.delete(memberId);
      this.memberWaits.delete(memberId);
      this.groupWaits.delete(memberId);
    }
    for (const output of settlement.outputMessages) this.emitMessage(room, output);
    this.emitMember(room, settlement.member);
    this.emit(room, { type: 'meter', seq: this.store.currentSeq(room), meter: settlement.meter });
    for (const delivery of [...settlement.requeued, ...settlement.settled]) {
      this.emitInbox(room, delivery);
    }
    if (settlement.notice !== undefined) this.emitMessage(room, settlement.notice);
    const affectedRounds = new Map<string, { groupId: string; roundNumber: number }>();
    for (const delivery of settlement.settled) {
      if (delivery.group_id === undefined || delivery.group_round === undefined) continue;
      affectedRounds.set(`${delivery.group_id}:${String(delivery.group_round)}`, {
        groupId: delivery.group_id,
        roundNumber: delivery.group_round,
      });
    }
    for (const { groupId, roundNumber } of affectedRounds.values()) {
      this.clearSatisfiedGroupWaits(room, groupId, roundNumber);
      this.advanceCollaborationRound(room, groupId, roundNumber);
    }
    if (preserveOtherActiveTurn) {
      this.runActivity.delete(`${room}:${runMsgId}`);
    } else {
      this.retireTerminalRunRuntime(room, memberId, runMsgId);
    }
  }
  // harn:end collaboration-lifecycle-interruption-is-nonterminal

  /**
   * True when this batch cannot take the normal finalization path, because its
   * collaboration work is already settled: a terminal participant, a closed
   * group, or a closed round. It asks the Store the SAME question repair asks —
   * a narrower check here would let a closed group accept a fresh result, since
   * `recordCollaborationParticipantTerminal` guards the participant alone.
   *
   * Checked proactively before normal completion at both boot and runtime; the
   * runtime catch stays for transaction failures this cannot foresee.
   */
  private normalFinalizationIsIllegal(room: string, batch: Delivery[]): boolean {
    return batch.some((delivery) => this.store.collaborationWorkIsSettled(room, delivery.id));
  }
  // harn:end failed-finalization-reconciles-at-runtime

  /** Clear transient evidence that must not outlive any terminalized attempt. */
  private retireTerminalRunRuntime(room: string, memberId: string, runMsgId: number): void {
    this.runActivity.delete(`${room}:${runMsgId}`);
    for (const extension of this.store.listMembers(room)) {
      if (extension.kind !== 'extension' || extension.parent !== memberId || extension.state !== 'running') continue;
      this.emitMember(room, this.store.updateMember(room, extension.id, { state: 'dead' }));
    }
  }

  private composeBatchPayload(room: string, recipient: Member, batch: Delivery[]): string {
    const payloads: string[] = [];
    for (const delivery of batch) {
      const encoded = this.store.getDeliveryPayloadSnapshot(room, delivery.id);
      const fresh = this.store.getMember(room, recipient.id)!;
      const needsConventions = !fresh.conventions_sent || fresh.misaddressed;
      const needsRoster = fresh.roster_stale;
      // harn:assume grouped-deliveries-retain-agent-briefings ref=grouped-delivery-briefing
      const roster = needsRoster
        ? this.store.listMembers(room).map((member) => ({
            handle: member.handle,
            kind: member.kind,
            ...(member.purpose !== undefined && { purpose: member.purpose }),
          }))
        : undefined;
      const conventions = needsConventions
        ? {
            ledger: this.ledger?.isEnabled(room) ?? false,
            // harn:assume collaboration-briefing-is-capability-aware ref=collaboration-capability-context
            liveInbox: fresh.harness !== undefined &&
              this.adapters.get(fresh.harness)?.capabilities.live_inbox === true,
            // harn:end collaboration-briefing-is-capability-aware
          }
        : undefined;
      if (encoded !== undefined) {
        const candidate = JSON.parse(encoded) as DeliveryPayloadSnapshot | GroupDeliveryPayloadSnapshot;
        if ('kind' in candidate && candidate.kind === 'group') {
          payloads.push(candidate.payload + composeDeliveryBriefing({ roster, conventions }));
          if (needsRoster) this.store.clearAgentRosterStale(room, recipient.id);
          if (needsConventions) {
            this.emitMember(
              room,
              this.store.updateMember(room, recipient.id, {
                conventions_sent: true,
                misaddressed: false,
              }),
            );
          }
          // harn:end grouped-deliveries-retain-agent-briefings
          continue;
        }
      }
      const snapshot = encoded
        ? (JSON.parse(encoded) as DeliveryPayloadSnapshot)
        : (JSON.parse(
            this.snapshotPayload(
              room,
              this.store.getMessage(room, delivery.message_id)!,
              recipient,
              [recipient],
            ),
          ) as DeliveryPayloadSnapshot);
      const ctx: PayloadContext = {
        ...snapshot.context,
        roster,
        conventions: needsConventions
          ? {
              ...conventions,
              untaggedGoesTo: snapshot.context.authorHandle,
            }
          : undefined,
      };
      payloads.push(composePayload(ctx, snapshot.you));
      if (needsRoster) this.store.clearAgentRosterStale(room, recipient.id);
      if (needsConventions) {
        this.emitMember(
          room,
          this.store.updateMember(room, recipient.id, { conventions_sent: true, misaddressed: false }),
        );
      }
    }
    // Attachment path lines ride each delivery's text (outside the briefing
    // anchors), recomputed from the live message so they vanish on delete.
    return payloads
      .map((payload, index) => payload + this.attachmentPayloadLines(room, batch[index]!.message_id))
      .join('\n');
  }

  private outputPatches(
    room: string,
    root: Message,
    projection: ReturnType<typeof projectContinuationOutputs>,
    ack: boolean,
    retainRootBody = true,
  ): TurnOutputPatch[] {
    const members = this.store.listMembers(room);
    return [...projection.referencedMessageIds]
      .sort((left, right) => left - right)
      .map((id) => {
        const message = this.store.getMessage(room, id);
        if (
          message === undefined
          || (id !== root.id && message.run_parent_id !== root.id)
        ) {
          throw new Error(`turn #${root.id} journal targets invalid output #${id}`);
        }
        const body = id === root.id && !retainRootBody
          ? ''
          : (projection.bodies.get(id) ?? '');
        const rowAck = ack && id === projection.resultMessageId;
        const parsed = rowAck
          ? { mentions: [], refs: [], ledger_refs: [] }
          : parseBody(body, members);
        return {
          id,
          body,
          mentions: parsed.mentions,
          refs: parsed.refs,
          ledger_refs: parsed.ledger_refs,
          ...(rowAck && { ack: true }),
          substantive: !ack && projection.substantiveMessageIds.has(id),
        };
      });
  }

  // harn:assume finalized-turn-routes-aggregate-from-terminal-output ref=finalize-and-route
  /**
   * Finalize every journal-owned output row while routing one complete aggregate
   * under the permanent terminal output id. The root alone owns lifecycle truth;
   * persisted continuation bodies remain their own chronological stretches.
   */
  private finalizeTurn(
    room: string,
    memberId: string,
    runMsgId: number,
    completion: TurnCompletion,
    batch: Delivery[],
    toolCalls: number,
  ): void {
    const runMsg = this.store.getMessage(room, runMsgId)!;
    // harn:assume failed-run-details-never-route-as-replies ref=failed-run-finalization
    // harn:assume run-failure-evidence-is-surfaced ref=interrupted-error-evidence
    const failed = completion.status === 'failed';
    // The `?? completion.final_text` arm is LOAD-BEARING: codex/gemini/opencode/
    // copilot report failure detail in final_text, only claude uses error.
    // An operator interrupt can reclassify failed->interrupted after the
    // adapter already produced error detail — persist it there too, or the
    // "why" of the interrupt vanishes from every surface.
    const rawFailure = failed
      ? (completion.error ?? completion.final_text)
      : completion.status === 'interrupted'
        ? completion.error
        : undefined;
    const failure = rawFailure?.trim() === '' ? undefined : rawFailure;
    const journal = this.blobs.read(room, runMsg.run!.events_ref);
    const projection = projectContinuationOutputs(runMsgId, journal);
    const projectedAggregate = [...projection.bodies]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('');
    // The journal projection is the one complete, normalized answer. Some
    // adapters report the whole response in final_text; others report only the
    // final suffix after streaming interim narration. Persisting the native
    // field directly would silently truncate the lifecycle aggregate in the
    // latter case even though every chronological row rendered correctly.
    const body = failed ? '' : projectedAggregate;
    // harn:end run-failure-evidence-is-surfaced
    // harn:end failed-run-details-never-route-as-replies
    // harn:assume substantive-routing-excludes-acknowledgements ref=exact-ack-finalization
    const ack = completion.status === 'completed' && body.trim() === '<ACK_OK>';
    const parsed = failed || ack
      ? { mentions: [], refs: [], ledger_refs: [], unresolved: [] }
      : parseBody(body, this.store.listMembers(room));
    const endedTs = new Date().toISOString();
    const outputPatches = this.outputPatches(room, runMsg, projection, ack, !failed);
    const resultMessageId = projection.resultMessageId;
    const messagePatch = {
      body: projection.bodies.get(runMsgId) ?? '',
      ...(ack && { ack: true as const }),
      mentions: parsed.mentions,
      refs: parsed.refs,
      ledger_refs: parsed.ledger_refs,
      run: {
        ...runMsg.run!,
        status: completion.status,
        ended_ts: endedTs,
        stalled_since: undefined,
        tool_calls: toolCalls,
        usage: completion.usage,
        // harn:assume failed-run-details-never-route-as-replies ref=failed-run-finalization
        final_text: failed ? undefined : body,
        output_mode: 'messages' as const,
        result_message_id: resultMessageId,
        error: failure,
        // harn:end failed-run-details-never-route-as-replies
      },
    } satisfies Parameters<Store['completeTurn']>[1]['message'];
    // harn:end substantive-routing-excludes-acknowledgements

    // harn:assume collaboration-lifecycle-interruption-is-nonterminal ref=lifecycle-collaboration-finalization
    // A turn THIS daemon's lifecycle interrupted is retryable work, not a
    // result. Settle the run evidence, the delivery's retry decision, and the
    // participant's barrier state as one fact — committing terminality first
    // and re-queueing afterwards is exactly what resurrected #598 into #599.
    // Operator Stop never reaches here: it is not marked as lifecycle.
    if (completion.status === 'interrupted' && this.lifecycleInterrupts.has(memberId)) {
      this.settleLifecycleInterruptedTurn(room, memberId, runMsgId, batch, messagePatch, endedTs);
      return;
    }
    // harn:end collaboration-lifecycle-interruption-is-nonterminal

    const resultRow = this.store.getMessage(room, resultMessageId);
    if (resultRow === undefined) throw new Error(`turn #${runMsgId} result #${resultMessageId} is missing`);
    const finalizedDraft: Message = {
      ...resultRow,
      body,
      mentions: parsed.mentions,
      refs: parsed.refs,
      ledger_refs: parsed.ledger_refs,
      ...(ack && { ack: true }),
      run: messagePatch.run,
    };
    const lastDelivery = batch.at(-1);
    const triggerAuthor = lastDelivery
      ? this.store.getMessage(room, lastDelivery.message_id)?.author
      : undefined;
    // harn:assume batched-human-resets-hop-count ref=batched-onward-hop-reset
    const onwardHopCount = batch.length === 0
      ? 1
      : Math.min(...batch.map((delivery) => delivery.hop_count ?? 0)) + 1;
    // harn:end batched-human-resets-hop-count
    // harn:assume group-participant-terminality-commits-with-the-turn ref=collaboration-finalization-engine
    const groupedDelivery = batch.find((delivery) => delivery.group_id !== undefined);
    const planned = this.planRoutedMessage(
      room,
      finalizedDraft,
      triggerAuthor,
      onwardHopCount,
      false,
      groupedDelivery === undefined,
    );
    const humanIds = new Set(planned.result.humans.map((human) => human.id));
    const fanout = groupedDelivery === undefined
      ? planned.plan.fanout
      : planned.plan.fanout.filter((delivery) => humanIds.has(delivery.recipient));
    const day = new Date().toISOString().slice(0, 10);
    const completed = this.store.completeTurn(room, {
      runMsgId,
      message: messagePatch,
      outputs: outputPatches,
      resultMessageId,
      inputDeliveryIds: batch.map((delivery) => delivery.id),
      memberId,
      memberPatch: {
        state:
          completion.status === 'failed'
            ? 'dead'
            : this.store.getMember(room, memberId)?.state === 'dead'
              ? 'dead'
              : this.store.getMember(room, memberId)?.state === 'paused'
                ? 'paused'
                : 'idle',
        ...(planned.result.misaddressed && { misaddressed: true }),
      },
      meterDay: day,
      meterDelta: {
        turns: 1,
        cost_usd: completion.usage?.cost_usd ?? 0,
        input_tokens: completion.usage?.input_tokens ?? 0,
        output_tokens: completion.usage?.output_tokens ?? 0,
        uncosted_tokens:
          completion.usage !== undefined && completion.usage.cost_usd === undefined
            ? completion.usage.input_tokens + completion.usage.output_tokens
            : 0,
      },
      fanout,
      ...(groupedDelivery !== undefined && {
        participantTerminal: {
          deliveryId: groupedDelivery.id,
          status: completion.status,
          completedTs: endedTs,
        },
      }),
      ...(groupedDelivery === undefined && planned.plan.collaboration !== undefined && {
        collaboration: planned.plan.collaboration,
      }),
    });
    // harn:end group-participant-terminality-commits-with-the-turn
    // harn:assume live-agent-waits-are-transient ref=wait-clears-on-turn-end
    this.memberWaits.delete(memberId);
    this.groupWaits.delete(memberId);
    // harn:end live-agent-waits-are-transient
    for (const output of completed.outputMessages) this.emitMessage(room, output);
    this.emitMember(room, completed.member);
    // harn:assume agent-delivery-lifecycle-streams ref=delivery-consumed-emit
    // The turn just consumed its inputs — stream the settled rows so seen
    // ticks flip without a reconnect.
    for (const input of batch) {
      const settled = this.store.getDelivery(room, input.id);
      if (settled !== undefined) this.emitInbox(room, settled);
    }
    // harn:end agent-delivery-lifecycle-streams
    // harn:assume extensions-retire-with-parent-run ref=parent-finalization-extension-sweep
    for (const extension of this.store.listMembers(room)) {
      if (extension.kind !== 'extension' || extension.parent !== memberId || extension.state !== 'running') continue;
      this.emitMember(room, this.store.updateMember(room, extension.id, { state: 'dead' }));
    }
    // harn:end extensions-retire-with-parent-run
    this.emit(room, { type: 'meter', seq: this.store.currentSeq(room), meter: completed.meter });
    this.dispatchCreatedDeliveries(room, completed.deliveries);
    if (groupedDelivery?.group_id !== undefined && groupedDelivery.group_round !== undefined) {
      this.clearSatisfiedGroupWaits(room, groupedDelivery.group_id, groupedDelivery.group_round);
      this.advanceCollaborationRound(room, groupedDelivery.group_id, groupedDelivery.group_round);
    }
    this.runActivity.delete(`${room}:${runMsgId}`);
    if (completion.status === 'failed') {
      this.postSystemMessage(
        room,
        completed.member.session_ref
          ? `@${completed.member.handle} died mid-run (turn #${runMsgId} failed); revive to retry`
          : `@${completed.member.handle} died mid-run (turn #${runMsgId} failed); remove it and spawn a replacement`,
      );
    }
  }
  // harn:end finalized-turn-routes-aggregate-from-terminal-output

  // harn:assume collaboration-round-release-is-one-barrier ref=collaboration-barrier-engine
  private advanceCollaborationRound(room: string, groupId: string, roundNumber: number): void {
    const projection = this.store.getCollaborationRoundProjection(room, groupId, roundNumber);
    if (!projection || projection.round.state !== 'collecting') return;
    if (projection.participants.some((participant) => participant.terminal_status === undefined)) return;

    const root = this.store.getMessage(room, projection.group.root_message_id);
    if (!root) throw new Error(`collaboration group ${groupId} has no root message`);
    const results: NonNullable<GroupRoundPayloadContext['results']> = [];
    const nextMembers: Member[] = [];
    const seen = new Set<string>();
    for (const participant of projection.participants) {
      const member = this.store.getMember(room, participant.member_id);
      const result = participant.result_message_id === undefined
        ? undefined
        : this.store.getMessage(room, participant.result_message_id);
      const resultRoot = result === undefined ? undefined : this.store.getRunRoot(room, result);
      const resultAck = result?.ack === true || resultRoot?.ack === true;
      const aggregateBody = resultRoot?.run?.final_text ?? result?.body ?? '';
      const aggregateParsed = parseBody(aggregateBody, this.store.listMembers(room));
      const status = participant.terminal_status === 'completed' && resultAck
        ? 'acknowledged'
        : participant.terminal_status!;
      results.push({
        ordinal: participant.ordinal,
        memberHandle: member?.handle ?? participant.member_id,
        status,
        ...(result !== undefined && !resultAck && {
          messageId: result.id,
          // harn:assume run-failure-evidence-is-surfaced ref=round-result-error-evidence
          // A failed participant's body is empty by design; surface its run
          // error so peers see why the round member stopped.
          body: participant.terminal_status === 'completed'
            ? aggregateBody
            : this.runRefBody(resultRoot ?? result),
          // harn:end run-failure-evidence-is-surfaced
        }),
      });

      if (participant.terminal_status !== 'completed' || resultAck) continue;
      for (const mention of aggregateParsed.mentions) {
        if (mention.member_id === participant.member_id || seen.has(mention.member_id)) continue;
        const recipient = this.store.getMember(room, mention.member_id);
        if (
          recipient?.kind !== 'agent' ||
          recipient.removed_ts !== undefined
        ) continue;
        seen.add(recipient.id);
        nextMembers.push(recipient);
      }
    }

    const context: GroupRoundPayloadContext = {
      ...this.groupPayloadContext(room, root, groupId, roundNumber + 1),
      priorRoundNumber: roundNumber,
      results,
    };
    const nextHop = Math.min(...projection.deliveries.map((delivery) => delivery.hop_count ?? 0)) + 1;
    const release = this.store.releaseCollaborationRound(room, {
      groupId,
      roundNumber,
      releasedTs: new Date().toISOString(),
      nextParticipants: nextMembers.map((member) => ({
        memberId: member.id,
        payloadSnapshot: this.groupPayloadSnapshot(composeGroupRoundPayload(context, member.handle)),
        state: 'queued',
        hopCount: nextHop,
      })),
    });
    if (release.status === 'released') {
      this.dispatchCreatedDeliveries(room, release.deliveries);
    }
  }
  // harn:end collaboration-round-release-is-one-barrier

  private clearSatisfiedGroupWaits(room: string, groupId: string, roundNumber: number): void {
    const participants = this.store.listCollaborationParticipants(room, groupId, roundNumber);
    const terminal = new Set(
      participants
        .filter((participant) => participant.terminal_status !== undefined)
        .map((participant) => participant.member_id),
    );
    const participantIds = new Set(participants.map((participant) => participant.member_id));
    for (const [memberId, context] of this.groupWaits) {
      if (
        context.room !== room ||
        context.groupId !== groupId ||
        context.roundNumber !== roundNumber
      ) continue;
      const waiting = this.memberWaits.get(memberId);
      if (
        !waiting ||
        !waiting.peers.every((peerId) => participantIds.has(peerId) && terminal.has(peerId))
      ) continue;
      this.memberWaits.delete(memberId);
      this.groupWaits.delete(memberId);
      const member = this.store.getMember(room, memberId);
      if (member) this.emitMember(room, member);
    }
  }

  // harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-member-skip-engine
  private skipUnavailableGroupDelivery(room: string, delivery: Delivery): void {
    if (delivery.group_id === undefined || delivery.group_round === undefined) return;
    const skipped = this.store.skipCollaborationParticipant(
      room,
      delivery.id,
      new Date().toISOString(),
    );
    if (delivery.state === 'held') this.emitInbox(room, skipped.delivery);
    this.clearSatisfiedGroupWaits(room, delivery.group_id, delivery.group_round);
    this.advanceCollaborationRound(room, delivery.group_id, delivery.group_round);
  }
  // harn:end open-collaboration-groups-reconcile-without-resurrection

  // ── interactions (PROTOCOL §2 state machine) ──────────────────────────

  // harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-orphan-daemon
  private orphanInteraction(room: string, interaction: PendingInteraction): PendingInteraction {
    const orphaned = this.store.orphanInteraction(
      room,
      interaction.id,
      new Date().toISOString(),
    );
    for (const delivery of orphaned.deliveries) this.emitInbox(room, delivery);
    return orphaned.interaction;
  }
  // harn:end approval-deliveries-project-resolution-separately

  private handleInteractionRaised(room: string, member: Member, card: AskCard, kind: 'ask' | 'approval'): void {
    const key = interactionKey(kind, card);
    const open = this.store
      .listInteractions(room)
      .filter((i) => i.member_id === member.id && (i.state === 'pending' || i.state === 'answered'));
    const match = open.find((i) => {
      const cardMsg = this.store.getMessage(room, i.message_id);
      return cardMsg?.ask !== undefined && interactionKey(i.kind, cardMsg.ask) === key;
    });

    if (match) {
      // Re-correlation after a crash: same semantic card, FRESH native id.
      const updated = this.store.upsertInteraction({ ...match, native_id: card.interaction_id });
      if (updated.state === 'answered') {
        if (updated.kind === 'ask') {
          // Idempotent replay of the persisted answer (P0.2 fixtures).
          void this.deliverAnswer(room, updated).catch(() => undefined);
        } else {
          // NEVER auto-resend an approval: orphan it and raise a fresh card.
          this.orphanInteraction(room, updated);
          this.postSystemMessage(
            room,
            `approval card #${updated.message_id} expired (answered before a restart; approvals are never auto-resent)`,
          );
          this.createInteraction(room, member, card, kind);
        }
      }
      return;
    }
    this.createInteraction(room, member, card, kind);
  }

  private createInteraction(room: string, member: Member, card: AskCard, kind: 'ask' | 'approval'): void {
    const cardMsg = this.store.postMessage(room, {
      author: member.id,
      kind,
      body: card.prompt,
      ask: card,
    });
    this.emitMessage(room, cardMsg);
    const targets = this.store
      .listMembers(room)
      .filter((m) => m.kind === 'human' && (m.role === 'owner' || m.role === 'admin' || m.role === 'member'))
      .map((m) => m.id);
    this.store.upsertInteraction({
      id: ulid(),
      room,
      member_id: member.id,
      message_id: cardMsg.id,
      native_id: card.interaction_id,
      kind,
      targets,
      state: 'pending',
    });
    for (const target of targets) {
      const delivery = this.store.createDelivery(room, {
        message_id: cardMsg.id,
        recipient: target,
        state: 'consumed',
      });
      this.emitInbox(room, delivery);
    }
    this.emitMember(room, this.store.updateMember(room, member.id, { state: 'awaiting_input' }));
  }

  /**
   * Resolves the client-supplied interaction handle: the store id, the
   * harness-native id, or the CARD MESSAGE id (what surfaces have — stable
   * across re-raises while native ids rotate).
   */
  private resolveInteraction(room: string, handle: string): PendingInteraction | undefined {
    const direct = this.store.getInteraction(handle);
    if (direct && direct.room === room) return direct;
    return this.store
      .listInteractions(room)
      .find((i) => i.native_id === handle || String(i.message_id) === handle);
  }

  /** The answer_interaction act: answered → respondInteraction ack → acked. */
  async answerInteraction(room: string, interactionId: string, answer: unknown, byMemberId?: string): Promise<void> {
    const interaction = this.resolveInteraction(room, interactionId);
    if (!interaction) throw new Error(`no such interaction ${interactionId}`);
    if (interaction.state !== 'pending') throw new Error(`interaction ${interactionId} is ${interaction.state}`);
    const by = byMemberId ?? this.ownerOf(room).id;
    if (!interaction.targets.includes(by)) {
      throw new Error(`interaction ${interactionId} is not addressed to member ${by}`);
    }
    // harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-daemon
    let answered: PendingInteraction;
    if (interaction.kind === 'approval') {
      const committed = this.store.answerApproval(
        room,
        interaction.id,
        answer,
        by,
        new Date().toISOString(),
      );
      answered = committed.interaction;
      for (const delivery of committed.deliveries) this.emitInbox(room, delivery);
    } else {
      answered = this.store.upsertInteraction({
        ...interaction,
        state: 'answered',
        answer,
        answered_by: by,
        answered_ts: new Date().toISOString(),
      });
      // Question answers remain visible history. A reply to a card never routes.
      const audit = this.store.postMessage(room, {
        author: by,
        kind: 'chat',
        body: typeof answer === 'string' ? answer : JSON.stringify(answer),
        reply_to: interaction.message_id,
      });
      this.emitMessage(room, audit);
    }
    // harn:end approval-answer-is-atomic-and-chatless
    await this.deliverAnswer(room, answered);
  }

  private async deliverAnswer(room: string, interaction: PendingInteraction): Promise<void> {
    const member = this.store.getMember(room, interaction.member_id);
    const session = member ? this.sessions.get(member.id) : undefined;
    if (!member || !session) {
      throw new Error('interaction answer persisted but its adapter turn is not in flight');
    }
    await this.requireAdapter(member.harness!).respondInteraction(
      session,
      interaction.native_id,
      interaction.answer,
    );
    this.store.upsertInteraction({ ...interaction, state: 'acked' });
    // harn:assume interaction-ack-preserves-finalized-member-state ref=interaction-ack-member-transition
    const current = this.store.getMember(room, member.id);
    if (current?.state === 'awaiting_input') {
      this.emitMember(room, this.store.updateMember(room, member.id, { state: 'running' }));
    }
    // harn:end interaction-ack-preserves-finalized-member-state
  }

  // ── boot reconcile ────────────────────────────────────────────────────

  // harn:assume delivery-attempt-wal-reconcile ref=boot-reconcile
  /**
   * Crash recovery, exactly-once-or-held: every `delivering` delivery is
   * reconciled against its run blob —
   *   blob shows run.completed → finalize that turn from the journal;
   *   blob empty on the first attempt → provably never started → retry ONCE
   *     (the retry REUSES the same run message);
   *   anything else (events but no completion, or a second failure) → HELD
   *     with a system message; the operator releases or redelivers.
   * Interactions left pending/answered ride the retry: the re-raised card
   * re-correlates semantically (fresh native ids), answered asks replay
   * idempotently, answered approvals orphan (never auto-resent). If the
   * turn never re-raises, finalize orphans the leftover interaction.
   */
  async reconcile(): Promise<void> {
    for (const room of this.store.listRooms()) {
      // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-seeding
      for (const member of this.store.listMembers(room.id)) {
        this.seedContextUsage(room.id, member);
      }
      // harn:end last-agent-usage-is-transient-and-seeded
      const delivering = this.store.listDeliveries(room.id, { state: 'delivering' });
      const byRunMsg = new Map<number, Delivery[]>();
      for (const delivery of delivering) {
        if (delivery.run_msg_id === undefined) continue;
        const group = byRunMsg.get(delivery.run_msg_id) ?? [];
        group.push(delivery);
        byRunMsg.set(delivery.run_msg_id, group);
      }

      for (const [runMsgId, group] of byRunMsg) {
        const runMsg = this.store.getMessage(room.id, runMsgId);
        if (!runMsg?.run) continue;
        if (runMsg.run.status !== 'running') {
          // already finalized — just consume
          for (const d of group) this.store.updateDelivery(room.id, d.id, { state: 'consumed' });
          continue;
        }
        const events = this.blobs.read(room.id, runMsg.run.events_ref);
        const completed = events.find((e): e is Extract<WireEvent, { type: 'run.completed' }> => e.type === 'run.completed');
        const member = this.store.getMember(room.id, runMsg.author)!;
        if (this.isRemoteMember(member)) {
          if (!this.residency?.isReachable(member.host)) {
            if (member.state !== 'unreachable') {
              this.emitMember(
                room.id,
                this.store.updateMember(room.id, member.id, { state: 'unreachable' }),
              );
            }
            continue;
          }
          if (!this.inflight.has(member.id)) {
            this.inflight.add(member.id);
            this.track(
              this.runTurn(room.id, member, group, runMsg)
                .finally(() => this.inflight.delete(member.id)),
            );
          }
          continue;
        }
        const blockedInteractions = this.store
          .listInteractions(room.id)
          .filter((i) => i.member_id === member.id && (i.state === 'pending' || i.state === 'answered'));

        const hasProcessEvidence = group.some(
          (delivery) => this.store.getDeliveryAttemptProcess(room.id, delivery.id) !== undefined,
        );
        const processAlive = group.some((delivery) => {
          const process = this.store.getDeliveryAttemptProcess(room.id, delivery.id);
          return process !== undefined && this.processAlive(process);
        });

        if (completed) {
          // Provably completed → finalize from the journal, never re-run.
          const toolCalls = events.filter((e) => e.type === 'run.item' && e.item_type === 'tool_call').length;
          // A row like #599 cannot finalize normally: its participant already
          // holds a terminal result, so completeTurn would refuse and roll the
          // whole transaction back, leaving the row running exactly as it was
          // found. Boot uses the SAME repair the runtime seam does instead.
          if (this.normalFinalizationIsIllegal(room.id, group)) {
            this.reconcileFailedFinalization(
              room.id,
              member.id,
              runMsgId,
              group,
              { status: completed.status, usage: completed.usage },
              new Error('its collaboration work was already settled'),
            );
            this.orphanLeftoverInteractions(room.id, member.id);
            continue;
          }
          const completion = {
            status: completed.status,
            final_text: completed.final_text,
            error: completed.error,
            usage: completed.usage,
          } satisfies TurnCompletion;
          try {
            this.finalizeTurn(
              room.id,
              member.id,
              runMsgId,
              // harn:assume failed-run-details-never-route-as-replies ref=failed-run-recovery
              completion,
              // harn:end failed-run-details-never-route-as-replies
              group,
              toolCalls,
            );
          } catch (error) {
            this.reconcileFailedFinalization(
              room.id,
              member.id,
              runMsgId,
              group,
              completion,
              error,
            );
          }
          this.orphanLeftoverInteractions(room.id, member.id);
        } else if (processAlive) {
          this.holdAmbiguousTurn(room.id, member, group, runMsgId, 'its adapter process may still be alive');
        } else if (blockedInteractions.length > 0 && group.every((d) => d.attempt_count <= 2)) {
          // Crashed while BLOCKED on an ask/approval: re-deliver so the
          // session can re-raise — the raise handler re-correlates the card
          // semantically (fresh native ids), replays answered asks, and
          // orphans answered approvals. The retried turn may block again on
          // a human, so it is TRACKED, never awaited; whatever never
          // re-raised is orphaned once the turn finalizes.
          const refusal = this.retryTurn(room.id, member, group, runMsg, true);
          if (refusal && !refusal.alreadyHeld) {
            this.holdAmbiguousTurn(room.id, member, group, runMsgId, refusal.reason);
          }
        } else if (
          events.length === 0 &&
          !hasProcessEvidence &&
          group.every((d) => d.attempt_count <= 1)
        ) {
          // Provably never started → retry once, REUSING the run message.
          const refusal = this.retryTurn(room.id, member, group, runMsg, false);
          if (refusal && !refusal.alreadyHeld) {
            this.holdAmbiguousTurn(room.id, member, group, runMsgId, refusal.reason);
          }
        } else {
          // Ambiguous → held + system message; operator decides.
          this.holdAmbiguousTurn(room.id, member, group, runMsgId);
        }
      }
      // harn:assume lifecycle-retries-only-live-collaboration-work ref=recovery-requeue-contract
      // A run still `running` here was stranded by a CRASH mid-turn — a graceful
      // stop settles its own turns in close(), before the store closes (#492), so
      // anything left running got no chance to. It takes the SAME atomic
      // retry-or-terminal settlement, so a crash cannot resurrect closed work
      // that a graceful stop would have refused.
      for (const runMsg of this.store.listMessages(room.id, { limit: Number.MAX_SAFE_INTEGER })) {
        if (runMsg.kind !== 'run' || runMsg.run?.status !== 'running') continue;
        // Exact run, not author-wide: another turn by the same author being
        // reconciled says nothing about whether THIS run is still owned.
        if (byRunMsg.has(runMsg.id)) continue; // this pass already reconciled it
        const bound = this.boundLifecycleDeliveries(room.id, runMsg.id);
        if (bound.length === 0) continue;
        const endedTs = new Date().toISOString();
        this.runActivity.delete(`${room.id}:${runMsg.id}`);
        this.settleLifecycleInterruptedTurn(
          room.id,
          runMsg.author,
          runMsg.id,
          bound,
          {
            body: '',
            mentions: [],
            refs: [],
            ledger_refs: [],
            run: {
              ...runMsg.run,
              status: 'interrupted',
              ended_ts: endedTs,
              stalled_since: undefined,
              final_text: undefined,
            },
          },
          endedTs,
          this.inflight.has(runMsg.author),
        );
      }
      // harn:end lifecycle-retries-only-live-collaboration-work
      this.reconcileCollaborationGroups(room.id);
      // drain anything still queued (tracked — a turn may block on an ask)
      for (const member of this.store.listMembers(room.id)) {
        if (member.kind === 'agent') this.track(this.maybeStartTurn(room.id, member.id));
      }
    }
  }
  // harn:end delivery-attempt-wal-reconcile

  // harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-reconciliation-engine
  private reconcileCollaborationGroups(room: string): void {
    for (const group of this.store.listCollaborationGroups(room, 'open')) {
      for (const round of this.store.listCollaborationRounds(room, group.id)) {
        if (round.state !== 'collecting') continue;
        for (const participant of this.store.listCollaborationParticipants(
          room,
          group.id,
          round.round_number,
        )) {
          if (participant.terminal_status !== undefined) continue;
          const delivery = this.store.getDelivery(room, participant.delivery_id);
          const member = this.store.getMember(room, participant.member_id);
          const result = delivery?.run_msg_id === undefined
            ? undefined
            : this.store.getMessage(room, delivery.run_msg_id);
          if (result?.run && result.run.status !== 'running') {
            this.store.recoverCollaborationParticipantTerminal(room, {
              deliveryId: participant.delivery_id,
              status: result.run.status,
              resultMessageId: result.id,
              completedTs: result.run.ended_ts ?? result.ts,
            });
          } else if (
            delivery !== undefined &&
            delivery.run_msg_id === undefined &&
            (member?.state === 'dead' || member?.removed_ts !== undefined)
          ) {
            this.store.skipCollaborationParticipant(
              room,
              delivery.id,
              new Date().toISOString(),
            );
          }
        }
        this.advanceCollaborationRound(room, group.id, round.round_number);
      }
    }
  }
  // harn:end open-collaboration-groups-reconcile-without-resurrection

  private processAlive(attempt: { pid?: number; process_group_id?: number }): boolean {
    const target = attempt.process_group_id !== undefined
      ? -attempt.process_group_id
      : attempt.pid;
    if (target === undefined) return false;
    return this.processProbe(target);
  }

  private holdAmbiguousTurn(
    room: string,
    member: Member,
    group: Delivery[],
    runMsgId: number,
    detail?: string,
  ): void {
    for (const delivery of group) this.store.updateDelivery(room, delivery.id, { state: 'held' });
    this.postSystemMessage(
      room,
      `delivery to @${member.handle} held after an ambiguous crash (turn #${runMsgId}${
        detail ? `; ${detail}` : ''
      }) — release_hold to retry or redeliver`,
    );
    const current = this.store.getMember(room, member.id);
    // harn:assume live-agent-waits-are-transient ref=wait-clears-on-turn-end
    this.memberWaits.delete(member.id);
    this.groupWaits.delete(member.id);
    // harn:end live-agent-waits-are-transient
    if (
      current?.custody === 'owned' &&
      current.state !== 'paused' &&
      current.state !== 'dead' &&
      current.state !== 'custody_uncertain'
    ) {
      this.emitMember(room, this.store.updateMember(room, member.id, { state: 'idle' }));
    }
    this.orphanLeftoverInteractions(room, member.id);
  }

  /** Reconcile retry: re-runs the SAME turn without blocking reconcile. */
  private retryTurn(
    room: string,
    member: Member,
    group: Delivery[],
    runMsg: Message,
    orphanAfter: boolean,
  ): RetryTurnRefusal | undefined {
    const eligible = this.turnStartEligibility(room, member.id);
    if (!eligible.member) {
      return {
        reason: eligible.refusal ?? `member @${member.handle} cannot start a turn`,
        alreadyHeld: false,
      };
    }
    const runnable = this.applyTurnStartBrakes(room, group, true);
    if (runnable.length === 0) {
      return { reason: 'delivery batch was held by current room brakes', alreadyHeld: true };
    }
    this.inflight.add(eligible.member.id);
    const turn = this.runTurn(room, eligible.member, runnable, runMsg)
      .finally(() => this.inflight.delete(eligible.member!.id))
      .then(() => {
        if (orphanAfter) this.orphanLeftoverInteractions(room, eligible.member!.id);
      });
    this.track(turn);
    return undefined;
  }

  /** Pending/answered interactions whose run never re-raised them → orphaned. */
  private orphanLeftoverInteractions(room: string, memberId: string): void {
    for (const interaction of this.store.listInteractions(room)) {
      if (interaction.member_id !== memberId) continue;
      if (interaction.state !== 'pending' && interaction.state !== 'answered') continue;
      this.orphanInteraction(room, interaction);
      this.postSystemMessage(
        room,
        `${interaction.kind} card #${interaction.message_id} expired (could not be re-correlated after restart) — redeliver to retry`,
      );
    }
  }

  // ── operator acts ─────────────────────────────────────────────────────

  // harn:assume redeliver-interrupts-stranded-run ref=redeliver-run-retirement
  redeliver(room: string, deliveryId: string): void {
    const delivery = this.store.getDelivery(room, deliveryId);
    if (!delivery) throw new Error(`no such delivery ${deliveryId}`);
    const abandonedRunId = delivery.run_msg_id;
    this.releasedDeliveries.delete(deliveryId);
    const updated = this.store.updateDelivery(room, deliveryId, {
      state: 'queued',
      run_msg_id: undefined,
      attempt_count: 0,
    });
    this.store.setDeliveryAttemptProcess(room, [deliveryId], undefined);
    if (abandonedRunId !== undefined) {
      const stillBound = this.store
        .listDeliveries(room)
        .some((candidate) => candidate.id !== deliveryId && candidate.run_msg_id === abandonedRunId);
      const abandoned = this.store.getMessage(room, abandonedRunId);
      if (!stillBound && abandoned?.run?.status === 'running') {
        const interrupted = this.store.updateMessage(room, abandoned.id, {
          body: '',
          mentions: [],
          refs: [],
          ledger_refs: [],
          run: {
            ...abandoned.run,
            status: 'interrupted',
            ended_ts: new Date().toISOString(),
            stalled_since: undefined,
            final_text: undefined,
          },
        });
        this.runActivity.delete(`${room}:${abandoned.id}`);
        this.emitMessage(room, interrupted);
      }
    }
    this.emitInbox(room, updated);
    this.track(this.maybeStartTurn(room, delivery.recipient));
  }
  // harn:end redeliver-interrupts-stranded-run

  // harn:assume retried-runs-revive-and-redeliver ref=retry-run-contract
  /**
   * Retry a failed or interrupted run: re-deliver the instructions it fed so the
   * agent takes them again as a fresh turn producing a NEW run; the original run
   * stays in history untouched. Only human owners/admins may retry (the server
   * gate enforces the role; this refuses others defensively). Deliveries whose
   * trigger message was since deleted are skipped — a purge must not resurrect —
   * and a run with none surviving is refused. A failed run leaves its agent dead,
   * so it is revived first; reuses redeliver unmodified for the re-queue.
   */
  retryRun(room: string, messageId: number, byMemberId: string): void {
    const actor = this.store.getMember(room, byMemberId);
    if (actor?.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new Error('forbidden: only owners and admins can retry runs');
    }
    const message = this.store.getMessage(room, messageId);
    if (!message) throw new Error(`no such message: #${messageId}`);
    if (message.kind !== 'run' || message.run === undefined) {
      throw new Error(`only run messages can be retried, not ${message.kind}`);
    }
    const status = message.run.status;
    if (status !== 'failed' && status !== 'interrupted') {
      throw new Error(`only failed or interrupted runs can be retried, not ${status}`);
    }
    // A deleted trigger stays purged: skip its snapshotted delivery.
    const survivors = this.store
      .listDeliveries(room)
      .filter((delivery) => delivery.run_msg_id === messageId)
      .filter((delivery) => this.store.getMessage(room, delivery.message_id)?.deleted !== true);
    if (survivors.length === 0) {
      throw new Error('nothing to retry: the run has no surviving instructions to re-deliver');
    }
    // A failed run killed its agent; bring it back so the re-queue can run.
    const agent = this.store.getMember(room, message.author);
    if (agent?.kind === 'agent' && agent.state === 'dead') this.reviveMember(room, agent.id);
    for (const delivery of survivors) this.redeliver(room, delivery.id);
  }
  // harn:end retried-runs-revive-and-redeliver

  releaseHold(room: string, deliveryId: string): void {
    const delivery = this.store.getDelivery(room, deliveryId);
    if (!delivery || delivery.state !== 'held') throw new Error(`delivery ${deliveryId} is not held`);
    const attemptProcess = this.store.getDeliveryAttemptProcess(room, deliveryId);
    if (attemptProcess && this.processAlive(attemptProcess)) {
      throw new Error(`delivery ${deliveryId} cannot be released while its adapter process is alive`);
    }
    if (delivery.run_msg_id !== undefined) {
      const runMsg = this.store.getMessage(room, delivery.run_msg_id);
      const member = this.store.getMember(room, delivery.recipient);
      if (runMsg?.run?.status === 'running' && member?.kind === 'agent') {
        const group = this.store
          .listDeliveries(room, { recipient: member.id, state: 'held' })
          .filter((candidate) => candidate.run_msg_id === runMsg.id);
        for (const candidate of group) this.releasedDeliveries.add(candidate.id);
        const refusal = this.retryTurn(room, member, group, runMsg, false);
        if (refusal) {
          for (const candidate of group) this.releasedDeliveries.delete(candidate.id);
          throw new Error(`delivery ${deliveryId} cannot be released: ${refusal.reason}`);
        }
        return;
      }
    }
    this.releasedDeliveries.add(deliveryId);
    const updated = this.store.updateDelivery(room, deliveryId, { state: 'queued' });
    this.emitInbox(room, updated);
    this.track(this.maybeStartTurn(room, delivery.recipient));
  }

  /** Operator hold: parks a queued delivery until release_hold (also the brake hook). */
  holdDelivery(room: string, deliveryId: string, reason: string): void {
    const delivery = this.store.getDelivery(room, deliveryId);
    if (!delivery) throw new Error(`no such delivery ${deliveryId}`);
    this.releasedDeliveries.delete(deliveryId);
    const updated = this.store.updateDelivery(room, deliveryId, { state: 'held' });
    this.emitInbox(room, updated);
    const recipient = this.store.getMember(room, delivery.recipient);
    const body = `delivery to @${recipient?.handle ?? delivery.recipient} held (${reason}) — release_hold to run it`;
    this.postSystemMessage(room, body);
    this.pushLog.push({ room, body, ts: new Date().toISOString() });
    if (reason.startsWith('turn brake') || reason.startsWith('spend brake')) {
      this.queueHumanPush(
        room,
        delivery.message_id,
        'hold',
        body,
        [this.ownerOf(room).id],
        delivery.id,
      );
    }
  }

  markRead(room: string, deliveryId: string, byMemberId?: string): Delivery {
    const delivery = this.store.getDelivery(room, deliveryId);
    if (!delivery) throw new Error(`no such delivery ${deliveryId}`);
    const by = byMemberId ?? this.ownerOf(room).id;
    if (delivery.recipient !== by) throw new Error(`delivery ${deliveryId} does not belong to member ${by}`);
    const updated = this.store.updateDelivery(room, deliveryId, { read_ts: new Date().toISOString() });
    this.emitInbox(room, updated);
    return updated;
  }

  // harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-storage
  markRoomRead(room: string, throughSeq: number, byMemberId?: string): RoomSupport {
    const by = byMemberId ?? this.ownerOf(room).id;
    const result = this.store.markRoomRead(room, by, throughSeq);
    for (const delivery of result.deliveries) this.emitInbox(room, delivery);
    return this.roomSupport(room, by);
  }
  // harn:end human-room-read-cursors-are-durable-and-monotonic

  // harn:assume live-delivery-consumption-is-idempotent ref=consume-delivery-daemon
  consumeDelivery(
    room: string,
    deliveryId: string,
    byMemberId: string,
  ): { delivery: Delivery; message: Message } {
    return this.project(
      room,
      this.store.consumeQueuedDelivery(room, deliveryId, byMemberId),
    );
  }
  // harn:end live-delivery-consumption-is-idempotent

  // harn:assume member-status-is-bounded-and-identity-safe ref=status-aggregation
  memberStatus(room: string, memberId: string, now = new Date()): MemberStatusResponse {
    const member = this.store.getMember(room, memberId);
    if (!member || member.removed_ts !== undefined) throw new Error(`no such member: ${memberId}`);
    const latestRun = this.store.listRunMessages(room, { author: memberId, limit: 1 })[0];
    const currentRun = latestRun?.run?.status === 'running' ? latestRun : undefined;
    const resultByCall = new Map<string, { status: 'ok' | 'error'; duration_ms?: number }>();
    const events = latestRun ? this.readRunBlob(room, latestRun.id) : [];
    for (const event of events) {
      if (event.type !== 'run.item' || event.item_type !== 'tool_result') continue;
      const parsed = parseRunItemPayload('tool_result', event.payload);
      if (!parsed.success) continue;
      resultByCall.set(parsed.data.call_id, {
        status: parsed.data.status,
        ...(parsed.data.duration_ms !== undefined && { duration_ms: parsed.data.duration_ms }),
      });
    }
    const recent: MemberStatusResponse['recent'] = [];
    let observedToolCalls = 0;
    if (latestRun?.run) {
      for (const event of events) {
        if (event.type !== 'run.item' || event.item_type !== 'tool_call') continue;
        const parsed = parseRunItemPayload('tool_call', event.payload);
        if (!parsed.success) continue;
        observedToolCalls++;
        const result = resultByCall.get(parsed.data.call_id);
        recent.push({
          kind: 'tool',
          title: parsed.data.title.slice(0, 500),
          ...(result?.status !== undefined && { status: result.status }),
          ...(result?.duration_ms !== undefined && { duration_ms: result.duration_ms }),
          ts: event.ts ?? latestRun.run.started_ts,
        });
      }
      for (const post of this.store.listChatMessagesByAuthorWithin(
        room,
        memberId,
        latestRun.run.started_ts,
        latestRun.run.ended_ts,
        5,
      )) {
        recent.push({ kind: 'post', title: post.body.slice(0, 500), ts: post.ts });
      }
    }
    recent.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    const waiting = this.memberWaits.get(memberId);
    const response: MemberStatusResponse = {
      member: {
        handle: member.handle,
        state: member.state ?? 'idle',
        ...(waiting && {
          waiting: {
            peers: waiting.peers
              .map((peerId) => this.store.getMember(room, peerId)?.handle)
              .filter((handle): handle is string => handle !== undefined),
            reason: waiting.reason,
            since_ts: waiting.since_ts,
            until_ts: waiting.until_ts,
          },
        }),
      },
      ...(currentRun?.run && {
        current_run: {
          message_id: currentRun.id,
          started_ts: currentRun.run.started_ts,
          elapsed_ms: Math.max(0, now.getTime() - Date.parse(currentRun.run.started_ts)),
          tool_calls: Math.max(currentRun.run.tool_calls, observedToolCalls),
        },
      }),
      recent: recent.slice(0, 5),
    };
    return MemberStatusResponseSchema.parse(this.project(room, response));
  }
  // harn:end member-status-is-bounded-and-identity-safe

  // harn:assume run-evidence-search-is-bounded-and-redacted ref=bounded-run-evidence-scan
  searchRunEvidence(room: string, query: string, scanLimit = 50): RunSearchHit[] {
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 200) {
      throw new Error('run search limit must be an integer from 1 to 200');
    }
    const needle = query.toLowerCase();
    const hits: RunSearchHit[] = [];
    const excerpt = (value: string): string => {
      const text = value.replace(/\s+/g, ' ').trim();
      const match = text.toLowerCase().indexOf(needle);
      const start = Math.max(0, match - 80);
      return text.slice(start, start + 240);
    };
    for (const run of this.store.listRunMessages(room, { limit: scanLimit })) {
      const events = this.readRunBlob(room, run.id);
      for (let itemIndex = 0; itemIndex < events.length; itemIndex++) {
        const event = events[itemIndex]!;
        if (event.type !== 'run.item') continue;
        let value: string | undefined;
        if (event.item_type === 'tool_call') {
          const parsed = parseRunItemPayload('tool_call', event.payload);
          if (parsed.success) value = parsed.data.title;
        } else if (event.item_type === 'tool_result') {
          const parsed = parseRunItemPayload('tool_result', event.payload);
          if (parsed.success) value = parsed.data.output_text;
        }
        if (value === undefined || !value.toLowerCase().includes(needle)) continue;
        hits.push({
          message_id: run.id,
          item_index: itemIndex,
          kind: event.item_type as 'tool_call' | 'tool_result',
          excerpt: excerpt(value),
        });
        if (hits.length === scanLimit) return hits;
      }
    }
    return hits;
  }
  // harn:end run-evidence-search-is-bounded-and-redacted

  unreadCount(room: string, memberId: string): number {
    return this.store
      .listDeliveries(room, { recipient: memberId })
      .filter((d) => d.read_ts === undefined && d.state === 'consumed').length;
  }

  // harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-projection
  roomSupport(room: string, memberId: string): RoomSupport {
    return this.project(room, this.store.roomSupport(room, memberId));
  }
  // harn:end room-support-is-bounded-recipient-scoped-state

  /** Delta-sync straight off the change log, redacted like every fanout. */
  // harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-contract
  sync(
    room: string,
    sinceSeq: number,
    opts?: {
      hydrateLimit?: number;
      subscriber?: string;
      strictTail?: boolean;
      supportFor?: string;
    },
  ): ReturnType<Store['sync']>;
  // harn:end addressed-cold-hydration-is-strict-and-legacy-safe
  // harn:assume live-agent-waits-are-transient ref=wait-member-projection
  sync(
    room: string,
    sinceSeq: number,
    opts: { hydrateLimit?: number; subscriber?: string } = {},
  ): ReturnType<Store['sync']> {
    const sync = this.store.sync(room, sinceSeq, opts);
    const members = new Map(sync.members.map((member) => [member.id, member]));
    for (const member of this.store.listMembers(room)) members.set(member.id, member);
    return this.project(room, {
      ...sync,
      // Transient waits have no change-log row, so every hydration gets the
      // authoritative active roster plus any removed-member delta from Store.
      members: [...members.values()].map((member) => {
        // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-member-projection
        const waiting = this.memberWaits.get(member.id);
        return {
          ...this.memberWithLastUsage(room, member),
          ...(waiting && { waiting }),
        };
        // harn:end last-agent-usage-is-transient-and-seeded
      }),
    });
  }
  // harn:end live-agent-waits-are-transient

  readRunBlob(room: string, msgId: number): WireEvent[] {
    const message = this.store.getMessage(room, msgId);
    if (!message?.run) return [];
    return this.project(room, this.blobs.read(room, message.run.events_ref));
  }

  // harn:assume room-git-state-read-only-from-known-cwds ref=room-git-state-contract
  /**
   * The diff explorer's live git working-state for one of the room's known
   * directories. `requestedCwd` is a SELECTOR into the room's recorded cwd set,
   * never a free path: a value outside the set is refused before any git runs.
   * A non-git or clean directory yields an empty, clean state.
   */
  async gitWorkingState(room: string, requestedCwd?: string): Promise<RoomGitWorkingState> {
    const cwds = this.roomKnownCwds(room);
    if (requestedCwd !== undefined && !cwds.includes(requestedCwd)) {
      throw new Error("cwd is not one of the room's known directories");
    }
    const selected = requestedCwd ?? cwds[0] ?? null;
    if (selected === null) return { cwds, selected, clean: true, files: [] };
    const files = await this.readGitWorkingFiles(selected);
    return { cwds, selected, clean: files.length === 0, files };
  }

  /** The room's known directories: distinct existing cwds of its agent members
   *  plus the room's recorded folder, canonicalized. Missing dirs are dropped so
   *  a stale cwd is never offered and never reaches git. */
  private roomKnownCwds(room: string): string[] {
    const raw: string[] = [];
    for (const member of this.store.listMembers(room)) {
      if (member.kind === 'agent' && member.cwd !== undefined) raw.push(member.cwd);
    }
    const roomCwd = this.store.getRoom(room)?.config.cwd;
    if (roomCwd !== undefined) raw.push(roomCwd);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of raw) {
      let normalized: string;
      try {
        normalized = normalizeWorkingDirectory(value, this.homeDir);
      } catch {
        continue; // a removed/invalid directory is simply not offered
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }

  /** Read-only git working-tree read for one already-validated directory. Only
   *  read-only subcommands run, each via execFile with a timeout — no shell, no
   *  mutation. A non-git or clean directory returns no files. */
  private async readGitWorkingFiles(cwd: string): Promise<RoomGitFile[]> {
    const git = async (args: string[], tolerateDiff = false): Promise<string> => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
        });
        return stdout;
      } catch (error) {
        // `diff --no-index` exits 1 when the files differ — expected, not failure.
        const code = (error as { code?: unknown }).code;
        const stdout = (error as { stdout?: unknown }).stdout;
        if (tolerateDiff && code === 1 && typeof stdout === 'string') return stdout;
        throw error;
      }
    };

    try {
      if ((await git(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return [];
    } catch {
      return []; // not a git repository (or git unavailable)
    }

    let statusOut: string;
    try {
      statusOut = await git(['status', '--porcelain=v1', '-z']);
    } catch {
      return [];
    }
    const entries = parsePorcelainStatus(statusOut);
    if (entries.length === 0) return [];

    const numstat = new Map<string, { additions: number; deletions: number }>();
    try {
      const out = await git(['diff', 'HEAD', '--numstat']);
      for (const line of out.split('\n')) {
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
        if (!match) continue;
        const raw = match[3]!;
        const path = raw.includes(' => ') ? raw.replace(/^.* => /, '') : raw;
        numstat.set(path, {
          additions: match[1] === '-' ? 0 : Number(match[1]),
          deletions: match[2] === '-' ? 0 : Number(match[2]),
        });
      }
    } catch {
      // No HEAD yet (empty repo): counts fall back to per-file line counting.
    }

    const files: RoomGitFile[] = [];
    for (const entry of entries) {
      let diff = '';
      try {
        diff = entry.status === 'untracked'
          ? await git(['diff', '--no-index', '--', '/dev/null', entry.path], true)
          : await git(['diff', 'HEAD', '--', entry.path]);
      } catch {
        diff = '';
      }
      let truncated = false;
      if (diff.length > MAX_FILE_DIFF_CHARS) {
        diff = diff.slice(0, MAX_FILE_DIFF_CHARS) + DIFF_TRUNCATED_MARKER;
        truncated = true;
      }
      const counts = numstat.get(entry.path) ?? countDiffLines(diff);
      files.push({
        path: entry.path,
        status: entry.status,
        additions: counts.additions,
        deletions: counts.deletions,
        diff,
        truncated,
      });
    }
    return files;
  }
  // harn:end room-git-state-read-only-from-known-cwds

  // harn:assume attachments-are-capped-files-served-inert ref=attachment-contract
  // The attachment contract: files live under the data dir keyed by a server-issued
  // hex id (never a client path), staged by upload, validated on post, delivered to
  // agents as absolute path lines, unlinked on delete, and swept when orphaned.

  /** A fresh, path-safe attachment id — also the on-disk file name. */
  newAttachmentId(): string {
    return randomBytes(16).toString('hex');
  }

  /** Absolute path to an attachment's bytes; throws unless id is a valid handle,
   *  so a client-supplied id can never escape the room's attachment directory. */
  attachmentPath(room: string, id: string): string {
    if (!ATTACHMENT_ID.test(id)) throw new Error('invalid attachment id');
    return join(this.attachmentsRoot, room, id);
  }

  private attachmentMetaPath(room: string, id: string): string {
    return `${this.attachmentPath(room, id)}.json`;
  }

  /** Ensure a room's attachment directory exists before an upload writes into it. */
  ensureAttachmentDir(room: string): string {
    const dir = join(this.attachmentsRoot, room);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Persist an uploaded file's metadata sidecar (name/mime/size by id). */
  recordAttachment(room: string, meta: Attachment): void {
    writeFileSync(this.attachmentMetaPath(room, meta.id), JSON.stringify(meta));
  }

  /** An attachment's stored metadata, or undefined if it was never staged here. */
  getAttachmentMeta(room: string, id: string): Attachment | undefined {
    if (!ATTACHMENT_ID.test(id)) return undefined;
    try {
      return AttachmentSchema.parse(JSON.parse(readFileSync(this.attachmentMetaPath(room, id), 'utf8')));
    } catch {
      return undefined;
    }
  }

  /** Validate post-time attachment ids against this room's staging and return
   *  their metadata to stamp onto the message. Throws on any unknown id (which
   *  also refuses another room's ids) or over the per-message cap. */
  resolveAttachmentsForPost(room: string, ids: readonly string[] | undefined): Attachment[] {
    if (ids === undefined || ids.length === 0) return [];
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} attachments per message`);
    }
    return ids.map((id) => {
      const meta = this.getAttachmentMeta(room, id);
      if (meta === undefined) throw new Error(`unknown attachment ${id}`);
      return meta;
    });
  }

  /** Unlink a deleted message's attachment files (bytes + sidecar) from disk. */
  private unlinkAttachments(room: string, attachments: Attachment[] | undefined): void {
    for (const attachment of attachments ?? []) {
      if (!ATTACHMENT_ID.test(attachment.id)) continue;
      rmSync(this.attachmentPath(room, attachment.id), { force: true });
      rmSync(this.attachmentMetaPath(room, attachment.id), { force: true });
    }
  }

  /** Boot-time sweep: unlink staged files that no message referenced within the
   *  orphan window. Referenced files stay until their message is deleted. */
  sweepOrphanAttachments(now = Date.now()): void {
    let rooms: string[];
    try {
      rooms = readdirSync(this.attachmentsRoot);
    } catch {
      return; // nothing staged yet
    }
    for (const room of rooms) {
      const dir = join(this.attachmentsRoot, room);
      const referenced = new Set<string>();
      if (this.store.getRoom(room) !== undefined) {
        for (const message of this.store.listMessages(room, { limit: Number.MAX_SAFE_INTEGER })) {
          for (const attachment of message.attachments ?? []) referenced.add(attachment.id);
        }
      }
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const id = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry;
        if (!ATTACHMENT_ID.test(id) || referenced.has(id)) continue;
        const path = join(dir, entry);
        try {
          if (now - statSync(path).mtimeMs > ORPHAN_ATTACHMENT_MS) rmSync(path, { force: true });
        } catch {
          // raced away — nothing to unlink
        }
      }
    }
  }

  /** Absolute-path lines appended to an agent's delivered text for a message's
   *  files — agents share this machine, so a path is the honest delivery form. */
  private attachmentPayloadLines(room: string, messageId: number): string {
    const attachments = this.store.getMessage(room, messageId)?.attachments ?? [];
    if (attachments.length === 0) return '';
    const lines = attachments.map(
      (attachment) =>
        `- ${this.attachmentPath(room, attachment.id)} (${attachment.name}, ${formatBytes(attachment.size)})`,
    );
    return `\n\nAttachments:\n${lines.join('\n')}`;
  }
  // harn:end attachments-are-capped-files-served-inert
}
