import type { Message } from '@wireroom/protocol';
import { describe, expect, it } from 'vitest';

import {
  TelegramTransport,
  type TelegramGateway,
  type TelegramInboundEvent,
} from './index.js';

// harn:assume bridge-enable-admin-or-owner ref=bridge-platform-regression
describe('TelegramTransport', () => {
  it('maps one chat inbound, preserves references, and ignores bot echoes', async () => {
    let listener: ((event: TelegramInboundEvent) => Promise<void>) | undefined;
    const posted: { chatId: string; text: string }[] = [];
    const gateway: TelegramGateway = {
      onMessage: (next) => { listener = next; },
      post: async (chatId, text) => { posted.push({ chatId, text }); },
      start: async () => undefined,
      stop: async () => undefined,
    };
    const received: unknown[] = [];
    const transport = new TelegramTransport({ chatId: '-10022', gateway });
    await transport.start(async (message) => { received.push(message); });
    await listener!({ chatId: '-1', messageId: '1', text: 'wrong', senderName: 'A' });
    await listener!({ chatId: '-10022', messageId: '2', text: 'echo', senderName: 'Bot', bot: true });
    await listener!({ chatId: '-10022', messageId: '3', text: '@alpha read #7', senderName: 'Lea' });
    await transport.send({ body: 'Reviewed [[plan]]' } as Message);

    expect(received).toEqual([{ externalId: '3', senderName: 'Lea', body: '@alpha read #7' }]);
    expect(posted).toEqual([{ chatId: '-10022', text: 'Reviewed [[plan]]' }]);
  });
});
// harn:end bridge-enable-admin-or-owner
