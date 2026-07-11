import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { dirname } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientFrameSchema, RoomIdSchema, type Member, type ServerFrame } from '@wireroom/protocol';

import { assertHumanCapability, roleAllows, type HumanCapability } from './authorization.js';
import { constantTimeEqual } from './crypto/challenge.js';
import type { CryptoVault, PairingRequest } from './crypto/pairing.js';
import type { Daemon } from './daemon.js';
import type { PushSubscriptionStore } from './push/subscriptions.js';

export interface ServerOptions {
  daemon: Daemon;
  /** Single pairing token — the authenticated principal IS the room owner. */
  token: string;
  /** Optional pre-enrolled local principals; enrollment/directory service is out of scope. */
  principals?: readonly { token: string; member_id: string }[];
  host?: string;
  port?: number;
  /** Serve the built web SPA from this directory (the switchboard IS the web host). */
  staticRoot?: string;
  /** Local CLI transport; filesystem mode is 0600 and no bearer token crosses it. */
  socketPath?: string;
  /** Device enrollment and room-key authority for this switchboard. */
  crypto?: CryptoVault;
  /** Paired browser Web Push destinations; content remains on the switchboard. */
  pushSubscriptions?: PushSubscriptionStore;
  /** Public VAPID application-server key used by browser PushManager.subscribe. */
  pushVapidPublicKey?: string;
  /** True only when the producer has a validated relay destination. */
  pushRelayEnabled?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  socketPath?: string;
  close(): Promise<void>;
}

interface AuthPrincipal {
  /** Undefined is the backwards-compatible single-operator owner token. */
  memberId?: string;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  // harn:assume unix-socket-parent-private-before-listen ref=unix-socket-parent-precondition
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) {
    throw new Error(`unix socket parent must be a private directory (mode 0700): ${parent}`);
  }
  // harn:end unix-socket-parent-private-before-listen
  if (!existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket()) {
    throw new Error(`refusing to replace non-socket path ${socketPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    const probe = connectSocket(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`unix socket already in use: ${socketPath}`));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        rmSync(socketPath, { force: true });
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function listenUnix(server: HttpServer, socketPath: string): Promise<void> {
  await prepareSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
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
  const configuredPrincipals = options.principals ?? [];
  const principalTokens = new Set<string>();
  for (const principal of configuredPrincipals) {
    if (principal.token.trim() === '') throw new Error('principal tokens must be non-empty');
    if (constantTimeEqual(principal.token, token) || principalTokens.has(principal.token)) {
      throw new Error('principal tokens must be unique');
    }
    principalTokens.add(principal.token);
  }
  // harn:end server-token-required
  const app = Fastify();

  const principalForToken = (candidate: string | undefined): AuthPrincipal | undefined => {
    if (candidate === undefined) return undefined;
    if (constantTimeEqual(candidate, token)) return {};
    const configured = configuredPrincipals.find((principal) =>
      constantTimeEqual(candidate, principal.token));
    return configured ? { memberId: configured.member_id } : undefined;
  };

  const authed = (req: FastifyRequest, reply: FastifyReply): AuthPrincipal | undefined => {
    const header = req.headers.authorization;
    const query = (req.query as { token?: string }).token;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
    const principal = principalForToken(bearer) ?? principalForToken(query);
    if (principal) return principal;
    void reply.code(401).send({ error: 'unauthorized' });
    return undefined;
  };

  const memberForRoom = (principal: AuthPrincipal, room: string): Member => {
    if (principal.memberId === undefined) return daemon.ownerOf(room);
    const member = daemon.store.getMember(room, principal.memberId);
    if (member?.kind !== 'human') throw new Error('principal is not a human member of this room');
    return member;
  };

  const memberForGlobal = (principal: AuthPrincipal): Member | undefined => {
    if (principal.memberId === undefined) return undefined;
    for (const room of daemon.store.listRooms()) {
      const member = daemon.store.getMember(room.id, principal.memberId);
      if (member?.kind === 'human') return member;
    }
    throw new Error('principal is not a human member');
  };

  const authorizeRoom = (
    principal: AuthPrincipal,
    room: string,
    capability: HumanCapability,
    reply?: FastifyReply,
  ): Member | undefined => {
    if (!daemon.store.getRoom(room)) {
      if (reply) void reply.code(404).send({ error: `no such room ${room}` });
      return undefined;
    }
    try {
      const member = memberForRoom(principal, room);
      assertHumanCapability(member, capability);
      return member;
    } catch (error) {
      if (reply) void reply.code(403).send({ error: String(error) });
      return undefined;
    }
  };

  const authorizeGlobal = (
    principal: AuthPrincipal,
    capability: HumanCapability,
    reply?: FastifyReply,
  ): boolean => {
    try {
      const member = memberForGlobal(principal);
      if (member) assertHumanCapability(member, capability);
      else if (!roleAllows('owner', capability)) throw new Error(`forbidden: owner cannot ${capability}`);
      return true;
    } catch (error) {
      if (reply) void reply.code(403).send({ error: String(error) });
      return false;
    }
  };

  const roomsFor = (principal: AuthPrincipal) => daemon.store.listRooms().filter((room) =>
    principal.memberId === undefined || daemon.store.getMember(room.id, principal.memberId)?.kind === 'human');

  app.post('/api/pairing/complete', (req, reply) => {
    if (!options.crypto) return reply.code(404).send({ error: 'pairing is not configured' });
    const authorization = req.headers.authorization;
    const pairingToken = authorization?.startsWith('Pairing ')
      ? authorization.slice('Pairing '.length)
      : undefined;
    if (!pairingToken) return reply.code(401).send({ error: 'pairing token required' });
    try {
      return reply.send({
        ...options.crypto.pairing.complete(pairingToken, req.body as PairingRequest),
        access_token: token,
      });
    } catch (error) {
      return reply.code(401).send({ error: String(error) });
    }
  });

  app.post('/api/pairing/offers', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_devices', reply)) return;
    if (!options.crypto) return reply.code(404).send({ error: 'pairing is not configured' });
    try {
      const { endpoint } = req.body as { endpoint: string };
      return reply.send(options.crypto.pairing.issue(endpoint));
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.post('/api/devices/:deviceId/push-subscription', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_devices', reply)) return;
    if (!options.pushSubscriptions) {
      return reply.code(404).send({ error: 'push subscriptions are not configured' });
    }
    const { deviceId } = req.params as { deviceId: string };
    try {
      const body = req.body as { subscription?: unknown };
      return reply.code(201).send({
        subscription: options.pushSubscriptions.register(deviceId, body.subscription),
      });
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.delete('/api/devices/:deviceId/push-subscription', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_devices', reply)) return;
    if (!options.pushSubscriptions) {
      return reply.code(404).send({ error: 'push subscriptions are not configured' });
    }
    const { deviceId } = req.params as { deviceId: string };
    options.pushSubscriptions.remove(deviceId);
    return reply.code(204).send();
  });

  app.get('/api/push/config', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'read', reply)) return;
    return reply.send({
      enabled: Boolean(
        options.pushSubscriptions && options.pushVapidPublicKey && options.pushRelayEnabled,
      ),
      ...(options.pushVapidPublicKey && { vapid_public_key: options.pushVapidPublicKey }),
    });
  });

  // harn:assume unpair-purges-all-browser-state ref=device-revoke-rest
  app.get('/api/devices', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_devices', reply)) return;
    if (!options.crypto) return reply.code(404).send({ error: 'pairing is not configured' });
    return reply.send({
      devices: options.crypto.keys.listPeers()
        .filter((peer) => peer.kind === 'device')
        .map((peer) => ({
          device_id: peer.device_id,
          label: peer.label,
          paired_at: peer.paired_at,
          push_enabled: options.pushSubscriptions?.get(peer.device_id) !== undefined,
        })),
    });
  });

  app.delete('/api/devices/:deviceId', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_devices', reply)) return;
    if (!options.crypto) return reply.code(404).send({ error: 'pairing is not configured' });
    const { deviceId } = req.params as { deviceId: string };
    const peer = options.crypto.keys.getPeer(deviceId);
    if (!peer || peer.kind !== 'device') return reply.code(404).send({ error: 'no such device' });
    options.pushSubscriptions?.remove(deviceId);
    const revoked = options.crypto.revokePeer(deviceId);
    return reply.send({ revoked });
  });
  // harn:end unpair-purges-all-browser-state

  app.get('/api/rooms', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'read', reply)) return;
    void reply.send({ rooms: roomsFor(principal) });
  });

  app.get('/api/adapters', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'read', reply)) return;
    void reply.send({ adapters: daemon.registeredAdapters() });
  });

  app.post('/api/rooms', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_rooms', reply)) return;
    const body = req.body as { id: string; name: string; owner: { handle: string; display_name: string } };
    RoomIdSchema.parse(body.id);
    const created = daemon.createRoom(body);
    options.crypto?.roomKeys.ensureRoom(created.room.id);
    void reply.send(created);
  });

  app.get('/api/rooms/:room/sync', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    const sinceSeq = Number((req.query as { since_seq?: string }).since_seq ?? 0);
    try {
      void reply.send(daemon.sync(room, sinceSeq));
    } catch {
      void reply.code(404).send({ error: `no such room ${room}` });
    }
  });

  // harn:assume permalink-ids-stable ref=message-history-rest
  const positiveInteger = (
    value: string | undefined,
    fallback: number,
    maximum: number,
    label: string,
  ): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new Error(`${label} must be an integer from 1 to ${String(maximum)}`);
    }
    return parsed;
  };

  app.get('/api/rooms/:room/messages', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    if (!daemon.store.getRoom(room)) return reply.code(404).send({ error: `no such room ${room}` });
    try {
      const query = req.query as { before?: string; limit?: string };
      const limit = positiveInteger(query.limit, 50, 100, 'limit');
      const before = positiveInteger(
        query.before,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        'before',
      );
      const page = daemon.store.listMessages(room, { before, limit: limit + 1 });
      const hasMore = page.length > limit;
      const messages = hasMore ? page.slice(-limit) : page;
      return reply.send({ messages: daemon.project(room, messages), has_more: hasMore });
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.get('/api/rooms/:room/search', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    if (!daemon.store.getRoom(room)) return reply.code(404).send({ error: `no such room ${room}` });
    try {
      const query = req.query as { q?: string; limit?: string };
      const needle = query.q?.trim();
      if (!needle || needle.length > 200) throw new Error('q must contain 1 to 200 characters');
      const limit = positiveInteger(query.limit, 50, 100, 'limit');
      const messages = daemon.store.searchMessages(room, needle, { limit });
      return reply.send({ messages: daemon.project(room, messages) });
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });
  // harn:end permalink-ids-stable

  app.get('/api/rooms/:room/runs/:msgId', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, msgId } = req.params as { room: string; msgId: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    void reply.send({ events: daemon.readRunBlob(room, Number(msgId)) });
  });

  app.get('/api/rooms/:room/ledger/:name', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, name } = req.params as { room: string; name: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    try {
      const note = daemon.getLedgerNote(room, name);
      if (!note) return reply.code(404).send({ error: `no such ledger note ${name}` });
      return reply.send({ note: daemon.project(room, note) });
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post('/api/rooms/:room/members', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'spawn', reply)) return;
    const body = req.body as { harness: string; handle: string; cwd: string; policy?: string; model?: string };
    void reply.send(daemon.spawnMember(room, body));
  });

  app.get('/api/rooms/:room/members', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    void reply.send({ members: daemon.project(room, daemon.memberDetails(room)) });
  });

  app.patch('/api/rooms/:room/members/:memberId', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, memberId } = req.params as { room: string; memberId: string };
    if (!authorizeRoom(principal, room, 'rename', reply)) return;
    const body = req.body as { handle: string; display_name?: string };
    void reply.send(daemon.renameMember(room, memberId, body.handle, body.display_name));
  });

  for (const action of ['revive', 'kill', 'pause', 'unpause'] as const) {
    app.post(`/api/rooms/:room/members/:memberId/${action}`, (req, reply) => {
      const principal = authed(req, reply);
      if (!principal) return;
      const { room, memberId } = req.params as { room: string; memberId: string };
      if (!authorizeRoom(principal, room, action, reply)) return;
      const member =
        action === 'revive'
          ? daemon.reviveMember(room, memberId)
          : action === 'kill'
            ? daemon.killMember(room, memberId)
            : action === 'pause'
              ? daemon.pauseMember(room, memberId)
              : daemon.unpauseMember(room, memberId);
      void reply.send(member);
    });
  }

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
  let ipcServer: HttpServer | undefined;
  let ipcWss: WebSocketServer | undefined;
  const subscriptions = new Map<WebSocket, Set<string>>();

  const unsubscribeFrames = daemon.onFrame((room, frame) => {
    for (const [socket, rooms] of subscriptions) {
      if (rooms.has(room) && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    }
  });

  // harn:assume unix-socket-same-protocol ref=unix-websocket-listener
  const bindProtocol = (
    server: WebSocketServer,
    authenticate: (url: URL) => AuthPrincipal | undefined,
  ): void => {
    server.on('connection', (socket, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const principal = authenticate(url);
      if (!principal) {
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
          if (frame.type === 'mirror_turn') {
            const joined = daemon.store.findMemberBySessionRef(frame.harness, frame.session_ref);
            if (!joined) throw new Error(`no mirrored member for ${frame.harness} session ${frame.session_ref}`);
            assertHumanCapability(memberForRoom(principal, joined.room), 'mirror_turn');
            const mirrored = daemon.mirrorTurn(frame);
            send({
              type: 'mirror_ack',
              native_turn_id: frame.native_turn_id,
              message_id: mirrored.message.id,
              deduped: mirrored.deduped,
            });
          } else if (frame.type === 'mirror_session_end') {
            const joined = daemon.store.findMemberBySessionRef(frame.harness, frame.session_ref);
            if (!joined) throw new Error(`no mirrored member for ${frame.harness} session ${frame.session_ref}`);
            assertHumanCapability(memberForRoom(principal, joined.room), 'mirror_session_end');
            send({
              type: 'mirror_ack',
              adopted: daemon.mirrorSessionEnd(frame.harness, frame.session_ref),
            });
          } else if (frame.type === 'list_rooms') {
            if (!authorizeGlobal(principal, 'read')) throw new Error('forbidden: principal cannot list rooms');
            send({
              type: 'rooms',
              rooms: roomsFor(principal).map((room) => daemon.project(room.id, room)),
            });
          } else if (frame.type === 'subscribe') {
            const actor = memberForRoom(principal, frame.room);
            assertHumanCapability(actor, 'read');
            subscriptions.get(socket)!.add(frame.room);
            const sync = daemon.sync(frame.room, frame.since_seq);
            const hydrationCursor = frame.since_seq;
            send({ type: 'self', member_id: actor.id });
            send({ type: 'room', seq: hydrationCursor, room: sync.room });
            for (const member of sync.members) send({ type: 'member', seq: hydrationCursor, member });
            for (const message of sync.messages) send({ type: 'message', seq: hydrationCursor, message });
            for (const delivery of sync.inbox) send({ type: 'inbox', seq: hydrationCursor, delivery });
            for (const meter of sync.meters) send({ type: 'meter', seq: hydrationCursor, meter });
            send({ type: 'sync_complete', seq: sync.seq });
          } else if (frame.type === 'post') {
            const actor = memberForRoom(principal, frame.room);
            assertHumanCapability(actor, 'post');
            daemon.postHumanMessage(frame.room, frame.body, {
              author: actor.id,
              reply_to: frame.reply_to,
            });
          } else if (frame.type === 'act') {
            const act = frame.act;
            const actor = memberForRoom(principal, frame.room);
            assertHumanCapability(actor, act.act);
            if (act.act === 'answer_interaction') {
              void daemon
                .answerInteraction(frame.room, act.interaction_id, act.answer, actor.id)
                .catch((error: unknown) =>
                  send({ type: 'error', message: String(error), ref: 'answer_interaction' }),
                );
            } else if (act.act === 'join') {
              daemon.joinMember(frame.room, {
                harness: act.harness,
                handle: act.handle,
                session_ref: act.session_ref,
                cwd: act.cwd,
                policy: act.policy,
              });
            } else if (act.act === 'adopt') daemon.adoptMember(frame.room, act.member_id);
            else if (act.act === 'attach_acquire') {
              void daemon.acquireAttachLease(frame.room, act.member_id, act.cli_pid)
                .then(({ lease, member }) => send({
                  type: 'attach_lease',
                  status: 'acquired',
                  lease,
                  member,
                }))
                .catch((error: unknown) => send({
                  type: 'error',
                  message: String(error),
                  ref: 'attach_acquire',
                }));
            } else if (act.act === 'attach_child') {
              const { lease, member } = daemon.reportAttachChild(
                act.lease_id,
                act.child_pid,
                act.process_group_id,
              );
              send({ type: 'attach_lease', status: 'child_recorded', lease, member });
            } else if (act.act === 'attach_heartbeat') {
              daemon.heartbeatAttachLease(act.lease_id);
            } else if (act.act === 'attach_complete') {
              const completed = daemon.completeAttachLease(act.lease_id);
              send({
                type: 'attach_lease',
                status: completed.status,
                lease: completed.lease,
                member: completed.member,
              });
            } else if (act.act === 'configure_room') {
              daemon.configureRoom(frame.room, {
                ...(act.turn_brake !== undefined && { turn_brake: act.turn_brake }),
                ...(act.spend_brake_usd !== undefined && {
                  spend_brake_usd: act.spend_brake_usd,
                }),
                ...(act.stall_minutes !== undefined && { stall_minutes: act.stall_minutes }),
              });
            }
            else if (act.act === 'redeliver') daemon.redeliver(frame.room, act.delivery_id);
            else if (act.act === 'release_hold') daemon.releaseHold(frame.room, act.delivery_id);
            else if (act.act === 'mark_read') daemon.markRead(frame.room, act.delivery_id, actor.id);
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
            else if (act.act === 'kill') daemon.killMember(frame.room, act.member_id);
            else if (act.act === 'pause') daemon.pauseMember(frame.room, act.member_id);
            else if (act.act === 'unpause') daemon.unpauseMember(frame.room, act.member_id);
            else if (act.act === 'interrupt') daemon.interruptMember(frame.room, act.member_id);
            else if (act.act === 'set_role') daemon.setHumanRole(frame.room, act.member_id, act.role);
          }
        } catch (error) {
          send({ type: 'error', message: String(error), ref: frame.type });
        }
      });
    });
  };

  bindProtocol(wss, (url) => principalForToken(url.searchParams.get('token') ?? undefined));
  if (options.socketPath !== undefined) {
    ipcServer = createHttpServer((_req, res) => res.writeHead(404).end());
    ipcWss = new WebSocketServer({ server: ipcServer, path: '/ws' });
    bindProtocol(ipcWss, () => ({}));
    try {
      await listenUnix(ipcServer, options.socketPath);
    } catch (error) {
      unsubscribeFrames();
      ipcWss.close();
      wss.close();
      await app.close();
      throw error;
    }
  }
  // harn:end unix-socket-same-protocol

  return {
    app,
    port,
    socketPath: options.socketPath,
    close: async () => {
      unsubscribeFrames();
      for (const socket of subscriptions.keys()) socket.terminate();
      wss.close();
      ipcWss?.close();
      if (ipcServer?.listening) {
        await new Promise<void>((resolve, reject) =>
          ipcServer!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await app.close();
      if (options.socketPath !== undefined) rmSync(options.socketPath, { force: true });
    },
  };
}
