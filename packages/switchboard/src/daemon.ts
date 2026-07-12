import { homedir } from 'node:os';

import type {
  AskCard,
  AttachLease,
  BridgeOrigin,
  Delivery,
  HarnessAdapter,
  Member,
  Message,
  PendingInteraction,
  Role,
  ServerFrame,
  Session,
  WireEvent,
  CreateRoomRequest,
} from '@codor/protocol';
import { deriveRoomId } from '@codor/protocol';

import { BlobStore } from './blobs.js';
import { validateSpawnOptions } from './adapter-registry.js';
import { roleAllows } from './authorization.js';
import type { LedgerGraph, LedgerManager } from './ledger/watch.js';
import type { LedgerNote, LedgerWrite } from './ledger/vault.js';
import type { HumanPushKind, HumanPushNotifier } from './push/producer.js';
import { redactValue } from './redact.js';
import {
  RemoteAttemptAmbiguousError,
  type ResidencyCoordinator,
  remoteMemberSpec,
} from './residency.js';
import {
  composePayload,
  evaluateBrakes,
  parseBody,
  type PayloadContext,
  resolveRecipients,
  type ResolvedRef,
} from './router.js';
import { Store, type FanoutDelivery } from './store.js';
import { normalizeWorkingDirectory } from './working-directory.js';

export interface DaemonOptions {
  dbPath: string;
  blobRoot: string;
  adapters: HarnessAdapter[];
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
}

export interface MemberDetails {
  member: Member;
  queued_count: number;
  spend: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    uncosted_tokens: number;
  };
}

export type FrameListener = (room: string, frame: ServerFrame) => void;

interface TurnCompletion {
  status: 'completed' | 'failed' | 'interrupted';
  final_text?: string;
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
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private readonly listeners: FrameListener[] = [];
  private readonly pendingAttach = new Set<string>();
  private readonly releasedDeliveries = new Set<string>();
  private readonly operatorInterrupts = new Set<string>();
  private readonly attachLeaseTimeoutMs: number;
  private readonly processProbe: (target: number) => boolean;
  private readonly attachLeaseTimer: NodeJS.Timeout;
  private readonly stallTimer: NodeJS.Timeout;
  private readonly runActivity = new Map<string, number>();
  private readonly hostId?: string;
  private readonly residency?: ResidencyCoordinator;
  private readonly ledger?: LedgerManager;
  private readonly pushProducer?: HumanPushNotifier;
  private readonly onBackgroundError: (error: Error) => void;
  private readonly homeDir: string;
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
    this.stopResidencyReachability = this.residency?.onReachability((peerId, connected) =>
      this.handleResidentReachability(peerId, connected));
  }

  async close(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    clearInterval(this.attachLeaseTimer);
    clearInterval(this.stallTimer);
    this.stopResidencyReachability?.();
    if (options.force !== true) {
      for (const [memberId, session] of this.sessions) {
        const member = this.store.listRooms().find((room) => this.store.getMember(room.id, memberId));
        const persisted = member ? this.store.getMember(member.id, memberId) : undefined;
        if (persisted?.harness) this.requireAdapter(persisted.harness).interrupt(session);
      }
      await this.settle();
    }
    await this.ledger?.close();
    this.store.close();
    this.closed = true;
  }

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

  private emitMember(room: string, member: Member): void {
    this.emit(room, { type: 'member', seq: this.store.currentSeq(room), member });
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
    const baseId = opts.id ?? deriveRoomId(opts.name);
    let id = baseId;
    if (opts.id === undefined) {
      for (let suffix = 2; this.store.getRoom(id); suffix++) id = `${baseId}-${String(suffix)}`;
    }
    const cwd = opts.cwd === undefined
      ? undefined
      : normalizeWorkingDirectory(opts.cwd, this.homeDir);
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
          cwd: cwd ?? normalizeWorkingDirectory(process.cwd(), this.homeDir),
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
    );
    if (!result.deduped) {
      this.emitMessage(room, result.message);
      this.routeAndFanout(room, result.message);
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

  registeredAdapters(): { id: string; capabilities: HarnessAdapter['capabilities'] }[] {
    return [...this.adapters.values()]
      .map((adapter) => ({ id: adapter.id, capabilities: adapter.capabilities }))
      .sort((a, b) => a.id.localeCompare(b.id));
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
        member,
        queued_count: this.store.listDeliveries(room, {
          recipient: member.id,
          state: 'queued',
        }).length,
        spend: runs.reduce(
          (total, message) => ({
            turns: total.turns + 1,
            input_tokens: total.input_tokens + (message.run?.usage?.input_tokens ?? 0),
            output_tokens: total.output_tokens + (message.run?.usage?.output_tokens ?? 0),
            cost_usd: total.cost_usd + (message.run?.usage?.cost_usd ?? 0),
            uncosted_tokens:
              total.uncosted_tokens +
              (message.run?.usage !== undefined && message.run.usage.cost_usd === undefined
                ? message.run.usage.input_tokens + message.run.usage.output_tokens
                : 0),
          }),
          { turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, uncosted_tokens: 0 },
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
      host: this.hostId,
      state: 'idle',
      custody: 'owned',
    });
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
        this.store.upsertInteraction({ ...interaction, state: 'orphaned' });
      }
    }
    const member = this.store.updateMember(room, memberId, { state: 'dead' });
    this.emitMember(room, member);
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
    if (existing.state !== 'dead') throw new Error(`member @${existing.handle} must be dead before removal`);
    const member = this.store.updateMember(room, memberId, {
      removed_ts: new Date().toISOString(),
    });
    this.sessions.delete(memberId);
    this.markRostersStale(room);
    this.emitMember(room, member);
    this.postSystemMessage(room, `@${member.handle} was removed; its history remains attributed`);
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
    let session = this.sessions.get(member.id);
    if (!session) {
      const adapter = this.requireAdapter(member.harness!);
      session =
        member.session_ref !== undefined
          ? adapter.attach(member.session_ref)
          : (() => {
              const spawnOpts = { cwd: member.cwd ?? process.cwd(), policy: member.policy };
              // harn:assume canonical-spawn-controls-enforced ref=daemon-session-rebuild-validation
              validateSpawnOptions(adapter, spawnOpts);
              const rebuilt = adapter.spawn(spawnOpts);
              // harn:end canonical-spawn-controls-enforced
              return rebuilt;
            })();
      session.cwd = member.cwd ?? session.cwd; // revive MUST reuse the persisted cwd
      session.policy = member.policy;
      this.sessions.set(member.id, session);
    }
    return session;
  }

  // ── posting ───────────────────────────────────────────────────────────

  postHumanMessage(room: string, body: string, opts: { author?: string; reply_to?: number } = {}): Message {
    const authorId = opts.author ?? this.ownerOf(room).id;
    const author = this.store.getMember(room, authorId);
    if (author?.kind !== 'human') throw new Error(`no such human author: ${authorId}`);
    const parsed = parseBody(body, this.store.listMembers(room));
    const message = this.store.postMessage(room, {
      author: authorId,
      kind: 'chat',
      body,
      mentions: parsed.mentions,
      refs: parsed.refs,
      ledger_refs: parsed.ledger_refs,
      reply_to: opts.reply_to,
    });
    this.emitMessage(room, message);
    this.routeAndFanout(room, message);
    return message;
  }

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
          },
        };
        const draft: Message = { ...placeholder, ...patch };
        const { result, fanout } = this.planFanout(
          joined.room,
          draft,
          this.ownerOf(joined.room).id,
        );
        return { message: patch, fanout, markMisaddressed: result.misaddressed };
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
    });
    this.blobs.append(joined.room, eventsRef, {
      type: 'run.completed',
      status: 'completed',
      final_text: input.body,
    });
    this.emitMessage(joined.room, committed.message);
    if (committed.member) this.emitMember(joined.room, committed.member);
    this.dispatchCreatedDeliveries(joined.room, committed.deliveries);
    return { message: committed.message, deduped: false };
  }
  // harn:end mirror-one-message-per-native-turn

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

  private routeAndFanout(room: string, message: Message, triggerAuthor?: string): void {
    const { result, fanout } = this.planFanout(room, message, triggerAuthor);
    if (!result.routable) return;

    const author = this.store.getMember(room, message.author);
    if (result.misaddressed && author) {
      this.emitMember(room, this.store.updateMember(room, author.id, { misaddressed: true }));
    }

    const created = fanout.map((delivery) =>
      this.store.createDelivery(room, {
        message_id: message.id,
        recipient: delivery.recipient,
        state: delivery.state,
        payload_snapshot: delivery.payload_snapshot,
        hop_count: delivery.hop_count,
      }),
    );
    this.dispatchCreatedDeliveries(room, created);
  }

  private dispatchCreatedDeliveries(room: string, created: Delivery[]): void {
    for (const delivery of created) {
      const recipient = this.store.getMember(room, delivery.recipient);
      if (recipient?.kind === 'human') this.emitInbox(room, delivery);
      else if (recipient?.kind === 'agent') this.dispatchAgentDelivery(room, delivery, recipient);
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
    const preservesState =
      recipient.state === 'paused' ||
      recipient.state === 'dead' ||
      recipient.state === 'custody_uncertain';
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

  private planFanout(room: string, message: Message, triggerAuthor?: string, agentHop?: number) {
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
        payload_snapshot: this.snapshotPayload(room, message, agent, recipients),
        hop_count: agentHop ?? (author?.kind === 'agent' ? 1 : 0),
      })),
    ];
    return { result, fanout };
  }

  // harn:assume delivery-payload-snapshotted ref=daemon-payload-snapshot
  private snapshotPayload(room: string, message: Message, recipient: Member, recipients: Member[]): string {
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
        body: ref.kind === 'run' ? (ref.run?.final_text ?? ref.body) : ref.body,
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
    const batch = this.applyTurnStartBrakes(room, queued, false);
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
    // harn:assume runs-are-one-message ref=run-message-lifecycle
    // Exactly one run message per turn: post the placeholder (status
    // running, events_ref = its own blob) — or REUSE the placeholder when a
    // reconciled retry re-runs the same turn. Never a second message.
    const originalStates = new Map(batch.map((delivery) => [delivery.id, delivery.state]));
    const started = this.store.beginTurn(room, {
      memberId: member.id,
      deliveryIds: batch.map((delivery) => delivery.id),
      startedTs: new Date().toISOString(),
      eventsRef: (messageId) => this.blobs.ref(messageId),
      reuseRunMsgId: reuseRunMsg?.id,
    });
    const runMsg = started.runMessage;
    this.emitMessage(room, runMsg);
    this.noteRunActivity(room, runMsg.id);
    // harn:end runs-are-one-message

    // harn:assume delivery-attempt-wal-reconcile ref=wal-bind-before-spawn
    // Attempt WAL: bind every batched delivery to the run message and count
    // the attempt BEFORE the adapter spawns — consumption happens only when
    // run.completed lands, so a crash leaves reconcilable evidence.
    const bound = started.deliveries;
    // harn:end delivery-attempt-wal-reconcile
    for (const delivery of bound) {
      if (originalStates.get(delivery.id) === 'held') this.emitInbox(room, delivery);
    }

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
          this.emit(room, { type: 'run_event', room, message_id: runMsg.id, event: startedEvent });
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
        this.blobs.append(room, runMsg.run!.events_ref, journalEvent);
        if (
          journalEvent.type === 'run.started' ||
          journalEvent.type === 'run.item' ||
          journalEvent.type === 'extension.started' ||
          journalEvent.type === 'extension.ended'
        ) {
          this.emit(room, { type: 'run_event', room, message_id: runMsg.id, event: journalEvent });
        }
        if (event.type === 'ask.raised' || event.type === 'approval.raised') {
          this.handleInteractionRaised(room, member, event.card, event.type === 'ask.raised' ? 'ask' : 'approval');
        } else if (event.type === 'run.completed') {
          completion = { status: event.status, final_text: event.final_text, usage: event.usage };
        }
      }
    } catch (error) {
      if (error instanceof RemoteAttemptAmbiguousError) {
        this.holdAmbiguousTurn(room, member, bound, runMsg.id, 'resident reported ambiguous');
        return;
      }
      completion = completion ?? {
        status: 'failed',
        final_text: error instanceof Error ? error.message : String(error),
      };
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
    this.finalizeTurn(room, member.id, runMsg.id, completion ?? { status: 'interrupted' }, bound, toolCalls);
  }

  private composeBatchPayload(room: string, recipient: Member, batch: Delivery[]): string {
    const payloads: string[] = [];
    for (const delivery of batch) {
      const encoded = this.store.getDeliveryPayloadSnapshot(room, delivery.id);
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
      const fresh = this.store.getMember(room, recipient.id)!;
      const needsConventions = !fresh.conventions_sent || fresh.misaddressed;
      const needsRoster = fresh.roster_stale;
      const ctx: PayloadContext = {
        ...snapshot.context,
        roster: needsRoster
          ? this.store.listMembers(room).map((member) => ({
              handle: member.handle,
              kind: member.kind,
              ...(member.purpose !== undefined && { purpose: member.purpose }),
            }))
          : undefined,
        conventions: needsConventions
          ? {
              others: [
                ...new Set([
                  ...snapshot.context.toHandles.filter((handle) => handle !== snapshot.you),
                  snapshot.context.authorHandle,
                ]),
              ],
              untaggedGoesTo: snapshot.context.authorHandle,
              ledger: this.ledger?.isEnabled(room) ?? false,
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
    return payloads.join('\n');
  }

  // harn:assume reply-is-finalized-run-message ref=finalize-and-route
  /**
   * The reply IS the run message: finalize IN PLACE (body = final_text,
   * mentions/refs re-parsed from that body, summary updated, seq bumped) and
   * route onward FROM this same message id. One turn, one message, one #N —
   * no separate reply message ever exists.
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
    const body = completion.final_text ?? '';
    // harn:assume substantive-routing-excludes-acknowledgements ref=exact-ack-finalization
    const ack = completion.status === 'completed' && body.trim() === '<ACK_OK>';
    const parsed = ack
      ? { mentions: [], refs: [], ledger_refs: [], unresolved: [] }
      : parseBody(body, this.store.listMembers(room));
    const messagePatch = {
      body,
      ...(ack && { ack: true as const }),
      mentions: parsed.mentions,
      refs: parsed.refs,
      ledger_refs: parsed.ledger_refs,
      run: {
        ...runMsg.run!,
        status: completion.status,
        ended_ts: new Date().toISOString(),
        stalled_since: undefined,
        tool_calls: toolCalls,
        usage: completion.usage,
        final_text: completion.final_text,
      },
    } satisfies Parameters<Store['completeTurn']>[1]['message'];
    // harn:end substantive-routing-excludes-acknowledgements
    const finalizedDraft: Message = { ...runMsg, ...messagePatch };
    const lastDelivery = batch.at(-1);
    const triggerAuthor = lastDelivery
      ? this.store.getMessage(room, lastDelivery.message_id)?.author
      : undefined;
    // harn:assume batched-human-resets-hop-count ref=batched-onward-hop-reset
    const onwardHopCount = batch.length === 0
      ? 1
      : Math.min(...batch.map((delivery) => delivery.hop_count ?? 0)) + 1;
    // harn:end batched-human-resets-hop-count
    const { result, fanout } = this.planFanout(
      room,
      finalizedDraft,
      triggerAuthor,
      onwardHopCount,
    );
    const day = new Date().toISOString().slice(0, 10);
    const completed = this.store.completeTurn(room, {
      runMsgId,
      message: messagePatch,
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
        ...(result.misaddressed && { misaddressed: true }),
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
    });
    this.emitMessage(room, completed.message);
    this.emitMember(room, completed.member);
    // harn:assume extensions-retire-with-parent-run ref=parent-finalization-extension-sweep
    for (const extension of this.store.listMembers(room)) {
      if (extension.kind !== 'extension' || extension.parent !== memberId || extension.state !== 'running') continue;
      this.emitMember(room, this.store.updateMember(room, extension.id, { state: 'dead' }));
    }
    // harn:end extensions-retire-with-parent-run
    this.emit(room, { type: 'meter', seq: this.store.currentSeq(room), meter: completed.meter });
    for (const delivery of completed.deliveries) {
      const recipient = this.store.getMember(room, delivery.recipient);
      if (recipient?.kind === 'human') this.emitInbox(room, delivery);
      else if (recipient?.kind === 'agent') this.dispatchAgentDelivery(room, delivery, recipient);
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
  // harn:end reply-is-finalized-run-message

  // ── interactions (PROTOCOL §2 state machine) ──────────────────────────

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
          this.store.upsertInteraction({ ...updated, state: 'orphaned' });
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
    const answered = this.store.upsertInteraction({
      ...interaction,
      state: 'answered',
      answer,
      answered_by: by,
      answered_ts: new Date().toISOString(),
    });
    // Audit reply on the card — reply_to a card NEVER routes (gate).
    const audit = this.store.postMessage(room, {
      author: by,
      kind: 'chat',
      body: typeof answer === 'string' ? answer : JSON.stringify(answer),
      reply_to: interaction.message_id,
    });
    this.emitMessage(room, audit);
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
          this.finalizeTurn(
            room.id,
            member.id,
            runMsgId,
            { status: completed.status, final_text: completed.final_text, usage: completed.usage },
            group,
            toolCalls,
          );
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
      // drain anything still queued (tracked — a turn may block on an ask)
      for (const member of this.store.listMembers(room.id)) {
        if (member.kind === 'agent') this.track(this.maybeStartTurn(room.id, member.id));
      }
    }
  }
  // harn:end delivery-attempt-wal-reconcile

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
      this.store.upsertInteraction({ ...interaction, state: 'orphaned' });
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

  unreadCount(room: string, memberId: string): number {
    return this.store
      .listDeliveries(room, { recipient: memberId })
      .filter((d) => d.read_ts === undefined && d.state === 'consumed').length;
  }

  /** Delta-sync straight off the change log, redacted like every fanout. */
  sync(room: string, sinceSeq: number): ReturnType<Store['sync']> {
    return this.project(room, this.store.sync(room, sinceSeq));
  }

  readRunBlob(room: string, msgId: number): WireEvent[] {
    const message = this.store.getMessage(room, msgId);
    if (!message?.run) return [];
    return this.project(room, this.blobs.read(room, message.run.events_ref));
  }
}
