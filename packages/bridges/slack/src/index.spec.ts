import type { Message } from '@wireroom/protocol';
import { describe, expect, it } from 'vitest';

import { SlackTransport, type SlackGateway, type SlackInboundEvent } from './index.js';

describe('SlackTransport', () => {
  it('maps one channel inbound and ignores bot echoes while posting outbound', async () => {
    let listener: ((event: SlackInboundEvent) => Promise<void>) | undefined;
    const posted: { channel: string; text: string }[] = [];
    const gateway: SlackGateway = {
      onMessage: (next) => { listener = next; },
      post: async (channel, text) => { posted.push({ channel, text }); },
      start: async () => undefined,
      stop: async () => undefined,
    };
    const received: unknown[] = [];
    const transport = new SlackTransport({ channel: 'C123', gateway });
    await transport.start(async (message) => { received.push(message); });
    await listener!({ channel: 'C999', timestamp: '1', text: 'wrong', senderName: 'A' });
    await listener!({ channel: 'C123', timestamp: '2', text: 'echo', senderName: 'Bot', bot: true });
    await listener!({ channel: 'C123', timestamp: '3', text: '@alpha ship [[plan]]', senderName: 'Sarah' });
    await transport.send({ body: 'Done #4', id: 4 } as Message);

    expect(received).toEqual([{ externalId: '3', senderName: 'Sarah', body: '@alpha ship [[plan]]' }]);
    expect(posted).toEqual([{ channel: 'C123', text: 'Done #4' }]);
  });
});
