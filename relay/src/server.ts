import Fastify, { type FastifyInstance } from 'fastify';

import {
  InvalidNotifyRequestError,
  NotifyPayloadTooLargeError,
  parseNotifyRequest,
  type NotifyAuth,
  type SenderPolicy,
  UnauthorizedNotifyError,
  verifyNotifySignature,
} from './seal.js';
import { PushDeliveryError, type PushSender } from './push.js';

export interface RelayServerOptions extends SenderPolicy {
  push: PushSender;
  now?: () => number;
  openRateLimit?: number;
  openRateWindowMs?: number;
  openRateMaximumEntries?: number;
  trustProxy?: boolean | string | string[];
}

interface RateEntry {
  count: number;
  resetAt: number;
}

export class WindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>();
  private nextSweep = 0;

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maximumEntries = 10_000,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
      this.nextSweep = now + this.windowMs;
    }
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.entries.size >= this.maximumEntries) {
        let oldestKey: string | undefined;
        let oldestReset = Number.POSITIVE_INFINITY;
        for (const [entryKey, entry] of this.entries) {
          if (entry.resetAt < oldestReset) {
            oldestKey = entryKey;
            oldestReset = entry.resetAt;
          }
        }
        if (oldestKey) this.entries.delete(oldestKey);
      }
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.maximum) return false;
    current.count += 1;
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}

function requiredHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new UnauthorizedNotifyError(`missing ${name}`);
  }
  return value;
}

// harn:assume relay-stateless-subscription-in-request ref=notify-subscription-request
export function createRelayServer(options: RelayServerOptions): FastifyInstance {
  if (!options.openMode && options.allowedSenders.size === 0) {
    throw new Error('configure ALLOWED_SENDERS or explicitly enable OPEN_MODE');
  }
  const now = options.now ?? Date.now;
  const rateLimit = new WindowRateLimiter(
    options.openRateLimit ?? 10,
    options.openRateWindowMs ?? 60_000,
    now,
    options.openRateMaximumEntries ?? 10_000,
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    ...(options.trustProxy !== undefined && { trustProxy: options.trustProxy }),
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/notify', async (request, reply) => {
    try {
      if (options.openMode && !rateLimit.take(`address:${request.ip}`)) {
        return reply.code(429).send({ error: 'rate_limited' });
      }
      const { body, sealed } = parseNotifyRequest(request.body);
      const auth: NotifyAuth = {
        sender: requiredHeader(request.headers['x-codor-sender'], 'x-codor-sender'),
        timestamp: requiredHeader(request.headers['x-codor-timestamp'], 'x-codor-timestamp'),
        signature: requiredHeader(request.headers['x-codor-signature'], 'x-codor-signature'),
      };
      verifyNotifySignature(body, auth, options, now());
      if (options.openMode && !rateLimit.take(`sender:${auth.sender}`)) {
        return reply.code(429).send({ error: 'rate_limited' });
      }
      // harn:assume relay-opaque-forwarder-no-crypto ref=relay-opaque-push-boundary
      await options.push.send(body.subscription, sealed, body.ttl);
      // harn:end relay-opaque-forwarder-no-crypto
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      if (error instanceof NotifyPayloadTooLargeError) {
        return reply.code(413).send({ error: 'sealed_payload_too_large' });
      }
      if (error instanceof InvalidNotifyRequestError) {
        return reply.code(400).send({ error: 'invalid_notify_request' });
      }
      if (error instanceof UnauthorizedNotifyError) {
        return reply.code(401).send({ error: 'unauthorized_sender' });
      }
      if (error instanceof PushDeliveryError && error.expiredSubscription) {
        return reply.code(410).send({ error: 'subscription_expired' });
      }
      if (error instanceof PushDeliveryError) {
        return reply.code(502).send({ error: 'push_delivery_failed' });
      }
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  return app;
}
// harn:end relay-stateless-subscription-in-request
