import { pathToFileURL } from 'node:url';

import { WebPushSender } from './push.js';
import { createRelayServer } from './server.js';

export { PushDeliveryError, WebPushSender } from './push.js';
export type { PushSender, VapidConfig } from './push.js';
export { createRelayServer } from './server.js';
export type { RelayServerOptions } from './server.js';
export {
  canonicalNotifyBytes,
  InvalidNotifyRequestError,
  MAX_SEALED_BYTES,
  NotifyPayloadTooLargeError,
  NotifyRequestSchema,
  parseNotifyRequest,
  UnauthorizedNotifyError,
  verifyNotifySignature,
} from './seal.js';
export type { NotifyAuth, NotifyRequest, SenderPolicy } from './seal.js';

export interface RelayEnvironment {
  HOST?: string;
  PORT?: string;
  ALLOWED_SENDERS?: string;
  OPEN_MODE?: string;
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  TRUST_PROXY?: string;
}

export function relayConfigFromEnv(env: RelayEnvironment) {
  const required = (name: keyof RelayEnvironment): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const allowedSenders = new Set(
    (env.ALLOWED_SENDERS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  );
  const openMode = env.OPEN_MODE === '1' || env.OPEN_MODE === 'true';
  const trustProxy = (env.TRUST_PROXY ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!openMode && allowedSenders.size === 0) {
    throw new Error('ALLOWED_SENDERS is required unless OPEN_MODE=true');
  }
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT ?? '8787'),
    allowedSenders,
    openMode,
    trustProxy,
    vapid: {
      subject: required('VAPID_SUBJECT'),
      publicKey: required('VAPID_PUBLIC_KEY'),
      privateKey: required('VAPID_PRIVATE_KEY'),
    },
  };
}

export async function startRelayFromEnv(env: RelayEnvironment = process.env): Promise<void> {
  const config = relayConfigFromEnv(env);
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error('PORT must be a valid TCP port');
  }
  const app = createRelayServer({
    push: new WebPushSender(config.vapid),
    allowedSenders: config.allowedSenders,
    openMode: config.openMode,
    ...(config.trustProxy.length > 0 && { trustProxy: config.trustProxy }),
  });
  await app.listen({ host: config.host, port: config.port });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startRelayFromEnv().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'relay failed to start');
    process.exitCode = 1;
  });
}
