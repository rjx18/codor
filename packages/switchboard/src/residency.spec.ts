import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CryptoVault } from './crypto/pairing.js';
import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import {
  ResidencyCoordinator,
  type ResidencyBoundary,
  type ResidencyCoordinatorOptions,
} from './residency.js';
import { HyperswarmTransport } from './transport/hyperswarm.js';
import type { OutgoingEnvelope, TransportEnvelope } from './transport/peer.js';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet') as (
  size: number,
) => Promise<{
  bootstrap: { host: string; port: number }[];
  destroy(): Promise<void>;
}>;

interface Fixture {
  root: string;
  testnet: Awaited<ReturnType<typeof createTestnet>>;
  homeVault: CryptoVault;
  outpostVault: CryptoVault;
  homeTransport: HyperswarmTransport;
  outpostTransport: HyperswarmTransport;
  homeResidency: ResidencyCoordinator;
  outpostResidency: ResidencyCoordinator;
  daemon: Daemon;
  fake: FakeAdapter;
  memberId: string;
  outpostJournal: string;
  outpostBlobs: string;
}

const fixtures: Fixture[] = [];

class StubTransport {
  private envelopeHandler:
    | ((envelope: TransportEnvelope, peerId: string) => void | Promise<void>)
    | undefined;
  private peerStateHandler: ((peerId: string, connected: boolean) => void) | undefined;
  readonly sent: { peerId: string; envelope: OutgoingEnvelope }[] = [];

  onEnvelope(
    handler: (envelope: TransportEnvelope, peerId: string) => void | Promise<void>,
  ): () => void {
    this.envelopeHandler = handler;
    return () => {
      this.envelopeHandler = undefined;
    };
  }

  onPeerState(handler: (peerId: string, connected: boolean) => void): () => void {
    this.peerStateHandler = handler;
    return () => {
      this.peerStateHandler = undefined;
    };
  }

  peerIds(): string[] {
    return ['expected-host', 'attacker-host'];
  }

  send(peerId: string, envelope: OutgoingEnvelope): string {
    this.sent.push({ peerId, envelope });
    return `sent-${String(this.sent.length)}`;
  }

  async emit(peerId: string, envelope: OutgoingEnvelope): Promise<void> {
    await this.envelopeHandler?.({
      envelope_id: '01J00000000000000000000000',
      ...envelope,
    }, peerId);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup(options: {
  homeBoundary?: (transport: HyperswarmTransport) => ResidencyCoordinatorOptions['boundaryHook'];
  outpostBoundary?: (transport: HyperswarmTransport) => ResidencyCoordinatorOptions['boundaryHook'];
  maxPendingCompletionAcks?: number;
} = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'codor-residency-'));
  const testnet = await createTestnet(3);
  const homeVault = new CryptoVault(join(root, 'home-crypto'));
  const outpostVault = new CryptoVault(join(root, 'outpost-crypto'));
  const offer = homeVault.pairing.issue('http://localhost:8137');
  const pairing = homeVault.pairing.complete(offer.pairing_token, {
    ...outpostVault.keys.publicIdentity(),
    kind: 'switchboard',
    label: 'outpost',
  });
  outpostVault.pairing.accept(pairing, 'home');
  const line = { name: 'multibox', secret: `test-${root}` };
  const retry = { backoffs: [20, 40, 80], jitter: 0 };
  const homeTransport = new HyperswarmTransport({
    lines: [line], crypto: homeVault, bootstrap: testnet.bootstrap, ...retry,
  });
  const outpostTransport = new HyperswarmTransport({
    lines: [line], crypto: outpostVault, bootstrap: testnet.bootstrap, ...retry,
  });
  const fake = new FakeAdapter('fake');
  const outpostJournal = join(root, 'outpost', 'resident.sqlite');
  const outpostBlobs = join(root, 'outpost', 'blobs');
  const homeResidency = new ResidencyCoordinator({
    transport: homeTransport,
    adapters: [],
    journalPath: join(root, 'home', 'resident.sqlite'),
    blobRoot: join(root, 'home', 'resident-blobs'),
    boundaryHook: options.homeBoundary?.(homeTransport),
    ...(options.maxPendingCompletionAcks !== undefined && {
      maxPendingCompletionAcks: options.maxPendingCompletionAcks,
    }),
  });
  const outpostResidency = new ResidencyCoordinator({
    transport: outpostTransport,
    adapters: [fake],
    journalPath: outpostJournal,
    blobRoot: outpostBlobs,
    boundaryHook: options.outpostBoundary?.(outpostTransport),
  });
  await homeTransport.start();
  await outpostTransport.start();
  await Promise.all([
    homeTransport.waitForPeer(outpostVault.keys.identity.device_id),
    outpostTransport.waitForPeer(homeVault.keys.identity.device_id),
  ]);
  const daemon = new Daemon({
    dbPath: join(root, 'home', 'switchboard.sqlite'),
    blobRoot: join(root, 'home', 'room-blobs'),
    adapters: [],
    hostId: homeVault.keys.identity.device_id,
    residency: homeResidency,
  });
  daemon.createRoom({
    id: 'eng',
    name: 'Engineering',
    owner: { handle: 'richard', display_name: 'Richard' },
  });
  const member = daemon.spawnRemoteMember('eng', {
    host: outpostVault.keys.identity.device_id,
    harness: 'fake',
    handle: 'lab',
    cwd: '/lab/work',
  });
  const fixture = {
    root,
    testnet,
    homeVault,
    outpostVault,
    homeTransport,
    outpostTransport,
    homeResidency,
    outpostResidency,
    daemon,
    fake,
    memberId: member.id,
    outpostJournal,
    outpostBlobs,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.daemon.close({ force: true });
    await fixture.homeResidency.close();
    await fixture.outpostResidency.close();
    await fixture.homeTransport.close();
    await fixture.outpostTransport.close();
    fixture.homeVault.close();
    fixture.outpostVault.close();
    await fixture.testnet.destroy();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('multi-box member residency over hyperdht/testnet', () => {
  it('accepts a resident session reference only from the pending attempt host and room', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-resident-session-auth-'));
    const transport = new StubTransport();
    const coordinator = new ResidencyCoordinator({
      transport: transport as unknown as HyperswarmTransport,
      adapters: [],
      journalPath: join(root, 'resident.sqlite'),
      blobRoot: join(root, 'blobs'),
    });
    const onSessionRef = vi.fn();
    try {
      coordinator.deliver('expected-host', {
        rpc_id: 'home:eng:7',
        room: 'eng',
        member: { id: 'remote-agent', harness: 'fake', cwd: '/work' },
        payload: 'continue',
        trigger_msg: 7,
      }, { onSessionRef });
      const update = {
        kind: 'resident_session',
        room: 'eng',
        payload: { rpc_id: 'home:eng:7', session_ref: 'expected-session' },
      };

      await transport.emit('attacker-host', update);
      await transport.emit('expected-host', { ...update, room: 'other-room' });
      await transport.emit('expected-host', {
        ...update,
        payload: { ...update.payload, session_ref: '' },
      });
      expect(onSessionRef).not.toHaveBeenCalled();

      await transport.emit('expected-host', update);
      expect(onSessionRef).toHaveBeenCalledOnce();
      expect(onSessionRef).toHaveBeenCalledWith('expected-session');
    } finally {
      await coordinator.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backpressures before completion tracking can exceed its configured bound', async () => {
    const fixture = await setup({ maxPendingCompletionAcks: 1 });
    const host = fixture.outpostVault.keys.identity.device_id;
    const member = {
      id: fixture.memberId,
      harness: 'fake',
      cwd: '/lab/work',
    };
    fixture.homeResidency.deliver(host, {
      rpc_id: 'bounded-rpc-1', room: 'eng', member, payload: 'first', trigger_msg: 1,
    });
    expect(() => fixture.homeResidency.deliver(host, {
      rpc_id: 'bounded-rpc-2', room: 'eng', member, payload: 'second', trigger_msg: 2,
    })).toThrow('completion acknowledgements in flight');
  });

  it('keeps room authority at home, runs the outpost adapter, preserves ids, and never routes an empty remote run', async () => {
    const fixture = await setup();
    fixture.fake.enqueue({
      kind: 'complete',
      final_text: '@richard remote work done',
      items: [{ type: 'run.item', item_type: 'text_delta', payload: { text: 'working' } }],
    });
    fixture.daemon.postHumanMessage('eng', '@lab do the remote work');
    await fixture.daemon.settle();

    const firstMessages = fixture.daemon.store.listMessages('eng', { limit: 20 });
    expect(firstMessages.map((message) => message.id)).toEqual([1, 2]);
    expect(firstMessages[1]).toMatchObject({
      id: 2,
      author: fixture.memberId,
      kind: 'run',
      body: '@richard remote work done',
      run: { status: 'completed' },
    });
    expect(fixture.fake.deliveries).toHaveLength(1);
    expect(fixture.fake.deliveries[0]).toMatchObject({ cwd: '/lab/work' });
    expect(fixture.daemon.store.getMember('eng', fixture.memberId)).toMatchObject({
      host: fixture.outpostVault.keys.identity.device_id,
      state: 'idle',
      session_ref: 'fake-session-1',
    });
    expect(fixture.daemon.readRunBlob('eng', 2).map((event) => event.type)).toEqual([
      'run.started',
      'run.item',
      'run.completed',
    ]);
    await waitFor(() => fixture.homeResidency.pendingCompletionAckCount() === 0);

    fixture.fake.enqueue({ kind: 'complete', final_text: '' });
    fixture.daemon.postHumanMessage('eng', '@lab finish silently');
    await fixture.daemon.settle();
    const messages = fixture.daemon.store.listMessages('eng', { limit: 20 });
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
    expect(messages[3]).toMatchObject({ body: '', run: { status: 'completed', final_text: '' } });
    expect(fixture.daemon.store.listDeliveries('eng').filter((delivery) =>
      delivery.message_id === 4)).toEqual([]);
    expect(fixture.outpostResidency.journal.get(
      fixture.homeVault.keys.identity.device_id,
      `${fixture.homeVault.keys.identity.device_id}:eng:4`,
    )).toMatchObject({ state: 'completed', attempt_count: 1 });
  }, 20_000);

  it('holds the home FIFO while unreachable and drains it after an outpost restart before RPC', async () => {
    const fixture = await setup();
    await fixture.outpostResidency.close();
    await fixture.outpostTransport.close();
    await waitFor(() =>
      fixture.daemon.store.getMember('eng', fixture.memberId)?.state === 'unreachable');
    fixture.fake.enqueue({ kind: 'complete', final_text: '@richard restarted outpost done' });
    fixture.daemon.postHumanMessage('eng', '@lab queued before rpc');
    await fixture.daemon.settle();
    expect(fixture.fake.deliveries).toHaveLength(0);
    expect(fixture.daemon.store.listDeliveries('eng', {
      recipient: fixture.memberId,
      state: 'queued',
    })).toHaveLength(1);

    const replacementTransport = new HyperswarmTransport({
      lines: [{ name: 'multibox', secret: `test-${fixture.root}` }],
      crypto: fixture.outpostVault,
      bootstrap: fixture.testnet.bootstrap,
      backoffs: [20, 40, 80],
      jitter: 0,
    });
    const replacementResidency = new ResidencyCoordinator({
      transport: replacementTransport,
      adapters: [fixture.fake],
      journalPath: fixture.outpostJournal,
      blobRoot: fixture.outpostBlobs,
    });
    fixture.outpostTransport = replacementTransport;
    fixture.outpostResidency = replacementResidency;
    await replacementTransport.start();
    await replacementTransport.waitForPeer(fixture.homeVault.keys.identity.device_id);
    await waitFor(() => fixture.fake.deliveries.length === 1);
    await fixture.daemon.settle();
    expect(fixture.daemon.store.getMember('eng', fixture.memberId)?.state).toBe('idle');
    expect(fixture.daemon.store.listMessages('eng', { limit: 10 }).at(-1)).toMatchObject({
      kind: 'run',
      body: '@richard restarted outpost done',
      run: { status: 'completed' },
    });
  }, 20_000);

  for (const boundary of ['mid-events', 'after-complete-before-ack'] as const) {
    it(`reconciles ${boundary} disconnect without duplicate adapter side effects`, async () => {
      let disconnected = false;
      const fixture = await setup(boundary === 'mid-events'
        ? {
            outpostBoundary: (transport) => (
              point: ResidencyBoundary,
              detail,
            ) => {
              if (
                !disconnected &&
                point === 'resident_event_sent' &&
                detail.event.type === 'run.item'
              ) {
                disconnected = true;
                transport.disconnect(fixtureHomeId);
              }
            },
          }
        : {
            homeBoundary: (transport) => (point) => {
              if (!disconnected && point === 'home_complete_before_event_ack') {
                disconnected = true;
                transport.disconnect(fixtureOutpostId);
              }
            },
          });
      const fixtureHomeId = fixture.homeVault.keys.identity.device_id;
      const fixtureOutpostId = fixture.outpostVault.keys.identity.device_id;
      fixture.fake.enqueue({
        kind: 'complete',
        final_text: '@richard exactly once',
        items: [{ type: 'run.item', item_type: 'commit', payload: { marker: boundary } }],
      });
      fixture.daemon.postHumanMessage('eng', '@lab boundary work');
      await fixture.daemon.settle();
      await waitFor(() => fixture.homeTransport.peerIds().includes(fixtureOutpostId));
      expect(disconnected).toBe(true);
      expect(fixture.fake.deliveries).toHaveLength(1);
      const runs = fixture.daemon.store.listMessages('eng', { limit: 10 })
        .filter((message) => message.kind === 'run');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ body: '@richard exactly once', run: { status: 'completed' } });
      await waitFor(() => fixture.homeResidency.pendingCompletionAckCount() === 0);
    }, 20_000);
  }

  it('holds a resident attempt that started but ended without a completion outcome', async () => {
    const fixture = await setup();
    fixture.fake.enqueue({ kind: 'die-silently' });
    fixture.daemon.postHumanMessage('eng', '@lab ambiguous side effect');
    await fixture.daemon.settle();
    expect(fixture.fake.deliveries).toHaveLength(1);
    expect(fixture.daemon.store.listDeliveries('eng', {
      recipient: fixture.memberId,
      state: 'held',
    })).toHaveLength(1);
    expect(fixture.daemon.store.listMessages('eng', { limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'system', body: expect.stringContaining('resident reported ambiguous') }),
      ]),
    );
    expect(fixture.outpostResidency.journal.get(
      fixture.homeVault.keys.identity.device_id,
      `${fixture.homeVault.keys.identity.device_id}:eng:2`,
    )).toMatchObject({ state: 'ambiguous', attempt_count: 1 });
  }, 20_000);
});
