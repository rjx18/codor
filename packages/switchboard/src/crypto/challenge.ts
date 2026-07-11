import sodium from 'sodium-native';

import {
  decodeKey,
  type DeviceIdentity,
  type DeviceKeyStore,
  type PeerRecord,
} from './keys.js';

export interface AuthChallenge {
  challenge_id: string;
  server_nonce: string;
  transcript_hash: string;
  expires_at: string;
}

interface StoredChallenge extends AuthChallenge {
  peer_id: string;
}

export interface AuthenticatedConnection {
  id: string;
  peer: PeerRecord;
  close(reason: string): void;
}

const CHALLENGE_TTL_MS = 30_000;
const MAX_PENDING_PER_PEER = 8;
const MAX_PENDING_TOTAL = 1_024;
const CHALLENGE_DOMAIN = Buffer.from('codor-auth-v1\0', 'utf8');

function random(bytes: number): Buffer {
  const value = Buffer.alloc(bytes);
  sodium.randombytes_buf(value);
  return value;
}

export function challengeBytes(challenge: Pick<AuthChallenge, 'server_nonce' | 'transcript_hash'>): Buffer {
  return Buffer.concat([
    CHALLENGE_DOMAIN,
    decodeKey(challenge.server_nonce, 32, 'server nonce'),
    decodeKey(challenge.transcript_hash, sodium.crypto_generichash_BYTES, 'transcript hash'),
  ]);
}

export function hashTranscript(transcript: Uint8Array): string {
  const digest = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(digest, Buffer.from(transcript));
  return digest.toString('base64url');
}

export function signChallenge(challenge: AuthChallenge, identity: DeviceIdentity): string {
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
  sodium.crypto_sign_detached(
    signature,
    challengeBytes(challenge),
    decodeKey(identity.sign_secret_key, sodium.crypto_sign_SECRETKEYBYTES, 'Ed25519 secret key'),
  );
  return signature.toString('base64url');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = Buffer.alloc(sodium.crypto_generichash_BYTES);
  const rightHash = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(leftHash, Buffer.from(left, 'utf8'));
  sodium.crypto_generichash(rightHash, Buffer.from(right, 'utf8'));
  return sodium.sodium_memcmp(leftHash, rightHash);
}

// harn:assume nonce-challenge-auth-no-key-possession-identity ref=replay-bound-peer-auth
export class ChallengeAuthority {
  private readonly pending = new Map<string, StoredChallenge>();

  constructor(
    private readonly keys: DeviceKeyStore,
    private readonly now: () => number = Date.now,
  ) {}

  issue(peerId: string, transcriptHash: string): AuthChallenge {
    if (!this.keys.getPeer(peerId)) throw new Error('peer is not enrolled');
    decodeKey(transcriptHash, sodium.crypto_generichash_BYTES, 'transcript hash');
    this.sweepExpired();
    this.trimPending((challenge) => challenge.peer_id === peerId, MAX_PENDING_PER_PEER);
    this.trimPending(() => true, MAX_PENDING_TOTAL);
    const issued = this.now();
    const challenge: StoredChallenge = {
      challenge_id: random(16).toString('base64url'),
      server_nonce: random(32).toString('base64url'),
      transcript_hash: transcriptHash,
      expires_at: new Date(issued + CHALLENGE_TTL_MS).toISOString(),
      peer_id: peerId,
    };
    this.pending.set(challenge.challenge_id, challenge);
    return challenge;
  }

  pendingCount(peerId?: string): number {
    this.sweepExpired();
    return peerId === undefined
      ? this.pending.size
      : [...this.pending.values()].filter((challenge) => challenge.peer_id === peerId).length;
  }

  verify(challengeId: string, signature: string): PeerRecord {
    const challenge = this.pending.get(challengeId);
    this.pending.delete(challengeId);
    if (!challenge) throw new Error('unknown or already-consumed challenge');
    if (this.now() > Date.parse(challenge.expires_at)) throw new Error('challenge expired');
    const peer = this.keys.getPeer(challenge.peer_id);
    if (!peer) throw new Error('peer is no longer enrolled');
    const valid = sodium.crypto_sign_verify_detached(
      decodeKey(signature, sodium.crypto_sign_BYTES, 'Ed25519 signature'),
      challengeBytes(challenge),
      decodeKey(peer.sign_public_key, sodium.crypto_sign_PUBLICKEYBYTES, 'Ed25519 public key'),
    );
    if (!valid) throw new Error('invalid challenge signature');
    return peer;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, challenge] of this.pending) {
      if (now > Date.parse(challenge.expires_at)) this.pending.delete(id);
    }
  }

  private trimPending(
    matches: (challenge: StoredChallenge) => boolean,
    maximum: number,
  ): void {
    let count = [...this.pending.values()].filter(matches).length;
    for (const [id, challenge] of this.pending) {
      if (count < maximum) return;
      if (!matches(challenge)) continue;
      this.pending.delete(id);
      count -= 1;
    }
  }
}

export class AuthenticatedConnectionRegistry {
  private readonly connections = new Map<string, AuthenticatedConnection>();
  private readonly stopWatching: () => void;

  constructor(keys: DeviceKeyStore) {
    this.stopWatching = keys.onPeerRevoked((deviceId) => this.dropPeer(deviceId));
  }

  add(connection: AuthenticatedConnection): () => void {
    this.connections.set(connection.id, connection);
    return () => this.connections.delete(connection.id);
  }

  has(id: string): boolean {
    return this.connections.has(id);
  }

  close(): void {
    this.stopWatching();
    for (const connection of this.connections.values()) connection.close('registry closed');
    this.connections.clear();
  }

  private dropPeer(deviceId: string): void {
    for (const [id, connection] of this.connections) {
      if (connection.peer.device_id !== deviceId) continue;
      this.connections.delete(id);
      connection.close('peer revoked');
    }
  }
}
// harn:end nonce-challenge-auth-no-key-possession-identity
