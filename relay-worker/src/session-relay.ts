import { RELAY_CLOSE, RELAY_KEEPALIVE_PING, RELAY_KEEPALIVE_PONG, type SessionRole } from './control.js';
import type { Env } from './index.js';

// harn:assume session-relay-lifecycle ref=session-relay-behavior
// SessionRelay durable rendezvous (PLAN §4.1). One host multiplexes up to 16
// client connections. It never inspects payloads — it only adds/strips a 4-byte
// connId routing prefix — so the relay stays blind. Possession of the 256-bit
// session id is the sole capability; there is no alarm and no expiry.
const ROLE_HOST: SessionRole = 'host';
const ROLE_CLIENT: SessionRole = 'client';
const MAX_CLIENTS = 16;
const CONN_ID_BYTES = 4;

interface SessionAttachment {
  role: SessionRole;
  connId?: number;
}

export class SessionRelay {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    // Answer idle keepalives without waking the object (no app-level heartbeats).
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_KEEPALIVE_PING, RELAY_KEEPALIVE_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const role = new URL(request.url).searchParams.get('role');
    if (role === ROLE_HOST) return this.acceptHost();
    if (role === ROLE_CLIENT) return this.acceptClient();
    return new Response('missing or invalid role', { status: 400 });
  }

  private acceptHost(): Response {
    // Newest host wins.
    for (const existing of this.state.getWebSockets(ROLE_HOST)) {
      this.closeSocket(existing, RELAY_CLOSE.SUPERSEDED, 'superseded');
    }
    const { server, response } = this.admit({ role: ROLE_HOST });
    // Announce the host to every client, and re-announce every client to the
    // (possibly reconnected) host so it re-learns their connIds.
    for (const client of this.state.getWebSockets(ROLE_CLIENT)) {
      this.sendJson(client, { type: 'host-connected' });
      const connId = this.attachmentOf(client)?.connId;
      if (connId !== undefined) this.sendJson(server, { type: 'client-connected', conn: connId });
    }
    return response;
  }

  private async acceptClient(): Promise<Response> {
    if (this.state.getWebSockets(ROLE_CLIENT).length >= MAX_CLIENTS) {
      return this.rejectSocket(RELAY_CLOSE.FULL, 'full');
    }
    const connId = (await this.state.storage.get<number>('next_conn_id')) ?? 1;
    await this.state.storage.put('next_conn_id', connId + 1);
    const { server, response } = this.admit({ role: ROLE_CLIENT, connId });
    const host = this.currentHost();
    if (host) this.sendJson(host, { type: 'client-connected', conn: connId });
    // Tell the new client whether a host is currently present.
    this.sendJson(server, { type: host ? 'host-connected' : 'host-disconnected' });
    return response;
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === 'string') return; // keepalive is auto-answered; other text ignored
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;

    if (attachment.role === ROLE_CLIENT) {
      const host = this.currentHost();
      if (!host) return; // no host to reach; the client already knows via host-disconnected
      this.safeSend(host, this.frame(attachment.connId ?? 0, message));
      return;
    }

    // Ignore frames from a superseded host still finishing its close handshake:
    // getWebSockets() may keep returning a CLOSING socket, and newest-host-wins
    // means only the current OPEN host may deliver to clients.
    if (ws.readyState !== WebSocket.OPEN) return;
    // Host → client: the leading connId names the target.
    if (message.byteLength < CONN_ID_BYTES) return;
    const connId = new DataView(message).getUint32(0, false);
    const payload = message.slice(CONN_ID_BYTES);
    const target = this.state
      .getWebSockets(ROLE_CLIENT)
      .find((client) => this.attachmentOf(client)?.connId === connId);
    if (!target) {
      this.sendJson(ws, { type: 'unknown-conn', conn: connId });
      return;
    }
    this.safeSend(target, payload);
  }

  webSocketClose(ws: WebSocket, code?: number, reason?: string): void {
    const attachment = this.attachmentOf(ws);
    if (attachment?.role === ROLE_HOST) {
      // Only announce the host gone if no other host is still current (a
      // supersede leaves a newer OPEN host that clients should keep).
      const anotherHostOpen = this.state
        .getWebSockets(ROLE_HOST)
        .some((h) => h !== ws && h.readyState === WebSocket.OPEN);
      if (!anotherHostOpen) {
        for (const client of this.state.getWebSockets(ROLE_CLIENT)) {
          this.sendJson(client, { type: 'host-disconnected' });
        }
      }
    } else if (attachment?.role === ROLE_CLIENT && attachment.connId !== undefined) {
      const host = this.currentHost();
      if (host) this.sendJson(host, { type: 'client-disconnected', conn: attachment.connId });
    }
    // Complete the close handshake (pinned compat date has no auto close-reply).
    const echo = typeof code === 'number' && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
    this.closeSocket(ws, echo, reason ?? '');
  }

  webSocketError(ws: WebSocket): void {
    this.closeSocket(ws, 1011, 'error');
  }

  /** Accept a hibernatable server socket tagged by role, returning it and the 101 response. */
  private admit(attachment: SessionAttachment): { server: WebSocket; response: Response } {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [attachment.role]);
    server.serializeAttachment(attachment);
    return { server, response: new Response(null, { status: 101, webSocket: client }) };
  }

  /** Prefix a client payload with its 4-byte big-endian connId for the host. */
  private frame(connId: number, payload: ArrayBuffer): Uint8Array {
    const out = new Uint8Array(CONN_ID_BYTES + payload.byteLength);
    new DataView(out.buffer).setUint32(0, connId, false);
    out.set(new Uint8Array(payload), CONN_ID_BYTES);
    return out;
  }

  private attachmentOf(ws: WebSocket): SessionAttachment | null {
    return ws.deserializeAttachment() as SessionAttachment | null;
  }

  /** The current host is the OPEN host socket; a superseded one may linger while CLOSING. */
  private currentHost(): WebSocket | undefined {
    return this.state.getWebSockets(ROLE_HOST).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  private rejectSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    this.closeSocket(pair[1], code, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private sendJson(ws: WebSocket, value: unknown): void {
    this.safeSend(ws, JSON.stringify(value));
  }

  private safeSend(ws: WebSocket, data: ArrayBuffer | ArrayBufferView | string): void {
    try {
      ws.send(data as ArrayBuffer);
    } catch {
      // socket closing/closed; drop.
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
// harn:end session-relay-lifecycle
