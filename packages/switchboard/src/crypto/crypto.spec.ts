import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthenticatedConnectionRegistry,
  ChallengeAuthority,
  constantTimeEqual,
  hashTranscript,
  signChallenge,
} from './challenge.js';
import { BrowserDeviceSessionAuthority } from './browser-sessions.js';
import { CryptoVault, pairingUrl } from './pairing.js';
import { openSealedBox } from './roomkeys.js';

const roots: string[] = [];

function vault(label: string): CryptoVault {
  const root = mkdtempSync(join(tmpdir(), `wireroom-${label}-`));
  roots.push(root);
  return new CryptoVault(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('device identity, pairing, challenge auth, and room keys', () => {
  it('persists separate Ed25519 and X25519 identities across first-run restarts', () => {
    const first = vault('identity');
    const root = first.dataDir;
    const identity = first.keys.identity;
    expect(identity.device_id).toBe(identity.sign_public_key);
    expect(identity.sign_public_key).not.toBe(identity.encryption_public_key);
    first.close();

    const restarted = new CryptoVault(root);
    expect(restarted.keys.identity).toEqual(identity);
    restarted.close();
  });

  it('pairs both public keys over a single-use ten-minute offer and stores each side', () => {
    const home = vault('home');
    const outpost = vault('outpost');
    home.roomKeys.ensureRoom('eng');

    const offer = home.pairing.issue('http://127.0.0.1:8137');
    expect(Date.parse(offer.expires_at) - Date.now()).toBeGreaterThan(9 * 60 * 1_000);
    expect(pairingUrl(offer)).toContain('/pair?');
    const result = home.pairing.complete(offer.pairing_token, {
      ...outpost.keys.publicIdentity(),
      kind: 'switchboard',
      label: 'lab',
    });
    outpost.pairing.accept(result, 'desk');

    expect(home.keys.getPeer(outpost.keys.identity.device_id)).toMatchObject({
      sign_public_key: outpost.keys.identity.sign_public_key,
      encryption_public_key: outpost.keys.identity.encryption_public_key,
      kind: 'switchboard',
    });
    expect(outpost.keys.getPeer(home.keys.identity.device_id)).toMatchObject({ kind: 'switchboard' });
    expect(openSealedBox(result.room_keys[0]!.sealed_key, outpost.keys.identity)).toEqual(
      home.roomKeys.roomKey('eng'),
    );
    expect(() => home.pairing.complete(offer.pairing_token, {
      ...outpost.keys.publicIdentity(),
      kind: 'switchboard',
    })).toThrow('already-used');
    home.close();
    outpost.close();
  });

  it('trusted device enrollment reuses ordinary peer and room-key enrollment', () => {
    const home = vault('trusted-home');
    const device = vault('trusted-device');
    home.roomKeys.ensureRoom('eng');
    const result = home.pairing.completeTrusted({
      ...device.keys.publicIdentity(),
      kind: 'device',
      label: 'client supplied',
    }, 'operator@example.com');
    expect(home.keys.getPeer(device.keys.identity.device_id)).toMatchObject({
      kind: 'device',
      label: 'operator@example.com',
    });
    expect(result.room_keys).toHaveLength(1);
    expect(() => home.pairing.completeTrusted({
      ...device.keys.publicIdentity(),
      kind: 'switchboard',
    }, 'operator@example.com')).toThrow('only for browser devices');
    home.close();
    device.close();
  });

  it('accepts a transcript-bound Ed25519 signature and rejects forgery and replay', () => {
    const home = vault('auth-home');
    const peer = vault('auth-peer');
    const forger = vault('auth-forger');
    const offer = home.pairing.issue('http://localhost:8137');
    home.pairing.complete(offer.pairing_token, {
      ...peer.keys.publicIdentity(),
      kind: 'device',
    });
    const transcript = hashTranscript(Buffer.from('noise transcript'));

    const forgedChallenge = home.challenges.issue(peer.keys.identity.device_id, transcript);
    const forged = signChallenge(forgedChallenge, forger.keys.identity);
    expect(() => home.challenges.verify(forgedChallenge.challenge_id, forged)).toThrow(
      'invalid challenge signature',
    );

    const challenge = home.challenges.issue(peer.keys.identity.device_id, transcript);
    const signature = signChallenge(challenge, peer.keys.identity);
    expect(home.challenges.verify(challenge.challenge_id, signature).device_id).toBe(
      peer.keys.identity.device_id,
    );
    expect(() => home.challenges.verify(challenge.challenge_id, signature)).toThrow(
      'already-consumed',
    );
    const transportChallenge = home.challenges.issue(peer.keys.identity.device_id, transcript);
    for (let index = 0; index < 32; index++) {
      home.browserChallenges.issue(peer.keys.identity.device_id, transcript);
    }
    expect(home.challenges.verify(
      transportChallenge.challenge_id,
      signChallenge(transportChallenge, peer.keys.identity),
    ).device_id).toBe(peer.keys.identity.device_id);
    let now = Date.now();
    const expiring = new ChallengeAuthority(home.keys, () => now);
    const expired = expiring.issue(peer.keys.identity.device_id, transcript);
    now += 31_000;
    expect(() => expiring.verify(expired.challenge_id, signChallenge(expired, peer.keys.identity)))
      .toThrow('challenge expired');
    const bounded = new ChallengeAuthority(home.keys, () => now);
    for (let index = 0; index < 32; index++) {
      bounded.issue(peer.keys.identity.device_id, transcript);
    }
    expect(bounded.pendingCount(peer.keys.identity.device_id)).toBe(8);
    now += 31_000;
    expect(bounded.pendingCount()).toBe(0);
    expect(constantTimeEqual('auth-secret', 'auth-secret')).toBe(true);
    expect(constantTimeEqual('wrong', 'auth-secret')).toBe(false);
    home.close();
    peer.close();
    forger.close();
  });

  it('bounds device sessions and invalidates every bearer on peer revocation', () => {
    const home = vault('browser-session-home');
    const device = vault('browser-session-device');
    const offer = home.pairing.issue('http://localhost:8137');
    home.pairing.complete(offer.pairing_token, {
      ...device.keys.publicIdentity(),
      kind: 'device',
    });
    let now = Date.now();
    const sessions = new BrowserDeviceSessionAuthority(home.keys, () => now);
    const first = sessions.issue(device.keys.identity.device_id);
    expect(sessions.authenticate(first.access_token)).toBe(device.keys.identity.device_id);
    for (let index = 0; index < 12; index++) sessions.issue(device.keys.identity.device_id);
    expect(sessions.count(device.keys.identity.device_id)).toBe(8);
    now += 25 * 60 * 60 * 1_000;
    expect(sessions.count()).toBe(0);
    const revoked = sessions.issue(device.keys.identity.device_id);
    home.revokePeer(device.keys.identity.device_id);
    expect(sessions.authenticate(revoked.access_token)).toBeUndefined();
    sessions.close();
    home.close();
    device.close();
  });

  it('revokes, rotates every room, excludes the old device, and drops its live connection', async () => {
    const home = vault('revoke-home');
    const oldDevice = vault('revoke-old');
    const remaining = vault('revoke-remaining');
    home.roomKeys.ensureRoom('eng');
    home.roomKeys.ensureRoom('ops');
    for (const [device, label] of [[oldDevice, 'old'], [remaining, 'remaining']] as const) {
      const offer = home.pairing.issue('http://localhost:8137');
      home.pairing.complete(offer.pairing_token, {
        ...device.keys.publicIdentity(),
        kind: 'device',
        label,
      });
    }
    const oldGenerations = ['eng', 'ops'].map((room) => home.roomKeys.roomGeneration(room));
    const registry = new AuthenticatedConnectionRegistry(home.keys);
    let closeReason: string | undefined;
    registry.add({
      id: 'live-old-device',
      peer: home.keys.getPeer(oldDevice.keys.identity.device_id)!,
      close: (reason) => { closeReason = reason; },
    });

    const cliProcess = new CryptoVault(home.dataDir);
    cliProcess.revokePeer('old');
    for (let attempt = 0; attempt < 50 && closeReason === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(closeReason).toBe('peer revoked');
    expect(registry.has('live-old-device')).toBe(false);
    expect(home.keys.getPeer(oldDevice.keys.identity.device_id)).toBeUndefined();
    expect(home.roomKeys.sealedFor(oldDevice.keys.identity.device_id)).toEqual([]);
    expect(home.roomKeys.sealedFor(remaining.keys.identity.device_id)).toHaveLength(2);
    expect(['eng', 'ops'].map((room) => home.roomKeys.roomGeneration(room))).toEqual(
      oldGenerations.map((generation) => generation + 1),
    );
    const remainingBox = home.roomKeys.sealedFor(remaining.keys.identity.device_id)[0]!;
    expect(() => openSealedBox(remainingBox.sealed_key, oldDevice.keys.identity)).toThrow(
      'not addressed',
    );
    registry.close();
    cliProcess.close();
    home.close();
    oldDevice.close();
    remaining.close();
  });
});
