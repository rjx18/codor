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
import { TunnelClient, type TunnelState } from '@runtime/relay.js';
import { setActiveComputer } from '@runtime/active-computer.js';

import { createConnector, type ConnectorOptions, type RoomConnector } from './connector.js';
import { requireBrowserUpgrade } from './compatibility.js';
import { rememberedRoom, rememberRoom, resolveStartupRoom } from './startup.js';
import { createClientStore, mirrorClientStore, type ClientStore } from './store.js';
import { refreshMutableRunJournals } from '../room/run-journals.js';
import {
  finalizedTranscriptRoots,
  refreshTranscriptHistoryHead,
} from '../room/transcript-history.js';

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
  onStateChange?: (state: TunnelState) => void;
  connect(): void;
  whenReady(): Promise<void>;
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
  upgrade?: Extract<ServerFrame, { type: 'upgrade_required' }>;
  disposed: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  stopStore: () => void;
}

export interface ComputerSessionDeps {
  load(): Promise<{ materials: HostedComputerMaterial[]; activeId?: string }>;
  makeTunnel(material: HostedComputerMaterial): SessionTunnel;
  authenticate(material: HostedComputerMaterial, tunnel: SessionTunnel): Promise<BrowserDeviceSession>;
  loadRooms(token: string, tunnel: SessionTunnel): Promise<RoomSummary[]>;
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
  authenticate: (material, tunnel) => openBrowserDeviceSessionWith(
    material.switchboard,
    tunnel.fetch.bind(tunnel),
    relayAccessOrigin(material.relay.relay_url),
  ),
  loadRooms: async (token, tunnel) => {
    const headers = { authorization: `Bearer ${token}` };
    const summaryResponse = await tunnel.fetch('/api/rooms/summary?read_state=durable', { headers });
    if (summaryResponse.ok) {
      return ((await summaryResponse.json()) as { rooms: RoomSummary[] }).rooms;
    }
    const roomsResponse = await tunnel.fetch('/api/rooms', { headers });
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

// harn:assume hosted-app-keeps-all-paired-computers-live ref=computer-session-lifecycle
/** Hosted-only, per-tab composition. It owns one existing tunnel, signed device
 *  session, isolated store and existing connector for every indexed computer. */
export class ComputerSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly listeners = new Set<() => void>();
  private activeId?: string;
  private snapshot: ComputerSessionsSnapshot = { computers: [] };
  private disposed = false;

  constructor(private readonly deps: ComputerSessionDeps = defaultDeps) {}

  async start(): Promise<boolean> {
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
      await Promise.race([active.ready, this.deps.sleep(bootWaitMs())]);
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
      room: entry.connector.room(),
      token: entry.token,
      connector: entry.connector,
    };
  }

  activeToken(): string {
    return this.activeId === undefined ? '' : this.entries.get(this.activeId)?.token ?? '';
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

  onActiveTunnelState(listener: (state: TunnelState) => void): void {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (entry) entry.tunnel.onStateChange = listener;
  }

  // harn:assume hosted-computer-switching-reuses-warm-session ref=warm-computer-activation
  async activate(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!this.usable(entry)) return false;
    await this.deps.switchStored(id);
    this.activeId = id;
    this.applyActiveRuntime();
    if (entry.connector) rememberRoom(entry.connector.room(), id);
    if (entry.upgrade) requireBrowserUpgrade(entry.upgrade);
    this.publish();
    return entry.connector !== undefined;
  }
  // harn:end hosted-computer-switching-reuses-warm-session

  rememberActiveRoom(room: string): void {
    if (this.activeId !== undefined) rememberRoom(room, this.activeId);
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
    const wasActive = id === this.activeId;
    const fallback = wasActive
      ? [...this.entries.values()]
        .filter((entry) => entry.material.computer.id !== id && this.usable(entry))
        .sort((left, right) => Number(right.store.getState().connected) - Number(left.store.getState().connected))[0]
      : undefined;
    await this.deps.forget(id);
    this.disposeEntry(id);
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

  // harn:assume hosted-computer-sessions-keep-state-isolated ref=per-computer-session-state
  private startEntry(material: HostedComputerMaterial): void {
    let resolveReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
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
      stopStore: () => undefined,
    };
    entry.stopStore = store.subscribe(() => this.publish());
    tunnel.onStateChange = () => this.publish();
    this.entries.set(material.computer.id, entry);
    tunnel.connect();
    void this.completeEntry(entry);
  }

  private async completeEntry(entry: SessionEntry): Promise<void> {
    let retryMs = 500;
    while (!this.disposed && !entry.disposed && !entry.connector) {
      try {
        await entry.tunnel.whenReady();
        const token = await this.refreshEntryToken(entry);
        const rooms = await this.deps.loadRooms(token, entry.tunnel);
        entry.store.getState().setRoomSummaries(rooms);
        const explicit = entry.material.computer.id === this.activeId
          ? new URLSearchParams(window.location.search).get('room') ?? undefined
          : undefined;
        const room = resolveStartupRoom(rooms, {
          explicit,
          remembered: rememberedRoom(entry.material.computer.id),
        });
        if (room === undefined) {
          entry.resolveReady();
          this.publish();
          return;
        }
        rememberRoom(room, entry.material.computer.id);
        entry.connector = this.deps.makeConnector({
          room,
          token,
          origin: relayAccessOrigin(entry.material.relay.relay_url).replace(/^http/, 'ws'),
          socketFactory: entry.tunnel.socketFactory.bind(entry.tunnel),
          store: entry.store,
          setToken: (next) => this.setEntryToken(entry, next),
          refreshToken: () => this.refreshEntryToken(entry),
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

  private async refreshEntryToken(entry: SessionEntry): Promise<string> {
    const session = await this.deps.authenticate(entry.material, entry.tunnel);
    // harn:assume hosted-generated-computer-label-follows-authenticated-hostname ref=authenticated-computer-label
    if (session.hostname) {
      const computer = await this.deps.adoptHostname(entry.material.computer.id, session.hostname);
      if (computer) entry.material = { ...entry.material, computer };
    }
    // harn:end hosted-generated-computer-label-follows-authenticated-hostname
    return this.setEntryToken(entry, session.token);
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
    if (entry.connector) {
      (window as unknown as { __codor?: RoomConnector }).__codor = entry.connector;
    }
  }

  private disposeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.disposed = true;
    entry.stopStore();
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
    if (this.usable(previous)) {
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
