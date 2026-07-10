import webPush, {
  type PushSubscription,
  type SendResult,
} from 'web-push';

export interface PushSender {
  send(subscription: PushSubscription, sealed: Buffer, ttl: number): Promise<SendResult | void>;
}

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export class PushDeliveryError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }

  get expiredSubscription(): boolean {
    return this.statusCode === 404 || this.statusCode === 410;
  }
}

export class WebPushSender implements PushSender {
  constructor(private readonly vapid: VapidConfig) {}

  async send(subscription: PushSubscription, sealed: Buffer, ttl: number): Promise<SendResult> {
    try {
      return await webPush.sendNotification(subscription, sealed, {
        TTL: ttl,
        contentEncoding: 'aes128gcm',
        urgency: 'high',
        vapidDetails: {
          subject: this.vapid.subject,
          publicKey: this.vapid.publicKey,
          privateKey: this.vapid.privateKey,
        },
      });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : undefined;
      throw new PushDeliveryError('push service rejected the notification', statusCode);
    }
  }
}
