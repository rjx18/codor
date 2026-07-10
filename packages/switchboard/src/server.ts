import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientFrameSchema, RoomIdSchema, type ServerFrame } from '@wireroom/protocol';

import type { Daemon } from './daemon.js';

export interface ServerOptions {
  daemon: Daemon;
  /** Single pairing token — the authenticated principal IS the room owner. */
  token: string;
  host?: string;
  port?: number;
  /** Serve the built web SPA from this directory (the switchboard IS the web host). */
  staticRoot?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  close(): Promise<void>;
}

/**
 * The API surface: one WebSocket (subscribe/post/act) + small REST (sync,
 * blob fetch, room + member management). Everything served here has already
 * passed the daemon's redaction projection.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { daemon, token } = options;
  // harn:assume server-token-required ref=token-validation
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('startServer requires a non-empty authentication token');
  }
  // harn:end server-token-required
  const app = Fastify();

  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const header = req.headers.authorization;
    const query = (req.query as { token?: string }).token;
    if (header === `Bearer ${token}` || query === token) return true;
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  };

  app.get('/api/rooms', (req, reply) => {
    if (!authed(req, reply)) return;
    void reply.send({ rooms: daemon.store.listRooms() });
  });

  app.post('/api/rooms', (req, reply) => {
    if (!authed(req, reply)) return;
    const body = req.body as { id: string; name: string; owner: { handle: string; display_name: string } };
    RoomIdSchema.parse(body.id);
    const created = daemon.createRoom(body);
    void reply.send(created);
  });

  app.get('/api/rooms/:room/sync', (req, reply) => {
    if (!authed(req, reply)) return;
    const { room } = req.params as { room: string };
    const sinceSeq = Number((req.query as { since_seq?: string }).since_seq ?? 0);
    try {
      void reply.send(daemon.sync(room, sinceSeq));
    } catch {
      void reply.code(404).send({ error: `no such room ${room}` });
    }
  });

  app.get('/api/rooms/:room/runs/:msgId', (req, reply) => {
    if (!authed(req, reply)) return;
    const { room, msgId } = req.params as { room: string; msgId: string };
    void reply.send({ events: daemon.readRunBlob(room, Number(msgId)) });
  });

  app.post('/api/rooms/:room/members', (req, reply) => {
    if (!authed(req, reply)) return;
    const { room } = req.params as { room: string };
    const body = req.body as { harness: string; handle: string; cwd: string; policy?: string; model?: string };
    void reply.send(daemon.spawnMember(room, body));
  });

  if (options.staticRoot !== undefined) {
    await app.register(fastifyStatic, { root: options.staticRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html'); // SPA fallback
    });
  }

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // ── WebSocket: subscribe / post / act ─────────────────────────────────
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });
  const subscriptions = new Map<WebSocket, Set<string>>();

  const unsubscribeFrames = daemon.onFrame((room, frame) => {
    for (const [socket, rooms] of subscriptions) {
      if (rooms.has(room) && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    }
  });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== token) {
      socket.close(4401, 'unauthorized');
      return;
    }
    subscriptions.set(socket, new Set());
    socket.on('close', () => subscriptions.delete(socket));

    const send = (frame: ServerFrame): void => {
      socket.send(JSON.stringify(frame));
    };

    socket.on('message', (raw: Buffer) => {
      let frame;
      try {
        frame = ClientFrameSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        return send({ type: 'error', message: `invalid frame: ${String(error)}` });
      }
      try {
        if (frame.type === 'subscribe') {
          subscriptions.get(socket)!.add(frame.room);
          // hydrate everything changed since the client's cursor
          const sync = daemon.sync(frame.room, frame.since_seq);
          const hydrationCursor = frame.since_seq;
          send({ type: 'room', seq: hydrationCursor, room: sync.room });
          for (const member of sync.members) send({ type: 'member', seq: hydrationCursor, member });
          for (const message of sync.messages) send({ type: 'message', seq: hydrationCursor, message });
          for (const delivery of sync.inbox) send({ type: 'inbox', seq: hydrationCursor, delivery });
          for (const meter of sync.meters) send({ type: 'meter', seq: hydrationCursor, meter });
          send({ type: 'sync_complete', seq: sync.seq });
        } else if (frame.type === 'post') {
          daemon.postHumanMessage(frame.room, frame.body, { reply_to: frame.reply_to });
        } else if (frame.type === 'act') {
          const act = frame.act;
          if (act.act === 'answer_interaction') {
            void daemon
              .answerInteraction(frame.room, act.interaction_id, act.answer)
              .catch((error: unknown) =>
                send({ type: 'error', message: String(error), ref: 'answer_interaction' }),
              );
          } else if (act.act === 'redeliver') daemon.redeliver(frame.room, act.delivery_id);
          else if (act.act === 'release_hold') daemon.releaseHold(frame.room, act.delivery_id);
          else if (act.act === 'mark_read') daemon.markRead(frame.room, act.delivery_id);
          else if (act.act === 'spawn') {
            daemon.spawnMember(frame.room, {
              harness: act.harness,
              handle: act.handle,
              cwd: act.cwd,
              policy: act.policy,
              model: act.model,
            });
          } else if (act.act === 'rename') daemon.renameMember(frame.room, act.member_id, act.handle, act.display_name);
          else if (act.act === 'revive') daemon.reviveMember(frame.room, act.member_id);
          else if (act.act === 'interrupt') daemon.interruptMember(frame.room, act.member_id);
        }
      } catch (error) {
        send({ type: 'error', message: String(error), ref: frame.type });
      }
    });
  });

  return {
    app,
    port,
    close: async () => {
      unsubscribeFrames();
      wss.close();
      await app.close();
    },
  };
}
