import type { Member, Message } from '@wireroom/protocol';
import { describe, expect, it } from 'vitest';

import {
  BridgeRuntime,
  type BridgeApi,
  type BridgeTransport,
  type ExternalBridgeMessage,
} from './index.js';

const bridge = {
  id: '01KX80N5NPNF485M2HS6HV3WK5',
  kind: 'bridge',
  handle: 'slack-bridge',
  display_name: 'Slack · C123',
  conventions_sent: false,
  misaddressed: false,
} satisfies Member;

const message = (id: number, author = 'local-human', origin?: Message['origin']): Message => ({
  id,
  room: 'eng',
  author,
  kind: 'chat',
  body: `message ${String(id)}`,
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: '2026-07-11T00:00:00.000Z',
  seq: id,
  ...(origin && { origin }),
});

describe('BridgeRuntime', () => {
  it('posts retried inbound events with a stable origin and suppresses its own outbound echo', async () => {
    const ingress: Parameters<BridgeApi['ingress']>[0][] = [];
    const api: BridgeApi = {
      enable: async () => ({ member: bridge, after: 4 }),
      ingress: async (input) => {
        ingress.push(input);
        return { message: message(5, bridge.id, input.origin), deduped: ingress.length > 1 };
      },
      outbound: async () => ({
        messages: [
          message(5, bridge.id, { platform: 'slack', external_id: '171.42', sender_name: 'Sarah' }),
          message(6),
        ],
        nextAfter: 6,
      }),
    };
    let receive: ((value: ExternalBridgeMessage) => Promise<void>) | undefined;
    const sent: Message[] = [];
    const transport: BridgeTransport = {
      platform: 'slack',
      start: async (next) => { receive = next; },
      send: async (item) => { sent.push(item); },
      stop: async () => undefined,
    };
    const runtime = new BridgeRuntime({ api, transport, room: 'eng', channel: 'C123' });
    await runtime.start();
    const external = { externalId: '171.42', senderName: 'Sarah', body: 'Ship it' };
    await receive!(external);
    await receive!(external);
    await runtime.pollOnce();

    expect(ingress).toHaveLength(2);
    expect(ingress[0]!.origin).toEqual({
      platform: 'slack', external_id: '171.42', sender_name: 'Sarah',
    });
    expect(sent.map((item) => item.id)).toEqual([6]);
  });
});
