import type { VoiceProvider } from '@codor/protocol';

import { CodexVoiceProvider, codexVoiceStatus } from './adapter-registry.js';

// harn:assume voice-provider-catalog-is-named-and-safe ref=voice-provider-registry
/**
 * A curated voice provider. `status()` detects availability at request time
 * (presence of usable credentials — never invoking a binary or minting tokens);
 * `create()` builds the live provider only when a transcription runs.
 */
export interface VoiceProviderDefinition {
  readonly id: string;
  readonly label: string;
  status(): Promise<{ available: boolean; reason?: string }>;
  create(): VoiceProvider;
}

/** Safe public projection of a provider — never tokens, credentials, or paths. */
export interface VoiceProviderMetadata {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * The frozen curated set. Codex-only today; adding a provider is a deliberate
 * code edit, never a client- or PATH-driven mutation.
 */
export const VOICE_PROVIDER_DEFINITIONS: readonly VoiceProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: 'codex',
    label: 'Codex (ChatGPT login)',
    status: () => codexVoiceStatus(),
    create: () => new CodexVoiceProvider(),
  }),
]) as readonly VoiceProviderDefinition[];

/** Project every definition to safe metadata, detecting availability now. */
export async function voiceProviderCatalog(
  definitions: readonly VoiceProviderDefinition[] = VOICE_PROVIDER_DEFINITIONS,
): Promise<VoiceProviderMetadata[]> {
  return Promise.all(definitions.map(async (definition): Promise<VoiceProviderMetadata> => {
    const { available, reason } = await definition.status();
    return {
      id: definition.id,
      label: definition.label,
      available,
      ...(reason !== undefined && { reason }),
    };
  }));
}

/** Resolve a definition by its stable id, or undefined when unknown/disabled. */
export function resolveVoiceProvider(
  id: string,
  definitions: readonly VoiceProviderDefinition[] = VOICE_PROVIDER_DEFINITIONS,
): VoiceProviderDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
}
// harn:end voice-provider-catalog-is-named-and-safe
