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

// harn:assume bridge-enable-admin-or-owner ref=bridge-runtime
export class BridgeRuntime {
  private memberId?: string;
  private cursor = 0;
  private started = false;
  private readonly onError: (error: Error) => void;

  constructor(private readonly options: {
    api: BridgeApi;
    transport: BridgeTransport;
    room: string;
    channel: string;
    pollIntervalMs?: number;
    onError?: (error: Error) => void;
  }) {
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const enabled = await this.options.api.enable({
      room: this.options.room,
      platform: this.options.transport.platform,
      channel: this.options.channel,
    });
    this.memberId = enabled.member.id;
    this.cursor = enabled.after;
    await this.options.transport.start(async (external) => {
      try {
        await this.options.api.ingress({
          room: this.options.room,
          memberId: enabled.member.id,
          body: external.body,
          origin: {
            platform: this.options.transport.platform,
            external_id: external.externalId,
            sender_name: external.senderName,
          },
        });
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.started = true;
  }

  async pollOnce(): Promise<void> {
    if (!this.started || !this.memberId) throw new Error('bridge runtime is not started');
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
    }
    this.cursor = batch.nextAfter;
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
