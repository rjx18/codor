import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sodium from 'sodium-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyNotifySignature } from '../../../../relay/src/seal.js';
import { CryptoVault } from '../crypto/pairing.js';
import { openSealedBox } from '../crypto/roomkeys.js';
import { Daemon } from '../daemon.js';
import { FakeAdapter } from '../fake-adapter.js';
import {
  buildPushPreview,
  paddedPushPreview,
  PUSH_BUCKETS,
  PUSH_DEVICE_ENVELOPE_MAGIC,
  PUSH_DEVICE_ENVELOPE_OVERHEAD,
  PUSH_ENVELOPE_OVERHEAD,
  PushProducer,
  sealPushPreview,
  type HumanPushEvent,
  type HumanPushNotifier,
  type PushPreview,
} from './producer.js';
import { PushSubscriptionStore } from './subscriptions.js';

const PUSH_ASSOCIATED_DATA = Buffer.from('codor-push-v1\0', 'utf8');

let dir: string;
let crypto: CryptoVault;
let device: CryptoVault;
let subscriptions: PushSubscriptionStore;

const subscription = {
  endpoint: 'https://push.example.test/device',
  expirationTime: null,
  keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codor-push-'));
  crypto = new CryptoVault(dir);
  crypto.roomKeys.ensureRoom('eng');
  device = new CryptoVault(join(dir, 'device'));
  const peer = crypto.keys.enrollPeer({
    ...device.keys.publicIdentity(),
    kind: 'device',
    label: 'browser',
  });
  crypto.roomKeys.enrollPeer(peer);
  subscriptions = new PushSubscriptionStore(dir, crypto.keys);
  subscriptions.register(peer.device_id, subscription);
});

afterEach(() => {
  crypto.close();
  device.close();
  rmSync(dir, { recursive: true, force: true });
});

function openForTest(sealed: Buffer, key: Buffer): { preview: PushPreview; padded: Buffer } {
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = sealed.subarray(0, nonceBytes);
  const ciphertext = sealed.subarray(nonceBytes);
  const padded = Buffer.alloc(ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    padded,
    null,
    ciphertext,
    PUSH_ASSOCIATED_DATA,
    nonce,
    key,
  );
  const length = padded.readUInt32BE(0);
  return {
    preview: JSON.parse(padded.subarray(4, 4 + length).toString('utf8')) as PushPreview,
    padded,
  };
}

function unwrapForDevice(envelope: Buffer, target = device): {
  generation: number;
  preview: PushPreview;
  padded: Buffer;
} {
  expect(envelope.subarray(0, PUSH_DEVICE_ENVELOPE_MAGIC.length))
    .toEqual(PUSH_DEVICE_ENVELOPE_MAGIC);
  const generation = envelope.readUInt32BE(PUSH_DEVICE_ENVELOPE_MAGIC.length);
  const keyLength = envelope.readUInt16BE(PUSH_DEVICE_ENVELOPE_MAGIC.length + 4);
  const keyStart = PUSH_DEVICE_ENVELOPE_MAGIC.length + 6;
  const keyEnd = keyStart + keyLength;
  const roomKey = openSealedBox(envelope.subarray(keyStart, keyEnd).toString('base64url'), target.keys.identity);
  return { generation, ...openForTest(envelope.subarray(keyEnd), roomKey) };
}

describe('push envelope', () => {
  it('redacts before truncating and roundtrips the 512-byte golden bucket', () => {
    const event: HumanPushEvent = {
      room: 'eng',
      msg_id: 42,
      kind: 'inbox',
      preview: `deploy sk-proj-${'a'.repeat(24)} ${'x'.repeat(180)}`,
      target_human_ids: ['owner'],
    };
    const preview = buildPushPreview(event);
    expect(preview.preview).toContain('[redacted]');
    expect(preview.preview).not.toContain('sk-proj-');
    expect([...preview.preview]).toHaveLength(120);
    const sealed = sealPushPreview(preview, crypto.roomKeys.roomKey('eng'));
    const opened = openForTest(sealed, crypto.roomKeys.roomKey('eng'));
    expect(opened.preview).toEqual(preview);
    expect(opened.padded).toHaveLength(PUSH_BUCKETS[0]);
    expect(sealed).toHaveLength(PUSH_BUCKETS[0] + PUSH_ENVELOPE_OVERHEAD);
  });

  it('uses the 2048 bucket when the encoded envelope does not fit 512 and stays under Web Push budget', () => {
    const preview: PushPreview = {
      room: `large-${'r'.repeat(600)}`,
      msg_id: 7,
      kind: 'stall',
      preview: 'known preview',
    };
    expect(paddedPushPreview(preview)).toHaveLength(PUSH_BUCKETS[1]);
    const sealed = sealPushPreview(preview, crypto.roomKeys.roomKey('eng'));
    expect(sealed).toHaveLength(PUSH_BUCKETS[1] + PUSH_ENVELOPE_OVERHEAD);
    expect(sealed.length).toBeLessThan(4_096);
    expect(openForTest(sealed, crypto.roomKeys.roomKey('eng')).preview).toEqual(preview);
  });
});

describe('PushProducer', () => {
  it('rejects an insecure non-local relay URL before any notification is queued', () => {
    expect(() => new PushProducer({
      relayUrl: 'http://relay.example.test',
      identity: crypto.keys.identity,
      roomKeys: crypto.roomKeys,
      subscriptions,
    })).toThrow('relay_url must use https except on localhost');
  });

  it('makes no relay request when relay_url is absent', async () => {
    const request = vi.fn<typeof fetch>();
    const producer = new PushProducer({
      identity: crypto.keys.identity,
      roomKeys: crypto.roomKeys,
      subscriptions,
      fetch: request,
    });
    expect(await producer.notify({
      room: 'eng', msg_id: 1, kind: 'inbox', preview: 'hello', target_human_ids: ['owner'],
    })).toEqual([{ status: 'disabled' }]);
    expect(request).not.toHaveBeenCalled();
  });

  it('seals, canonically signs, and posts one request per active paired subscription', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const request = vi.fn<typeof fetch>(async (input, init) => {
      captured.url = String(input);
      captured.init = init;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    const producer = new PushProducer({
      relayUrl: 'http://127.0.0.1:8787/base/',
      identity: crypto.keys.identity,
      roomKeys: crypto.roomKeys,
      subscriptions,
      fetch: request,
      now: () => 1_752_163_200_000,
      ttl: 45,
    });
    const results = await producer.notify({
      room: 'eng', msg_id: 9, kind: 'approval', preview: 'Approve release?', target_human_ids: ['owner'],
    });
    expect(results).toEqual([
      expect.objectContaining({ status: 'sent', http_status: 202 }),
    ]);
    expect(captured.url).toBe('http://127.0.0.1:8787/base/notify');
    const headers = captured.init!.headers as Record<string, string>;
    const body = JSON.parse(String(captured.init!.body)) as {
      subscription: typeof subscription;
      sealed: string;
      ttl: number;
    };
    verifyNotifySignature(body, {
      sender: headers['x-codor-sender']!,
      timestamp: headers['x-codor-timestamp']!,
      signature: headers['x-codor-signature']!,
    }, {
      allowedSenders: new Set([crypto.keys.identity.sign_public_key]),
      openMode: false,
    }, 1_752_163_200_000);
    const envelope = Buffer.from(body.sealed, 'base64');
    const opened = unwrapForDevice(envelope);
    expect(opened.preview).toEqual({
      room: 'eng', msg_id: 9, kind: 'approval', preview: 'Approve release?',
    });
    expect(envelope).toHaveLength(PUSH_BUCKETS[0] + PUSH_ENVELOPE_OVERHEAD + PUSH_DEVICE_ENVELOPE_OVERHEAD);
  });

  it('delivers a rotated room key only to each surviving device before its next push', async () => {
    const revoked = new CryptoVault(join(dir, 'revoked'));
    const revokedPeer = crypto.keys.enrollPeer({
      ...revoked.keys.publicIdentity(),
      kind: 'device',
      label: 'revoked browser',
    });
    crypto.roomKeys.enrollPeer(revokedPeer);
    crypto.revokePeer(revokedPeer.device_id);
    let delivered: Buffer | undefined;
    const producer = new PushProducer({
      relayUrl: 'https://relay.example.test',
      identity: crypto.keys.identity,
      roomKeys: crypto.roomKeys,
      subscriptions,
      fetch: async (_input, init) => {
        delivered = Buffer.from((JSON.parse(String(init?.body)) as { sealed: string }).sealed, 'base64');
        return new Response('{"accepted":true}', { status: 202 });
      },
    });

    await producer.notify({
      room: 'eng', msg_id: 11, kind: 'inbox', preview: 'after revoke', target_human_ids: ['owner'],
    });

    expect(delivered).toBeDefined();
    expect(unwrapForDevice(delivered!).generation).toBe(2);
    expect(unwrapForDevice(delivered!).preview.preview).toBe('after revoke');
    expect(() => unwrapForDevice(delivered!, revoked)).toThrow('sealed box was not addressed');
    revoked.close();
  });

  it('removes subscriptions that the relay reports as expired', async () => {
    const deviceId = subscriptions.list()[0]!.device_id;
    const producer = new PushProducer({
      relayUrl: 'https://relay.example.test',
      identity: crypto.keys.identity,
      roomKeys: crypto.roomKeys,
      subscriptions,
      fetch: async () => new Response('{"error":"subscription_expired"}', { status: 410 }),
    });
    expect((await producer.notify({
      room: 'eng', msg_id: 10, kind: 'stall', preview: 'stalled', target_human_ids: ['owner'],
    }))[0]).toMatchObject({ status: 'expired', device_id: deviceId });
    expect(subscriptions.list()).toEqual([]);
  });
});

describe('Daemon human push trigger allowlist', () => {
  it('reports failed background push deliveries through a sanitized diagnostic', async () => {
    const report = vi.fn();
    const fake = new FakeAdapter();
    const daemon = new Daemon({
      dbPath: join(dir, 'push-failure.sqlite'),
      blobRoot: join(dir, 'push-failure-blobs'),
      adapters: [fake],
      pushProducer: {
        notify: async () => [{ device_id: 'device-secret', status: 'failed', http_status: 502 }],
      },
      onBackgroundError: report,
    });
    daemon.createRoom({ id: 'failure', name: 'Failure', owner: { handle: 'richard', display_name: 'Richard' } });
    daemon.spawnMember('failure', { harness: 'fake', handle: 'alpha', cwd: dir });
    fake.enqueue({ kind: 'complete', final_text: '@richard result' });

    daemon.postHumanMessage('failure', '@alpha report');
    await daemon.settle();

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0]).toMatchObject({
      message: 'push delivery failed for 1 device(s): 502',
    });
    expect(report.mock.calls[0]![0].message).not.toContain('device-secret');
    await daemon.close();
  });

  it('fires for inbox, ask, brake hold, and stall but not ordinary system or manual holds', async () => {
    const events: HumanPushEvent[] = [];
    const notifier: HumanPushNotifier = {
      notify: async (event) => {
        events.push(event);
        return [];
      },
    };
    const fake = new FakeAdapter();
    const daemon = new Daemon({
      dbPath: join(dir, 'push-daemon.sqlite'),
      blobRoot: join(dir, 'push-blobs'),
      adapters: [fake],
      pushProducer: notifier,
    });
    daemon.createRoom({ id: 'push', name: 'Push', owner: { handle: 'richard', display_name: 'Richard' } });
    const owner = daemon.ownerOf('push');
    const alpha = daemon.spawnMember('push', { harness: 'fake', handle: 'alpha', cwd: dir });

    daemon.postSystemMessage('push', 'ordinary audit notice');
    fake.enqueue({ kind: 'complete', final_text: '@richard inbox result' });
    daemon.postHumanMessage('push', '@alpha report');
    await daemon.settle();

    fake.enqueue({
      kind: 'ask',
      card: { kind: 'ask', prompt: 'Choose?', options: [{ label: 'yes' }] },
      reply: () => '@richard answered',
    });
    daemon.postHumanMessage('push', '@alpha ask me');
    const pending = await waitFor(() => daemon.store.listInteractions('push', 'pending')[0]);
    await waitFor(() => events.find((event) => event.kind === 'ask'));
    await daemon.answerInteraction('push', pending.id, 'yes');
    await daemon.settle();

    // harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-push-regression
    fake.enqueue({
      kind: 'ask',
      card: { kind: 'approval', prompt: 'Allow deploy?', options: [{ label: 'Allow once' }] },
      reply: () => '@richard deployed',
    });
    daemon.postHumanMessage('push', '@alpha deploy');
    const approval = await waitFor(() => daemon.store.listInteractions('push', 'pending')
      .find((interaction) => interaction.kind === 'approval'));
    await waitFor(() => events.find((event) => event.kind === 'approval'));
    await daemon.answerInteraction('push', approval.id, 'Allow once');
    await daemon.settle();
    expect(events.filter((event) => event.kind === 'approval')).toHaveLength(1);
    expect(daemon.store.listDeliveries('push', { recipient: owner.id })
      .find((delivery) => delivery.message_id === approval.message_id)?.read_ts).toBeDefined();
    // harn:end approval-answer-is-atomic-and-chatless

    const heldMessage = daemon.store.postMessage('push', {
      author: owner.id, kind: 'chat', body: '@alpha held',
    });
    const brake = daemon.store.createDelivery('push', {
      message_id: heldMessage.id, recipient: alpha.id, state: 'queued',
    });
    daemon.holdDelivery('push', brake.id, 'turn brake before hop 4');
    const manual = daemon.store.createDelivery('push', {
      message_id: heldMessage.id, recipient: alpha.id, state: 'queued',
    });
    daemon.holdDelivery('push', manual.id, 'operator parked this manually');

    const running = daemon.store.postMessage('push', {
      author: alpha.id,
      kind: 'run',
      body: '',
      run: {
        status: 'running',
        started_ts: '2026-07-10T10:00:00.000Z',
        tool_calls: 0,
        events_ref: 'runs/stall.jsonl',
      },
    });
    daemon.checkStalls(new Date('2026-07-10T11:00:00.000Z'));
    await daemon.settle();

    expect(events.map((event) => event.kind)).toEqual([
      'inbox', 'ask', 'inbox', 'approval', 'inbox', 'hold', 'stall',
    ]);
    expect(events.find((event) => event.kind === 'hold')).toMatchObject({
      msg_id: heldMessage.id,
      delivery_id: brake.id,
      target_human_ids: [owner.id],
    });
    expect(events.find((event) => event.kind === 'stall')).toMatchObject({ msg_id: running.id });
    await daemon.close();
  });
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
