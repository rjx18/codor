import { describe, expect, it } from 'vitest';

import { VOICE_ERROR_CODES, VoiceProviderIdSchema, VoiceTranscribeError } from './voice.js';
import type { VoiceProvider, VoiceTranscribeInput, VoiceTranscribeResult } from './voice.js';

// harn:assume voice-transcription-provider-contract ref=voice-provider-contract-regression
describe('VoiceProviderIdSchema', () => {
  it('accepts short lowercase slugs', () => {
    expect(VoiceProviderIdSchema.parse('codex')).toBe('codex');
    expect(VoiceProviderIdSchema.parse('local-whisper')).toBe('local-whisper');
  });

  it('rejects empty, uppercase, leading-dash, and over-long ids', () => {
    expect(() => VoiceProviderIdSchema.parse('')).toThrow();
    expect(() => VoiceProviderIdSchema.parse('Codex')).toThrow();
    expect(() => VoiceProviderIdSchema.parse('-lead')).toThrow();
    expect(() => VoiceProviderIdSchema.parse('a'.repeat(65))).toThrow();
  });
});

describe('VoiceProvider contract shape', () => {
  it('carries transcript text out of a minimal provider', async () => {
    const provider: VoiceProvider = {
      id: 'stub',
      label: 'Stub',
      async transcribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult> {
        return { text: `${input.mimeType}:${String(input.audio.length)}` };
      },
    };
    await expect(provider.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' }))
      .resolves.toEqual({ text: 'audio/wav:3' });
  });
});

describe('VoiceTranscribeError', () => {
  it('bounds the code set to input/auth/upstream', () => {
    expect([...VOICE_ERROR_CODES]).toEqual(['input', 'auth', 'upstream']);
  });

  it('carries a bounded code and stays an Error', () => {
    const error = new VoiceTranscribeError('auth', 'sign in first');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('auth');
    expect(error.message).toBe('sign in first');
  });
});
// harn:end voice-transcription-provider-contract
