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
} from '@codor/switchboard';
import { createRelayServer } from '@codor/relay';

const API_PORT = 8137;
const CONTROL_PORT = 8138;
const RELAY_PORT = 8139;
const TOKEN = 'e2e-token';
const ADMIN_TOKEN = 'e2e-admin-token';
const MEMBER_TOKEN = 'e2e-member-token';
const OBSERVER_TOKEN = 'e2e-observer-token';

const dir = mkdtempSync(join(tmpdir(), 'codor-e2e-'));
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
const admin = daemon.store.addMember('eng', {
  kind: 'human', handle: 'admin-user', display_name: 'Admin', role: 'admin',
});
const member = daemon.store.addMember('eng', {
  kind: 'human', handle: 'member-user', display_name: 'Member', role: 'member',
});
const observer = daemon.store.addMember('eng', {
  kind: 'human', handle: 'observer-user', display_name: 'Observer', role: 'observer',
});
const alpha = daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: dir });
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const vapidPublicKey = vapid.getPublicKey().toString('base64url');

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
await startServer({
  daemon,
  token: TOKEN,
  principals: [
    { token: ADMIN_TOKEN, member_id: admin.id },
    { token: MEMBER_TOKEN, member_id: member.id },
    { token: OBSERVER_TOKEN, member_id: observer.id },
  ],
  port: API_PORT,
  staticRoot,
  crypto,
  pushSubscriptions,
  pushVapidPublicKey: vapidPublicKey,
  pushRelayEnabled: true,
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
      const removable = new CryptoVault(mkdtempSync(join(tmpdir(), 'codor-revoked-device-')));
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
      const index = body.endpoint
        ? pushed.findIndex((candidate) => candidate.subscription.endpoint === body.endpoint)
        : pushed.length - 1;
      const notification = index >= 0 ? pushed.splice(index, 1)[0] : undefined;
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
    } else if (url.pathname === '/ledger-graph-init') {
      for (const write of [
        { name: 'launch-plan', type: 'decision', body: '# Launch plan\n\nShip with [[risk-limits]] and [[wire-contract]].' },
        { name: 'risk-limits', type: 'constraint', body: '# Risk limits\n\nKeep exposure below 2%. Link back to [[launch-plan]].' },
        { name: 'wire-contract', type: 'contract', body: '# Wire contract\n\nFrames remain acknowledged. See [[launch-plan]].' },
        { name: 'release-checklist', type: 'decision', body: '# Release checklist\n\nConfirm [[wire-contract]].' },
      ]) {
        daemon.addLedgerNote('eng', { ...write, author: 'richard' });
      }
    } else if (url.pathname === '/bridge-enable') {
      const enabled = daemon.enableBridge('eng', body.platform ?? 'slack', body.channel ?? 'C123');
      const posted = daemon.store.postBridgeMessage(
        'eng',
        enabled.member.id,
        body.message ?? '@alpha review [[launch-plan]]',
        {
          platform: body.platform ?? 'slack',
          external_id: body.externalId ?? '171.42',
          sender_name: body.senderName ?? 'Sarah Chen',
        },
        { mentions: [], refs: [], ledger_refs: ['launch-plan'] },
      );
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        member_id: enabled.member.id,
        message_id: posted.message.id,
      }));
      return;
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
  console.log(`codor e2e harness up: api :${API_PORT}, control :${CONTROL_PORT}`);
});
