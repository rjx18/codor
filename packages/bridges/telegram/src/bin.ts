import { homedir } from 'node:os';
import { join } from 'node:path';

import { BridgeRuntime, HttpBridgeApi, JsonBridgeStateStore } from '@codor/bridge-core';

import { GrammyTelegramGateway, TelegramTransport } from './index.js';

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const chatId = env('TELEGRAM_CHAT_ID');
const room = env('CODOR_ROOM');
const statePath = process.env.CODOR_BRIDGE_STATE?.trim() || join(
  homedir(),
  '.codor',
  'bridges',
  `${room.replace(/[^a-zA-Z0-9._-]/g, '_')}-telegram.json`,
);
const runtime = new BridgeRuntime({
  api: new HttpBridgeApi({
    baseUrl: env('CODOR_URL'),
    token: env('CODOR_TOKEN'),
  }),
  transport: new TelegramTransport({
    chatId,
    gateway: new GrammyTelegramGateway(env('TELEGRAM_BOT_TOKEN')),
  }),
  room,
  channel: chatId,
  stateStore: new JsonBridgeStateStore(statePath),
  onError: (error) => console.error(error.message),
});

await runtime.run(controller.signal);
