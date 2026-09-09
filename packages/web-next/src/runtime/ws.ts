import type { Act, ServerFrame } from '@codor/protocol';
import type { SubmissionResult } from '../app/pending-submission.js';

export interface PostOptions {
  room?: string;
  replyTo?: number; attachments?: string[];
  voice?: { duration_seconds: number; levels: number[] };
  submissionId?: string;
  retrySubmission?: boolean;
  onResult?: (result: SubmissionResult) => void;
}

import { setActiveBrowserAccessToken } from './crypto.js';
import { HISTORY_PAGE_SIZE, useRoomStore } from './state.js';
import { directCombinedTranscriptHistorySupported } from '../app/compatibility.js';

export interface Connection {
  /** Stable page-memory identity shared by cached/live shells of one session. */
  readonly compositionOwner?: object;
  subscribePostState?(listener: () => void): () => void;
  postStateVersion?(): number;
  stopWaitingForSubmission?(room: string, id: string): boolean;
  readonly postAcknowledgements?: boolean;
  readonly postCorrelations?: boolean;
  /** Local intent admission only; never represents a socket write. */
  readonly localSendAllowed?: boolean;
  enqueueOutgoing?(id: string): boolean;
  forgetSubmission?(id: string): void;
  readonly submissionPending?: boolean;
  post(
    body: string,
    opts?: PostOptions,
  ): boolean;
  // harn:assume scheduled-cards-are-accessible-authoritative-and-nonduplicating ref=correlated-browser-schedule-cancel
  // harn:assume context-reset-requests-settle-by-explicit-ref ref=clear-context-ref-client-transport
  /** Send an act with its caller-owned ref, defaulting schedule cancellation to its stable schedule id. */
  act(act: Act, ref?: string): void;
  /** Address a management act to a captured room without changing selection. */
  actForRoom?(room: string, act: Act, ref?: string): boolean;
  // harn:end context-reset-requests-settle-by-explicit-ref
  // harn:end scheduled-cards-are-accessible-authoritative-and-nonduplicating
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
          // harn:assume combined-history-capability-gates-socket-fallback ref=capability-gated-socket-history
          hydrate_limit: directCombinedTranscriptHistorySupported() ? 0 : HISTORY_PAGE_SIZE,
          // harn:end combined-history-capability-gates-socket-fallback
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

  const send = (frame: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // A socket can close between the readyState check and send(). The caller
      // must be able to preserve a draft instead of believing this was queued.
      return false;
    }
  };

  const connection: Connection = {
    // harn:assume reconnect-safe-post-dispatch-preserves-draft-v3-cached ref=runtime-post-dispatch-result
    post: (body, opts) => send({
      type: 'post',
      room: options.room,
      body,
      ...(opts?.replyTo !== undefined && { reply_to: opts.replyTo }),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.voice !== undefined && { voice: opts.voice }),
    }),
    // harn:end reconnect-safe-post-dispatch-preserves-draft-v3-cached
    // harn:assume channel-archive-ui-captures-source-and-authoritative-result ref=channel-archive-targeted-act
    actForRoom: (room, act, ref) => {
      const correlationRef = ref ?? (act.act === 'cancel_schedule' ? act.schedule_id : undefined);
      return send({
        type: 'act', room, act,
        ...(correlationRef !== undefined && { ref: correlationRef }),
      });
    },
    act: (act, ref) => {
      const correlationRef = ref ?? (act.act === 'cancel_schedule' ? act.schedule_id : undefined);
      send({
        type: 'act', room: options.room, act,
        ...(correlationRef !== undefined && { ref: correlationRef }),
      });
    },
    // harn:end channel-archive-ui-captures-source-and-authoritative-result
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
