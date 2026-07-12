import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sodium from 'sodium-native';

import { BrowserDeviceSessionAuthority } from './browser-sessions.js';
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
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_LENGTH = 8;

interface StoredPairingToken {
  token_hash: string;
  code_hash?: string;
  endpoint: string;
  expires_at: string;
}

interface PairingFile {
  version: 1;
  tokens: StoredPairingToken[];
}

export interface PairingPayload {
  endpoint: string;
  pairing_token: string;
  expires_at: string;
  switchboard_sign_pub: string;
}

export interface PairingOffer extends PairingPayload {
  pairing_code: string;
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

function randomPairingCode(): string {
  const bytes = Buffer.alloc(PAIRING_CODE_LENGTH);
  sodium.randombytes_buf(bytes);
  return Array.from(bytes, (byte) => PAIRING_CODE_ALPHABET[byte & 31]).join('');
}

export function normalizePairingCode(value: string): string | undefined {
  const candidate = value.toUpperCase();
  const characterClass = `[${PAIRING_CODE_ALPHABET}]`;
  if (!new RegExp(`^(?:${characterClass}{8}|${characterClass}{4}-${characterClass}{4})$`).test(candidate)) {
    return undefined;
  }
  return candidate.replace('-', '');
}

export function formatPairingCode(value: string): string {
  const normalized = normalizePairingCode(value);
  if (!normalized) throw new Error('invalid pairing code');
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function hashToken(token: string): string {
  const digest = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(digest, Buffer.from(token, 'utf8'));
  return digest.toString('base64url');
}

export function pairingUrl(offer: PairingPayload): string {
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

  // harn:assume short-pairing-code-grant-exchange ref=pairing-code-grant-source
  issue(endpoint: string): PairingOffer {
    const normalized = new URL(endpoint).toString().replace(/\/$/, '');
    const token = randomToken();
    const code = randomPairingCode();
    const expiresAt = new Date(this.now() + PAIRING_TTL_MS).toISOString();
    const state = this.read();
    state.tokens = state.tokens
      .filter((entry) => Date.parse(entry.expires_at) >= this.now())
      .concat({
        token_hash: hashToken(token),
        code_hash: hashToken(code),
        endpoint: normalized,
        expires_at: expiresAt,
      });
    this.write(state);
    return {
      endpoint: normalized,
      pairing_token: token,
      pairing_code: formatPairingCode(code),
      expires_at: expiresAt,
      switchboard_sign_pub: this.keys.identity.sign_public_key,
    };
  }

  exchange(code: string): PairingPayload {
    const normalized = normalizePairingCode(code);
    const digest = hashToken(normalized ?? 'INVALID2');
    const state = this.read();
    let match: StoredPairingToken | undefined;
    for (const entry of state.tokens) {
      if (entry.code_hash && constantTimeEqual(entry.code_hash, digest)) match = entry;
    }
    if (!normalized || !match || this.now() > Date.parse(match.expires_at)) {
      throw new Error('pairing code not found');
    }

    const token = randomToken();
    state.tokens = state.tokens.map((entry) => entry === match
      ? { ...entry, token_hash: hashToken(token), code_hash: undefined }
      : entry);
    this.write(state);
    return {
      endpoint: match.endpoint,
      pairing_token: token,
      expires_at: match.expires_at,
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
    return this.enroll(request);
  }
  // harn:end short-pairing-code-grant-exchange

  // harn:assume tailnet-auto-pairing-explicit-trust ref=trusted-device-enrollment
  completeTrusted(request: PairingRequest, label: string): PairingResult {
    if (request.kind !== 'device') throw new Error('trusted enrollment is only for browser devices');
    return this.enroll({ ...request, label });
  }
  // harn:end tailnet-auto-pairing-explicit-trust

  private enroll(request: PairingRequest): PairingResult {
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
  readonly browserChallenges: ChallengeAuthority;
  readonly browserSessions: BrowserDeviceSessionAuthority;

  constructor(readonly dataDir: string) {
    this.keys = new DeviceKeyStore(dataDir);
    this.roomKeys = new RoomKeyStore(dataDir, this.keys);
    this.pairing = new PairingService(dataDir, this.keys, this.roomKeys);
    this.challenges = new ChallengeAuthority(this.keys);
    this.browserChallenges = new ChallengeAuthority(this.keys);
    this.browserSessions = new BrowserDeviceSessionAuthority(this.keys);
  }

  revokePeer(reference: string): PeerRecord {
    const revoked = this.keys.revokePeer(reference);
    this.roomKeys.rotateAll();
    return revoked;
  }

  close(): void {
    this.browserSessions.close();
    this.keys.close();
  }
}
// harn:end revocation-rotates-room-keys
