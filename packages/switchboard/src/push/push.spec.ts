import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sodium from 'sodium-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyNotifySignature } from '../../../../relay/src/seal.js';
import { CryptoVault } from '../crypto/pairing.js';
import { Daemon } from '../daemon.js';
import { FakeAdapter } from '../fake-adapter.js';
import {
  buildPushPreview,
  paddedPushPreview,
  PUSH_BUCKETS,
  PUSH_ENVELOPE_OVERHEAD,
  PushProducer,
  sealPushPreview,
  type HumanPushEvent,
  type HumanPushNotifier,
  type PushPreview,
} from './producer.js';
import { PushSubscriptionStore } from './subscriptions.js';

const PUSH_ASSOCIATED_DATA = Buffer.from('wireroom-push-v1\0', 'utf8');

let dir: string;
let crypto: CryptoVault;
let subscriptions: PushSubscriptionStore;

const subscription = {
  endpoint: 'https://push.example.test/device',
  expirationTime: null,
  keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wireroom-push-'));
  crypto = new CryptoVault(dir);
  crypto.roomKeys.ensureRoom('eng');
  const device = new CryptoVault(join(dir, 'device'));
  const peer = crypto.keys.enrollPeer({
    ...device.keys.publicIdentity(),
    kind: 'device',
    label: 'browser',
  });
  crypto.roomKeys.enrollPeer(peer);
  subscriptions = new PushSubscriptionStore(dir, crypto.keys);
  subscriptions.register(peer.device_id, subscription);
  device.close();
});

afterEach(() => {
  crypto.close();
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
      sender: headers['x-wireroom-sender']!,
      timestamp: headers['x-wireroom-timestamp']!,
      signature: headers['x-wireroom-signature']!,
    }, {
      allowedSenders: new Set([crypto.keys.identity.sign_public_key]),
      openMode: false,
    }, 1_752_163_200_000);
    const opened = openForTest(Buffer.from(body.sealed, 'base64'), crypto.roomKeys.roomKey('eng'));
    expect(opened.preview).toEqual({
      room: 'eng', msg_id: 9, kind: 'approval', preview: 'Approve release?',
    });
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
    const alpha = daemon.spawnMember('push', { harness: 'fake', handle: 'alpha', cwd: '/work' });

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
      'inbox', 'ask', 'inbox', 'hold', 'stall',
    ]);
    expect(events.find((event) => event.kind === 'hold')).toMatchObject({
      msg_id: heldMessage.id,
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
