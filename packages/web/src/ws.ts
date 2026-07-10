import type { Act, ServerFrame } from '@wireroom/protocol';

import { useRoomStore } from './state.js';

export interface Connection {
  post(body: string, replyTo?: number): void;
  act(act: Act): void;
  disconnect(): void;
  reconnect(): void;
}

export interface ConnectOptions {
  room: string;
  token: string;
  /** ws(s):// origin; defaults to the page origin. */
  origin?: string;
}

// harn:assume client-syncs-by-seq ref=ws-resubscribe-cursor
/**
 * Every (re)connect subscribes with the store's current seq cursor — the
 * server hydrates exactly what changed since, incl. in-place run
 * finalizations that message-id paging could never see. Reconnects are
 * automatic with backoff; `disconnect()` parks the connection (used by the
 * e2e disconnect-during-run test via window.__wireroom).
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

  const open = (): void => {
    manuallyClosed = false;
    socket = new WebSocket(`${origin}/ws?token=${encodeURIComponent(options.token)}`);
    socket.onopen = () => {
      retryMs = 500;
      setConnected(true);
      socket!.send(
        JSON.stringify({
          type: 'subscribe',
          room: options.room,
          since_seq: useRoomStore.getState().seq,
        }),
      );
    };
    socket.onmessage = (event) => {
      applyFrame(JSON.parse(event.data as string) as ServerFrame);
    };
    socket.onclose = () => {
      setConnected(false);
      if (!manuallyClosed) {
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    };
  };
  open();

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const connection: Connection = {
    post: (body, replyTo) =>
      send({ type: 'post', room: options.room, body, ...(replyTo !== undefined && { reply_to: replyTo }) }),
    act: (act) => send({ type: 'act', room: options.room, act }),
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
  (window as unknown as { __wireroom?: Connection }).__wireroom = connection;
  singleton = connection;
  return connection;
}
// harn:end client-syncs-by-seq
