// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnector } from './connector.js';
import { useClientStore } from './store.js';

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
  useClientStore.setState({ rooms: {}, activeRoom: undefined, connected: false } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connector resume', () => {
  it('replaces an apparently-open socket and retires the old generation', async () => {
    const connector = build();
    const first = latest();
    first.accept();
    expect(useClientStore.getState().connected).toBe(true);

    fireVisible();
    await flush();

    // A new socket exists and the old one was closed, despite still being OPEN.
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.closed).toBe(1);

    // Late events from the retired socket cannot touch the store.
    first.drop(1006);
    latest().accept();
    expect(useClientStore.getState().connected).toBe(true);
    connector.dispose();
  });

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
