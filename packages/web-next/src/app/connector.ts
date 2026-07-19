// Scoped room connector: the legacy socket module is a page singleton pinned to
// one room, so in-place channel switching (Richard's decision — no reloads) gets
// its own connector with the SAME wire semantics: subscribe with the store's seq
// cursor, apply frames, exponential backoff, 4401 token refresh, 4403 park.
// Switching rooms is MULTIPLEXED on the one socket: it subscribes to the next
// room and keeps every other subscription and the shared store intact. It does
// not close the socket and does not reset the store — the previous comment here
// described behaviour this connector has not had since in-place switching.
import { BROWSER_PROTOCOL_EPOCH, type Act, type ServerFrame } from '@codor/protocol';

import { setActiveBrowserAccessToken } from '@legacy/crypto.js';
import type { Connection } from '@legacy/ws.js';

import { HISTORY_PAGE_SIZE, roomSlice, useClientStore } from './store.js';
import { requireBrowserUpgrade } from './compatibility.js';

export interface RoomConnector extends Connection {
  /** Select another already-multiplexed room without replacing the socket. */
  switchRoom(room: string): void;
  room(): string;
  /** What this connector is doing — resume legality depends on it. */
  state(): ConnectorState;
  /** Release every listener, timer and socket this connector owns. */
  dispose(): void;
}

export interface ConnectorOptions {
  room: string;
  token: string;
  /** Injectable for tests; production always constructs a real WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  /** Called for EVERY legal resume — lifecycle or watchdog — so recovery work
   *  that must follow a replacement has one place to live. */
  onResume?: (room: string) => void;
  refreshToken?: () => Promise<string>;
}

/** What the connector is doing, and whether a resume may act on it. */
export type ConnectorState =
  | 'connected'
  | 'disconnected'
  | 'parked-manual'
  | 'parked-upgrade'
  | 'parked-auth'
  | 'disposed';

/** A resume is legal only from a recoverable generation — never from a park the
 *  operator or the server chose, and never from a disposed connector. */
const RESUMABLE: ReadonlySet<ConnectorState> = new Set<ConnectorState>([
  'connected',
  'disconnected',
]);

/** Foreground liveness probe cadence, and how long the server has to answer. */
const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;

export function createConnector(options: ConnectorOptions): RoomConnector {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  let currentRoom = options.room;
  let socket: WebSocket | undefined;
  let subscribed = new Set<string>();
  let state: ConnectorState = 'disconnected';
  let retryMs = 500;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // The foreground watchdog: a socket can stay OPEN while the server has long
  // since stopped answering it — no visibility change, no offline event, no
  // close. On an always-active desktop nothing else would ever notice.
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let probeDeadline: ReturnType<typeof setTimeout> | undefined;
  let awaitingProbe = false;
  let token = options.token;
  // Every socket carries the generation that created it. A frozen tab can hand
  // back events from a socket we already replaced; without this they would
  // reset `connected`, schedule retries, or resubscribe on a dead wire.
  let generation = 0;

  useClientStore.getState().setActiveRoom(currentRoom);

  const clearRetry = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  /** Every probe timer is owned here, so a generation change or dispose takes
   *  them with it rather than leaving a heartbeat beating on a dead page. */
  const clearProbes = (): void => {
    if (probeTimer !== undefined) clearInterval(probeTimer);
    if (probeDeadline !== undefined) clearTimeout(probeDeadline);
    probeTimer = undefined;
    probeDeadline = undefined;
    awaitingProbe = false;
  };

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const subscribe = (room: string): void => {
    if (subscribed.has(room) || socket?.readyState !== WebSocket.OPEN) return;
    subscribed.add(room);
    send({
      type: 'subscribe',
      room,
      // Each room resumes from ITS OWN committed cursor, so a resubscribe
      // replays only what that room missed and never re-hydrates it.
      since_seq: roomSlice(useClientStore.getState(), room).seq,
      hydrate_limit: HISTORY_PAGE_SIZE,
      room_addressed: true,
      browser_protocol: BROWSER_PROTOCOL_EPOCH,
      client_kind: 'browser',
    });
  };

  /** Detach a socket from this connector before replacing or closing it. */
  const retire = (victim: WebSocket | undefined): void => {
    if (victim === undefined) return;
    victim.onopen = null;
    victim.onmessage = null;
    victim.onclose = null;
    victim.onerror = null;
    try {
      victim.close();
    } catch {
      // An already-closing socket is exactly what we wanted.
    }
  };

  /**
   * Ask the server something it must answer, and replace the socket if it does
   * not. `list_rooms` is already part of the handshake, so this adds no new
   * protocol — it reuses a request whose `rooms` reply is proof the wire is
   * genuinely alive rather than merely OPEN.
   */
  const startProbes = (mine: number): void => {
    clearProbes();
    probeTimer = setInterval(() => {
      if (mine !== generation || state !== 'connected') return;
      if (document.visibilityState !== 'visible') return; // only while foregrounded
      if (awaitingProbe) return; // a probe is already outstanding
      awaitingProbe = true;
      send({ type: 'list_rooms' });
      probeDeadline = setTimeout(() => {
        if (mine !== generation || !awaitingProbe) return;
        // Unanswered: the socket lies about being open. Go through the SAME
        // resume path, so a manual or upgrade park is still respected.
        awaitingProbe = false;
        resume();
      }, PROBE_TIMEOUT_MS);
    }, PROBE_INTERVAL_MS);
  };

  const open = (): void => {
    if (state === 'disposed') return;
    clearRetry();
    clearProbes();
    const mine = ++generation;
    retire(socket);
    subscribed = new Set();
    socket = socketFactory(`${origin}/ws?token=${encodeURIComponent(token)}`);
    const live = (): boolean => mine === generation && state !== 'disposed';

    socket.onopen = () => {
      if (!live()) return;
      retryMs = 500;
      state = 'connected';
      useClientStore.getState().setConnected(true);
      // The selected room hydrates first; the rooms listing then fans the same
      // socket out to every other authorized room, each from its own cursor.
      subscribe(currentRoom);
      send({ type: 'list_rooms' });
      startProbes(mine);
    };
    socket.onmessage = (event) => {
      if (!live()) return;
      const frame = JSON.parse(event.data as string) as ServerFrame;
      if (frame.type === 'upgrade_required') {
        // A server-chosen park: never resumed automatically, only by reload.
        state = 'parked-upgrade';
        clearProbes();
        useClientStore.getState().setConnected(false);
        requireBrowserUpgrade(frame);
        retire(socket);
        socket = undefined;
        return;
      }
      useClientStore.getState().applyFrame(frame, currentRoom);
      if (frame.type === 'rooms') {
        awaitingProbe = false;
        if (probeDeadline !== undefined) clearTimeout(probeDeadline);
        probeDeadline = undefined;
        for (const room of frame.rooms) subscribe(room.id);
      }
    };
    socket.onclose = (event) => {
      if (!live()) return;
      clearProbes();
      if (state === 'connected' || state === 'disconnected') state = 'disconnected';
      useClientStore.getState().setConnected(false);
      if (state !== 'disconnected') return; // parked or disposed: stay put
      if (event.code === 4403) {
        // The credential was revoked. Reopening with it would hammer the server
        // with a token it has already refused, so this park is absolute: no
        // lifecycle resume and no deliberate reconnect leaves it. Re-pairing
        // (a fresh page) is the only way out.
        state = 'parked-auth';
        setActiveBrowserAccessToken('');
        return;
      }
      const reconnect = (): void => {
        if (!live() || state !== 'disconnected') return;
        clearRetry();
        retryTimer = setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
      if (event.code === 4401 && options.refreshToken) {
        void options.refreshToken().then(
          (refreshed) => {
            if (!live()) return;
            token = setActiveBrowserAccessToken(refreshed);
            reconnect();
          },
          reconnect,
        );
      } else reconnect();
    };
  };
  open();

  /**
   * A genuine resume replaces the socket even when it still reports OPEN. A
   * frozen tab routinely wakes holding a socket the server abandoned long ago,
   * and trusting `readyState` there is how a turn's evidence goes missing.
   * Room slices are NOT reset: each room resubscribes from its own cursor.
   */
  // Several signals routinely describe ONE transition — a wake fires
  // visibilitychange and online together, and the watchdog may agree a moment
  // later. Queue them behind a single microtask so the transition produces one
  // replacement instead of a socket per signal.
  let resumeQueued = false;
  const resume = (): void => {
    if (!RESUMABLE.has(state) || resumeQueued) return;
    resumeQueued = true;
    queueMicrotask(() => {
      resumeQueued = false;
      if (!RESUMABLE.has(state)) return;
      open();
      options.onResume?.(currentRoom);
    });
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') resume();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) resume();
  };
  // A network event while backgrounded is not a resume: the tab is not being
  // used, and the visibility transition owns that moment when it comes.
  const onOnline = (): void => {
    if (document.visibilityState === 'visible') resume();
  };

  window.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow as EventListener);
  window.addEventListener('online', onOnline);

  const connector: RoomConnector = {
    room: () => currentRoom,
    state: () => state,
    post: (body: string, opts?: { replyTo?: number; attachments?: string[] }) =>
      send({
        type: 'post',
        room: currentRoom,
        body,
        ...(opts?.replyTo !== undefined && { reply_to: opts.replyTo }),
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    act: (act: Act) => send({ type: 'act', room: currentRoom, act }),
    disconnect: () => {
      // An operator-chosen park: lifecycle events must not undo it.
      state = 'parked-manual';
      clearRetry();
      clearProbes();
      generation += 1;
      retire(socket);
      socket = undefined;
      useClientStore.getState().setConnected(false);
    },
    reconnect: () => {
      // Only the OPERATOR's own park is reconnectable. An upgrade park needs a
      // reload to pick up the new client, and a revoked credential needs
      // re-pairing — reopening either would just repeat the refusal.
      if (state !== 'parked-manual' && state !== 'disconnected') return;
      state = 'disconnected';
      open();
    },
    switchRoom: (room: string) => {
      if (room === currentRoom) return;
      currentRoom = room;
      useClientStore.getState().setActiveRoom(room);
      subscribe(room);
    },
    dispose: () => {
      state = 'disposed';
      clearRetry();
      clearProbes();
      // The page is going away: nothing should still read as connected.
      useClientStore.getState().setConnected(false);
      generation += 1; // any in-flight callback is now superseded
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow as EventListener);
      window.removeEventListener('online', onOnline);
      retire(socket);
      socket = undefined;
    },
  };
  // e2e hook, same contract as the legacy module exposed
  (window as unknown as { __codor?: Connection }).__codor = connector;
  return connector;
}
