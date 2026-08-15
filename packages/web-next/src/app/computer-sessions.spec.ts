// @vitest-environment happy-dom
import type { Message, RoomSummary } from '@codor/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recovery = vi.hoisted(() => ({
  refresh: vi.fn(),
  refreshHead: vi.fn((_store: unknown, _room: string, _token: () => string) => Promise.resolve(true)),
  finalizedRoots: vi.fn((_store: unknown, _room: string) => new Set<number>()),
  upgrade: vi.fn(),
}));
const lastGoodCache = vi.hoisted(() => ({ snapshots: new Map<string, unknown>() }));
vi.mock('../room/run-journals.js', () => ({ refreshMutableRunJournals: recovery.refresh }));
vi.mock('../room/transcript-history.js', () => ({
  refreshTranscriptHistoryHead: recovery.refreshHead,
  finalizedTranscriptRoots: recovery.finalizedRoots,
}));
vi.mock('./compatibility.js', () => ({ requireBrowserUpgrade: recovery.upgrade }));
vi.mock('../runtime/last-good-room.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/last-good-room.js')>();
  return {
    ...actual,
    loadLastGoodRoom: vi.fn(async (id: string) => lastGoodCache.snapshots.get(id)),
    saveLastGoodRoom: vi.fn(async (snapshot: { computerId: string }) => {
      lastGoodCache.snapshots.set(snapshot.computerId, snapshot);
    }),
    deleteLastGoodRoom: vi.fn(async (id: string) => { lastGoodCache.snapshots.delete(id); }),
  };
});

import type { HostedComputerMaterial } from '@runtime/crypto.js';
import type { TunnelState } from '@runtime/relay.js';

import {
  ComputerSessionManager,
  historyEvidenceRooms,
  type ComputerSessionDeps,
} from './computer-sessions.js';
import type { ConnectorOptions, RoomConnector } from './connector.js';
import { rememberRoom, rememberedRoom } from './startup.js';
import {
  deleteLastGoodRoom,
  loadLastGoodRoom,
  saveLastGoodRoom,
  type LastGoodRoomSnapshot,
} from '../runtime/last-good-room.js';
import { reconcileSelectedRoomHistory } from '../room/RoomPage.js';

beforeEach(() => lastGoodCache.snapshots.clear());

const material = (id: string, gen = 1): HostedComputerMaterial => ({
  computer: { id, gen, label: `Computer ${id}`, label_source: 'fallback', paired_at: `2026-08-0${gen}` },
  relay: {
    relay_url: 'wss://relay.test',
    session_id: id.repeat(64).slice(0, 64),
    client_static: { pub: id, priv: id },
    host_static_pub: id,
  },
  switchboard: {
    kind: 'switchboard',
    device_id: `switchboard-${id}`,
    sign_public_key: `sign-${id}`,
    encryption_public_key: `box-${id}`,
  },
});

const summary = (id: string, unread: number): RoomSummary => ({
  id: 'same-room',
  name: `Room on ${id}`,
  created_ts: '2026-08-01T00:00:00.000Z',
  working: id === 'B',
  attention: id === 'B',
  unread,
});

function harness() {
  let materials = [material('A'), material('B')];
  let activeId: string | undefined = 'A';
  const tunnelStarts: string[] = [];
  const connectorStarts: string[] = [];
  const tunnelDisposals: string[] = [];
  const connectorDisposals: string[] = [];
  const switches: string[] = [];
  const connectorOptions = new Map<string, ConnectorOptions>();
  const desiredByComputer = new Map<string, readonly string[]>();
  const connectors = new Map<string, RoomConnector>();
  const tunnels = new Map<string, {
    set(state: TunnelState, advance?: boolean): void;
    recoveries: number;
    readonly generation: number;
  }>();

  const deps: ComputerSessionDeps = {
    load: async () => ({ materials, activeId }),
    makeTunnel: (loaded) => {
      const id = loaded.computer.id;
      let state: TunnelState = 'connected';
      let generation = 1;
      const listeners = new Set<(state: TunnelState, generation: number) => void>();
      const control = {
        recoveries: 0,
        get generation() { return generation; },
        set(next: TunnelState, advance = false) {
          if (advance) generation += 1;
          state = next;
          for (const listener of listeners) listener(state, generation);
        },
      };
      tunnels.set(id, control);
      const tunnel = {
        get state() { return state; },
        get generation() { return generation; },
        connect: () => { tunnelStarts.push(id); },
        recover: () => { control.recoveries += 1; },
        whenReady: async () => generation,
        subscribe: (listener: (state: TunnelState, current: number) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        fetch: async () => new Response(),
        socketFactory: () => ({}) as WebSocket,
        dispose: () => { tunnelDisposals.push(id); },
      };
      return tunnel;
    },
    authenticate: async (loaded) => ({ token: `token-${loaded.computer.id}` }),
    loadRooms: async (token) => [summary(token.slice(-1), token.endsWith('B') ? 7 : 1)],
    makeConnector: (options: ConnectorOptions): RoomConnector => {
      const id = options.token.slice(-1);
      connectorOptions.set(id, options);
      connectorStarts.push(id);
      options.store!.getState().setConnected(true);
      let room = options.room;
      let desired: readonly string[] = [];
      desiredByComputer.set(id, desired);
      const connector: RoomConnector = {
        room: () => room,
        state: () => 'connected',
        switchRoom: (next) => { room = next; options.store!.getState().setActiveRoom(next); },
        // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-managed-connector-regression
        setDesiredRooms: (rooms) => { desired = rooms; desiredByComputer.set(id, rooms); },
        roomReadiness: (target) =>
          target === room || desired.includes(target) ? 'connected' : 'unsubscribed',
        // harn:end worktree-conversation-status-is-live-and-independent
        post: () => false,
        act: () => undefined,
        disconnect: () => options.store!.getState().setConnected(false),
        reconnect: () => options.store!.getState().setConnected(true),
        dispose: () => { connectorDisposals.push(id); options.store!.getState().setConnected(false); },
      };
      connectors.set(id, connector);
      return connector;
    },
    switchStored: async (id) => { switches.push(id); activeId = id; },
    pair: async () => {
      materials = [...materials, material('C')];
      activeId = 'C';
    },
    forget: async (id) => {
      materials = materials.filter((entry) => entry.computer.id !== id);
      if (activeId === id) activeId = materials.at(-1)?.computer.id;
    },
    rename: async (id, label) => {
      materials = materials.map((entry) => entry.computer.id === id
        ? { ...entry, computer: { ...entry.computer, label, label_source: 'custom' } }
        : entry);
    },
    adoptHostname: async (id, hostname) => {
      let adopted: HostedComputerMaterial['computer'] | undefined;
      materials = materials.map((entry) => {
        if (entry.computer.id !== id) return entry;
        const source = entry.computer.label_source
          ?? (/^Computer [1-9][0-9]*$/.test(entry.computer.label) ? 'fallback' : 'custom');
        if (source === 'custom') {
          adopted = entry.computer;
          return entry;
        }
        adopted = { ...entry.computer, label: hostname, label_source: 'hostname' };
        return { ...entry, computer: adopted };
      });
      return adopted;
    },
    sleep: () => new Promise(() => undefined),
  };
  return {
    deps,
    tunnelStarts,
    connectorStarts,
    tunnelDisposals,
    connectorDisposals,
    switches,
    connectorOptions,
    desiredByComputer,
    connectors,
    tunnels,
  };
}

describe('ComputerSessionManager', () => {
  it('warms inactive evidence with one trailing captured-store refresh', async () => {
    recovery.refreshHead.mockReset();
    const calls: Array<{
      store: NonNullable<ConnectorOptions['store']>;
      room: string;
      token: string;
      release: () => void;
    }> = [];
    recovery.refreshHead.mockImplementation((store, room, token) => {
      let release!: () => void;
      const request = new Promise<boolean>((resolve) => { release = () => resolve(true); });
      calls.push({
        store: store as NonNullable<ConnectorOptions['store']>,
        room,
        token: token(),
        release,
      });
      return request;
    });
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
      const storeB = h.connectorOptions.get('B')!.store!;
      storeB.getState().setActiveRoom('same-room');
      const previous = storeB.getState();
      const message41 = {
        id: 41, seq: 41, room: 'same-room', kind: 'chat', body: 'background evidence',
      } as unknown as Message;
      const current = {
        ...previous,
        rooms: {
          ...previous.rooms,
          'same-room': {
            ...previous.rooms['same-room']!,
            messages: { ...previous.rooms['same-room']!.messages, 41: message41 },
          },
        },
      };
      expect(historyEvidenceRooms(current, previous)).toEqual(['same-room']);
      storeB.setState(current);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ store: storeB, room: 'same-room', token: 'token-B' });

      storeB.getState().applyFrame({
        type: 'message',
        seq: 42,
        message: { id: 42, seq: 42, room: 'same-room', kind: 'chat', body: 'trailing evidence' } as unknown as Message,
      } as never);
      expect(calls).toHaveLength(1);
      calls[0]!.release();
      for (let tick = 0; tick < 8 && calls.length < 2; tick += 1) await Promise.resolve();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ store: storeB, room: 'same-room', token: 'token-B' });
      calls[1]!.release();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

      // A warmed destination is already initialized, so activation itself has
      // no extra head request or transport creation to hide the result.
      recovery.refreshHead.mockClear();
      storeB.getState().updateTranscriptHistory('same-room', (history) => ({
        ...history,
        initialized: true,
        failed: false,
        headNeedsRevalidation: false,
      }));
      reconcileSelectedRoomHistory(h.connectors.get('B')!, 'same-room', true, storeB, 'token-B');
      expect(recovery.refreshHead).not.toHaveBeenCalled();
      expect(await manager.activate('B')).toBe(true);
      expect(recovery.refreshHead).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      for (const call of calls) call.release();
      recovery.refreshHead.mockReset();
      recovery.refreshHead.mockImplementation(
        (_store: unknown, _room: string, _token: () => string) => Promise.resolve(true),
      );
    }
  });

  // harn:assume hosted-app-streams-follow-tunnel-generations ref=generation-aware-session-regression
  it('rejects stale bootstrap work and mounts only the current tunnel generation', async () => {
    const h = harness();
    const authenticate = h.deps.authenticate;
    let releaseFirstA!: () => void;
    let aAttempts = 0;
    h.deps.sleep = async () => undefined;
    h.deps.authenticate = async (loaded, tunnel) => {
      if (loaded.computer.id === 'A' && ++aAttempts === 1) {
        await new Promise<void>((resolve) => { releaseFirstA = resolve; });
      }
      return authenticate(loaded, tunnel);
    };
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

    h.tunnels.get('A')?.set('disconnected', true);
    h.tunnels.get('A')?.set('connected');
    releaseFirstA();
    // The generation-bound request wrapper adds a settlement hop so stale
    // authentication and room-summary work cannot outlive its abort cleanup.
    for (let tick = 0; tick < 24; tick += 1) await Promise.resolve();

    expect(aAttempts).toBe(2);
    expect(h.connectorStarts.filter((id) => id === 'A')).toHaveLength(1);
    expect(h.connectorOptions.get('A')?.tunnel?.generation).toBe(2);
    manager.dispose();
  });
  // harn:end hosted-app-streams-follow-tunnel-generations

  it('keeps two isolated warm stacks and activates one without another handshake or disposal', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    expect(await manager.start()).toBe(true);

    expect(h.tunnelStarts.sort()).toEqual(['A', 'B']);
    expect(h.connectorStarts.sort()).toEqual(['A', 'B']);
    expect(manager.getSnapshot().computers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A', active: true, connected: true, unread: 1, attention: false, working: 0 }),
      expect.objectContaining({ id: 'B', active: false, connected: true, unread: 7, attention: true, working: 1 }),
    ]));

    expect(await manager.activate('B')).toBe(true);
    expect(h.switches).toEqual(['A', 'B']);
    expect(h.tunnelStarts.sort()).toEqual(['A', 'B']);
    expect(h.connectorStarts.sort()).toEqual(['A', 'B']);
    expect(h.tunnelDisposals).toEqual([]);
    expect(h.connectorDisposals).toEqual([]);
    expect(manager.active()).toMatchObject({ id: 'B', room: 'same-room', token: 'token-B' });
    manager.dispose();
  });

  it('publishes positive auth refusal evidence for repair presentation', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    h.connectorOptions.get('B')?.store?.getState().setAuthRefused(true);
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')).toMatchObject({
      authRefused: true,
      connected: true,
    });
    manager.dispose();
  });

  it('adds, renames and forgets only the addressed session', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    expect(await manager.add('CODE', 'wss://relay.test')).toBe(true);
    expect(h.tunnelStarts.sort()).toEqual(['A', 'B', 'C']);
    expect(manager.active()?.id).toBe('C');

    await manager.rename('A', 'Desk');
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'A')?.label).toBe('Desk');

    await manager.forget('B');
    expect(h.tunnelDisposals).toEqual(['B']);
    expect(h.connectorDisposals).toEqual(['B']);
    expect(manager.getSnapshot().computers.map((computer) => computer.id).sort()).toEqual(['A', 'C']);
    expect(manager.active()?.id).toBe('C');
    manager.dispose();
  });

  it('adopts each signed session hostname only for its generated computer label', async () => {
    const h = harness();
    h.deps.authenticate = async (loaded) => ({
      token: `token-${loaded.computer.id}`,
      hostname: `host-${loaded.computer.id.toLowerCase()}`,
    });
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    expect(manager.getSnapshot().computers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A', label: 'host-a' }),
      expect.objectContaining({ id: 'B', label: 'host-b' }),
    ]));

    await manager.rename('A', 'Operator desk');
    await h.connectorOptions.get('A')?.refreshToken?.();
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'A')?.label).toBe('Operator desk');
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')?.label).toBe('host-b');
    manager.dispose();
  });

  it('keeps generated labels when an older signed session omits hostname', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    expect(manager.getSnapshot().computers.map((computer) => computer.label).sort()).toEqual(['Computer A', 'Computer B']);
    manager.dispose();
  });

  it('restores the prior usable session when a newly paired computer misses readiness', async () => {
    const h = harness();
    const loadRooms = h.deps.loadRooms;
    h.deps.loadRooms = async (token, tunnel) => token.endsWith('C')
      ? new Promise<RoomSummary[]>(() => undefined)
      : loadRooms(token, tunnel);
    h.deps.sleep = async () => undefined;
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    expect(await manager.add('CODE', 'wss://relay.test')).toBe(false);
    expect(manager.active()?.id).toBe('A');
    expect((await h.deps.load()).activeId).toBe('A');
    expect(h.switches).toEqual(['A', 'A']);
    expect(h.tunnelDisposals).toEqual([]);
    manager.dispose();
  });

  it('can expose a token before the active connector is ready', async () => {
    const h = harness();
    const loadRooms = h.deps.loadRooms;
    h.deps.loadRooms = async (token, tunnel) => token.endsWith('A')
      ? new Promise<RoomSummary[]>(() => undefined)
      : loadRooms(token, tunnel);
    h.deps.sleep = async () => undefined;
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

    expect(manager.activeToken()).toBe('token-A');
    expect(manager.active()).toBeUndefined();
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')?.ready).toBe(true);
    manager.dispose();
  });

  it('keeps retry work alive after the active session misses its bounded boot wait', async () => {
    const h = harness();
    const authenticate = h.deps.authenticate;
    let releaseA: (() => void) | undefined;
    h.deps.authenticate = vi.fn(async (loaded, tunnel) => {
      if (loaded.computer.id === 'A') await new Promise<void>((resolve) => { releaseA = resolve; });
      return authenticate(loaded, tunnel);
    });
    h.deps.sleep = async () => undefined;
    (window as unknown as { __CODOR_SESSION_BOOT_MS?: number }).__CODOR_SESSION_BOOT_MS = 1;
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')).toMatchObject({ ready: true, connected: true });
    expect(await manager.activate('B')).toBe(true);
    releaseA?.();
    await Promise.resolve();
    expect(h.tunnelDisposals).toEqual([]);
    manager.dispose();
    delete (window as unknown as { __CODOR_SESSION_BOOT_MS?: number }).__CODOR_SESSION_BOOT_MS;
  });

  // harn:assume hosted-bootstrap-requests-are-abortable-and-generation-bounded ref=bounded-managed-bootstrap-regression
  it('aborts one stalled entry at its deadline and retries without recovering its ready peer', async () => {
    vi.useFakeTimers();
    const h = harness();
    const authenticate = h.deps.authenticate;
    let attempts = 0;
    let firstSignal: AbortSignal | undefined;
    h.deps.authenticate = async (loaded, tunnel, signal) => {
      if (loaded.computer.id === 'A' && ++attempts === 1) {
        firstSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return authenticate(loaded, tunnel, signal);
    };
    h.deps.sleep = async () => undefined;
    (window as unknown as { __CODOR_SESSION_REQUEST_MS?: number }).__CODOR_SESSION_REQUEST_MS = 25;
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    await vi.advanceTimersByTimeAsync(25);
    for (let tick = 0; tick < 16; tick += 1) await Promise.resolve();

    expect(firstSignal?.aborted).toBe(true);
    expect(h.tunnels.get('A')?.recoveries).toBe(1);
    expect(h.tunnels.get('B')?.recoveries).toBe(0);
    expect(h.connectorStarts.filter((id) => id === 'A')).toHaveLength(1);
    expect(h.connectorStarts.filter((id) => id === 'B')).toHaveLength(1);
    manager.dispose();
    delete (window as unknown as { __CODOR_SESSION_REQUEST_MS?: number }).__CODOR_SESSION_REQUEST_MS;
    vi.useRealTimers();
  });
  // harn:end hosted-bootstrap-requests-are-abortable-and-generation-bounded

  it('keeps a revoked active connector mounted and rejects selecting it later', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    h.connectorOptions.get('A')?.setToken?.('');
    expect(manager.active()).toMatchObject({ id: 'A', token: '' });
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'A')?.ready).toBe(false);
    expect(await manager.activate('B')).toBe(true);
    const before = [...h.switches];
    expect(await manager.activate('A')).toBe(false);
    expect(h.switches).toEqual(before);
    expect(manager.active()?.id).toBe('B');
    manager.dispose();
  });

  it('rejects a connectorless target before persisted or in-memory activation', async () => {
    const h = harness();
    h.deps.loadRooms = async (token) => token.endsWith('B') ? [] : [summary('A', 1)];
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')?.ready).toBe(false);
    const before = [...h.switches];
    expect(await manager.activate('B')).toBe(false);
    expect(h.switches).toEqual(before);
    expect(manager.active()?.id).toBe('A');
    manager.dispose();
  });

  it('retires a mounted stale cache before publishing authenticated empty-room truth', async () => {
    const h = harness();
    let resolveEmpty!: (rooms: RoomSummary[]) => void;
    const loadRooms = h.deps.loadRooms;
    h.deps.loadRooms = async (token, tunnel, signal) => token.endsWith('A')
      ? new Promise<RoomSummary[]>((resolve) => { resolveEmpty = resolve; })
      : loadRooms(token, tunnel, signal);
    const room = {
      id: 'same-room',
      name: 'Stale cached room',
      created_ts: '2026-08-01T00:00:00.000Z',
      config: {
        turn_brake: null,
        spend_brake_usd: null,
        stall_minutes: 30,
        redaction_enabled: true,
        bridged: false,
      },
    };
    const cached: LastGoodRoomSnapshot = {
      version: 1,
      computerId: 'A',
      room,
      summaries: [summary('A', 1)],
      history: { messages: {}, journals: {}, units: [], beforeCursor: null, hasMore: false },
      savedAt: '2026-08-10T00:00:00.000Z',
    };
    await deleteLastGoodRoom('A');
    await saveLastGoodRoom(cached);
    expect(await loadLastGoodRoom('A')).toEqual(cached);
    rememberRoom(room.id, 'A');

    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    expect(manager.renderableActive()).toMatchObject({ id: 'A', room: 'same-room', token: '' });

    resolveEmpty([]);
    for (let tick = 0; tick < 24 && await loadLastGoodRoom('A') !== undefined; tick += 1) {
      await Promise.resolve();
    }
    expect(manager.activeHasNoRooms()).toBe(true);
    expect(manager.renderableActive()).toBeUndefined();
    expect(manager.active()).toBeUndefined();
    expect(rememberedRoom('A')).toBeUndefined();
    expect(await loadLastGoodRoom('A')).toBeUndefined();
    manager.dispose();
  });

  it('keeps the original explicit room when cached rendering rewrites the URL before live readiness', async () => {
    const previousUrl = window.location.href;
    window.history.replaceState(null, '', '/?room=workspace');
    const h = harness();
    let resolveRooms!: (rooms: RoomSummary[]) => void;
    const loadRooms = h.deps.loadRooms;
    h.deps.loadRooms = async (token, tunnel, signal) => token.endsWith('A')
      ? new Promise<RoomSummary[]>((resolve) => { resolveRooms = resolve; })
      : loadRooms(token, tunnel, signal);
    const cachedRoom = {
      id: 'eng',
      name: 'Cached Engineering',
      created_ts: '2026-08-01T00:00:00.000Z',
      config: {
        turn_brake: null,
        spend_brake_usd: null,
        stall_minutes: 30,
        redaction_enabled: true,
        bridged: false,
      },
    };
    await saveLastGoodRoom({
      version: 1,
      computerId: 'A',
      room: cachedRoom,
      summaries: [{ ...summary('A', 1), id: 'eng', name: cachedRoom.name }],
      history: { messages: {}, journals: {}, units: [], beforeCursor: null, hasMore: false },
      savedAt: '2026-08-10T00:00:00.000Z',
    });

    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
      expect(manager.renderableActive()).toMatchObject({ id: 'A', room: 'eng', token: '' });

      // This is the early cached ManagedBootstrap canonicalization that used to
      // erase the operator's requested room before live room discovery landed.
      window.history.replaceState(null, '', '/?room=eng');
      resolveRooms([
        { ...summary('A', 1), id: 'eng', name: 'Engineering' },
        { ...summary('A', 0), id: 'workspace', name: 'Workspace' },
      ]);
      for (let tick = 0; tick < 24 && manager.active()?.room !== 'workspace'; tick += 1) {
        await Promise.resolve();
      }
      expect(manager.active()).toMatchObject({ id: 'A', room: 'workspace', token: 'token-A' });
    } finally {
      manager.dispose();
      window.history.replaceState(null, '', previousUrl);
    }
  });

  it('refreshes mutable journals only for the active connector with its own token', async () => {
    recovery.refresh.mockReset();
    recovery.refreshHead.mockClear();
    recovery.finalizedRoots.mockClear();
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    h.connectorOptions.get('B')?.onResume?.('same-room');
    expect(recovery.refresh).not.toHaveBeenCalled();
    expect(recovery.refreshHead).not.toHaveBeenCalled();
    h.connectorOptions.get('A')?.onResume?.('same-room');
    await Promise.resolve();
    expect(recovery.refreshHead).toHaveBeenCalledTimes(1);
    expect(recovery.refreshHead.mock.calls[0]?.[2]()).toBe('token-A');
    expect(recovery.refresh).toHaveBeenCalledTimes(1);
    expect(recovery.refresh.mock.calls[0]?.[1]()).toBe('token-A');

    await manager.activate('B');
    h.connectorOptions.get('B')?.onResume?.('same-room');
    await Promise.resolve();
    expect(recovery.refreshHead.mock.calls[1]?.[2]()).toBe('token-B');
    expect(recovery.refresh.mock.calls[1]?.[1]()).toBe('token-B');
    manager.dispose();
  });

  // harn:assume selected-room-activation-reconciles-destination-history ref=selected-room-source-isolation-regression
  it('keeps an unresolved selected-room refresh bound to its captured computer store', async () => {
    recovery.refreshHead.mockReset();
    const calls: Array<{
      store: NonNullable<ConnectorOptions['store']>;
      room: string;
      token: string;
      release: () => void;
    }> = [];
    recovery.refreshHead.mockImplementation((store, room, token) => {
      let release!: () => void;
      const request = new Promise<boolean>((resolve) => {
        release = () => {
          (store as NonNullable<ConnectorOptions['store']>).getState()
            .updateTranscriptHistory(room, (history) => ({ ...history, failed: true }));
          resolve(true);
        };
      });
      calls.push({
        store: store as NonNullable<ConnectorOptions['store']>,
        room,
        token: token(),
        release,
      });
      return request;
    });
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
      const storeA = h.connectorOptions.get('A')!.store!;
      const storeB = h.connectorOptions.get('B')!.store!;
      const connectorA = h.connectors.get('A')!;
      const connectorB = h.connectors.get('B')!;

      reconcileSelectedRoomHistory(connectorA, 'same-room', true, storeA, 'token-A');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ store: storeA, room: 'same-room', token: 'token-A' });

      // The source activation remains unresolved while the selected computer changes.
      expect(await manager.activate('B')).toBe(true);
      reconcileSelectedRoomHistory(connectorB, 'same-room', true, storeB, 'token-B');
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ store: storeB, room: 'same-room', token: 'token-B' });

      calls[0]!.release();
      await Promise.resolve();
      expect(storeA.getState().rooms['same-room']?.transcriptHistory.failed).toBe(true);
      expect(storeB.getState().rooms['same-room']?.transcriptHistory.failed).not.toBe(true);

      calls[1]!.release();
      await Promise.resolve();
      expect(storeB.getState().rooms['same-room']?.transcriptHistory.failed).toBe(true);
    } finally {
      manager.dispose();
      for (const call of calls) call.release();
      recovery.refreshHead.mockReset();
      recovery.refreshHead.mockImplementation(
        (_store: unknown, _room: string, _token: () => string) => Promise.resolve(true),
      );
    }
  });

  it('parks an inactive upgrade without replacing the active UI and gates it when selected', async () => {
    recovery.upgrade.mockReset();
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    const frame = {
      type: 'upgrade_required' as const,
      current_browser_protocol: 1,
      minimum_browser_protocol: 99,
    };

    h.connectorOptions.get('B')?.onUpgradeRequired?.(frame);
    expect(recovery.upgrade).not.toHaveBeenCalled();
    expect(manager.active()?.id).toBe('A');
    expect(await manager.activate('B')).toBe(true);
    expect(recovery.upgrade).toHaveBeenCalledWith(frame);
    manager.dispose();
  });

  it('forgets an active computer only into a ready fallback', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    expect(await manager.forget('A')).toBe(true);
    expect(manager.active()?.id).toBe('B');
    expect(h.switches.at(-1)).toBe('B');
    manager.dispose();
  });

  it('requests reload instead of publishing a connectorless active fallback', async () => {
    const h = harness();
    h.deps.loadRooms = async (token) => token.endsWith('B') ? [] : [summary('A', 1)];
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    const before = manager.getSnapshot();

    expect(await manager.forget('A')).toBe(false);
    expect(manager.getSnapshot()).toBe(before);
    manager.dispose();
  });

  it('keeps hidden worktree observation per computer without sharing stores', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    h.connectors.get('A')!.setDesiredRooms(['wt-child-on-a']);
    h.connectors.get('B')!.setDesiredRooms(['wt-child-on-b-1', 'wt-child-on-b-2']);
    expect(h.desiredByComputer.get('A')).toEqual(['wt-child-on-a']);
    expect(h.desiredByComputer.get('B')).toEqual(['wt-child-on-b-1', 'wt-child-on-b-2']);
    expect(h.connectors.get('A')!.roomReadiness('wt-child-on-a')).toBe('connected');
    expect(h.connectors.get('A')!.roomReadiness('wt-child-on-b-1')).toBe('unsubscribed');
    expect(h.connectors.get('B')!.roomReadiness('wt-child-on-b-2')).toBe('connected');
    // Public-root identity per computer is unchanged.
    expect(h.connectors.get('A')!.room()).toBe('same-room');
    expect(h.connectors.get('B')!.room()).toBe('same-room');
    manager.dispose();
  });

  // harn:assume merged-worktree-reliability-contracts-coexist ref=cross-stack-session-recovery-regression
  it('keeps each warm worktree observation on its own tunnel generation', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    const connectorA = h.connectors.get('A')!;
    const connectorB = h.connectors.get('B')!;
    connectorA.setDesiredRooms(['wt-a']);
    connectorB.setDesiredRooms(['wt-b']);

    h.tunnels.get('A')!.set('disconnected', true);
    h.tunnels.get('A')!.set('connected');
    await Promise.resolve();

    expect(h.tunnels.get('A')?.generation).toBe(2);
    expect(h.tunnels.get('B')?.generation).toBe(1);
    expect(h.connectors.get('A')).toBe(connectorA);
    expect(h.connectors.get('B')).toBe(connectorB);
    expect(h.desiredByComputer.get('A')).toEqual(['wt-a']);
    expect(h.desiredByComputer.get('B')).toEqual(['wt-b']);
    expect(connectorA.roomReadiness('wt-b')).toBe('unsubscribed');
    expect(connectorB.roomReadiness('wt-a')).toBe('unsubscribed');
    expect(h.connectorDisposals).toEqual([]);
    manager.dispose();
  });
  // harn:end merged-worktree-reliability-contracts-coexist

  // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-managed-connector-regression
  it('remembers only the public root while a hidden child is selected, across computer switches', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    // A top-level switch names the session's public root.
    manager.rememberActiveRoom('root-on-a');
    // Selecting a hidden registered child moves only the connector's
    // conversation — never the remembered room.
    h.connectors.get('A')!.switchRoom('hidden-child-on-a');
    expect(h.connectors.get('A')!.room()).toBe('hidden-child-on-a');
    expect(manager.active()?.room).toBe('root-on-a');
    expect(rememberedRoom('A')).toBe('root-on-a');

    // Switch computers away and back: the restored session room is still the
    // public root, and the warm connector is driven back to it while its child
    // selection remains only conversation-local state.
    await manager.activate('B');
    expect(manager.active()?.id).toBe('B');
    await manager.activate('A');
    expect(manager.active()).toMatchObject({ id: 'A', room: 'root-on-a' });
    expect(h.connectors.get('A')!.room()).toBe('root-on-a');
    expect(rememberedRoom('A')).toBe('root-on-a');
    manager.dispose();
  });
  // harn:end worktree-conversation-status-is-live-and-independent
});
