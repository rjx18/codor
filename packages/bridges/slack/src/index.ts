import { App } from '@slack/bolt';
import type { BridgeTransport, ExternalBridgeMessage } from '@wireroom/bridge-core';
import type { Message } from '@wireroom/protocol';

export interface SlackInboundEvent {
  channel: string;
  timestamp: string;
  text: string;
  senderName: string;
  bot?: boolean;
  subtype?: string;
}

export interface SlackGateway {
  onMessage(handler: (event: SlackInboundEvent) => Promise<void>): void;
  post(channel: string, text: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class BoltSlackGateway implements SlackGateway {
  private readonly app: App;

  constructor(options: {
    token: string;
    signingSecret: string;
    appToken: string;
    port?: number;
  }) {
    this.app = new App({
      token: options.token,
      signingSecret: options.signingSecret,
      appToken: options.appToken,
      socketMode: true,
    });
    this.port = options.port ?? 3001;
  }

  private readonly port: number;

  onMessage(handler: (event: SlackInboundEvent) => Promise<void>): void {
    this.app.event('message', async ({ event, client }) => {
      const item = event as {
        channel?: string;
        ts?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        subtype?: string;
      };
      if (!item.channel || !item.ts || !item.text) return;
      let senderName = item.user ?? 'Slack user';
      if (item.user) {
        try {
          const profile = await client.users.info({ user: item.user });
          senderName = profile.user?.profile?.display_name || profile.user?.real_name || senderName;
        } catch {
          // The stable user id remains a truthful fallback when profile lookup is unavailable.
        }
      }
      await handler({
        channel: item.channel,
        timestamp: item.ts,
        text: item.text,
        senderName,
        bot: item.bot_id !== undefined,
        subtype: item.subtype,
      });
    });
  }

  async post(channel: string, text: string): Promise<void> {
    await this.app.client.chat.postMessage({ channel, text });
  }

  async start(): Promise<void> {
    await this.app.start(this.port);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

export class SlackTransport implements BridgeTransport {
  readonly platform = 'slack' as const;

  constructor(private readonly options: { channel: string; gateway: SlackGateway }) {}

  async start(receive: (message: ExternalBridgeMessage) => Promise<void>): Promise<void> {
    this.options.gateway.onMessage(async (event) => {
      if (
        event.channel !== this.options.channel ||
        event.bot === true ||
        event.subtype !== undefined ||
        event.text.trim() === ''
      ) return;
      await receive({
        externalId: event.timestamp,
        senderName: event.senderName,
        body: event.text,
      });
    });
    await this.options.gateway.start();
  }

  async send(message: Message): Promise<void> {
    await this.options.gateway.post(this.options.channel, message.body);
  }

  stop(): Promise<void> {
    return this.options.gateway.stop();
  }
}
