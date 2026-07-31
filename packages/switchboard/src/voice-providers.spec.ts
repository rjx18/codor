import { describe, expect, it, vi } from 'vitest';

import {
  resolveVoiceProvider,
  voiceProviderCatalog,
  type VoiceProviderDefinition,
} from './voice-providers.js';

const def = (
  id: string,
  status: { available: boolean; reason?: string },
): VoiceProviderDefinition => ({
  id,
  label: `${id} label`,
  status: async () => status,
  create: () => ({ id, label: id, transcribe: async () => ({ text: '' }) }),
});

// harn:assume voice-provider-catalog-is-named-and-safe ref=voice-provider-registry-regression
describe('voiceProviderCatalog', () => {
  it('projects availability truth from each definition status', async () => {
    const catalog = await voiceProviderCatalog([
      def('codex', { available: true }),
      def('local', { available: false, reason: 'not installed' }),
    ]);
    expect(catalog).toEqual([
      { id: 'codex', label: 'codex label', available: true },
      { id: 'local', label: 'local label', available: false, reason: 'not installed' },
    ]);
  });

  it('projects only id/label/available/reason — no credential or path material', async () => {
    const [entry] = await voiceProviderCatalog([def('codex', { available: true })]);
    expect(Object.keys(entry).sort()).toEqual(['available', 'id', 'label']);
  });

  it('detects availability at request time on every call', async () => {
    const status = vi.fn(async () => ({ available: true }));
    const definitions = [{ id: 'codex', label: 'Codex', status, create: def('codex', { available: true }).create }];
    await voiceProviderCatalog(definitions);
    await voiceProviderCatalog(definitions);
    expect(status).toHaveBeenCalledTimes(2);
  });
});

describe('resolveVoiceProvider', () => {
  it('resolves a known id and returns undefined for an unknown one', () => {
    const definitions = [def('codex', { available: true })];
    expect(resolveVoiceProvider('codex', definitions)?.id).toBe('codex');
    expect(resolveVoiceProvider('nope', definitions)).toBeUndefined();
  });
});
// harn:end voice-provider-catalog-is-named-and-safe
