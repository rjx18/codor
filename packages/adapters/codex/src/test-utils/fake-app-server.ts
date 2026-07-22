import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type {
  CodexAppServerFactory,
  CodexAppServerSpawnContext,
} from '../app-server-transport.js';

type JsonRecord = Record<string, unknown>;
type Handler = (params: unknown) => unknown | Promise<unknown>;

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

export interface FakeCodexAppServer {
  readonly child: FakeChild;
  readonly messages: JsonRecord[];
  readonly errors: Error[];
  notify(method: string, params?: unknown): void;
  request(method: string, params?: unknown): Promise<unknown>;
  waitForRequest(method: string, occurrence?: number): Promise<JsonRecord>;
  exit(code?: number | null, signal?: NodeJS.Signals | null, stderr?: string): void;
  assertNoErrors(): void;
}

export interface FakeCodexAppServerFactory {
  readonly factory: CodexAppServerFactory;
  readonly contexts: CodexAppServerSpawnContext[];
  readonly servers: FakeCodexAppServer[];
  enqueue(server: FakeCodexAppServer): void;
}

let nextPid = 41_000;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: nextPid++,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as FakeChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.killed) return false;
    const mutable = child as unknown as {
      killed: boolean;
      signalCode: NodeJS.Signals | null;
    };
    mutable.killed = true;
    queueMicrotask(() => {
      mutable.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
      child.emit('exit', null, mutable.signalCode);
    });
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

// harn:assume codex-app-server-contract-is-pinned-to-0-144-5 ref=codex-app-server-fake
export function createFakeCodexAppServer(
  handlers: Record<string, Handler> = {},
): FakeCodexAppServer {
  const child = fakeChild();
  const messages: JsonRecord[] = [];
  const errors: Error[] = [];
  const waiters = new Set<{
    predicate(message: JsonRecord): boolean;
    resolve(message: JsonRecord): void;
  }>();
  const responseHandlers: Record<string, Handler> = {
    initialize: () => ({}),
    'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }),
    'thread/resume': (params) => ({
      thread: { id: record(params).threadId },
      model: 'gpt-5.6-sol',
    }),
    'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } }),
    'turn/interrupt': () => ({}),
    ...handlers,
  };
  let input = '';
  let nextServerRequestId = 1000;
  const serverRequests = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  const processMessage = (message: JsonRecord): void => {
    messages.push(message);
    for (const waiter of Array.from(waiters)) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }

    if (typeof message.id === 'number' && typeof message.method !== 'string') {
      const pending = serverRequests.get(message.id);
      if (pending === undefined) return;
      serverRequests.delete(message.id);
      if (record(message.error).message !== undefined) {
        pending.reject(new Error(String(record(message.error).message)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id !== 'number' || typeof message.method !== 'string') return;
    const handler = responseHandlers[message.method];
    if (handler === undefined) {
      errors.push(new Error(`Unexpected Codex app-server request: ${message.method}`));
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { message: `Unexpected request: ${message.method}` },
      })}\n`);
      return;
    }
    void Promise.resolve(handler(message.params)).then(
      (result) => {
        if (!child.stdout.writableEnded) {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
      },
      (error) => {
        if (!child.stdout.writableEnded) {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          })}\n`);
        }
      },
    );
  };

  child.stdin.on('data', (chunk) => {
    input += chunk.toString();
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (line === '') continue;
      try {
        processMessage(record(JSON.parse(line)));
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  return {
    child,
    messages,
    errors,
    notify(method, params) {
      child.stdout.write(`${JSON.stringify({ method, ...(params !== undefined && { params }) })}\n`);
    },
    request(method, params) {
      const id = nextServerRequestId++;
      child.stdout.write(`${JSON.stringify({ id, method, ...(params !== undefined && { params }) })}\n`);
      return new Promise((resolve, reject) => serverRequests.set(id, { resolve, reject }));
    },
    waitForRequest(method, occurrence = 1) {
      const predicate = (message: JsonRecord) => message.method === method;
      const existing = messages.filter(predicate)[occurrence - 1];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${method} request ${occurrence}`));
        }, 1000);
        const waiter = {
          predicate: (message: JsonRecord) => {
            if (!predicate(message)) return false;
            return messages.filter(predicate).length >= occurrence;
          },
          resolve: (message: JsonRecord) => {
            clearTimeout(timer);
            resolve(message);
          },
        };
        waiters.add(waiter);
      });
    },
    exit(code = 1, signal = null, stderr = '') {
      if (stderr !== '') child.stderr.write(stderr);
      const mutable = child as unknown as {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      mutable.exitCode = code;
      mutable.signalCode = signal;
      child.emit('exit', code, signal);
      child.stdout.end();
      child.stderr.end();
    },
    assertNoErrors() {
      if (errors.length > 0) throw errors[0];
    },
  };
}

export function createFakeCodexAppServerFactory(): FakeCodexAppServerFactory {
  const contexts: CodexAppServerSpawnContext[] = [];
  const servers: FakeCodexAppServer[] = [];
  const queued: FakeCodexAppServer[] = [];
  return {
    contexts,
    servers,
    enqueue(server) {
      queued.push(server);
    },
    factory: async (context) => {
      contexts.push(context);
      const server = queued.shift() ?? createFakeCodexAppServer();
      servers.push(server);
      return server.child;
    },
  };
}
// harn:end codex-app-server-contract-is-pinned-to-0-144-5
