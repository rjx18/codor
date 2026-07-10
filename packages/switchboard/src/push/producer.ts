import sodium from 'sodium-native';

import { type DeviceIdentity, decodeKey } from '../crypto/keys.js';
import type { RoomKeyStore } from '../crypto/roomkeys.js';
import { redactText } from '../redact.js';
import type {
  DevicePushSubscription,
  PushSubscriptionStore,
  WebPushSubscription,
} from './subscriptions.js';

export const PUSH_BUCKETS = [512, 2_048] as const;
export const PUSH_PREVIEW_LIMIT = 120;
export const PUSH_ENVELOPE_OVERHEAD =
  sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
  sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

export type HumanPushKind = 'inbox' | 'ask' | 'approval' | 'hold' | 'stall';

export interface PushPreview {
  room: string;
  msg_id: number;
  kind: HumanPushKind;
  preview: string;
}

export interface HumanPushEvent extends PushPreview {
  target_human_ids: string[];
}

export interface HumanPushNotifier {
  notify(event: HumanPushEvent): Promise<PushDeliveryResult[]>;
}

export interface PushDeliveryResult {
  device_id?: string;
  status: 'disabled' | 'ignored' | 'sent' | 'expired' | 'failed';
  http_status?: number;
}

export interface PushProducerOptions {
  relayUrl?: string;
  identity: DeviceIdentity;
  roomKeys: RoomKeyStore;
  subscriptions: PushSubscriptionStore;
  fetch?: typeof fetch;
  now?: () => number;
  ttl?: number;
}

interface RelayNotifyBody {
  subscription: WebPushSubscription;
  sealed: string;
  ttl: number;
}

const PUSH_ASSOCIATED_DATA = Buffer.from('wireroom-push-v1\0', 'utf8');
const SIGNATURE_DOMAIN = Buffer.from('wireroom-relay-notify-v1\0', 'utf8');

function codePointSlice(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('');
}

export function buildPushPreview(event: HumanPushEvent): PushPreview {
  return {
    room: event.room,
    msg_id: event.msg_id,
    kind: event.kind,
    preview: codePointSlice(redactText(event.preview), PUSH_PREVIEW_LIMIT),
  };
}

export function paddedPushPreview(preview: PushPreview): Buffer {
  const encoded = Buffer.from(JSON.stringify(preview), 'utf8');
  const bucket = PUSH_BUCKETS.find((size) => encoded.length + 4 <= size);
  if (bucket === undefined) throw new Error('push preview exceeds the largest padding bucket');
  const padded = Buffer.alloc(bucket);
  padded.writeUInt32BE(encoded.length, 0);
  encoded.copy(padded, 4);
  if (encoded.length + 4 < padded.length) {
    sodium.randombytes_buf(padded.subarray(encoded.length + 4));
  }
  return padded;
}

// harn:assume push-previews-redacted-pad-then-sealed ref=producer-pad-seal-sign
export function sealPushPreview(preview: PushPreview, roomKey: Buffer): Buffer {
  const padded = paddedPushPreview(preview);
  const nonce = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  sodium.randombytes_buf(nonce);
  const ciphertext = Buffer.alloc(
    padded.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
  );
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext,
    padded,
    PUSH_ASSOCIATED_DATA,
    null,
    nonce,
    roomKey,
  );
  return Buffer.concat([nonce, ciphertext]);
}

function canonicalNotifyBytes(
  body: RelayNotifyBody,
  auth: { sender: string; timestamp: string },
): Buffer {
  return Buffer.concat([
    SIGNATURE_DOMAIN,
    Buffer.from(JSON.stringify({
      sender: auth.sender,
      timestamp: auth.timestamp,
      subscription: {
        endpoint: body.subscription.endpoint,
        expirationTime: body.subscription.expirationTime ?? null,
        keys: {
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
        },
      },
      sealed: body.sealed,
      ttl: body.ttl,
    }), 'utf8'),
  ]);
}

function relayEndpoint(relayUrl: string): string {
  const url = new URL(relayUrl);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('relay_url must use https except on localhost');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/notify`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class PushProducer implements HumanPushNotifier {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly options: PushProducerOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? 60;
  }

  async notify(event: HumanPushEvent): Promise<PushDeliveryResult[]> {
    if (!this.options.relayUrl) return [{ status: 'disabled' }];
    if (event.target_human_ids.length === 0) return [{ status: 'ignored' }];
    const records = this.options.subscriptions.list();
    if (records.length === 0) return [];
    const preview = buildPushPreview(event);
    const sealed = sealPushPreview(preview, this.options.roomKeys.roomKey(event.room));
    const endpoint = relayEndpoint(this.options.relayUrl);
    return Promise.all(records.map((record) => this.send(endpoint, record, sealed)));
  }

  private async send(
    endpoint: string,
    record: DevicePushSubscription,
    sealed: Buffer,
  ): Promise<PushDeliveryResult> {
    const body: RelayNotifyBody = {
      subscription: record.subscription,
      sealed: sealed.toString('base64'),
      ttl: this.ttl,
    };
    const sender = this.options.identity.sign_public_key;
    const timestamp = String(this.now());
    const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(
      signature,
      canonicalNotifyBytes(body, { sender, timestamp }),
      decodeKey(
        this.options.identity.sign_secret_key,
        sodium.crypto_sign_SECRETKEYBYTES,
        'Ed25519 secret key',
      ),
    );
    try {
      const response = await this.request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wireroom-sender': sender,
          'x-wireroom-timestamp': timestamp,
          'x-wireroom-signature': signature.toString('base64url'),
        },
        body: JSON.stringify(body),
      });
      if (response.status === 410) {
        this.options.subscriptions.remove(record.device_id);
        return { device_id: record.device_id, status: 'expired', http_status: 410 };
      }
      if (!response.ok) {
        return { device_id: record.device_id, status: 'failed', http_status: response.status };
      }
      return { device_id: record.device_id, status: 'sent', http_status: response.status };
    } catch {
      return { device_id: record.device_id, status: 'failed' };
    }
  }
}
// harn:end push-previews-redacted-pad-then-sealed
