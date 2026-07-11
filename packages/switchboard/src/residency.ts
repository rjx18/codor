import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import type {
  HarnessAdapter,
  Member,
  Session,
  WireEvent,
} from '@codor/protocol';

import { BlobStore } from './blobs.js';
import type { HyperswarmTransport, RunEventPayload } from './transport/hyperswarm.js';
import type { TransportEnvelope } from './transport/peer.js';

type AttemptState = 'accepted' | 'started' | 'completed' | 'ambiguous';

export interface ResidentMember {
  id: string;
  harness: string;
  cwd: string;
  policy?: string;
  session_ref?: string;
}

export interface ResidentDeliveryRequest {
  rpc_id: string;
  room: string;
  member: ResidentMember;
  payload: string;
  trigger_msg: number;
}

export interface ResidentAttempt {
  home_peer: string;
  rpc_id: string;
  room: string;
  member: ResidentMember;
  payload: string;
  trigger_msg: number;
  state: AttemptState;
  attempt_count: number;
  events_ref: string;
  acked_event_index: number;
  session_ref?: string;
}

interface AttemptRow {
  home_peer: string;
  rpc_id: string;
  room: string;
  member_json: string;
  payload: string;
  trigger_msg: number;
  state: AttemptState;
  attempt_count: number;
  events_ref: string;
  acked_event_index: number;
  session_ref: string | null;
}

interface ReconcileRequest {
  rpc_id: string;
  last_event_index: number;
}

interface ResidentOutcome {
  rpc_id: string;
  outcome: 'completed' | 'never_started' | 'ambiguous';
  events?: { event_index: number; event: WireEvent }[];
  session_ref?: string;
}

export type ResidencyBoundary =
  | 'resident_event_sent'
  | 'home_complete_before_event_ack';

export interface ResidencyCoordinatorOptions {
  transport: HyperswarmTransport;
  adapters: HarnessAdapter[];
  journalPath: string;
  blobRoot: string;
  completionAckRetryMs?: number;
  maxPendingCompletionAcks?: number;
  boundaryHook?: (
    boundary: ResidencyBoundary,
    detail: { rpc_id: string; event_index: number; event: WireEvent },
  ) => void;
}

export interface RemoteDeliverHooks {
  onSessionRef?(sessionRef: string): void;
  lastEventIndex?: number;
}

export class RemoteAttemptAmbiguousError extends Error {
  constructor(readonly rpcId: string) {
    super(`resident attempt ${rpcId} is ambiguous`);
  }
}

function attemptFromRow(row: AttemptRow): ResidentAttempt {
  return {
    home_peer: row.home_peer,
    rpc_id: row.rpc_id,
    room: row.room,
    member: JSON.parse(row.member_json) as ResidentMember,
    payload: row.payload,
    trigger_msg: row.trigger_msg,
    state: row.state,
    attempt_count: row.attempt_count,
    events_ref: row.events_ref,
    acked_event_index: row.acked_event_index,
    session_ref: row.session_ref ?? undefined,
  };
}

function safeRpcRef(homePeer: string, rpcId: string): string {
  const source = Buffer.from(`${homePeer}\0${rpcId}`, 'utf8');
  return `resident/${source.toString('base64url')}.jsonl`;
}

// harn:assume resident-attempt-journal-reconciles ref=resident-attempt-wal
export class ResidentAttemptJournal {
  private readonly db: Database.Database;
  private readonly blobs: BlobStore;

  constructor(path: string, blobRoot: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.blobs = new BlobStore(blobRoot);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resident_attempts (
        home_peer TEXT NOT NULL,
        rpc_id TEXT NOT NULL,
        room TEXT NOT NULL,
        member_json TEXT NOT NULL,
        payload TEXT NOT NULL,
        trigger_msg INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        events_ref TEXT NOT NULL,
        acked_event_index INTEGER NOT NULL DEFAULT -1,
        session_ref TEXT,
        PRIMARY KEY (home_peer, rpc_id)
      )
    `);
  }

  get(homePeer: string, rpcId: string): ResidentAttempt | undefined {
    const row = this.db.prepare(
      'SELECT * FROM resident_attempts WHERE home_peer = ? AND rpc_id = ?',
    ).get(homePeer, rpcId) as AttemptRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  ensure(homePeer: string, request: ResidentDeliveryRequest): ResidentAttempt {
    const existing = this.get(homePeer, request.rpc_id);
    if (existing) {
      if (
        existing.room !== request.room ||
        existing.member.id !== request.member.id ||
        existing.payload !== request.payload
      ) {
        throw new Error(`rpc_id ${request.rpc_id} was reused with different input`);
      }
      return existing;
    }
    const eventsRef = safeRpcRef(homePeer, request.rpc_id);
    this.db.prepare(
      `INSERT INTO resident_attempts
       (home_peer, rpc_id, room, member_json, payload, trigger_msg, state,
        attempt_count, events_ref, acked_event_index, session_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?, -1, ?)`,
    ).run(
      homePeer,
      request.rpc_id,
      request.room,
      JSON.stringify(request.member),
      request.payload,
      request.trigger_msg,
      eventsRef,
      request.member.session_ref ?? null,
    );
    return this.get(homePeer, request.rpc_id)!;
  }

  begin(homePeer: string, rpcId: string): ResidentAttempt {
    this.db.prepare(
      `UPDATE resident_attempts SET attempt_count = attempt_count + 1
       WHERE home_peer = ? AND rpc_id = ?`,
    ).run(homePeer, rpcId);
    return this.get(homePeer, rpcId)!;
  }

  setState(homePeer: string, rpcId: string, state: AttemptState): ResidentAttempt {
    this.db.prepare(
      'UPDATE resident_attempts SET state = ? WHERE home_peer = ? AND rpc_id = ?',
    ).run(state, homePeer, rpcId);
    return this.get(homePeer, rpcId)!;
  }

  setSessionRef(homePeer: string, rpcId: string, sessionRef: string): void {
    this.db.prepare(
      'UPDATE resident_attempts SET session_ref = ? WHERE home_peer = ? AND rpc_id = ?',
    ).run(sessionRef, homePeer, rpcId);
  }

  appendEvent(homePeer: string, rpcId: string, event: WireEvent): number {
    const attempt = this.get(homePeer, rpcId);
    if (!attempt) throw new Error(`no resident attempt ${rpcId}`);
    const eventIndex = this.events(attempt).length;
    this.blobs.append('resident', attempt.events_ref, event);
    return eventIndex;
  }

  events(attempt: ResidentAttempt): WireEvent[] {
    return this.blobs.read('resident', attempt.events_ref);
  }

  acknowledge(homePeer: string, rpcId: string, eventIndex: number): void {
    this.db.prepare(
      `UPDATE resident_attempts
       SET acked_event_index = MAX(acked_event_index, ?)
       WHERE home_peer = ? AND rpc_id = ?`,
    ).run(eventIndex, homePeer, rpcId);
  }

  close(): void {
    this.db.close();
  }
}

class RemoteEventStream implements AsyncIterable<WireEvent> {
  private readonly events: WireEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private ended = false;
  private failure: Error | undefined;

  push(event: WireEvent): void {
    this.events.push(event);
    this.wake();
  }

  complete(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WireEvent> {
    for (;;) {
      while (this.cursor < this.events.length) yield this.events[this.cursor++]!;
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
}

interface PendingRemote {
  host: string;
  request: ResidentDeliveryRequest;
  stream: RemoteEventStream;
  nextEventIndex: number;
  buffered: Map<number, WireEvent>;
  retries: number;
  hooks: RemoteDeliverHooks;
}

export class ResidencyCoordinator {
  readonly journal: ResidentAttemptJournal;
  private readonly transport: HyperswarmTransport;
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly sessions = new Map<string, Session>();
  private readonly activeResidentAttempts = new Set<string>();
  private readonly pendingHomeAttempts = new Map<string, PendingRemote>();
  private readonly completedHomeIndexes = new Map<string, { host: string; room: string; index: number }>();
  private readonly maxPendingCompletionAcks: number;
  private readonly completionAckTimer: NodeJS.Timeout;
  private readonly reachabilityHandlers = new Set<(peerId: string, connected: boolean) => void>();
  private readonly stopEnvelope: () => void;
  private readonly stopPeerState: () => void;
  private closed = false;

  constructor(private readonly options: ResidencyCoordinatorOptions) {
    this.transport = options.transport;
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter);
    this.journal = new ResidentAttemptJournal(options.journalPath, options.blobRoot);
    this.maxPendingCompletionAcks = options.maxPendingCompletionAcks ?? 1_024;
    if (!Number.isSafeInteger(this.maxPendingCompletionAcks) || this.maxPendingCompletionAcks < 1) {
      throw new Error('maxPendingCompletionAcks must be a positive integer');
    }
    const retryMs = options.completionAckRetryMs ?? 1_000;
    if (!Number.isSafeInteger(retryMs) || retryMs < 1) {
      throw new Error('completionAckRetryMs must be a positive integer');
    }
    this.completionAckTimer = setInterval(() => this.retryCompletionAcks(), retryMs);
    this.completionAckTimer.unref();
    this.stopEnvelope = this.transport.onEnvelope((envelope, peerId) =>
      this.handleEnvelope(envelope, peerId));
    this.stopPeerState = this.transport.onPeerState((peerId, connected) =>
      this.handlePeerState(peerId, connected));
  }

  // harn:assume adapter-registry-sole-harness-source ref=resident-registry-observability
  registeredAdapters(): { id: string; capabilities: HarnessAdapter['capabilities'] }[] {
    return [...this.adapters.values()]
      .map((adapter) => ({ id: adapter.id, capabilities: adapter.capabilities }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  // harn:end adapter-registry-sole-harness-source

  isReachable(peerId: string): boolean {
    return this.transport.peerIds().includes(peerId);
  }

  onReachability(handler: (peerId: string, connected: boolean) => void): () => void {
    this.reachabilityHandlers.add(handler);
    return () => this.reachabilityHandlers.delete(handler);
  }

  deliver(host: string, request: ResidentDeliveryRequest, hooks: RemoteDeliverHooks = {}): AsyncIterable<WireEvent> {
    if (!this.isReachable(host)) throw new Error(`resident ${host} is unreachable`);
    const existing = this.pendingHomeAttempts.get(request.rpc_id);
    if (existing) return existing.stream;
    const outstandingForHost = [...this.completedHomeIndexes.values()]
      .filter((completion) => completion.host === host).length +
      [...this.pendingHomeAttempts.values()].filter((pending) => pending.host === host).length;
    if (outstandingForHost >= this.maxPendingCompletionAcks) {
      throw new Error(`resident ${host} has too many completion acknowledgements in flight`);
    }
    const pending: PendingRemote = {
      host,
      request,
      stream: new RemoteEventStream(),
      nextEventIndex: (hooks.lastEventIndex ?? -1) + 1,
      buffered: new Map(),
      retries: 0,
      hooks,
    };
    this.pendingHomeAttempts.set(request.rpc_id, pending);
    this.sendDelivery(pending);
    return pending.stream;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopEnvelope();
    this.stopPeerState();
    clearInterval(this.completionAckTimer);
    for (const [key, session] of this.sessions) {
      const harness = key.split('\0').at(-1)!;
      this.adapters.get(harness)?.interrupt(session);
    }
    for (const pending of this.pendingHomeAttempts.values()) {
      pending.stream.fail(new RemoteAttemptAmbiguousError(pending.request.rpc_id));
    }
    this.journal.close();
  }

  private async handleEnvelope(envelope: TransportEnvelope, peerId: string): Promise<void> {
    if (envelope.kind === 'resident_deliver') {
      this.acceptResidentDelivery(peerId, envelope.payload as ResidentDeliveryRequest);
    } else if (envelope.kind === 'resident_reconcile') {
      this.reconcileResident(peerId, envelope.room, envelope.payload as { attempts: ReconcileRequest[] });
    } else if (envelope.kind === 'resident_outcome') {
      this.handleOutcome(peerId, envelope.room, envelope.payload as ResidentOutcome);
    } else if (envelope.kind === 'run_event') {
      this.handleRemoteEvent(peerId, envelope.room, envelope.payload as RunEventPayload);
    } else if (envelope.kind === 'run_event_ack') {
      const ack = envelope.payload as { rpc_id: string; event_index: number };
      this.journal.acknowledge(peerId, ack.rpc_id, ack.event_index);
      const attempt = this.journal.get(peerId, ack.rpc_id);
      if (attempt?.state === 'completed') {
        const finalIndex = this.journal.events(attempt).length - 1;
        if (finalIndex >= 0 && ack.event_index >= finalIndex) {
          try {
            this.transport.send(peerId, {
              room: attempt.room,
              kind: 'resident_completion_ack',
              payload: { rpc_id: ack.rpc_id, event_index: finalIndex },
            });
          } catch {
            // The home retries the terminal event ack until this reply is delivered.
          }
        }
      }
    } else if (envelope.kind === 'resident_completion_ack') {
      const ack = envelope.payload as { rpc_id?: unknown; event_index?: unknown };
      if (typeof ack.rpc_id !== 'string' || !Number.isSafeInteger(ack.event_index)) return;
      const completed = this.completedHomeIndexes.get(ack.rpc_id);
      if (completed?.host === peerId && completed.index === ack.event_index) {
        this.completedHomeIndexes.delete(ack.rpc_id);
      }
    } else if (envelope.kind === 'resident_session') {
      // harn:assume resident-session-updates-host-bound ref=resident-session-host-binding
      const session = envelope.payload as { rpc_id?: unknown; session_ref?: unknown };
      if (
        typeof session.rpc_id !== 'string' ||
        typeof session.session_ref !== 'string' ||
        session.session_ref.length === 0
      ) return;
      const pending = this.pendingHomeAttempts.get(session.rpc_id);
      if (
        !pending ||
        pending.host !== peerId ||
        pending.request.room !== envelope.room
      ) return;
      pending.hooks.onSessionRef?.(session.session_ref);
      // harn:end resident-session-updates-host-bound
    }
  }

  private handlePeerState(peerId: string, connected: boolean): void {
    for (const handler of this.reachabilityHandlers) handler(peerId, connected);
    if (!connected) return;
    this.retryCompletionAcks(peerId);
    const attempts = [...this.pendingHomeAttempts.values()]
      .filter((pending) => pending.host === peerId)
      .map((pending) => ({
        rpc_id: pending.request.rpc_id,
        last_event_index: pending.nextEventIndex - 1,
      }));
    if (attempts.length > 0) {
      this.transport.send(peerId, {
        room: '',
        kind: 'resident_reconcile',
        payload: { attempts },
      });
    }
  }

  private sendDelivery(pending: PendingRemote): void {
    this.transport.send(pending.host, {
      room: pending.request.room,
      kind: 'resident_deliver',
      payload: pending.request,
    });
  }

  private acceptResidentDelivery(homePeer: string, request: ResidentDeliveryRequest): void {
    const attempt = this.journal.ensure(homePeer, request);
    const key = this.attemptKey(homePeer, request.rpc_id);
    if (attempt.state === 'completed') {
      this.sendOutcome(homePeer, attempt, 'completed', -1);
      return;
    }
    if (attempt.state === 'ambiguous' || (attempt.state === 'started' && !this.activeResidentAttempts.has(key))) {
      this.sendOutcome(homePeer, attempt, 'ambiguous', -1);
      return;
    }
    if (this.activeResidentAttempts.has(key)) return;
    if (attempt.attempt_count >= 2) {
      this.journal.setState(homePeer, request.rpc_id, 'ambiguous');
      this.sendOutcome(homePeer, attempt, 'ambiguous', -1);
      return;
    }
    this.activeResidentAttempts.add(key);
    void this.runResidentAttempt(homePeer, request).finally(() => {
      this.activeResidentAttempts.delete(key);
    });
  }

  private async runResidentAttempt(homePeer: string, request: ResidentDeliveryRequest): Promise<void> {
    const attempt = this.journal.begin(homePeer, request.rpc_id);
    const adapter = this.adapters.get(request.member.harness);
    if (!adapter) {
      this.journal.setState(homePeer, request.rpc_id, 'ambiguous');
      this.sendOutcome(homePeer, attempt, 'ambiguous', -1);
      return;
    }
    const sessionKey = `${homePeer}\0${request.member.id}\0${adapter.id}`;
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = request.member.session_ref && adapter.capabilities.resume
        ? adapter.attach(request.member.session_ref)
        : adapter.spawn({ cwd: request.member.cwd, policy: request.member.policy });
      session.cwd = request.member.cwd;
      session.policy = request.member.policy;
      this.sessions.set(sessionKey, session);
    }
    let started = false;
    let completed = false;
    try {
      for await (const event of adapter.deliver(session, request.payload, {
        onStarted: () => {
          started = true;
          this.journal.setState(homePeer, request.rpc_id, 'started');
          this.emitResidentEvent(homePeer, request, {
            type: 'run.started',
            member: request.member.id,
            trigger_msg: request.trigger_msg,
          });
        },
        onSessionRef: (sessionRef) => {
          this.journal.setSessionRef(homePeer, request.rpc_id, sessionRef);
          this.transport.send(homePeer, {
            room: request.room,
            kind: 'resident_session',
            payload: { rpc_id: request.rpc_id, session_ref: sessionRef },
          });
        },
      })) {
        this.emitResidentEvent(homePeer, request, event);
        if (event.type === 'run.completed') completed = true;
      }
      if (completed) {
        this.journal.setState(homePeer, request.rpc_id, 'completed');
      } else if (started || this.journal.events(this.journal.get(homePeer, request.rpc_id)!).length > 0) {
        const ambiguous = this.journal.setState(homePeer, request.rpc_id, 'ambiguous');
        this.sendOutcome(homePeer, ambiguous, 'ambiguous', -1);
      } else if (attempt.attempt_count >= 2) {
        const ambiguous = this.journal.setState(homePeer, request.rpc_id, 'ambiguous');
        this.sendOutcome(homePeer, ambiguous, 'ambiguous', -1);
      } else {
        const neverStarted = this.journal.setState(homePeer, request.rpc_id, 'accepted');
        this.sendOutcome(homePeer, neverStarted, 'never_started', -1);
      }
    } catch {
      const current = this.journal.get(homePeer, request.rpc_id)!;
      if (!started && this.journal.events(current).length === 0 && current.attempt_count < 2) {
        this.journal.setState(homePeer, request.rpc_id, 'accepted');
        this.sendOutcome(homePeer, current, 'never_started', -1);
      } else {
        const ambiguous = this.journal.setState(homePeer, request.rpc_id, 'ambiguous');
        this.sendOutcome(homePeer, ambiguous, 'ambiguous', -1);
      }
    }
  }

  private emitResidentEvent(homePeer: string, request: ResidentDeliveryRequest, event: WireEvent): void {
    const eventIndex = this.journal.appendEvent(homePeer, request.rpc_id, event);
    this.transport.sendRunEvent(homePeer, request.room, {
      rpc_id: request.rpc_id,
      event_index: eventIndex,
      event,
    });
    this.options.boundaryHook?.('resident_event_sent', {
      rpc_id: request.rpc_id,
      event_index: eventIndex,
      event,
    });
  }

  private reconcileResident(homePeer: string, room: string, payload: { attempts: ReconcileRequest[] }): void {
    for (const requested of payload.attempts) {
      const attempt = this.journal.get(homePeer, requested.rpc_id);
      if (!attempt) {
        this.transport.send(homePeer, {
          room,
          kind: 'resident_outcome',
          payload: { rpc_id: requested.rpc_id, outcome: 'never_started' } satisfies ResidentOutcome,
        });
        continue;
      }
      const key = this.attemptKey(homePeer, requested.rpc_id);
      if (attempt.state === 'completed') {
        this.sendOutcome(homePeer, attempt, 'completed', requested.last_event_index);
      } else if (attempt.state === 'accepted' && this.journal.events(attempt).length === 0) {
        this.sendOutcome(homePeer, attempt, 'never_started', requested.last_event_index);
      } else if (!this.activeResidentAttempts.has(key)) {
        this.sendOutcome(homePeer, attempt, 'ambiguous', requested.last_event_index);
      }
    }
  }

  private sendOutcome(
    homePeer: string,
    attempt: ResidentAttempt,
    outcome: ResidentOutcome['outcome'],
    lastEventIndex: number,
  ): void {
    const events = outcome === 'completed'
      ? this.journal.events(attempt).flatMap((event, eventIndex) =>
          eventIndex > lastEventIndex ? [{ event_index: eventIndex, event }] : [])
      : undefined;
    this.transport.send(homePeer, {
      room: attempt.room,
      kind: 'resident_outcome',
      payload: {
        rpc_id: attempt.rpc_id,
        outcome,
        events,
        session_ref: attempt.session_ref,
      } satisfies ResidentOutcome,
    });
  }

  private handleOutcome(peerId: string, room: string, outcome: ResidentOutcome): void {
    const pending = this.pendingHomeAttempts.get(outcome.rpc_id);
    if (!pending || pending.host !== peerId) return;
    outcome.session_ref && pending.hooks.onSessionRef?.(outcome.session_ref);
    if (outcome.outcome === 'completed') {
      for (const indexed of outcome.events ?? []) {
        this.handleRemoteEvent(peerId, room, {
          rpc_id: outcome.rpc_id,
          event_index: indexed.event_index,
          event: indexed.event,
        });
      }
    } else if (outcome.outcome === 'never_started' && pending.retries < 1) {
      pending.retries += 1;
      this.sendDelivery(pending);
    } else {
      pending.stream.fail(new RemoteAttemptAmbiguousError(outcome.rpc_id));
      this.pendingHomeAttempts.delete(outcome.rpc_id);
    }
  }

  private handleRemoteEvent(peerId: string, room: string, payload: RunEventPayload): void {
    const pending = this.pendingHomeAttempts.get(payload.rpc_id);
    if (!pending || pending.host !== peerId) {
      const completed = this.completedHomeIndexes.get(payload.rpc_id);
      if (completed?.host === peerId && payload.event_index <= completed.index) {
        this.sendCompletionEventAck(payload.rpc_id, completed);
      }
      return;
    }
    if (payload.event_index < pending.nextEventIndex) {
      try {
        this.transport.sendRunEventAck(peerId, room, payload.rpc_id, pending.nextEventIndex - 1);
      } catch {
        // Reconnect reconciliation resends the indexed event and recovers the ack.
      }
      return;
    }
    pending.buffered.set(payload.event_index, payload.event as WireEvent);
    let completed: { event_index: number; event: WireEvent } | undefined;
    while (pending.buffered.has(pending.nextEventIndex)) {
      const eventIndex = pending.nextEventIndex;
      const event = pending.buffered.get(eventIndex)!;
      pending.buffered.delete(eventIndex);
      pending.nextEventIndex += 1;
      pending.stream.push(event);
      if (event.type === 'run.completed') completed = { event_index: eventIndex, event };
    }
    if (completed) {
      this.options.boundaryHook?.('home_complete_before_event_ack', {
        rpc_id: payload.rpc_id,
        event_index: completed.event_index,
        event: completed.event,
      });
    }
    if (completed) {
      const completion = { host: peerId, room, index: completed.event_index };
      this.completedHomeIndexes.set(payload.rpc_id, completion);
      this.sendCompletionEventAck(payload.rpc_id, completion);
      pending.stream.complete();
      this.pendingHomeAttempts.delete(payload.rpc_id);
    } else {
      try {
        this.transport.sendRunEventAck(peerId, room, payload.rpc_id, pending.nextEventIndex - 1);
      } catch {
        // Reconnect reconciliation resends the indexed event and recovers the ack.
      }
    }
  }

  pendingCompletionAckCount(host?: string): number {
    return [...this.completedHomeIndexes.values()]
      .filter((completion) => host === undefined || completion.host === host).length;
  }

  private sendCompletionEventAck(
    rpcId: string,
    completion: { host: string; room: string; index: number },
  ): void {
    if (!this.isReachable(completion.host)) return;
    try {
      this.transport.sendRunEventAck(
        completion.host,
        completion.room,
        rpcId,
        completion.index,
      );
    } catch {
      // The retry timer or peer reconnect repeats this exact terminal ack.
    }
  }

  private retryCompletionAcks(host?: string): void {
    for (const [rpcId, completion] of this.completedHomeIndexes) {
      if (host !== undefined && completion.host !== host) continue;
      this.sendCompletionEventAck(rpcId, completion);
    }
  }

  private attemptKey(homePeer: string, rpcId: string): string {
    return `${homePeer}\0${rpcId}`;
  }
}
// harn:end resident-attempt-journal-reconciles

export function remoteMemberSpec(member: Member): ResidentMember {
  if (!member.harness || !member.cwd) throw new Error(`remote member @${member.handle} lacks harness or cwd`);
  return {
    id: member.id,
    harness: member.harness,
    cwd: member.cwd,
    policy: member.policy,
    session_ref: member.session_ref,
  };
}
