import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CryptoVault, buildPushPreview, sealPushPreview } from '@wireroom/switchboard';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cdpPushData,
  decodePushEventData,
  notificationTarget,
  openPushEnvelope,
} from './push.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('service-worker push envelope opener', () => {
  it('opens the sodium-native producer envelope with libsodium-wrappers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wireroom-web-push-'));
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
    const firstDir = mkdtempSync(join(tmpdir(), 'wireroom-web-push-a-'));
    const secondDir = mkdtempSync(join(tmpdir(), 'wireroom-web-push-b-'));
    dirs.push(firstDir, secondDir);
    const first = new CryptoVault(firstDir);
    const second = new CryptoVault(secondDir);
    first.roomKeys.ensureRoom('eng');
    second.roomKeys.ensureRoom('eng');
    const sealed = sealPushPreview({ room: 'eng', msg_id: 1, kind: 'inbox', preview: 'hello' }, first.roomKeys.roomKey('eng'));
    sealed[sealed.length - 1] ^= 1;
    await expect(openPushEnvelope(sealed, first.roomKeys.roomKey('eng').toString('base64url')))
      .rejects.toThrow();
    await expect(openPushEnvelope(Uint8Array.of(1, 2, 3), second.roomKeys.roomKey('eng').toString('base64url')))
      .rejects.toThrow('too short');
    first.close();
    second.close();
  });

  it('routes open and release actions through permanent room message ids', () => {
    const preview = { room: 'eng', msg_id: 99, kind: 'hold' as const, preview: 'held' };
    expect(notificationTarget(preview, 'open-room')).toBe('/?room=eng&notification_action=mark_read&msg_id=99#99');
    expect(notificationTarget(preview, 'release-hold')).toBe('/?room=eng&notification_action=release_hold&msg_id=99#99');
  });
});
