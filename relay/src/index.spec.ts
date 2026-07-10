import { describe, expect, it } from 'vitest';

import { relayConfigFromEnv } from './index.js';

describe('relay environment', () => {
  it('fails closed without an allowlist or explicit open mode', () => {
    expect(() => relayConfigFromEnv({
      VAPID_SUBJECT: 'mailto:ops@example.com',
      VAPID_PUBLIC_KEY: 'public',
      VAPID_PRIVATE_KEY: 'private',
    })).toThrow('ALLOWED_SENDERS');
  });

  it('accepts explicit open mode and keeps VAPID values out of public config errors', () => {
    const config = relayConfigFromEnv({
      OPEN_MODE: 'true',
      PORT: '9000',
      VAPID_SUBJECT: 'mailto:ops@example.com',
      VAPID_PUBLIC_KEY: 'public',
      VAPID_PRIVATE_KEY: 'private',
    });
    expect(config.port).toBe(9000);
    expect(config.openMode).toBe(true);
    expect(config.allowedSenders.size).toBe(0);
  });
});
