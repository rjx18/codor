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
const CHALLENGE_DOMAIN = Buffer.from('wireroom-auth-v1\0', 'utf8');

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

export function authenticateLocalToken(
  presented: string,
  expected: string,
  remoteAddress: string | undefined,
): boolean {
  const address = remoteAddress?.replace(/^::ffff:/, '');
  if (address !== '127.0.0.1' && address !== '::1') return false;
  const presentedHash = Buffer.alloc(sodium.crypto_generichash_BYTES);
  const expectedHash = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(presentedHash, Buffer.from(presented, 'utf8'));
  sodium.crypto_generichash(expectedHash, Buffer.from(expected, 'utf8'));
  return sodium.sodium_memcmp(presentedHash, expectedHash);
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
