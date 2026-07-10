import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import sodium from 'sodium-native';

export type PeerKind = 'device' | 'switchboard';

export interface PublicIdentity {
  device_id: string;
  sign_public_key: string;
  encryption_public_key: string;
}

export interface DeviceIdentity extends PublicIdentity {
  sign_secret_key: string;
  encryption_secret_key: string;
}

export interface PeerRecord extends PublicIdentity {
  kind: PeerKind;
  label?: string;
  paired_at: string;
}

interface PeerFile {
  version: 1;
  peers: PeerRecord[];
}

const encode = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

export function decodeKey(value: string, bytes: number, label: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes) throw new Error(`${label} must be ${String(bytes)} bytes`);
  return decoded;
}

export function privateJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function publicIdentity(identity: DeviceIdentity): PublicIdentity {
  return {
    device_id: identity.device_id,
    sign_public_key: identity.sign_public_key,
    encryption_public_key: identity.encryption_public_key,
  };
}

function validatePublicIdentity(identity: PublicIdentity): void {
  decodeKey(identity.sign_public_key, sodium.crypto_sign_PUBLICKEYBYTES, 'Ed25519 public key');
  decodeKey(
    identity.encryption_public_key,
    sodium.crypto_box_PUBLICKEYBYTES,
    'X25519 public key',
  );
  if (identity.device_id !== identity.sign_public_key) {
    throw new Error('device id must equal the Ed25519 public key');
  }
}

// harn:assume ed25519-identity-x25519-encryption ref=dual-device-identity
// harn:assume single-crypto-suite-libsodium ref=node-libsodium-suite
export function generateIdentity(): DeviceIdentity {
  const signPublic = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const signSecret = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(signPublic, signSecret);
  const encryptionPublic = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const encryptionSecret = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(encryptionPublic, encryptionSecret);
  const signPublicKey = encode(signPublic);
  return {
    device_id: signPublicKey,
    sign_public_key: signPublicKey,
    sign_secret_key: encode(signSecret),
    encryption_public_key: encode(encryptionPublic),
    encryption_secret_key: encode(encryptionSecret),
  };
}

export class DeviceKeyStore {
  readonly identity: DeviceIdentity;
  private readonly identityPath: string;
  private readonly peersPath: string;
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private knownPeerIds = new Set<string>();

  constructor(readonly dataDir: string) {
    const cryptoDir = join(dataDir, 'crypto');
    this.identityPath = join(cryptoDir, 'identity.json');
    this.peersPath = join(cryptoDir, 'peers.json');
    mkdirSync(cryptoDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.identityPath)) privateJsonWrite(this.identityPath, generateIdentity());
    this.identity = JSON.parse(readFileSync(this.identityPath, 'utf8')) as DeviceIdentity;
    validatePublicIdentity(this.identity);
    decodeKey(this.identity.sign_secret_key, sodium.crypto_sign_SECRETKEYBYTES, 'Ed25519 secret key');
    decodeKey(
      this.identity.encryption_secret_key,
      sodium.crypto_box_SECRETKEYBYTES,
      'X25519 secret key',
    );
    if (!existsSync(this.peersPath)) privateJsonWrite(this.peersPath, { version: 1, peers: [] });
    this.knownPeerIds = new Set(this.readPeers().map((peer) => peer.device_id));
    watchFile(this.peersPath, { persistent: false, interval: 100 }, () => this.detectExternalRevokes());
  }

  publicIdentity(): PublicIdentity {
    return publicIdentity(this.identity);
  }

  listPeers(): PeerRecord[] {
    return this.readPeers();
  }

  getPeer(deviceId: string): PeerRecord | undefined {
    return this.readPeers().find((peer) => peer.device_id === deviceId);
  }

  resolvePeer(reference: string): PeerRecord | undefined {
    const peers = this.readPeers();
    return peers.find((peer) => peer.device_id === reference || peer.label === reference);
  }

  enrollPeer(input: Omit<PeerRecord, 'paired_at'> & { paired_at?: string }): PeerRecord {
    validatePublicIdentity(input);
    if (input.kind !== 'device' && input.kind !== 'switchboard') {
      throw new Error(`invalid peer kind '${String(input.kind)}'`);
    }
    const peers = this.readPeers();
    const record: PeerRecord = { ...input, paired_at: input.paired_at ?? new Date().toISOString() };
    const existing = peers.findIndex((peer) => peer.device_id === record.device_id);
    if (existing >= 0) peers[existing] = record;
    else peers.push(record);
    this.writePeers(peers);
    return record;
  }

  revokePeer(reference: string): PeerRecord {
    const peers = this.readPeers();
    const peer = peers.find((candidate) =>
      candidate.device_id === reference || candidate.label === reference);
    if (!peer) throw new Error(`no such peer '${reference}'`);
    this.writePeers(peers.filter((candidate) => candidate.device_id !== peer.device_id));
    for (const listener of this.revokeListeners) listener(peer.device_id);
    return peer;
  }

  onPeerRevoked(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  close(): void {
    unwatchFile(this.peersPath);
    this.revokeListeners.clear();
  }

  private readPeers(): PeerRecord[] {
    const parsed = JSON.parse(readFileSync(this.peersPath, 'utf8')) as PeerFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.peers)) throw new Error('invalid peers file');
    for (const peer of parsed.peers) validatePublicIdentity(peer);
    return parsed.peers;
  }

  private writePeers(peers: PeerRecord[]): void {
    privateJsonWrite(this.peersPath, { version: 1, peers } satisfies PeerFile);
    this.knownPeerIds = new Set(peers.map((peer) => peer.device_id));
  }

  private detectExternalRevokes(): void {
    const current = new Set(this.readPeers().map((peer) => peer.device_id));
    for (const deviceId of this.knownPeerIds) {
      if (!current.has(deviceId)) {
        for (const listener of this.revokeListeners) listener(deviceId);
      }
    }
    this.knownPeerIds = current;
  }
}
// harn:end single-crypto-suite-libsodium
// harn:end ed25519-identity-x25519-encryption
