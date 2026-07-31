import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VoiceTranscribeError } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_TRANSCRIBE_URL,
  CodexVoiceProvider,
  codexVoiceStatus,
  ensureCodexWav,
  type CodexTranscribeFetcher,
  type CodexTranscribeResponse,
} from './transcribe.js';

/** Capture a synchronous throw as a VoiceTranscribeError for code assertions. */
function caught(fn: () => unknown): VoiceTranscribeError {
  try {
    fn();
  } catch (error) {
    return error as VoiceTranscribeError;
  }
  throw new Error('expected a throw');
}

/** Capture an async rejection as a VoiceTranscribeError for code assertions. */
async function caughtAsync(promise: Promise<unknown>): Promise<VoiceTranscribeError> {
  try {
    await promise;
  } catch (error) {
    return error as VoiceTranscribeError;
  }
  throw new Error('expected a rejection');
}

const dirs: string[] = [];

function authFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-voice-'));
  dirs.push(dir);
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a PCM16 WAV of a 440 Hz tone at the given rate/channels. */
function wav(seconds: number, sampleRate: number, channels: number): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let f = 0; f < frames; f += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * f) / sampleRate) * 10_000);
    for (let c = 0; c < channels; c += 1) view.setInt16(44 + (f * channels + c) * 2, value, true);
  }
  return new Uint8Array(buffer);
}

/** Read back the fmt fields of an encoded WAV. */
function header(bytes: Uint8Array): { riff: string; wave: string; sampleRate: number; channels: number; bits: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  return {
    riff: tag(0),
    wave: tag(8),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
  };
}

const CHATGPT_AUTH = { tokens: { access_token: 'head.body.sig', account_id: 'acct-1' } };

function okFetcher(text: string, calls?: Parameters<CodexTranscribeFetcher>[]): CodexTranscribeFetcher {
  return async (url, init) => {
    calls?.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ text }), text: async () => JSON.stringify({ text }) };
  };
}

function statusFetcher(status: number, body: string, counter?: { n: number }): CodexTranscribeFetcher {
  return async () => {
    if (counter) counter.n += 1;
    return { ok: false, status, json: async () => ({}), text: async () => body } satisfies CodexTranscribeResponse;
  };
}

const rejectIfCalled: CodexTranscribeFetcher = () => {
  throw new Error('fetcher should not be called');
};

// harn:assume codex-voice-upload-is-24khz-mono-pcm16-wav ref=codex-transcribe-wav-regression
describe('ensureCodexWav', () => {
  it('emits a 24 kHz mono PCM16 RIFF/WAVE header', () => {
    const out = ensureCodexWav(wav(1.5, 24_000, 1));
    expect(header(out)).toEqual({ riff: 'RIFF', wave: 'WAVE', sampleRate: 24_000, channels: 1, bits: 16 });
  });

  it('downmixes and resamples 48 kHz stereo to ~24 kHz mono', () => {
    const out = ensureCodexWav(wav(1.5, 48_000, 2));
    expect(header(out)).toMatchObject({ sampleRate: 24_000, channels: 1, bits: 16 });
    const frames = (out.length - 44) / 2;
    expect(frames).toBeGreaterThan(24_000); // ~1.5s at 24 kHz
    expect(frames).toBeLessThan(48_000);
  });

  it('rejects audio shorter than one second with code input', () => {
    const error = caught(() => ensureCodexWav(wav(0.5, 24_000, 1)));
    expect(error).toBeInstanceOf(VoiceTranscribeError);
    expect(error.code).toBe('input');
    expect(error.message).toMatch(/at least 1s/);
  });

  it('rejects a non-WAV payload with code input', () => {
    const error = caught(() => ensureCodexWav(new Uint8Array([1, 2, 3, 4])));
    expect(error.code).toBe('input');
    expect(error.message).toMatch(/RIFF\/WAVE/);
  });
});
// harn:end codex-voice-upload-is-24khz-mono-pcm16-wav

// harn:assume codex-voice-transcription-reuses-signed-in-codex-identity ref=codex-transcribe-identity-regression
describe('CodexVoiceProvider identity', () => {
  it('uploads to the verified endpoint with Codex Desktop headers and one file part', async () => {
    const calls: Parameters<CodexTranscribeFetcher>[] = [];
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile(CHATGPT_AUTH),
      fetcher: okFetcher('hello world', calls),
    });
    await expect(provider.transcribe({ audio: wav(1.5, 24_000, 1), mimeType: 'audio/wav' }))
      .resolves.toEqual({ text: 'hello world' });

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(CODEX_TRANSCRIBE_URL);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer head.body.sig',
      'ChatGPT-Account-Id': 'acct-1',
      'OAI-Product-Sku': 'CODEX',
      originator: 'Codex Desktop',
    });
    expect(init.headers['User-Agent']).toMatch(/^Codex Desktop\/[\d.]+ \(Macintosh; Intel Mac OS X; \w+\)$/);

    const file = init.body.get('file') as File;
    expect(file.name).toBe('codex.wav');
    expect(file.type).toBe('audio/wav');
    expect(header(new Uint8Array(await file.arrayBuffer()))).toMatchObject({ sampleRate: 24_000, channels: 1 });
  });

  it('reads credentials at request time, not construction', async () => {
    const path = authFile({ tokens: {} }); // unusable at construction
    const provider = new CodexVoiceProvider({ credentialsPath: path, fetcher: okFetcher('ok') });
    writeFileSync(path, JSON.stringify(CHATGPT_AUTH)); // becomes valid before the call
    await expect(provider.transcribe({ audio: wav(1.5, 24_000, 1), mimeType: 'audio/wav' }))
      .resolves.toEqual({ text: 'ok' });
  });

  it('never leaks the access token into an error message', async () => {
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile({ tokens: { access_token: 'top.secret.jwt', account_id: 'acct-1' } }),
      fetcher: statusFetcher(500, 'upstream boom'),
    });
    await expect(provider.transcribe({ audio: wav(1.5, 24_000, 1), mimeType: 'audio/wav' }))
      .rejects.toThrow(/upstream boom/);
    await expect(provider.transcribe({ audio: wav(1.5, 24_000, 1), mimeType: 'audio/wav' }))
      .rejects.not.toThrow(/top\.secret\.jwt/);
  });

  it('reports availability true for a ChatGPT login and false otherwise, without paths', async () => {
    await expect(codexVoiceStatus({ credentialsPath: authFile(CHATGPT_AUTH) }))
      .resolves.toEqual({ available: true });
    const missing = await codexVoiceStatus({ credentialsPath: authFile({ tokens: {} }) });
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/codex login/);
    const apiKey = await codexVoiceStatus({ credentialsPath: authFile({ OPENAI_API_KEY: 'sk-live', tokens: null }) });
    expect(apiKey).toEqual({ available: false, reason: expect.stringMatching(/API key/) });
  });
});
// harn:end codex-voice-transcription-reuses-signed-in-codex-identity

// harn:assume codex-voice-transcription-requires-chatgpt-login ref=codex-transcribe-auth-regression
describe('CodexVoiceProvider auth matrix', () => {
  const audio = () => ({ audio: wav(1.5, 24_000, 1), mimeType: 'audio/wav' });

  it('rejects an API-key login with code auth and without uploading', async () => {
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile({ OPENAI_API_KEY: 'sk-live-123', tokens: null }),
      fetcher: rejectIfCalled,
    });
    const error = await caughtAsync(provider.transcribe(audio()));
    expect(error.code).toBe('auth');
    expect(error.message).toMatch(/API key/);
  });

  it('rejects a personal access token with code auth and without uploading', async () => {
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile({ tokens: { access_token: 'pat-opaque-token', account_id: 'acct-1' } }),
      fetcher: rejectIfCalled,
    });
    const error = await caughtAsync(provider.transcribe(audio()));
    expect(error.code).toBe('auth');
    expect(error.message).toMatch(/personal access token/);
  });

  it('rejects a missing auth.json with code auth and without uploading', async () => {
    const provider = new CodexVoiceProvider({
      credentialsPath: join(tmpdir(), 'codor-voice-absent', 'auth.json'),
      fetcher: rejectIfCalled,
    });
    const error = await caughtAsync(provider.transcribe(audio()));
    expect(error.code).toBe('auth');
    expect(error.message).toMatch(/codex login/);
  });

  it('maps a 401 to a code upstream re-authenticate error with no refresh attempt', async () => {
    const counter = { n: 0 };
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile(CHATGPT_AUTH),
      fetcher: statusFetcher(401, 'unauthorized', counter),
    });
    const error = await caughtAsync(provider.transcribe(audio()));
    expect(error.code).toBe('upstream');
    expect(error.message).toMatch(/Re-authenticate with `codex login`/);
    expect(counter.n).toBe(1); // exactly one call — no silent refresh/retry
  });

  it('preserves a non-success response body in a code upstream error', async () => {
    const provider = new CodexVoiceProvider({
      credentialsPath: authFile(CHATGPT_AUTH),
      fetcher: statusFetcher(503, 'service unavailable'),
    });
    const error = await caughtAsync(provider.transcribe(audio()));
    expect(error.code).toBe('upstream');
    expect(error.message).toMatch(/service unavailable/);
  });
});
// harn:end codex-voice-transcription-requires-chatgpt-login
