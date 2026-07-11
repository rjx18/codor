import sodium from 'sodium-native';

import type { DeviceKeyStore } from './keys.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSIONS_PER_DEVICE = 8;
const MAX_SESSIONS_TOTAL = 1_024;

export interface BrowserDeviceSession {
  access_token: string;
  device_id: string;
  expires_at: string;
}

interface StoredSession {
  deviceId: string;
  expiresAt: number;
}

function tokenDigest(token: string): string {
  const digest = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(digest, Buffer.from(token, 'utf8'));
  return digest.toString('base64url');
}

function randomToken(): string {
  const token = Buffer.alloc(32);
  sodium.randombytes_buf(token);
  return token.toString('base64url');
}

// harn:assume paired-browser-challenge-session ref=device-session-token-authority
/** Short-lived bearer sessions exist only after an enrolled device signs a fresh challenge. */
export class BrowserDeviceSessionAuthority {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly stopWatchingRevocation: () => void;

  constructor(
    private readonly keys: DeviceKeyStore,
    private readonly now: () => number = Date.now,
  ) {
    this.stopWatchingRevocation = keys.onPeerRevoked((deviceId) => this.revoke(deviceId));
  }

  issue(deviceId: string): BrowserDeviceSession {
    const peer = this.keys.getPeer(deviceId);
    if (peer?.kind !== 'device') throw new Error('browser sessions require an enrolled device');
    this.sweepExpired();
    this.trim((session) => session.deviceId === deviceId, MAX_SESSIONS_PER_DEVICE);
    this.trim(() => true, MAX_SESSIONS_TOTAL);
    const accessToken = randomToken();
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(tokenDigest(accessToken), { deviceId, expiresAt });
    return {
      access_token: accessToken,
      device_id: deviceId,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  authenticate(token: string): string | undefined {
    this.sweepExpired();
    const digest = tokenDigest(token);
    const session = this.sessions.get(digest);
    if (!session) return undefined;
    const peer = this.keys.getPeer(session.deviceId);
    if (peer?.kind !== 'device') {
      this.sessions.delete(digest);
      return undefined;
    }
    return session.deviceId;
  }

  revoke(deviceId: string): void {
    for (const [digest, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(digest);
    }
  }

  count(deviceId?: string): number {
    this.sweepExpired();
    return deviceId === undefined
      ? this.sessions.size
      : [...this.sessions.values()].filter((session) => session.deviceId === deviceId).length;
  }

  close(): void {
    this.stopWatchingRevocation();
    this.sessions.clear();
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(digest);
    }
  }

  private trim(matches: (session: StoredSession) => boolean, maximum: number): void {
    let count = [...this.sessions.values()].filter(matches).length;
    for (const [digest, session] of this.sessions) {
      if (count < maximum) return;
      if (!matches(session)) continue;
      this.sessions.delete(digest);
      count -= 1;
    }
  }
}
// harn:end paired-browser-challenge-session
