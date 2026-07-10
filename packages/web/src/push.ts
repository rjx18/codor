import sodium from 'libsodium-wrappers';

import { storedBrowserRoomKeys } from './crypto.js';

export type BrowserPushKind = 'inbox' | 'ask' | 'approval' | 'hold' | 'stall';

export interface BrowserPushPreview {
  room: string;
  msg_id: number;
  kind: BrowserPushKind;
  preview: string;
}

export type NotificationAction = '' | 'open-room' | 'release-hold';

const ASSOCIATED_DATA = new TextEncoder().encode('wireroom-push-v1\0');
const CDP_BASE64_PREFIX = 'wireroom-b64:';

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validatedPreview(input: unknown): BrowserPushPreview {
  if (typeof input !== 'object' || input === null) throw new Error('push preview is not an object');
  const value = input as Partial<BrowserPushPreview>;
  if (typeof value.room !== 'string' || value.room === '') throw new Error('push room is invalid');
  if (!Number.isSafeInteger(value.msg_id) || value.msg_id! < 1) throw new Error('push msg_id is invalid');
  if (!['inbox', 'ask', 'approval', 'hold', 'stall'].includes(value.kind ?? '')) {
    throw new Error('push kind is invalid');
  }
  if (typeof value.preview !== 'string' || [...value.preview].length > 120) {
    throw new Error('push preview text is invalid');
  }
  return value as BrowserPushPreview;
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
  const keys = await storedBrowserRoomKeys();
  for (const key of keys) {
    try {
      const preview = await openPushEnvelope(input, key.key);
      if (preview.room === key.room) return preview;
    } catch {
      // A push carries no cleartext room id, so try the small paired-room key set.
    }
  }
  throw new Error('push was not addressed to any paired room');
}
// harn:end push-decrypts-on-device-only

export function notificationTitle(kind: BrowserPushKind): string {
  switch (kind) {
    case 'ask': return 'Question needs you';
    case 'approval': return 'Approval requested';
    case 'hold': return 'Room paused';
    case 'stall': return 'Run stalled';
    default: return 'New room message';
  }
}

export function notificationTarget(preview: BrowserPushPreview, action: NotificationAction): string {
  const query = new URLSearchParams({ room: preview.room });
  query.set(
    'notification_action',
    action === 'release-hold' ? 'release_hold' : 'mark_read',
  );
  query.set('msg_id', String(preview.msg_id));
  return `/?${query.toString()}#${String(preview.msg_id)}`;
}

export const cdpPushData = (sealedBase64: string): string => `${CDP_BASE64_PREFIX}${sealedBase64}`;
