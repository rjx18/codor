import sodium from 'sodium-native';
import { z } from 'zod';

export const MAX_SEALED_BYTES =
  2_048 +
  sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
  sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES +
  Buffer.byteLength('WRPUSH1\0') +
  4 +
  2 +
  sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES +
  sodium.crypto_box_SEALBYTES;
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

const PushSubscriptionSchema = z.strictObject({
  endpoint: z.url().refine((value) => new URL(value).protocol === 'https:', {
    message: 'push endpoint must use https',
  }),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
});

export const NotifyRequestSchema = z.strictObject({
  subscription: PushSubscriptionSchema,
  sealed: z.string().min(4).max(Math.ceil(MAX_SEALED_BYTES / 3) * 4),
  ttl: z.number().int().min(0).max(2_419_200),
});

export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;

export interface NotifyAuth {
  sender: string;
  timestamp: string;
  signature: string;
}

export interface SenderPolicy {
  allowedSenders: ReadonlySet<string>;
  openMode: boolean;
}

export class InvalidNotifyRequestError extends Error {}
export class NotifyPayloadTooLargeError extends Error {}
export class UnauthorizedNotifyError extends Error {}

const SIGNATURE_DOMAIN = Buffer.from('wireroom-relay-notify-v1\0', 'utf8');

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new InvalidNotifyRequestError('sealed must be canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new InvalidNotifyRequestError('sealed must be canonical base64');
  }
  if (decoded.length > MAX_SEALED_BYTES) {
    throw new NotifyPayloadTooLargeError('sealed payload exceeds the Web Push budget');
  }
  return decoded;
}

function decodeBase64Url(value: string, bytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new UnauthorizedNotifyError(`${label} is malformed`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) {
    throw new UnauthorizedNotifyError(`${label} is malformed`);
  }
  return decoded;
}

export function canonicalNotifyBytes(body: NotifyRequest, auth: Pick<NotifyAuth, 'sender' | 'timestamp'>): Buffer {
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

export function parseNotifyRequest(input: unknown): { body: NotifyRequest; sealed: Buffer } {
  const result = NotifyRequestSchema.safeParse(input);
  if (!result.success) {
    const candidate = input as { sealed?: unknown } | null;
    if (candidate && typeof candidate.sealed === 'string') {
      const approximateBytes = Math.floor(candidate.sealed.length * 3 / 4);
      if (approximateBytes > MAX_SEALED_BYTES) {
        throw new NotifyPayloadTooLargeError('sealed payload exceeds the Web Push budget');
      }
    }
    throw new InvalidNotifyRequestError('invalid notify request');
  }
  return { body: result.data, sealed: decodeBase64(result.data.sealed) };
}

// harn:assume notify-signed-by-allowlisted-switchboard ref=relay-sender-signature-gate
export function verifyNotifySignature(
  body: NotifyRequest,
  auth: NotifyAuth,
  policy: SenderPolicy,
  now: number = Date.now(),
): void {
  const publicKey = decodeBase64Url(
    auth.sender,
    sodium.crypto_sign_PUBLICKEYBYTES,
    'sender public key',
  );
  const timestamp = Number(auth.timestamp);
  if (!/^\d+$/.test(auth.timestamp) || !Number.isSafeInteger(timestamp)) {
    throw new UnauthorizedNotifyError('invalid signature timestamp');
  }
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    throw new UnauthorizedNotifyError('signature timestamp is outside the allowed window');
  }
  if (!policy.openMode && !policy.allowedSenders.has(auth.sender)) {
    throw new UnauthorizedNotifyError('sender is not allowed');
  }
  const signature = decodeBase64Url(
    auth.signature,
    sodium.crypto_sign_BYTES,
    'Ed25519 signature',
  );
  if (!sodium.crypto_sign_verify_detached(
    signature,
    canonicalNotifyBytes(body, auth),
    publicKey,
  )) {
    throw new UnauthorizedNotifyError('invalid sender signature');
  }
}
// harn:end notify-signed-by-allowlisted-switchboard
