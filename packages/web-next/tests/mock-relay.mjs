// Faithful in-process §4.1 mock relay for the e2e (authorized fallback, msg #51):
// pairing rooms (verbatim binary + peer-joined + host fail/success burn) and the
// session relay (4-byte connId prefix add/strip + presence). No crypto — it only
// forwards ciphertext, exactly like the real blind relay-worker.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const nameplate = () => ALPHABET[Math.floor(Math.random() * 32)] + ALPHABET[Math.floor(Math.random() * 32)];

export async function startMockRelay() {
  const http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/pair/rooms') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nameplate: nameplate() }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http });
  const rooms = new Map(); // nameplate -> { host, claim }
  const sessions = new Map(); // sessionId -> { host, clients: Map<connId, ws>, next }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const role = url.searchParams.get('role');
    ws.binaryType = 'nodebuffer';
    const pair = url.pathname.match(/^\/v1\/pair\/([^/]+)\/ws$/);
    const session = url.pathname.match(/^\/v1\/session\/([^/]+)\/ws$/);
    if (pair) handlePairing(pair[1], role, ws, rooms);
    else if (session) handleSession(session[1], role, ws, sessions);
    else ws.close();
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = http.address().port;
  return {
    url: `ws://127.0.0.1:${port}`,
    /** Force every session host offline (browsers then reconnect) — the e2e "kill" leg. */
    dropHosts() {
      for (const s of sessions.values()) {
        s.host?.close();
        s.host = undefined;
        for (const client of s.clients.values()) client.close();
        s.clients.clear();
      }
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => http.close(resolve)));
    },
  };
}

function handlePairing(np, role, ws, rooms) {
  let room = rooms.get(np);
  if (!room) {
    room = {};
    rooms.set(np, room);
  }
  if (role === 'host') room.host = ws;
  else {
    room.claim = ws;
    room.host?.send(JSON.stringify({ type: 'peer-joined', role: 'claim' }));
  }
  ws.on('message', (data, isBinary) => {
    // §4.1 keepalive: answer codor-ping at the relay (before any JSON.parse),
    // mirroring the DO's setWebSocketAutoResponse so the pairing host's probe is
    // met and never mis-parsed as control.
    if (!isBinary && data.toString() === 'codor-ping') {
      ws.send('codor-pong');
      return;
    }
    const other = role === 'host' ? room.claim : room.host;
    if (isBinary) {
      other?.send(data, { binary: true });
      return;
    }
    if (role === 'host') {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'success') {
        room.claim?.close(1000);
        room.host?.close(1000);
        rooms.delete(np);
      } else if (msg.type === 'fail') {
        room.claim?.close(4003);
      }
    }
  });
  ws.on('close', () => {
    if (role === 'host' && room.host === ws) room.host = undefined;
    if (role === 'claim' && room.claim === ws) room.claim = undefined;
  });
}

function handleSession(sid, role, ws, sessions) {
  let s = sessions.get(sid);
  if (!s) {
    s = { clients: new Map(), next: 1 };
    sessions.set(sid, s);
  }
  if (role === 'host') {
    s.host = ws;
    for (const conn of s.clients.keys()) ws.send(JSON.stringify({ type: 'client-connected', conn }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'codor-ping') {
        ws.send('codor-pong'); // answer the host link's keepalive probe
        return;
      }
      if (!isBinary || data.length < 4) return;
      s.clients.get(data.readUInt32BE(0))?.send(data.subarray(4), { binary: true });
    });
    ws.on('close', () => {
      if (s.host === ws) s.host = undefined;
      for (const client of s.clients.values()) client.send(JSON.stringify({ type: 'host-disconnected' }));
    });
  } else {
    const conn = s.next++;
    s.clients.set(conn, ws);
    s.host?.send(JSON.stringify({ type: 'client-connected', conn }));
    ws.send(JSON.stringify({ type: s.host ? 'host-connected' : 'host-disconnected' }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'codor-ping') {
        ws.send('codor-pong'); // answer the browser client's keepalive probe
        return;
      }
      if (!isBinary) return;
      const framed = Buffer.allocUnsafe(4 + data.length);
      framed.writeUInt32BE(conn, 0);
      data.copy(framed, 4);
      s.host?.send(framed, { binary: true });
    });
    ws.on('close', () => {
      s.clients.delete(conn);
      s.host?.send(JSON.stringify({ type: 'client-disconnected', conn }));
    });
  }
}
