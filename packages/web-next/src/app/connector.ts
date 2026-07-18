// Scoped room connector: the legacy socket module is a page singleton pinned to
// one room, so in-place channel switching (Richard's decision — no reloads) gets
// its own connector with the SAME wire semantics: subscribe with the store's seq
// cursor, apply frames, exponential backoff, 4401 token refresh, 4403 park.
// Switching rooms closes the socket, resets the store, and resubscribes fresh.
import type { Act, ServerFrame } from '@codor/protocol';

import { setActiveBrowserAccessToken } from '@legacy/crypto.js';
import { HISTORY_PAGE_SIZE, useRoomStore } from '@legacy/state.js';
import type { Connection } from '@legacy/ws.js';

export interface RoomConnector extends Connection {
  /** Close, reset the store, and resubscribe to another room in place. */
  switchRoom(room: string): void;
  room(): string;
}

export interface ConnectorOptions {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
}

export function createConnector(options: ConnectorOptions): RoomConnector {
  const { applyFrame, setConnected } = useRoomStore.getState();
  const origin = window.location.origin.replace(/^http/, 'ws');
  let currentRoom = options.room;
  let socket: WebSocket | undefined;
  let manuallyClosed = false;
  let retryMs = 500;
  let token = options.token;

  const open = (): void => {
    manuallyClosed = false;
    socket = new WebSocket(`${origin}/ws?token=${encodeURIComponent(token)}`);
    const openedFor = currentRoom;
    socket.onopen = () => {
      retryMs = 500;
      setConnected(true);
      socket!.send(JSON.stringify({
        type: 'subscribe',
        room: openedFor,
        since_seq: useRoomStore.getState().seq,
        // Cold loads want the tail, not the whole room. The server ignores this
        // on a warm resubscribe, so a reconnect still replays every change.
        hydrate_limit: HISTORY_PAGE_SIZE,
      }));
    };
    socket.onmessage = (event) => {
      // A frame racing in for a room we already left must not pollute the store.
      if (openedFor !== currentRoom) return;
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

  const connector: RoomConnector = {
    room: () => currentRoom,
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
      manuallyClosed = true;
      socket?.close();
    },
    reconnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return;
      open();
    },
    switchRoom: (room: string) => {
      if (room === currentRoom) return;
      manuallyClosed = true;
      socket?.close();
      currentRoom = room;
      useRoomStore.getState().reset();
      open();
    },
  };
  // e2e hook, same contract as the legacy module exposed
  (window as unknown as { __codor?: Connection }).__codor = connector;
  return connector;
}
