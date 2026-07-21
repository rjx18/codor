import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ADAPTER_IDS,
  loadAdapterRegistry,
  validateSpawnOptions,
} from './adapter-registry.js';
import { FakeAdapter } from './fake-adapter.js';

// harn:assume harness-declares-supported-thinking-levels ref=registry-thinking-level-regression
describe('adapter registry spawn controls', () => {
  it('reports each built-in thinking capability and exact accepted levels', async () => {
    const adapters = await loadAdapterRegistry();
    expect(adapters.map((adapter) => adapter.id)).toEqual(BUILTIN_ADAPTER_IDS);
    expect(adapters.map((adapter) => [
      adapter.id,
      adapter.capabilities.thinking,
      adapter.capabilities.thinking_levels,
    ])).toEqual([
      ['antigravity', false, undefined],
      ['claude-code', true, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']],
      ['codex', true, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
      ['copilot', false, undefined],
      ['cursor', false, undefined],
      ['gemini', false, undefined],
      ['opencode', true, ['low', 'medium', 'high']],
      ['tura', false, undefined],
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
    })).toThrow('valid levels: low, medium, high, xhigh, max, ultra, ultracode');
  });

  it('rejects thinking before delegating to unsupported adapters', async () => {
    const adapters = await loadAdapterRegistry();
    for (const id of ['antigravity', 'copilot', 'gemini']) {
      const adapter = adapters.find((candidate) => candidate.id === id)!;
      expect(() => adapter.spawn({ cwd: '/work', thinking: 'high' })).toThrow(
        `adapter '${id}' does not support thinking levels`,
      );
    }
  });

  it('rejects globally valid levels that the selected harness does not accept', async () => {
    const adapters = await loadAdapterRegistry();
    const codex = adapters.find((adapter) => adapter.id === 'codex')!;
    const claude = adapters.find((adapter) => adapter.id === 'claude-code')!;
    const opencode = adapters.find((adapter) => adapter.id === 'opencode')!;
    expect(() => codex.spawn({ cwd: '/work', thinking: 'ultracode' })).toThrow(
      "adapter 'codex' does not support thinking level 'ultracode'",
    );
    expect(() => claude.spawn({ cwd: '/work', thinking: 'ultra' })).toThrow(
      "adapter 'claude-code' does not support thinking level 'ultra'",
    );
    expect(() => opencode.spawn({ cwd: '/work', thinking: 'xhigh' })).toThrow(
      "adapter 'opencode' does not support thinking level 'xhigh'",
    );
  });

  it('preserves low, medium, and high for older thinking-capable adapters', () => {
    const legacy = new FakeAdapter('legacy', { thinking: true });
    expect(() => validateSpawnOptions(legacy, { cwd: '/work', thinking: 'high' })).not.toThrow();
    expect(() => validateSpawnOptions(legacy, { cwd: '/work', thinking: 'xhigh' })).toThrow(
      "adapter 'legacy' does not support thinking level 'xhigh'; valid levels: low, medium, high",
    );
  });
});
// harn:end harness-declares-supported-thinking-levels

// harn:assume adapter-wrappers-preserve-the-whole-contract ref=registry-wrapper-regression
describe('the registry wrapper preserves the whole adapter contract', () => {
  it('still reports the models of every adapter that can answer', async () => {
    // The daemon only ever sees WRAPPED adapters. U3 shipped model discovery that
    // could never run because the wrapper rebuilt each adapter from a property list
    // that omitted listModels — and every test that built adapters directly passed.
    const adapters = await loadAdapterRegistry();
    const answering = adapters.filter((adapter) => adapter.listModels !== undefined);
    expect(answering.map((adapter) => adapter.id).sort()).toEqual(
      ['antigravity', 'claude-code', 'codex', 'copilot', 'gemini', 'opencode'],
    );

    const claude = adapters.find((adapter) => adapter.id === 'claude-code')!;
    const catalog = await claude.listModels!();
    expect(catalog.source).toBe('curated');
    expect(catalog.models).toContain('opus');
  });

  it('forwards peekContextUsage so production gauges can seed', async () => {
    // The seeding sweep only ever sees WRAPPED adapters; a dropped member
    // means every gauge silently stays empty (this exact bug shipped).
    const adapters = await loadAdapterRegistry();
    const claude = adapters.find((adapter) => adapter.id === 'claude-code')!;
    expect(claude.peekContextUsage).toBeTypeOf('function');
    await expect(claude.peekContextUsage!('no-such-session-ref')).resolves.toBeUndefined();
  });

  it('forwards compactSession so the operator lever reaches the engine', async () => {
    // Same class as the peekContextUsage bug: the compact act only ever calls
    // WRAPPED adapters, so a dropped member makes the button silently useless
    // while every direct-construction adapter test still passes.
    const adapters = await loadAdapterRegistry();
    const claude = adapters.find((adapter) => adapter.id === 'claude-code')!;
    expect(claude.compactSession).toBeTypeOf('function');
    await expect(claude.compactSession!({ harness: 'claude-code', cwd: '/' }))
      .rejects.toThrow(/no live Claude session/);
  });

  it('carries every declared member of the contract through the wrapper', async () => {
    // Guards the next member somebody adds to HarnessAdapter and forgets here.
    const wrapped = (await loadAdapterRegistry())
      .find((adapter) => adapter.id === 'claude-code')!;
    for (const member of [
      'id', 'capabilities', 'spawn', 'attach', 'deliver',
      'respondInteraction', 'interrupt', 'discoverSessions', 'listModels',
      // Existence only — probing here would hit a real provider.
      'probeLimits', 'peekContextUsage', 'compactSession',
    ]) {
      expect(wrapped, `wrapper must carry ${member}`).toHaveProperty(member);
    }
  });
});

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-registry-validation
describe('a harness must say what its permission levels do', () => {
  const dataModule = (source: string): string =>
    `data:text/javascript,${encodeURIComponent(source)}`;

  const capabilities = (extra: string): string =>
    `export function createAdapter({id}){return {id,capabilities:{resume:true,discover:false,` +
    `interactiveAttach:false,ask:false,approvals:'spawn-time',extensions:false,thinking:false,${extra}},` +
    `spawn:()=>({harness:id,cwd:'/'}),attach:()=>({harness:id,cwd:'/'}),` +
    `deliver:async function*(){},respondInteraction:async()=>{},interrupt(){},discoverSessions:()=>[]}}`;

  it('refuses a harness that never declares its policies', async () => {
    // The declaration is what every surface reads to tell the operator what an agent
    // may do to their machine. A harness that will not say does not get to register.
    await expect(loadAdapterRegistry({
      adapters: { silent: dataModule(capabilities('')) },
    })).rejects.toThrow(/invalid capabilities/);
  });

  it('refuses a harness that declares only some of them', async () => {
    await expect(loadAdapterRegistry({
      adapters: { partial: dataModule(capabilities(`policies:{'read-only':'plan'}`)) },
    })).rejects.toThrow(/invalid capabilities/);
  });

  it('accepts null — a harness saying plainly that it does not enforce a level', async () => {
    // Null is not a missing declaration. It is the harness stating that it does not
    // distinguish this level at all, which the operator is then told.
    const adapters = await loadAdapterRegistry({
      adapters: {
        deferring: dataModule(capabilities(
          `policies:{'read-only':null,'workspace-write':null,'full-access':'--yolo'}`,
        )),
      },
    });
    const deferring = adapters.find((adapter) => adapter.id === 'deferring')!;
    expect(deferring.capabilities.policies['read-only']).toBeNull();
    expect(deferring.capabilities.policies['full-access']).toBe('--yolo');
  });
});

// harn:assume canonical-spawn-controls-enforced ref=canonical-policy-thinking-enforcement
describe('an unknown policy is refused wherever it comes from', () => {
  it('rejects a policy outside the canonical three', async () => {
    // The UI can no longer produce one — the control is three buttons off the enum. A
    // hand-written API call still can, and this is the guarantee that stops it.
    const [adapter] = await loadAdapterRegistry({ adapters: {} });
    expect(() => adapter!.spawn({ cwd: '/work', policy: 'root' }))
      .toThrow(/unknown policy 'root'/);
  });
});

// harn:assume the-adapter-doc-is-the-contract-it-enforces ref=adapter-doc-drift-gate
describe('the published adapter contract is the one the registry enforces', () => {
  // docs/ADAPTERS.md IS the contract for harnesses the core does not ship — an author
  // can only follow what is written down. It had drifted silently: `thinking` was never
  // published at all, and `policies` became required while the doc still showed the old
  // interface, so a faithful third-party adapter would be REFUSED at load with nothing
  // to explain why. A doc that omits a required field is worse than no doc.
  const doc = readFileSync('../../docs/ADAPTERS.md', 'utf8');
  const published = /interface HarnessAdapter \{[\s\S]*?\n\}/.exec(doc)?.[0] ?? '';

  it('publishes every capability a real adapter declares', () => {
    // Runtime truth, not a hand-kept list: whatever an adapter actually carries.
    const declared = Object.keys(new FakeAdapter().capabilities);
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter((field) => !published.includes(field));
    expect(missing, 'the doc must publish every capability the registry requires').toEqual([]);
  });

  it('publishes the capability the registry refuses adapters for omitting', () => {
    expect(published).toContain('policies');
  });
});
