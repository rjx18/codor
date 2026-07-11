import { Bot } from 'grammy';
import type { BridgeTransport, ExternalBridgeMessage } from '@codor/bridge-core';
import type { Message } from '@codor/protocol';

export interface TelegramInboundEvent {
  chatId: string;
  messageId: string;
  text: string;
  senderName: string;
  bot?: boolean;
}

export interface TelegramGateway {
  onMessage(handler: (event: TelegramInboundEvent) => Promise<void>): void;
  post(chatId: string, text: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class GrammyTelegramGateway implements TelegramGateway {
  private readonly bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  onMessage(handler: (event: TelegramInboundEvent) => Promise<void>): void {
    this.bot.on('message:text', async (context) => {
      const sender = context.from;
      await handler({
        chatId: String(context.chat.id),
        messageId: String(context.message.message_id),
        text: context.message.text,
        senderName: [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || String(sender.id),
        bot: sender.is_bot,
      });
    });
  }

  async post(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.bot.start({ onStart: () => resolve() }).catch(reject);
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}

export class TelegramTransport implements BridgeTransport {
  readonly platform = 'telegram' as const;

  constructor(private readonly options: { chatId: string; gateway: TelegramGateway }) {}

  async start(receive: (message: ExternalBridgeMessage) => Promise<void>): Promise<void> {
    this.options.gateway.onMessage(async (event) => {
      if (event.chatId !== this.options.chatId || event.bot === true || event.text.trim() === '') return;
      await receive({
        externalId: event.messageId,
        senderName: event.senderName,
        body: event.text,
      });
    });
    await this.options.gateway.start();
  }

  async send(message: Message): Promise<void> {
    await this.options.gateway.post(this.options.chatId, message.body);
  }

  stop(): Promise<void> {
    return this.options.gateway.stop();
  }
}
