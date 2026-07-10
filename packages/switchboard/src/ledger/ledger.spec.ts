import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CryptoVault } from '../crypto/pairing.js';
import { Daemon } from '../daemon.js';
import { FakeAdapter } from '../fake-adapter.js';
import { HyperswarmTransport } from '../transport/hyperswarm.js';
import { addRemoteLedgerNote, LedgerManager } from './watch.js';
import { LedgerVault } from './vault.js';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet') as (
  size: number,
) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }>;

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ledger vault v1', () => {
  it('bootstraps the Obsidian-compatible vault from a byte-exact golden', () => {
    const root = mkdtempSync(join(tmpdir(), 'wireroom-ledger-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const vault = new LedgerVault(root, 'eng');
    vault.bootstrap();
    expect(vault.snapshot()).toEqual({
      'INDEX.md': '---\nname: index\n---\n# Room Ledger\n\n## Decisions\n\n## Constraints\n\n## Contracts\n',
      'constraints/_template.md': '---\nname: constraint-template\ntype: constraint\n---\n# Constraint\n\n',
      'contracts/_template.md': '---\nname: contract-template\ntype: contract\n---\n# Contract\n\n',
      'decisions/_template.md': '---\nname: decision-template\ntype: decision\n---\n# Decision\n\n',
    });
  });

  it('attributes managed writes to a member and direct edits to operator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wireroom-ledger-watch-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const changes: { name: string; author: string }[] = [];
    const manager = new LedgerManager({
      dataDir: root,
      onChange: ({ name, author }) => changes.push({ name, author }),
    });
    cleanup.push(() => manager.close());
    manager.enable('eng');
    await new Promise((resolve) => setTimeout(resolve, 100));
    new LedgerVault(root, 'eng').add({
      name: 'risk-limits',
      type: 'constraint',
      author: 'claude',
      body: 'Keep exposure below 2%.',
    });
    await waitFor(() => changes.some((change) =>
      change.name === 'risk-limits' && change.author === 'claude'));
    writeFileSync(
      join(root, 'rooms', 'eng', 'ledger', 'constraints', 'risk-limits.md'),
      '---\nname: risk-limits\ntype: constraint\n---\nKeep exposure below 1%.\n',
    );
    await waitFor(() => changes.some((change) =>
      change.name === 'risk-limits' && change.author === 'operator'));
  });

  it('resolves [[refs]] at home into the snapshotted payload and advertises ledger syntax', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wireroom-ledger-payload-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const fake = new FakeAdapter();
    const ledger = new LedgerManager({ dataDir: root });
    const daemon = new Daemon({
      dbPath: join(root, 'db.sqlite'),
      blobRoot: join(root, 'blobs'),
      adapters: [fake],
      ledger,
    });
    cleanup.push(() => daemon.close({ force: true }));
    daemon.createRoom({
      id: 'eng',
      name: 'Engineering',
      owner: { handle: 'richard', display_name: 'Richard' },
    });
    daemon.spawnMember('eng', { harness: 'fake', handle: 'alpha', cwd: '/work' });
    daemon.addLedgerNote('eng', {
      name: 'risk-limits',
      type: 'constraint',
      author: 'claude',
      body: 'Keep exposure below 2%.',
    });
    fake.enqueue({ kind: 'complete', final_text: '' });
    daemon.postHumanMessage('eng', '@alpha honor [[risk-limits]]');
    await daemon.settle();
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]!.payload).toContain('--- ledger [[risk-limits]] ---');
    expect(fake.deliveries[0]!.payload).toContain('Keep exposure below 2%.');
    expect(fake.deliveries[0]!.payload).toContain('Cite ledger notes as [[name]].');
    const notices = daemon.store.listMessages('eng', { limit: 20 })
      .filter((message) => message.kind === 'system');
    expect(notices.map((message) => message.body)).toContain('@claude updated [[risk-limits]]');
    expect(daemon.store.listDeliveries('eng').filter((delivery) =>
      notices.some((notice) => notice.id === delivery.message_id))).toEqual([]);
  });

  it('routes an outpost ledger add over authenticated testnet transport to the home vault only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wireroom-ledger-remote-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const testnet = await createTestnet(3);
    cleanup.push(() => testnet.destroy());
    const homeCrypto = new CryptoVault(join(root, 'home-crypto'));
    const outpostCrypto = new CryptoVault(join(root, 'outpost-crypto'));
    cleanup.push(() => { homeCrypto.close(); outpostCrypto.close(); });
    const offer = homeCrypto.pairing.issue('http://localhost');
    const paired = homeCrypto.pairing.complete(offer.pairing_token, {
      ...outpostCrypto.keys.publicIdentity(), kind: 'switchboard', label: 'outpost',
    });
    outpostCrypto.pairing.accept(paired, 'home');
    const line = { name: 'ledger', secret: `test-${root}` };
    const home = new HyperswarmTransport({ lines: [line], crypto: homeCrypto, bootstrap: testnet.bootstrap });
    const outpost = new HyperswarmTransport({ lines: [line], crypto: outpostCrypto, bootstrap: testnet.bootstrap });
    cleanup.push(async () => { await home.close(); await outpost.close(); });
    const manager = new LedgerManager({ dataDir: join(root, 'home'), transport: home });
    manager.setRoomValidator((room) => room === 'eng');
    cleanup.push(() => manager.close());
    await home.start();
    await outpost.start();
    await Promise.all([
      home.waitForPeer(outpostCrypto.keys.identity.device_id),
      outpost.waitForPeer(homeCrypto.keys.identity.device_id),
    ]);
    await addRemoteLedgerNote(outpost, homeCrypto.keys.identity.device_id, 'eng', {
      name: 'wire-contract', type: 'contract', author: 'lab', body: 'Frames are acknowledged.',
    });
    expect(manager.note('eng', 'wire-contract')?.body).toContain('Frames are acknowledged.');
    expect(new LedgerVault(join(root, 'outpost'), 'eng').isEnabled()).toBe(false);
  }, 20_000);
});
