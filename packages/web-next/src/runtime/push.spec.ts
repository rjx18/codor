import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CryptoVault, buildPushPreview, sealPushPreview } from '@codor/switchboard';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { enablePushNotifications } from './notifications.js';
import {
  cdpPushData,
  decodePushEventData,
  notificationTarget,
  openPushEnvelope,
} from './push.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('push subscription lifecycle', () => {
  it('replaces a subscription created for a rotated VAPID key', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscribe = vi.fn(async () => ({
      options: { applicationServerKey: Uint8Array.from([4, 5, 6]).buffer },
      toJSON: () => ({
        endpoint: 'https://push.example.test/current',
        expirationTime: null,
        keys: { p256dh: 'p256dh', auth: 'auth' },
      }),
    }));
    const existing = {
      options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
      unsubscribe,
      toJSON: () => ({}),
    };
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => existing, subscribe },
        }),
      },
    });
    vi.stubGlobal('window', { location: { origin: 'https://codor.example.test' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })));

    await enablePushNotifications({ deviceId: 'device', token: 'token', vapidPublicKey: 'BAUG' });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from([4, 5, 6]).buffer,
    });
  });
});

describe('service-worker push envelope opener', () => {
  it('opens the sodium-native producer envelope with libsodium-wrappers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-web-push-'));
    dirs.push(dir);
    const crypto = new CryptoVault(dir);
    crypto.roomKeys.ensureRoom('eng');
    const preview = buildPushPreview({
      room: 'eng',
      msg_id: 41,
      kind: 'hold',
      preview: 'release the held delivery',
      target_human_ids: ['owner'],
    });
    const sealed = sealPushPreview(preview, crypto.roomKeys.roomKey('eng'));
    const key = crypto.roomKeys.roomKey('eng').toString('base64url');
    expect(await openPushEnvelope(sealed, key)).toEqual(preview);
    const wrapped = new TextEncoder().encode(cdpPushData(sealed.toString('base64')));
    expect(decodePushEventData(wrapped)).toEqual(Uint8Array.from(sealed));
    expect(await openPushEnvelope(wrapped, key)).toEqual(preview);
    crypto.close();
  });

  it('rejects tampering, malformed lengths, and the wrong room key', async () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'codor-web-push-a-'));
    const secondDir = mkdtempSync(join(tmpdir(), 'codor-web-push-b-'));
    dirs.push(firstDir, secondDir);
    const first = new CryptoVault(firstDir);
    const second = new CryptoVault(secondDir);
    first.roomKeys.ensureRoom('eng');
    second.roomKeys.ensureRoom('eng');
    const sealed = sealPushPreview({ room: 'eng', msg_id: 1, kind: 'inbox', preview: 'hello' }, first.roomKeys.roomKey('eng'));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    await expect(openPushEnvelope(sealed, first.roomKeys.roomKey('eng').toString('base64url')))
      .rejects.toThrow();
    await expect(openPushEnvelope(Uint8Array.of(1, 2, 3), second.roomKeys.roomKey('eng').toString('base64url')))
      .rejects.toThrow('too short');
    first.close();
    second.close();
  });

  it('routes open and release actions through permanent room message ids', () => {
    const preview = {
      room: 'eng', msg_id: 99, kind: 'hold' as const, preview: 'held', delivery_id: 'delivery-99',
    };
    expect(notificationTarget(preview, 'open-room')).toBe(
      '/?room=eng&notification_action=mark_read&msg_id=99&delivery_id=delivery-99#99',
    );
    expect(notificationTarget(preview, 'release-hold')).toBe(
      '/?room=eng&notification_action=release_hold&msg_id=99&delivery_id=delivery-99#99',
    );
  });
});
