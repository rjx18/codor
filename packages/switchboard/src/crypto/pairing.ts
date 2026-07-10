import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sodium from 'sodium-native';

import { ChallengeAuthority, constantTimeEqual } from './challenge.js';
import {
  DeviceKeyStore,
  type PeerKind,
  type PeerRecord,
  type PublicIdentity,
  privateJsonWrite,
} from './keys.js';
import { RoomKeyStore, type SealedRoomKey } from './roomkeys.js';

const PAIRING_TTL_MS = 10 * 60 * 1_000;

interface StoredPairingToken {
  token_hash: string;
  endpoint: string;
  expires_at: string;
}

interface PairingFile {
  version: 1;
  tokens: StoredPairingToken[];
}

export interface PairingOffer {
  endpoint: string;
  pairing_token: string;
  expires_at: string;
  switchboard_sign_pub: string;
}

export interface PairingRequest extends PublicIdentity {
  kind: PeerKind;
  label?: string;
}

export interface PairingResult {
  switchboard: PublicIdentity;
  room_keys: SealedRoomKey[];
}

function randomToken(): string {
  const token = Buffer.alloc(32);
  sodium.randombytes_buf(token);
  return token.toString('base64url');
}

function hashToken(token: string): string {
  const digest = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(digest, Buffer.from(token, 'utf8'));
  return digest.toString('base64url');
}

export function pairingUrl(offer: PairingOffer): string {
  const url = new URL('/pair', offer.endpoint);
  url.searchParams.set('endpoint', offer.endpoint);
  url.searchParams.set('pairing_token', offer.pairing_token);
  url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
  return url.toString();
}

export class PairingService {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly keys: DeviceKeyStore,
    private readonly roomKeys: RoomKeyStore,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dataDir, 'crypto', 'pairing-tokens.json');
    if (!existsSync(this.path)) privateJsonWrite(this.path, { version: 1, tokens: [] });
  }

  issue(endpoint: string): PairingOffer {
    const normalized = new URL(endpoint).toString().replace(/\/$/, '');
    const token = randomToken();
    const expiresAt = new Date(this.now() + PAIRING_TTL_MS).toISOString();
    const state = this.read();
    state.tokens = state.tokens
      .filter((entry) => Date.parse(entry.expires_at) >= this.now())
      .concat({ token_hash: hashToken(token), endpoint: normalized, expires_at: expiresAt });
    this.write(state);
    return {
      endpoint: normalized,
      pairing_token: token,
      expires_at: expiresAt,
      switchboard_sign_pub: this.keys.identity.sign_public_key,
    };
  }

  complete(token: string, request: PairingRequest): PairingResult {
    const state = this.read();
    const digest = hashToken(token);
    let match: StoredPairingToken | undefined;
    for (const entry of state.tokens) {
      if (constantTimeEqual(entry.token_hash, digest)) match = entry;
    }
    state.tokens = state.tokens.filter((entry) => !constantTimeEqual(entry.token_hash, digest));
    this.write(state);
    if (!match) throw new Error('invalid or already-used pairing token');
    if (this.now() > Date.parse(match.expires_at)) throw new Error('pairing token expired');
    const peer = this.keys.enrollPeer(request);
    this.roomKeys.enrollPeer(peer);
    return {
      switchboard: this.keys.publicIdentity(),
      room_keys: this.roomKeys.sealedFor(peer.device_id),
    };
  }

  accept(result: PairingResult, label = 'home'): PeerRecord {
    return this.keys.enrollPeer({ ...result.switchboard, kind: 'switchboard', label });
  }

  private read(): PairingFile {
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as PairingFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) throw new Error('invalid pairing file');
    return parsed;
  }

  private write(state: PairingFile): void {
    privateJsonWrite(this.path, state);
  }
}

// harn:assume revocation-rotates-room-keys ref=revoke-rekey-disconnect
export class CryptoVault {
  readonly keys: DeviceKeyStore;
  readonly roomKeys: RoomKeyStore;
  readonly pairing: PairingService;
  readonly challenges: ChallengeAuthority;

  constructor(readonly dataDir: string) {
    this.keys = new DeviceKeyStore(dataDir);
    this.roomKeys = new RoomKeyStore(dataDir, this.keys);
    this.pairing = new PairingService(dataDir, this.keys, this.roomKeys);
    this.challenges = new ChallengeAuthority(this.keys);
  }

  revokePeer(reference: string): PeerRecord {
    const revoked = this.keys.revokePeer(reference);
    this.roomKeys.rotateAll();
    return revoked;
  }

  close(): void {
    this.keys.close();
  }
}
// harn:end revocation-rotates-room-keys
