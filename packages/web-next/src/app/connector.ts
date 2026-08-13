// Scoped room connector: the legacy socket module is a page singleton pinned to
// one room, so in-place channel switching (Richard's decision — no reloads) gets
// its own connector with the SAME wire semantics: subscribe with the store's seq
// cursor, apply frames, exponential backoff, 4401 token refresh, 4403 park.
// Switching rooms is MULTIPLEXED on the one socket: it subscribes to the next
// room and keeps every other subscription and the shared store intact. It does
// not close the socket and does not reset the store — the previous comment here
// described behaviour this connector has not had since in-place switching.
import { BROWSER_PROTOCOL_EPOCH, type Act, type ServerFrame } from '@codor/protocol';

import { setActiveBrowserAccessToken } from '@runtime/crypto.js';
import type { TunnelState, TunnelStateListener } from '@runtime/relay.js';
import type { Connection } from '@runtime/ws.js';

import {
  HISTORY_PAGE_SIZE,
  roomSlice,
  suppressRunEventRecovery,
  useClientStore,
  type ClientStore,
} from './store.js';
import { requireBrowserUpgrade } from './compatibility.js';

export interface RoomConnector extends Connection {
  /** Select another already-multiplexed room without replacing the socket. */
  switchRoom(room: string): void;
  room(): string;
  /** What this connector is doing — resume legality depends on it. */
  state(): ConnectorState;
  // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-observed-room-subscriptions
  /** Maintain the desired observation set: the public root PLUS its registered
   *  child conversations, so a reconnect while a child is selected still
   *  observes main and every active sibling. Members subscribe on the existing
   *  multiplexed socket from their own committed cursors and are resubscribed
   *  after EVERY legal reconnect; rooms dropped from the set simply stop being
   *  resubscribed. The connector's public-root identity is unchanged. */
  setDesiredRooms(rooms: readonly string[]): void;
  /** Exact-room readiness for the CURRENT socket generation: offline while the
   *  socket is down, connecting until THIS generation delivers that room's own
   *  addressed sync_complete. Retained hydration from a prior generation is
   *  last-good content only and never marks a room live. */
  roomReadiness(room: string): 'connecting' | 'connected' | 'offline' | 'unsubscribed';
  // harn:end worktree-conversation-status-is-live-and-independent
  /** Release every listener, timer and socket this connector owns. */
  dispose(): void;
}

export interface ConnectorOptions {
  room: string;
  token: string;
  /** ws(s):// origin; defaults to the page origin. Set to the relay origin when
   *  the browser reaches its switchboard through the blind relay tunnel. */
  origin?: string;
  /** Injectable for tests AND the relay tunnel; production direct-path
   *  constructs a real WebSocket to the page origin. Re-invoked on EVERY
   *  (re)open, so when the tunnel session drops and closes the app-WS socket,
   *  the next open builds a fresh app-WS stream on the NEW session. */
  socketFactory?: (url: string) => WebSocket;
  /** Isolated session store. Omitted by the direct/self-hosted singleton path. */
  store?: ClientStore;
  /** Session-local token sink. Defaults to the legacy active-token singleton. */
  setToken?: (token: string) => string;
  /** Whether this connector owns the legacy e2e window hook. */
  expose?: boolean;
  /** Called for EVERY legal resume — lifecycle or watchdog — so recovery work
   *  that must follow a replacement has one place to live. */
  onResume?: (room: string) => void;
  /** Session managers park inactive incompatible computers locally and publish
   *  the global gate only if that computer is selected. */
  onUpgradeRequired?: (frame: Extract<ServerFrame, { type: 'upgrade_required' }>) => void;
  refreshToken?: () => Promise<string>;
  /** Hosted-only tunnel generation gate. Direct/self-hosted callers omit it. */
  tunnel?: {
    readonly state: TunnelState;
    readonly generation: number;
    whenReady(): Promise<number>;
    recover(): void;
    subscribe(listener: TunnelStateListener): () => void;
  };
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
  const origin = (options.origin ?? window.location.origin).replace(/^http/, 'ws');
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const clientStore = options.store ?? useClientStore;
  const setToken = options.setToken ?? setActiveBrowserAccessToken;
  let currentRoom = options.room;
  let socket: WebSocket | undefined;
  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-router
  /** Correlated acts keep their source room across in-place selection changes. */
  const actionRooms = new Map<string, string>();
  const rememberActionRoom = (ref: string, room: string): void => {
    actionRooms.set(ref, room);
    while (actionRooms.size > 64) {
      const oldest = actionRooms.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      actionRooms.delete(oldest);
    }
  };
  // harn:end context-reset-confirmation-is-anchored-and-member-local
  let subscribed = new Set<string>();
  /** Highest cold-history budget requested in this socket generation. */
  let subscriptionBudgets = new Map<string, number>();
  /** Rooms whose twenty-message promotion completed in any generation. */
  const historyHydrated = new Set<string>();
  /** Rooms that completed a metadata-only cold hydrate and still need promotion. */
  const zeroHydrated = new Set<string>();
  // Hidden child conversations the group view wants live. They ride the same
  // multiplexed socket and resubscribe from their own cursors on every open.
  let desiredRooms = new Set<string>();
  // Rooms with an in-flight reconciliation resync, mapped to the server seq we
  // are catching up to. One resync per room; reset with the socket generation.
  let resyncing = new Map<string, number>();
  // harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-observed-room-subscriptions
  // Rooms proven live in the CURRENT socket generation by their own addressed
  // sync_complete. Reset on every replacement; a hydrated slice retained from a
  // prior generation is last-good content, never readiness evidence. The same
  // evidence is mirrored into the client store for reactive row projection.
  let liveRooms = new Set<string>();
  // harn:end worktree-conversation-status-is-live-and-independent
  let state: ConnectorState = 'disconnected';
  let retryMs = 500;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // The foreground watchdog: a socket can stay OPEN while the server has long
  // since stopped answering it — no visibility change, no offline event, no
  // close. On an always-active desktop nothing else would ever notice.
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let probeDeadline: ReturnType<typeof setTimeout> | undefined;
  let awaitingProbe = false;
  let foregroundProbePending = false;
  let token = options.token;
  // Every socket carries the generation that created it. A frozen tab can hand
  // back events from a socket we already replaced; without this they would
  // reset `connected`, schedule retries, or resubscribe on a dead wire.
  let generation = 0;
  let openedTunnelGeneration: number | undefined;
  let waitingTunnelGeneration: number | undefined;
  let resumeAfterTunnel = false;

  clientStore.getState().setActiveRoom(currentRoom);

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
    foregroundProbePending = false;
  };

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  // harn:assume hosted-background-rooms-hydrate-metadata-until-promoted ref=background-room-promotion
  const subscribe = (room: string, hydrateLimit: number): void => {
    const priorBudget = subscriptionBudgets.get(room);
    if ((priorBudget ?? -1) >= hydrateLimit || socket?.readyState !== WebSocket.OPEN) return;
    const promote = hydrateLimit > 0 && zeroHydrated.has(room) && !historyHydrated.has(room);
    subscribed.add(room);
    subscriptionBudgets.set(room, hydrateLimit);
    const sinceSeq = promote ? 0 : roomSlice(clientStore.getState(), room).seq;
    if (promote) {
      // harn:assume subscribed-live-run-events-survive-switch-and-history-retirement ref=connector-recovery-boundary
      // A zero-hydrated room is being promoted, not reconnected. Its next
      // sync_complete must not turn a preserved background buffer into a
      // journal-recovery request.
      suppressRunEventRecovery(clientStore, room);
      // harn:end subscribed-live-run-events-survive-switch-and-history-retirement
    }
    if (typeof window !== 'undefined') {
      (window as unknown as {
        __codorRoomSubscribes?: Array<{ room: string; hydrateLimit: number; sinceSeq: number }>;
      }).__codorRoomSubscribes?.push({ room, hydrateLimit, sinceSeq });
    }
    send({
      type: 'subscribe',
      room,
      // Each room resumes from ITS OWN committed cursor, so a resubscribe
      // replays only what that room missed and never re-hydrates it.
      since_seq: sinceSeq,
      hydrate_limit: hydrateLimit,
      room_addressed: true,
      browser_protocol: BROWSER_PROTOCOL_EPOCH,
      client_kind: 'browser',
    });
  };
  // harn:end hosted-background-rooms-hydrate-metadata-until-promoted

  /**
   * Warm-resync a room that fell behind, bypassing the `subscribed` guard: it is
   * already subscribed, so we only replay the delta from its committed cursor.
   */
  const resync = (room: string, sinceSeq: number): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    send({
      type: 'subscribe',
      room,
      since_seq: sinceSeq,
      hydrate_limit: HISTORY_PAGE_SIZE,
      room_addressed: true,
      browser_protocol: BROWSER_PROTOCOL_EPOCH,
      client_kind: 'browser',
    });
  };

  /**
   * Reconcile subscribed rooms against the server's per-room seqs carried on the
   * `rooms` reply (the watchdog probe already ticks it). A room whose committed
   * cursor trails the server gets ONE in-flight warm resync; the marker clears
   * once the cursor catches up, so a future lag re-arms. Rooms only just
   * subscribed this round are hydrating already and are skipped, as is an older
   * server that omits the field (graceful no-op). A spurious lag — a frame in
   * flight when the reply was computed — resyncs to an empty delta, harmless.
   */
  const reconcile = (roomSeqs: Record<string, number> | undefined, priorSubscribed: Set<string>): void => {
    if (roomSeqs === undefined) return;
    const store = clientStore.getState();
    for (const [room, serverSeq] of Object.entries(roomSeqs)) {
      if (!priorSubscribed.has(room)) continue;
      const committed = roomSlice(store, room).seq;
      const target = resyncing.get(room);
      if (target !== undefined) {
        if (committed >= target) resyncing.delete(room);
        else continue; // one in-flight resync per room
      }
      if (serverSeq > committed) {
        resyncing.set(room, serverSeq);
        resync(room, committed);
      }
    }
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
  // harn:assume foreground-watchdog-probes-are-refresh-neutral ref=watchdog-probe-state
  const probeNow = (mine: number, fromForeground = false): void => {
    if (mine !== generation || state !== 'connected') return;
    if (document.visibilityState !== 'visible') return;
    if (options.tunnel?.state !== undefined && options.tunnel.state !== 'connected') {
      resume();
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) {
      resume();
      return;
    }
    if (awaitingProbe) {
      // A wake that overlaps the watchdog consumes its already outstanding
      // reply, rather than creating a second list_rooms request.
      if (fromForeground) foregroundProbePending = true;
      return;
    }
    awaitingProbe = true;
    foregroundProbePending = fromForeground;
    send({ type: 'list_rooms' });
    probeDeadline = setTimeout(() => {
      if (mine !== generation || !awaitingProbe) return;
      // Unanswered: the socket lies about being open. Go through the SAME
      // resume path, so a manual or upgrade park is still respected.
      awaitingProbe = false;
      resume();
    }, PROBE_TIMEOUT_MS);
  };

  const startProbes = (mine: number): void => {
    clearProbes();
    // Test seam: e2e sets a short cadence to exercise seq reconciliation without
    // a wall-clock wait; production uses the fixed foreground interval.
    const interval = (window as unknown as { __codorProbeMs?: number }).__codorProbeMs ?? PROBE_INTERVAL_MS;
    probeTimer = setInterval(() => probeNow(mine), interval);
  };
  // harn:end foreground-watchdog-probes-are-refresh-neutral

  const waitForTunnel = (accelerate = false): void => {
    const tunnel = options.tunnel;
    if (!tunnel || !RESUMABLE.has(state)) return;
    clientStore.getState().setConnected(false);
    if (accelerate) tunnel.recover();
    const wanted = tunnel.generation;
    if (waitingTunnelGeneration === wanted) return;
    waitingTunnelGeneration = wanted;
    void tunnel.whenReady().then(
      (ready) => {
        if (waitingTunnelGeneration === wanted) waitingTunnelGeneration = undefined;
        if (ready !== tunnel.generation || tunnel.state !== 'connected' || !RESUMABLE.has(state)) return;
        open(false);
      },
      () => {
        if (waitingTunnelGeneration === wanted) waitingTunnelGeneration = undefined;
        if (RESUMABLE.has(state)) waitForTunnel();
      },
    );
  };

  // harn:assume hosted-app-streams-follow-tunnel-generations ref=generation-gated-app-connector
  // harn:assume relay-app-socket-readiness-requires-server-evidence ref=relay-app-socket-readiness
  function open(force = false): void {
    if (state === 'disposed') return;
    const tunnel = options.tunnel;
    if (tunnel) {
      if (tunnel.state !== 'connected') {
        waitForTunnel();
        return;
      }
      if (!force && openedTunnelGeneration === tunnel.generation) return;
      openedTunnelGeneration = tunnel.generation;
    }
    clearRetry();
    clearProbes();
    // Starting a replacement generation withdraws send admission immediately.
    // In relay mode the next WebSocket OPEN is optimistic: it proves only that
    // the mux stream exists, not that the host loopback can carry app frames.
    clientStore.getState().setConnected(false);
    const mine = ++generation;
    retire(socket);
    subscribed = new Set();
    subscriptionBudgets = new Map();
    resyncing = new Map();
    // A new socket generation withdraws every prior live proof: each desired
    // room reads connecting (or offline until server evidence) until THIS
    // generation delivers its own addressed sync_complete. Retained hydration
    // keeps rendering last-good content but never marks readiness.
    clientStore.getState().markRoomsConnecting([...liveRooms, currentRoom, ...desiredRooms]);
    liveRooms = new Set();
    socket = socketFactory(`${origin}/ws?token=${encodeURIComponent(token)}`);
    const live = (): boolean => mine === generation && state !== 'disposed';

    socket.onopen = () => {
      if (!live()) return;
      retryMs = 500;
      state = 'connected';
      // The selected room hydrates first; the rooms listing then fans the same
      // socket out to every other authorized room, each from its own cursor.
      subscribe(currentRoom, HISTORY_PAGE_SIZE);
      for (const desired of desiredRooms) subscribe(desired, HISTORY_PAGE_SIZE);
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
        clientStore.getState().setConnected(false);
        if (options.onUpgradeRequired) options.onUpgradeRequired(frame);
        else requireBrowserUpgrade(frame);
        retire(socket);
        socket = undefined;
        return;
      }
      // A frame from the current generation is the first bidirectional evidence
      // that the server-side app socket is usable. Only now may the composer
      // trust `connected` and admit a post.
      clientStore.getState().setConnected(true);
      // harn:assume context-reset-requests-settle-by-explicit-ref ref=clear-context-ref-client-result
      const frameRef = 'ref' in frame ? frame.ref : undefined;
      const resultRoom = frameRef === undefined ? undefined : actionRooms.get(frameRef);
      clientStore.getState().applyFrame(frame, resultRoom ?? currentRoom);
      // One explicit result retires one source-room mapping. Unmatched refs are
      // deliberately allowed to use the current-room fallback for legacy frames.
      if (frameRef !== undefined && frame.type !== 'rooms') actionRooms.delete(frameRef);
      // harn:end context-reset-requests-settle-by-explicit-ref
      if (frame.type === 'sync_complete') {
        // Only THIS room's own addressed completion marks it live — one frame
        // never stands in for a sibling's hydration. Frames from a retired
        // socket are already dropped by the live() guard above.
        const completed = frame.room ?? currentRoom;
        if ((subscriptionBudgets.get(completed) ?? 0) > 0) {
          historyHydrated.add(completed);
          zeroHydrated.delete(completed);
        } else if (!historyHydrated.has(completed)) {
          zeroHydrated.add(completed);
        }
        liveRooms.add(completed);
        clientStore.getState().markRoomLive(completed);
      }
      // harn:assume foreground-watchdog-probes-are-refresh-neutral ref=watchdog-probe-reply
      if (frame.type === 'rooms') {
        const foregroundProbe = foregroundProbePending;
        awaitingProbe = false;
        foregroundProbePending = false;
        if (probeDeadline !== undefined) clearTimeout(probeDeadline);
        probeDeadline = undefined;
        // Reconcile rooms we already held BEFORE this round subscribes any new
        // ones — a freshly subscribed room is hydrating and needs no resync.
        const priorSubscribed = new Set(subscribed);
        for (const room of frame.rooms) {
          const foreground = room.id === currentRoom || desiredRooms.has(room.id);
          subscribe(room.id, foreground ? HISTORY_PAGE_SIZE : 0);
        }
        reconcile(frame.room_seqs, priorSubscribed);
        if (foregroundProbe) options.onResume?.(currentRoom);
      }
      // harn:end foreground-watchdog-probes-are-refresh-neutral
    };
  // harn:end relay-app-socket-readiness-requires-server-evidence
    socket.onclose = (event) => {
      if (!live()) return;
      clearProbes();
      if (state === 'connected' || state === 'disconnected') state = 'disconnected';
      clientStore.getState().setConnected(false);
      if (state !== 'disconnected') return; // parked or disposed: stay put
      if (event.code === 4403) {
        // The credential was revoked. Reopening with it would hammer the server
        // with a token it has already refused, so this park is absolute: no
        // lifecycle resume and no deliberate reconnect leaves it. Re-pairing
        // (a fresh page) is the only way out.
        state = 'parked-auth';
        // Positive pairing-dead evidence for the recovery surface: the host is up
        // (we had a working session) and turned this browser's credential away.
        clientStore.getState().setAuthRefused(true);
        setToken('');
        return;
      }
      const reconnect = (): void => {
        if (!live() || state !== 'disconnected') return;
        if (options.tunnel?.state !== undefined && options.tunnel.state !== 'connected') {
          waitForTunnel();
          return;
        }
        clearRetry();
        retryTimer = setTimeout(() => open(true), retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
      if (event.code === 4401 && options.refreshToken) {
        void options.refreshToken().then(
          (refreshed) => {
            if (!live()) return;
            token = setToken(refreshed);
            reconnect();
          },
          reconnect,
        );
      } else reconnect();
    };
    if (resumeAfterTunnel && tunnel) {
      resumeAfterTunnel = false;
      options.onResume?.(currentRoom);
    }
  }
  open();
  // harn:end hosted-app-streams-follow-tunnel-generations

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
      if (options.tunnel) {
        resumeAfterTunnel = true;
        waitForTunnel(true);
      } else {
        open(true);
        options.onResume?.(currentRoom);
      }
    });
  };

  // harn:assume hosted-foregrounding-reuses-healthy-sessions ref=foreground-health-probe
  const onForeground = (): void => {
    if (document.visibilityState !== 'visible') return;
    // Direct/self-hosted connectors retain their established replacement path;
    // only a tunnel-backed session can safely probe and reuse a healthy socket.
    if (!options.tunnel) {
      resume();
      return;
    }
    if (
      state !== 'connected'
      || socket?.readyState !== WebSocket.OPEN
      || (options.tunnel?.state !== undefined && options.tunnel.state !== 'connected')
    ) {
      resume();
      return;
    }
    probeNow(generation, true);
  };
  // harn:end hosted-foregrounding-reuses-healthy-sessions
  const onVisibility = onForeground;
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) onForeground();
  };
  // A network event while backgrounded is not a resume: the tab is not being
  // used, and the visibility transition owns that moment when it comes.
  const onOnline = (): void => {
    onForeground();
  };

  window.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow as EventListener);
  window.addEventListener('online', onOnline);

  const stopTunnel = options.tunnel?.subscribe((tunnelState, tunnelGeneration) => {
    if (!RESUMABLE.has(state)) return;
    if (tunnelState !== 'connected') {
      clearRetry();
      clearProbes();
      state = 'disconnected';
      clientStore.getState().setConnected(false);
      generation += 1;
      retire(socket);
      socket = undefined;
      waitForTunnel();
      return;
    }
    if (tunnelGeneration !== options.tunnel?.generation) return;
    open(false);
  }) ?? (() => undefined);

  const connector: RoomConnector = {
    room: () => currentRoom,
    state: () => state,
    post: (
      body: string,
      opts?: { replyTo?: number; attachments?: string[]; voice?: { duration_seconds: number; levels: number[] } },
    ) =>
      send({
        type: 'post',
        room: currentRoom,
        body,
        ...(opts?.replyTo !== undefined && { reply_to: opts.replyTo }),
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
        ...(opts?.voice !== undefined && { voice: opts.voice }),
      }),
    // harn:assume scheduled-cards-are-accessible-authoritative-and-nonduplicating ref=correlated-browser-schedule-cancel-regression
    // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-router
    act: (act: Act, ref?: string): void => {
      const correlationRef = ref ?? (act.act === 'cancel_schedule' ? act.schedule_id : undefined);
      const sourceRoom = currentRoom;
      if (correlationRef !== undefined) rememberActionRoom(correlationRef, sourceRoom);
      send({
        type: 'act', room: sourceRoom, act,
        ...(correlationRef !== undefined && { ref: correlationRef }),
      });
    },
    // harn:end context-reset-confirmation-is-anchored-and-member-local
    // harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
    disconnect: () => {
      // An operator-chosen park: lifecycle events must not undo it.
      state = 'parked-manual';
      clearRetry();
      clearProbes();
      generation += 1;
      retire(socket);
      socket = undefined;
      clientStore.getState().setConnected(false);
    },
    reconnect: () => {
      // Only the OPERATOR's own park is reconnectable. An upgrade park needs a
      // reload to pick up the new client, and a revoked credential needs
      // re-pairing — reopening either would just repeat the refusal.
      if (state !== 'parked-manual' && state !== 'disconnected') return;
      state = 'disconnected';
      open(true);
    },
    switchRoom: (room: string) => {
      if (room === currentRoom) return;
      currentRoom = room;
      clientStore.getState().setActiveRoom(room);
      subscribe(room, HISTORY_PAGE_SIZE);
    },
    setDesiredRooms: (rooms: readonly string[]) => {
      desiredRooms = new Set(rooms);
      for (const desired of desiredRooms) subscribe(desired, HISTORY_PAGE_SIZE);
    },
    roomReadiness: (room: string) => {
      if (room !== currentRoom && !desiredRooms.has(room)) return 'unsubscribed';
      if (state !== 'connected') return 'offline';
      // Live requires THIS generation's own sync_complete: a room rejoining
      // the desired set mid-generation keeps the proof it already earned this
      // generation, while a replaced socket cleared every prior proof.
      return liveRooms.has(room) ? 'connected' : 'connecting';
    },
    dispose: () => {
      state = 'disposed';
      clearRetry();
      clearProbes();
      // The page is going away: nothing should still read as connected.
      clientStore.getState().setConnected(false);
      generation += 1; // any in-flight callback is now superseded
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow as EventListener);
      window.removeEventListener('online', onOnline);
      stopTunnel();
      actionRooms.clear();
      retire(socket);
      socket = undefined;
    },
  };
  // e2e hook, same contract as the legacy module exposed
  if (options.expose ?? options.store === undefined) {
    (window as unknown as { __codor?: Connection }).__codor = connector;
  }
  return connector;
}
