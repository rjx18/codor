import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CryptoVault } from '../crypto/pairing.js';
import { hashTranscript } from '../crypto/challenge.js';
import { HyperswarmTransport, lineTopic } from './hyperswarm.js';
import {
  EnvelopeDecoder,
  EnvelopeDeduplicator,
  encodeEnvelope,
  envelopeUlid,
  type NoiseDuplex,
  ReliablePeer,
  type TransportEnvelope,
} from './peer.js';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet') as (
  size: number,
) => Promise<{
  bootstrap: { host: string; port: number }[];
  destroy(): Promise<void>;
}>;

const roots: string[] = [];
const transports: HyperswarmTransport[] = [];
const vaults: CryptoVault[] = [];
const testnets: { destroy(): Promise<void> }[] = [];

function makeVault(label: string): CryptoVault {
  const root = mkdtempSync(join(tmpdir(), `wireroom-transport-${label}-`));
  roots.push(root);
  const created = new CryptoVault(root);
  vaults.push(created);
  return created;
}

function enrollEachOther(left: CryptoVault, right: CryptoVault): void {
  const offer = left.pairing.issue('http://localhost:8137');
  const result = left.pairing.complete(offer.pairing_token, {
    ...right.keys.publicIdentity(),
    kind: 'switchboard',
    label: 'peer',
  });
  right.pairing.accept(result, 'peer');
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  for (const vault of vaults.splice(0)) vault.close();
  for (const testnet of testnets.splice(0)) await testnet.destroy();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('length-prefixed envelopes', () => {
  it('derives the exact private line topic and emits valid ULIDs', () => {
    expect(lineTopic({ name: 'studio', secret: 'correct horse' }).toString('hex')).toBe(
      '2052062da0d3cdd21178a36245808899b29a77e2a0d451b94ddff85696d81b73',
    );
    expect(envelopeUlid()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(() => lineTopic({ name: 'studio', secret: '' })).toThrow('line secret');
  });

  it('decodes fragmented and coalesced frames from odd-sized chunks', () => {
    const envelopes: TransportEnvelope[] = [
      { envelope_id: envelopeUlid(), room: 'one', kind: 'chat', payload: { n: 1 } },
      { envelope_id: envelopeUlid(), room: 'two', kind: 'chat', payload: { n: 2 } },
    ];
    const bytes = Buffer.concat(envelopes.map(encodeEnvelope));
    const decoder = new EnvelopeDecoder();
    const decoded: TransportEnvelope[] = [];
    const sizes = [1, 7, 3, 19, 5, 31, 2, 47];
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
      const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]!);
      decoded.push(...decoder.push(bytes.subarray(offset, end)));
      offset = end;
    }
    expect(decoded).toEqual(envelopes);
    expect(new EnvelopeDecoder().push(bytes)).toEqual(envelopes);
  });

  it('rejects application traffic before the identity handshake', async () => {
    class StubStream extends EventEmitter implements NoiseDuplex {
      readonly handshakeHash = Buffer.alloc(32, 7);
      destroyed = false;
      write(): boolean { return true; }
      destroy(error?: Error): void {
        this.destroyed = true;
        if (error) this.emit('error', error);
        this.emit('close');
      }
      override on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): this {
        return super.on(event, listener);
      }
      override off(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): this {
        return super.off(event, listener);
      }
    }
    const crypto = makeVault('preauth');
    let rejected = '';
    const peer = new ReliablePeer(crypto, () => undefined, () => undefined, (error) => {
      rejected = error.message;
    });
    const stream = new StubStream();
    peer.attach(stream);
    stream.emit('data', encodeEnvelope({
      envelope_id: envelopeUlid(),
      room: 'eng',
      kind: 'chat',
      payload: { secret: true },
    }));
    await waitFor(() => rejected !== '');
    expect(rejected).toContain('before peer authentication');
    expect(stream.destroyed).toBe(true);
    peer.close();
  });

  it('bounds repeated unverified identity challenges before authentication', async () => {
    class StubStream extends EventEmitter implements NoiseDuplex {
      readonly handshakeHash = Buffer.alloc(32, 11);
      destroyed = false;
      writes = 0;
      write(): boolean { this.writes += 1; return true; }
      destroy(error?: Error): void {
        this.destroyed = true;
        if (error) this.emit('error', error);
        this.emit('close');
      }
      override on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): this {
        return super.on(event, listener);
      }
      override off(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): this {
        return super.off(event, listener);
      }
    }
    const home = makeVault('challenge-bound-home');
    const remote = makeVault('challenge-bound-remote');
    enrollEachOther(home, remote);
    const peer = new ReliablePeer(home, () => undefined, () => undefined, () => undefined);
    const stream = new StubStream();
    peer.attach(stream);
    const transcriptHash = hashTranscript(stream.handshakeHash);
    for (let index = 0; index < 32; index++) {
      stream.emit('data', encodeEnvelope({
        envelope_id: envelopeUlid(),
        room: '',
        kind: 'hello',
        payload: {
          type: 'identity',
          device_id: remote.keys.identity.device_id,
          transcript_hash: transcriptHash,
        },
      }));
    }
    await waitFor(() => stream.writes === 33);
    expect(home.challenges.pendingCount(remote.keys.identity.device_id)).toBe(8);
    peer.close();
  });

  it('retains exact deduplication beyond the old ten-thousand-envelope eviction point', () => {
    const dedup = new EnvelopeDeduplicator();
    const first = envelopeUlid();
    dedup.remember(first);
    for (let index = 0; index < 10_001; index++) dedup.remember(envelopeUlid());
    expect(dedup.has(first)).toBe(true);
    expect(dedup.size).toBe(10_002);

    const bounded = new EnvelopeDeduplicator(2);
    const ids = [envelopeUlid(), envelopeUlid(), envelopeUlid()];
    for (const id of ids) bounded.remember(id);
    expect(bounded.size).toBe(2);
    expect(bounded.has(ids[0]!)).toBe(false);
  });
});

describe('Hyperswarm over hyperdht/testnet', () => {
  it('authenticates two daemons and multiplexes rooms, same-seq fan-out, RPCs, and events on one socket', async () => {
    const testnet = await createTestnet(3);
    testnets.push(testnet);
    const leftVault = makeVault('left');
    const rightVault = makeVault('right');
    enrollEachOther(leftVault, rightVault);
    const line = { name: 'integration', secret: 'testnet-only-secret' };
    const left = new HyperswarmTransport({ lines: [line], crypto: leftVault, bootstrap: testnet.bootstrap });
    const right = new HyperswarmTransport({ lines: [line], crypto: rightVault, bootstrap: testnet.bootstrap });
    transports.push(left, right);
    const atLeft: TransportEnvelope[] = [];
    const atRight: TransportEnvelope[] = [];
    left.onEnvelope((envelope) => { atLeft.push(envelope); });
    right.onEnvelope((envelope) => { atRight.push(envelope); });

    await left.start();
    await right.start();
    await Promise.all([
      left.waitForPeer(rightVault.keys.identity.device_id),
      right.waitForPeer(leftVault.keys.identity.device_id),
    ]);
    expect(left.connectionCount).toBe(1);
    expect(right.connectionCount).toBe(1);

    left.send(rightVault.keys.identity.device_id, { room: 'one', kind: 'chat', payload: { seq: 12, body: 'first' } });
    left.send(rightVault.keys.identity.device_id, { room: 'two', kind: 'chat', payload: { seq: 12, body: 'second' } });
    left.send(rightVault.keys.identity.device_id, { room: 'one', kind: 'chat', payload: { seq: 44, branch: 'a' } });
    left.send(rightVault.keys.identity.device_id, { room: 'one', kind: 'chat', payload: { seq: 44, branch: 'b' } });
    left.sendRpc(rightVault.keys.identity.device_id, 'one', 'rpc-1', { delivery: 9 });
    left.sendRunEvent(rightVault.keys.identity.device_id, 'one', {
      rpc_id: 'rpc-1',
      event_index: 0,
      event: { type: 'run.started' },
    });
    right.sendRunEventAck(leftVault.keys.identity.device_id, 'one', 'rpc-1', 0);
    right.send(leftVault.keys.identity.device_id, { room: 'two', kind: 'chat', payload: { body: 'return' } });

    await waitFor(() => atRight.length === 6 && atLeft.length === 2);
    expect(atRight.slice(0, 2).map((envelope) => envelope.room)).toEqual(['one', 'two']);
    expect(atRight.filter((envelope) =>
      (envelope.payload as { seq?: number }).seq === 44)).toHaveLength(2);
    expect(atRight.find((envelope) => envelope.kind === 'rpc')?.payload).toMatchObject({ rpc_id: 'rpc-1' });
    expect(atRight.find((envelope) => envelope.kind === 'run_event')?.payload).toMatchObject({
      rpc_id: 'rpc-1',
      event_index: 0,
    });
    expect(atLeft.find((envelope) => envelope.kind === 'run_event_ack')?.payload).toEqual({
      rpc_id: 'rpc-1',
      event_index: 0,
    });
    await waitFor(() =>
      left.pendingCount(rightVault.keys.identity.device_id) === 0 &&
      right.pendingCount(leftVault.keys.identity.device_id) === 0);
    expect(left.connectionCount).toBe(1);
  }, 20_000);

  it('rejects a line-secret holder that was never enrolled', async () => {
    const testnet = await createTestnet(3);
    testnets.push(testnet);
    const leftVault = makeVault('unauthorized-left');
    const strangerVault = makeVault('unauthorized-stranger');
    const line = { name: 'private', secret: 'known-but-not-authorized' };
    const left = new HyperswarmTransport({ lines: [line], crypto: leftVault, bootstrap: testnet.bootstrap });
    const stranger = new HyperswarmTransport({ lines: [line], crypto: strangerVault, bootstrap: testnet.bootstrap });
    transports.push(left, stranger);
    await left.start();
    await stranger.start();
    await waitFor(() => left.rejectedConnections + stranger.rejectedConnections > 0);
    expect(left.peerIds()).toEqual([]);
    expect(stranger.peerIds()).toEqual([]);
  }, 20_000);

  it('reconnects, retransmits an unacked envelope, and deduplicates application delivery', async () => {
    const testnet = await createTestnet(3);
    testnets.push(testnet);
    const leftVault = makeVault('retry-left');
    const rightVault = makeVault('retry-right');
    enrollEachOther(leftVault, rightVault);
    const line = { name: 'retry', secret: 'deterministic-testnet' };
    const retry = { backoffs: [20, 40, 80], jitter: 0 };
    const left = new HyperswarmTransport({
      lines: [line], crypto: leftVault, bootstrap: testnet.bootstrap, ...retry,
    });
    const right = new HyperswarmTransport({
      lines: [line], crypto: rightVault, bootstrap: testnet.bootstrap, ...retry,
    });
    transports.push(left, right);
    let deliveries = 0;
    right.onEnvelope((envelope) => {
      if (envelope.kind !== 'disconnect-boundary') return;
      deliveries += 1;
      if (deliveries === 1) right.disconnect(leftVault.keys.identity.device_id);
    });
    await left.start();
    await right.start();
    await Promise.all([
      left.waitForPeer(rightVault.keys.identity.device_id),
      right.waitForPeer(leftVault.keys.identity.device_id),
    ]);
    left.send(rightVault.keys.identity.device_id, {
      room: 'eng',
      kind: 'disconnect-boundary',
      payload: { marker: 'once' },
    });

    await waitFor(() => deliveries === 1);
    await waitFor(() =>
      left.pendingCount(rightVault.keys.identity.device_id) === 0 &&
      left.peerIds().includes(rightVault.keys.identity.device_id), 15_000);
    expect(deliveries).toBe(1);
  }, 25_000);
});
