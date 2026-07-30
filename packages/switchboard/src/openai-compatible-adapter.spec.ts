import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

import {
  createOpenAICompatibleAdapter,
} from '../adapters/openai-compatible.mjs';
import { loadAdapterRegistry } from './adapter-registry.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function eventsFrom(
  adapter: ReturnType<typeof createOpenAICompatibleAdapter>,
  session: ReturnType<ReturnType<typeof createOpenAICompatibleAdapter>['spawn']>,
  prompt = 'hello',
) {
  const events = [];
  for await (const event of adapter.deliver(session, prompt)) events.push(event);
  return events;
}

describe('configured OpenAI-compatible adapters', () => {
  it('loads both providers through the production configured-adapter registry', async () => {
    const registry = await loadAdapterRegistry({
      adapters: {
        nvidia: './adapters/openai-compatible.mjs',
        ollama: './adapters/openai-compatible.mjs',
      },
      baseDir: resolve(import.meta.dirname, '..'),
    });

    const ollama = registry.find((adapter) => adapter.id === 'ollama');
    const nvidia = registry.find((adapter) => adapter.id === 'nvidia');
    expect(ollama?.capabilities.policies).toEqual({
      'read-only': 'chat-only',
      'workspace-write': null,
      'full-access': null,
    });
    expect(nvidia?.capabilities).toMatchObject({
      resume: true,
      thinking: false,
    });
    expect(ollama?.spawn({
      cwd: '/work',
      model: 'qwen3.6:latest',
      policy: 'read-only',
    })).toMatchObject({
      harness: 'ollama',
      model: 'qwen3.6:latest',
      policy: 'read-only',
    });
  });

  it('discovers Ollama models without a credential', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      object: 'list',
      data: [
        { id: 'qwen3.6:latest' },
        { id: 'nomic-embed-text:latest' },
        { id: 'llama3.1:8b' },
      ],
    }));
    const adapter = createOpenAICompatibleAdapter({ id: 'ollama', fetcher });

    await expect(adapter.listModels()).resolves.toEqual({
      models: ['qwen3.6:latest', 'llama3.1:8b'],
      source: 'discovered',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      { headers: { accept: 'application/json' } },
    );
  });

  it('completes a chat-only Ollama turn with normalized text and usage', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      model: 'qwen3.6:latest',
      choices: [{ message: { content: '@orchestrator local review complete' } }],
      usage: { prompt_tokens: 17, completion_tokens: 6 },
    }));
    const adapter = createOpenAICompatibleAdapter({ id: 'ollama', fetcher });
    const session = adapter.spawn({
      cwd: '/work',
      model: 'qwen3.6:latest',
      policy: 'full-access',
    });

    await expect(eventsFrom(adapter, session)).resolves.toEqual([
      {
        type: 'run.item',
        item_type: 'text_delta',
        payload: { text: '@orchestrator local review complete' },
      },
      {
        type: 'run.completed',
        status: 'completed',
        model: 'qwen3.6:latest',
        final_text: '@orchestrator local review complete',
        usage: { input_tokens: 17, output_tokens: 6 },
      },
    ]);
    expect(session.policy).toBe('read-only');
  });

  it('reads NVIDIA credentials at turn time without exposing them in output', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      model: 'meta/llama-4-maverick-17b-128e-instruct',
      choices: [{ message: { content: 'remote review' } }],
    }));
    const execFile = vi.fn().mockReturnValue('secret-from-keychain\n');
    const adapter = createOpenAICompatibleAdapter({
      id: 'nvidia',
      fetcher,
      execFile,
      env: {
        CODOR_NVIDIA_KEYCHAIN_SERVICE: 'NVIDIA_API_KEY_CODOR',
        CODOR_NVIDIA_KEYCHAIN_ACCOUNT: 'emanuelfarruda',
      },
    });
    const session = adapter.spawn({
      cwd: '/work',
      model: 'meta/llama-4-maverick-17b-128e-instruct',
    });

    const events = await eventsFrom(adapter, session);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-s',
        'NVIDIA_API_KEY_CODOR',
        '-a',
        'emanuelfarruda',
        '-w',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-from-keychain',
    );
    expect(JSON.stringify(events)).not.toContain('secret-from-keychain');
  });

  it('fails closed when NVIDIA has no dedicated credential configuration', async () => {
    const fetcher = vi.fn();
    const adapter = createOpenAICompatibleAdapter({
      id: 'nvidia',
      fetcher,
      env: {},
    });
    const session = adapter.spawn({
      cwd: '/work',
      model: 'meta/llama-4-maverick-17b-128e-instruct',
    });

    const events = await eventsFrom(adapter, session);
    expect(events).toEqual([expect.objectContaining({
      type: 'run.completed',
      status: 'failed',
      error: expect.stringContaining('CODOR_NVIDIA_KEYCHAIN_SERVICE'),
    })]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
