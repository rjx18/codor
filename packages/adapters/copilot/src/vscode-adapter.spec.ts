import { chmodSync, closeSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopilotVscodeAdapter, vscodeCopilotBridgeAvailable } from './vscode-adapter.js';

const roots: string[] = [];

interface TurnGate {
  before?: Promise<void>;
  afterStarted?: Promise<void>;
}

async function fixture(lines: unknown[] | unknown[][], options: { turnGates?: TurnGate[] } = {}): Promise<{
  adapter: CopilotVscodeAdapter;
  close(): Promise<void>;
  discovery: string;
  requests: Array<{ url: string; authorization?: string; body?: unknown }>;
}> {
  const root = join(tmpdir(), `codor-vscode-${process.pid}-${Date.now()}-${Math.random()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
  const scripted = Array.isArray(lines[0]) ? [...(lines as unknown[][])] : undefined;
  let turnNumber = 0;
  const token = 'a'.repeat(64);
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const source = Buffer.concat(chunks).toString('utf8');
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      ...(source !== '' && { body: JSON.parse(source) as unknown }),
    });
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply.statusCode = 401;
      reply.end();
      return;
    }
    if (request.url === '/v1/models') {
      reply.setHeader('content-type', 'application/json');
      reply.end(JSON.stringify({ models: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-4o-mini' }] }));
      return;
    }
    if (request.url === '/v1/turn') {
      const gate = options.turnGates?.[turnNumber];
      turnNumber += 1;
      if (gate?.before !== undefined) await gate.before;
      reply.setHeader('content-type', 'application/x-ndjson');
      const responseLines = scripted?.shift() ?? lines as unknown[];
      const [first, ...rest] = responseLines;
      if (gate?.afterStarted !== undefined && (first as { type?: unknown } | undefined)?.type === 'started') {
        reply.write(`${JSON.stringify(first)}\n`);
        await gate.afterStarted;
        reply.end(rest.map((line) => JSON.stringify(line)).join('\n'));
      } else {
        reply.end(responseLines.map((line) => JSON.stringify(line)).join('\n'));
      }
      return;
    }
    reply.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not listen');
  const discovery = join(root, 'bridge.json');
  const fd = openSync(discovery, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    protocol_version: 1,
    pid: process.pid,
    port: address.port,
    token,
    started_at: new Date().toISOString(),
  }));
  closeSync(fd);
  return {
    adapter: new CopilotVscodeAdapter(discovery),
    discovery,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-bridge-regression
// harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-adapter-regression
describe('VS Code Copilot adapter bridge', () => {
  it('discovers live models and maps the authenticated native stream without approval cards or round trips', async () => {
    const bridge = await fixture([
      { type: 'started', turn_id: 'turn-1' },
      { type: 'part', text_delta: 'hello' },
      {
        type: 'part',
        index: 1,
        part: {
          kind: 'toolInvocation',
          toolId: 'terminal',
          invocationMessage: 'Run tests',
          pastTenseMessage: 'Ran tests',
          state: { type: 'completed' },
        },
      },
      {
        type: 'done',
        result: { status: 'complete' },
        response: [{ value: 'hello' }],
      },
    ]);
    try {
      expect(await bridge.adapter.listModels()).toEqual({
        models: ['gpt-5.6-luna', 'gpt-4o-mini'],
        source: 'discovered',
      });
      const session = bridge.adapter.spawn({
        cwd: '/tmp',
        model: 'gpt-5.6-luna',
        policy: 'workspace-write',
      });
      const events = [];
      for await (const event of bridge.adapter.deliver(session, 'work')) events.push(event);
      expect(events).toContainEqual({
        type: 'run.item',
        item_type: 'text_delta',
        payload: { text: 'hello' },
      });
      expect(events.some((event) => event.type === 'approval.raised')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run.item',
        item_type: 'tool_call',
        payload: expect.objectContaining({ tool: 'terminal', title: 'Run tests' }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run.item',
        item_type: 'tool_result',
        payload: expect.objectContaining({ status: 'ok', output_text: 'Ran tests' }),
      }));
      expect(events.at(-1)).toEqual({
        type: 'run.completed',
        status: 'completed',
        final_text: 'hello',
      });
      expect(bridge.requests.some((request) => request.url.includes('/interaction'))).toBe(false);
      expect(bridge.requests.every((request) => request.authorization === `Bearer ${'a'.repeat(64)}`))
        .toBe(true);
      expect(JSON.stringify(events)).not.toContain('a'.repeat(64));
    } finally {
      await bridge.close();
    }
  });

  // harn:assume vscode-copilot-recoverable-native-failure-preserves-context ref=vscode-copilot-session-checkpoint-regression
  it('checkpoints a native partial failure and includes it in the next explicit delivery without replaying tools', async () => {
    const bridge = await fixture([
      [
        { type: 'started', turn_id: 'failed-turn' },
        { type: 'part', text_delta: 'partial answer' },
        {
          type: 'error', recoverable: true, message: 'native stop',
          response: [{ value: 'partial answer' }], assistant_text: 'partial answer',
        },
      ],
      [
        { type: 'started', turn_id: 'continued-turn' },
        { type: 'done', result: { status: 'complete' }, response: [{ value: 'continued' }] },
      ],
    ]);
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp', model: 'gpt-5.6-luna' });
      const failed = [];
      for await (const event of bridge.adapter.deliver(session, 'failed prompt')) failed.push(event);
      expect(failed.at(-1)).toEqual({
        type: 'run.completed', status: 'failed', error: 'native stop', recoverable: true,
      });
      expect((session as unknown as { failure_checkpoint?: unknown }).failure_checkpoint)
        .toMatchObject({ prompt: 'failed prompt', response: 'partial answer' });

      const continued = [];
      for await (const event of bridge.adapter.deliver(session, 'continue')) continued.push(event);
      expect(continued.at(-1)).toEqual({
        type: 'run.completed', status: 'completed', final_text: 'continued',
      });
      expect((session as unknown as { failure_checkpoint?: unknown }).failure_checkpoint).toBeUndefined();
      const turns = bridge.requests.filter((request) => request.url === '/v1/turn');
      expect(turns).toHaveLength(2);
      expect((turns[1]!.body as { history?: unknown[] }).history).toEqual([
        { role: 'user', text: 'failed prompt' },
        { role: 'assistant', text: 'partial answer' },
      ]);
      expect(bridge.requests.some((request) => request.url.includes('/interaction'))).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('keeps checkpoints isolated across adapter windows and rejects a changed bridge generation', async () => {
    const bridge = await fixture([
      [
        { type: 'started', turn_id: 'failed-a' },
        { type: 'error', recoverable: true, message: 'A stopped', response: [{ value: 'A partial' }], assistant_text: 'A partial' },
      ],
      [
        { type: 'started', turn_id: 'failed-b' },
        { type: 'error', recoverable: true, message: 'B stopped', response: [{ value: 'B partial' }], assistant_text: 'B partial' },
      ],
      [{ type: 'done', result: { status: 'complete' }, response: [{ value: 'A continued' }] }],
      [{ type: 'done', result: { status: 'complete' }, response: [{ value: 'B continued' }] }],
      [
        { type: 'started', turn_id: 'failed-c' },
        { type: 'error', recoverable: true, message: 'C stopped', response: [{ value: 'C partial' }], assistant_text: 'C partial' },
      ],
    ]);
    try {
      const otherWindow = new CopilotVscodeAdapter(bridge.discovery);
      const sessionA = bridge.adapter.spawn({ cwd: '/tmp' });
      const sessionB = otherWindow.spawn({ cwd: '/tmp' });
      for await (const _event of bridge.adapter.deliver(sessionA, 'prompt A')) { /* collect */ }
      for await (const _event of otherWindow.deliver(sessionB, 'prompt B')) { /* collect */ }
      for await (const _event of bridge.adapter.deliver(sessionA, 'continue A')) { /* collect */ }
      for await (const _event of otherWindow.deliver(sessionB, 'continue B')) { /* collect */ }
      const turns = bridge.requests.filter((request) => request.url === '/v1/turn');
      expect((turns[2]!.body as { history?: unknown[] }).history).toEqual([
        { role: 'user', text: 'prompt A' }, { role: 'assistant', text: 'A partial' },
      ]);
      expect((turns[3]!.body as { history?: unknown[] }).history).toEqual([
        { role: 'user', text: 'prompt B' }, { role: 'assistant', text: 'B partial' },
      ]);

      const sessionC = bridge.adapter.spawn({ cwd: '/tmp' });
      for await (const _event of bridge.adapter.deliver(sessionC, 'prompt C')) { /* collect */ }
      const beforeGenerationChange = bridge.requests.length;
      writeFileSync(bridge.discovery, JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        port: 1,
        token: 'b'.repeat(64),
        started_at: new Date(Date.now() + 1_000).toISOString(),
      }));
      const failed = [];
      for await (const event of bridge.adapter.deliver(sessionC, 'after generation change')) failed.push(event);
      expect(failed.at(-1)).toEqual(expect.objectContaining({
        type: 'run.completed', status: 'failed',
        error: expect.stringContaining('recoverable context was lost'),
      }));
      expect(failed.at(-1)).not.toHaveProperty('recoverable');
      expect(bridge.requests).toHaveLength(beforeGenerationChange);
    } finally {
      await bridge.close();
    }
  });

  it('keeps an unmarked bridge or protocol error terminal and does not create a checkpoint', async () => {
    const bridge = await fixture([{
      type: 'error', message: 'bridge protocol failure', recoverable: false,
    }]);
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp' });
      const events = [];
      for await (const event of bridge.adapter.deliver(session, 'protocol failure')) events.push(event);
      expect(events.at(-1)).toEqual({
        type: 'run.completed', status: 'failed', error: 'bridge protocol failure',
      });
      expect(events.at(-1)).not.toHaveProperty('recoverable');
      expect((session as unknown as { failure_checkpoint?: unknown }).failure_checkpoint).toBeUndefined();
    } finally {
      await bridge.close();
    }
  });
  // harn:end vscode-copilot-recoverable-native-failure-preserves-context

  // harn:assume context-reset-retirement-is-bounded-owned-and-confirmed ref=reset-retirement-regression
  it('refuses reset during pre-start and started native work without retiring the active session', async () => {
    let releasePreStart!: () => void;
    let releaseStarted!: () => void;
    const preStart = new Promise<void>((resolve) => { releasePreStart = resolve; });
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const bridge = await fixture([
      [
        { type: 'started', turn_id: 'pre-start-turn' },
        { type: 'done', result: { status: 'complete' }, response: [{ value: 'pre-start done' }] },
      ],
      [
        { type: 'started', turn_id: 'started-turn' },
        { type: 'done', result: { status: 'complete' }, response: [{ value: 'started done' }] },
      ],
    ], { turnGates: [{ before: preStart }, { afterStarted: started }] });
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp' });
      const preStartDelivery = (async () => {
        const events = [];
        for await (const event of bridge.adapter.deliver(session, 'pre-start')) events.push(event);
        return events;
      })();
      await vi.waitFor(() => expect(bridge.requests.filter((request) => request.url === '/v1/turn'))
        .toHaveLength(1));
      await expect(bridge.adapter.resetSession!(session)).rejects.toThrow(/active|in-flight/);
      releasePreStart();
      await preStartDelivery;

      let resolveStarted!: () => void;
      const startedSeen = new Promise<void>((resolve) => { resolveStarted = resolve; });
      const startedDelivery = (async () => {
        const events = [];
        for await (const event of bridge.adapter.deliver(session, 'started', {
          onStarted: () => resolveStarted(),
        })) events.push(event);
        return events;
      })();
      await startedSeen;
      await expect(bridge.adapter.resetSession!(session)).rejects.toThrow(/active|in-flight/);
      releaseStarted();
      await startedDelivery;
    } finally {
      releasePreStart();
      releaseStarted();
      await bridge.close();
    }
  });

  // harn:assume context-reset-retirement-is-bounded-owned-and-confirmed ref=reset-retirement-regression
  it('retires idle local history and checkpoints without bridge work and permits a fresh session', async () => {
    const bridge = await fixture([
      [{ type: 'started', turn_id: 'old-turn' }, { type: 'done', result: { status: 'complete' }, response: [{ value: 'old answer' }] }],
      [{ type: 'started', turn_id: 'failed-turn' }, {
        type: 'error', recoverable: true, message: 'native stop',
        response: [{ value: 'partial old answer' }], assistant_text: 'partial old answer',
      }],
      [{ type: 'started', turn_id: 'fresh-turn' }, { type: 'done', result: { status: 'complete' }, response: [{ value: 'fresh answer' }] }],
    ]);
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp' });
      for await (const _event of bridge.adapter.deliver(session, 'old prompt')) { /* collect */ }
      for await (const _event of bridge.adapter.deliver(session, 'old continuation')) { /* collect */ }
      const requestsBeforeReset = bridge.requests.length;
      expect((session as unknown as { history?: unknown[] }).history).toHaveLength(2);
      expect((session as unknown as { failure_checkpoint?: unknown }).failure_checkpoint)
        .toMatchObject({ prompt: 'old continuation' });

      await expect(bridge.adapter.resetSession!(undefined)).resolves.toBeUndefined();
      await bridge.adapter.resetSession!(session);
      expect(bridge.requests).toHaveLength(requestsBeforeReset);
      expect((session as unknown as { history?: unknown[] }).history).toEqual([]);
      expect((session as unknown as { failure_checkpoint?: unknown }).failure_checkpoint).toBeUndefined();
      expect(bridge.adapter.canReviveSession(session)).toBe(false);

      const stale = [];
      for await (const event of bridge.adapter.deliver(session, 'must not run')) stale.push(event);
      expect(stale.at(-1)).toEqual(expect.objectContaining({
        type: 'run.completed', status: 'failed', error: expect.stringMatching(/retired|reset/),
      }));
      expect(bridge.requests).toHaveLength(requestsBeforeReset);

      const fresh = bridge.adapter.spawn({ cwd: '/tmp' });
      const freshEvents = [];
      for await (const event of bridge.adapter.deliver(fresh, 'fresh prompt')) freshEvents.push(event);
      expect(freshEvents.at(-1)).toEqual(expect.objectContaining({
        type: 'run.completed', status: 'completed', final_text: 'fresh answer',
      }));
      const turns = bridge.requests.filter((request) => request.url === '/v1/turn');
      expect(turns).toHaveLength(3);
      expect((turns.at(-1)?.body as { history?: unknown[] }).history).toEqual([]);
      expect(bridge.requests.some((request) => request.url.includes('/cancel'))).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('requires the live bridge generation for the explicit cache revive and never attaches a native ref', async () => {
    const bridge = await fixture([]);
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp' });
      expect(bridge.adapter.canReviveSession(session)).toBe(true);
      expect(() => bridge.adapter.attach('native-ref')).toThrow('does not support native session attach');
      writeFileSync(bridge.discovery, JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        port: 1,
        token: 'b'.repeat(64),
        started_at: new Date().toISOString(),
      }));
      expect(bridge.adapter.canReviveSession(session)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('rejects non-private, symlinked, oversized, and malformed discovery records', async () => {
    const bridge = await fixture([]);
    const link = join(dirname(bridge.discovery), 'bridge-link.json');
    try {
      if (process.platform !== 'win32') {
        chmodSync(bridge.discovery, 0o644);
        expect(vscodeCopilotBridgeAvailable(bridge.discovery)).toBe(false);
        chmodSync(bridge.discovery, 0o600);

        symlinkSync(bridge.discovery, link);
        expect(vscodeCopilotBridgeAvailable(link)).toBe(false);
        rmSync(link, { force: true });
      }

      writeFileSync(bridge.discovery, 'x'.repeat(4097));
      expect(vscodeCopilotBridgeAvailable(bridge.discovery)).toBe(false);

      writeFileSync(bridge.discovery, JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        port: 1,
        token: 'not-a-token',
        started_at: new Date().toISOString(),
      }));
      expect(vscodeCopilotBridgeAvailable(bridge.discovery)).toBe(false);
    } finally {
      rmSync(link, { force: true });
      await bridge.close();
    }
  });

  it('rejects thinking and fails safely when no valid discovery record exists', async () => {
    const missing = join(tmpdir(), `missing-${Date.now()}.json`);
    const adapter = new CopilotVscodeAdapter(missing);
    expect(vscodeCopilotBridgeAvailable(missing)).toBe(false);
    expect(() => adapter.spawn({ cwd: '/tmp', thinking: 'high' })).toThrow('does not support');
    await expect(adapter.listModels()).rejects.toThrow('bridge is unavailable');
  });
});
// harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence
// harn:end vscode-copilot-bridge-is-manual-local-and-credential-private
