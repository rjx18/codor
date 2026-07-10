import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { type DeviceKeyStore, privateJsonWrite } from '../crypto/keys.js';

export const WebPushSubscriptionSchema = z.strictObject({
  endpoint: z.url().refine((value) => new URL(value).protocol === 'https:', {
    message: 'push endpoint must use https',
  }),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
});

export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;

export interface DevicePushSubscription {
  device_id: string;
  subscription: WebPushSubscription;
  updated_at: string;
}

interface SubscriptionFile {
  version: 1;
  subscriptions: DevicePushSubscription[];
}

// harn:assume push-only-for-human-targeted-events ref=paired-device-subscriptions
export class PushSubscriptionStore {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly keys: DeviceKeyStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dataDir, 'crypto', 'push-subscriptions.json');
    if (!existsSync(this.path)) {
      privateJsonWrite(this.path, { version: 1, subscriptions: [] } satisfies SubscriptionFile);
    }
  }

  register(deviceId: string, input: unknown): DevicePushSubscription {
    const peer = this.keys.getPeer(deviceId);
    if (!peer || peer.kind !== 'device') throw new Error('push subscriptions require a paired device');
    const subscription = WebPushSubscriptionSchema.parse(input);
    const state = this.read();
    const record: DevicePushSubscription = {
      device_id: deviceId,
      subscription,
      updated_at: this.now().toISOString(),
    };
    const index = state.subscriptions.findIndex((item) => item.device_id === deviceId);
    if (index >= 0) state.subscriptions[index] = record;
    else state.subscriptions.push(record);
    this.write(state);
    return record;
  }

  remove(deviceId: string): boolean {
    const state = this.read();
    const next = state.subscriptions.filter((item) => item.device_id !== deviceId);
    if (next.length === state.subscriptions.length) return false;
    this.write({ version: 1, subscriptions: next });
    return true;
  }

  list(): DevicePushSubscription[] {
    return this.read().subscriptions.filter((record) => {
      const peer = this.keys.getPeer(record.device_id);
      return peer?.kind === 'device';
    });
  }

  get(deviceId: string): DevicePushSubscription | undefined {
    return this.list().find((record) => record.device_id === deviceId);
  }

  private read(): SubscriptionFile {
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as SubscriptionFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) {
      throw new Error('invalid push subscription file');
    }
    return {
      version: 1,
      subscriptions: parsed.subscriptions.map((record) => ({
        device_id: z.string().min(1).parse(record.device_id),
        subscription: WebPushSubscriptionSchema.parse(record.subscription),
        updated_at: z.iso.datetime().parse(record.updated_at),
      })),
    };
  }

  private write(state: SubscriptionFile): void {
    privateJsonWrite(this.path, state);
  }
}
// harn:end push-only-for-human-targeted-events
