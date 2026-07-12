import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ClaudeCodeAdapter } from '@codor/adapter-claude-code';
import { CodexAdapter } from '@codor/adapter-codex';
import { CopilotAdapter } from '@codor/adapter-copilot';
import { GeminiAdapter } from '@codor/adapter-gemini';
import { OpenCodeAdapter } from '@codor/adapter-opencode';
import {
  type AdapterCapabilities,
  type HarnessAdapter,
  PolicySchema,
  type SpawnOpts,
  ThinkingLevelSchema,
} from '@codor/protocol';

export type AdapterModuleConfig = Record<string, string>;

export interface AdapterFactoryContext {
  id: string;
}

export interface AdapterRegistryOptions {
  adapters?: AdapterModuleConfig;
  baseDir?: string;
}

type AdapterFactory = () => HarnessAdapter;

// harn:assume adapter-registry-sole-harness-source ref=configured-adapter-registry
const builtinFactories = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  copilot: () => new CopilotAdapter(),
  gemini: () => new GeminiAdapter(),
  opencode: () => new OpenCodeAdapter(),
} satisfies Record<string, AdapterFactory>;

export const BUILTIN_ADAPTER_IDS = Object.freeze(Object.keys(builtinFactories));

const requiredMethods = [
  'spawn',
  'attach',
  'deliver',
  'respondInteraction',
  'interrupt',
  'discoverSessions',
] as const;

export function resolveAdapterModuleSpecifier(specifier: string, baseDir: string): string {
  if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
    return pathToFileURL(resolve(baseDir, specifier)).href;
  }
  return specifier;
}

function validCapabilities(value: unknown): value is AdapterCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Partial<AdapterCapabilities>;
  return typeof capabilities.resume === 'boolean' &&
    typeof capabilities.discover === 'boolean' &&
    typeof capabilities.interactiveAttach === 'boolean' &&
    typeof capabilities.ask === 'boolean' &&
    (capabilities.approvals === 'runtime' || capabilities.approvals === 'spawn-time') &&
    typeof capabilities.extensions === 'boolean' &&
    typeof capabilities.thinking === 'boolean' &&
    validPolicyMap(capabilities.policies);
}

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-registry-validation
// A harness may not register without saying what its policies actually do. Every
// canonical policy needs an entry: the native mode it becomes, or null where this
// harness does not distinguish it — which the operator has to be told, not spared.
function validPolicyMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const policies = value as Record<string, unknown>;
  return PolicySchema.options.every((policy) => {
    const native = policies[policy];
    return native === null || (typeof native === 'string' && native.length > 0);
  });
}
// harn:end harness-declares-what-a-policy-becomes

const validPolicies = PolicySchema.options.join(', ');
const validThinking = ThinkingLevelSchema.options.join(', ');

export function validateSpawnOptions(adapter: HarnessAdapter, opts: SpawnOpts): void {
  if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
    throw new Error(`unknown policy '${opts.policy}'; valid policies: ${validPolicies}`);
  }
  if (opts.thinking !== undefined && !ThinkingLevelSchema.safeParse(opts.thinking).success) {
    throw new Error(`unknown thinking level '${String(opts.thinking)}'; valid levels: ${validThinking}`);
  }
  if (opts.thinking !== undefined && !adapter.capabilities.thinking) {
    throw new Error(`adapter '${adapter.id}' does not support thinking levels`);
  }
}

// harn:assume canonical-spawn-controls-enforced ref=registry-spawn-control-validation
function withSpawnValidation(adapter: HarnessAdapter): HarnessAdapter {
  return {
    id: adapter.id,
    capabilities: adapter.capabilities,
    spawn: (opts) => {
      validateSpawnOptions(adapter, opts);
      return adapter.spawn(opts);
    },
    attach: (sessionRef) => adapter.attach(sessionRef),
    deliver: (session, payload, hooks) => adapter.deliver(session, payload, hooks),
    respondInteraction: (session, interactionId, answer) =>
      adapter.respondInteraction(session, interactionId, answer),
    interrupt: (session) => adapter.interrupt(session),
    discoverSessions: () => adapter.discoverSessions(),
    // harn:assume adapter-wrappers-preserve-the-whole-contract ref=registry-wrapper-completeness
    // This wrapper is what production runs. A member it omits does not degrade —
    // it vanishes, while every test that builds the adapter directly still passes.
    // U3 lost model discovery here for exactly that reason.
    ...(adapter.listModels && { listModels: () => adapter.listModels!() }),
    // harn:end adapter-wrappers-preserve-the-whole-contract
  };
}
// harn:end canonical-spawn-controls-enforced

function validateAdapter(value: unknown, configuredId: string, specifier: string): HarnessAdapter {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`configured adapter '${configuredId}' from '${specifier}' did not return an object`);
  }
  const adapter = value as Partial<HarnessAdapter>;
  if (adapter.id !== configuredId) {
    throw new Error(
      `configured adapter '${configuredId}' from '${specifier}' returned id '${String(adapter.id)}'`,
    );
  }
  if (!validCapabilities(adapter.capabilities)) {
    throw new Error(`configured adapter '${configuredId}' from '${specifier}' has invalid capabilities`);
  }
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`configured adapter '${configuredId}' from '${specifier}' is missing ${method}()`);
    }
  }
  return adapter as HarnessAdapter;
}

export async function loadAdapterRegistry(
  options: AdapterRegistryOptions = {},
): Promise<HarnessAdapter[]> {
  const registry = new Map<string, HarnessAdapter>(
    Object.entries(builtinFactories).map(([id, factory]) => [id, withSpawnValidation(factory())]),
  );
  const baseDir = resolve(options.baseDir ?? process.cwd());

  for (const [id, configuredModule] of Object.entries(options.adapters ?? {}).sort(([a], [b]) =>
    a.localeCompare(b))) {
    if (id.trim() === '') throw new Error('configured adapter id must not be empty');
    if (configuredModule.trim() === '') {
      throw new Error(`configured adapter '${id}' has an empty module specifier`);
    }
    const specifier = resolveAdapterModuleSpecifier(configuredModule, baseDir);
    let imported: Record<string, unknown>;
    try {
      imported = await import(specifier) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `could not load configured adapter '${id}' from '${configuredModule}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (typeof imported.createAdapter !== 'function') {
      throw new Error(
        `configured adapter '${id}' from '${configuredModule}' must export createAdapter({ id })`,
      );
    }
    let candidate: unknown;
    try {
      candidate = await (imported.createAdapter as (
        context: AdapterFactoryContext,
      ) => unknown | Promise<unknown>)({ id });
    } catch (error) {
      throw new Error(
        `configured adapter '${id}' from '${configuredModule}' failed during createAdapter(): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    registry.set(id, withSpawnValidation(validateAdapter(candidate, id, configuredModule)));
  }

  return [...registry.values()];
}
// harn:end adapter-registry-sole-harness-source
