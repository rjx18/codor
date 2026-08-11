import type { Room, RoomSummary, ServerFrame } from '@codor/protocol';

import {
  forgetPairedComputer,
  adoptPairedComputerHostname,
  listPairedComputers,
  loadHostedComputerMaterials,
  openBrowserDeviceSessionWith,
  pairThroughRelay,
  relayAccessOrigin,
  renamePairedComputer,
  setActiveBrowserAccessToken,
  switchComputer,
  type HostedComputerMaterial,
  type BrowserDeviceSession,
} from '@runtime/crypto.js';
import { setRelayTransport } from '@runtime/relay-transport.js';
import { TunnelClient, type TunnelState, type TunnelStateListener } from '@runtime/relay.js';
import { setActiveComputer } from '@runtime/active-computer.js';

import { createConnector, type ConnectorOptions, type RoomConnector } from './connector.js';
import { requireBrowserUpgrade } from './compatibility.js';
import { forgetRoom, rememberedRoom, rememberRoom, resolveStartupRoom } from './startup.js';
import { createClientStore, mirrorClientStore, type ClientStore } from './store.js';
import { refreshMutableRunJournals } from '../room/run-journals.js';
import {
  finalizedTranscriptRoots,
  refreshTranscriptHistoryHead,
} from '../room/transcript-history.js';
import {
  deleteLastGoodRoom,
  hydrateLastGoodRoom,
  loadLastGoodRoom,
  saveLastGoodRoom,
  snapshotLastGoodRoom,
} from '../runtime/last-good-room.js';

export interface ComputerActivitySummary {
  connected: boolean;
  unread: number;
  attention: boolean;
  working: number;
}

export interface ComputerSessionView extends ComputerActivitySummary {
  id: string;
  label: string;
  active: boolean;
  ready: boolean;
  /** Positive device-auth refusal evidence; unlike a quiet disconnect this needs repair. */
  authRefused: boolean;
}

export interface ComputerSessionsSnapshot {
  activeId?: string;
  computers: ComputerSessionView[];
}

export interface ActiveComputerSession {
  id: string;
  room: string;
  token: string;
  connector: RoomConnector;
}

interface SessionTunnel {
  readonly state: TunnelState;
  readonly generation: number;
  connect(): void;
  recover(): void;
  whenReady(): Promise<number>;
  subscribe(listener: TunnelStateListener): () => void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  socketFactory(url: string): WebSocket;
  dispose(): void;
}

interface SessionEntry {
  material: HostedComputerMaterial;
  tunnel: SessionTunnel;
  store: ClientStore;
  token: string;
  connector?: RoomConnector;
  cachedConnector?: RoomConnector;
  /** The session's remembered PUBLIC root. The warm connector may have a
   *  hidden registered child selected as its current conversation; that
   *  selection is conversation-local and must never replace this root. */
  publicRoot?: string;
  upgrade?: Extract<ServerFrame, { type: 'upgrade_required' }>;
  noRooms?: boolean;
  disposed: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  cachedReady: Promise<void>;
  resolveCachedReady: () => void;
  cacheRevision?: string;
  cacheWrite: Promise<void>;
  stopStore: () => void;
  stopTunnel: () => void;
}

export interface ComputerSessionDeps {
  load(): Promise<{ materials: HostedComputerMaterial[]; activeId?: string }>;
  makeTunnel(material: HostedComputerMaterial): SessionTunnel;
  authenticate(material: HostedComputerMaterial, tunnel: SessionTunnel, signal?: AbortSignal): Promise<BrowserDeviceSession>;
  loadRooms(token: string, tunnel: SessionTunnel, signal?: AbortSignal): Promise<RoomSummary[]>;
  makeConnector(options: ConnectorOptions): RoomConnector;
  switchStored(id: string): Promise<void>;
  pair(code: string, relayUrl: string): Promise<void>;
  forget(id: string): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  adoptHostname(id: string, hostname: string): Promise<HostedComputerMaterial['computer'] | undefined>;
  sleep(ms: number): Promise<void>;
}

const defaultDeps: ComputerSessionDeps = {
  load: async () => {
    const materials = await loadHostedComputerMaterials();
    const index = await listPairedComputers();
    return { materials, activeId: index.active_id };
  },
  makeTunnel: (material) => new TunnelClient(material.relay),
  authenticate: (material, tunnel, signal) => openBrowserDeviceSessionWith(
    material.switchboard,
    (input, init) => tunnel.fetch(input, { ...init, signal }),
    relayAccessOrigin(material.relay.relay_url),
  ),
  loadRooms: async (token, tunnel, signal) => {
    const headers = { authorization: `Bearer ${token}` };
    const summaryResponse = await tunnel.fetch('/api/rooms/summary?read_state=durable', { headers, signal });
    if (summaryResponse.ok) {
      return ((await summaryResponse.json()) as { rooms: RoomSummary[] }).rooms;
    }
    const roomsResponse = await tunnel.fetch('/api/rooms', { headers, signal });
    if (!roomsResponse.ok) throw new Error(`Channel list failed: ${String(roomsResponse.status)}`);
    return ((await roomsResponse.json()) as { rooms: Room[] }).rooms.map((room) => ({
      id: room.id,
      name: room.name,
      created_ts: room.created_ts,
      color: room.config.color,
      working: false,
      attention: false,
      unread: 0,
    }));
  },
  makeConnector: createConnector,
  switchStored: switchComputer,
  pair: pairThroughRelay,
  forget: forgetPairedComputer,
  rename: renamePairedComputer,
  adoptHostname: adoptPairedComputerHostname,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const bootWaitMs = (): number =>
  (typeof window !== 'undefined' && (window as unknown as { __CODOR_SESSION_BOOT_MS?: number }).__CODOR_SESSION_BOOT_MS)
  || 8_000;

const requestDeadlineMs = (): number =>
  (typeof window !== 'undefined' && (window as unknown as { __CODOR_SESSION_REQUEST_MS?: number }).__CODOR_SESSION_REQUEST_MS)
  || 8_000;

// harn:assume hosted-app-keeps-all-paired-computers-live ref=computer-session-lifecycle
/** Hosted-only, per-tab composition. It owns one existing tunnel, signed device
 *  session, isolated store and existing connector for every indexed computer. */
export class ComputerSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly listeners = new Set<() => void>();
  private activeId?: string;
  private startupExplicitRoom?: string;
  private snapshot: ComputerSessionsSnapshot = { computers: [] };
  private disposed = false;

  constructor(private readonly deps: ComputerSessionDeps = defaultDeps) {}

  async start(): Promise<boolean> {
    // Capture the navigation intent before an optional cached projection can
    // render and canonicalize its own room into the URL. Live room discovery
    // remains authoritative about whether this requested room is valid.
    this.startupExplicitRoom = typeof window === 'undefined'
      ? undefined
      : new URLSearchParams(window.location.search).get('room') ?? undefined;
    const loaded = await this.deps.load();
    if (loaded.materials.length === 0) return false;
    this.activeId = loaded.materials.some((material) => material.computer.id === loaded.activeId)
      ? loaded.activeId
      : loaded.materials.at(-1)?.computer.id;
    for (const material of loaded.materials) this.startEntry(material);
    if (this.activeId !== undefined) await this.deps.switchStored(this.activeId);
    this.applyActiveRuntime();
    this.publish();

    const active = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (active) {
      await Promise.race([active.ready, active.cachedReady, this.deps.sleep(bootWaitMs())]);
      this.applyActiveRuntime();
    }
    return true;
  }

  getSnapshot = (): ComputerSessionsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  active(): ActiveComputerSession | undefined {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (!entry?.connector) return undefined;
    return {
      id: entry.material.computer.id,
      // The remembered room is the session's public root — never the hidden
      // child conversation its warm connector may currently have selected.
      room: entry.publicRoot ?? entry.connector.room(),
      token: entry.token,
      connector: entry.connector,
    };
  }

  renderableActive(): ActiveComputerSession | undefined {
    const live = this.active();
    if (live) return live;
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (!entry?.cachedConnector || !entry.publicRoot) return undefined;
    return {
      id: entry.material.computer.id,
      room: entry.publicRoot,
      token: '',
      connector: entry.cachedConnector,
    };
  }

  activeToken(): string {
    return this.activeId === undefined ? '' : this.entries.get(this.activeId)?.token ?? '';
  }

  activeHasNoRooms(): boolean {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    return entry?.noRooms === true && entry.token !== '';
  }

  activeTunnelState(): TunnelState | undefined {
    return this.activeId === undefined ? undefined : this.entries.get(this.activeId)?.tunnel.state;
  }

  activeConnectExtras(): { origin?: string; socketFactory?: (url: string) => WebSocket } {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (!entry) return {};
    return {
      origin: relayAccessOrigin(entry.material.relay.relay_url).replace(/^http/, 'ws'),
      socketFactory: entry.tunnel.socketFactory.bind(entry.tunnel),
    };
  }

  onActiveTunnelState(listener: (state: TunnelState) => void): () => void {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    return entry?.tunnel.subscribe((state) => listener(state)) ?? (() => undefined);
  }

  // harn:assume hosted-computer-switching-reuses-warm-session ref=warm-computer-activation
  async activate(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!this.usable(entry)) return false;
    await this.deps.switchStored(id);
    this.activeId = id;
    this.applyActiveRuntime();
    // Activation restores the session's PUBLIC root: the warm connector keeps
    // whatever hidden child it had selected only as conversation-local state,
    // and the remembered room is always the root.
    const publicRoot = entry.publicRoot ?? entry.connector?.room();
    if (entry.connector !== undefined && publicRoot !== undefined && entry.connector.room() !== publicRoot) {
      entry.connector.switchRoom(publicRoot);
    }
    if (publicRoot !== undefined) rememberRoom(publicRoot, id);
    if (entry.upgrade) requireBrowserUpgrade(entry.upgrade);
    this.publish();
    if (publicRoot !== undefined) {
      // harn:assume managed-computer-activation-revalidates-destination-history ref=destination-history-activation-refresh
      // Capture every ownership input before the controller's async boundary.
      // The controller keys requests by this concrete source store, so a later
      // mirror switch cannot redirect its merge into a same-named room.
      const destination = {
        computerId: entry.material.computer.id,
        store: entry.store,
        token: entry.token,
        room: publicRoot,
      };
      void refreshTranscriptHistoryHead(
        destination.store,
        destination.room,
        () => destination.token,
      );
      // harn:end managed-computer-activation-revalidates-destination-history
    }
    return entry.connector !== undefined;
  }
  // harn:end hosted-computer-switching-reuses-warm-session

  rememberActiveRoom(room: string): void {
    // Top-level switches name public roots only; keep both the durable
    // remembered room and this session's in-memory root in step.
    if (this.activeId === undefined) return;
    const entry = this.entries.get(this.activeId);
    if (entry) entry.publicRoot = room;
    rememberRoom(room, this.activeId);
  }

  async add(code: string, relayUrl: string): Promise<boolean> {
    const previous = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    await this.deps.pair(code, relayUrl);
    const loaded = await this.deps.load();
    for (const material of loaded.materials) {
      const existing = this.entries.get(material.computer.id);
      if (existing && this.sameTransport(existing.material, material)) existing.material = material;
      else {
        if (existing) this.disposeEntry(material.computer.id);
        this.startEntry(material);
      }
    }
    const added = loaded.activeId === undefined ? undefined : this.entries.get(loaded.activeId);
    if (!added) return this.restoreAfterFailedAdd(previous);
    await Promise.race([added.ready, this.deps.sleep(bootWaitMs())]);
    if (!this.usable(added)) return this.restoreAfterFailedAdd(previous);
    return this.activate(added.material.computer.id);
  }

  async forget(id: string): Promise<boolean> {
    const forgotten = this.entries.get(id);
    const wasActive = id === this.activeId;
    const fallback = wasActive
      ? [...this.entries.values()]
        .filter((entry) => entry.material.computer.id !== id && this.usable(entry))
        .sort((left, right) => Number(right.store.getState().connected) - Number(left.store.getState().connected))[0]
      : undefined;
    await this.deps.forget(id);
    this.disposeEntry(id);
    // Stop future store writes, drain the one serialized projection writer,
    // then delete. A pre-forget transaction must never finish afterward and
    // resurrect the addressed computer's snapshot.
    await forgotten?.cacheWrite.catch(() => undefined);
    await deleteLastGoodRoom(id);
    const loaded = await this.deps.load();
    if (loaded.materials.length === 0) {
      setRelayTransport(undefined);
      setActiveBrowserAccessToken('');
      setActiveComputer(undefined);
      this.activeId = undefined;
      this.snapshot = { computers: [] };
      return false;
    }
    for (const material of loaded.materials) {
      const existing = this.entries.get(material.computer.id);
      if (!existing) this.startEntry(material);
    }
    if (wasActive) {
      if (!fallback || !this.entries.has(fallback.material.computer.id)) return false;
      await this.deps.switchStored(fallback.material.computer.id);
      this.activeId = fallback.material.computer.id;
    }
    this.applyActiveRuntime();
    this.publish();
    return true;
  }

  async rename(id: string, label: string): Promise<void> {
    await this.deps.rename(id, label);
    const entry = this.entries.get(id);
    if (entry) entry.material = {
      ...entry.material,
      computer: { ...entry.material.computer, label, label_source: 'custom' },
    };
    this.publish();
  }

  async refresh(): Promise<void> {
    const loaded = await this.deps.load();
    const currentIds = new Set(loaded.materials.map((material) => material.computer.id));
    for (const id of this.entries.keys()) if (!currentIds.has(id)) this.disposeEntry(id);
    for (const material of loaded.materials) {
      const existing = this.entries.get(material.computer.id);
      if (existing && this.sameTransport(existing.material, material)) {
        existing.material = material;
      } else {
        if (existing) this.disposeEntry(material.computer.id);
        this.startEntry(material);
      }
    }
    this.activeId = loaded.activeId;
    this.applyActiveRuntime();
    this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.entries.keys()]) this.disposeEntry(id);
    this.listeners.clear();
  }

  // harn:assume hosted-app-streams-follow-tunnel-generations ref=generation-aware-computer-session
  // harn:assume hosted-computer-sessions-keep-state-isolated ref=per-computer-session-state
  private startEntry(material: HostedComputerMaterial): void {
    let resolveReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    let resolveCachedReady = (): void => undefined;
    const cachedReady = new Promise<void>((resolve) => { resolveCachedReady = resolve; });
    const store = createClientStore();
    const tunnel = this.deps.makeTunnel(material);
    const entry: SessionEntry = {
      material,
      tunnel,
      store,
      token: '',
      disposed: false,
      ready,
      resolveReady,
      cachedReady,
      resolveCachedReady,
      cacheWrite: Promise.resolve(),
      stopStore: () => undefined,
      stopTunnel: () => undefined,
    };
    entry.stopStore = store.subscribe(() => {
      this.persistEntrySnapshot(entry);
      this.publish();
    });
    entry.stopTunnel = tunnel.subscribe(() => this.publish());
    this.entries.set(material.computer.id, entry);
    tunnel.connect();
    void this.hydrateEntrySnapshot(entry);
    void this.completeEntry(entry);
  }

  // harn:assume hosted-last-good-room-cache-is-bounded-read-only-projection ref=hosted-last-good-room-lifecycle
  private async hydrateEntrySnapshot(entry: SessionEntry): Promise<void> {
    try {
      const snapshot = await loadLastGoodRoom(entry.material.computer.id);
      if (entry.disposed || entry.connector !== undefined || entry.noRooms === true || snapshot === undefined) return;
      hydrateLastGoodRoom(entry.store, snapshot);
      entry.publicRoot = snapshot.room.id;
      entry.cachedConnector = this.makeCachedConnector(entry);
      if (entry.material.computer.id === this.activeId) this.applyActiveRuntime();
      this.publish();
      entry.resolveCachedReady();
    } catch {
      // Optional local fallback must never block or fail live startup.
    }
  }

  private persistEntrySnapshot(entry: SessionEntry): void {
    if (entry.disposed || entry.token === '' || entry.publicRoot === undefined) return;
    const snapshot = snapshotLastGoodRoom(entry.material.computer.id, entry.store, entry.publicRoot);
    if (!snapshot) return;
    const revision = JSON.stringify({
      room: snapshot.room,
      summaries: snapshot.summaries,
      history: snapshot.history,
    });
    if (revision === entry.cacheRevision) return;
    entry.cacheRevision = revision;
    entry.cacheWrite = entry.cacheWrite
      .catch(() => undefined)
      .then(async () => await saveLastGoodRoom(snapshot))
      .catch(() => {
        if (entry.cacheRevision === revision) entry.cacheRevision = undefined;
      });
  }

  private makeCachedConnector(entry: SessionEntry): RoomConnector {
    let room = entry.publicRoot!;
    return {
      room: () => room,
      state: () => 'disconnected',
      post: () => undefined,
      act: () => undefined,
      disconnect: () => undefined,
      reconnect: () => entry.tunnel.recover(),
      switchRoom: (next) => {
        room = next;
        entry.store.getState().setActiveRoom(next);
      },
      setDesiredRooms: () => undefined,
      roomReadiness: () => 'offline',
      dispose: () => undefined,
    };
  }
  // harn:end hosted-last-good-room-cache-is-bounded-read-only-projection

  private async completeEntry(entry: SessionEntry): Promise<void> {
    let retryMs = 500;
    while (!this.disposed && !entry.disposed && !entry.connector) {
      try {
        const tunnelGeneration = await entry.tunnel.whenReady();
        // harn:assume hosted-bootstrap-requests-are-abortable-and-generation-bounded ref=bounded-managed-bootstrap-attempt
        const { token, rooms } = await this.withEntryDeadline(entry, tunnelGeneration, async (signal) => {
          const token = await this.refreshEntryToken(entry, signal);
          if (entry.tunnel.state !== 'connected' || entry.tunnel.generation !== tunnelGeneration) {
            throw new Error('stale tunnel generation after authentication');
          }
          return { token, rooms: await this.deps.loadRooms(token, entry.tunnel, signal) };
        });
        // harn:end hosted-bootstrap-requests-are-abortable-and-generation-bounded
        if (entry.tunnel.state !== 'connected' || entry.tunnel.generation !== tunnelGeneration) {
          throw new Error('stale tunnel generation after room loading');
        }
        entry.store.getState().setRoomSummaries(rooms);
        const explicit = entry.material.computer.id === this.activeId
          ? this.startupExplicitRoom
          : undefined;
        const room = resolveStartupRoom(rooms, {
          explicit,
          remembered: rememberedRoom(entry.material.computer.id),
        });
        if (room === undefined) {
          // Current authenticated truth is authoritative over an optional
          // projection. Withdraw it before publishing No Channels, and set the
          // marker first so an IndexedDB read already in flight cannot hydrate
          // the stale room after deletion.
          entry.noRooms = true;
          const cached = entry.cachedConnector;
          entry.cachedConnector = undefined;
          entry.publicRoot = undefined;
          cached?.dispose();
          forgetRoom(entry.material.computer.id);
          await entry.cacheWrite.catch(() => undefined);
          await deleteLastGoodRoom(entry.material.computer.id);
          if (entry.material.computer.id === this.activeId
            && (window as unknown as { __codor?: RoomConnector }).__codor === cached) {
            delete (window as unknown as { __codor?: RoomConnector }).__codor;
          }
          entry.resolveReady();
          this.publish();
          return;
        }
        // The startup resolution names a public root; it is the session's
        // remembered room regardless of which conversation gets selected later.
        entry.publicRoot = room;
        rememberRoom(room, entry.material.computer.id);
        entry.connector = this.deps.makeConnector({
          room,
          token,
          origin: relayAccessOrigin(entry.material.relay.relay_url).replace(/^http/, 'ws'),
          socketFactory: entry.tunnel.socketFactory.bind(entry.tunnel),
          store: entry.store,
          setToken: (next) => this.setEntryToken(entry, next),
          refreshToken: () => this.refreshEntryToken(entry),
          tunnel: entry.tunnel,
          onResume: (room) => {
            if (entry.material.computer.id === this.activeId) {
              // harn:assume missed-terminal-history-refreshes-through-combined-head ref=combined-history-resume
              void refreshTranscriptHistoryHead(entry.store, room, () => entry.token).then((refreshed) => {
                if (!refreshed || entry.material.computer.id !== this.activeId) return;
                refreshMutableRunJournals(
                  room,
                  () => entry.token,
                  finalizedTranscriptRoots(entry.store, room),
                );
              });
              // harn:end missed-terminal-history-refreshes-through-combined-head
            }
          },
          onUpgradeRequired: (frame) => {
            entry.upgrade = frame;
            if (entry.material.computer.id === this.activeId) requireBrowserUpgrade(frame);
            this.publish();
          },
          expose: false,
        });
        entry.cachedConnector = undefined;
        entry.resolveReady();
        if (entry.material.computer.id === this.activeId) this.applyActiveRuntime();
        this.publish();
        return;
      } catch {
        await this.deps.sleep(retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    }
  }
  // harn:end hosted-computer-sessions-keep-state-isolated
  // harn:end hosted-app-streams-follow-tunnel-generations

  private async refreshEntryToken(entry: SessionEntry, signal?: AbortSignal): Promise<string> {
    const session = await this.deps.authenticate(entry.material, entry.tunnel, signal);
    // harn:assume hosted-generated-computer-label-follows-authenticated-hostname ref=authenticated-computer-label
    if (session.hostname) {
      const computer = await this.deps.adoptHostname(entry.material.computer.id, session.hostname);
      if (computer) entry.material = { ...entry.material, computer };
    }
    // harn:end hosted-generated-computer-label-follows-authenticated-hostname
    return this.setEntryToken(entry, session.token);
  }

  private async withEntryDeadline<T>(
    entry: SessionEntry,
    generation: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        act();
      };
      const timer = setTimeout(() => {
        const error = new DOMException('Hosted bootstrap request timed out', 'TimeoutError');
        controller.abort(error);
        // Recovery advances/retains only this entry's tunnel generation and
        // rejects sibling work on the stale mux before the retry loop continues.
        if (entry.tunnel.generation === generation) entry.tunnel.recover();
        finish(() => reject(error));
      }, requestDeadlineMs());
      void work(controller.signal).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private setEntryToken(entry: SessionEntry, token: string): string {
    entry.token = token;
    if (entry.material.computer.id === this.activeId) setActiveBrowserAccessToken(token);
    this.publish();
    return token;
  }

  private applyActiveRuntime(): void {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (!entry) return;
    setActiveComputer(entry.material.computer.id);
    const origin = relayAccessOrigin(entry.material.relay.relay_url);
    setRelayTransport({ origin, fetch: entry.tunnel.fetch.bind(entry.tunnel) });
    setActiveBrowserAccessToken(entry.token);
    mirrorClientStore(entry.store);
    const connector = entry.connector ?? entry.cachedConnector;
    if (connector) {
      (window as unknown as { __codor?: RoomConnector }).__codor = connector;
    }
  }

  private disposeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.disposed = true;
    entry.stopStore();
    entry.stopTunnel();
    entry.connector?.dispose();
    entry.tunnel.dispose();
    this.entries.delete(id);
  }

  private sameTransport(left: HostedComputerMaterial, right: HostedComputerMaterial): boolean {
    return left.relay.session_id === right.relay.session_id
      && left.relay.client_static.pub === right.relay.client_static.pub
      && left.relay.host_static_pub === right.relay.host_static_pub
      && left.switchboard.device_id === right.switchboard.device_id
      && left.switchboard.sign_public_key === right.switchboard.sign_public_key;
  }

  private usable(entry: SessionEntry | undefined): entry is SessionEntry {
    return entry !== undefined && !entry.disposed && entry.connector !== undefined && entry.token !== '';
  }

  private async restoreAfterFailedAdd(previous: SessionEntry | undefined): Promise<false> {
    if (previous !== undefined && !previous.disposed) {
      await this.deps.switchStored(previous.material.computer.id);
      this.activeId = previous.material.computer.id;
      this.applyActiveRuntime();
      this.publish();
    }
    return false;
  }

  // harn:assume hosted-background-computer-activity-is-visible ref=background-computer-summary
  private summary(entry: SessionEntry): ComputerActivitySummary {
    const state = entry.store.getState();
    const byRoom = new Map(state.roomSummaries.map((summary) => [summary.id, summary]));
    for (const slice of Object.values(state.rooms)) {
      if (slice.support) byRoom.set(slice.support.room, slice.support.summary);
    }
    const summaries = [...byRoom.values()];
    const workingMembers = Object.values(state.rooms).reduce(
      (total, slice) => total + Object.values(slice.members).filter((member) =>
        member.kind === 'agent' && (member.state === 'running' || member.state === 'queued')).length,
      0,
    );
    return {
      connected: state.connected,
      unread: summaries.reduce((total, room) => total + room.unread, 0),
      attention: summaries.some((room) => room.attention),
      working: Math.max(workingMembers, summaries.filter((room) => room.working).length),
    };
  }

  private publish(): void {
    this.snapshot = {
      activeId: this.activeId,
      computers: [...this.entries.values()].map((entry) => ({
        id: entry.material.computer.id,
        label: entry.material.computer.label,
        active: entry.material.computer.id === this.activeId,
        ready: this.usable(entry),
        authRefused: entry.store.getState().authRefused,
        ...this.summary(entry),
      })),
    };
    for (const listener of this.listeners) listener();
  }
  // harn:end hosted-background-computer-activity-is-visible
}
// harn:end hosted-app-keeps-all-paired-computers-live

let singleton: ComputerSessionManager | undefined;

export async function initComputerSessions(): Promise<ComputerSessionManager | undefined> {
  if (singleton) return singleton;
  const manager = new ComputerSessionManager();
  if (!await manager.start()) return undefined;
  singleton = manager;
  window.addEventListener('beforeunload', () => manager.dispose(), { once: true });
  return manager;
}

export function computerSessions(): ComputerSessionManager | undefined {
  return singleton;
}
