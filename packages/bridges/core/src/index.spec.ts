import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Member, Message } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  BridgeRuntime,
  HttpBridgeApi,
  JsonBridgeStateStore,
  MemoryBridgeStateStore,
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

// harn:assume bridge-runtime-persists-delivery-progress ref=bridge-durable-regression
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

  it('persists each successful outbound prefix and resumes from it after restart', async () => {
    const stateStore = new MemoryBridgeStateStore();
    const requestedAfter: number[] = [];
    const api: BridgeApi = {
      enable: async () => ({ member: bridge, after: 4 }),
      ingress: async () => ({ message: message(1), deduped: false }),
      outbound: async ({ after }) => {
        requestedAfter.push(after);
        return {
          messages: [message(5), message(6)].filter((item) => item.id > after),
          nextAfter: 6,
        };
      },
    };
    let failSix = true;
    const firstSent: number[] = [];
    const firstTransport: BridgeTransport = {
      platform: 'slack',
      start: async () => undefined,
      send: async (item) => {
        if (item.id === 6 && failSix) throw new Error('rate limited');
        firstSent.push(item.id);
      },
      stop: async () => undefined,
    };
    const first = new BridgeRuntime({
      api, transport: firstTransport, room: 'eng', channel: 'C123', stateStore,
    });
    await first.start();
    await expect(first.pollOnce()).rejects.toThrow('rate limited');
    await first.stop();
    expect(firstSent).toEqual([5]);
    expect((await stateStore.load()).cursor).toBe(5);

    failSix = false;
    const secondSent: number[] = [];
    const second = new BridgeRuntime({
      api: { ...api, enable: async () => ({ member: bridge, after: 99 }) },
      transport: { ...firstTransport, send: async (item) => { secondSent.push(item.id); } },
      room: 'eng',
      channel: 'C123',
      stateStore,
    });
    await second.start();
    await second.pollOnce();
    expect(requestedAfter).toEqual([4, 5]);
    expect(secondSent).toEqual([6]);
    expect((await stateStore.load()).cursor).toBe(6);
  });

  it('persists failed ingress before returning and retries it on the next poll', async () => {
    const stateStore = new MemoryBridgeStateStore();
    let receive: ((value: ExternalBridgeMessage) => Promise<void>) | undefined;
    let attempts = 0;
    const errors: string[] = [];
    const api: BridgeApi = {
      enable: async () => ({ member: bridge, after: 0 }),
      ingress: async (input) => {
        attempts++;
        if (attempts === 1) throw new Error('switchboard unavailable');
        return { message: message(1, bridge.id, input.origin), deduped: false };
      },
      outbound: async ({ after }) => ({ messages: [], nextAfter: after }),
    };
    const runtime = new BridgeRuntime({
      api,
      transport: {
        platform: 'slack',
        start: async (next) => { receive = next; },
        send: async () => undefined,
        stop: async () => undefined,
      },
      room: 'eng',
      channel: 'C123',
      stateStore,
      onError: (error) => errors.push(error.message),
    });
    await runtime.start();
    await receive!({ externalId: '171.42', senderName: 'Sarah', body: 'Retry me' });
    expect((await stateStore.load()).pendingIngress).toHaveLength(1);
    await runtime.pollOnce();
    expect(attempts).toBe(2);
    expect(errors).toEqual(['switchboard unavailable']);
    expect((await stateStore.load()).pendingIngress).toEqual([]);
  });
});

describe('bridge state and HTTP boundary', () => {
  it('roundtrips private JSON state with a 0600 file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codor-bridge-state-'));
    try {
      const path = join(dir, 'nested', 'state.json');
      const store = new JsonBridgeStateStore(path);
      await store.save({
        cursor: 12,
        pendingIngress: [{ externalId: '3', senderName: 'Lea', body: 'Pending' }],
      });
      await expect(store.load()).resolves.toEqual({
        cursor: 12,
        pendingIngress: [{ externalId: '3', senderName: 'Lea', body: 'Pending' }],
      });
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ cursor: 12 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps the authenticated HTTP contract and surfaces non-success responses', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/bridges')) {
        return new Response(JSON.stringify({ member: bridge, after: 4 }), { status: 201 });
      }
      if (url.includes('/outbound?')) {
        return new Response(JSON.stringify({ messages: [message(5)], next_after: 5 }));
      }
      if (url.includes('/messages')) {
        return new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const api = new HttpBridgeApi({ baseUrl: 'http://127.0.0.1:8137/', token: 'secret', fetch: fetcher });
    await expect(api.enable({ room: 'eng/a', platform: 'slack', channel: 'C123' }))
      .resolves.toMatchObject({ after: 4 });
    await expect(api.outbound({ room: 'eng/a', memberId: bridge.id, after: 4 }))
      .resolves.toMatchObject({ nextAfter: 5, messages: [{ id: 5 }] });
    await expect(api.ingress({
      room: 'eng/a', memberId: bridge.id, body: 'No',
      origin: { platform: 'slack', external_id: '1', sender_name: 'Sarah' },
    })).rejects.toThrow('403');
    expect(requests[0]!.url).toContain('/api/rooms/eng%2Fa/bridges');
    expect(requests[1]!.url).toContain(`/${bridge.id}/outbound?after=4`);
    expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe('Bearer secret');
  });
});
// harn:end bridge-runtime-persists-delivery-progress
