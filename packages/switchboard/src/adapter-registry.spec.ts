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

// harn:assume adapter-wrappers-preserve-the-whole-contract ref=registry-wrapper-regression
describe('the registry wrapper preserves the whole adapter contract', () => {
  it('still reports the models of every adapter that can answer', async () => {
    // The daemon only ever sees WRAPPED adapters. U3 shipped model discovery that
    // could never run because the wrapper rebuilt each adapter from a property list
    // that omitted listModels — and every test that built adapters directly passed.
    const adapters = await loadAdapterRegistry();
    const answering = adapters.filter((adapter) => adapter.listModels !== undefined);
    expect(answering.map((adapter) => adapter.id).sort()).toEqual(
      ['claude-code', 'codex', 'copilot', 'gemini', 'opencode'],
    );

    const claude = adapters.find((adapter) => adapter.id === 'claude-code')!;
    const catalog = await claude.listModels!();
    expect(catalog.source).toBe('curated');
    expect(catalog.models).toContain('opus');
  });

  it('carries every declared member of the contract through the wrapper', async () => {
    // Guards the next member somebody adds to HarnessAdapter and forgets here.
    const [wrapped] = await loadAdapterRegistry();
    for (const member of [
      'id', 'capabilities', 'spawn', 'attach', 'deliver',
      'respondInteraction', 'interrupt', 'discoverSessions', 'listModels',
    ]) {
      expect(wrapped, `wrapper must carry ${member}`).toHaveProperty(member);
    }
  });
});
