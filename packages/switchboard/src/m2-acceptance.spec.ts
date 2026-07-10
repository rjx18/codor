import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CryptoVault } from './crypto/pairing.js';
import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import { LedgerManager } from './ledger/watch.js';
import { LedgerVault } from './ledger/vault.js';
import { ResidencyCoordinator } from './residency.js';
import { HyperswarmTransport } from './transport/hyperswarm.js';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet') as (
  size: number,
) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }>;

const PLAINTEXT_MARKER = 'M2-RAW-PLAINTEXT-7E20C492';

interface AcceptanceFixture {
  root: string;
  homeCrypto: CryptoVault;
  outpostCrypto: CryptoVault;
  homeTransport: HyperswarmTransport;
  outpostTransport: HyperswarmTransport;
  homeResidency: ResidencyCoordinator;
  outpostResidency: ResidencyCoordinator;
  daemon: Daemon;
  fake: FakeAdapter;
  captured: Buffer[];
  destroyBootstrap?: () => Promise<void>;
}

const fixtures: AcceptanceFixture[] = [];

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('acceptance condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function setup(mode: 'testnet' | 'real-dht'): Promise<AcceptanceFixture> {
  const root = mkdtempSync(join(tmpdir(), `wireroom-m2-${mode}-`));
  const testnet = mode === 'testnet' ? await createTestnet(3) : undefined;
  const homeCrypto = new CryptoVault(join(root, 'home-crypto'));
  const outpostCrypto = new CryptoVault(join(root, 'outpost-crypto'));
  homeCrypto.roomKeys.ensureRoom('eng');
  const offer = homeCrypto.pairing.issue('http://127.0.0.1:8137');
  const paired = homeCrypto.pairing.complete(offer.pairing_token, {
    ...outpostCrypto.keys.publicIdentity(),
    kind: 'switchboard',
    label: 'outpost',
  });
  outpostCrypto.pairing.accept(paired, 'home');

  const captured: Buffer[] = [];
  const transportOptions = {
    lines: [{ name: `m2-${mode}`, secret: `accept-${root}` }],
    ...(testnet ? { bootstrap: testnet.bootstrap } : {}),
    backoffs: [20, 40, 80],
    jitter: 0,
    captureRawBytes: (chunk: Uint8Array) => captured.push(Buffer.from(chunk)),
  };
  const homeTransport = new HyperswarmTransport({ ...transportOptions, crypto: homeCrypto });
  const outpostTransport = new HyperswarmTransport({ ...transportOptions, crypto: outpostCrypto });
  const fake = new FakeAdapter('fake');
  const homeResidency = new ResidencyCoordinator({
    transport: homeTransport,
    adapters: [],
    journalPath: join(root, 'home', 'resident.sqlite'),
    blobRoot: join(root, 'home', 'resident-blobs'),
  });
  const outpostResidency = new ResidencyCoordinator({
    transport: outpostTransport,
    adapters: [fake],
    journalPath: join(root, 'outpost', 'resident.sqlite'),
    blobRoot: join(root, 'outpost', 'resident-blobs'),
  });
  const ledger = new LedgerManager({ dataDir: join(root, 'home'), transport: homeTransport });
  const daemon = new Daemon({
    dbPath: join(root, 'home', 'switchboard.sqlite'),
    blobRoot: join(root, 'home', 'room-blobs'),
    adapters: [],
    hostId: homeCrypto.keys.identity.device_id,
    residency: homeResidency,
    ledger,
  });
  daemon.createRoom({
    id: 'eng',
    name: 'Engineering',
    owner: { handle: 'richard', display_name: 'Richard' },
  });
  daemon.addLedgerNote('eng', {
    name: 'long-lines',
    type: 'contract',
    author: 'richard',
    body: 'Remote turns receive home-snapshotted ledger context.',
  });
  daemon.spawnRemoteMember('eng', {
    host: outpostCrypto.keys.identity.device_id,
    harness: 'fake',
    handle: 'lab',
    cwd: '/lab/work',
  });

  const fixture: AcceptanceFixture = {
    root,
    homeCrypto,
    outpostCrypto,
    homeTransport,
    outpostTransport,
    homeResidency,
    outpostResidency,
    daemon,
    fake,
    captured,
    destroyBootstrap: testnet ? () => testnet.destroy() : undefined,
  };
  fixtures.push(fixture);
  await homeTransport.start();
  await outpostTransport.start();
  const timeout = mode === 'real-dht' ? 30_000 : 10_000;
  await Promise.all([
    homeTransport.waitForPeer(outpostCrypto.keys.identity.device_id, timeout),
    outpostTransport.waitForPeer(homeCrypto.keys.identity.device_id, timeout),
  ]);
  return fixture;
}

async function runConversation(fixture: AcceptanceFixture): Promise<void> {
  fixture.fake.enqueue({ kind: 'complete', final_text: '@richard M2-PONG' });
  fixture.daemon.postHumanMessage(
    'eng',
    `@lab reply using [[long-lines]] and preserve marker ${PLAINTEXT_MARKER}`,
  );
  await fixture.daemon.settle();
  const messages = fixture.daemon.store.listMessages('eng', { limit: 20 });
  expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
  expect(messages[0]).toMatchObject({ kind: 'system', body: '@richard updated [[long-lines]]' });
  expect(messages[2]).toMatchObject({
    kind: 'run',
    body: '@richard M2-PONG',
    run: { status: 'completed', final_text: '@richard M2-PONG' },
  });
  expect(fixture.fake.deliveries).toHaveLength(1);
  expect(fixture.fake.deliveries[0]!.payload).toContain(PLAINTEXT_MARKER);
  expect(fixture.fake.deliveries[0]!.payload)
    .toContain('Remote turns receive home-snapshotted ledger context.');
  expect(new LedgerVault(join(fixture.root, 'outpost'), 'eng').isEnabled()).toBe(false);
  expect(fixture.daemon.readRunBlob('eng', 3).map((event) => event.type)).toEqual([
    'run.started',
    'run.completed',
  ]);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.daemon.close({ force: true });
    await fixture.homeResidency.close();
    await fixture.outpostResidency.close();
    await fixture.homeTransport.close();
    await fixture.outpostTransport.close();
    fixture.homeCrypto.close();
    fixture.outpostCrypto.close();
    await fixture.destroyBootstrap?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('M2 long-lines acceptance', () => {
  it('runs the full home/resident flow on testnet, encrypts raw bytes, and locks out a revoked peer', async () => {
    const fixture = await setup('testnet');
    await runConversation(fixture);
    await waitFor(() => fixture.captured.length > 0);
    expect(Buffer.concat(fixture.captured).includes(Buffer.from(PLAINTEXT_MARKER))).toBe(false);

    const generation = fixture.homeCrypto.roomKeys.roomGeneration('eng');
    const rejectedBefore = fixture.homeTransport.rejectedConnections;
    fixture.homeCrypto.revokePeer(fixture.outpostCrypto.keys.identity.device_id);
    await waitFor(() =>
      !fixture.homeTransport.peerIds().includes(fixture.outpostCrypto.keys.identity.device_id) &&
      !fixture.outpostTransport.peerIds().includes(fixture.homeCrypto.keys.identity.device_id));
    expect(fixture.homeCrypto.roomKeys.roomGeneration('eng')).toBe(generation + 1);
    await waitFor(() => fixture.homeTransport.rejectedConnections > rejectedBefore);

    let receivedAfterRevoke = false;
    const stop = fixture.homeTransport.onEnvelope((envelope) => {
      if (envelope.kind === 'post-revoke') receivedAfterRevoke = true;
    });
    fixture.outpostTransport.send(fixture.homeCrypto.keys.identity.device_id, {
      room: 'eng', kind: 'post-revoke', payload: { marker: PLAINTEXT_MARKER },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    stop();
    expect(receivedAfterRevoke).toBe(false);
    expect(fixture.homeTransport.peerIds()).not.toContain(
      fixture.outpostCrypto.keys.identity.device_id,
    );
  }, 30_000);

  it('runs the same deterministic two-switchboard flow over the real DHT on localhost', async () => {
    const fixture = await setup('real-dht');
    await runConversation(fixture);
  }, 45_000);
});
