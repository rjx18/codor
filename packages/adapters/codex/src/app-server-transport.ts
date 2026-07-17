import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 8 * 1024;

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type CodexAppServerFactory = (
  context: CodexAppServerSpawnContext,
) => Promise<ChildProcessWithoutNullStreams>;

export type CodexAppServerNotificationHandler = (
  method: string,
  params: unknown,
) => void;

export type CodexAppServerRequestHandler = (
  params: unknown,
  requestId: number,
) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// harn:assume codex-app-server-contract-is-pinned-to-0-144-5 ref=codex-app-server-transport
/**
 * Spawn the installed Codex app-server without probing it. The app-server is
 * retained by the adapter, so its stdin remains open across turn/start calls.
 */
export function spawnCodexAppServer(
  context: CodexAppServerSpawnContext,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(context.command, ['app-server'], {
      cwd: context.cwd,
      env: context.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // stdin EOF on daemon exit is the final ownership boundary. Unlike the
      // old per-turn driver, interruption is an RPC and needs no process group.
      detached: false,
    });
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off('error', onError);
      resolve(child);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

/** Minimal JSONL JSON-RPC transport for Codex app-server 0.144.5. */
export class CodexAppServerClient {
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, CodexAppServerRequestHandler>();
  private notificationHandler: CodexAppServerNotificationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private closed = false;
  private stderrBuffer = '';

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly onClose: (error: Error) => void,
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => void this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', (error) => this.closeWith(error));
    child.stdout.on('error', (error) => this.closeWith(error));
    child.stderr.on('error', (error) => this.closeWith(error));
    child.on('error', (error) => this.closeWith(error));
    child.on('exit', (code, signal) => {
      const suffix = this.stderrBuffer.trim();
      const detail = `Codex app-server exited with code ${String(code)} and signal ${String(signal)}`;
      this.closeWith(new Error(suffix === '' ? detail : `${detail}\n${suffix}`));
    });
  }

  setNotificationHandler(handler: CodexAppServerNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: CodexAppServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.disposed) {
      return Promise.reject(new Error('Codex app-server client is closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params !== undefined && { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.disposed) throw new Error('Codex app-server client is closed');
    this.write({ method, ...(params !== undefined && { params }) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
    this.rejectPending(new Error('Codex app-server client was disposed'));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
  }

  stderr(): string {
    return this.stderrBuffer.trim();
  }

  private write(message: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      const handler = this.requestHandlers.get(message.method);
      if (handler === undefined) {
        this.write({
          id: message.id,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        });
        return;
      }
      try {
        const result = await handler(message.params, message.id);
        this.write({ id: message.id, result });
      } catch (error) {
        this.write({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(new Error(
          typeof message.error.message === 'string'
            ? message.error.message
            : 'Codex app-server request failed',
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      this.notificationHandler?.(message.method, message.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private closeWith(error: Error): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(error);
    this.onClose(error);
  }
}
// harn:end codex-app-server-contract-is-pinned-to-0-144-5
