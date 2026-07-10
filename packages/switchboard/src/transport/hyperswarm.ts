import { createRequire } from 'node:module';

import sodium from 'sodium-native';

import type { CryptoVault } from '../crypto/pairing.js';
import {
  type NoiseDuplex,
  type OutgoingEnvelope,
  ReliablePeer,
  type TransportEnvelope,
} from './peer.js';

const require = createRequire(import.meta.url);

interface PeerInfo {
  publicKey: Uint8Array;
}

interface Discovery {
  flushed(): Promise<void>;
}

interface SwarmLike {
  readonly connections: Set<NoiseDuplex>;
  on(event: 'connection', listener: (stream: NoiseDuplex, info: PeerInfo) => void): this;
  join(topic: Uint8Array, options: { client: boolean; server: boolean }): Discovery;
  flush(): Promise<unknown>;
  destroy(options?: { force?: boolean }): Promise<void>;
}

type HyperswarmConstructor = new (options?: {
  bootstrap?: { host: string; port: number }[];
  backoffs?: number[];
  jitter?: number;
}) => SwarmLike;

const Hyperswarm = require('hyperswarm') as HyperswarmConstructor;

export interface LineConfig {
  name: string;
  secret: string;
}

export interface HyperswarmTransportOptions {
  lines: LineConfig[];
  crypto: CryptoVault;
  bootstrap?: { host: string; port: number }[];
  backoffs?: number[];
  jitter?: number;
}

export interface RunEventPayload {
  rpc_id: string;
  event_index: number;
  event: unknown;
}

type TransportHandler = (envelope: TransportEnvelope, peerId: string) => void | Promise<void>;
type PeerStateHandler = (peerId: string, connected: boolean) => void;

function nonempty(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

// harn:assume dht-topic-from-line-secret ref=line-topic-derivation
export function lineTopic(line: LineConfig): Buffer {
  const name = nonempty(line.name, 'line name');
  const secret = nonempty(line.secret, 'line secret');
  const topic = Buffer.alloc(32);
  sodium.crypto_generichash(topic, Buffer.from(`wireroom:${name}:${secret}`, 'utf8'));
  return topic;
}

export class HyperswarmTransport {
  private readonly swarm: SwarmLike;
  private readonly topics: Buffer[];
  private readonly channelsByNoiseKey = new Map<string, ReliablePeer>();
  private readonly channelsByPeerId = new Map<string, ReliablePeer>();
  private readonly handlers = new Set<TransportHandler>();
  private readonly peerStateHandlers = new Set<PeerStateHandler>();
  private readonly peerWaiters = new Set<() => void>();
  private started = false;
  private closed = false;
  private rejections = 0;

  constructor(private readonly options: HyperswarmTransportOptions) {
    if (options.lines.length === 0) throw new Error('at least one line is required');
    const unique = new Map(options.lines.map((line) => {
      const topic = lineTopic(line);
      return [topic.toString('hex'), topic] as const;
    }));
    this.topics = [...unique.values()];
    this.swarm = new Hyperswarm({
      bootstrap: options.bootstrap,
      backoffs: options.backoffs,
      jitter: options.jitter,
    });
    this.swarm.on('connection', (stream, info) => this.accept(stream, info));
  }

  get connectionCount(): number {
    return this.swarm.connections.size;
  }

  get rejectedConnections(): number {
    return this.rejections;
  }

  joinedTopics(): Buffer[] {
    return this.topics.map((topic) => Buffer.from(topic));
  }

  onEnvelope(handler: TransportHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onPeerState(handler: PeerStateHandler): () => void {
    this.peerStateHandlers.add(handler);
    return () => this.peerStateHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('transport is closed');
    this.started = true;
    const discoveries = this.topics.map((topic) =>
      this.swarm.join(topic, { client: true, server: true }));
    await Promise.all(discoveries.map((discovery) => discovery.flushed()));
    await this.swarm.flush();
  }

  peerIds(): string[] {
    return [...this.channelsByPeerId.entries()]
      .filter(([, channel]) => channel.authenticated)
      .map(([peerId]) => peerId);
  }

  async waitForPeer(peerId?: string, timeoutMs = 10_000): Promise<string> {
    const current = this.peerIds().find((id) => peerId === undefined || peerId === id);
    if (current) return current;
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        const found = this.peerIds().some((id) => peerId === undefined || peerId === id);
        if (!found) return;
        clearTimeout(timer);
        this.peerWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.peerWaiters.delete(wake);
        reject(new Error(`timed out waiting for ${peerId ?? 'an authenticated peer'}`));
      }, timeoutMs);
      this.peerWaiters.add(wake);
    });
    return this.peerIds().find((id) => peerId === undefined || peerId === id)!;
  }

  send<T>(peerId: string, outgoing: OutgoingEnvelope<T>): string {
    const channel = this.channelsByPeerId.get(peerId);
    if (!channel) throw new Error(`peer ${peerId} has never authenticated`);
    return channel.send(outgoing);
  }

  broadcast<T>(outgoing: OutgoingEnvelope<T>): string[] {
    return this.peerIds().map((peerId) => this.send(peerId, outgoing));
  }

  sendRpc(peerId: string, room: string, rpcId: string, payload: unknown): string {
    nonempty(rpcId, 'rpc_id');
    return this.send(peerId, { room, kind: 'rpc', payload: { rpc_id: rpcId, body: payload } });
  }

  sendRunEvent(peerId: string, room: string, payload: RunEventPayload): string {
    nonempty(payload.rpc_id, 'rpc_id');
    if (!Number.isSafeInteger(payload.event_index) || payload.event_index < 0) {
      throw new Error('event_index must be nonnegative');
    }
    return this.send(peerId, { room, kind: 'run_event', payload });
  }

  sendRunEventAck(peerId: string, room: string, rpcId: string, eventIndex: number): string {
    const channel = this.channelsByPeerId.get(peerId);
    if (!channel) throw new Error(`peer ${peerId} has never authenticated`);
    return channel.sendRunEventAck(room, rpcId, eventIndex);
  }

  pendingCount(peerId: string): number {
    return this.channelsByPeerId.get(peerId)?.pendingCount ?? 0;
  }

  disconnect(peerId: string): void {
    this.channelsByPeerId.get(peerId)?.disconnect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channelsByNoiseKey.values()) channel.close();
    this.channelsByNoiseKey.clear();
    this.channelsByPeerId.clear();
    await this.swarm.destroy({ force: true });
  }

  private accept(stream: NoiseDuplex, info: PeerInfo): void {
    const noiseKey = Buffer.from(info.publicKey).toString('hex');
    let channel = this.channelsByNoiseKey.get(noiseKey);
    if (!channel) {
      channel = new ReliablePeer(
        this.options.crypto,
        async (envelope, peerId) => {
          for (const handler of this.handlers) await handler(envelope, peerId);
        },
        (peerId) => {
          const existing = this.channelsByPeerId.get(peerId);
          if (existing && existing !== channel) existing.close();
          this.channelsByPeerId.set(peerId, channel!);
          for (const wake of this.peerWaiters) wake();
          for (const handler of this.peerStateHandlers) handler(peerId, true);
        },
        () => { this.rejections += 1; },
      );
      this.channelsByNoiseKey.set(noiseKey, channel);
    }
    try {
      channel.attach(stream);
      stream.on('close', () => {
        const peerId = channel!.peerId;
        if (!peerId || this.channelsByPeerId.get(peerId) !== channel || channel!.authenticated) return;
        for (const handler of this.peerStateHandlers) handler(peerId, false);
      });
    } catch (error) {
      this.rejections += 1;
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
// harn:end dht-topic-from-line-secret
