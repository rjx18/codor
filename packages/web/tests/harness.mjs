// E2E harness: boots a real daemon + server (serving the built SPA) with a
// FakeAdapter, plus a node-only control endpoint the Playwright runner uses
// to script turns, holds, and server-side answers.
import { createServer } from 'node:http';
import { createECDH } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CryptoVault,
  Daemon,
  FakeAdapter,
  LedgerManager,
  pairingUrl,
  PushProducer,
  PushSubscriptionStore,
  startServer,
} from '@wireroom/switchboard';
import { createRelayServer } from '@wireroom/relay';

const API_PORT = 8137;
const CONTROL_PORT = 8138;
const RELAY_PORT = 8139;
const TOKEN = 'e2e-token';

const dir = mkdtempSync(join(tmpdir(), 'wireroom-e2e-'));
const fake = new FakeAdapter('fake', { extensions: true });
const ledger = new LedgerManager({ dataDir: dir });
const crypto = new CryptoVault(dir);
crypto.roomKeys.ensureRoom('eng');
const pushSubscriptions = new PushSubscriptionStore(dir, crypto.keys);
const pushed = [];
const relay = createRelayServer({
  allowedSenders: new Set([crypto.keys.identity.sign_public_key]),
  openMode: false,
  push: {
    send: async (subscription, sealed, ttl) => {
      pushed.push({ subscription, sealed: Buffer.from(sealed), ttl });
    },
  },
});
await relay.listen({ host: '127.0.0.1', port: RELAY_PORT });
const pushProducer = new PushProducer({
  relayUrl: `http://127.0.0.1:${String(RELAY_PORT)}`,
  identity: crypto.keys.identity,
  roomKeys: crypto.roomKeys,
  subscriptions: pushSubscriptions,
});
const daemon = new Daemon({
  dbPath: join(dir, 'db.sqlite'),
  blobRoot: join(dir, 'blobs'),
  adapters: [fake],
  ledger,
  pushProducer,
});
daemon.createRoom({ id: 'eng', name: 'Engineering', owner: { handle: 'richard', display_name: 'Richard' } });
const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/work' });
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const vapidPublicKey = vapid.getPublicKey().toString('base64url');

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
await startServer({
  daemon,
  token: TOKEN,
  port: API_PORT,
  staticRoot,
  crypto,
  pushSubscriptions,
  pushVapidPublicKey: vapidPublicKey,
});

const readBody = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body === '' ? {} : JSON.parse(body)));
  });

createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/enqueue') {
      for (const turn of body.turns) {
        if (turn.kind === 'ask') {
          fake.enqueue({
            kind: 'ask',
            card: {
              kind: turn.cardKind ?? 'ask',
              prompt: turn.prompt,
              options: turn.options.map((label) => ({ label })),
              ...(turn.tool !== undefined && { tool: turn.tool }),
            },
            reply: (answer) => `${turn.replyPrefix ?? ''}${String(answer)}`,
          });
        } else {
          fake.enqueue(turn);
        }
      }
    } else if (url.pathname === '/answer') {
      const pending = daemon.store.listInteractions('eng', 'pending')[0];
      if (!pending) throw new Error('no pending interaction');
      await daemon.answerInteraction('eng', pending.id, body.label);
    } else if (url.pathname === '/hold') {
      // Construct an operator-attention hold: a real queued delivery, parked.
      const owner = daemon.ownerOf('eng');
      const message = daemon.store.postMessage('eng', {
        author: owner.id,
        kind: 'chat',
        body: body.body ?? '@alpha parked work item',
      });
      const delivery = daemon.store.createDelivery('eng', { message_id: message.id, recipient: alpha.id });
      daemon.holdDelivery('eng', delivery.id, body.reason ?? 'e2e hold');
    } else if (url.pathname === '/push-hold') {
      pushed.length = 0;
      fake.enqueue({ kind: 'complete', final_text: '@richard released from notification' });
      const owner = daemon.ownerOf('eng');
      const message = daemon.store.postMessage('eng', {
        author: owner.id,
        kind: 'chat',
        body: body.body ?? '@alpha deploy after review',
      });
      const delivery = daemon.store.createDelivery('eng', {
        message_id: message.id,
        recipient: alpha.id,
        state: 'queued',
      });
      daemon.holdDelivery('eng', delivery.id, 'turn brake before hop 4');
      await daemon.settle();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        message_id: message.id,
        delivery_id: delivery.id,
      }));
      return;
    } else if (url.pathname === '/rotate-room-key') {
      const removable = new CryptoVault(mkdtempSync(join(tmpdir(), 'wireroom-revoked-device-')));
      const peer = crypto.keys.enrollPeer({
        ...removable.keys.publicIdentity(),
        kind: 'device',
        label: 'revocation regression fixture',
      });
      crypto.roomKeys.enrollPeer(peer);
      crypto.revokePeer(peer.device_id);
      removable.close();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        generation: crypto.roomKeys.roomGeneration('eng'),
      }));
      return;
    } else if (url.pathname === '/next-push') {
      const notification = pushed.shift();
      if (!notification) throw new Error('no captured push');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        sealed: notification.sealed.toString('base64'),
        ttl: notification.ttl,
      }));
      return;
    } else if (url.pathname === '/seed-history') {
      const owner = daemon.ownerOf('eng');
      const messages = [];
      for (let index = 1; index <= 75; index++) {
        messages.push(daemon.store.postMessage('eng', {
          author: owner.id,
          kind: 'chat',
          body: `archive-entry-${String(index).padStart(4, '0')}`,
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        first: messages[0].id,
        last: messages.at(-1).id,
      }));
      return;
    } else if (url.pathname === '/pair-offer') {
      const offer = crypto.pairing.issue(`http://127.0.0.1:${String(API_PORT)}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        url: pairingUrl(offer),
      }));
      return;
    } else if (url.pathname === '/peers') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        peers: crypto.keys.listPeers(),
      }));
      return;
    } else if (url.pathname === '/ledger-init') {
      daemon.addLedgerNote('eng', {
        name: body.name ?? 'risk-limits',
        type: body.type ?? 'constraint',
        author: body.author ?? 'richard',
        body: body.noteBody ?? 'Keep exposure below 2%.',
      });
    } else if (url.pathname === '/ledger-direct') {
      const name = body.name ?? 'risk-limits';
      writeFileSync(
        join(dir, 'rooms', 'eng', 'ledger', 'constraints', `${name}.md`),
        `---\nname: ${name}\ntype: constraint\n---\n${body.noteBody ?? 'Keep exposure below 1%.'}\n`,
      );
    } else if (url.pathname !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
}).listen(CONTROL_PORT, '127.0.0.1', () => {
  console.log(`wireroom e2e harness up: api :${API_PORT}, control :${CONTROL_PORT}`);
});
