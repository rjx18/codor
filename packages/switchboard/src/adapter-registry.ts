import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ClaudeCodeAdapter } from '@wireroom/adapter-claude-code';
import { CodexAdapter } from '@wireroom/adapter-codex';
import { CopilotAdapter } from '@wireroom/adapter-copilot';
import { GeminiAdapter } from '@wireroom/adapter-gemini';
import { OpenCodeAdapter } from '@wireroom/adapter-opencode';
import type { AdapterCapabilities, HarnessAdapter } from '@wireroom/protocol';

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

function moduleSpecifier(specifier: string, baseDir: string): string {
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
    typeof capabilities.extensions === 'boolean';
}

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
    Object.entries(builtinFactories).map(([id, factory]) => [id, factory()]),
  );
  const baseDir = resolve(options.baseDir ?? process.cwd());

  for (const [id, configuredModule] of Object.entries(options.adapters ?? {}).sort(([a], [b]) =>
    a.localeCompare(b))) {
    if (id.trim() === '') throw new Error('configured adapter id must not be empty');
    if (configuredModule.trim() === '') {
      throw new Error(`configured adapter '${id}' has an empty module specifier`);
    }
    const specifier = moduleSpecifier(configuredModule, baseDir);
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
    registry.set(id, validateAdapter(candidate, id, configuredModule));
  }

  return [...registry.values()];
}
// harn:end adapter-registry-sole-harness-source
