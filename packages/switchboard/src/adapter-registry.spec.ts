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
