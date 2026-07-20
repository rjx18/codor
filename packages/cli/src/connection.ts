import { connect as netConnect } from 'node:net';

import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from '@codor/protocol';
import { isPipePath, localSocketPath } from '@codor/switchboard';
import WebSocket from 'ws';

export interface ProtocolClientOptions {
  dataDir: string;
  socketPath?: string;
  remoteUrl?: string;
  token?: string;
  timeoutMs?: number;
}

function transportUrl(options: ProtocolClientOptions): string {
  if (options.remoteUrl === undefined) {
    const socketPath = options.socketPath ?? localSocketPath(options.dataDir);
    // harn:assume member-env-selects-narrow-cli-identity ref=explicit-token-unix-transport
    const query = options.token === undefined ? '' : `?token=${encodeURIComponent(options.token)}`;
    const prefix = isPipePath(socketPath) ? 'ws+unix:///' : 'ws+unix://';
    return `${prefix}${socketPath}:/ws${query}`;
    // harn:end member-env-selects-narrow-cli-identity
  }
  if (!options.token) throw new Error('--token or CODOR_TOKEN is required with --url');
  const url = new URL(options.remoteUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('--url must use http(s) or ws(s)');
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.searchParams.set('token', options.token);
  return url.toString();
}

// harn:assume unix-socket-same-protocol ref=cli-protocol-transport
export class ProtocolClient {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private closedError: Error | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      this.frames.push(frame);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
    socket.on('error', (error) => {
      this.closedError = error;
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
    socket.on('close', (code, reason) => {
      this.closedError ??= new Error(`connection closed (${code} ${reason.toString()})`);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
  }

  static async connect(options: ProtocolClientOptions): Promise<ProtocolClient> {
    const socketPath = options.socketPath ?? localSocketPath(options.dataDir);
    const wsOptions: WebSocket.ClientOptions = {};
    if (isPipePath(socketPath)) {
      wsOptions.createConnection = (opts) => {
        if (typeof opts === 'object' && opts !== null) {
          const socketOpts = opts as Record<string, any>;
          if (typeof socketOpts.socketPath === 'string' && socketOpts.socketPath.startsWith('/')) {
            socketOpts.socketPath = socketOpts.socketPath.substring(1);
          }
          if (typeof socketOpts.path === 'string' && socketOpts.path.startsWith('/')) {
            socketOpts.path = socketOpts.path.substring(1);
          }
        }
        return netConnect(opts as any);
      };
    }
    const socket = new WebSocket(transportUrl(options), wsOptions);
    const timeoutMs = options.timeoutMs ?? 5_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('connection timed out'));
      }, timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new ProtocolClient(socket);
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(ClientFrameSchema.parse(frame)));
  }

  async next(timeoutMs = 5_000): Promise<ServerFrame> {
    if (this.cursor < this.frames.length) return this.frames[this.cursor++]!;
    if (this.closedError) throw this.closedError;
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(new Error('timed out waiting for server frame'));
      }, timeoutMs);
      this.waiters.add(wake);
    });
    if (this.cursor < this.frames.length) return this.frames[this.cursor++]!;
    throw this.closedError ?? new Error('connection closed');
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}
// harn:end unix-socket-same-protocol
