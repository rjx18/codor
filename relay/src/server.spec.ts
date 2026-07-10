import sodium from 'sodium-native';
import { describe, expect, it, vi } from 'vitest';

import { PushDeliveryError, type PushSender } from './push.js';
import { createRelayServer, WindowRateLimiter } from './server.js';
import {
  canonicalNotifyBytes,
  MAX_SEALED_BYTES,
  type NotifyRequest,
} from './seal.js';

const NOW = Date.parse('2026-07-10T16:00:00.000Z');
const subscription = {
  endpoint: 'https://push.example.test/device/opaque-token',
  expirationTime: null,
  keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
};

function signer() {
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(publicKey, secretKey);
  return { sender: publicKey.toString('base64url'), secretKey };
}

function signed(body: NotifyRequest, identity: ReturnType<typeof signer>, timestamp = NOW) {
  const auth = { sender: identity.sender, timestamp: String(timestamp) };
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
  sodium.crypto_sign_detached(signature, canonicalNotifyBytes(body, auth), identity.secretKey);
  return {
    payload: body,
    headers: {
      'x-wireroom-sender': identity.sender,
      'x-wireroom-timestamp': auth.timestamp,
      'x-wireroom-signature': signature.toString('base64url'),
    },
  };
}

function body(bytes: Buffer = Buffer.from([0, 255, 18, 77])): NotifyRequest {
  return { subscription, sealed: bytes.toString('base64'), ttl: 45 };
}

describe('POST /notify', () => {
  it('verifies an allowlisted sender and forwards the exact opaque bytes only', async () => {
    const identity = signer();
    const push: PushSender = { send: vi.fn(async () => undefined) };
    const app = createRelayServer({
      push,
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    const opaque = Buffer.from([0, 1, 2, 3, 254, 255]);
    const request = signed(body(opaque), identity);

    const response = await app.inject({ method: 'POST', url: '/notify', ...request });

    expect(response.statusCode).toBe(202);
    expect(push.send).toHaveBeenCalledOnce();
    expect(push.send).toHaveBeenCalledWith(subscription, opaque, 45);
    await app.close();
  });

  it('rejects a valid signature from a sender outside the allowlist', async () => {
    const identity = signer();
    const push: PushSender = { send: vi.fn(async () => undefined) };
    const app = createRelayServer({
      push,
      allowedSenders: new Set([signer().sender]),
      openMode: false,
      now: () => NOW,
    });
    const response = await app.inject({ method: 'POST', url: '/notify', ...signed(body(), identity) });
    expect(response.statusCode).toBe(401);
    expect(push.send).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects signature tampering and stale signed requests', async () => {
    const identity = signer();
    const push: PushSender = { send: vi.fn(async () => undefined) };
    const app = createRelayServer({
      push,
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    const request = signed(body(), identity);
    const tampered = await app.inject({
      method: 'POST',
      url: '/notify',
      payload: { ...request.payload, ttl: 46 },
      headers: request.headers,
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/notify',
      ...signed(body(), identity, NOW - 5 * 60_000 - 1),
    });
    expect(tampered.statusCode).toBe(401);
    expect(stale.statusCode).toBe(401);
    expect(push.send).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts the device-key wrapper budget and rejects larger opaque payloads', async () => {
    const identity = signer();
    const push: PushSender = { send: vi.fn(async () => undefined) };
    const app = createRelayServer({
      push,
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/notify',
      ...signed(body(Buffer.alloc(MAX_SEALED_BYTES)), identity),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/notify',
      ...signed(body(Buffer.alloc(MAX_SEALED_BYTES + 1)), identity),
    });
    expect(accepted.statusCode).toBe(202);
    expect(response.statusCode).toBe(413);
    expect(push.send).toHaveBeenCalledOnce();
    await app.close();
  });

  it('surfaces expired subscriptions to the sender', async () => {
    const identity = signer();
    const push: PushSender = {
      send: vi.fn(async () => { throw new PushDeliveryError('gone', 410); }),
    };
    const app = createRelayServer({
      push,
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    const response = await app.inject({ method: 'POST', url: '/notify', ...signed(body(), identity) });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: 'subscription_expired' });
    await app.close();
  });

  it('retains no delivery state across a failed instance and retry after restart', async () => {
    const identity = signer();
    const failed = createRelayServer({
      push: { send: async () => { throw new PushDeliveryError('restart'); } },
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    const request = signed(body(), identity);
    expect((await failed.inject({ method: 'POST', url: '/notify', ...request })).statusCode).toBe(502);
    await failed.close();

    const send = vi.fn(async () => undefined);
    const restarted = createRelayServer({
      push: { send },
      allowedSenders: new Set([identity.sender]),
      openMode: false,
      now: () => NOW,
    });
    expect((await restarted.inject({ method: 'POST', url: '/notify', ...request })).statusCode).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    await restarted.close();
  });

  it('strictly rate limits explicit open mode by sender and address', async () => {
    const identity = signer();
    const push: PushSender = { send: vi.fn(async () => undefined) };
    const app = createRelayServer({
      push,
      allowedSenders: new Set(),
      openMode: true,
      openRateLimit: 2,
      openRateWindowMs: 60_000,
      now: () => NOW,
    });
    const request = signed(body(), identity);
    expect((await app.inject({ method: 'POST', url: '/notify', ...request })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/notify', ...request })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/notify', ...request })).statusCode).toBe(429);
    await app.close();
  });

  it('uses a configured trusted proxy address instead of collapsing all clients', async () => {
    const first = signer();
    const second = signer();
    const app = createRelayServer({
      push: { send: vi.fn(async () => undefined) },
      allowedSenders: new Set(),
      openMode: true,
      openRateLimit: 1,
      now: () => NOW,
      trustProxy: ['127.0.0.1'],
    });
    const firstRequest = signed(body(), first);
    const secondRequest = signed(body(), second);
    const third = signer();
    const thirdRequest = signed(body(), third);

    const fromFirst = await app.inject({
      method: 'POST', url: '/notify', ...firstRequest,
      headers: { ...firstRequest.headers, 'x-forwarded-for': '203.0.113.10' },
    });
    const fromSecond = await app.inject({
      method: 'POST', url: '/notify', ...secondRequest,
      headers: { ...secondRequest.headers, 'x-forwarded-for': '203.0.113.11' },
    });
    const repeatedAddress = await app.inject({
      method: 'POST', url: '/notify', ...thirdRequest,
      headers: { ...thirdRequest.headers, 'x-forwarded-for': '203.0.113.10' },
    });

    expect(fromFirst.statusCode).toBe(202);
    expect(fromSecond.statusCode).toBe(202);
    expect(repeatedAddress.statusCode).toBe(429);
    await app.close();
  });
});

describe('WindowRateLimiter', () => {
  it('sweeps expired entries and stays within its configured key bound', () => {
    let now = 1_000;
    const limiter = new WindowRateLimiter(1, 100, () => now, 3);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('c')).toBe(true);
    expect(limiter.take('d')).toBe(true);
    expect(limiter.size).toBe(3);
    now += 101;
    expect(limiter.take('fresh')).toBe(true);
    expect(limiter.size).toBe(1);
  });
});
