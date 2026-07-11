import { BridgeRuntime, HttpBridgeApi } from '@wireroom/bridge-core';

import { BoltSlackGateway, SlackTransport } from './index.js';

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const channel = env('SLACK_CHANNEL_ID');
const runtime = new BridgeRuntime({
  api: new HttpBridgeApi({
    baseUrl: env('WIREROOM_URL'),
    token: env('WIREROOM_TOKEN'),
  }),
  transport: new SlackTransport({
    channel,
    gateway: new BoltSlackGateway({
      token: env('SLACK_BOT_TOKEN'),
      signingSecret: env('SLACK_SIGNING_SECRET'),
      appToken: env('SLACK_APP_TOKEN'),
      port: Number(process.env.PORT ?? 3001),
    }),
  }),
  room: env('WIREROOM_ROOM'),
  channel,
  onError: (error) => console.error(error.message),
});

await runtime.run(controller.signal);
