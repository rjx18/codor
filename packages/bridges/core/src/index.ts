import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BridgeOrigin, Member, Message } from '@wireroom/protocol';

export type BridgePlatform = 'slack' | 'telegram';

export interface ExternalBridgeMessage {
  externalId: string;
  senderName: string;
  body: string;
}

export interface BridgeTransport {
  readonly platform: BridgePlatform;
  start(receive: (message: ExternalBridgeMessage) => Promise<void>): Promise<void>;
  send(message: Message): Promise<void>;
  stop(): Promise<void>;
}

export interface BridgeApi {
  enable(input: {
    room: string;
    platform: BridgePlatform;
    channel: string;
  }): Promise<{ member: Member; after: number }>;
  ingress(input: {
    room: string;
    memberId: string;
    body: string;
    origin: BridgeOrigin;
  }): Promise<{ message: Message; deduped: boolean }>;
  outbound(input: {
    room: string;
    memberId: string;
    after: number;
  }): Promise<{ messages: Message[]; nextAfter: number }>;
}

export interface BridgeRuntimeState {
  cursor?: number;
  pendingIngress: ExternalBridgeMessage[];
}

export interface BridgeStateStore {
  load(): Promise<BridgeRuntimeState>;
  save(state: BridgeRuntimeState): Promise<void>;
}

export class MemoryBridgeStateStore implements BridgeStateStore {
  private state: BridgeRuntimeState = { pendingIngress: [] };

  async load(): Promise<BridgeRuntimeState> {
    return structuredClone(this.state);
  }

  async save(state: BridgeRuntimeState): Promise<void> {
    this.state = structuredClone(state);
  }
}

function validExternalMessage(value: unknown): value is ExternalBridgeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.externalId === 'string' && item.externalId !== '' &&
    typeof item.senderName === 'string' && item.senderName !== '' &&
    typeof item.body === 'string' && item.body !== '';
}

export class JsonBridgeStateStore implements BridgeStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BridgeRuntimeState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      const cursor = Number.isSafeInteger(parsed.cursor) && Number(parsed.cursor) >= 0
        ? Number(parsed.cursor)
        : undefined;
      const pendingIngress = Array.isArray(parsed.pendingIngress)
        ? parsed.pendingIngress.filter(validExternalMessage)
        : [];
      return { ...(cursor !== undefined && { cursor }), pendingIngress };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pendingIngress: [] };
      throw error;
    }
  }

  async save(state: BridgeRuntimeState): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`switchboard bridge request failed (${String(response.status)}): ${detail}`);
  }
  return response.json() as Promise<T>;
}

export class HttpBridgeApi implements BridgeApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    if (this.baseUrl === '' || this.token === '') throw new Error('bridge base URL and token are required');
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  }

  async enable(input: {
    room: string;
    platform: BridgePlatform;
    channel: string;
  }): Promise<{ member: Member; after: number }> {
    return responseJson(await this.request(`/api/rooms/${encodeURIComponent(input.room)}/bridges`, {
      method: 'POST',
      body: JSON.stringify({ platform: input.platform, channel: input.channel }),
    }));
  }

  async ingress(input: {
    room: string;
    memberId: string;
    body: string;
    origin: BridgeOrigin;
  }): Promise<{ message: Message; deduped: boolean }> {
    return responseJson(await this.request(
      `/api/rooms/${encodeURIComponent(input.room)}/bridges/${encodeURIComponent(input.memberId)}/messages`,
      { method: 'POST', body: JSON.stringify({ body: input.body, origin: input.origin }) },
    ));
  }

  async outbound(input: {
    room: string;
    memberId: string;
    after: number;
  }): Promise<{ messages: Message[]; nextAfter: number }> {
    const query = new URLSearchParams({ after: String(input.after) });
    const result = await responseJson<{ messages: Message[]; next_after: number }>(await this.request(
      `/api/rooms/${encodeURIComponent(input.room)}/bridges/${encodeURIComponent(input.memberId)}/outbound?${query.toString()}`,
    ));
    return { messages: result.messages, nextAfter: result.next_after };
  }
}

// harn:assume bridge-runtime-persists-delivery-progress ref=bridge-durable-progress
// harn:assume bridge-enable-admin-or-owner ref=bridge-runtime
export class BridgeRuntime {
  private memberId?: string;
  private cursor = 0;
  private started = false;
  private state: BridgeRuntimeState = { pendingIngress: [] };
  private stateWrites: Promise<void> = Promise.resolve();
  private ingressWork: Promise<void> = Promise.resolve();
  private readonly onError: (error: Error) => void;
  private readonly stateStore: BridgeStateStore;

  constructor(private readonly options: {
    api: BridgeApi;
    transport: BridgeTransport;
    room: string;
    channel: string;
    pollIntervalMs?: number;
    stateStore?: BridgeStateStore;
    onError?: (error: Error) => void;
  }) {
    this.stateStore = options.stateStore ?? new MemoryBridgeStateStore();
    this.onError = options.onError ?? ((error) => console.error(`bridge runtime: ${error.message}`));
  }

  private saveState(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const write = this.stateWrites.catch(() => undefined).then(() => this.stateStore.save(snapshot));
    this.stateWrites = write;
    return write;
  }

  private drainIngress(): Promise<void> {
    const drain = this.ingressWork.catch(() => undefined).then(async () => {
      if (!this.memberId) return;
      while (this.state.pendingIngress.length > 0) {
        const external = this.state.pendingIngress[0]!;
        try {
          await this.options.api.ingress({
            room: this.options.room,
            memberId: this.memberId,
            body: external.body,
            origin: {
              platform: this.options.transport.platform,
              external_id: external.externalId,
              sender_name: external.senderName,
            },
          });
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.state.pendingIngress.shift();
        await this.saveState();
      }
    });
    this.ingressWork = drain;
    return drain;
  }

  private enqueueIngress(external: ExternalBridgeMessage): Promise<void> {
    const enqueue = this.ingressWork.catch(() => undefined).then(async () => {
      if (!this.state.pendingIngress.some((item) => item.externalId === external.externalId)) {
        this.state.pendingIngress.push(external);
        await this.saveState();
      }
    });
    this.ingressWork = enqueue;
    return enqueue.then(() => this.drainIngress());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.state = await this.stateStore.load();
    const enabled = await this.options.api.enable({
      room: this.options.room,
      platform: this.options.transport.platform,
      channel: this.options.channel,
    });
    this.memberId = enabled.member.id;
    this.cursor = this.state.cursor ?? enabled.after;
    if (this.state.cursor === undefined) {
      this.state.cursor = this.cursor;
      await this.saveState();
    }
    await this.options.transport.start((external) => this.enqueueIngress(external));
    this.started = true;
    await this.drainIngress();
  }

  async pollOnce(): Promise<void> {
    if (!this.started || !this.memberId) throw new Error('bridge runtime is not started');
    await this.drainIngress();
    const batch = await this.options.api.outbound({
      room: this.options.room,
      memberId: this.memberId,
      after: this.cursor,
    });
    for (const message of batch.messages) {
      if (
        message.author === this.memberId &&
        message.origin?.platform === this.options.transport.platform
      ) continue;
      await this.options.transport.send(message);
      this.cursor = message.id;
      this.state.cursor = this.cursor;
      await this.saveState();
    }
    if (batch.nextAfter > this.cursor) {
      this.cursor = batch.nextAfter;
      this.state.cursor = this.cursor;
      await this.saveState();
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.start();
    try {
      while (!signal.aborted) {
        try {
          await this.pollOnce();
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, this.options.pollIntervalMs ?? 1_000);
          signal.addEventListener('abort', finish, { once: true });
        });
      }
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.transport.stop();
  }
}
// harn:end bridge-enable-admin-or-owner
// harn:end bridge-runtime-persists-delivery-progress
