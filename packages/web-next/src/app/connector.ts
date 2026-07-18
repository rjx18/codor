// Scoped room connector: the legacy socket module is a page singleton pinned to
// one room, so in-place channel switching (Richard's decision — no reloads) gets
// its own connector with the SAME wire semantics: subscribe with the store's seq
// cursor, apply frames, exponential backoff, 4401 token refresh, 4403 park.
// Switching rooms closes the socket, resets the store, and resubscribes fresh.
import type { Act, ServerFrame } from '@codor/protocol';

import { setActiveBrowserAccessToken } from '@legacy/crypto.js';
import type { Connection } from '@legacy/ws.js';

import { HISTORY_PAGE_SIZE, roomSlice, useClientStore } from './store.js';

export interface RoomConnector extends Connection {
  /** Select another already-multiplexed room without replacing the socket. */
  switchRoom(room: string): void;
  room(): string;
}

export interface ConnectorOptions {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
}

export function createConnector(options: ConnectorOptions): RoomConnector {
  const origin = window.location.origin.replace(/^http/, 'ws');
  let currentRoom = options.room;
  let socket: WebSocket | undefined;
  let subscribed = new Set<string>();
  let manuallyClosed = false;
  let retryMs = 500;
  let token = options.token;

  useClientStore.getState().setActiveRoom(currentRoom);

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const subscribe = (room: string): void => {
    if (subscribed.has(room) || socket?.readyState !== WebSocket.OPEN) return;
    subscribed.add(room);
    send({
      type: 'subscribe',
      room,
      since_seq: roomSlice(useClientStore.getState(), room).seq,
      hydrate_limit: HISTORY_PAGE_SIZE,
      room_addressed: true,
    });
  };

  const open = (): void => {
    manuallyClosed = false;
    subscribed = new Set();
    socket = new WebSocket(`${origin}/ws?token=${encodeURIComponent(token)}`);
    socket.onopen = () => {
      retryMs = 500;
      useClientStore.getState().setConnected(true);
      // The selected room hydrates first; the rooms listing then fans the same
      // socket out to every other authorized room.
      subscribe(currentRoom);
      send({ type: 'list_rooms' });
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as ServerFrame;
      useClientStore.getState().applyFrame(frame, currentRoom);
      if (frame.type === 'rooms') {
        for (const room of frame.rooms) subscribe(room.id);
      }
    };
    socket.onclose = (event) => {
      useClientStore.getState().setConnected(false);
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
      currentRoom = room;
      useClientStore.getState().setActiveRoom(room);
      subscribe(room);
    },
  };
  // e2e hook, same contract as the legacy module exposed
  (window as unknown as { __codor?: Connection }).__codor = connector;
  return connector;
}
