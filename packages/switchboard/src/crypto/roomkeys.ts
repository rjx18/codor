import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sodium from 'sodium-native';

import {
  decodeKey,
  type DeviceIdentity,
  type DeviceKeyStore,
  type PeerRecord,
  privateJsonWrite,
} from './keys.js';

export interface SealedRoomKey {
  room: string;
  generation: number;
  sealed_key: string;
}

interface StoredRoomKey {
  generation: number;
  key: string;
  sealed: Record<string, string>;
}

interface RoomKeyFile {
  version: 1;
  rooms: Record<string, StoredRoomKey>;
}

const encode = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

export function sealBox(message: Uint8Array, publicKey: string): string {
  const recipient = decodeKey(publicKey, sodium.crypto_box_PUBLICKEYBYTES, 'X25519 public key');
  const ciphertext = Buffer.alloc(message.length + sodium.crypto_box_SEALBYTES);
  sodium.crypto_box_seal(ciphertext, Buffer.from(message), recipient);
  return encode(ciphertext);
}

export function openSealedBox(ciphertext: string, identity: DeviceIdentity): Buffer {
  const sealed = Buffer.from(ciphertext, 'base64url');
  if (sealed.length < sodium.crypto_box_SEALBYTES) throw new Error('invalid sealed box');
  const plaintext = Buffer.alloc(sealed.length - sodium.crypto_box_SEALBYTES);
  const opened = sodium.crypto_box_seal_open(
    plaintext,
    sealed,
    decodeKey(identity.encryption_public_key, sodium.crypto_box_PUBLICKEYBYTES, 'X25519 public key'),
    decodeKey(identity.encryption_secret_key, sodium.crypto_box_SECRETKEYBYTES, 'X25519 secret key'),
  );
  if (!opened) throw new Error('sealed box was not addressed to this identity');
  return plaintext;
}

// harn:assume sealed-room-keys-per-enrollee ref=sealed-room-key-fanout
export class RoomKeyStore {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly keys: DeviceKeyStore,
  ) {
    this.path = join(dataDir, 'crypto', 'room-keys.json');
    if (!existsSync(this.path)) privateJsonWrite(this.path, { version: 1, rooms: {} });
  }

  ensureRoom(room: string): StoredRoomKey {
    const state = this.read();
    const existing = state.rooms[room];
    if (existing) return existing;
    const created = this.createRoomKey(1, this.keys.listPeers());
    state.rooms[room] = created;
    this.write(state);
    return created;
  }

  roomGeneration(room: string): number {
    return this.ensureRoom(room).generation;
  }

  roomKey(room: string): Buffer {
    return decodeKey(
      this.ensureRoom(room).key,
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      'room key',
    );
  }

  enrollPeer(peer: PeerRecord): void {
    const state = this.read();
    for (const stored of Object.values(state.rooms)) {
      stored.sealed[peer.device_id] = sealBox(
        decodeKey(stored.key, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 'room key'),
        peer.encryption_public_key,
      );
    }
    this.write(state);
  }

  rotateRoom(room: string): StoredRoomKey {
    const state = this.read();
    const generation = (state.rooms[room]?.generation ?? 0) + 1;
    const rotated = this.createRoomKey(generation, this.keys.listPeers());
    state.rooms[room] = rotated;
    this.write(state);
    return rotated;
  }

  rotateAll(): void {
    const state = this.read();
    const peers = this.keys.listPeers();
    for (const [room, stored] of Object.entries(state.rooms)) {
      state.rooms[room] = this.createRoomKey(stored.generation + 1, peers);
    }
    this.write(state);
  }

  sealedFor(deviceId: string): SealedRoomKey[] {
    const state = this.read();
    return Object.entries(state.rooms).flatMap(([room, stored]) => {
      const sealed = stored.sealed[deviceId];
      return sealed ? [{ room, generation: stored.generation, sealed_key: sealed }] : [];
    });
  }

  private createRoomKey(generation: number, peers: PeerRecord[]): StoredRoomKey {
    const key = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    sodium.crypto_aead_xchacha20poly1305_ietf_keygen(key);
    return {
      generation,
      key: encode(key),
      sealed: Object.fromEntries(peers.map((peer) => [
        peer.device_id,
        sealBox(key, peer.encryption_public_key),
      ])),
    };
  }

  private read(): RoomKeyFile {
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as RoomKeyFile;
    if (parsed.version !== 1 || typeof parsed.rooms !== 'object') throw new Error('invalid room key file');
    return parsed;
  }

  private write(state: RoomKeyFile): void {
    privateJsonWrite(this.path, state);
  }
}
// harn:end sealed-room-keys-per-enrollee
