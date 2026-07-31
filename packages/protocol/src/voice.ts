import { z } from 'zod';

// harn:assume voice-transcription-provider-contract ref=voice-provider-contract
/**
 * The provider-agnostic voice transcription seam. One shape shared by the
 * switchboard, the adapters, and any future speech-to-text backend so dictation
 * stays swappable without reshaping the endpoint or the web UI.
 */

/** A stable public id for a voice provider, e.g. `codex`. Bounded lowercase slug. */
export const VoiceProviderIdSchema = z.string().regex(
  /^[a-z0-9][a-z0-9-]{0,63}$/,
  'Voice provider id must be a short lowercase slug',
);
export type VoiceProviderId = z.infer<typeof VoiceProviderIdSchema>;

/** Audio handed to a provider for transcription. */
export interface VoiceTranscribeInput {
  /** Encoded audio bytes (the codex provider expects a PCM16 RIFF/WAVE payload). */
  readonly audio: Uint8Array;
  /** IANA media type of {@link audio}, e.g. `audio/wav`. */
  readonly mimeType: string;
  /** Source sample rate (Hz) when a caller carries it outside the container. */
  readonly sampleRate?: number;
  /** Source channel count when a caller carries it outside the container. */
  readonly channels?: number;
}

/** The transcript a provider resolves to. Failures reject; never encoded here. */
export interface VoiceTranscribeResult {
  readonly text: string;
}

/**
 * A named speech-to-text backend. `transcribe` resolves to the transcript or
 * rejects with a descriptive error that preserves any non-success response
 * body; it never encodes failure into the result.
 */
export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  transcribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult>;
}

/** Bounded failure categories so callers map a rejection to an HTTP status. */
export const VOICE_ERROR_CODES = ['input', 'auth', 'upstream'] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

/**
 * A transcription failure carrying a bounded {@link VoiceErrorCode}. The
 * switchboard endpoint maps `input` → 400 and `auth`/`upstream` → 502 without
 * string-matching provider messages. The descriptive message is unchanged.
 */
export class VoiceTranscribeError extends Error {
  readonly code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceTranscribeError';
    this.code = code;
  }
}
// harn:end voice-transcription-provider-contract
