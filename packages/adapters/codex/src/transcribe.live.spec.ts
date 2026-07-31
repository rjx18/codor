import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CodexVoiceProvider } from './transcribe.js';

/**
 * Live smoke: drive CodexVoiceProvider.transcribe() against the real
 * chatgpt.com transcription endpoint using the operator's signed-in codex
 * identity. Spend-gated behind CODOR_LIVE_SMOKE=1 with the WAV path supplied by
 * CODOR_VOICE_SMOKE_WAV so `pnpm -r test` never re-bills; run explicitly.
 */
const LIVE = process.env.CODOR_LIVE_SMOKE === '1';
const WAV = process.env.CODOR_VOICE_SMOKE_WAV;

describe.skipIf(!LIVE || !WAV)('codex voice transcription live smoke (CODOR_LIVE_SMOKE=1)', () => {
  it('returns a non-empty transcript for a real WAV', { timeout: 60_000 }, async () => {
    const provider = new CodexVoiceProvider();
    const audio = new Uint8Array(readFileSync(WAV as string));
    const result = await provider.transcribe({ audio, mimeType: 'audio/wav' });
    expect(result.text.trim().length).toBeGreaterThan(0);
  });
});
