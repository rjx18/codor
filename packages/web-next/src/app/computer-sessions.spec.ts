// @vitest-environment happy-dom
import type { RoomSummary } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

const recovery = vi.hoisted(() => ({
  refresh: vi.fn(),
  refreshHead: vi.fn((_store: unknown, _room: string, _token: () => string) => Promise.resolve(true)),
  finalizedRoots: vi.fn((_store: unknown, _room: string) => new Set<number>()),
  upgrade: vi.fn(),
}));
vi.mock('../room/run-journals.js', () => ({ refreshMutableRunJournals: recovery.refresh }));
vi.mock('../room/transcript-history.js', () => ({
  refreshTranscriptHistoryHead: recovery.refreshHead,
  finalizedTranscriptRoots: recovery.finalizedRoots,
}));
vi.mock('./compatibility.js', () => ({ requireBrowserUpgrade: recovery.upgrade }));

import type { HostedComputerMaterial } from '@runtime/crypto.js';
import type { TunnelState } from '@runtime/relay.js';

import {
  ComputerSessionManager,
  type ComputerSessionDeps,
} from './computer-sessions.js';
import type { ConnectorOptions, RoomConnector } from './connector.js';
import { rememberedRoom } from './startup.js';

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
        post: () => undefined,
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
