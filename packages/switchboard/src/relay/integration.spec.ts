import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import {
  MessageReassembler,
  MuxStream,
  PairingChannel,
  PakeClaimant,
  SessionInitiator,
  SessionResponder,
  StreamKind,
  StreamMux,
  decodePairingMessage,
  frameMessage,
  generateTunnelKeypair,
  splitCode,
  type PairingMessage,
  type TunnelKeypair,
} from '@codor/tunnel';

import { CryptoVault } from './../crypto/pairing.js';
import { Daemon } from './../daemon.js';
import { FakeAdapter } from './../fake-adapter.js';
import { LedgerManager } from './../ledger/watch.js';
import { type RunningServer, startServer } from './../server.js';
import { RelayLink } from './link.js';
import { RelayPairingHost } from './pairing-host.js';
import { RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-int-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// §4.2 pairing (pairing-host ↔ real claimant ↔ PairingService) via in-memory room
// ---------------------------------------------------------------------------
class MockRoom {
  private hostCb?: (d: Uint8Array, bin: boolean) => void;
  private claimCb?: (d: Uint8Array, bin: boolean) => void;
  private hostClose?: () => void;
  private claimClose?: () => void;

  readonly hostSocket = {
    send: (data: Uint8Array | string) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data) as { type?: string };
        if (msg.type === 'success' || msg.type === 'fail') {
          this.claimClose?.();
          if (msg.type === 'success') this.hostClose?.();
        }
        return;
      }
      queueMicrotask(() => this.claimCb?.(data, true));
    },
    close: () => this.hostClose?.(),
    onMessage: (cb: (d: Uint8Array, b: boolean) => void) => (this.hostCb = cb),
    onOpen: (cb: () => void) => cb(),
    onClose: (cb: () => void) => (this.hostClose = cb),
    onError: () => {},
  };

  readonly claimSocket = {
    send: (data: Uint8Array | string) => {
      if (typeof data === 'string') return;
      queueMicrotask(() => this.hostCb?.(data, true));
    },
    close: () => this.claimClose?.(),
    onMessage: (cb: (d: Uint8Array, b: boolean) => void) => (this.claimCb = cb),
    onOpen: (cb: () => void) => cb(),
    onClose: (cb: () => void) => (this.claimClose = cb),
    onError: () => {},
  };

  join(): void {
    queueMicrotask(() => this.hostCb?.(utf8(JSON.stringify({ type: 'peer-joined', role: 'claim' })), false));
  }
}

describe('relay pairing end-to-end (pairing-host ↔ real claimant ↔ PairingService)', () => {
  it('pairs a browser through the room and enrolls it into the existing identity system', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('wss://relay.test');

    const room = new MockRoom();
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.hostSocket,
      now: () => 0,
    });

    const offer = await pairingHost.pair();
    const { secret } = splitCode(offer.pairing_code);

    const browser = new CryptoVault(join(dir, 'browser'));
    const browserId = browser.keys.publicIdentity();
    const clientStatic = generateTunnelKeypair();
    const claimant = new PakeClaimant({ nameplate: 'AA', secret });

    let channel: PairingChannel | undefined;
    let enrolledResult: unknown;
    const done = new Promise<void>((resolve, reject) => {
      room.claimSocket.onMessage((data) => {
        try {
          if (!channel) {
            if (data.length === 48) {
              const { msgB, tagC } = claimant.receiveMsgA(data);
              room.claimSocket.send(msgB);
              room.claimSocket.send(tagC);
            } else if (data.length === 32) {
              claimant.receiveHostConfirmation(data);
              channel = new PairingChannel(claimant.channel());
            }
            return;
          }
          const message = decodePairingMessage(claimant.channel().open(data));
          if (message.type === 'hello') {
            const enroll: PairingMessage = {
              type: 'enroll',
              request: { ...browserId, kind: 'device', label: 'phone' },
              client_static_pub: b64(clientStatic.publicKey),
              pairing_token: message.pairing_token,
            };
            room.claimSocket.send(channel.seal(enroll));
          } else if (message.type === 'enrolled') {
            enrolledResult = message.result;
            room.claimSocket.send(channel.seal({ type: 'done' }));
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    room.join();
    await done;

    expect(host.keys.getPeer(browserId.device_id)).toBeTruthy();
    expect(store.listDevices()[0]?.device_id).toBe(browserId.device_id);
    expect(store.clientStaticPubByKid(store.listDevices()[0].kid)).toBe(b64(clientStatic.publicKey));
    expect((enrolledResult as { room_keys?: unknown[] }).room_keys).toBeDefined();

    // The relay enrollment burned the SINGLE shared grant, so the very same code
    // no longer opens the local door: consuming one door dies at both.
    expect(() => host.pairing.exchange(offer.pairing_code)).toThrow();

    host.close();
    browser.close();
  });

  it('fails the claimant (no silent hang) when enrollment hits a grant already consumed at the local door', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('wss://relay.test');

    const room = new MockRoom();
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.hostSocket,
      now: () => 0,
    });

    const offer = await pairingHost.pair();
    const { secret } = splitCode(offer.pairing_code);
    const browser = new CryptoVault(join(dir, 'browser'));
    const clientStatic = generateTunnelKeypair();
    const claimant = new PakeClaimant({ nameplate: 'AA', secret });

    let channel: PairingChannel | undefined;
    let claimClosed = false;
    const settled = new Promise<void>((resolve, reject) => {
      room.claimSocket.onClose(() => {
        claimClosed = true; // host sent {type:'fail'} → room closed the claimant
        resolve();
      });
      room.claimSocket.onMessage((data) => {
        try {
          if (!channel) {
            if (data.length === 48) {
              const { msgB, tagC } = claimant.receiveMsgA(data);
              room.claimSocket.send(msgB);
              room.claimSocket.send(tagC);
            } else if (data.length === 32) {
              claimant.receiveHostConfirmation(data);
              channel = new PairingChannel(claimant.channel());
            }
            return;
          }
          const message = decodePairingMessage(claimant.channel().open(data));
          if (message.type === 'hello') {
            // Consume the shared grant at the LOCAL door first, so the relay's
            // pre-minted token is now dead. The host must signal fail, not hang.
            host.pairing.exchange(offer.pairing_code);
            const enroll: PairingMessage = {
              type: 'enroll',
              request: { ...browser.keys.publicIdentity(), kind: 'device', label: 'phone' },
              client_static_pub: b64(clientStatic.publicKey),
              pairing_token: message.pairing_token,
            };
            room.claimSocket.send(channel.seal(enroll));
          } else if (message.type === 'enrolled') {
            reject(new Error('enrollment must not succeed against a dead grant'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    room.join();
    await settled;
    expect(claimClosed).toBe(true);
    // The device was NOT enrolled, and the local door (already consumed) stays dead.
    expect(host.keys.getPeer(browser.keys.publicIdentity().device_id)).toBeUndefined();
    host.close();
    browser.close();
  });

  it('N1: replays the cached enrolled to the same device after a lost ack, enrolling once', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('wss://relay.test');
    const room = new MockRoom();
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.hostSocket,
      now: () => 0,
    });
    const offer = await pairingHost.pair();
    const { secret } = splitCode(offer.pairing_code);
    const browser = new CryptoVault(join(dir, 'browser'));
    const browserId = browser.keys.publicIdentity();
    const firstStatic = generateTunnelKeypair();
    // A REAL retry re-generates its tunnel static key (as a fresh browser does),
    // so the replay must migrate key custody, not just re-send the message.
    const retryStatic = generateTunnelKeypair();
    const claimant = new PakeClaimant({ nameplate: 'AA', secret });
    const enroll = (token: string, key: TunnelKeypair): PairingMessage => ({
      type: 'enroll',
      request: { ...browserId, kind: 'device', label: 'phone' },
      client_static_pub: b64(key.publicKey),
      pairing_token: token,
    });

    // A KK session handshake against the host's stored key for `device`: succeeds
    // iff the store holds `key`'s static pub under its kid.
    const handshakeSucceeds = (key: TunnelKeypair): boolean => {
      const sid = new Uint8Array(32).fill(7);
      const responder = new SessionResponder({
        hostStatic: store.hostStatic,
        sessionId: sid,
        lookupClientStatic: (kid) => {
          const pub = store.clientStaticPubByKid(Buffer.from(kid).toString('hex'));
          return pub ? new Uint8Array(Buffer.from(pub, 'base64')) : undefined;
        },
      });
      const initiator = new SessionInitiator({ clientStatic: key, hostStaticPub: store.hostStatic.publicKey, sessionId: sid });
      try {
        const msg2 = responder.receiveMsg1(initiator.start());
        responder.receiveMsg3(initiator.receiveMsg2(msg2));
        return true;
      } catch {
        return false;
      }
    };

    let channel: PairingChannel | undefined;
    let enrolledCount = 0;
    let firstResult: unknown;
    let lastResult: unknown;
    const done = new Promise<void>((resolve, reject) => {
      room.claimSocket.onMessage((data) => {
        try {
          if (!channel) {
            if (data.length === 48) {
              const { msgB, tagC } = claimant.receiveMsgA(data);
              room.claimSocket.send(msgB);
              room.claimSocket.send(tagC);
            } else if (data.length === 32) {
              claimant.receiveHostConfirmation(data);
              channel = new PairingChannel(claimant.channel());
            }
            return;
          }
          const message = decodePairingMessage(claimant.channel().open(data));
          if (message.type === 'hello') {
            room.claimSocket.send(channel.seal(enroll(message.pairing_token, firstStatic)));
          } else if (message.type === 'enrolled') {
            enrolledCount += 1;
            if (enrolledCount === 1) {
              firstResult = message.result;
              // Lost enrolled ack: the browser retries with a FRESH static key.
              room.claimSocket.send(channel.seal(enroll('dead-token', retryStatic)));
            } else {
              lastResult = message.result;
              resolve();
            }
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    room.join();
    await done;
    expect(enrolledCount).toBe(2); // original enrolled + one replay
    expect(lastResult).toEqual(firstResult); // same PairingResult (room keys bind the device identity)
    expect(store.listDevices()).toHaveLength(1); // enrolled ONCE, not twice
    expect(host.keys.getPeer(browserId.device_id)).toBeTruthy();
    // Key custody MIGRATED to the retry's key: the end-to-end property is that a
    // KK handshake with the NEW key succeeds and the OLD key is now stranded.
    expect(store.clientStaticPubByKid(store.listDevices()[0]!.kid)).toBe(b64(retryStatic.publicKey));
    expect(handshakeSucceeds(retryStatic)).toBe(true);
    expect(handshakeSucceeds(firstStatic)).toBe(false);
    host.close();
    browser.close();
  });

  it('N1: a different device after success gets failed, not the cached replay', async () => {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('wss://relay.test');
    const room = new MockRoom();
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.hostSocket,
      now: () => 0,
    });
    const offer = await pairingHost.pair();
    const { secret } = splitCode(offer.pairing_code);
    const deviceA = new CryptoVault(join(dir, 'browserA'));
    const deviceB = new CryptoVault(join(dir, 'browserB'));
    const clientStatic = generateTunnelKeypair();
    const claimant = new PakeClaimant({ nameplate: 'AA', secret });
    const enroll = (id: typeof deviceA, token: string): PairingMessage => ({
      type: 'enroll',
      request: { ...id.keys.publicIdentity(), kind: 'device', label: 'phone' },
      client_static_pub: b64(clientStatic.publicKey),
      pairing_token: token,
    });

    let channel: PairingChannel | undefined;
    let enrolledForA = false;
    let claimClosed = false;
    const settled = new Promise<void>((resolve, reject) => {
      room.claimSocket.onClose(() => {
        claimClosed = true; // host failed the second (different) device
        resolve();
      });
      room.claimSocket.onMessage((data) => {
        try {
          if (!channel) {
            if (data.length === 48) {
              const { msgB, tagC } = claimant.receiveMsgA(data);
              room.claimSocket.send(msgB);
              room.claimSocket.send(tagC);
            } else if (data.length === 32) {
              claimant.receiveHostConfirmation(data);
              channel = new PairingChannel(claimant.channel());
            }
            return;
          }
          const message = decodePairingMessage(claimant.channel().open(data));
          if (message.type === 'hello') {
            room.claimSocket.send(channel.seal(enroll(deviceA, message.pairing_token)));
          } else if (message.type === 'enrolled') {
            enrolledForA = true;
            // A DIFFERENT device tries to reuse the burned grant → must fail, not replay.
            room.claimSocket.send(channel.seal(enroll(deviceB, 'dead-token')));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    room.join();
    await settled;
    expect(enrolledForA).toBe(true);
    expect(claimClosed).toBe(true); // device B failed (fail → room closed the claimant)
    expect(host.keys.getPeer(deviceA.keys.publicIdentity().device_id)).toBeTruthy();
    expect(host.keys.getPeer(deviceB.keys.publicIdentity().device_id)).toBeUndefined();
    host.close();
    deviceA.close();
    deviceB.close();
  });
});

// ---------------------------------------------------------------------------
// §4.1/§4.3/§4.4 session: RelayLink ↔ mock session relay ↔ real switchboard
// ---------------------------------------------------------------------------
/** Faithful §4.1 mock session relay: 4-byte connId prefix add/strip + presence. */
function startMockRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const sessions = new Map<string, { host?: WebSocket; clients: Map<number, WebSocket>; next: number }>();
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://x');
    const match = url.pathname.match(/^\/v1\/session\/([^/]+)\/ws$/);
    if (!match) return ws.close();
    const sid = match[1];
    let session = sessions.get(sid);
    if (!session) {
      session = { clients: new Map(), next: 1 };
      sessions.set(sid, session);
    }
    if (url.searchParams.get('role') === 'host') {
      session.host = ws;
      for (const conn of session.clients.keys()) ws.send(JSON.stringify({ type: 'client-connected', conn }));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary || data.length < 4) return;
        session!.clients.get(data.readUInt32BE(0))?.send(data.subarray(4), { binary: true });
      });
    } else {
      const conn = session.next++;
      session.clients.set(conn, ws);
      session.host?.send(JSON.stringify({ type: 'client-connected', conn }));
      ws.send(JSON.stringify({ type: session.host ? 'host-connected' : 'host-disconnected' }));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        const framed = Buffer.allocUnsafe(4 + data.length);
        framed.writeUInt32BE(conn, 0);
        data.copy(framed, 4);
        session!.host?.send(framed, { binary: true });
      });
      ws.on('close', () => {
        session!.clients.delete(conn);
        session!.host?.send(JSON.stringify({ type: 'client-disconnected', conn }));
      });
    }
  });
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const port = (http.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => http.close(() => r()));
          }),
      });
    });
  });
}

const TOKEN = 'owner-token';

interface Harness {
  server: RunningServer;
  daemon: Daemon;
  crypto: CryptoVault;
  store: RelayStore;
  link: RelayLink;
  relay: { port: number; close: () => Promise<void> };
  browser: { id: ReturnType<CryptoVault['keys']['publicIdentity']>; clientStatic: TunnelKeypair };
  stopRevocation: () => void;
}

async function bootstrap(): Promise<Harness> {
  const crypto = new CryptoVault(join(dir, 'host'));
  const fake = new FakeAdapter('fake', {});
  Object.assign(fake, { executable: 'fake' });
  const daemon = new Daemon({
    dbPath: join(dir, 'db.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [fake],
    ledger: new LedgerManager({ dataDir: dir }),
    homeDir: dir,
    executableOnPath: () => true,
  });
  daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' } });
  crypto.roomKeys.ensureRoom('eng');

  const server = await startServer({ daemon, token: TOKEN, crypto, homeDir: dir });

  const relay = await startMockRelay();
  const store = new RelayStore(join(dir, 'host'));
  store.enable(`ws://127.0.0.1:${relay.port}`);

  // Seed a paired browser: enrolled in the switchboard AND the relay store.
  const browserVault = new CryptoVault(join(dir, 'browser'));
  const browserId = browserVault.keys.publicIdentity();
  const clientStatic = generateTunnelKeypair();
  crypto.pairing.completeTrusted({ ...browserId, kind: 'device', label: 'phone' });
  store.addDevice({ device_id: browserId.device_id, client_static_pub: b64(clientStatic.publicKey) });
  browserVault.close(); // browserId + clientStatic captured; stop its peers.json watcher

  const link = new RelayLink({
    store,
    loopbackPort: server.port,
    isDeviceActive: (deviceId) => crypto.keys.getPeer(deviceId) !== undefined,
  });
  const stopRevocation = crypto.keys.onPeerRevoked((deviceId) => {
    link.dropDevice(deviceId);
    store.removeDevice(deviceId);
  });
  link.start();
  await delay(50); // let the host session socket connect to the mock relay

  return { server, daemon, crypto, store, link, relay, browser: { id: browserId, clientStatic }, stopRevocation };
}

/** A browser-side session client: connects, KK-handshakes, and drives the client mux. */
class SessionClient {
  private ws: WebSocket;
  private initiator: SessionInitiator;
  private mux?: StreamMux;
  private channel = false;
  ready: Promise<void>;
  refused = false;

  constructor(relayPort: number, store: RelayStore, clientStatic: TunnelKeypair) {
    this.ws = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/session/${store.sessionId}/ws?role=client`);
    this.ws.binaryType = 'nodebuffer';
    this.initiator = new SessionInitiator({
      clientStatic,
      hostStaticPub: store.hostStatic.publicKey,
      sessionId: store.sessionIdBytes,
    });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    this.ws.on('open', () => this.ws.send(this.initiator.start()));
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = new Uint8Array(data);
      if (!this.mux) {
        // msg2 → produce msg3 → establish the client channel + mux.
        const msg3 = this.initiator.receiveMsg2(bytes);
        this.ws.send(msg3);
        const channel = this.initiator.channel();
        this.channel = true;
        this.mux = new StreamMux({
          role: 'client',
          onPacket: (packet) => this.ws.send(channel.seal(packet)),
          onStream: () => {},
        });
        (this as { channelObj?: ReturnType<SessionInitiator['channel']> }).channelObj = channel;
        resolveReady();
        return;
      }
      const channel = (this as { channelObj?: ReturnType<SessionInitiator['channel']> }).channelObj!;
      this.mux.receivePacket(channel.open(bytes));
    });
    // If the host refuses (no msg2 within the window), mark refused.
    setTimeout(() => {
      if (!this.channel) this.refused = true;
    }, 300);
  }

  openStream(kind: number, token?: Uint8Array): MuxStream {
    return this.mux!.openStream(kind, token ? { token } : {});
  }

  close(): void {
    this.ws.close();
  }
}

/** GET through an HTTP tunnel stream; resolves { status, body }. */
function httpGet(client: SessionClient, target: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const stream = client.openStream(StreamKind.HTTP);
    let status = 0;
    const chunks: Uint8Array[] = [];
    stream.onHead = (head) => {
      status = (head as { status: number }).status;
    };
    stream.onData = (chunk) => {
      chunks.push(chunk);
      stream.consume(chunk.length);
    };
    stream.onEnd = () => {
      try {
        const text = fromUtf8(new Uint8Array(chunks.flatMap((c) => [...c])));
        resolve({ status, body: text ? JSON.parse(text) : undefined });
      } catch (error) {
        reject(error);
      }
    };
    stream.onReset = (reason) => reject(new Error(`http stream reset: ${reason}`));
    stream.sendHead({ method: 'GET', target, headers: { authorization: `Bearer ${TOKEN}` } });
    stream.end();
  });
}

describe('relay session end-to-end (RelayLink ↔ mock relay ↔ real switchboard)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootstrap();
  });
  afterEach(async () => {
    h.stopRevocation();
    h.link.stop();
    await h.server.close();
    await h.relay.close();
    h.crypto.close();
  });

  it('tunnels an HTTP request to the real /api and returns live data', async () => {
    const client = new SessionClient(h.relay.port, h.store, h.browser.clientStatic);
    await client.ready;
    const { status, body } = await httpGet(client, '/api/rooms');
    expect(status).toBe(200);
    expect(Array.isArray((body as { rooms?: unknown[] }).rooms)).toBe(true);
    expect((body as { rooms: { id: string }[] }).rooms.some((r) => r.id === 'eng')).toBe(true);
    client.close();
  });

  it('tunnels the app-WS protocol to the real /ws (subscribe → server frames)', async () => {
    const client = new SessionClient(h.relay.port, h.store, h.browser.clientStatic);
    await client.ready;
    const stream = client.openStream(StreamKind.APP_WS, utf8(TOKEN));
    const reassembler = new MessageReassembler();
    const frames: unknown[] = [];
    const gotFrame = new Promise<void>((resolve) => {
      stream.onData = (chunk) => {
        stream.consume(chunk.length);
        for (const message of reassembler.push(chunk)) {
          frames.push(JSON.parse(fromUtf8(message)));
        }
        if (frames.length > 0) resolve();
      };
    });
    // App-WS messages are length-delimited over the mux (browser bridge contract).
    stream.write(frameMessage(utf8(JSON.stringify({ type: 'subscribe', room: 'eng', since_seq: 0 }))));
    await Promise.race([gotFrame, delay(1500)]);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => typeof (f as { type?: unknown }).type === 'string')).toBe(true);
    client.close();
  });

  it('resets a tunneled request body that exceeds the 32 MiB cap (no unbounded buffering)', async () => {
    const client = new SessionClient(h.relay.port, h.store, h.browser.clientStatic);
    await client.ready;
    const stream = client.openStream(StreamKind.HTTP);
    const reset = new Promise<string>((resolve) => {
      stream.onReset = (reason) => resolve(reason);
    });
    stream.sendHead({ method: 'POST', target: '/api/rooms', headers: { authorization: `Bearer ${TOKEN}` } });
    const oneMiB = new Uint8Array(1024 * 1024).fill(1);
    for (let i = 0; i < 34; i++) {
      try {
        stream.write(oneMiB);
      } catch {
        break; // stream reset mid-write
      }
    }
    expect(await Promise.race([reset, delay(5000).then(() => 'TIMEOUT')])).toBe('request-too-large');
    client.close();
  });

  it('refuses a revoked device on its next handshake', async () => {
    // Sanity: works before revocation.
    const before = new SessionClient(h.relay.port, h.store, h.browser.clientStatic);
    await before.ready;
    before.close();

    h.crypto.revokePeer(h.browser.id.device_id);
    await delay(50);

    const after = new SessionClient(h.relay.port, h.store, h.browser.clientStatic);
    await Promise.race([after.ready, delay(400)]);
    expect(after.refused).toBe(true); // no msg2 → handshake never established
    after.close();
  });
});
