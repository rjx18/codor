import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { dirname } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientFrameSchema,
  CreateRoomRequestSchema,
  type BridgeOrigin,
  type Member,
  type Policy,
  type ServerFrame,
  type ThinkingLevel,
} from '@codor/protocol';

import {
  assertAgentCapability,
  assertHumanCapability,
  roleAllows,
  type HumanCapability,
  type RoomCapability,
} from './authorization.js';
import { constantTimeEqual, hashTranscript } from './crypto/challenge.js';
import type { CryptoVault, PairingRequest } from './crypto/pairing.js';
import type { Daemon } from './daemon.js';
import { listLocalDirectories, LocalDirectoryError } from './local-dirs.js';
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
  /** Trust Tailscale Serve's injected identity header for browser enrollment. */
  trustTailscaleServe?: boolean;
  /** Testable operator-home boundary; defaults to the process home. */
  homeDir?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  socketPath?: string;
  close(): Promise<void>;
}

type AuthPrincipal =
  | { kind: 'owner' }
  | { kind: 'human'; memberId: string }
  | { kind: 'browser'; deviceId: string }
  | { kind: 'agent'; memberId: string; room: string };

const PAIRING_CODE_ATTEMPTS = 5;
const PAIRING_CODE_WINDOW_MS = 60_000;

function pairingCodeAttemptLimiter(now: () => number): (connection: object) => boolean {
  const attempts = new WeakMap<object, number[]>();
  return (connection) => {
    const cutoff = now() - PAIRING_CODE_WINDOW_MS;
    const recent = (attempts.get(connection) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= PAIRING_CODE_ATTEMPTS) {
      attempts.set(connection, recent);
      return false;
    }
    recent.push(now());
    attempts.set(connection, recent);
    return true;
  };
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
  const allowPairingCodeAttempt = pairingCodeAttemptLimiter(Date.now);
  const browserAuthTranscript = options.crypto
    ? hashTranscript(Buffer.from(
        `codor-browser-session-v1\0${options.crypto.keys.identity.device_id}`,
        'utf8',
      ))
    : undefined;

  const principalForToken = (candidate: string | undefined): AuthPrincipal | undefined => {
    if (candidate === undefined) return undefined;
    if (constantTimeEqual(candidate, token)) return { kind: 'owner' };
    const configured = configuredPrincipals.find((principal) =>
      constantTimeEqual(candidate, principal.token));
    if (configured) return { kind: 'human', memberId: configured.member_id };
    const deviceId = options.crypto?.browserSessions.authenticate(candidate);
    if (deviceId) return { kind: 'browser', deviceId };
    // harn:assume agent-member-credentials-stay-secret ref=agent-principal-resolution
    const agent = daemon.authenticateAgentToken(candidate);
    return agent
      ? { kind: 'agent', memberId: agent.member.id, room: agent.room }
      : undefined;
    // harn:end agent-member-credentials-stay-secret
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
    if (principal.kind === 'owner' || principal.kind === 'browser') return daemon.ownerOf(room);
    if (principal.kind === 'agent' && principal.room !== room) {
      throw new Error(`forbidden: agent credential belongs to room ${principal.room}`);
    }
    const member = daemon.store.getMember(room, principal.memberId);
    if (member?.kind !== principal.kind) {
      throw new Error(`principal is not a ${principal.kind} member of this room`);
    }
    return member;
  };

  const memberForGlobal = (principal: AuthPrincipal): Member | undefined => {
    if (principal.kind === 'owner' || principal.kind === 'browser') return undefined;
    if (principal.kind === 'agent') throw new Error('forbidden: agent principal is room-scoped');
    for (const room of daemon.store.listRooms()) {
      const member = daemon.store.getMember(room.id, principal.memberId);
      if (member?.kind === 'human') return member;
    }
    throw new Error('principal is not a human member');
  };

  // harn:assume agent-network-authority-is-narrow ref=agent-room-authorization
  const assertRoomCapability = (
    principal: AuthPrincipal,
    room: string,
    capability: RoomCapability,
  ): Member => {
    if (!daemon.store.getRoom(room)) throw new Error(`no such room ${room}`);
    const member = memberForRoom(principal, room);
    if (principal.kind === 'agent') assertAgentCapability(member, capability);
    else assertHumanCapability(member, capability as HumanCapability);
    return member;
  };

  const authorizeRoom = (
    principal: AuthPrincipal,
    room: string,
    capability: RoomCapability,
    reply?: FastifyReply,
  ): Member | undefined => {
    if (!daemon.store.getRoom(room)) {
      if (reply) void reply.code(404).send({ error: `no such room ${room}` });
      return undefined;
    }
    try {
      return assertRoomCapability(principal, room, capability);
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
      if (principal.kind === 'agent') {
        throw new Error(`forbidden: agent cannot use global ${capability}`);
      }
      const member = memberForGlobal(principal);
      if (member) assertHumanCapability(member, capability);
      else if (!roleAllows('owner', capability)) throw new Error(`forbidden: owner cannot ${capability}`);
      return true;
    } catch (error) {
      if (reply) void reply.code(403).send({ error: String(error) });
      return false;
    }
  };

  const roomsFor = (principal: AuthPrincipal) => daemon.store.listRooms().filter((room) => {
    if (principal.kind === 'owner' || principal.kind === 'browser') return true;
    if (principal.kind === 'agent') return room.id === principal.room;
    return daemon.store.getMember(room.id, principal.memberId)?.kind === 'human';
  });
  // harn:end agent-network-authority-is-narrow

  // harn:assume paired-browser-challenge-session ref=browser-device-session-rest
  app.post('/api/auth/challenge', (req, reply) => {
    if (!options.crypto || !browserAuthTranscript) {
      return reply.code(404).send({ error: 'device authentication is not configured' });
    }
    try {
      const body = req.body as { device_id?: unknown };
      if (typeof body.device_id !== 'string' || body.device_id === '') {
        throw new Error('device id is required');
      }
      const challenge = options.crypto.browserChallenges.issue(body.device_id, browserAuthTranscript);
      return reply.header('cache-control', 'no-store').send({
        challenge,
        switchboard_device_id: options.crypto.keys.identity.device_id,
      });
    } catch {
      return reply.code(401).send({ error: 'device authentication failed' });
    }
  });

  app.post('/api/auth/session', (req, reply) => {
    if (!options.crypto) {
      return reply.code(404).send({ error: 'device authentication is not configured' });
    }
    try {
      const body = req.body as { challenge_id?: unknown; signature?: unknown };
      if (typeof body.challenge_id !== 'string' || typeof body.signature !== 'string') {
        throw new Error('challenge response is required');
      }
      const peer = options.crypto.browserChallenges.verify(body.challenge_id, body.signature);
      if (peer.kind !== 'device') throw new Error('only paired devices may open browser sessions');
      return reply.header('cache-control', 'no-store').send(
        options.crypto.browserSessions.issue(peer.device_id),
      );
    } catch {
      return reply.code(401).send({ error: 'device authentication failed' });
    }
  });
  // harn:end paired-browser-challenge-session

  // harn:assume unpaired-browser-always-has-enrollment-path ref=trusted-pairing-status-rest
  app.get('/api/pairing/status', (req, reply) => {
    const tailnetLogin = req.headers['tailscale-user-login'];
    return reply.header('cache-control', 'no-store').send({
      trusted_enrollment:
        options.trustTailscaleServe === true &&
        typeof tailnetLogin === 'string' &&
        tailnetLogin.trim() !== '',
    });
  });
  // harn:end unpaired-browser-always-has-enrollment-path

  // harn:assume pairing-code-exchange-uniform-and-rate-limited ref=pairing-code-exchange-rest
  app.post('/api/pairing/exchange', (req, reply) => {
    const notFound = () => reply.header('cache-control', 'no-store')
      .code(404).send({ error: 'pairing code not found' });
    if (!options.crypto || !allowPairingCodeAttempt(req.raw.socket)) return notFound();
    try {
      const body = req.body as { code?: unknown };
      if (typeof body.code !== 'string') return notFound();
      return reply.header('cache-control', 'no-store').send(
        options.crypto.pairing.exchange(body.code),
      );
    } catch {
      return notFound();
    }
  });
  // harn:end pairing-code-exchange-uniform-and-rate-limited

  app.post('/api/pairing/complete', (req, reply) => {
    if (!options.crypto) return reply.code(404).send({ error: 'pairing is not configured' });
    const authorization = req.headers.authorization;
    const pairingToken = authorization?.startsWith('Pairing ')
      ? authorization.slice('Pairing '.length)
      : undefined;
    try {
      // harn:assume tailnet-auto-pairing-explicit-trust ref=trusted-tailnet-pairing-rest
      const tailnetLogin = req.headers['tailscale-user-login'];
      if (!pairingToken) {
        if (
          options.trustTailscaleServe !== true ||
          typeof tailnetLogin !== 'string' ||
          tailnetLogin.trim() === ''
        ) {
          return reply.code(401).send({ error: 'pairing token required' });
        }
        return reply.header('cache-control', 'no-store').send(
          options.crypto.pairing.completeTrusted(
            req.body as PairingRequest,
            tailnetLogin.trim(),
          ),
        );
      }
      // harn:end tailnet-auto-pairing-explicit-trust
      return reply.header('cache-control', 'no-store').send(
        options.crypto.pairing.complete(pairingToken, req.body as PairingRequest),
      );
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
      return reply.header('cache-control', 'no-store').send(options.crypto.pairing.issue(endpoint));
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
    if (!principal) return;
    if (principal.kind === 'agent') {
      if (!authorizeRoom(principal, principal.room, 'read', reply)) return;
    } else if (!authorizeGlobal(principal, 'read', reply)) return;
    void reply.send({ rooms: roomsFor(principal) });
  });

  app.get('/api/adapters', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'read', reply)) return;
    // harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-pending-rest
    void reply.send({
      adapters: daemon.registeredAdapters(),
      discovering: daemon.modelDiscoveryPending(),
    });
    // harn:end model-catalogs-reach-a-browser-that-arrives-early
  });

  // harn:assume local-directory-listing-home-contained ref=local-dirs-rest-boundary
  app.get('/api/local/dirs', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_agents', reply)) return;
    const query = req.query as { path?: string; hidden?: string };
    try {
      return reply.send(listLocalDirectories(query.path, query.hidden === '1', options.homeDir));
    } catch (error) {
      if (error instanceof LocalDirectoryError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
  // harn:end local-directory-listing-home-contained

  // harn:assume channel-creation-derived-and-seeded ref=create-room-rest-contract
  app.post('/api/rooms', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal || !authorizeGlobal(principal, 'manage_rooms', reply)) return;
    try {
      const body = CreateRoomRequestSchema.parse(req.body);
      const created = daemon.createRoom(body);
      options.crypto?.roomKeys.ensureRoom(created.room.id);
      return reply.send(created);
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });
  // harn:end channel-creation-derived-and-seeded

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

  // harn:assume member-status-is-bounded-and-identity-safe ref=status-rest-boundary
  app.get('/api/rooms/:room/members/:memberId/status', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, memberId } = req.params as { room: string; memberId: string };
    if (!authorizeRoom(
      principal,
      room,
      principal.kind === 'agent' ? 'member_status' : 'read',
      reply,
    )) return;
    try {
      return reply.send(daemon.memberStatus(room, memberId));
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });
  // harn:end member-status-is-bounded-and-identity-safe

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
    if (!authorizeRoom(
      principal,
      room,
      principal.kind === 'agent' ? 'search' : 'read',
      reply,
    )) return;
    if (!daemon.store.getRoom(room)) return reply.code(404).send({ error: `no such room ${room}` });
    try {
      const query = req.query as { q?: string; include?: string; limit?: string };
      const needle = query.q?.trim();
      if (!needle || needle.length > 200) throw new Error('q must contain 1 to 200 characters');
      if (query.include !== undefined && query.include !== 'runs') {
        throw new Error('include must be runs when provided');
      }
      const includeRuns = query.include === 'runs';
      const limit = positiveInteger(query.limit, 50, includeRuns ? 200 : 100, 'limit');
      const messages = daemon.store.searchMessages(room, needle, { limit });
      // harn:assume run-evidence-search-is-bounded-and-redacted ref=run-search-rest-boundary
      return reply.send({
        messages: daemon.project(room, messages),
        ...(includeRuns && { runs: daemon.searchRunEvidence(room, needle, limit) }),
      });
      // harn:end run-evidence-search-is-bounded-and-redacted
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

  // harn:assume graph-derived-from-vault-links-readonly-v5 ref=ledger-graph-rest
  app.get('/api/rooms/:room/ledger', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'read', reply)) return;
    try {
      return reply.send({ graph: daemon.project(room, daemon.ledgerGraph(room)) });
    } catch {
      return reply.code(500).send({ error: 'ledger graph unavailable' });
    }
  });
  // harn:end graph-derived-from-vault-links-readonly-v5

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

  // harn:assume bridge-enable-admin-or-owner ref=bridge-rest-boundary
  app.post('/api/rooms/:room/bridges', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'enable_bridge', reply)) return;
    try {
      const body = req.body as { platform?: unknown; channel?: unknown };
      if (body.platform !== 'slack' && body.platform !== 'telegram') {
        throw new Error('platform must be slack or telegram');
      }
      if (typeof body.channel !== 'string' || body.channel.trim() === '' || body.channel.length > 200) {
        throw new Error('channel must contain 1 to 200 characters');
      }
      return reply.code(201).send(daemon.enableBridge(room, body.platform, body.channel));
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.post('/api/rooms/:room/bridges/:memberId/messages', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, memberId } = req.params as { room: string; memberId: string };
    if (!authorizeRoom(principal, room, 'enable_bridge', reply)) return;
    try {
      const body = req.body as { body?: unknown; origin?: unknown };
      if (typeof body.body !== 'string' || body.body.trim() === '' || body.body.length > 100_000) {
        throw new Error('body must contain 1 to 100000 characters');
      }
      return reply.send(daemon.postBridgeMessage(
        room,
        memberId,
        body.body,
        body.origin as BridgeOrigin,
      ));
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  // harn:assume bridge-runtime-persists-delivery-progress ref=bridge-outbound-ready-window
  app.get('/api/rooms/:room/bridges/:memberId/outbound', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, memberId } = req.params as { room: string; memberId: string };
    if (!authorizeRoom(principal, room, 'enable_bridge', reply)) return;
    try {
      const bridge = daemon.store.getMember(room, memberId);
      if (bridge?.kind !== 'bridge') return reply.code(404).send({ error: 'no such bridge' });
      const query = req.query as { after?: string; limit?: string };
      const after = query.after === undefined ? 0 : Number(query.after);
      const limit = query.limit === undefined ? 100 : Number(query.limit);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('limit must be an integer from 1 to 100');
      }
      const scanned = daemon.bridgeMessagesAfter(room, after, limit);
      const platform = bridge.handle.slice(0, -'-bridge'.length);
      const messages = [];
      let nextAfter = after;
      for (const message of scanned) {
        if (message.kind === 'run' && message.run?.status === 'running') break;
        nextAfter = message.id;
        if (message.kind === 'run' && message.body.trim() === '') continue;
        if (message.author === bridge.id && message.origin?.platform === platform) continue;
        messages.push(message);
      }
      return reply.send({
        messages: daemon.project(room, messages),
        next_after: nextAfter,
      });
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });
  // harn:end bridge-runtime-persists-delivery-progress
  // harn:end bridge-enable-admin-or-owner

  app.post('/api/rooms/:room/members', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room } = req.params as { room: string };
    if (!authorizeRoom(principal, room, 'spawn', reply)) return;
    const body = req.body as {
      harness: string;
      handle: string;
      cwd: string;
      policy?: string;
      model?: string;
      thinking?: 'low' | 'medium' | 'high';
      purpose?: string;
    };
    try {
      return reply.send(daemon.spawnMember(room, body));
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
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

  // harn:assume member-config-is-changed-not-respawned ref=configure-act-contract
  app.post('/api/rooms/:room/members/:memberId/configure', (req, reply) => {
    const principal = authed(req, reply);
    if (!principal) return;
    const { room, memberId } = req.params as { room: string; memberId: string };
    if (!authorizeRoom(principal, room, 'configure', reply)) return;
    const body = req.body as { model?: string | null; thinking?: ThinkingLevel | null; policy?: Policy };
    const actor = memberForRoom(principal, room);
    void reply.send(daemon.configureMember(room, memberId, body, { actor: actor.id }));
  });
  // harn:end member-config-is-changed-not-respawned

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
  const deviceSockets = new Map<string, Set<WebSocket>>();
  // harn:assume paired-browser-challenge-session ref=browser-device-session-socket
  const stopDeviceRevocations = options.crypto?.keys.onPeerRevoked((deviceId) => {
    const sockets = deviceSockets.get(deviceId);
    if (!sockets) return;
    deviceSockets.delete(deviceId);
    for (const socket of sockets) socket.close(4403, 'device revoked');
  });
  // harn:end paired-browser-challenge-session

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
      if (principal.kind === 'browser') {
        const sockets = deviceSockets.get(principal.deviceId) ?? new Set<WebSocket>();
        sockets.add(socket);
        deviceSockets.set(principal.deviceId, sockets);
      }
      socket.on('close', () => {
        subscriptions.delete(socket);
        if (principal.kind !== 'browser') return;
        const sockets = deviceSockets.get(principal.deviceId);
        sockets?.delete(socket);
        if (sockets?.size === 0) deviceSockets.delete(principal.deviceId);
      });

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
            assertRoomCapability(principal, joined.room, 'mirror_turn');
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
            assertRoomCapability(principal, joined.room, 'mirror_session_end');
            send({
              type: 'mirror_ack',
              adopted: daemon.mirrorSessionEnd(frame.harness, frame.session_ref),
            });
          } else if (frame.type === 'list_rooms') {
            if (principal.kind === 'agent') {
              assertRoomCapability(principal, principal.room, 'read');
            } else if (!authorizeGlobal(principal, 'read')) {
              throw new Error('forbidden: principal cannot list rooms');
            }
            send({
              type: 'rooms',
              rooms: roomsFor(principal).map((room) => daemon.project(room.id, room)),
            });
          } else if (frame.type === 'subscribe') {
            const actor = assertRoomCapability(principal, frame.room, 'read');
            subscriptions.get(socket)!.add(frame.room);
            const sync = daemon.sync(frame.room, frame.since_seq);
            const hydrationCursor = frame.since_seq;
            send({ type: 'self', member_id: actor.id });
            send({ type: 'room', seq: hydrationCursor, room: sync.room });
            for (const member of sync.members) send({ type: 'member', seq: hydrationCursor, member });
            for (const message of sync.messages) send({ type: 'message', seq: hydrationCursor, message });
            // harn:assume agent-sync-hydrates-only-own-queued-inbox ref=agent-own-queued-sync-overlay
            const inbox = principal.kind === 'agent'
              ? new Map([
                  ...sync.inbox
                    .filter((delivery) => delivery.recipient === actor.id)
                    .map((delivery) => [delivery.id, delivery] as const),
                  ...daemon.store.listDeliveries(frame.room, {
                    recipient: actor.id,
                    state: 'queued',
                  }).map((delivery) => [delivery.id, delivery] as const),
                ]).values()
              : sync.inbox;
            for (const delivery of inbox) send({ type: 'inbox', seq: hydrationCursor, delivery });
            // harn:end agent-sync-hydrates-only-own-queued-inbox
            for (const meter of sync.meters) send({ type: 'meter', seq: hydrationCursor, meter });
            send({ type: 'sync_complete', seq: sync.seq });
          } else if (frame.type === 'post') {
            const actor = assertRoomCapability(principal, frame.room, 'post');
            if (principal.kind === 'agent') {
              daemon.postAgentMessage(
                frame.room,
                actor.id,
                frame.body,
                frame.reply_to,
                frame.awaiting_reply,
              );
            } else {
              daemon.postHumanMessage(frame.room, frame.body, {
                author: actor.id,
                reply_to: frame.reply_to,
              });
            }
          } else if (frame.type === 'act') {
            const act = frame.act;
            const actor = assertRoomCapability(principal, frame.room, act.act);
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
                purpose: act.purpose,
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
              // harn:assume attach-lease-actions-room-bound ref=attach-lease-room-authorization
              const attachLease = daemon.store.getAttachLease(act.lease_id);
              if (!attachLease || attachLease.room !== frame.room) {
                throw new Error(`no such attach lease ${act.lease_id}`);
              }
              const { lease, member } = daemon.reportAttachChild(
                act.lease_id,
                act.child_pid,
                act.process_group_id,
              );
              send({ type: 'attach_lease', status: 'child_recorded', lease, member });
            } else if (act.act === 'attach_heartbeat') {
              const attachLease = daemon.store.getAttachLease(act.lease_id);
              if (!attachLease || attachLease.room !== frame.room) {
                throw new Error(`no such attach lease ${act.lease_id}`);
              }
              daemon.heartbeatAttachLease(act.lease_id);
            } else if (act.act === 'attach_complete') {
              const attachLease = daemon.store.getAttachLease(act.lease_id);
              if (!attachLease || attachLease.room !== frame.room) {
                throw new Error(`no such attach lease ${act.lease_id}`);
              }
              const completed = daemon.completeAttachLease(act.lease_id);
              send({
                type: 'attach_lease',
                status: completed.status,
                lease: completed.lease,
                member: completed.member,
              });
              // harn:end attach-lease-actions-room-bound
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
            // harn:assume live-delivery-consumption-is-idempotent ref=consume-act-dispatch
            else if (act.act === 'consume_delivery') {
              const consumed = daemon.consumeDelivery(frame.room, act.delivery_id, actor.id);
              send({ type: 'consume_result', ...consumed });
            }
            // harn:end live-delivery-consumption-is-idempotent
            // harn:assume live-agent-waits-are-transient ref=wait-act-dispatch
            else if (act.act === 'wait_begin') {
              if (principal.kind !== 'agent') throw new Error('forbidden: waits require an agent credential');
              daemon.beginWait(frame.room, actor.id, {
                reason: act.reason,
                peers: act.peers,
                until_ts: act.until_ts,
              });
            } else if (act.act === 'wait_end') {
              if (principal.kind !== 'agent') throw new Error('forbidden: waits require an agent credential');
              daemon.endWait(frame.room, actor.id);
            }
            // harn:end live-agent-waits-are-transient
            else if (act.act === 'spawn') {
              daemon.spawnMember(frame.room, {
                harness: act.harness,
                handle: act.handle,
                cwd: act.cwd,
                policy: act.policy,
                model: act.model,
                thinking: act.thinking,
                purpose: act.purpose,
              });
            } else if (act.act === 'configure') {
              daemon.configureMember(
                frame.room,
                act.member_id,
                { model: act.model, thinking: act.thinking, policy: act.policy },
                { actor: actor.id },
              );
            } else if (act.act === 'rename') daemon.renameMember(frame.room, act.member_id, act.handle, act.display_name);
            else if (act.act === 'revive') daemon.reviveMember(frame.room, act.member_id);
            else if (act.act === 'kill') daemon.killMember(frame.room, act.member_id);
            else if (act.act === 'remove') daemon.removeMember(frame.room, act.member_id);
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
    bindProtocol(ipcWss, (url) => {
      const candidate = url.searchParams.get('token') ?? undefined;
      return candidate === undefined ? { kind: 'owner' } : principalForToken(candidate);
    });
    try {
      await listenUnix(ipcServer, options.socketPath);
    } catch (error) {
      unsubscribeFrames();
      stopDeviceRevocations?.();
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
      stopDeviceRevocations?.();
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
