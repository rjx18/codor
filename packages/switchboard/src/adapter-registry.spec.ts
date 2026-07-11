import { describe, expect, it } from 'vitest';

import { BUILTIN_ADAPTER_IDS, loadAdapterRegistry } from './adapter-registry.js';

describe('adapter registry spawn controls', () => {
  it('requires every built-in to declare thinking support explicitly', async () => {
    const adapters = await loadAdapterRegistry();
    expect(adapters.map((adapter) => adapter.id)).toEqual(BUILTIN_ADAPTER_IDS);
    expect(adapters.map((adapter) => [adapter.id, adapter.capabilities.thinking])).toEqual([
      ['claude-code', true],
      ['codex', true],
      ['copilot', false],
      ['gemini', false],
      ['opencode', true],
    ]);
  });

  it('rejects unknown canonical values at the registry boundary', async () => {
    const [adapter] = await loadAdapterRegistry();
    expect(() => adapter!.spawn({ cwd: '/work', policy: 'yolo' })).toThrow(
      'valid policies: read-only, workspace-write, full-access',
    );
    expect(() => adapter!.spawn({
      cwd: '/work',
      thinking: 'extreme' as 'high',
    })).toThrow('valid levels: low, medium, high');
  });

  it('rejects thinking before delegating to unsupported adapters', async () => {
    const adapters = await loadAdapterRegistry();
    for (const id of ['copilot', 'gemini']) {
      const adapter = adapters.find((candidate) => candidate.id === id)!;
      expect(() => adapter.spawn({ cwd: '/work', thinking: 'high' })).toThrow(
        `adapter '${id}' does not support thinking levels`,
      );
    }
  });
});
