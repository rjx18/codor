// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnector } from './connector.js';
import { createClientStore, useClientStore } from './store.js';
import type { TunnelState, TunnelStateListener } from '@runtime/relay.js';

/**
 * A socket that stays OPEN unless something retires it — the shape a frozen tab
 * actually wakes holding. `readyState` alone is not evidence the wire is alive,
 * so a resume must replace it regardless.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed += 1; this.readyState = 3; }

  /** Drive the handshake the way a real server would. */
  accept(): void { this.onopen?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }

  subscriptions(): { room: string; since_seq: number }[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type?: string; room?: string; since_seq?: number })
      .filter((frame) => frame.type === 'subscribe')
      .map((frame) => ({ room: frame.room ?? '', since_seq: frame.since_seq ?? -1 }));
  }
}

class FakeTunnel {
  state: TunnelState;
  generation = 1;
  recoveries = 0;
  private readonly listeners = new Set<TunnelStateListener>();
  private readonly waiters = new Set<{
    generation: number;
    resolve: (generation: number) => void;
    reject: (error: Error) => void;
  }>();

  constructor(state: TunnelState) {
    this.state = state;
  }

  subscribe(listener: TunnelStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  whenReady(): Promise<number> {
    if (this.state === 'connected') return Promise.resolve(this.generation);
    return new Promise((resolve, reject) => {
      this.waiters.add({ generation: this.generation, resolve, reject });
    });
  }

  recover(): void {
    this.recoveries += 1;
    if (this.state === 'connected') this.advance();
    this.state = 'connecting';
    this.emit();
  }

  drop(): void {
    this.advance();
    this.state = 'disconnected';
    this.emit();
  }

  ready(): void {
    this.state = 'connected';
    this.emit();
    for (const waiter of [...this.waiters]) {
      if (waiter.generation !== this.generation) continue;
      this.waiters.delete(waiter);
      waiter.resolve(this.generation);
    }
  }

  private advance(): void {
    this.generation += 1;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.reject(new Error('stale tunnel generation'));
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state, this.generation);
  }
}

const build = (room = 'eng') => createConnector({
  room,
  token: 'token',
  socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
});

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

/** Resume is queued on a microtask, so tests must let it run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const fireVisible = (): void => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  window.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  useClientStore.setState({ rooms: {}, activeRoom: undefined, connected: false, roomLive: {} } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// harn:assume relay-app-socket-readiness-requires-server-evidence ref=relay-app-socket-readiness-unit-regression
describe('connector resume', () => {
  it('writes only the injected computer store and token sink', () => {
    const isolated = createClientStore();
    const setToken = vi.fn((token: string) => token);
    const connector = createConnector({
      room: 'shared',
      token: 'computer-token',
      store: isolated,
      setToken,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    latest().accept();
    expect(isolated.getState().connected).toBe(false);
    latest().deliver({ type: 'rooms', rooms: [] });
    expect(isolated.getState().connected).toBe(true);
    expect(useClientStore.getState().connected).toBe(false);
    latest().drop(4403);
    expect(isolated.getState().authRefused).toBe(true);
    expect(setToken).toHaveBeenCalledWith('');
    connector.dispose();
  });

  it('replaces an apparently-open socket and retires the old generation', async () => {
    const connector = build();
    const first = latest();
    first.accept();
    expect(useClientStore.getState().connected).toBe(false);
    first.deliver({ type: 'rooms', rooms: [] });
    expect(useClientStore.getState().connected).toBe(true);

    fireVisible();
    await flush();

    // A new socket exists and the old one was closed, despite still being OPEN.
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.closed).toBe(1);

    // Late events from the retired socket cannot touch the store.
    first.drop(1006);
    latest().accept();
    expect(useClientStore.getState().connected).toBe(false);
    latest().deliver({ type: 'rooms', rooms: [] });
    expect(useClientStore.getState().connected).toBe(true);
    connector.dispose();
  });
// harn:end relay-app-socket-readiness-requires-server-evidence

  it('coalesces several signals describing one transition into ONE replacement', async () => {
    const connector = build();
    latest().accept();
    const before = FakeSocket.instances.length;

    // A real wake fires these together; each must not mint its own socket.
    fireVisible();
    window.dispatchEvent(new Event('online'));
    fireVisible();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    await Promise.resolve();

    expect(FakeSocket.instances.length).toBe(before + 1);
    expect(FakeSocket.instances.filter((entry) => entry.closed === 0)).toHaveLength(1);
    connector.dispose();
  });

  it('ignores an online event while the tab is hidden', async () => {
    const connector = build();
    latest().accept();
    const before = FakeSocket.instances.length;

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    await Promise.resolve();

    // A backgrounded tab is not in use; the visibility transition owns the wake.
    expect(FakeSocket.instances.length).toBe(before);
    connector.dispose();
  });

  it('resubscribes each room from its own committed cursor', async () => {
    const connector = build('eng');
    latest().accept();
    latest().deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }] });

    // Both rooms have advanced independently while connected.
    useClientStore.setState({
      rooms: {
        eng: { ...useClientStore.getState().rooms.eng, seq: 42 },
        design: { ...useClientStore.getState().rooms.design, seq: 7 },
      },
    } as never);

    fireVisible();
    await flush();
    const resumed = latest();
    resumed.accept();
    resumed.deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }] });

    const subs = resumed.subscriptions();
    expect(subs[0]?.room).toBe('eng'); // selected room first
    expect(subs.find((entry) => entry.room === 'eng')?.since_seq).toBe(42);
    expect(subs.find((entry) => entry.room === 'design')?.since_seq).toBe(7);
    connector.dispose();
  });

  it('never resumes a manual park', () => {
    const connector = build();
    latest().accept();
    connector.disconnect();
    expect(connector.state()).toBe('parked-manual');
    const parked = FakeSocket.instances.length;

    fireVisible();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    expect(FakeSocket.instances).toHaveLength(parked);
    expect(connector.state()).toBe('parked-manual');

    // Only a deliberate reconnect leaves the park.
    connector.reconnect();
    expect(FakeSocket.instances.length).toBe(parked + 1);
    connector.dispose();
  });

  it('never resumes an upgrade park', () => {
    const connector = build();
    latest().accept();
    latest().deliver({
      type: 'upgrade_required',
      current_browser_protocol: 1,
      minimum_browser_protocol: 99,
    });
    expect(connector.state()).toBe('parked-upgrade');
    const parked = FakeSocket.instances.length;

    fireVisible();
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(parked);
    connector.dispose();
  });

  it('lets a managed session own upgrade presentation', () => {
    const onUpgradeRequired = vi.fn();
    const connector = createConnector({
      room: 'eng',
      token: 'token',
      onUpgradeRequired,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    latest().accept();
    const frame = {
      type: 'upgrade_required' as const,
      current_browser_protocol: 1,
      minimum_browser_protocol: 99,
    };
    latest().deliver(frame);
    expect(onUpgradeRequired).toHaveBeenCalledWith(frame);
    expect(connector.state()).toBe('parked-upgrade');
    connector.dispose();
  });

  it('never leaves a revoked-credential park, by resume or by reconnect', async () => {
    const connector = build();
    latest().accept();
    latest().drop(4403); // the server revoked this token
    expect(connector.state()).toBe('parked-auth');
    const parked = FakeSocket.instances.length;

    fireVisible();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await flush();
    // Reopening with a refused credential would just hammer the server.
    expect(FakeSocket.instances).toHaveLength(parked);

    connector.reconnect(); // even a deliberate one: re-pairing is the way out
    await flush();
    expect(FakeSocket.instances).toHaveLength(parked);
    expect(connector.state()).toBe('parked-auth');
    connector.dispose();
  });

  it('does not let reconnect() revive an upgrade park', async () => {
    const connector = build();
    latest().accept();
    latest().deliver({
      type: 'upgrade_required',
      current_browser_protocol: 1,
      minimum_browser_protocol: 99,
    });
    const parked = FakeSocket.instances.length;

    connector.reconnect(); // the old client is still the old client
    await flush();
    expect(FakeSocket.instances).toHaveLength(parked);
    expect(connector.state()).toBe('parked-upgrade');
    connector.dispose();
  });

  it('resumes on a persisted pageshow but not a fresh one', async () => {
    const connector = build();
    latest().accept();
    const before = FakeSocket.instances.length;

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    await flush();
    expect(FakeSocket.instances).toHaveLength(before);

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await flush();
    expect(FakeSocket.instances).toHaveLength(before + 1);
    connector.dispose();
  });

  it('cancels a pending backoff when a resume supersedes it', async () => {
    vi.useFakeTimers();
    const connector = build();
    latest().accept();
    latest().drop(1006); // schedules a retry

    fireVisible();
    await flush(); // resume replaces the socket immediately
    const afterResume = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(30_000);

    // The superseded backoff must not open a second socket behind the resume.
    expect(FakeSocket.instances).toHaveLength(afterResume);
    connector.dispose();
  });
});

// harn:assume hosted-app-streams-follow-tunnel-generations ref=generation-gated-connector-regression
describe('tunnel-generation-gated connector recovery', () => {
  it('suppresses app retries while down and opens once when the tunnel becomes ready', async () => {
    const tunnel = new FakeTunnel('disconnected');
    const connector = createConnector({
      room: 'eng', token: 'token', tunnel,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    expect(FakeSocket.instances).toHaveLength(0);

    connector.reconnect();
    connector.reconnect();
    expect(FakeSocket.instances).toHaveLength(0);
    tunnel.ready();
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    connector.dispose();
  });

  it('cancels an app backoff when tunnel loss wins, then opens once after handshake', async () => {
    vi.useFakeTimers();
    const tunnel = new FakeTunnel('connected');
    const connector = createConnector({
      room: 'eng', token: 'token', tunnel,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    expect(FakeSocket.instances).toHaveLength(1);
    latest().drop(1006); // app retry starts first while the tunnel still looks live
    tunnel.drop(); // tunnel loss must cancel that doomed app backoff
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);

    tunnel.ready();
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    connector.dispose();
  });

  it('foreground recovery waits for the next tunnel generation and coalesces signals', async () => {
    const tunnel = new FakeTunnel('connected');
    const onResume = vi.fn();
    const connector = createConnector({
      room: 'eng', token: 'token', tunnel, onResume,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    expect(FakeSocket.instances).toHaveLength(1);

    fireVisible();
    window.dispatchEvent(new Event('online'));
    fireVisible();
    await flush();
    expect(tunnel.recoveries).toBe(1);
    expect(FakeSocket.instances).toHaveLength(1);
    tunnel.ready();
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(onResume).toHaveBeenCalledTimes(1);
    connector.dispose();
  });

  it('does not reopen an authentication park on a later tunnel generation', async () => {
    const tunnel = new FakeTunnel('connected');
    const connector = createConnector({
      room: 'eng', token: 'token', tunnel,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    latest().drop(4403);
    expect(connector.state()).toBe('parked-auth');
    tunnel.drop();
    tunnel.ready();
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    connector.dispose();
  });
});
// harn:end hosted-app-streams-follow-tunnel-generations

describe('connector disposal', () => {
  it('releases listeners and timers, closes once, and ignores later lifecycle', async () => {
    vi.useFakeTimers();
    const connector = build();
    const socket = latest();
    socket.accept();
    socket.drop(1006); // arm a retry

    connector.dispose();
    expect(connector.state()).toBe('disposed');
    // A disposed page must not still read as connected anywhere.
    expect(useClientStore.getState().connected).toBe(false);
    const afterDispose = FakeSocket.instances.length;

    await vi.advanceTimersByTimeAsync(30_000);
    fireVisible();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    // Nothing this connector owned can create a replacement any more.
    expect(FakeSocket.instances).toHaveLength(afterDispose);
    expect(socket.closed).toBeGreaterThanOrEqual(1);

    // And a late frame from its retired socket changes nothing.
    socket.accept();
    expect(useClientStore.getState().connected).toBe(false);
  });
});

describe('foreground watchdog', () => {
  const visible = (): void => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  };

  it('replaces a socket that stays OPEN but stops answering', async () => {
    vi.useFakeTimers();
    visible();
    const connector = build();
    const stalled = latest();
    stalled.accept();
    stalled.deliver({ type: 'rooms', rooms: [{ id: 'eng' }] });
    const before = FakeSocket.instances.length;

    // The always-active desktop stall: no visibility change, no offline event,
    // no close — the socket simply stops answering.
    await vi.advanceTimersByTimeAsync(20_000); // probe sent
    expect(stalled.sent.filter((raw) => raw.includes('list_rooms'))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8_000); // deadline passes unanswered

    expect(FakeSocket.instances.length).toBe(before + 1);
    expect(stalled.closed).toBe(1);
    connector.dispose();
  });

  it('leaves a responsive socket alone', async () => {
    vi.useFakeTimers();
    visible();
    const connector = build();
    const healthy = latest();
    healthy.accept();
    healthy.deliver({ type: 'rooms', rooms: [{ id: 'eng' }] });
    const before = FakeSocket.instances.length;

    // Advance exactly to each probe and answer it before its deadline. Running
    // past both boundaries in one step would deliver the answer after the
    // deadline had already fired — a test artefact, not a stall.
    for (let round = 0; round < 3; round++) {
      await vi.advanceTimersByTimeAsync(20_000);
      healthy.deliver({ type: 'rooms', rooms: [{ id: 'eng' }] }); // answered in time
    }

    expect(FakeSocket.instances.length).toBe(before);
    expect(healthy.closed).toBe(0);
    connector.dispose();
  });

  it('does not probe while the tab is hidden', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const connector = build();
    const socket = latest();
    socket.accept();
    const sentBefore = socket.sent.length;

    await vi.advanceTimersByTimeAsync(120_000);
    // Backgrounded tabs are throttled and expected to be quiet; the resume
    // path owns that transition, not the watchdog.
    expect(socket.sent.length).toBe(sentBefore);
    expect(FakeSocket.instances).toHaveLength(1);
    connector.dispose();
  });

  it('never resurrects a manual park', async () => {
    vi.useFakeTimers();
    visible();
    const connector = build();
    latest().accept();
    connector.disconnect();
    const parked = FakeSocket.instances.length;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(parked);
    expect(connector.state()).toBe('parked-manual');
    connector.dispose();
  });

  it('stops probing once disposed', async () => {
    vi.useFakeTimers();
    visible();
    const connector = build();
    const socket = latest();
    socket.accept();
    socket.deliver({ type: 'rooms', rooms: [{ id: 'eng' }] });

    connector.dispose();
    const afterDispose = FakeSocket.instances.length;
    const sentAfterDispose = socket.sent.length;

    await vi.advanceTimersByTimeAsync(300_000);
    expect(socket.sent.length).toBe(sentAfterDispose); // no heartbeat on a dead page
    expect(FakeSocket.instances).toHaveLength(afterDispose);
  });
});

describe('per-room seq reconciliation', () => {
  /** Subscribe eng+design on a fresh socket and advance their committed cursors. */
  const primed = (engSeq: number, designSeq: number): FakeSocket => {
    build('eng');
    const socket = latest();
    socket.accept();
    socket.deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }] });
    useClientStore.setState({
      rooms: {
        eng: { ...useClientStore.getState().rooms.eng, seq: engSeq },
        design: { ...useClientStore.getState().rooms.design, seq: designSeq },
      },
    } as never);
    return socket;
  };
  const resyncsAfter = (socket: FakeSocket, before: number) => socket.subscriptions().slice(before);

  it('warm-resyncs only a subscribed room the server reports is behind', () => {
    const socket = primed(10, 5);
    const before = socket.subscriptions().length;
    // Probe reply: design trails (server 8 > committed 5); eng is current.
    socket.deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }], room_seqs: { eng: 10, design: 8 } });
    expect(resyncsAfter(socket, before)).toEqual([{ room: 'design', since_seq: 5 }]);
  });

  it('holds one in-flight resync per room until the cursor catches up, then re-arms', () => {
    const socket = primed(10, 5);
    let before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'design' }], room_seqs: { design: 8 } });
    expect(resyncsAfter(socket, before)).toEqual([{ room: 'design', since_seq: 5 }]);

    // A second probe while still behind must NOT fire another resync.
    before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'design' }], room_seqs: { design: 9 } });
    expect(resyncsAfter(socket, before)).toEqual([]);

    // Cursor catches up (the resync's sync_complete landed); a fresh lag re-arms.
    useClientStore.setState({
      rooms: { design: { ...useClientStore.getState().rooms.design, seq: 9 } },
    } as never);
    before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'design' }], room_seqs: { design: 12 } });
    expect(resyncsAfter(socket, before)).toEqual([{ room: 'design', since_seq: 9 }]);
  });

  it('does not resync a room that is current', () => {
    const socket = primed(10, 8);
    const before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }], room_seqs: { eng: 10, design: 8 } });
    expect(resyncsAfter(socket, before)).toEqual([]);
  });

  it('is a graceful no-op when the server omits room_seqs', () => {
    const socket = primed(10, 5);
    const before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'eng' }, { id: 'design' }] });
    expect(resyncsAfter(socket, before)).toEqual([]);
  });

  it('converges: a lag self-limits to ONE resync once sync_complete fast-forwards the cursor', () => {
    const socket = primed(10, 5);
    // A lag (even a spurious empty-delta one) fires exactly one resync.
    let before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'design' }], room_seqs: { design: 8 } });
    expect(resyncsAfter(socket, before)).toEqual([{ room: 'design', since_seq: 5 }]);

    // The resync's sync_complete carries the room's currentSeq, fast-forwarding
    // the committed cursor even if the warm delta was empty.
    useClientStore.setState({
      rooms: { design: { ...useClientStore.getState().rooms.design, seq: 8 } },
    } as never);

    // A subsequent probe with the SAME server seq must NOT resync again.
    before = socket.subscriptions().length;
    socket.deliver({ type: 'rooms', rooms: [{ id: 'design' }], room_seqs: { design: 8 } });
    expect(resyncsAfter(socket, before)).toEqual([]);
  });
});

// harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-observed-room-regression
describe('connector hidden-room observation', () => {
  it('subscribes desired hidden rooms from their own cursors on every open', async () => {
    const connector = build('eng');
    const first = latest();
    first.accept();
    first.deliver({ type: 'rooms', rooms: [] });

    connector.setDesiredRooms(['wt-child-a', 'wt-child-b']);
    expect(first.subscriptions().map((sub) => sub.room))
      .toEqual(['eng', 'wt-child-a', 'wt-child-b']);
    expect(first.subscriptions().find((sub) => sub.room === 'wt-child-a')?.since_seq).toBe(0);

    // A legal resume replaces the socket and resubscribes the whole desired
    // set alongside the selected public root.
    fireVisible();
    await flush();
    const second = latest();
    second.accept();
    expect(second.subscriptions().map((sub) => sub.room))
      .toEqual(['eng', 'wt-child-a', 'wt-child-b']);
    connector.dispose();
  });

  it('stops resubscribing rooms dropped from the desired set', async () => {
    const connector = build('eng');
    const first = latest();
    first.accept();
    first.deliver({ type: 'rooms', rooms: [] });
    connector.setDesiredRooms(['wt-child-a', 'wt-child-b']);
    connector.setDesiredRooms(['wt-child-b']);

    fireVisible();
    await flush();
    const second = latest();
    second.accept();
    expect(second.subscriptions().map((sub) => sub.room)).toEqual(['eng', 'wt-child-b']);
    connector.dispose();
  });

  it('marks a room live only after its own addressed sync_complete', () => {
    const connector = build('eng');
    const socket = latest();
    expect(connector.roomReadiness('wt-child-a')).toBe('unsubscribed');
    socket.accept();
    socket.deliver({ type: 'rooms', rooms: [] });
    connector.setDesiredRooms(['wt-child-a']);
    expect(connector.roomReadiness('wt-child-a')).toBe('connecting');
    expect(connector.roomReadiness('wt-elsewhere')).toBe('unsubscribed');
    expect(connector.room()).toBe('eng');

    // A sibling's completion — and even retained hydrated content — never
    // marks this room live; only its own addressed sync_complete does.
    socket.deliver({ type: 'sync_complete', seq: 1, room: 'eng' });
    expect(connector.roomReadiness('eng')).toBe('connected');
    expect(connector.roomReadiness('wt-child-a')).toBe('connecting');
    socket.deliver({ type: 'sync_complete', seq: 2, room: 'wt-child-a' });
    expect(connector.roomReadiness('wt-child-a')).toBe('connected');

    socket.drop(1006);
    expect(connector.roomReadiness('wt-child-a')).toBe('offline');
    connector.dispose();
  });

  it('requires each exact new sync_complete after socket replacement despite retained hydration', async () => {
    const connector = build('eng');
    const first = latest();
    first.accept();
    first.deliver({ type: 'rooms', rooms: [] });
    connector.setDesiredRooms(['wt-child-a', 'wt-child-b']);
    first.deliver({ type: 'sync_complete', seq: 1, room: 'eng' });
    first.deliver({ type: 'sync_complete', seq: 2, room: 'wt-child-a' });
    first.deliver({ type: 'sync_complete', seq: 3, room: 'wt-child-b' });
    expect(connector.roomReadiness('wt-child-a')).toBe('connected');
    expect(connector.roomReadiness('wt-child-b')).toBe('connected');
    // The prior generation's hydration is retained as last-good content.
    expect(useClientStore.getState().rooms['wt-child-a']?.hydrated).toBe(true);

    // Replacement: every desired room falls back to connecting even though its
    // hydrated slice is still in the store.
    fireVisible();
    await flush();
    const second = latest();
    second.accept();
    expect(connector.roomReadiness('eng')).toBe('connecting');
    expect(connector.roomReadiness('wt-child-a')).toBe('connecting');
    expect(connector.roomReadiness('wt-child-b')).toBe('connecting');
    expect(useClientStore.getState().rooms['wt-child-a']?.hydrated).toBe(true);

    // A completion addressed to one sibling leaves the other connecting.
    second.deliver({ type: 'sync_complete', seq: 4, room: 'wt-child-a' });
    expect(connector.roomReadiness('wt-child-a')).toBe('connected');
    expect(connector.roomReadiness('wt-child-b')).toBe('connecting');

    // And a late completion from the RETIRED socket proves nothing.
    first.deliver({ type: 'sync_complete', seq: 5, room: 'wt-child-b' });
    expect(connector.roomReadiness('wt-child-b')).toBe('connecting');
    connector.dispose();
  });

  it('keeps the public root observed while a hidden child is the selected conversation', async () => {
    const connector = build('eng');
    const first = latest();
    first.accept();
    first.deliver({ type: 'rooms', rooms: [] });
    // The page-level desired set carries the public root PLUS active children.
    connector.setDesiredRooms(['eng', 'wt-child-a']);
    connector.switchRoom('wt-child-a');
    expect(connector.room()).toBe('wt-child-a');

    fireVisible();
    await flush();
    const second = latest();
    second.accept();
    // Reconnect while the child is selected still subscribes main and every
    // desired child: current conversation first, then the whole desired set.
    expect(second.subscriptions().map((sub) => sub.room))
      .toEqual(['wt-child-a', 'eng']);
    connector.dispose();
  });

  it('keeps hidden observation inside an isolated computer store', () => {
    const isolated = createClientStore();
    const connector = createConnector({
      room: 'root',
      token: 'computer-token',
      store: isolated,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    latest().accept();
    latest().deliver({ type: 'rooms', rooms: [] });
    connector.setDesiredRooms(['wt-hosted-child']);
    expect(latest().subscriptions().map((sub) => sub.room)).toEqual(['root', 'wt-hosted-child']);
    expect(connector.roomReadiness('wt-hosted-child')).toBe('connecting');
    latest().deliver({ type: 'sync_complete', seq: 1, room: 'wt-hosted-child' });
    expect(connector.roomReadiness('wt-hosted-child')).toBe('connected');
    // The reactive evidence lives in the ISOLATED store, never the legacy one.
    expect(isolated.getState().roomLive['wt-hosted-child']).toBe(true);
    expect(useClientStore.getState().roomLive['wt-hosted-child']).toBeUndefined();
    expect(useClientStore.getState().rooms['wt-hosted-child']).toBeUndefined();
    connector.dispose();
  });
});
// harn:end worktree-conversation-status-is-live-and-independent
