import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from './adapter.js';
import { createFakeCodexAppServer, createFakeCodexAppServerFactory } from './test-utils/fake-app-server.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// harn:assume codex-model-probe-is-native-bounded-and-read-only ref=native-model-probe
describe('native Codex model discovery', () => {
  it('coalesces pagination, filters hidden entries and inherits effective configuration without a turn', async () => {
    vi.stubEnv('CODEX_HOME', '/fixture/pinned-astra-config');
    const factory = createFakeCodexAppServerFactory();
    const server = createFakeCodexAppServer({
      'model/list': (params) => (params as { cursor: string | null }).cursor === null
        ? { data: [{ id: 'picker-astra', model: 'gpt-6-astra', hidden: false }, { model: 'hidden-model', hidden: true }], nextCursor: 'next' }
        : { data: [{ id: 'future/model' }, { model: 'gpt-6-astra', hidden: false }], nextCursor: null },
    });
    factory.enqueue(server);
    const adapter = new CodexAdapter({ appServerFactory: factory.factory });
    const first = adapter.listModels();
    expect(adapter.listModels()).toBe(first);
    expect(await first).toEqual({ models: ['gpt-6-astra', 'future/model'], source: 'discovered' });
    expect(factory.contexts).toHaveLength(1);
    expect(factory.contexts[0]?.env.CODEX_HOME).toBe('/fixture/pinned-astra-config');
    expect(factory.contexts[0]?.cwd).toBe(process.cwd());
    expect(server.messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(server.messages.filter((message) => message.method === 'model/list').map((message) => message.params)).toEqual([
      { cursor: null, limit: 100, includeHidden: false }, { cursor: 'next', limit: 100, includeHidden: false },
    ]);
    expect(server.child.killed).toBe(true);
    expect(server.child.signalCode).toBe('SIGTERM');
    server.assertNoErrors();
  });

  it('starts a fresh probe after completion and admits an honestly empty native list', async () => {
    const factory = createFakeCodexAppServerFactory();
    for (let index = 0; index < 2; index++) factory.enqueue(createFakeCodexAppServer({ 'model/list': () => ({ data: [], nextCursor: null }) }));
    const adapter = new CodexAdapter({ appServerFactory: factory.factory });
    expect(await adapter.listModels()).toEqual({ models: [], source: 'discovered' });
    await adapter.listModels();
    expect(factory.contexts).toHaveLength(2);
    expect(factory.servers.every((server) => server.child.killed)).toBe(true);
  });

  it.each(['unsupported', 'malformed', 'cycle'])('cleans up %s failures without inventing models', async (mode) => {
    const factory = createFakeCodexAppServerFactory();
    const server = createFakeCodexAppServer({ 'model/list': async () => {
      if (mode === 'unsupported') throw new Error('Method not found');
      return mode === 'malformed' ? { invalid: true } : { data: [], nextCursor: 'same' };
    } });
    factory.enqueue(server);
    await expect(new CodexAdapter({ appServerFactory: factory.factory }).listModels()).rejects.toThrow();
    expect(server.child.killed).toBe(true);
    expect(server.messages.some((message) => String(message.method).startsWith('turn/') || String(message.method).startsWith('thread/'))).toBe(false);
  });

  it('bounds a stalled request and terminates its owned child', async () => {
    vi.useFakeTimers();
    const factory = createFakeCodexAppServerFactory();
    const server = createFakeCodexAppServer({ 'model/list': () => new Promise(() => {}) });
    factory.enqueue(server);
    const failed = expect(new CodexAdapter({ appServerFactory: factory.factory, modelDiscoveryTimeoutMs: 25 }).listModels()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(25);
    await failed;
    expect(server.child.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates a stubborn child and confirms exit before resolving discovery', async () => {
    vi.useFakeTimers();
    const factory = createFakeCodexAppServerFactory();
    const server = createFakeCodexAppServer({ 'model/list': () => ({ data: [], nextCursor: null }) });
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') server.exit(null, 'SIGKILL');
      return true;
    });
    server.child.kill = kill; factory.enqueue(server);
    const pending = new CodexAdapter({ appServerFactory: factory.factory }).listModels();
    let finished = false; void pending.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(999); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(server.child.signalCode).toBe('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires a child whose asynchronous spawn completes after the deadline', async () => {
    vi.useFakeTimers();
    const server = createFakeCodexAppServer();
    let finish!: (child: typeof server.child) => void;
    const adapter = new CodexAdapter({ modelDiscoveryTimeoutMs: 25,
      appServerFactory: () => new Promise((resolve) => { finish = resolve; }) });
    const failed = expect(adapter.listModels()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(25); await failed;
    finish(server.child);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.child.killed).toBe(true);
    expect(server.messages).toEqual([]);
  });
});
// harn:end codex-model-probe-is-native-bounded-and-read-only
