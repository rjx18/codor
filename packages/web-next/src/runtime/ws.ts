import type { Act, ServerFrame } from '@codor/protocol';

import { setActiveBrowserAccessToken } from './crypto.js';
import { HISTORY_PAGE_SIZE, useRoomStore } from './state.js';

export interface Connection {
  post(
    body: string,
    opts?: { replyTo?: number; attachments?: string[]; voice?: { duration_seconds: number; levels: number[] } },
  ): void;
  // harn:assume context-reset-requests-settle-by-explicit-ref ref=clear-context-ref-client-transport
  /** Send an act with its caller-owned bounded correlation ref when supplied. */
  act(act: Act, ref?: string): void;
  // harn:end context-reset-requests-settle-by-explicit-ref
  disconnect(): void;
  reconnect(): void;
}

export interface ConnectOptions {
  room: string;
  token: string;
  /** ws(s):// origin; defaults to the page origin. */
  origin?: string;
  /** Re-authenticates a paired browser after a server restart invalidates its page session. */
  refreshToken?: () => Promise<string>;
  /**
   * Socket constructor seam (relay tunnel). Re-invoked on EVERY (re)connect, so
   * when the tunnel session drops and closes the app-WS socket, this reconnect
   * builds a fresh app-WS stream on the NEW session — never reuses a dead socket
   * or a stale session. Defaults to the direct browser WebSocket.
   */
  socketFactory?: (url: string) => WebSocket;
}

// harn:assume client-syncs-by-seq ref=ws-resubscribe-cursor
/**
 * Every (re)connect subscribes with the store's current seq cursor — the
 * server hydrates exactly what changed since, incl. in-place run
 * finalizations that message-id paging could never see. Reconnects are
 * automatic with backoff; `disconnect()` parks the connection (used by the
 * e2e disconnect-during-run test via window.__codor).
 */
let singleton: Connection | undefined;

export function connect(options: ConnectOptions): Connection {
  // One socket per page — StrictMode double-mounts must not leak a second
  // subscription (a zombie socket would keep applying frames after
  // disconnect(), breaking the reconnect-by-seq contract).
  if (singleton) return singleton;
  const { applyFrame, setConnected } = useRoomStore.getState();
  const origin =
    options.origin ?? window.location.origin.replace(/^http/, 'ws');
  let socket: WebSocket | undefined;
  let manuallyClosed = false;
  let retryMs = 500;
  let token = options.token;
  const makeSocket = options.socketFactory ?? ((url: string) => new WebSocket(url));

  const open = (): void => {
    manuallyClosed = false;
    socket = makeSocket(`${origin}/ws?token=${encodeURIComponent(token)}`);
    socket.onopen = () => {
      retryMs = 500;
      setConnected(true);
      socket!.send(
        JSON.stringify({
          type: 'subscribe',
          room: options.room,
          since_seq: useRoomStore.getState().seq,
          // A viewer wants the tail, not the room's whole history. Ignored by the
          // server on a warm resubscribe, so a reconnect still replays every change.
          hydrate_limit: HISTORY_PAGE_SIZE,
        }),
      );
    };
    socket.onmessage = (event) => {
      applyFrame(JSON.parse(event.data as string) as ServerFrame);
    };
    socket.onclose = (event) => {
      setConnected(false);
      if (manuallyClosed) return;
      if (event.code === 4403) {
        setActiveBrowserAccessToken('');
        return;
      }
      const reconnect = (): void => {
        if (manuallyClosed) return;
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
      if (event.code === 4401 && options.refreshToken) {
        void options.refreshToken().then(
          (refreshed) => {
            token = setActiveBrowserAccessToken(refreshed);
            reconnect();
          },
          reconnect,
        );
      } else reconnect();
    };
  };
  open();

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const connection: Connection = {
    post: (body, opts) =>
      send({
        type: 'post',
        room: options.room,
        body,
        ...(opts?.replyTo !== undefined && { reply_to: opts.replyTo }),
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
        ...(opts?.voice !== undefined && { voice: opts.voice }),
      }),
    // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-result-router
    act: (act, ref) => send({
      type: 'act',
      room: options.room,
      ...(ref !== undefined && { ref }),
      act,
    }),
    // harn:end context-reset-confirmation-is-anchored-and-member-local
    disconnect: () => {
      manuallyClosed = true;
      socket?.close();
    },
    reconnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return;
      open();
    },
  };
  // e2e hook: lets tests sever and re-establish the socket deterministically
  (window as unknown as { __codor?: Connection }).__codor = connection;
  singleton = connection;
  return connection;
}
// harn:end client-syncs-by-seq
