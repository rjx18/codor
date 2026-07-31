import { RELAY_CLOSE, RELAY_KEEPALIVE_PING, RELAY_KEEPALIVE_PONG, type BurnReason, type PairingRole } from './control.js';
import type { Env } from './index.js';

// harn:assume pairing-room-lifecycle ref=pairing-room-behavior
// PairingRoom rendezvous Durable Object (PLAN §4.1). SQLite-backed, hibernatable.
// It enforces the 10-minute lifetime, the 3-attempt and 10-churn abuse bounds,
// and burn-after-use. Binary payloads (the PAKE + AEAD pairing channel) are
// forwarded verbatim between host and claimant — the room never inspects them,
// so the relay stays blind; only relay control text is parsed.
const ROLE_HOST: PairingRole = 'host';
const ROLE_CLAIM: PairingRole = 'claim';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_CHURN = 10;

interface RoleAttachment {
  role: PairingRole;
}

function otherRole(role: PairingRole): PairingRole {
  return role === ROLE_HOST ? ROLE_CLAIM : ROLE_HOST;
}

export class PairingRoom {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    // Answer the pairing host's §4.1 codor-ping at the runtime, mirroring
    // SessionRelay, so an idle mint-to-claim window can't leave the host's room
    // socket silently half-open. Re-armed on every wake (hibernation).
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_KEEPALIVE_PING, RELAY_KEEPALIVE_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/reserve')) {
      return this.reserve();
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const role = url.searchParams.get('role');
    if (role !== ROLE_HOST && role !== ROLE_CLAIM) {
      return new Response('missing or invalid role', { status: 400 });
    }
    return this.accept(role);
  }

  /** Reserve the room and arm the 10-minute burn alarm. 409 if already reserved. */
  private async reserve(): Promise<Response> {
    if (await this.state.storage.get('reserved')) {
      return Response.json({ error: 'busy' }, { status: 409 });
    }
    await this.state.storage.put({ reserved: true, attempts: 0, churn: 0, created_at: Date.now() });
    await this.state.storage.setAlarm(Date.now() + TEN_MINUTES_MS);
    return new Response('ok');
  }

  private async accept(role: PairingRole): Promise<Response> {
    // A socket may only join a reserved (armed) room. This bounds rooms to the
    // reserved nameplate space, blocks pre-occupying a slot before reservation,
    // and prevents reconnecting after a burn wipes storage (burn-after-use).
    if (!(await this.state.storage.get('reserved'))) {
      return new Response('room not reserved', { status: 409 });
    }
    if (role === ROLE_HOST) {
      // Newest host wins: supersede any existing host socket.
      for (const existing of this.state.getWebSockets(ROLE_HOST)) {
        this.closeSocket(existing, RELAY_CLOSE.SUPERSEDED, 'superseded');
      }
    } else {
      // At most one claimant at a time.
      if (this.state.getWebSockets(ROLE_CLAIM).length > 0) {
        return this.rejectSocket(RELAY_CLOSE.BUSY, 'busy');
      }
      const churn = ((await this.state.storage.get<number>('churn')) ?? 0) + 1;
      await this.state.storage.put('churn', churn);
      if (churn > MAX_CHURN) {
        await this.burn('churn');
        return this.rejectSocket(RELAY_CLOSE.BURN, 'burned');
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies RoleAttachment);
    // Tell the peer (if present) that this role just joined.
    for (const peer of this.state.getWebSockets(otherRole(role))) {
      this.sendJson(peer, { type: 'peer-joined', role });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const role = (ws.deserializeAttachment() as RoleAttachment | null)?.role;
    if (!role) return;

    if (typeof message === 'string') {
      // Control text is accepted only from the host.
      if (role !== ROLE_HOST) return;
      void this.handleHostControl(message);
      return;
    }

    // Binary is forwarded verbatim to the peer; the room never inspects it.
    const peers = this.state.getWebSockets(otherRole(role));
    if (peers.length === 0) {
      this.sendJson(ws, { type: 'no-peer' });
      return;
    }
    for (const peer of peers) {
      try {
        peer.send(message);
      } catch {
        // peer closing/closed; drop.
      }
    }
  }

  private async handleHostControl(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === 'fail') {
      for (const claimant of this.state.getWebSockets(ROLE_CLAIM)) {
        this.closeSocket(claimant, RELAY_CLOSE.REJECTED, 'rejected');
      }
      const attempts = ((await this.state.storage.get<number>('attempts')) ?? 0) + 1;
      await this.state.storage.put('attempts', attempts);
      if (attempts >= MAX_ATTEMPTS) await this.burn('attempts');
    } else if (type === 'success') {
      await this.burn('paired');
    }
  }

  webSocketClose(ws: WebSocket, code?: number, reason?: string): void {
    const role = (ws.deserializeAttachment() as RoleAttachment | null)?.role;
    if (role) {
      for (const peer of this.state.getWebSockets(otherRole(role))) {
        this.sendJson(peer, { type: 'peer-left', role });
      }
    }
    // The pinned compatibility date (< 2026-04-07) does not auto-reply to the
    // client's close frame; without this the socket lingers in CLOSING and keeps
    // occupying its slot. Echo a valid close code to complete the handshake.
    const echo = typeof code === 'number' && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
    this.closeSocket(ws, echo, reason ?? '');
  }

  webSocketError(ws: WebSocket): void {
    this.closeSocket(ws, 1011, 'error');
  }

  async alarm(): Promise<void> {
    await this.burn('expired');
  }

  /** Notify + close every socket, then wipe storage so the nameplate is reusable. */
  private async burn(reason: BurnReason): Promise<void> {
    const code = reason === 'paired' ? RELAY_CLOSE.PAIRED : RELAY_CLOSE.BURN;
    for (const ws of this.state.getWebSockets()) {
      this.sendJson(ws, { type: 'burned', reason });
      this.closeSocket(ws, code, reason);
    }
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  /** Accept a fresh socket only to deliver a close code (busy / churn burn). */
  private rejectSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (reason === 'burned') this.sendJson(server, { type: 'burned', reason: 'churn' });
    this.closeSocket(server, code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendJson(ws: WebSocket, value: unknown): void {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      // socket closing/closed; drop the notice.
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed.
    }
  }
}
// harn:end pairing-room-lifecycle
