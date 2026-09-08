// @vitest-environment happy-dom
import type { Message, RoomSummary } from '@codor/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recovery = vi.hoisted(() => ({
  retireHistory: vi.fn(),
  bindOwner: vi.fn(),
  refresh: vi.fn(),
  refreshHead: vi.fn((_store: unknown, _room: string, _token: () => string) => Promise.resolve(true)),
  finalizedRoots: vi.fn((_store: unknown, _room: string) => new Set<number>()),
  upgrade: vi.fn(),
}));
const lastGoodCache = vi.hoisted(() => ({ snapshots: new Map<string, unknown>() }));
vi.mock('../room/run-journals.js', () => ({ refreshMutableRunJournals: recovery.refresh }));
vi.mock('../room/transcript-history.js', () => ({
  bindTranscriptHistoryOwner: recovery.bindOwner,
  retireTranscriptHistory: recovery.retireHistory,
  refreshTranscriptHistoryHead: recovery.refreshHead,
  finalizedTranscriptRoots: recovery.finalizedRoots,
}));
vi.mock('./compatibility.js', () => ({
  requireBrowserUpgrade: recovery.upgrade,
  fetchBrowserCompatibility: vi.fn(async () => ({ combinedTranscriptHistory: true })),
}));
vi.mock('../runtime/last-good-room.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/last-good-room.js')>();
  return {
    ...actual,
    snapshotLastGoodRoom: vi.fn(actual.snapshotLastGoodRoom),
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
  snapshotLastGoodRoom,
  type LastGoodRoomSnapshot,
} from '../runtime/last-good-room.js';
import { reconcileSelectedRoomHistory } from '../room/RoomPage.js';

beforeEach(() => lastGoodCache.snapshots.clear());

describe('bounded hosted background work', () => {
  it('publishes a changed public room even when activity summaries are unchanged', async () => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 64; tick++) await Promise.resolve();
    try {
      const snapshot = manager.getSnapshot();
      manager.rememberActiveRoom('workspace');
      expect(manager.getSnapshot()).not.toBe(snapshot);
      expect(manager.active()?.room).toBe('workspace');
    } finally { manager.dispose(); }
  });
  it('does not renew or retry a rejected mutating request', async () => {
    const h = harness();
    const make = h.deps.makeTunnel;
    const request = vi.fn(async () => new Response('', { status: 401 }));
    h.deps.makeTunnel = (material) => Object.assign(make(material), { fetch: request });
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 64; tick++) await Promise.resolve();
    const renew = vi.fn(async () => ({ token: 'unexpected' })); h.deps.authenticate = renew;
    try {
      const store = h.connectorOptions.get('A')!.store!;
      const capture = recovery.bindOwner.mock.calls.find((call) => call[0] === store)![1];
      const response = await capture().fetch('/api/rooms', { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
      expect(request).toHaveBeenCalledTimes(1);
      expect(renew).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });
  it.each(['expired', '401'])('coalesces %s renewal and completes fresh history despite P4 retirement', async (mode) => {
    const actual = await vi.importActual<typeof import('../room/transcript-history.js')>('../room/transcript-history.js');
    const h = harness();
    const originalAuth = h.deps.authenticate;
    h.deps.authenticate = async (...args) => ({ ...await originalAuth(...args), expiresAt: Date.now() + 3_600_000 });
    const originalTunnel = h.deps.makeTunnel;
    const tokens: string[] = [];
    h.deps.makeTunnel = (material) => {
      const tunnel = originalTunnel(material);
      tunnel.fetch = async (_input, init) => {
        const token = new Headers(init?.headers).get('authorization') ?? '';
        tokens.push(token);
        return token === 'Bearer fresh-A'
          ? new Response(JSON.stringify({ messages: [], journals: [], units: [], before_cursor: null, has_more: false }))
          : new Response('', { status: 401 });
      };
      return tunnel;
    };
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let tick = 0; tick < 64; tick++) await Promise.resolve();
    const clock = mode === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000) : undefined;
    let finish!: () => void;
    const renewal = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { token: 'fresh-A', expiresAt: Date.now() + 3_600_000 };
    });
    h.deps.authenticate = renewal;
    const store = h.connectorOptions.get('A')!.store!;
    const capture = recovery.bindOwner.mock.calls.find((call) => call[0] === store)![1];
    const operations: Array<{ isCurrent(): boolean }> = [];
    actual.bindTranscriptHistoryOwner(store, () => { const operation = capture(); operations.push(operation); return operation; });
    recovery.retireHistory.mockImplementation(actual.retireTranscriptHistory);
    try {
      const a = actual.refreshTranscriptHistoryHead(store, 'alpha', () => 'token-A');
      const b = actual.refreshTranscriptHistoryHead(store, 'beta', () => 'token-A');
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      expect(renewal).toHaveBeenCalledTimes(1);
      finish();
      expect(await Promise.all([a, b])).toEqual([true, true]);
      expect(tokens.filter((token) => token === 'Bearer fresh-A')).toHaveLength(2);
      expect(tokens).toHaveLength(mode === 'expired' ? 2 : 4);
      expect(operations.every((operation) => operation.isCurrent())).toBe(true);
      expect(store.getState().rooms.alpha?.transcriptHistory.loadingHead).toBe(false);
      expect(store.getState().rooms.beta?.transcriptHistory.initialized).toBe(true);
    } finally { manager.dispose(); clock?.mockRestore(); recovery.retireHistory.mockReset(); }
  });
  it.each([false, true])('promotes selected work and preserves trailing intent, inFlight=%s', async (inFlight) => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    const calls: Array<{ room: string; release: () => void }> = [];
    recovery.refreshHead.mockImplementation((_store, room) => new Promise<boolean>((resolve) => {
      calls.push({ room, release: () => resolve(true) });
    }));
    try {
      await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
      const store = h.connectorOptions.get('A')!.store!;
      const seed = (room: string, id = 1) => {
        store.getState().applyFrame({ type: 'message', seq: id,
          message: { room, id, seq: id, kind: 'chat', body: 'new work' } } as never);
      };
      seed('one'); seed('two');
      const selected = inFlight ? 'one' : 'three';
      seed(selected, 2);
      h.connectors.get('A')!.switchRoom(selected);
      if (inFlight) {
        calls.find((call) => call.room === selected)!.release();
        for (let tick = 0; tick < 12; tick++) await Promise.resolve();
        expect(calls.filter((call) => call.room === selected)).toHaveLength(2);
      } else {
        expect(calls.map((call) => call.room)).toEqual(['one', 'two', 'three']);
      }
    } finally {
      manager.dispose(); for (const call of calls) call.release();
      recovery.refreshHead.mockImplementation(() => Promise.resolve(true));
    }
  });
  it('aborts the captured transport when its tunnel generation is replaced', async () => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    try {
      const store = h.connectorOptions.get('A')!.store!;
      const capture = recovery.bindOwner.mock.calls.find((call) => call[0] === store)![1];
      const operation = capture();
      expect(operation.token).toBe('token-A');
      expect(operation.isCurrent()).toBe(true);
      h.tunnels.get('A')!.set('connected', true);
      expect(operation.isCurrent()).toBe(false);
      await expect(operation.fetch('/old')).rejects.toThrow('retired history operation');
      expect(capture().isCurrent()).toBe(true);
    } finally { manager.dispose(); }
  });
  it('ignores live roots and continuations but observes terminal and deleted evidence', async () => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    try {
      const store = h.connectorOptions.get('B')!.store!;
      store.getState().setActiveRoom('same-room');
      const prior = store.getState();
      const withMessage = (message: Message) => ({ ...prior, rooms: { ...prior.rooms, 'same-room': {
        ...prior.rooms['same-room']!, messages: { [message.id]: message },
      } } });
      const running = { id: 1, room: 'same-room', kind: 'run', seq: 1, run: { status: 'running' } } as Message;
      expect(historyEvidenceRooms(withMessage(running), prior)).toEqual([]);
      expect(historyEvidenceRooms(withMessage({ ...running, run: undefined, run_parent_id: 1, id: 2 }), prior)).toEqual([]);
      expect(historyEvidenceRooms(withMessage({ ...running, run: { ...running.run!, status: 'completed' } }), prior)).toEqual(['same-room']);
      expect(historyEvidenceRooms(withMessage({ ...running, deleted: true }), prior)).toEqual(['same-room']);
    } finally { manager.dispose(); }
  });

  it('bounds background rooms to two jobs and drops queued generation work on disposal', async () => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    const releases: Array<() => void> = [];
    recovery.refreshHead.mockImplementation(() => new Promise<boolean>((resolve) => { releases.push(() => resolve(true)); }));
    try {
      await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
      for (let id = 0; id < 8; id++) {
        const store = h.connectorOptions.get(id % 2 === 0 ? 'B' : 'A')!.store!;
        const room = `background-${id}`;
        store.getState().setActiveRoom(room);
        store.getState().applyFrame({ type: 'message', seq: 1,
          message: { id: 1, room, seq: 1, kind: 'chat', body: 'new' } } as never);
      }
      expect(releases).toHaveLength(2);
      releases[0]!();
      for (let tick = 0; tick < 64; tick++) await Promise.resolve();
      expect(releases).toHaveLength(3);
      manager.dispose();
      for (const release of releases) release();
      for (let tick = 0; tick < 64; tick++) await Promise.resolve();
      expect(releases).toHaveLength(3);
    } finally {
      manager.dispose(); for (const release of releases) release();
      recovery.refreshHead.mockImplementation(() => Promise.resolve(true));
    }
  });

  it('does not notify listeners for unchanged connection and visible summary inputs', async () => {
    const h = harness(); const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    try {
      const store = h.connectorOptions.get('A')!.store!;
      const notify = vi.fn(); const stop = manager.subscribe(notify);
      const snapshot = manager.getSnapshot();
      store.getState().setConnected(true);
      store.getState().setConnected(true);
      store.setState({ rooms: { ...store.getState().rooms } });
      expect(manager.getSnapshot()).toBe(snapshot);
      expect(notify).not.toHaveBeenCalled(); stop();
    } finally { manager.dispose(); }
  });
});

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
        get hasUnsettledHttp() { return false; },
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
    loadCompatibility: async () => true,
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
  it('captures combined-history capability independently for each computer connector', async () => {
    const h = harness();
    h.deps.loadCompatibility = async (token) => token.endsWith('A');
    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
      for (let tick = 0; tick < 64 && h.connectorOptions.size < 2; tick += 1) await Promise.resolve();
      expect(h.connectorOptions.get('A')?.combinedTranscriptHistory).toBe(true);
      expect(h.connectorOptions.get('B')?.combinedTranscriptHistory).toBe(false);
    } finally {
      manager.dispose();
    }
  });

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
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
      for (let tick = 0; tick < 64 && calls.length < 2; tick += 1) await Promise.resolve();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ store: storeB, room: 'same-room', token: 'token-B' });
      calls[1]!.release();
      for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

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

  // harn:assume hosted-last-good-history-cache-is-per-room-bounded-and-provisional ref=provisional-cache-write-coalescing
  it('coalesces rapid snapshot changes into one delayed cache write', async () => {
    vi.useFakeTimers();
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
      const storeA = h.connectorOptions.get('A')!.store!;
      storeA.getState().setActiveRoom('same-room');
      storeA.getState().applyFrame({
        type: 'room', seq: 1, room: {
          id: 'same-room', name: 'Room A', created_ts: '2026-08-01T00:00:00.000Z',
          config: {
            turn_brake: null, spend_brake_usd: null, stall_minutes: 30,
            redaction_enabled: true, bridged: false,
          },
        },
      } as never);
      storeA.getState().updateTranscriptHistory('same-room', (history) => ({
        ...history,
        initialized: true,
        cacheWindow: {
          messages: {}, journals: {}, units: [], beforeCursor: null, hasMore: false,
        },
      }));
      vi.mocked(saveLastGoodRoom).mockClear();
      vi.mocked(snapshotLastGoodRoom).mockClear();

      // Each state notification captures the latest projection, but the timer
      // keeps the stream from issuing one IndexedDB put per event.
      storeA.getState().setConnected(true);
      storeA.getState().setConnected(true);
      storeA.getState().setConnected(true);
      expect(saveLastGoodRoom).not.toHaveBeenCalled();
      expect(snapshotLastGoodRoom).not.toHaveBeenCalled();
      storeA.getState().setConnected(false);
      await vi.advanceTimersByTimeAsync(249);
      expect(saveLastGoodRoom).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(saveLastGoodRoom).toHaveBeenCalledTimes(1);
      expect(snapshotLastGoodRoom).toHaveBeenCalledTimes(1);
      storeA.getState().setConnected(true);
      storeA.getState().updateTranscriptHistory('same-room', (history) => ({ ...history }));
      await manager.forget('A');
      await vi.advanceTimersByTimeAsync(500);
      expect(await loadLastGoodRoom('A')).toBeUndefined();
    } finally {
      manager.dispose();
      vi.useRealTimers();
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

    h.tunnels.get('A')?.set('disconnected', true);
    h.tunnels.get('A')?.set('connected');
    releaseFirstA();
    // The generation-bound request wrapper adds a settlement hop so stale
    // authentication and room-summary work cannot outlive its abort cleanup.
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    for (let i = 0; i < 64; i += 1) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

    expect(firstSignal?.aborted).toBe(true);
    expect(h.tunnels.get('A')?.recoveries).toBe(0);
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();

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
      version: 2,
      computerId: 'A',
      publicRoom: room.id,
      summaries: [summary('A', 1)],
      rooms: {
        [room.id]: {
          room,
          history: { messages: {}, journals: {}, units: [], beforeCursor: null, hasMore: false },
        },
      },
      savedAt: '2026-08-10T00:00:00.000Z',
    };
    await deleteLastGoodRoom('A');
    await saveLastGoodRoom(cached);
    expect(await loadLastGoodRoom('A')).toEqual(cached);
    rememberRoom(room.id, 'A');

    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    expect(manager.renderableActive()).toMatchObject({ id: 'A', room: 'same-room', token: '' });

    resolveEmpty([]);
    for (let tick = 0; tick < 64 && await loadLastGoodRoom('A') !== undefined; tick += 1) {
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
      version: 2,
      computerId: 'A',
      publicRoom: cachedRoom.id,
      summaries: [{ ...summary('A', 1), id: 'eng', name: cachedRoom.name }],
      rooms: {
        [cachedRoom.id]: {
          room: cachedRoom,
          history: { messages: {}, journals: {}, units: [], beforeCursor: null, hasMore: false },
        },
      },
      savedAt: '2026-08-10T00:00:00.000Z',
    });

    const manager = new ComputerSessionManager(h.deps);
    try {
      await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
      expect(manager.renderableActive()).toMatchObject({ id: 'A', room: 'eng', token: '' });

      // This is the early cached ManagedBootstrap canonicalization that used to
      // erase the operator's requested room before live room discovery landed.
      window.history.replaceState(null, '', '/?room=eng');
      resolveRooms([
        { ...summary('A', 1), id: 'eng', name: 'Engineering' },
        { ...summary('A', 0), id: 'workspace', name: 'Workspace' },
      ]);
      for (let tick = 0; tick < 64 && manager.active()?.room !== 'workspace'; tick += 1) {
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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

  // harn:assume selected-room-activation-uses-bounded-destination-reconciliation ref=bounded-selected-room-history-regression
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
    for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();
    const before = manager.getSnapshot();

    expect(await manager.forget('A')).toBe(false);
    expect(manager.getSnapshot()).toBe(before);
    manager.dispose();
  });

  it('keeps hidden worktree observation per computer without sharing stores', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();
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
    for (let startupTick = 0; startupTick < 64; startupTick++) await Promise.resolve();

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
