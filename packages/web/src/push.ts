import sodium from 'libsodium-wrappers';

import {
  openForBrowser,
  persistBrowserRoomKey,
  storedBrowserRoomKeys,
} from './crypto.js';

export type BrowserPushKind = 'inbox' | 'ask' | 'approval' | 'hold' | 'stall';

export interface BrowserPushPreview {
  room: string;
  msg_id: number;
  kind: BrowserPushKind;
  preview: string;
  delivery_id?: string;
}

export type NotificationAction = '' | 'open-room' | 'release-hold';

const ASSOCIATED_DATA = new TextEncoder().encode('codor-push-v1\0');
const CDP_BASE64_PREFIX = 'codor-b64:';
const DEVICE_ENVELOPE_MAGIC = new TextEncoder().encode('WRPUSH1\0');
const SEALED_ROOM_KEY_BYTES = 80;

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validatedPreview(input: unknown): BrowserPushPreview {
  if (typeof input !== 'object' || input === null) throw new Error('push preview is not an object');
  const value = input as Partial<BrowserPushPreview>;
  if (typeof value.room !== 'string' || value.room === '') throw new Error('push channel is invalid');
  if (!Number.isSafeInteger(value.msg_id) || value.msg_id! < 1) throw new Error('push msg_id is invalid');
  if (!['inbox', 'ask', 'approval', 'hold', 'stall'].includes(value.kind ?? '')) {
    throw new Error('push kind is invalid');
  }
  if (typeof value.preview !== 'string' || [...value.preview].length > 120) {
    throw new Error('push preview text is invalid');
  }
  if (value.delivery_id !== undefined && (
    typeof value.delivery_id !== 'string' || value.delivery_id.length < 1 || value.delivery_id.length > 128
  )) {
    throw new Error('push delivery_id is invalid');
  }
  return value as BrowserPushPreview;
}

interface DeviceEnvelope {
  generation: number;
  sealedRoomKey: Uint8Array;
  sealedPreview: Uint8Array;
}

function parseDeviceEnvelope(input: Uint8Array): DeviceEnvelope | undefined {
  if (input.length < DEVICE_ENVELOPE_MAGIC.length) return undefined;
  if (!DEVICE_ENVELOPE_MAGIC.every((byte, index) => input[index] === byte)) return undefined;
  const headerBytes = DEVICE_ENVELOPE_MAGIC.length + 6;
  if (input.length < headerBytes + SEALED_ROOM_KEY_BYTES + 1) {
    throw new Error('device push envelope is too short');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const generation = view.getUint32(DEVICE_ENVELOPE_MAGIC.length);
  const keyBytes = view.getUint16(DEVICE_ENVELOPE_MAGIC.length + 4);
  if (generation < 1 || keyBytes !== SEALED_ROOM_KEY_BYTES || input.length <= headerBytes + keyBytes) {
    throw new Error('device push envelope header is invalid');
  }
  return {
    generation,
    sealedRoomKey: input.slice(headerBytes, headerBytes + keyBytes),
    sealedPreview: input.slice(headerBytes + keyBytes),
  };
}

export function decodePushEventData(data: Uint8Array): Uint8Array {
  const possibleWrapper = new TextDecoder().decode(data);
  if (!possibleWrapper.startsWith(CDP_BASE64_PREFIX)) return data;
  return decodeBase64(possibleWrapper.slice(CDP_BASE64_PREFIX.length));
}

// harn:assume push-decrypts-on-device-only ref=browser-push-envelope-open
export async function openPushEnvelope(
  input: Uint8Array,
  roomKeyBase64Url: string,
): Promise<BrowserPushPreview> {
  await sodium.ready;
  const sealed = decodePushEventData(input);
  return openSealedPreview(sealed, roomKeyBase64Url);
}

function openSealedPreview(
  sealed: Uint8Array,
  roomKeyBase64Url: string,
): BrowserPushPreview {
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const tagBytes = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
  if (sealed.length < nonceBytes + tagBytes + 4) throw new Error('push envelope is too short');
  const nonce = sealed.slice(0, nonceBytes);
  const ciphertext = sealed.slice(nonceBytes);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    ASSOCIATED_DATA,
    nonce,
    decodeBase64Url(roomKeyBase64Url),
  );
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const length = view.getUint32(0);
  if (length === 0 || length > plaintext.length - 4) throw new Error('push length prefix is invalid');
  return validatedPreview(JSON.parse(new TextDecoder().decode(plaintext.slice(4, 4 + length))));
}

export async function openPushFromStoredRooms(input: Uint8Array): Promise<BrowserPushPreview> {
  const decoded = decodePushEventData(input);
  const deviceEnvelope = parseDeviceEnvelope(decoded);
  if (deviceEnvelope) {
    const roomKey = await openForBrowser(encodeBase64Url(deviceEnvelope.sealedRoomKey));
    const preview = await openPushEnvelope(deviceEnvelope.sealedPreview, encodeBase64Url(roomKey));
    await persistBrowserRoomKey(preview.room, deviceEnvelope.generation, roomKey);
    return preview;
  }
  const keys = await storedBrowserRoomKeys();
  for (const key of keys) {
    try {
      const preview = await openPushEnvelope(decoded, key.key);
      if (preview.room === key.room) return preview;
    } catch {
      // A push carries no cleartext room id, so try the small paired-room key set.
    }
  }
  throw new Error('push was not addressed to any paired channel');
}
// harn:end push-decrypts-on-device-only

export function notificationTitle(kind: BrowserPushKind): string {
  switch (kind) {
    case 'ask': return 'Question needs you';
    case 'approval': return 'Approval requested';
    case 'hold': return 'Channel paused';
    case 'stall': return 'Run stalled';
    default: return 'New channel message';
  }
}

export function notificationTarget(preview: BrowserPushPreview, action: NotificationAction): string {
  const query = new URLSearchParams({ room: preview.room });
  query.set(
    'notification_action',
    action === 'release-hold' ? 'release_hold' : 'mark_read',
  );
  query.set('msg_id', String(preview.msg_id));
  if (preview.delivery_id) query.set('delivery_id', preview.delivery_id);
  return `/?${query.toString()}#${String(preview.msg_id)}`;
}

export const cdpPushData = (sealedBase64: string): string => `${CDP_BASE64_PREFIX}${sealedBase64}`;
