// harn:assume relay-worker-stays-blind ref=blind-router
// Blind relay router (PLAN §4.1). Routes by request method and URL path ONLY.
// It MUST NOT read, parse, or log request or response bodies, and this package
// MUST keep zero runtime dependencies and no cryptographic code — the relay
// only ever forwards opaque ciphertext and holds no key material.
import { PairingRoom } from './pairing-room.js';
import { SessionRelay } from './session-relay.js';

export interface Env {
  PAIRING_ROOM: DurableObjectNamespace;
  SESSION_RELAY: DurableObjectNamespace;
}

const PAIR_WS_ROUTE = /^\/v1\/pair\/([^/]+)\/ws$/;
const SESSION_WS_ROUTE = /^\/v1\/session\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === 'GET' && pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    if (method === 'POST' && pathname === '/v1/pair/rooms') {
      return reservePairingRoom(env);
    }

    const pairMatch = PAIR_WS_ROUTE.exec(pathname);
    if (method === 'GET' && pairMatch) {
      const nameplate = pairMatch[1];
      if (!isValidNameplate(nameplate)) {
        return new Response('invalid nameplate', { status: 400 });
      }
      const role = url.searchParams.get('role');
      if (role !== 'host' && role !== 'claim') {
        return new Response('missing or invalid role', { status: 400 });
      }
      const id = env.PAIRING_ROOM.idFromName(nameplate);
      return env.PAIRING_ROOM.get(id).fetch(request);
    }

    const sessionMatch = SESSION_WS_ROUTE.exec(pathname);
    if (method === 'GET' && sessionMatch) {
      const sessionId = sessionMatch[1];
      if (!isValidSessionId(sessionId)) {
        return new Response('invalid session id', { status: 400 });
      }
      const role = url.searchParams.get('role');
      if (role !== 'host' && role !== 'client') {
        return new Response('missing or invalid role', { status: 400 });
      }
      const id = env.SESSION_RELAY.idFromName(sessionId);
      return env.SESSION_RELAY.get(id).fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { PairingRoom, SessionRelay };
// harn:end relay-worker-stays-blind

// harn:assume session-capability-addressing ref=session-id-gate
// A session id is 32 random bytes rendered as 64 lowercase hex chars (PLAN
// §4.1). Possession of this unguessable id is the only capability the relay
// checks; there is no reservation. Reject anything that is not exactly this
// shape so a malformed id can never address a session Durable Object.
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;

function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}
// harn:end session-capability-addressing

// harn:assume pairing-nameplate-reservation ref=nameplate-reservation
// 32-symbol pairing alphabet (routing only, no crypto): the nameplate is
// chars 1-2 of the displayed pairing code, so it must draw from the same
// alphabet the code uses. Deliberately duplicated here to keep the Worker
// dependency-free.
const NAMEPLATE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const NAMEPLATE_LENGTH = 2;
const MAX_RESERVE_ATTEMPTS = 5;
const NAMEPLATE_PATTERN = new RegExp(`^[${NAMEPLATE_ALPHABET}]{${NAMEPLATE_LENGTH}}$`);

/** A well-formed nameplate is exactly two symbols from the pairing alphabet. */
function isValidNameplate(nameplate: string): boolean {
  return NAMEPLATE_PATTERN.test(nameplate);
}

function randomNameplate(): string {
  const bytes = new Uint8Array(NAMEPLATE_LENGTH);
  crypto.getRandomValues(bytes);
  let nameplate = '';
  for (const byte of bytes) nameplate += NAMEPLATE_ALPHABET[byte & 31];
  return nameplate;
}

/** POST /v1/pair/rooms: reserve a random nameplate, retrying up to 5 distinct ones. */
async function reservePairingRoom(env: Env): Promise<Response> {
  const tried = new Set<string>();
  while (tried.size < MAX_RESERVE_ATTEMPTS) {
    const nameplate = randomNameplate();
    if (tried.has(nameplate)) continue;
    tried.add(nameplate);
    const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(nameplate));
    const reserved = await room.fetch('https://relay.internal/reserve', { method: 'POST' });
    if (reserved.ok) return Response.json({ nameplate });
    // 409 busy → try another nameplate.
  }
  return Response.json({ error: 'exhausted' }, { status: 503 });
}
// harn:end pairing-nameplate-reservation
